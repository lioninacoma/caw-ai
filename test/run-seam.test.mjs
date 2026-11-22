// The seam between the flows and a run: executeRun and closeRun with a fake browser session, a chat without a window and a
// scripted playback. What the flows decide must reach the run and its files the same way the workbench does it.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createChat } from '../src/host/chat.mjs';
import { fixFlow, runFlow } from '../src/host/flows.mjs';
import { executeRun } from '../src/host/run.mjs';
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

test('Seam: open --design lists the deviations anew after F5, a reload of the window and restoring the state', async () => {
    const bench = benchSession();
    let computed = 0;
    const designOverlay = async () => {
        computed += 1;
        return { src: 'data:image/png;base64,AA', width: 1280, rows: [{ text: `Abweichung ${computed}` }] };
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
    const h = harness({ session: bench.make, seams: { designOverlay }, extra: { withDesign: true }, developing });
    const spec = testOf();
    spec.steps[1] = { ...spec.steps[1], design: 'design/form.html' };
    const code = await runFlow({ spec, through: 'S2', handover: true, canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
    assert.equal(code, EXIT.pass);
    const designs = bench.calls.filter(([name]) => name === 'design').map(([, given]) => given.rows.map(({ text }) => text).join());
    assert.deepEqual(designs, ['Abweichung 1', 'Abweichung 2', 'Abweichung 3', 'Abweichung 4'], 'once at open, then after F5, the window reload and restoring');
    assert.deepEqual(bench.calls.filter(([name]) => name === 'design').map(([, given]) => given.on), [true, undefined, undefined, undefined], 'F7 shown or hidden stays');
    assert.equal(h.notices.filter((text) => /neu aufgelistet/.test(text)).length, 3);
});

test('Seam: the target design of the first pending step, judged at its entry, is named and written to result.json; the run still passes', async () => {
    const judged = { step: 'S3', file: 'design/s3.html', verdict: 'not-met', missing: ['button "Speichern"'], extra: [], styleDiffs: [], layoutDiffs: ['Abstand heading "Notiz" → textarea "Notiz": 8px → 32px'], textDiffs: [] };
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
    const { step, file, verdict, missing, layoutDiffs } = h.result().pendingDesign;
    assert.deepEqual({ step, file, verdict, missing, layoutDiffs }, { step: 'S3', file: 'design/s3.html', verdict: 'not-met', missing: ['button "Speichern"'], layoutDiffs: judged.layoutDiffs });
    assert.ok(h.notices.some((text) => /^Zielbild von S3 an seinem Einstieg: noch nicht erfüllt \(lässt nichts scheitern\): design\/s3\.html Fehlt: button "Speichern"\. Layout weicht ab: Abstand/.test(text)), h.notices.join('\n'));
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
const openDesign = async (spec, at, designOverlay) => {
    const bench = benchSession();
    const h = harness({ session: bench.make, seams: { designOverlay }, extra: { withDesign: true }, developing: (ids, chat) => setImmediate(() => chat.human.choose('end')) });
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
        return { src: 'data:image/png;base64,AA', width: given.viewport.width, rows: [] };
    });
    assert.deepEqual(viewport, { width: 1024, height: 700 });
    const shown = h.notices.find((text) => /design\/form\.html/.test(text));
    assert.match(shown, /S2/, 'the size is the one S2 was recorded in');
    assert.doesNotMatch(shown, /S3/, 'S3 is not recorded');
});
