import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixFlow, recordFlow, runFlow } from '../src/host/flows.mjs';
import { stepHash } from '../src/host/test-file.mjs';
import { planView, samePlanStep } from '../src/host/test-plan.mjs';
import { CawError, EXIT } from '../src/shared/errors.mjs';

const stepOf = (id) => {
    const step = { id, name: id, do: '', expect: `${id} da` };
    return { ...step, recording: { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: 'z', actions: [{ action: 'reload' }], check: 'c' } };
};
const spec = { id: 't', steps: [stepOf('S1'), stepOf('S2')], expectations: [{ id: 'S1' }, { id: 'S2' }] };
const pass = { exitCode: EXIT.pass, verdict: { status: 'pass' } };
const failing = (id = 'S2', extra = {}) => ({ exitCode: EXIT.fail, verdict: { status: 'fail', reason: 'kaputt.' }, failed: { id, reason: 'weg.', suspect: false, ...extra } });
const nothing = { exitCode: EXIT.fail, verdict: { status: 'fail', reason: 'kaputt.' } };
const repaired = (extra = {}) => ({ ...pass, candidate: { ...spec, repaired: true }, fresh: [], ...extra });

/** Runs the flows without a browser: outcomes come in order, the human picks in order from `answers`. */
const harness = ({ outcomes, answers = ['adopt'] }) => {
    const calls = [];
    const adopted = [];
    const questions = [];
    const progress = [];
    const queue = [...outcomes];
    const wishes = [...answers];
    const notices = [];
    const said = [];
    const pick = (kind, text, options, card) => {
        const ids = options.map(({ id }) => id);
        questions.push({ kind, text, options: ids, labels: options.map(({ label }) => label), card, confirm: options.map(({ confirm }) => confirm) });
        // A message appears as { message } in the answers and only goes to discuss.
        const wish = wishes.find((candidate) => (typeof candidate === 'object' ? kind === 'discussing' : ids.includes(candidate)));
        if (wish !== undefined) wishes.splice(wishes.indexOf(wish), 1);
        return wish ?? ids.at(-1);
    };
    const chat = {
        choose: async (kind, text, options, card) => pick(kind, text, options, card),
        discuss: async (text, options) => {
            const wish = pick('discussing', text, options);
            return typeof wish === 'object' ? wish : { choice: wish };
        },
        notice: (text) => notices.push(text),
        progress: (text) => progress.push(text),
    };
    return {
        calls,
        adopted,
        questions,
        progress,
        notices,
        // What conclude returns to the run: { next } opens a new window, { outcome } is the last line in the chat.
        said,
        // `concluded` in an outcome only goes to conclude, e.g. talk or repairHere.
        execute: async ({ conclude, ...call }) => {
            calls.push(call);
            const { concluded = {}, ...outcome } = queue.shift();
            said.push(await conclude?.({ ...outcome, ...concluded, chat }));
            return outcome;
        },
        adopt: (draft, only) => {
            adopted.push({ draft, only });
            return 'caw/tests/t.yaml';
        },
        log: () => {},
    };
};

test('Recording: passed and adopted writes the whole plan', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, pass] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.equal(h.calls[0].sandbox, 's');
    assert.equal(h.calls[1].spec, spec);
    assert.ok(h.calls[1].replay.steps.length > 0);
    assert.deepEqual(h.adopted, [{ draft: spec, only: undefined }]);
    assert.deepEqual(h.questions.map(({ kind, options }) => [kind, options]), [['deciding', ['adopt', 'discard']]]);
});

test('Recording: discarding leaves everything as it is', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, pass], answers: ['discard'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.deepEqual(h.adopted, []);
    assert.deepEqual(h.said, [{ next: 'check' }, { outcome: 'Verworfen. Der Testplan bleibt unverändert.' }]);
});

test('Recording: the decision is a card; adopt names the steps and then the file', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, pass] });
    await recordFlow({ sandbox: 's', ...h });
    const [decision] = h.questions;
    assert.equal(decision.card.title, 'Prüflauf bestanden');
    assert.match(decision.card.facts[0], /ganze Testplan/);
    assert.equal(decision.card.question, 'Soll das der neue Testplan werden?');
    assert.deepEqual(decision.labels, [`Testplan übernehmen (${spec.steps.length} Schritte)`, 'Entwurf verwerfen']);
    assert.deepEqual(decision.confirm, [undefined, 'Wirklich verwerfen?'], 'only discard asks for confirmation');
    assert.deepEqual(h.said.at(-1), { outcome: 'Gespeichert: caw/tests/t.yaml' });
});

test('Recording: closing the window at the decision means not adopting', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, pass] });
    const execute = async ({ conclude, ...call }) => {
        const next = await h.execute(call);
        await conclude?.({ ...next, chat: { choose: async () => null } });
        return next;
    };
    assert.equal(await recordFlow({ sandbox: 's', ...h, execute }), EXIT.pass);
    assert.deepEqual(h.adopted, []);
});

test('Recording: Claude delivers nothing, the reason is in the chat, no check run', async () => {
    const h = harness({ outcomes: [nothing] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.fail);
    assert.equal(h.calls.length, 1);
    assert.match(h.questions[0].text, /kaputt/);
    assert.doesNotMatch(h.questions[0].text, /\.\./);
    assert.deepEqual(h.questions[0].options, ['close']);
});

test('Recording: if the check run fails, exactly that step is offered, also on the draft', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, failing('S2'), repaired(), pass], answers: ['fix', 'adopt'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.match(h.questions[0].text, /^S2 ist gescheitert: weg\. Beheben beginnt in einem frischen Browser mit den Schritten davor\.$/);
    assert.deepEqual(h.questions[0].options, ['fix', 'close']);
    assert.equal(h.questions[0].kind, 'discussing');
    assert.deepEqual(h.calls[2].repair, { id: 'S2', reason: 'weg.' });
    assert.equal(h.calls[2].spec, spec, 'the draft is repaired');
    assert.equal(h.adopted[0].only, undefined, 'a draft is adopted as a whole');
    assert.equal(h.adopted[0].draft.repaired, true);
});

test('Recording: the same failure after fixing is named, closing is then the main path', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, failing('S2'), repaired(), failing('S2')], answers: ['fix', 'close'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.fail);
    assert.doesNotMatch(h.questions[0].text, /derselbe Fehler/);
    assert.match(h.questions[1].text, /derselbe Fehler wie nach dem letzten Beheben.*caw\.config\.json/);
    assert.deepEqual(h.questions[1].options, ['close', 'fix']);
    assert.deepEqual(h.adopted, []);
});

test('Recording: closing at the offer leaves the test plan unchanged', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, failing('S2')], answers: ['close'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.fail);
    assert.deepEqual(h.adopted, []);
});

test('Fix: only this step is written; if another fails in the check run, that one is offered', async () => {
    const h = harness({ outcomes: [repaired(), failing('S1'), repaired(), pass], answers: ['fix', 'adopt'] });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.pass);
    assert.deepEqual(h.calls.filter(({ repair }) => repair).map(({ repair }) => repair.id), ['S2', 'S1']);
    assert.deepEqual([...h.adopted[0].only], ['S2', 'S1']);
    assert.match(h.calls[1].note, /S2 wurde behoben, Anlass: Grund/);
});

test('Fix: if a step before fails, that one is offered', async () => {
    const h = harness({ outcomes: [failing('S1'), repaired(), pass], answers: ['fix', 'adopt'] });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.pass);
    assert.equal(h.calls[1].repair.id, 'S1');
    assert.deepEqual([...h.adopted[0].only], ['S1']);
});

test('Fix: Claude does not make it, the test plan stays', async () => {
    const h = harness({ outcomes: [nothing] });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.fail);
    assert.match(h.questions[0].text, /Für S2 ist keine neue Aufzeichnung entstanden/);
    assert.deepEqual(h.adopted, []);
});

test('Fix: the decision names a changed result, new messages and what is still stale', async () => {
    const stale = { ...spec, steps: [spec.steps[0], { ...spec.steps[1], do: 'von Hand' }] };
    const h = harness({
        outcomes: [{ ...pass, candidate: stale, fresh: ['Sicher?'], expectChange: { id: 'S1', before: 'alt', after: 'neu' } }, pass],
    });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S1', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.pass);
    const { text } = h.questions[0];
    assert.match(text, /Neu als bekannte Meldung, das Abspielen meldet sie nicht mehr: Sicher\?/);
    assert.match(text, /Geändertes Ergebnis in S1: „neu“ statt „alt“/);
    assert.match(text, /Noch veraltet und nicht geprüft: S2/);
    assert.equal(h.calls[1].replay.until, 'S1');
    assert.match(h.calls[1].note, /Erwartet vorher: alt/);
});

test('Test run: a pass is only announced in the open chat, without Docker, without waiting, and the window goes as requested', async () => {
    const h = harness({ outcomes: [{ ...pass, verdict: { status: 'pass', warnings: [{ text: 't.getKey.', origin: 'x.js' }] } }] });
    const openSandbox = async () => assert.fail('Claude is not needed');
    assert.equal(await runFlow({ spec, handover: true, canFix: true, openSandbox, ...h }), EXIT.pass);
    assert.deepEqual(h.questions, []);
    assert.deepEqual(h.notices, ['Der Lauf hat bestanden. Warnungen: t.getKey (x.js).']);
    assert.equal(h.calls[0].testing, true);
    assert.equal(h.calls[0].handover(), true);
    assert.equal(h.calls[0].replay.until, undefined);
});

test('Test run: a green run fills in missing baselines without Claude; without a chat the file stays', async () => {
    const network = [{ name: 'GET /a', status: 200, ms: 40 }];
    const baselines = new Map([['S1', network]]);
    const h = harness({ outcomes: [{ ...pass, baselines }] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, fillBaselines: true, openSandbox: async () => assert.fail('no Claude'), ...h }), EXIT.pass);
    assert.match(h.notices[0], /^Der Lauf hat bestanden\. Vergleichswerte für S1 aufgezeichnet/);
    assert.equal(h.adopted.length, 1);
    assert.deepEqual([...h.adopted[0].only], ['S1']);
    assert.deepEqual(h.adopted[0].draft.steps[0].recording.network, network);
    assert.equal(h.adopted[0].draft.steps[0].recording.hash, spec.steps[0].recording.hash);
    assert.equal(h.adopted[0].draft.steps[1].recording.network, undefined);

    const quiet = harness({ outcomes: [{ ...pass, baselines }] });
    await runFlow({ spec, handover: false, canFix: false, openSandbox: async () => 's', ...quiet });
    assert.deepEqual(quiet.adopted, []);
});

test('Re-record: a step that did not fail is called that on the card, in the task and in the check run', async () => {
    const h = harness({ outcomes: [repaired(), pass] });
    await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Wunsch', rerecord: true }, sandbox: 's', ...h });
    assert.equal(h.calls[0].repair.rerecord, true);
    assert.match(h.calls[1].note, /^S2 wurde neu aufgenommen, Anlass: Wunsch\./);
    const step = { id: 'S2', name: 'N', do: 'D', expect: 'E', retry: { times: 3, waitMs: 1000 } };
    assert.equal(planView({ steps: [step] }, { repairing: true, rerecord: true }).title, 'S2 neu aufnehmen');
    assert.equal(planView({ steps: [step] }, { repairing: true }).title, 'S2 beheben');
    assert.equal(planView({ steps: [step] }).title, 'Ablaufplan');
    assert.equal(samePlanStep(step, { ...step, recording: { check: 'x' } }), true);
    assert.equal(samePlanStep(step, { ...step, expect: 'F' }), false);
    assert.equal(samePlanStep(step, { ...step, retry: { times: 2, waitMs: 1000 } }), false);
    assert.equal(samePlanStep({ ...step, note: '' }, step), true);
});

test('Test run: after a change to the app there is "test again" instead of "fix step"', async () => {
    const advice = { spec, touched: [], stale: [], files: ['src/app.js'], notes: false };
    const h = harness({ outcomes: [{ ...failing('S2'), concluded: { flawed: true, advise: async () => advice } }, pass], answers: ['rerun'] });
    const code = await runFlow({ spec, handover: true, canFix: true, advise: true, openSandbox: async () => 's', ...h });
    assert.equal(code, EXIT.pass);
    assert.equal(h.calls.length, 2, 'a second run with the changed app');
    assert.equal(h.calls[0].handover(), false, 'the window only goes to the human after the new run');
    assert.deepEqual(h.questions.map(({ options }) => options), [['rerun', 'close']], 'no fix step');
    assert.match(h.questions[0].text, /die Änderung an der Anwendung \(src\/app\.js\) ist übernommen/);

    // Only the config adopted, the code change rejected: then the chat says exactly that.
    const onlyConfig = harness({ outcomes: [{ ...failing('S2'), concluded: { flawed: true, advise: async () => ({ ...advice, files: ['caw.config.json'] }) } }], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, advise: true, openSandbox: async () => 's', ...onlyConfig });
    assert.match(onlyConfig.questions[0].text, /die Änderung an caw\.config\.json ist übernommen, die Anwendung ist unverändert/);
    assert.deepEqual(onlyConfig.notices, ['Geändert: caw.config.json. Committet wird nichts.']);

    const closed = harness({ outcomes: [{ ...failing('S2'), concluded: { flawed: true, advise: async () => advice } }], answers: ['close'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, advise: true, openSandbox: async () => 's', ...closed }), EXIT.fail);
    assert.equal(closed.calls.length, 1);
});

test('Test run: without --advise Claude looks for the cause on click, as the main button for an app failure', async () => {
    const advice = { spec, touched: [], stale: [], files: ['src/app.js'], notes: false };
    let advised = 0;
    const app = { side: 'app', text: 'Einschätzung: Fehler der Anwendung (eindeutig).', findings: ['HTTP 500.'] };
    const concluded = { flawed: true, advise: async () => { advised += 1; return advice; } };
    const h = harness({ outcomes: [{ ...failing('S2', { diagnosis: app }), concluded }, pass], answers: ['ask', 'rerun'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h }), EXIT.pass);
    assert.equal(advised, 1, 'Claude only after the click');
    assert.deepEqual(h.questions.map(({ options }) => options), [['ask', 'fix', 'close'], ['rerun', 'close']]);
    assert.equal(h.calls.length, 2);

    // Without the "app" assessment, fix stays first; asking still works.
    const other = harness({ outcomes: [failing('S2')], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...other });
    assert.deepEqual(other.questions[0].options, ['fix', 'ask', 'close']);

    // With --advise Claude already advised: do not ask a second time.
    const fixed = harness({ outcomes: [{ ...failing('S2', { diagnosis: app }), concluded: { flawed: true, advise: async () => null } }], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, advise: true, openSandbox: async () => 's', ...fixed });
    assert.deepEqual(fixed.questions[0].options, ['fix', 'close']);
});

test('Test run: up to a step', async () => {
    const h = harness({ outcomes: [pass] });
    await runFlow({ spec, until: 'S1', handover: true, canFix: true, openSandbox: async () => 's', ...h });
    assert.equal(h.calls[0].replay.until, 'S1');
    assert.deepEqual(h.calls[0].replay.steps.map(({ action }) => action), ['reload', 'check']);
});

test('Test run: step failed, nothing starts without a click', async () => {
    const h = harness({ outcomes: [failing('S2')], answers: ['close'] });
    let opened = 0;
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => { opened += 1; return 's'; }, ...h }), EXIT.fail);
    assert.equal(opened, 0);
    assert.equal(h.calls.length, 1);
});

test('Test run: clicking fix only then opens the sandbox and does not hand over the window', async () => {
    const h = harness({ outcomes: [failing('S2'), repaired(), pass], answers: ['fix', 'adopt'] });
    let opened = 0;
    assert.equal(await runFlow({ spec, handover: true, canFix: true, openSandbox: async () => { opened += 1; return 's'; }, ...h }), EXIT.pass);
    assert.equal(opened, 1);
    assert.equal(h.calls[1].sandbox, 's');
    assert.deepEqual(h.progress, ['Bereite die Sandbox vor']);
    assert.equal(h.calls[0].handover(), false);
});

test('Test run: fix and then discard ends with the original failure', async () => {
    const h = harness({ outcomes: [failing('S2'), repaired(), pass], answers: ['fix', 'discard'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h }), EXIT.fail);
    assert.deepEqual(h.adopted, []);
});

test('Test run: a hard failure gets the offer with a hint at the app', async () => {
    const h = harness({ outcomes: [failing('S2', { suspect: true })], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h });
    assert.match(h.questions[0].text, /Fehler der Anwendung/);
    assert.deepEqual(h.questions[0].options, ['fix', 'ask', 'close']);
});

test('Test run: without Docker or token the failure stays, the reason is in the chat', async () => {
    const h = harness({ outcomes: [failing('S2')], answers: ['fix'] });
    const openSandbox = async () => { throw new CawError('token-missing', 'kein Token'); };
    assert.equal(await runFlow({ spec, handover: true, canFix: true, openSandbox, ...h }), EXIT.fail);
    assert.match(h.questions[1].text, /Beheben geht gerade nicht: kein Token/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].handover(), true, 'without a fix the human gets their window');
});

test('Test run without terminal or on a higher stage: no offer, no chat, only the hint', async () => {
    const h = harness({ outcomes: [failing('S2')] });
    const hints = [];
    assert.equal(await runFlow({ spec, handover: false, canFix: false, openSandbox: async () => assert.fail('never'), hint: (failed) => hints.push(failed.id), ...h }), EXIT.fail);
    assert.equal(h.calls[0].testing, undefined);
    assert.deepEqual(h.questions, []);
    assert.deepEqual(hints, ['S2']);
});

test('Test run: only the message starts Claude, further ones go into the same conversation, closing ends it', async () => {
    const talked = [];
    const talk = ({ sandbox }, message) => {
        talked.push(['start', sandbox, message]);
        return { over: () => false, send: (text) => talked.push(['send', text]), end: async () => { talked.push(['end']); return null; } };
    };
    const h = harness({ outcomes: [{ ...failing('S2'), concluded: { talk } }], answers: [{ message: 'Warum?' }, { message: 'Und jetzt?' }, 'close'] });
    let opened = 0;
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => { opened += 1; return 's'; }, ...h }), EXIT.fail);
    assert.deepEqual(talked, [['start', 's', 'Warum?'], ['send', 'Und jetzt?'], ['end']]);
    assert.equal(opened, 1);
    // The button shows the way to Claude; typing still works.
    assert.doesNotMatch(h.questions[0].text, /Du kannst Claude auch erst fragen/);
    assert.deepEqual(h.questions[0].options, ['fix', 'ask', 'close']);
    assert.deepEqual(h.questions.map(({ kind }) => kind), ['discussing', 'discussing', 'discussing']);
    assert.equal(h.calls.length, 1);
});

test('Test run: a clean step is fixed in the same browser, then only the check run follows', async () => {
    const asked = [];
    const repairHere = async (given) => { asked.push(given); return repaired(); };
    const h = harness({ outcomes: [{ ...failing('S2'), concluded: { repairHere } }, pass], answers: ['fix', 'adopt'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h }), EXIT.pass);
    assert.match(h.questions[0].text, /im selben Browser, ohne die Schritte davor/);
    assert.deepEqual(asked, [{ sandbox: 's', reason: 'weg.' }]);
    assert.equal(h.calls.length, 2, 'no second run with warm-up');
    assert.equal(h.calls[1].repair, undefined);
    assert.match(h.calls[1].note, /S2 wurde behoben, Anlass: weg/);
    assert.deepEqual([...h.adopted[0].only], ['S2']);
});

test('Developing in a state with the Claude Code session as agent: it is there right away, not only after the first question', async () => {
    const h = harness({ outcomes: [pass] });
    let opened = 0;
    await runFlow({ spec, until: 'S2', handover: true, canFix: true, sessionAgent: true, openSandbox: async () => { opened += 1; return 'box'; }, ...h });
    const { develop } = h.calls[0];
    const sent = [];
    const answers = [{ message: 'Was siehst du?' }, { choice: 'end' }];
    const intro = [];
    const chat = {
        develop: async (question) => {
            intro.push(question);
            sent.push(`opened=${opened}`);
            return answers.shift();
        },
        notice: () => {},
        progress: () => {},
        onPicked: () => {},
    };
    const talk = (options, question) => {
        sent.push({ question, sandbox: options.sandbox });
        return { over: () => false, send: (text) => sent.push({ text }), end: async () => {} };
    };
    await develop({ chat, talk, until: 'S2', refresh: async () => '', restore: async () => '', onRefresh: () => {}, onReload: () => () => {}, toCode: () => {} });
    assert.deepEqual(sent, [{ question: undefined, sandbox: 'box' }, 'opened=1', { text: 'Was siehst du?' }, 'opened=1']);
    assert.match(intro[0], /Claude-Code-Sitzung ist verbunden/);
    assert.doesNotMatch(intro[0], /kosten Token/);
});

test('Developing in a state: refresh without state, restore state, crosshair to Claude Code, questions to Claude', async () => {
    const h = harness({ outcomes: [pass] });
    let opened = 0;
    await runFlow({ spec, until: 'S2', handover: true, canFix: true, openSandbox: async () => { opened += 1; return 'box'; }, ...h });
    const { develop } = h.calls[0];
    assert.equal(typeof develop, 'function');
    const element = { label: 'button "Senden"', target: { role: 'button' } };
    let refresher = 'never set';
    let reloaded = null;
    let picked = null;
    let refreshed = 0;
    const answers = [
        { choice: 'restore' },
        { message: 'Warum ist der deaktiviert?', element },
        { message: 'Und jetzt?' },
        { choice: 'end' },
    ];
    const notices = [];
    const shown = [];
    const sent = [];
    let ended = 0;
    const chat = {
        develop: async (question, options) => {
            shown.push({ question, options: options.map(({ id }) => id) });
            if (shown.length === 1) {
                // The human presses F5, picks an element with the crosshair, then reloads the whole workbench.
                await refresher();
                picked(element);
                await reloaded();
            }
            return answers.shift();
        },
        notice: (text) => notices.push(text),
        progress: () => {},
        onPicked: (handler) => { picked = handler; },
    };
    const handed = [];
    const talk = (options, question, about) => {
        sent.push({ question, about, sandbox: options.sandbox });
        return { over: () => false, send: (text, about2) => sent.push({ text, about: about2 }), end: async () => { ended += 1; } };
    };
    await develop({
        chat,
        talk,
        until: 'S2',
        refresh: async () => { refreshed += 1; return ''; },
        restore: async () => 'Zustand S2 ist neu hergestellt',
        onRefresh: (handler) => { refresher = handler; },
        onReload: (listener) => { reloaded = listener; return () => { reloaded = 'unsubscribed'; }; },
        toCode: (value) => handed.push(value),
    });
    assert.match(shown[0].question, /^Zustand S2 steht\. .*Neu laden.*Zustand neu herstellen.*Fadenkreuz.*kosten Token/);
    assert.deepEqual(shown[0].options, ['restore', 'end']);
    assert.equal(shown[1].question, undefined, 'the introduction comes only once');
    assert.equal(refreshed, 1, 'refresh only reloads the page, without a message');
    assert.deepEqual(handed, [element], 'the crosshair hands the element to Claude Code right away');
    assert.match(notices[0], /„button "Senden"“ hängt an deiner nächsten Frage hier im Chat/);
    assert.ok(!notices.some((text) => /neu geladen|nicht mehr gesichert/.test(text)), 'reloading the workbench does not warn while developing');
    assert.equal(notices[1], 'Zustand S2 ist neu hergestellt');
    assert.deepEqual(sent[0], { question: 'Warum ist der deaktiviert?', about: element, sandbox: 'box' });
    assert.deepEqual(sent[1], { text: 'Und jetzt?', about: undefined });
    assert.equal(opened, 1, 'Claude only on the first question');
    assert.equal(ended, 1, 'ending also ends the conversation');
    assert.equal(refresher, null, 'after developing, refresh is locked again');
    assert.equal(reloaded, 'unsubscribed');
    assert.equal(picked, null);

    // The dev server is restarting: restoring fails, the chat reports it, developing continues; closing the window ends Claude.
    const later = [{ choice: 'restore' }, { message: 'Hallo' }, null];
    const said = [];
    let stopped = 0;
    await develop({
        chat: { ...chat, develop: async () => later.shift(), notice: (text) => said.push(text) },
        talk: () => ({ over: () => false, send: () => {}, end: async () => { stopped += 1; } }),
        until: 'S2',
        refresh: async () => '',
        restore: async () => { throw new Error('net::ERR_CONNECTION_REFUSED at http://app.localhost:5173/\nCall log: ...'); },
        toCode: () => {},
    });
    assert.match(said[0], /^Zustand neu herstellen ging nicht: net::ERR_CONNECTION_REFUSED at http:\/\/app\.localhost:5173\/\. Läuft der Dev-Server/);
    assert.equal(stopped, 1, 'closing the window ends a running conversation');
});

test('Test run: if only the effects deviate, "forget effect" forgets them without Claude; otherwise there is no such button', async () => {
    const effects = { controls: ['button "Neu"'] };
    const learned = { ...spec, steps: spec.steps.map((step) => ({ ...step, recording: { ...step.recording, effects } })) };
    const reason = 'Die Prüfung ist erfüllt, aber die Anwendung reagiert anders als in gesunden Läufen. Aktion 1 click: fehlt button "Neu".';
    const h = harness({ outcomes: [failing('S2', { reason })], answers: ['forget-effect'] });
    assert.equal(await runFlow({ spec: learned, handover: false, canFix: true, openSandbox: async () => assert.fail('no Claude'), ...h }), EXIT.fail);
    assert.equal(h.questions[0].options[0], 'forget-effect');
    assert.equal(h.adopted.length, 1);
    assert.deepEqual([...h.adopted[0].only], ['S2']);
    assert.equal(h.adopted[0].draft.steps[1].recording.effects, undefined);
    assert.deepEqual(h.adopted[0].draft.steps[0].recording.effects, effects);
    assert.equal(h.adopted[0].draft.steps[1].recording.hash, spec.steps[1].recording.hash);
    assert.match(h.notices.at(-1), /^Die gelernte Wirkung von S2 ist vergessen\. Die nächsten 2 gesunden Läufe/);

    const other = harness({ outcomes: [failing('S2')], answers: ['close'] });
    await runFlow({ spec: learned, handover: false, canFix: true, openSandbox: async () => 's', ...other });
    assert.equal(other.questions[0].options.includes('forget-effect'), false);
});

test('If a step is still stale after the check run, the decision offers to re-record it', async () => {
    const stale = { ...spec, steps: [spec.steps[0], { ...spec.steps[1], expect: 'S2 anders' }] };
    const h = harness({ outcomes: [pass, repaired(), pass], answers: ['rerecord-next', 'adopt'] });
    await fixFlow({ draft: stale, sandbox: 's', ...h });
    assert.deepEqual(h.questions[0].options, ['rerecord-next', 'adopt', 'discard']);
    assert.match(h.questions[0].text, /Noch veraltet und nicht geprüft: S2\./);
    assert.equal(h.calls[1].repair.id, 'S2');
    assert.equal(h.calls[1].repair.rerecord, true);
    assert.equal(h.adopted.length, 1);
});

test('Check run: only script errors can be ignored with one click, then a new run checks without Claude', async () => {
    let ignored = 0;
    const ignore = () => { ignored += 1; return ['t.getKey is not a function']; };
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, { ...failing('S2'), concluded: { ignore } }, pass], answers: ['ignore-errors', 'adopt'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.deepEqual(h.questions[0].options, ['ignore-errors', 'fix', 'close'], 'ignore first, fix stays');
    assert.equal(ignored, 1);
    assert.equal(h.calls.length, 3, 'recording, check run, another check run, no Claude');
    assert.equal(h.calls[2].repair, undefined);
    assert.ok(h.notices.some((text) => text.includes('consoleIgnore eingetragen: t.getKey')), JSON.stringify(h.notices));
    assert.ok(h.notices.some((text) => /Prüflauf ohne Claude startet/.test(text)));
    assert.deepEqual(h.said[1], { next: 'check' });
});

test('Check run: all steps passed but script errors: ignore instead of a dead end', async () => {
    const ignore = () => ['x'];
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, { ...nothing, concluded: { ignore } }, pass], answers: ['ignore-errors', 'adopt'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.deepEqual(h.questions[0].options, ['ignore-errors', 'close']);
    assert.equal(h.calls.length, 3);
});

test('Check run: if the human adopts an ignore advice in the conversation that allows all failures, it continues without "fix step"', async () => {
    let notify;
    const talker = {
        over: () => false,
        send: () => {},
        log: () => [],
        configChanged: () => new Promise((resolve) => { notify = resolve; }),
        end: async () => null,
    };
    const talk = () => {
        // Claude advises, the human adopts: the config now allows everything.
        setTimeout(() => notify(), 10);
        return talker;
    };
    let allowed = false;
    const cleared = () => allowed;
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, { ...failing('S2'), concluded: { talk, cleared } }, pass], answers: [{ message: 'setze t.getKey auf ignore' }, 'adopt'] });
    // After the first message the chat waits; the next answer never comes, the config change ends the wait.
    const discuss = h.execute;
    let asked = 0;
    const execute = async ({ conclude, ...call }) => discuss({ ...call, conclude: conclude === undefined ? undefined : (concluded) => conclude({
        ...concluded,
        chat: { ...concluded.chat, discuss: async (...args) => { asked += 1; if (asked === 1) return concluded.chat.discuss(...args); allowed = true; return new Promise(() => {}); } },
    }) });
    assert.equal(await recordFlow({ sandbox: 's', ...h, execute, openSandbox: async () => 's' }), EXIT.pass);
    assert.equal(h.calls.length, 3, 'recording, check run, new check run without a fix');
    assert.equal(h.calls[2].repair, undefined);
    assert.ok(h.notices.some((text) => /Prüflauf ohne Claude startet/.test(text)));
});

test('Developing: a pick with F1 restores the state, one after another with restore', async () => {
    const h = harness({ outcomes: [pass] });
    await runFlow({ spec, until: 'S2', handover: true, canFix: true, openSandbox: async () => 'box', ...h });
    const { develop } = h.calls[0];
    let pick = null;
    const restored = [];
    const notices = [];
    const chat = {
        develop: async () => {
            // The human picks a test without a step with F1, then one with a step; then ends.
            await pick('anderer-test', undefined, { role: 'sachbearbeiter', until: 'S3' });
            await pick('anderer-test', 'S1', { role: 'sachbearbeiter', until: 'S1' });
            return { choice: 'end' };
        },
        // The human confirms each pick in the chat.
        choose: async (kind, question, options) => options[0].id,
        notice: (text) => notices.push(text),
        progress: () => {},
        onPicked: () => {},
    };
    await develop({
        chat,
        talk: () => ({}),
        until: 'S2',
        refresh: async () => '',
        restore: async () => '',
        restoreTo: async (testId, step) => { restored.push([testId, step]); return `${testId} ${step ?? 'Ende'} hergestellt`; },
        onPickState: (handler) => { pick = handler; },
        onRefresh: () => {},
        toCode: () => {},
    });
    assert.deepEqual(restored, [['anderer-test', undefined], ['anderer-test', 'S1']]);
    assert.deepEqual(notices, ['anderer-test Ende hergestellt', 'anderer-test S1 hergestellt']);
    assert.equal(pick, null, 'after developing, F1 is unsubscribed');
});

test('Developing: a state picked with F1 is restored only after the human confirms it in the chat', async () => {
    const h = harness({ outcomes: [pass] });
    await runFlow({ spec, until: 'S2', handover: true, canFix: true, openSandbox: async () => 'box', ...h });
    const { develop } = h.calls[0];
    let pick = null;
    const restored = [];
    const asked = [];
    let answer = null;
    const chat = {
        develop: async () => {
            // The pick may come from the application (same origin as the workbench): nothing happens until the chat answers.
            const first = pick('anderer-test', undefined, { role: 'sachbearbeiter', until: 'S3' });
            await new Promise((ok) => { setImmediate(ok); });
            assert.deepEqual(restored, [], 'not before the answer');
            // A second pick while the question is open is dropped, not queued.
            await pick('dritter-test', 'S1', { role: 'antragsteller', until: 'S1' });
            answer('cancel-restore');
            await first;
            const second = pick('anderer-test', 'S1', {});
            answer('restore-picked');
            await second;
            return { choice: 'end' };
        },
        choose: (kind, question, options) => {
            asked.push([kind, question, options.map(({ id, label }) => `${id}:${label}`)]);
            return new Promise((ok) => { answer = ok; });
        },
        notice: () => {},
        progress: () => {},
        onPicked: () => {},
    };
    await develop({
        chat,
        talk: () => ({}),
        until: 'S2',
        refresh: async () => '',
        restore: async () => '',
        restoreTo: async (testId, step) => { restored.push([testId, step]); return ''; },
        onPickState: (handler) => { pick = handler; },
        onRefresh: () => {},
        toCode: () => {},
    });
    assert.deepEqual(asked, [
        ['deciding', 'anderer-test bis S3 als sachbearbeiter herstellen?', ['restore-picked:Herstellen', 'cancel-restore:Abbrechen']],
        ['deciding', 'anderer-test bis S1 herstellen?', ['restore-picked:Herstellen', 'cancel-restore:Abbrechen']],
    ]);
    assert.deepEqual(restored, [['anderer-test', 'S1']], 'cancelled is not restored, confirmed is');
});
