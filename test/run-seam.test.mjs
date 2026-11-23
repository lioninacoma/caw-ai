// The seam between the flows and a run: executeRun and closeRun with a fake browser session, a chat without a window and a
// scripted playback. What the flows decide must reach the run and its files the same way the workbench does it.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createChat } from '../src/host/chat.mjs';
import { fixFlow, runFlow } from '../src/host/flows.mjs';
import { executeRun } from '../src/host/run.mjs';
import { replayOf } from '../src/host/replay.mjs';
import { stepHash } from '../src/host/test-file.mjs';
import { EXIT } from '../src/shared/errors.mjs';

const stepOf = (id) => {
    const step = { id, name: `Schritt ${id}`, do: 'tun', expect: `${id} da` };
    return { ...step, recording: { hash: stepHash(step), recordedOn: 'dev', recordedAt: 'z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [{ action: 'reload' }], check: `return "${id}" !== ""` } };
};
const testOf = (extra = {}) => {
    const steps = [stepOf('S1'), stepOf('S2')];
    return { id: 'kauf', role: 'tester', writes: false, notes: '', steps, expectations: steps.map(({ id, expect }) => ({ id, text: expect })), ...extra };
};
const config = { language: 'de', environments: { dev: { url: 'http://localhost:9', agent: true, writable: true } } };
const checked = { name: 'dev', url: 'http://localhost:9', source: 'deployed', agent: true, writable: true };

/** A browser session without Chrome: no page is ever touched, the run only reads its lists. */
const fakeSession = () => ({
    failures: () => [],
    warnings: () => [],
    writes: () => [],
    secrets: () => [],
    drainFailures: () => [],
    closed: new Promise(() => {}),
    stopTrace: async () => {},
    close: async () => {},
});

/** The playback of a recording: each step passes, except `fail` whose check answered "no" (it evaluated). */
const playback = (fail) => async ({ replay, log }) => {
    const ids = [...new Set(replay.steps.filter(({ action }) => action === 'check').map(({ id }) => id))];
    const results = new Map();
    for (const [index, id] of ids.entries()) {
        log?.({ position: index + 1, number: 1, owner: id, label: 'check' });
        results.set(id, id === fail ? { id, status: 'fail', note: `${id} nicht da`, evidence: { type: 'eval', value: 'false' } } : { id, status: 'pass', evidence: { type: 'eval', value: 'true' } });
    }
    return { results, broken: null, remembered: new Map(), requests: new Map(), effects: new Map(), deviations: new Map(), retried: new Map(), evaluated: new Set(fail === undefined ? [] : [fail]), designs: new Map(), looks: new Map(), seenLooks: new Map(), lookHints: new Map() };
};

/**
 * A run of caw with the seams in place: the chat answers with `answers` in order, one per decision, as the window's buttons do.
 * After the handover (`develop`) the chat hands its options to `developing` instead; `session`, `seams` and `extra` replace
 * the fake session, add seams and add options of executeRun (such as withDesign).
 * @returns { execute, decisions } with what each decision offered
 */
const harness = ({ fail, answers = [], headless = false, session = fakeSession, seams = {}, extra = {}, developing }) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-seam-'));
    mkdirSync(join(root, 'caw'), { recursive: true });
    const wishes = [...answers];
    const decisions = [];
    const notices = [];
    const openChat = async ({ desk }) => {
        const chat = createChat({
            desk,
            show: (who, text, about) => {
                if (who === 'notice') notices.push(text);
                if (['result', 'failure', 'decision'].includes(who)) decisions.push({ who, text, card: about });
            },
            status: (state, options) => {
                if (state === 'developing' && options !== undefined && options !== null) developing?.(options.map(({ id }) => id), chat);
                if (options === undefined || options === null || !['deciding', 'discussing'].includes(state)) return;
                const ids = options.map(({ id }) => id);
                decisions.at(-1).options = ids;
                decisions.at(-1).labels = options.map(({ label }) => label);
                const wish = wishes.find((candidate) => ids.includes(candidate));
                if (wish !== undefined) wishes.splice(wishes.indexOf(wish), 1);
                // The click comes after the question is up, like in the window.
                setImmediate(() => chat.human.choose(wish ?? ids.at(-1)));
            },
        });
        return chat;
    };
    const runs = [];
    const execute = async ({ spec, lazyChat, testing, ...call }) => {
        const result = await executeRun(root, config, call.sandbox ?? null, {
            spec,
            checked,
            target: 'dev',
            stepTimeoutMs: 1000,
            maxActions: 10,
            headless,
            ...call,
            ...extra,
            ...(call.conclude === undefined ? {} : { conversation: { transcript: [], lazy: lazyChat !== undefined, testing: testing === true } }),
            seams: { openRunSession: async () => session(), openChat, playReplay: playback(fail), ...seams },
        });
        runs.push(result);
        return result;
    };
    const adopted = [];
    const adopt = (draft, only) => {
        adopted.push({ draft, only });
        return `caw/tests/${draft.id}.yaml`;
    };
    return { root, execute, decisions, notices, runs, adopted, adopt, result: (index = -1) => JSON.parse(readFileSync(join(root, runs.at(index).report.replace(/report\.md$/, 'result.json')), 'utf8')) };
};

test('Seam: a passed check run of a new recording waits for adopting, then writes the test', async () => {
    const h = harness({ answers: ['adopt'] });
    const code = await fixFlow({ draft: testOf(), whole: true, execute: h.execute, adopt: h.adopt, log: () => {}, advising: false });
    assert.equal(code, EXIT.pass);
    assert.deepEqual(h.decisions.map(({ options }) => options), [['adopt', 'discard']]);
    assert.equal(h.adopted.length, 1);
    assert.equal(h.adopted[0].only, undefined);
    assert.equal(h.result().status, 'pass');
    assert.ok(existsSync(join(h.root, h.runs[0].report)));
    // The decision as data: logged with who took it, and answered in the run folder.
    assert.deepEqual(h.result().decisions.map(({ id, option, by }) => [id, option, by]), [['recording.adopt', 'adopt', 'window']]);
    const file = JSON.parse(readFileSync(join(h.root, h.runs[0].report.replace(/report\.md$/, 'decision.json')), 'utf8'));
    assert.deepEqual([file.state, file.id, file.option, file.by], ['answered', 'recording.adopt', 'adopt', 'window']);
});

test('Seam: a failed step in a test run waits on the failure card; closing ends with fail and writes nothing', async () => {
    const h = harness({ fail: 'S2', answers: ['close'] });
    const code = await runFlow({ spec: testOf(), canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
    assert.equal(code, EXIT.fail);
    assert.equal(h.decisions.length, 1);
    assert.equal(h.decisions[0].who, 'failure');
    assert.deepEqual(h.decisions[0].options, ['fix', 'ask', 'close']);
    assert.deepEqual(h.adopted, []);
    const result = h.result();
    assert.equal(result.status, 'fail');
    assert.equal(result.steps.find(({ id }) => id === 'S2').status, 'fail');
    assert.deepEqual(result.decisions.map(({ id, option }) => [id, option]), [['step.failed', 'close']]);
});

test('Seam: a draft red at its step in the check run offers the red proof; adopting saves it with the run', async () => {
    const h = harness({ fail: 'S2', answers: ['adopt'] });
    const code = await fixFlow({ draft: testOf({ draft: true }), whole: true, execute: h.execute, adopt: h.adopt, log: () => {}, advising: false, head: () => 'abc1234' });
    assert.equal(code, EXIT.pass);
    assert.deepEqual(h.decisions.map(({ options }) => options), [['adopt', 'discard']]);
    assert.equal(h.adopted.length, 1);
    assert.deepEqual(h.adopted[0].draft.red, { step: 'S2', run: h.runs[0].runId, head: 'abc1234' });
});

test('Seam without a window: the same plan recorded again is adopted by caw itself, logged as auto', async () => {
    const h = harness({ headless: true });
    const code = await fixFlow({ draft: testOf(), whole: true, previous: testOf(), execute: h.execute, adopt: h.adopt, log: () => {}, advising: false });
    assert.equal(code, EXIT.pass);
    assert.equal(h.adopted.length, 1);
    assert.deepEqual(h.result().decisions.map(({ id, option, by }) => [id, option, by]), [['recording.adopt', 'adopt', 'auto']]);
    assert.equal(h.runs[0].undecided, undefined);
    assert.match(readFileSync(join(h.root, h.runs[0].report.replace(/report\.md$/, 'chat.log')), 'utf8'), /notice: Testplan übernehmen \(2 Schritte\): von caw gewählt/);
});

test('Seam without a window: a recording that changes what the test checks is not adopted; the run names the open decision', async () => {
    const h = harness({ headless: true });
    // A message that newly counts as known, an expected result that changed: the person's to adopt.
    await fixFlow({ draft: testOf(), whole: true, previous: testOf(), fresh: ['Gespeichert'], execute: h.execute, adopt: h.adopt, log: () => {}, advising: false });
    assert.deepEqual(h.adopted, []);
    assert.equal(h.runs[0].undecided.id, 'recording.adopt');
    assert.deepEqual(h.runs[0].undecided.context.known, ['Gespeichert']);
    const result = h.result();
    assert.equal(result.openDecision.id, 'recording.adopt');
    assert.deepEqual(result.openDecision.options.map(({ id, gate }) => [id, gate]), [['adopt', 'human'], ['discard', 'free']]);
    assert.equal(result.decisions, undefined, 'the stop at the open decision is no decision taken');
    assert.match(readFileSync(join(h.root, h.runs[0].report), 'utf8'), /## Offene Entscheidung/);

    // A plan that is not the file's: the same.
    const other = harness({ headless: true });
    const changed = testOf();
    changed.steps[1] = { ...changed.steps[1], expect: 'S2 anders' };
    await fixFlow({ draft: changed, whole: true, previous: testOf(), execute: other.execute, adopt: other.adopt, log: () => {}, advising: false });
    assert.deepEqual(other.adopted, []);
    assert.equal(other.runs[0].undecided.context.samePlan, false);
});

test('Seam without a window: a failed step stops at its card without fixing; a draft red at its step saves its proof', async () => {
    const h = harness({ fail: 'S2', headless: true });
    const code = await fixFlow({ draft: testOf(), whole: true, previous: testOf(), execute: h.execute, adopt: h.adopt, log: () => {}, advising: false });
    assert.equal(code, EXIT.fail);
    assert.deepEqual(h.adopted, []);
    assert.equal(h.runs[0].undecided.id, 'step.failed');
    assert.equal(h.result().decisions, undefined, 'the stop at the open decision is no decision taken');

    const red = harness({ fail: 'S2', headless: true });
    assert.equal(await fixFlow({ draft: testOf({ draft: true }), whole: true, previous: testOf({ draft: true }), execute: red.execute, adopt: red.adopt, log: () => {}, advising: false, head: () => undefined }), EXIT.pass);
    assert.deepEqual(red.adopted[0].draft.red, { step: 'S2', run: red.runs[0].runId });
    assert.equal(red.runs[0].undecided, undefined);
});

test('Seam without a window: the run that follows is announced without a window, never as a new window', async () => {
    const h = harness({ headless: true });
    // The terminal: what ui prints goes to stdout and stderr.
    const printed = [];
    const writes = [process.stdout.write, process.stderr.write];
    const keep = (chunk) => { printed.push(String(chunk)); return true; };
    process.stdout.write = keep;
    process.stderr.write = keep;
    try {
        await h.execute({ spec: testOf(), replay: replayOf(testOf()), conclude: async () => ({ next: 'check' }) });
    } finally {
        [process.stdout.write, process.stderr.write] = writes;
    }
    const said = [...h.notices, ...printed.join('').split('\n')].filter((text) => /Fenster/.test(text));
    assert.ok(said.length > 0 && said.every((text) => /Als Nächstes läuft der Prüflauf, ohne Fenster\./.test(text)), JSON.stringify(said));
});

/**
 * A session with a workbench after the handover: every workbench call is recorded (as [name, ...args]), the handlers for
 * refresh (F5), reloading the whole window and picking a state (F1) are kept for the test to call.
 */
const benchSession = () => {
    const calls = [];
    const handlers = { refresh: null, reloads: new Set(), state: null };
    const own = {
        onRefresh: (handler) => { handlers.refresh = handler; },
        onReload: (listener) => {
            handlers.reloads.add(listener);
            return () => handlers.reloads.delete(listener);
        },
        onState: (handler) => { handlers.state = handler; },
        onDesignBuild: (handler) => { handlers.build = handler; },
    };
    const workbench = new Proxy(own, {
        get: (target, name) => {
            if (name === 'then') return undefined;
            if (name in target) return target[name];
            return async (...args) => { calls.push([name, ...args]); };
        },
    });
    const make = () => ({ ...fakeSession(), workbench, page: () => ({}), signedIn: false, reloadPage: async () => {}, restart: async () => ({ settled: true }) });
    return { make, calls, handlers };
};

/** What designComparison gives the comparison page, with one deviation per text. */
const comparison = (viewport, texts = []) => ({
    met: texts.length === 0,
    design: { src: 'data:image/png;base64,AA', width: viewport.width, height: viewport.height },
    app: { src: 'data:image/png;base64,AA', width: viewport.width, height: viewport.height },
    deviations: texts.map((text) => ({ kind: 'style', text, design: { x: 1, y: 2, width: 3, height: 4 }, app: { x: 1, y: 2, width: 3, height: 4 } })),
    extra: [],
});

test('Seam: open --design compares anew after F5, a reload of the window and restoring the state; the page opens once, then stays as the person left it', async () => {
    const bench = benchSession();
    let computed = 0;
    const designComparison = async ({ viewport, capture }) => {
        computed += 1;
        assert.equal(typeof capture, 'function', 'the app is captured at the recorded size');
        return comparison(viewport, [`Abweichung ${computed}`]);
    };
    let round = 0;
    const developing = (ids, chat) => {
        round += 1;
        if (round === 1) {
            setImmediate(async () => {
                await bench.handlers.refresh();
                for (const listener of [...bench.handlers.reloads]) await listener({ human: true });
                chat.human.choose('restore');
            });
        } else if (round === 2) setImmediate(() => chat.human.choose('end'));
    };
    const h = harness({ session: bench.make, seams: { designComparison }, extra: { withDesign: true }, developing });
    const spec = testOf();
    spec.steps[1] = { ...spec.steps[1], design: 'design/form.html' };
    const code = await runFlow({ spec, through: 'S2', handover: true, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
    assert.equal(code, EXIT.pass);
    const designs = bench.calls.filter(([name]) => name === 'design');
    assert.deepEqual(designs.map(([, given]) => given.deviations.map(({ text }) => text).join()), ['Abweichung 1', 'Abweichung 2', 'Abweichung 3', 'Abweichung 4'], 'once at open, then after F5, the window reload and restoring');
    assert.deepEqual(designs.map(([, , how]) => how), [{ open: true }, {}, {}, {}], 'opened at first, then as the person left it');
    const [, first] = designs[0];
    assert.deepEqual({ step: first.step, file: first.file, met: first.met, rail: first.steps }, { step: { id: 'S2', name: spec.steps[1].name }, file: 'design/form.html', met: false, rail: [{ id: 'S2', name: spec.steps[1].name, status: 'deviations', count: 1 }] });
    assert.match(first.run, /^\d{2}-\d{2}-\d{2}$/, 'the run by its time');
    // Restoring the state operates the app: the page steps aside meanwhile; F5 and a reload do not.
    assert.deepEqual(bench.calls.filter(([name]) => name === 'designAside').map(([, on]) => on), [true, false]);
    assert.equal(h.notices.filter((text) => /neu aufgelistet/.test(text)).length, 3);
});

test('Seam: the comparison page\'s rail shows another step as the newest run judged its design after its check (steps[].design)', async () => {
    const bench = benchSession();
    const developing = (ids, chat) => { setImmediate(() => chat.human.choose('end')); };
    const h = harness({ session: bench.make, seams: { designComparison: async ({ viewport }) => comparison(viewport, []) }, extra: { withDesign: true }, developing });
    const spec = testOf();
    spec.steps[0] = { ...spec.steps[0], design: 'design/list.html' };
    spec.steps[1] = { ...spec.steps[1], design: 'design/form.html' };
    const earlier = join(h.root, '.caw', 'runs', `2026-01-01T00-00-00-000Z-${spec.id}`);
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, 'result.json'), JSON.stringify({ status: 'fail', results: [{ id: 'S1', status: 'fail' }], steps: [{ id: 'S1', status: 'fail', kind: 'design', design: { file: 'design/list.html', verdict: 'not-met', missing: ['button "Neu"'], textDiffs: [], styleDiffs: ['a', 'b'], layoutDiffs: [] } }] }));
    const code = await runFlow({ spec, through: 'S2', handover: true, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
    assert.equal(code, EXIT.pass);
    const [, first] = bench.calls.find(([name]) => name === 'design');
    assert.deepEqual(first.steps, [{ id: 'S1', name: spec.steps[0].name, status: 'deviations', count: 3 }, { id: 'S2', name: spec.steps[1].name, status: 'met', count: 0 }]);
});

test('Seam: the comparison page\'s "have the agent build it" asks in the chat as the design card does (design.unmet, ask); only then the agent starts', async () => {
    for (const [answer, starts] of [['ask', 1], ['close', 0]]) {
        const bench = benchSession();
        let opened = 0;
        let asked;
        const developing = (ids, chat) => {
            if (asked !== undefined) return;
            asked = (async () => {
                await bench.handlers.build();
                chat.human.choose('end');
            })();
        };
        const h = harness({ session: bench.make, answers: [answer], seams: { designComparison: async ({ viewport }) => comparison(viewport, ['button "Speichern": color #ffffff → #000000']) }, extra: { withDesign: true }, developing });
        const spec = testOf();
        spec.steps[1] = { ...spec.steps[1], design: 'design/form.html' };
        const code = await runFlow({ spec, through: 'S2', handover: true, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => { opened += 1; return null; } });
        assert.equal(code, EXIT.pass);
        await asked;
        const question = h.decisions.find(({ text }) => /umsetzen lassen, bis er Zielbild design\/form\.html erfüllt/.test(text ?? ''));
        assert.ok(question !== undefined, h.decisions.map(({ text }) => text).join('\n'));
        assert.deepEqual(question.options, ['ask', 'close'], 'the design card\'s options');
        assert.equal(question.labels[1], 'Nicht jetzt', 'declining only closes the question, the window stays: no "End run"');
        assert.equal(opened, starts, `${answer}: the agent ${starts === 1 ? 'starts' : 'does not start'}`);
    }
});

test('Seam: at the first pending step\'s entry its target design\'s controls are looked for (still missing, or there: record it), written to result.json; the run still passes', async () => {
    for (const [judged, line] of [
        [{ step: 'S3', file: 'design/s3.html', verdict: 'not-ready', missing: ['button "Speichern"', 'textbox "Notiz"'] }, /^Zielbild von S3 am Einstieg: noch fehlend: button "Speichern"; textbox "Notiz" \(lässt nichts scheitern\)\.$/],
        [{ step: 'S3', file: 'design/s3.html', verdict: 'ready', missing: [] }, /^Zielbild von S3: Seine Bedienelemente sind am Einstieg da\. Beurteilt wird es nach der Prüfung von S3, sobald S3 aufgenommen ist\.$/],
    ]) {
        let given;
        const withPending = async (args) => {
            given = args.replay.pendingDesign;
            return { ...await playback()(args), pendingDesign: judged };
        };
        const h = harness({ seams: { playReplay: withPending } });
        const spec = testOf();
        const pending = { id: 'S3', name: 'Schritt S3', do: 'tun', expect: 'S3 da', design: 'design/s3.html' };
        spec.steps.push(pending);
        spec.expectations.push({ id: 'S3', text: pending.expect });
        const code = await runFlow({ spec, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
        assert.equal(code, EXIT.pass, 'a preview fails nothing');
        assert.deepEqual(given, { step: 'S3', file: 'design/s3.html' }, 'the replay carries the pending step\'s design');
        assert.deepEqual(h.result().pendingDesign, { step: 'S3', file: 'design/s3.html', verdict: judged.verdict, missing: judged.missing });
        assert.ok(h.notices.some((text) => line.test(text)), h.notices.join('\n'));
    }
});

test('Seam: a pending step with needs: they, not the design\'s controls, say at its entry whether it is ready', async () => {
    // A page without the needed button.
    const frame = { getByRole: () => ({ elementHandles: async () => [] }) };
    const session = () => ({ ...fakeSession(), framework: { targets: () => true }, page: () => ({ mainFrame: () => frame }) });
    const withPending = async (args) => ({ ...await playback()(args), pendingDesign: { step: 'S3', file: 'design/s3.html' } });
    const h = harness({ session, seams: { playReplay: withPending } });
    const spec = testOf();
    const pending = { id: 'S3', name: 'Schritt S3', do: 'tun', expect: 'S3 da', design: 'design/s3.html', needs: ["getByRole('button', { name: 'Speichern' })"] };
    spec.steps.push(pending);
    spec.expectations.push({ id: 'S3', text: pending.expect });
    assert.equal(await runFlow({ spec, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null }), EXIT.pass);
    assert.deepEqual(h.result().pendingDesign, { step: 'S3', file: 'design/s3.html', verdict: 'not-ready', missing: ["getByRole('button', { name: 'Speichern' })"] });
});

test('Seam: the first pending step ready to record is named with the record command for the run\'s environment', async () => {
    // A page where the needed button is there once and reachable.
    const handle = { evaluate: async () => true, dispose: async () => {} };
    const frame = { getByRole: () => ({ elementHandles: async () => [handle] }) };
    const session = () => ({ ...fakeSession(), framework: { targets: () => true }, page: () => ({ mainFrame: () => frame }) });
    const h = harness({ session });
    const spec = testOf();
    const pending = { id: 'S3', name: 'Schritt S3', do: 'tun', expect: 'S3 da', needs: ["getByRole('button', { name: 'Speichern' })"] };
    spec.steps.push(pending);
    spec.expectations.push({ id: 'S3', text: pending.expect });
    const code = await runFlow({ spec, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
    assert.equal(code, EXIT.pass);
    assert.equal(h.result().needs.ready, true);
    assert.ok(h.notices.some((text) => /S3 ist bereit zum Aufnehmen: .*record kauf@S3 --env dev$/.test(text)), h.notices.join('\n'));
});

/** open <test>@<step> --design in the seam: ends developing at once; @returns the harness after the run. */
const openDesign = async (spec, at, designComparison) => {
    const bench = benchSession();
    const h = harness({ session: bench.make, seams: { designComparison }, extra: { withDesign: true }, developing: (ids, chat) => setImmediate(() => chat.human.choose('end')) });
    const code = await runFlow({ spec, ...at, handover: true, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
    assert.equal(code, EXIT.pass);
    return { ...h, bench };
};

test('Seam: open --design with the design file missing names the file and the step', async () => {
    const spec = testOf();
    spec.steps[1] = { ...spec.steps[1], design: 'design/fehlt.html' };
    const h = await openDesign(spec, { through: 'S2' }, async () => null);
    assert.ok(h.notices.some((text) => /design\/fehlt\.html/.test(text) && /S2/.test(text)), h.notices.join('\n'));
    assert.equal(h.bench.calls.filter(([name]) => name === 'design').length, 0);
});

test('Seam: open --design at a pending step names the step whose recorded size the design is drawn at', async () => {
    const spec = testOf();
    spec.steps[1] = { ...spec.steps[1], recording: { ...spec.steps[1].recording, viewport: { width: 1024, height: 700 } } };
    const pending = { id: 'S3', name: 'Schritt S3', do: 'tun', expect: 'S3 da', design: 'design/form.html' };
    spec.steps.push(pending);
    spec.expectations.push({ id: 'S3', text: pending.expect });
    let viewport;
    const h = await openDesign(spec, { entry: 'S3' }, async (given) => {
        viewport = given.viewport;
        return comparison(given.viewport);
    });
    assert.deepEqual(viewport, { width: 1024, height: 700 });
    const shown = h.notices.find((text) => /design\/form\.html/.test(text));
    assert.match(shown, /S2/, 'the size is the one S2 was recorded in');
    assert.doesNotMatch(shown, /S3/, 'S3 is not recorded');
});

test('Seam: the window with a design does not report a passed test in the terminal; it names the step it replayed to', async () => {
    const spec = testOf();
    spec.steps[1] = { ...spec.steps[1], design: 'design/form.html' };
    const lines = [];
    const log = console.log;
    console.log = (text) => lines.push(String(text));
    try {
        await openDesign(spec, { through: 'S2' }, async (given) => comparison(given.viewport));
    } finally {
        console.log = log;
    }
    const text = lines.join('\n');
    assert.doesNotMatch(text, /: pass\b|Bestanden\.|von \d+ Schritten bestanden/, text);
    assert.match(text, /kauf auf dev: Bis S2 abgespielt, um sein Zielbild zu zeigen; weder der Test noch das Zielbild wird hier bewertet./, text);
});

test('Seam: while a card after the run lets the app be reloaded, F5 reloads the app page; afterwards it is locked again', async () => {
    const bench = benchSession();
    let reloaded = 0;
    const make = () => ({ ...bench.make(), reloadPage: async () => { reloaded += 1; } });
    const h = harness({ session: make });
    const seen = [];
    const spec = testOf();
    await h.execute({
        spec,
        replay: replayOf(spec),
        conclude: async ({ reloadable }) => {
            await reloadable(true);
            seen.push(bench.handlers.refresh !== null);
            await bench.handlers.refresh?.();
            await reloadable(false);
            seen.push(bench.handlers.refresh !== null);
        },
    });
    assert.deepEqual(seen, [true, false]);
    assert.equal(reloaded, 1);
});
