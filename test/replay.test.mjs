import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplay, createRecorder, failedStep, fillTarget, playReplay, replayOf, replayToEntry, replayVerdict, positionalActions, stepGroups, stepLabel, stepRecords, swapToken } from '../src/host/replay.mjs';
import { stepHash } from '../src/host/test-file.mjs';
import { extjs } from '../src/ext/extjs/extjs.mjs';
import { classifyFailure, renderReport, stackOrigin } from '../src/shared/report.mjs';
import { LEARN_RUNS, controlsProbe } from '../src/host/effects.mjs';

const runbook = { expectations: [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }] };
const NEXT_BUTTON = "locator('extjs=app_actionButton[text=\"Weiter\"]')";

// A page whose locators only carry their selector; the test decides which locator code each one records (recordTarget).
const pageWith = () => ({ locator: (selector) => ({ selector }) });
const recordWith = (describe) => async (locator) => describe(locator.selector.replace(/^aria-ref=/, ''));

const recorderWith = (describe, handler = async () => 'ok') => createRecorder({
    handler,
    session: { page: () => pageWith() },
    base: 'https://portal.example',
    recordTarget: recordWith(describe),
});

test('Recorder: references become stable targets, reads and failed attempts stay out', async () => {
    const recorder = recorderWith(() => NEXT_BUTTON, async (command) => {
        if (command.target === 'e-kaputt') throw Object.assign(new Error('verdeckt'), { code: 'failed' });
        if (command.action === 'check') return { pass: command.code === 'gut' };
        if (command.action === 'wait-ready') return { settled: true };
        return 'ok';
    });
    for (const command of [{ action: 'snapshot' }, { action: 'url' }, { action: 'eval', code: 'x' }, { action: 'console' }]) await recorder.handler(command);
    await assert.rejects(recorder.handler({ action: 'click', target: 'e-kaputt' }));
    await recorder.handler({ action: 'click', target: 'e12' });
    await recorder.handler({ action: 'wait-ready' });
    await recorder.handler({ action: 'wait-ready' });
    await recorder.handler({ action: 'fill', target: 'e13', value: 'Text' });
    await recorder.handler({ action: 'check', id: 'S1', code: 'schlecht' });
    await recorder.handler({ action: 'check', id: 'S1', code: 'gut' });
    assert.deepEqual(recorder.steps, [
        { action: 'click', target: NEXT_BUTTON },
        { action: 'wait-ready' },
        { action: 'fill', target: NEXT_BUTTON, value: 'Text' },
        { action: 'check', id: 'S1', code: 'gut' },
    ]);
    assert.deepEqual(recorder.problems, []);
});

test('Recorder: two wait-ready merge into one with the more specific wait and the longer timeout', async () => {
    const recorder = recorderWith(() => NEXT_BUTTON, async () => ({ settled: true }));
    await recorder.handler({ action: 'wait-ready', timeout: 60_000 });
    await recorder.handler({ action: 'wait-ready', for: 'antraege', minCount: 1 });
    await recorder.handler({ action: 'click', target: 'e1' });
    await recorder.handler({ action: 'wait-ready', for: 'liste' });
    await recorder.handler({ action: 'wait-ready' });
    assert.deepEqual(recorder.steps, [
        { action: 'wait-ready', for: 'antraege', minCount: 1, timeoutMs: 60_000 },
        { action: 'click', target: NEXT_BUTTON },
        { action: 'wait-ready', for: 'liste' },
    ]);
});

test('Recorder: dates close to the recording day become relative', async () => {
    const field = "getByRole('textbox', { name: 'Frist 21.11.2026', exact: true })";
    const recorder = createRecorder({ handler: async () => 'ok', session: { page: () => pageWith(), browser: { locale: 'de-DE' } }, base: 'https://portal.example', now: () => new Date(2026, 10, 7), recordTarget: recordWith(() => field) });
    await recorder.handler({ action: 'fill', target: 'e1', value: '21.11.2026' });
    assert.deepEqual(recorder.steps, [{ action: 'fill', target: "getByRole('textbox', { name: 'Frist {{date+14}}', exact: true })", value: '{{date+14}}' }]);
});

test('swapToken: remembered values only as whole tokens and only in inputs, checks, URLs and target texts', () => {
    const target = "locator('#v2026').filter({ hasText: '2026 offen' }).getByRole('link', { name: 'Vorgang 2026.', exact: true })";
    const step = { action: 'click', value: '2026', code: "t === 'Nr 2026' && d === '07.11.2026' && k === 'VG-2026' && 'x2026'", url: '/vorgang/2026?a=2026', target };
    assert.deepEqual(swapToken(step, '2026', '{{nr}}'), {
        action: 'click',
        value: '{{nr}}',
        code: "t === 'Nr {{nr}}' && d === '07.11.2026' && k === 'VG-2026' && 'x2026'",
        url: '/vorgang/{{nr}}?a={{nr}}',
        target: "locator('#v2026').filter({ hasText: '{{nr}} offen' }).getByRole('link', { name: 'Vorgang {{nr}}.', exact: true })",
    }, 'texts and selectors of the target, only whole tokens: #v2026 stays');
});

test('swapToken: also in a regular expression of the target, as written there, so the next run fills in its own value', () => {
    const cell = (text) => `locator('extjs=grid gridrow').locator('extjs=gridcell').filter({ hasText: /^${text}$/ })`;
    const step = { action: 'dblclick', target: cell('9990001234567890001') };
    const swapped = swapToken(step, '9990001234567890001', '{{vorgangsnr}}');
    assert.equal(swapped.target, cell('{{vorgangsnr}}'));
    assert.equal(fillTarget(swapped.target, () => '9990001234567890002'), cell('9990001234567890002'));
    // Escaped as the regular expression has it; a longer number or a date with it stays.
    assert.equal(swapToken({ action: 'click', target: cell('A\\.1 \\(x\\)') }, 'A.1 (x)', '{{nr}}').target, cell('{{nr}}'));
    assert.equal(swapToken({ action: 'click', target: cell('99900012345678900011') }, '9990001234567890001', '{{nr}}').target, cell('99900012345678900011'));
    assert.equal(swapToken({ action: 'click', target: cell('07\\.11\\.2026') }, '2026', '{{nr}}').target, cell('07\\.11\\.2026'));
});

test('fillTarget: placeholders through the string arguments: quotes stay one string, a regular expression gets the value escaped', () => {
    const lookup = (placeholder) => ({ '{{name}}': "O'Brien (Kunde)", '{{runTag}}': 'CAW-1' })[placeholder];
    assert.equal(fillTarget("getByRole('row').filter({ hasText: '{{name}} {{runTag}}' }).getByRole('button', { name: /^Öffnen {{name}}$/ })", lookup),
        "getByRole('row').filter({ hasText: 'O\\'Brien (Kunde) CAW-1' }).getByRole('button', { name: /^Öffnen O'Brien \\(Kunde\\)$/ })");
    assert.equal(fillTarget("getByText('{{unknown}}')", lookup), "getByText('{{unknown}}')", 'an unknown placeholder stays');
});

test('Recorder: messages belong to the action before them and are dropped with it', async () => {
    const shown = ['Willkommen'];
    const recorder = createRecorder({
        handler: async () => 'ok',
        session: { page: () => ({ ...pageWith(), evaluate: async () => ({ messages: [...shown] }) }) },
        base: 'https://portal.example',
        recordTarget: recordWith(() => NEXT_BUTTON),
    });
    await recorder.handler({ action: 'click', target: 'e1' });
    shown.push('Pflichtfeld fehlt');
    await recorder.handler({ action: 'click', target: 'e2' });
    shown.pop();
    await recorder.handler({ action: 'fill', target: 'e3', value: 'x' });
    assert.deepEqual([...recorder.messages].sort(), ['Pflichtfeld fehlt', 'Willkommen']);
    recorder.drop([1]);
    assert.deepEqual([...recorder.messages], ['Willkommen'], 'the misclick takes its dialog with it');
});

test('positionalActions: targets chosen by position or by a bare tag are listed', () => {
    const spec = { steps: [
        { id: 'S1', recording: { actions: [{ action: 'click', target: "getByRole('button', { name: 'Weiter', exact: true })" }] } },
        { id: 'S2', recording: { actions: [{ action: 'click', target: "locator('extjs=button').nth(5)" }] } },
        { id: 'S3', recording: { actions: [{ action: 'click', target: "getByRole('button', { name: 'Bearbeiten' }).nth(2)" }, { action: 'click', target: "locator('div')" }] } },
    ] };
    assert.deepEqual(positionalActions(spec), ['S2 click button [6]', 'S3 click button "Bearbeiten" [3]', 'S3 click div']);
    assert.deepEqual(positionalActions(spec, new Set(['S1'])), []);
});

test('Recorder: a target without a stable locator is reported, not silently skipped', async () => {
    const recorder = recorderWith(() => null);
    await recorder.handler({ action: 'click', target: 'e1' });
    await recorder.handler({ action: 'click', target: "getByRole('button'" });
    assert.equal(recorder.steps.length, 0);
    assert.match(recorder.problems[0], /e1.*nicht stabil/);
    assert.match(recorder.problems[1], /nicht stabil/, 'code that does not parse is no stable target either');
});

test('Recorder: goto becomes portable, denied targets are recorded as such', async () => {
    const recorder = recorderWith(() => NEXT_BUTTON, async (command) => {
        if (command.url.includes('evil')) throw Object.assign(new Error('nein'), { code: 'host-blocked' });
        return 'ok';
    });
    await recorder.handler({ action: 'goto', url: 'https://portal.example/app?x=1#start' });
    await assert.rejects(recorder.handler({ action: 'goto', url: 'https://evil.example/' }), { code: 'host-blocked' });
    assert.deepEqual(recorder.steps, [
        { action: 'goto', url: '/app?x=1#start' },
        { action: 'goto', url: 'https://evil.example/', denied: true },
    ]);
});

// A clock that only advances while sleeping: timeouts can be tested without waiting.
const fakeClock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms) => { time += ms; } };
};

/**
 * Page with elements that only become clickable after a number of queries. Its main frame answers every locator method with the
 * same locator; elementHandles() counts the queries. The adapter finds every element reachable.
 */
const fakeSession = ({ findAfter = 0, click = async () => {}, ready } = {}) => {
    let polls = 0;
    const element = { click, fill: async () => {}, type: async () => {}, evaluate: async (_fn, argument) => argument?.mode === 'reachable', dispose: async () => {} };
    const locator = new Proxy({}, {
        get: (_target, key) => {
            if (key === 'then') return undefined;
            if (key === 'elementHandles') {
                return async () => {
                    polls += 1;
                    return polls > findAfter ? [element] : [];
                };
            }
            if (key === 'evaluate') return async () => null;
            return () => locator;
        },
    });
    const page = { mainFrame: () => locator, waitForLoadState: async () => {} };
    return { page: () => page, waitReady: ready ?? (async () => ({ settled: true })), polls: () => polls };
};

const play = (steps, session, handler, clock = fakeClock()) => playReplay({
    replay: { steps },
    handler,
    session,
    base: 'https://portal.example',
    stepTimeoutMs: 1000,
    sleep: clock.sleep,
    now: clock.now,
});

/** Plays back with retry. `passOn` names the attempt in which the check passes. */
const playRetry = async ({ retries, passOn, steps, failOnAttempt = () => null, requests, baselines, onLoad = () => null, writes }) => {
    const seen = [];
    const failures = [];
    const warnings = [];
    let written = 0;
    const clock = fakeClock();
    let attempt = 1;
    const session = {
        ...fakeSession({ ready: async () => { const failure = onLoad(attempt); if (failure !== null) failures.push(failure); return { settled: true }; } }),
        failures: () => failures,
        retractFailures: (from, to = failures.length) => { failures.splice(from, to - from); },
        ...(requests === undefined ? {} : { network: { mark: () => 0, since: () => requests } }),
        ...(writes === undefined ? {} : { writes: () => [{ label: 'POST /bestellung', count: written }] }),
        warn: (warning) => warnings.push(warning),
    };
    const handler = async (command) => {
        seen.push(command.id === undefined ? command.action : `${command.action} ${command.id}`);
        if (command.action === 'reload') {
            attempt += 1;
            return 'ok';
        }
        if (command.action !== 'check') return 'ok';
        if (writes?.(attempt, command.id)) written += 1;
        const failure = failOnAttempt(attempt, command.id);
        if (failure !== null) failures.push(failure);
        return { pass: command.id !== 'S2' || attempt >= passOn, value: attempt };
    };
    const played = await playReplay({ replay: { steps, retries, baselines }, handler, session, base: 'https://portal.example', stepTimeoutMs: 1000, sleep: clock.sleep, now: clock.now });
    return { ...played, seen, failures, warnings, waited: clock.now() };
};
const TWO_STEPS = [{ action: 'check', id: 'S1', code: 'a' }, { action: 'check', id: 'S2', code: 'b' }];

test('retry: a failed step is reloaded and repeated, the report names the failed attempt', async () => {
    const { results, broken, seen, waited } = await playRetry({ retries: { S2: { times: 2, waitMs: 5000 } }, passOn: 2, steps: TWO_STEPS });
    assert.equal(broken, null);
    assert.equal(results.get('S2').status, 'pass');
    assert.match(results.get('S2').note, /Bestanden im 2\. Versuch\. Davor: Nach 1 s nicht erfüllt/);
    assert.deepEqual(seen.filter((item) => item === 'reload'), ['reload']);
    assert.equal(seen.filter((item) => item === 'check S1').length, 1, 'S1 does not run again');
    assert.ok(waited >= 5000, 'waits before the new attempt');
});

test('retry: from also repeats the step before', async () => {
    const { results, seen } = await playRetry({ retries: { S2: { times: 1, from: 'S1' } }, passOn: 2, steps: TWO_STEPS });
    assert.equal(seen.filter((item) => item === 'check S1').length, 2);
    assert.equal(results.get('S2').status, 'pass');
});

test('retry: when attempts are used up, the step stays fail and names them', async () => {
    const { results, seen } = await playRetry({ retries: { S2: { times: 2, waitMs: 0 } }, passOn: 9, steps: TWO_STEPS });
    assert.equal(seen.filter((item) => item === 'reload').length, 2);
    assert.equal(results.get('S2').status, 'fail');
    const { note } = results.get('S2');
    assert.match(note, /^In allen 3 Versuchen gescheitert: Nach \d+ s nicht erfüllt: /);
    assert.equal(note.split('nicht erfüllt').length, 2, 'the same reason appears only once, not nested');
});

test('retry: a hard failure of the failed attempt drops out of the verdict but stays in the note', async () => {
    const hard = { type: 'pageerror', text: 'Object' };
    const { results, failures, broken } = await playRetry({
        retries: { S2: { times: 1, waitMs: 0 } },
        passOn: 1,
        steps: TWO_STEPS,
        failOnAttempt: (attempt, id) => (attempt === 1 && id === 'S2' ? hard : null),
    });
    assert.equal(broken, null);
    assert.deepEqual(failures, []);
    assert.match(results.get('S2').note, /Harter Fehler \(pageerror\): Object/);
});

test('retry: a hard failure of a step without retry stays hard', async () => {
    const hard = { type: 'pageerror', text: 'Object' };
    const { failures, broken, seen } = await playRetry({
        retries: { S2: { times: 3, waitMs: 0 } },
        passOn: 1,
        steps: TWO_STEPS,
        failOnAttempt: (_, id) => (id === 'S1' ? hard : null),
    });
    assert.equal(broken.kind, 'external');
    assert.deepEqual(failures, [hard]);
    assert.ok(!seen.includes('reload'), 'the failure belongs to S1, repeating S2 does not help');
});

test('retry: if the app aborts a request itself the same way twice, there is no further attempt', async () => {
    const fees = 'GET /o/proxy connector=Preise';
    const aborted = [{ name: fees, outcome: 'aborted', navigated: false, ms: 160 }];
    const { results, seen } = await playRetry({ retries: { S2: { times: 3, waitMs: 0 } }, passOn: 9, steps: TWO_STEPS, requests: aborted, baselines: { S2: [{ name: fees, status: 200, ms: 1293 }] } });
    assert.equal(seen.filter((action) => action === 'reload').length, 1, 'one attempt, then it is clear that reloading changes nothing');
    assert.equal(results.get('S2').status, 'fail');
    assert.match(results.get('S2').note, /Kein neuer Versuch: GET \/o\/proxy connector=Preise wurde nach 160 ms von der Anwendung abgebrochen/);
    // Aborted by navigation or a slow service: a new attempt can change that.
    const navigated = await playRetry({ retries: { S2: { times: 1, waitMs: 0 } }, passOn: 2, steps: TWO_STEPS, requests: [{ ...aborted[0], navigated: true }] });
    assert.equal(navigated.results.get('S2').status, 'pass');
    const slow = await playRetry({ retries: { S2: { times: 1, waitMs: 0 } }, passOn: 2, steps: TWO_STEPS, requests: [{ ...aborted[0], ms: 30_000 }] });
    assert.equal(slow.results.get('S2').status, 'pass');
});

test('retry: without configuration there is no new attempt', async () => {
    const { results, seen } = await playRetry({ passOn: 2, steps: TWO_STEPS });
    assert.ok(!seen.includes('reload'));
    assert.equal(results.get('S2').status, 'fail');
});

test('Severity: real stacks from runs are classified correctly', () => {
    const rules = { foreign: [/\/Root\/public\//], skip: extjs.stackSkip };
    const ext ='https://p.example/html/js/extjs6/build/ext-modern-all-debug.js:13892:42';
    const stackFrom = (url) => `TypeError: x\n    at constructor.onEnter (${url}:138:9)\n    at constructor.fire (${ext})`;
    const pageerror = { type: 'pageerror', text: 'x' };
    const foreign = 'https://p.example/o/DataProxy?url=repo:///Root/public/shared/cockpit.js';
    const own = 'https://p.example/o/DataProxy?url=repo:///Root/myapp/app.js';
    assert.equal(classifyFailure(pageerror, { stack: stackFrom(foreign) }, rules), 'warn');
    assert.equal(classifyFailure(pageerror, { stack: stackFrom(own) }, rules), 'fail');
    assert.equal(classifyFailure(pageerror, { stack: undefined }, rules), 'fail', 'without a stack the origin is unknown');
    assert.equal(classifyFailure(pageerror, { stack: `Error: x\n    at f (${ext})` }, rules), 'fail', 'only ExtJS in the stack: unknown');
    assert.equal(stackOrigin(`TypeError: x\n    at g (${ext})\n    at f (${foreign}:1:1)`, extjs.stackSkip), `${foreign}:1:1`, 'ExtJS on top does not count');
    assert.equal(stackOrigin(`TypeError: x\n    at g (${ext})\n    at f (${foreign}:1:1)`), ext, 'without an adapter every file counts');
});

test('Severity: HTTP stays hard, static files warn, connector calls do not, consoleIgnore wins', () => {
    const rules = { ignored: [/bekannt/], foreign: [/\/Root\/public\//] };
    const publicUrl = 'https://p.example/o/DataProxy?connector=x&url=/Root/public/a.js';
    assert.equal(classifyFailure({ type: 'http', text: 'HTTP 500 bekannt' }, { url: publicUrl }, rules), 'fail');
    assert.equal(classifyFailure({ type: 'requestfailed', text: 'net::ERR_FAILED' }, { url: 'https://p.example/logo.png?v=1' }, rules), 'warn');
    assert.equal(classifyFailure({ type: 'requestfailed', text: 'net::ERR_FAILED' }, { url: 'https://p.example/o/DataProxy?connector=a.png' }, rules), 'fail');
    assert.equal(classifyFailure({ type: 'requestfailed', text: 'net::ERR_FAILED' }, { url: 'kein url' }, rules), 'fail');
    assert.equal(classifyFailure({ type: 'console', text: 'x' }, { url: publicUrl }, rules), 'warn');
    assert.equal(classifyFailure({ type: 'console', text: 'x' }, { url: 'https://p.example/own.js' }, rules), 'fail');
    assert.equal(classifyFailure({ type: 'console', text: 'bekannt' }, { url: 'https://p.example/own.js' }, rules), 'ignore');
});

test('Report: warnings are listed separately, status stays, repetitions are counted', () => {
    const text = renderReport({ status: 'pass', testId: 't', target: 'p/dev', warnings: [{ type: 'pageerror', text: 'x', origin: 'https://p.example/a.js:1:1', count: 3 }] });
    assert.match(text, /: pass/);
    assert.match(text, /## Warnungen/);
    assert.match(text, /- Skriptfehler: x \(https:\/\/p\.example\/a\.js:1:1\) \(3x\)/);
    assert.doesNotMatch(text, /## Harte Fehler/);
});

test('buildReplay: a hard failure with proven steps does not discard the recording, other failures do', () => {
    const spec = { id: 't', steps: [{ id: 'S1', name: 'a', do: '', expect: 'b' }], expectations: [{ id: 'S1', text: 'b' }] };
    const recorder = { problems: [], steps: [{ action: 'check', id: 'S1', code: 'x' }] };
    const pass = [{ id: 'S1', status: 'pass' }];
    const hard = { status: 'fail', results: pass, failures: [{ type: 'pageerror', text: 'Object' }] };
    assert.notEqual(buildReplay({ recorder, outcome: hard, spec, target: 'p/dev' }).candidate, undefined);
    const failedStepOutcome = { status: 'fail', results: [{ id: 'S1', status: 'fail' }], failures: hard.failures };
    assert.equal(buildReplay({ recorder, outcome: failedStepOutcome, spec, target: 'p/dev' }).candidate, undefined);
});

test('Playback: waits for the target and repeats the check until it holds', async () => {
    const clicks = [];
    const session = fakeSession({ findAfter: 3, click: async () => { clicks.push('klick'); } });
    let tries = 0;
    const handler = async ({ action }) => {
        if (action !== 'check') return 'ok';
        tries += 1;
        if (tries === 1) throw new Error('Ext is not defined');
        return { pass: tries >= 3, value: tries >= 3 };
    };
    const { results, broken } = await play([{ action: 'click', target: NEXT_BUTTON }, { action: 'check', id: 'S1', code: 'x' }], session, handler);
    assert.equal(broken, null);
    assert.deepEqual(clicks, ['klick']);
    assert.ok(session.polls() >= 4);
    assert.equal(tries, 3);
    assert.equal(results.get('S1').status, 'pass');
});

test('Playback: an unmet check is fail with the last value, the flow ends there', async () => {
    const seen = [];
    const handler = async (command) => {
        seen.push(command.action);
        return command.action === 'check' ? { pass: false, value: 'falsch' } : 'ok';
    };
    const { results, broken } = await play([{ action: 'check', id: 'S1', code: 'x' }, { action: 'reload' }], fakeSession(), handler);
    assert.equal(broken.kind, 'check');
    assert.equal(broken.step, 'S1');
    assert.equal(results.get('S1').status, 'fail');
    assert.match(results.get('S1').evidence.value, /falsch/);
    assert.ok(!seen.includes('reload'), 'nothing continues on an already wrong state');
});

test('Playback: a check that answered no is evaluated, one that threw is not; failedStep says so (a draft red step needs it)', async () => {
    const answered = await play([{ action: 'check', id: 'S1', code: 'x' }], fakeSession(), async () => ({ pass: false, value: false }));
    assert.deepEqual([...answered.evaluated], ['S1']);
    assert.equal(failedStep({ ...answered, expectations: runbook.expectations }).evaluated, true);
    const threw = await play([{ action: 'check', id: 'S1', code: 'x' }], fakeSession(), async () => { throw new Error('Ext is not defined'); });
    assert.deepEqual([...threw.evaluated], []);
    assert.equal(failedStep({ ...threw, expectations: runbook.expectations }).evaluated, undefined);
});

test('Recorder: for a draft red step it keeps the last failing check that evaluated, never one that threw', async () => {
    let answer = { pass: false, value: false };
    const recorder = createRecorder({ handler: async () => answer, session: { page: () => pageWith() }, base: 'https://portal.example', red: () => 'S2' });
    await recorder.handler({ action: 'check', id: 'S1', code: 'a' });
    await recorder.handler({ action: 'check', id: 'S2', code: 'first' });
    await recorder.handler({ action: 'check', id: 'S2', code: 'last' });
    answer = { pass: true, value: true };
    await recorder.handler({ action: 'check', id: 'S1', code: 'a' });
    assert.deepEqual(recorder.steps.map(({ id, code }) => `${id} ${code}`), ['S2 first', 'S2 last', 'S1 a'], 'S1 failing is no recording, only S2 is red');
    const plain = createRecorder({ handler: async () => ({ pass: false, value: false }), session: { page: () => pageWith() }, base: 'https://portal.example' });
    await plain.handler({ action: 'check', id: 'S2', code: 'x' });
    assert.deepEqual(plain.steps, [], 'a test without a red step keeps only passed checks');
});

test('buildReplay: a draft failing only at its red step is a recording with that failing check', () => {
    const spec = { id: 't', draft: true, steps: [{ id: 'S1', name: 'a', do: '', expect: 'b' }, { id: 'S2', name: 'c', do: '', expect: 'd' }], expectations: [{ id: 'S1', text: 'b' }, { id: 'S2', text: 'd' }] };
    const recorder = { problems: [], steps: [{ action: 'check', id: 'S1', code: 'x' }, { action: 'reload' }, { action: 'check', id: 'S2', code: 'bugGone()' }] };
    const outcome = { status: 'fail', results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'fail' }] };
    const { candidate } = buildReplay({ recorder, outcome, spec, target: 'p/dev', red: 'S2' });
    assert.equal(candidate.steps[1].recording.check, 'bugGone()');
    assert.equal(candidate.draft, true);
    assert.equal(buildReplay({ recorder, outcome, spec, target: 'p/dev' }).candidate, undefined, 'without red a failed step is no recording');
    const earlier = { status: 'fail', results: [{ id: 'S1', status: 'fail' }, { id: 'S2', status: 'fail' }] };
    assert.equal(buildReplay({ recorder, outcome: earlier, spec, target: 'p/dev', red: 'S2' }).candidate, undefined, 'a step before the red one must pass');
});

test('Playback: target never appears, abort with step, screenshot and no further steps', async () => {
    const seen = [];
    const session = fakeSession({ findAfter: Number.POSITIVE_INFINITY });
    const { broken } = await play([{ action: 'click', target: NEXT_BUTTON }, { action: 'reload' }], session, async (command) => { seen.push(command); return 'ok'; });
    assert.equal(broken.number, '1/2');
    assert.match(broken.message, /Weiter.*nicht klickbar/);
    assert.equal(broken.screenshot, 'failure-step-1.png');
    assert.deepEqual(seen.map(({ action }) => action), ['screenshot']);
});

test('Playback: a click fails once because ExtJS replaced the element, then succeeds', async () => {
    let clicks = 0;
    const session = fakeSession({ click: async () => { clicks += 1; if (clicks === 1) throw new Error('Element is not attached'); } });
    const { broken } = await play([{ action: 'click', target: NEXT_BUTTON }], session, async () => 'ok');
    assert.equal(broken, null);
    assert.equal(clicks, 2);
});

test('Playback: a denied target must stay denied, relative URLs are resolved against the target portal', async () => {
    const urls = [];
    const allow = async (command) => { urls.push(command.url); return 'ok'; };
    const denied = { action: 'goto', url: 'https://evil.example/', denied: true };
    assert.match((await play([denied], fakeSession(), allow)).broken.message, /abgelehnt/);
    const deny = async () => { throw Object.assign(new Error('nein'), { code: 'host-blocked' }); };
    assert.equal((await play([denied], fakeSession(), deny)).broken, null);
    urls.length = 0;
    await play([{ action: 'goto', url: '/app#start' }], fakeSession(), allow);
    assert.deepEqual(urls, ['https://portal.example/app#start']);
});

test('Playback: a step can have its own timeout', async () => {
    const clock = fakeClock();
    const session = fakeSession({ findAfter: Number.POSITIVE_INFINITY });
    await play([{ action: 'click', target: NEXT_BUTTON, timeoutMs: 5000 }], session, async () => 'ok', clock);
    assert.ok(clock.now() >= 5000);
});

test('replayVerdict: anything not reached is fail and names the failed step', () => {
    const results = new Map([['S1', { id: 'S1', status: 'pass', evidence: { type: 'eval', value: 'x' } }]]);
    const broken = { number: '2/3', label: 'click Weiter', message: 'weg', screenshot: 'f.png' };
    const { expectations } = replayVerdict({ results, broken, expectations: runbook.expectations });
    assert.equal(expectations[0].status, 'pass');
    assert.equal(expectations[1].status, 'fail');
    assert.deepEqual(expectations[1].evidence, { type: 'screenshot', value: 'f.png' });
    assert.match(expectations[1].note, /2\/3.*click Weiter.*weg/);
    const later = replayVerdict({ results, broken: { ...broken, step: 'S2' }, expectations: [...runbook.expectations, { id: 'S3' }] }).expectations[2];
    assert.match(later.note, /Nicht erreicht, weil S2/);
    const none = replayVerdict({ results: new Map(), broken: null, expectations: [{ id: 'S9' }] }).expectations[0];
    assert.equal(none.status, 'fail');
    assert.match(none.note, /keine Prüfung/);
});

const healthy = { appLoaded: true, signedIn: true, loading: false, path: '/app', messages: [] };

/** Page with a fixed state; the target never appears unless `findAfter` says otherwise. */
const stateSession = (state, { findAfter = Number.POSITIVE_INFINITY, failures = [], click } = {}) => {
    const session = fakeSession({ findAfter, click });
    const page = session.page();
    page.evaluate = async () => state;
    return { ...session, page: () => page, failures: () => failures };
};

const missingTarget = async (state, step = { action: 'click', target: NEXT_BUTTON }) => (await play([step], stateSession(state), async () => 'ok')).broken;

test('Playback: a locked target is called locked, even if a progress indicator runs next to it', async () => {
    const log = ['elementHandle.click: Timeout 30000ms exceeded.', 'Call log:', '  - waiting for element to be visible, enabled and stable', '  - element is not enabled'];
    const locked = async () => { throw new Error(log.join('\n')); };
    const { broken } = await play([{ action: 'click', target: NEXT_BUTTON }], stateSession({ ...healthy, loading: true }, { findAfter: 0, click: locked }), async () => 'ok');
    assert.equal(broken.kind, 'state');
    assert.match(broken.message, /blieb aber gesperrt/);
    assert.doesNotMatch(broken.message, /Lademaske/);
});

test('Playback: a missing target on a healthy page can be fixed', async () => {
    assert.equal((await missingTarget(healthy)).kind, 'target');
    assert.equal((await missingTarget(healthy, { action: 'click', target: NEXT_BUTTON, path: '/app' })).kind, 'target');
});

test('Playback: a wrong page state is not a stale step', async () => {
    const cases = [
        [{ ...healthy, appLoaded: false }, /nicht geladen/],
        [{ ...healthy, signedIn: false }, /Anmeldung/],
        [{ ...healthy, loading: true }, /Lademaske/],
        [null, /nicht auswerten/],
    ];
    for (const [state, reason] of cases) {
        const broken = await missingTarget(state);
        assert.equal(broken.kind, 'state');
        assert.match(broken.message, reason);
    }
    const moved = await missingTarget({ ...healthy, path: '/home' }, { action: 'click', target: NEXT_BUTTON, path: '/app' });
    assert.equal(moved.kind, 'state');
    assert.match(moved.message, /\/home statt \/app/);
});

test('Playback: an unexpected message stops immediately, a recorded one does not', async () => {
    const steps = [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'x' }];
    const handler = async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok');
    const state = { ...healthy, messages: ['Fehler Serverfehler # OK'] };

    const known = await playReplay({ replay: { steps, knownMessages: state.messages }, handler, session: stateSession(state), base: 'https://p.example', stepTimeoutMs: 1000 });
    assert.equal(known.broken, null);

    const unknown = await playReplay({ replay: { steps, knownMessages: [] }, handler, session: stateSession(state), base: 'https://p.example', stepTimeoutMs: 1000 });
    assert.equal(unknown.broken.kind, 'external');
    assert.equal(unknown.broken.number, '1/2');
    assert.match(unknown.broken.message, /Serverfehler/);
    assert.equal(unknown.results.size, 0);
});

test('Playback: an unknown status note warns once but fails nothing', async () => {
    const steps = [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'x' }];
    const handler = async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok');
    const warned = [];
    const session = { ...stateSession({ ...healthy, messages: [], notes: ['Treffer sind vorläufig'] }), warn: (entry) => warned.push(entry) };
    const played = await playReplay({ replay: { steps, knownMessages: [] }, handler, session, base: 'https://p.example', stepTimeoutMs: 1000 });
    assert.equal(played.broken, null);
    assert.equal(played.results.get('S1').status, 'pass');
    assert.equal(warned.length, 1);
    assert.match(warned[0].text, /Statushinweis.*Treffer sind vorläufig/);
    assert.equal(warned[0].step, 'S1', 'the step it showed in, for the CI reports');
});

test('Playback: a hard failure stops before the next step, even if it only occurs at the end', async () => {
    const failures = [];
    const seen = [];
    const session = stateSession(healthy, { failures });
    const handler = async (command) => {
        seen.push(command.action);
        if (command.action === 'reload') failures.push({ type: 'http', text: 'HTTP 500' });
        return 'ok';
    };
    const middle = await play([{ action: 'reload' }, { action: 'press', key: 'Tab' }], session, handler);
    assert.equal(middle.broken.kind, 'external');
    assert.match(middle.broken.message, /HTTP 500/);
    assert.ok(!seen.includes('press'));

    failures.length = 0;
    const last = await play([{ action: 'reload' }], session, handler);
    assert.equal(last.broken.kind, 'external');
    assert.equal(last.broken.label, 'Ende');
});

test('failedStep: the first failed step; hard failures are suspicious', () => {
    const expectations = runbook.expectations;
    const broken = { number: '2/3', step: 'S2', label: 'click Weiter', kind: 'target', message: 'weg' };
    const pass = new Map([['S1', { status: 'pass' }]]);
    assert.deepEqual(failedStep({ results: pass, broken, expectations }), { id: 'S2', reason: 'click Weiter: weg', suspect: false, clean: false });
    assert.equal(failedStep({ results: new Map(), broken: null, expectations }), null);
    assert.equal(failedStep({ results: pass, broken: { ...broken, kind: 'external' }, expectations }).suspect, true);
    assert.equal(failedStep({ results: pass, broken, expectations, failures: [{ type: 'http' }] }).suspect, true);
    const early = new Map([['S1', { status: 'fail', note: 'nicht erfüllt' }]]);
    assert.deepEqual(failedStep({ results: early, broken, expectations }), { id: 'S1', reason: 'nicht erfüllt', suspect: false, clean: false }, 'the earlier step is the cause');
});

test('Playback: the abort names the step the action belongs to', async () => {
    const session = fakeSession({ findAfter: Number.POSITIVE_INFINITY });
    const { broken } = await play([{ action: 'check', id: 'S1', code: 'x' }, { action: 'click', target: NEXT_BUTTON }, { action: 'check', id: 'S2', code: 'y' }], session, async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok'));
    assert.equal(broken.step, 'S2');
});

test('replayVerdict: an abort after proven points does not end as pass', () => {
    const results = new Map([['S1', { id: 'S1', status: 'pass', evidence: { type: 'eval', value: 'x' } }], ['S2', { id: 'S2', status: 'pass', evidence: { type: 'eval', value: 'y' } }]]);
    const { expectations } = replayVerdict({ results, broken: { number: '9/9', label: 'Ende', message: 'Unerwartete Meldung: x' }, expectations: runbook.expectations });
    assert.equal(expectations[0].status, 'pass');
    assert.equal(expectations[1].status, 'fail');
    assert.match(expectations[1].note, /Unerwartete Meldung/);
    assert.equal(expectations[1].evidence.value, 'y');
});

test('Recorder: visible messages and the page path are recorded', async () => {
    const page = { ...pageWith(), url: () => 'https://portal.example/app?x=1#start', evaluate: async () => ({ ...healthy, messages: ['Wirklich abbrechen? Ja Nein'] }) };
    const recorder = createRecorder({ handler: async () => 'ok', session: { page: () => page }, base: 'https://portal.example', recordTarget: recordWith(() => NEXT_BUTTON) });
    await recorder.handler({ action: 'click', target: 'e1' });
    assert.deepEqual([...recorder.messages], ['Wirklich abbrechen? Ja Nein']);
    assert.equal(recorder.steps[0].path, '/app');
});

test('Names in messages: the visible format stays click <kind> "<name>"', () => {
    assert.equal(stepLabel({ action: 'click', target: NEXT_BUTTON }), 'click app_actionButton "Weiter"');
    assert.equal(stepLabel({ action: 'click', target: "getByRole('dialog', { name: 'Neue Akte' }).getByRole('button', { name: 'Speichern', exact: true })", optional: true }), 'click button "Speichern" in dialog "Neue Akte" (optional)');
    assert.equal(stepLabel({ action: 'download', target: "getByText('Export')", file: '\\.csv$' }), 'download text "Export" /\\.csv$/');
    assert.equal(stepLabel({ action: 'check', id: 'S1', code: 'x' }), 'check S1');
    assert.equal(stepLabel({ action: 'reload' }), 'reload');
});

test('Playback: an abort is clean only if nothing of the step has run yet', async () => {
    const answer = async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok');
    const first = await play([{ action: 'check', id: 'S1', code: 'x' }, { action: 'click', target: NEXT_BUTTON }, { action: 'check', id: 'S2', code: 'y' }], fakeSession({ findAfter: Number.POSITIVE_INFINITY }), answer);
    assert.equal(first.broken.clean, true, 'first action of the step');
    const middle = await play([{ action: 'check', id: 'S1', code: 'x' }, { action: 'reload' }, { action: 'click', target: NEXT_BUTTON }, { action: 'check', id: 'S2', code: 'y' }], fakeSession({ findAfter: Number.POSITIVE_INFINITY }), answer);
    assert.equal(middle.broken.clean, false, 'an action of the step already ran before');
    const remembering = await play([{ action: 'check', id: 'S1', code: 'x' }, { action: 'remember', name: 'nr', code: 'z', timeoutMs: 0 }, { action: 'check', id: 'S2', code: 'y' }], fakeSession(), async ({ action }) => {
        if (action === 'remember') throw new Error('nicht da');
        return { pass: true, value: true };
    });
    assert.equal(remembering.broken.step, 'S2');
    assert.equal(remembering.broken.clean, true, 'remembering as the first action does not change the page');
});

test('failedStep: clean only without hard failures and never after a failed check', () => {
    const expectations = runbook.expectations;
    const broken = { number: '2/3', step: 'S2', label: 'click Weiter', kind: 'target', message: 'weg', clean: true };
    const pass = new Map([['S1', { status: 'pass' }]]);
    assert.equal(failedStep({ results: pass, broken, expectations }).clean, true);
    assert.equal(failedStep({ results: pass, broken, expectations, failures: [{ type: 'http' }] }).clean, false);
    assert.equal(failedStep({ results: new Map([['S1', { status: 'fail', note: 'nein' }]]), broken, expectations }).clean, false);
});

test('Plan change: checks from the first changed step on and of removed steps no longer apply', async () => {
    const { invalidatedChecks } = await import('../src/host/run.mjs');
    const recorder = recorderWith(() => NEXT_BUTTON, async () => ({ pass: true }));
    for (const id of ['S1', 'S2', 'S3']) {
        await recorder.handler({ action: 'click', target: 'e1' });
        await recorder.handler({ action: 'check', id, code: id });
    }
    const plan = (steps) => ({ steps: steps.map(([id, expect]) => ({ id, name: id, do: 'x', expect })) });
    const before = plan([['S1', 'a'], ['S2', 'b'], ['S3', 'c']]);
    assert.deepEqual(invalidatedChecks(before, plan([['S1', 'a'], ['S2', 'b'], ['S3', 'c'], ['S4', 'd']]), recorder), [], 'only appended');
    assert.deepEqual(invalidatedChecks(before, plan([['S1', 'a'], ['S2', 'B'], ['S3', 'c']]), recorder), ['S2', 'S3']);
    assert.deepEqual(invalidatedChecks(before, plan([['S1', 'a'], ['S3', 'c']]), recorder), ['S2'], 'S3 stays valid, the actions of S2 now belong to it');
    // Only reworded (name, action, note): the recorded actions are what happened, the check proved the same expected result.
    const reworded = { steps: before.steps.map((step) => (step.id === 'S2' ? { ...step, name: 'Anders', do: 'Button statt Doppelklick', note: 'n' } : step)) };
    assert.deepEqual(invalidatedChecks(before, reworded, recorder), [], 'rewording keeps the checks');
    assert.deepEqual(invalidatedChecks(before, plan([['S1', 'a'], ['S3', 'c'], ['S2', 'b']]), recorder), ['S3', 'S2'], 'another order');
    assert.deepEqual(invalidatedChecks(before, plan([['S1', 'a'], ['S1b', 'x'], ['S2', 'b'], ['S3', 'c']]), recorder), ['S2', 'S3'], 'a step inserted');
    const shown = () => recorder.steps.map(({ action, id }) => (id === undefined ? action : `${action} ${id}`));
    const taken = recorder.forgetChecks(new Set(['S2', 'S3']));
    assert.deepEqual(shown(), ['click', 'check S1', 'click', 'click']);
    assert.deepEqual(taken.map(({ step }) => step.id), ['S2', 'S3'], 'in their order');
    // Back to the plan they were checked under: they return behind the actions they followed.
    assert.deepEqual(recorder.restoreChecks(taken), ['S2', 'S3']);
    assert.deepEqual(shown(), ['click', 'check S1', 'click', 'check S2', 'click', 'check S3']);
});

test('Plan change: checkBasis is what a check proved, the expected results up to its step', async () => {
    const { checkBasis } = await import('../src/host/run.mjs');
    const plan = (steps) => ({ steps: steps.map(([id, expect, name = id]) => ({ id, name, do: 'x', expect })) });
    const basis = checkBasis(plan([['S1', 'a'], ['S2', 'b'], ['S3', 'c']]), 'S2');
    assert.equal(checkBasis(plan([['S1', 'a', 'neu'], ['S2', 'b'], ['S3', 'C']]), 'S2'), basis, 'names and later steps do not count');
    assert.notEqual(checkBasis(plan([['S1', 'A'], ['S2', 'b']]), 'S2'), basis, 'an earlier expected result counts');
    assert.equal(checkBasis(plan([['S1', 'a']]), 'S2'), null);
});

test('Playback: a lost sign-in also appears in the reason of an unmet check and of a hard failure', async () => {
    const steps = [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'x' }];
    const handler = async ({ action }) => (action === 'check' ? { pass: false, value: false } : 'ok');
    const out = { ...healthy, signedIn: false };
    const lost = await playReplay({ replay: { steps }, handler, session: stateSession(out), base: 'https://p.example', authMarker: '#m', stepTimeoutMs: 10 });
    assert.match(lost.results.get('S1').note, /nicht erfüllt.*Anmeldung ist verloren/);
    const fine = await playReplay({ replay: { steps }, handler, session: stateSession(healthy), base: 'https://p.example', authMarker: '#m', stepTimeoutMs: 10 });
    assert.doesNotMatch(fine.results.get('S1').note, /Anmeldung/);
    const unmarked = await playReplay({ replay: { steps }, handler, session: stateSession(out), base: 'https://p.example', stepTimeoutMs: 10 });
    assert.doesNotMatch(unmarked.results.get('S1').note, /Anmeldung/, 'without authMarker there is nothing to check');

    const failures = [{ type: 'http', text: 'HTTP 500' }];
    const hard = await playReplay({ replay: { steps: [{ action: 'reload' }] }, handler, session: stateSession(out, { failures }), base: 'https://p.example', authMarker: '#m', stepTimeoutMs: 10 });
    assert.equal(hard.broken.kind, 'external');
    assert.match(hard.broken.message, /HTTP 500 Die Anmeldung ist verloren/);
});

test('Playback: missing controls are re-measured, a slowly completed form does not fail the step', async () => {
    const run = async (readyAfter) => {
        let reads = 0;
        const session = fakeSession();
        const page = session.page();
        page.evaluate = async (fn) => {
            if (fn !== controlsProbe) return healthy;
            reads += 1;
            // First measurement before the action, then the form only completes after `readyAfter` measurements.
            return reads > readyAfter ? ['button "Weiter"', 'input "Kategorie" disabled'] : ['button "Weiter"'];
        };
        const clock = fakeClock();
        const effects = { S1: { runs: LEARN_RUNS, actions: [{ action: 1, controls: ['+ input "Kategorie" disabled'] }] } };
        const out = await playReplay({
            replay: { steps: [{ action: 'click', target: NEXT_BUTTON }, { action: 'check', id: 'S1', code: 'x' }], effects },
            handler: async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok'),
            session: { ...session, page: () => page, trail: { mark: () => 0, since: () => [] } },
            base: 'https://portal.example',
            stepTimeoutMs: 30_000,
            sleep: clock.sleep,
            now: clock.now,
        });
        return { status: out.results.get('S1').status, waited: clock.now() };
    };
    assert.deepEqual(await run(1), { status: 'pass', waited: 0 }, 'ready right away: no re-measuring');
    const slow = await run(4);
    assert.equal(slow.status, 'pass', 'ready later: re-measured, passed');
    assert.ok(slow.waited > 0 && slow.waited <= 10_000);
    assert.equal((await run(Number.POSITIVE_INFINITY)).status, 'fail', 'never ready: fails after re-measuring');
});

test('retry: an error of the reloaded page stays in the verdict, only the failed attempt drops out', async () => {
    let loaded = false;
    const { failures, broken } = await playRetry({
        retries: { S2: { times: 1, waitMs: 0 } },
        passOn: 2,
        steps: TWO_STEPS,
        failOnAttempt: (attempt, id) => (attempt === 1 && id === 'S2' ? { type: 'pageerror', text: 'alt' } : null),
        // Once after the reload, while waiting for the new page.
        onLoad: (attempt) => {
            if (attempt !== 2 || loaded) return null;
            loaded = true;
            return { type: 'pageerror', text: 'neu beim Start' };
        },
    });
    assert.deepEqual(failures.map(({ text }) => text), ['neu beim Start']);
    assert.equal(broken?.kind, 'external', 'it used to vanish with the failed attempt and the run passed');
    assert.match(broken.message, /neu beim Start/);
});

test('retry: after a write request since the attempt started there is no new one', async () => {
    const { results, seen } = await playRetry({ retries: { S2: { times: 2, waitMs: 0 } }, passOn: 2, steps: TWO_STEPS, writes: (attempt, id) => id === 'S2' });
    assert.ok(!seen.includes('reload'), 'a new attempt would create things twice');
    assert.equal(results.get('S2').status, 'fail');
    assert.match(results.get('S2').note, /Kein neuer Versuch: Seit S2 hat der Lauf schon .*schreibende.* geschickt/);
    // The write happened before the attempt, in S1: the attempt does not repeat it.
    const before = await playRetry({ retries: { S2: { times: 1, waitMs: 0 } }, passOn: 2, steps: TWO_STEPS, writes: (attempt, id) => id === 'S1' });
    assert.equal(before.results.get('S2').status, 'pass');
});

test('retry: a script error hidden by the new attempt remains as a warning', async () => {
    const { results, warnings } = await playRetry({ retries: { S2: { times: 1, waitMs: 0 } }, passOn: 2, steps: TWO_STEPS,
        failOnAttempt: (attempt, id) => (attempt === 1 && id === 'S2' ? { type: 'pageerror', text: 'TypeError: x is undefined' } : null) });
    assert.equal(results.get('S2').status, 'pass');
    assert.match(warnings.map(({ text }) => text).join(), /S2: Im Versuch 1 gab es einen Skriptfehler, den der neue Versuch verdeckt: TypeError/);
});

test('Step list: every recorded action becomes a point of its step, without entered values', async () => {
    const steps = [{ id: 'S1', name: 'Anmelden', expect: 'Startseite offen' }, { id: 'S2', name: 'Akte', expect: 'Akte steht da' }, { id: 'S3', name: 'Noch offen', expect: 'x' }];
    const replay = { steps: [
        { action: 'fill', target: "getByLabel('Passwort')", value: 'geheim' },
        { action: 'click', target: "getByRole('button', { name: 'Anmelden', exact: true })" },
        { action: 'wait-ready' },
        { action: 'check', id: 'S1' },
        { action: 'press', key: 'Enter' },
        { action: 'check', id: 'S2' },
        { action: 'screenshot', name: 'ende' },
    ] };
    const groups = stepGroups(steps, replay);
    assert.deepEqual(groups.map(({ id, points }) => [id, points.map(({ id: point }) => point)]), [['S1', ['a1', 'a2', 'a3', 'a4']], ['S2', ['a5', 'a6', 'a7']], ['S3', []]]);
    assert.deepEqual(groups[0].points.map(({ kind, label }) => `${kind} ${label}`), ['Eingabe "Passwort"', 'Klick "Anmelden"', 'Warten Seite ruhig', 'Prüfung Startseite offen']);
    assert.equal(stepGroups(steps, { steps: [{ action: 'click', target: "getByRole('button').nth(1)" }, { action: 'check', id: 'S1' }] })[0].points[0].label, 'button [2]', 'without a name its kind');
    assert.ok(!JSON.stringify(groups).includes('geheim'), 'no entered value');
    assert.deepEqual(stepGroups(steps, undefined).map(({ points }) => points.length), [0, 0, 0]);
});

test('Severity: an error caught by the framework with a stack in the console counts by its origin', () => {
    const rules = { foreign: [/\/vendor\//], skip: /\/@angular\/|chunk-angular/ };
    const console = { type: 'console', level: 'error', text: 'ERROR Error: x' };
    const caller = 'https://a.example/chunk-angular.js';
    const stackFrom = (url) => `ERROR Error: x\n    at f (${url}:1:5)\n    at g (${caller}:9:9)`;
    assert.equal(classifyFailure(console, { url: caller, stack: stackFrom('https://a.example/vendor/widget.js') }, rules), 'warn', 'origin in third-party code');
    assert.equal(classifyFailure(console, { url: caller, stack: stackFrom('https://a.example/main.js') }, rules), 'fail');
    assert.equal(classifyFailure(console, { url: 'https://a.example/vendor/widget.js' }, rules), 'warn', 'without a stack the file counts as before');
});

test('Recording: click --optional is recorded as optional; if the target was missing, nothing is recorded', async () => {
    const page = { ...pageWith(), url: () => 'https://p.example/a', evaluate: async () => ({ messages: [] }) };
    let absent = false;
    const recorder = createRecorder({ handler: async () => (absent ? 'absent' : 'ok'), session: { page: () => page }, base: 'https://p.example', recordTarget: recordWith(() => "getByRole('button', { name: 'Alle akzeptieren', exact: true })") });
    await recorder.handler({ action: 'click', target: 'e1', optional: true });
    absent = true;
    await recorder.handler({ action: 'click', target: 'e1', optional: true });
    absent = false;
    await recorder.handler({ action: 'click', target: 'e2' });
    assert.equal(recorder.steps.length, 2);
    assert.equal(recorder.steps[0].optional, true);
    assert.equal(recorder.steps[1].optional, undefined);
});

test('Recording: the run tag in a regular expression of the target becomes its placeholder, escaped as written there', async () => {
    const cellOf = (text) => `locator('extjs=grid gridrow').locator('extjs=gridcell').filter({ hasText: /^Anliegen ${text}$/ })`;
    const recorder = createRecorder({ handler: async () => 'ok', session: { page: () => pageWith() }, base: 'https://portal.example', runTag: 'CAW-20261113.1', recordTarget: recordWith(() => cellOf('CAW-20261113\\.1')) });
    await recorder.handler({ action: 'click', target: 'e1' });
    assert.equal(recorder.steps[0].target, cellOf('{{runTag}}'));
});

test('Recording: upload and dblclick are recorded with their target; upload with the files the host checked', async () => {
    const recorder = recorderWith(() => NEXT_BUTTON, async (command) => (command.action === 'upload' ? { files: ['fixtures/brief.pdf'] } : 'ok'));
    await recorder.handler({ action: 'upload', target: 'e1', files: ['fixtures/./brief.pdf'] });
    await recorder.handler({ action: 'dblclick', target: 'e2' });
    assert.deepEqual(recorder.steps.map(({ action, target, files }) => [action, target, files]), [['upload', NEXT_BUTTON, ['fixtures/brief.pdf']], ['dblclick', NEXT_BUTTON, undefined]]);
});

test('Check: if evaluation keeps failing until the timeout, the message names the error instead of just "not met"', async () => {
    const session = {
        page: () => ({ evaluate: async () => ({ messages: [], extLoaded: true, signedIn: true }), evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }), waitForLoadState: async () => {} }),
        waitReady: async () => {},
        failures: () => [],
    };
    const playCheck = (handler) => playReplay({ replay: { steps: [{ action: 'check', id: 'S1', code: 'true' }] }, handler, session, base: 'https://p.example', stepTimeoutMs: 100 });
    const broken = await playCheck(async () => { throw new Error('Unbekannter Schritt: S1'); });
    assert.match(broken.results.get('S1').note, /Nach 0 s nicht erfüllt: true \(Auswerten scheiterte zuletzt: Unbekannter Schritt: S1\)/);
    const notYet = await playCheck(async () => ({ pass: false, value: false }));
    assert.doesNotMatch(notYet.results.get('S1').note, /scheiterte/);
});

test('Claude at the browser: while developing it may operate on request, while advising and in the conversation after a failure it may only read', async () => {
    const { consultAllowed } = await import('../src/host/run.mjs');
    for (const action of ['click', 'dblclick', 'fill', 'type', 'press', 'goto', 'reload']) {
        assert.equal(consultAllowed('develop').has(action), true, action);
        assert.equal(consultAllowed('talk').has(action), false, action);
        assert.equal(consultAllowed('advise').has(action), false, action);
    }
    for (const action of ['check', 'remember', 'finish', 'upload', 'download']) assert.equal(consultAllowed('develop').has(action), false, action);
    assert.equal(consultAllowed('develop').has('advise'), true);
});

test('workbench chip: recording shows REC, replaying PLAY, open without steps PAUSE right away', async () => {
    const { transportOf } = await import('../src/host/run.mjs');
    assert.equal(transportOf(undefined), 'record', 'record, fix and rerecord replay nothing');
    assert.equal(transportOf({ steps: [{ id: 'S1' }] }), 'play', 'run and check run');
    assert.equal(transportOf({ steps: [{ id: 'S1' }], until: 'S1', entry: { id: 'S2' } }), 'play', 'open with a step replays first');
    assert.equal(transportOf({ steps: [], entry: { id: 'S1' } }), null, 'at the entry of S1 without navigation nothing runs');
    assert.equal(transportOf({ steps: [] }), null, 'open runs nothing and hands over at once: no chip');
});

/** A recorded step for replayToEntry: actions as given, recorded after the step before it. */
const entryStep = (id, actions, { after, effects, name = `Name ${id}` } = {}) => {
    const plan = { id, name, do: `Do ${id}`, expect: `${id} da` };
    return { ...plan, recording: { hash: stepHash(plan), ...(after === undefined ? {} : { after }), recordedOn: 'a/dev', recordedAt: `t-${id}`, actions, check: `check${id}()`, ...(effects === undefined ? {} : { effects }) } };
};
const CLICK = { action: 'click', target: NEXT_BUTTON };
const FILL = { action: 'fill', target: "getByLabel('Name')", value: 'x' };
const entryTest = (...third) => ({ id: 't', steps: [entryStep('S1', [CLICK]), entryStep('S2', [FILL], { after: 'S1' }), entryStep('S3', third, { after: 'S2' })] });
const shape = (replay) => replay.steps.map(({ action, id, entry }) => `${action}${id === undefined ? '' : ` ${id}`}${entry === undefined ? '' : ` @${entry}`}`);

test('replayToEntry: the steps before completely, then the leading navigation of the step up to its first input', () => {
    const replay = replayToEntry(entryTest(CLICK, { ...CLICK, optional: true }, FILL, { action: 'click', target: "getByText('Senden')" }), 'S3');
    assert.equal(replay.until, 'S2');
    assert.deepEqual(replay.entry, { id: 'S3', name: 'Name S3' });
    assert.deepEqual(shape(replay), ['click', 'check S1', 'fill', 'check S2', 'click @S3', 'click @S3']);
    assert.equal(replay.steps.at(-1).optional, true, 'an optional click is navigation too');
    assert.deepEqual(shape(replayToEntry(entryTest({ action: 'goto', url: '/antrag' }, { action: 'wait-ready' }, FILL), 'S3')).slice(4), ['goto @S3', 'wait-ready @S3']);
    // Anything else ends the entry: a key, a download, a remembered value.
    assert.deepEqual(shape(replayToEntry(entryTest({ action: 'press', key: 'Enter' }, CLICK, FILL), 'S3')).slice(4), []);
    assert.deepEqual(shape(replayToEntry(entryTest(CLICK, { action: 'remember', name: 'nr', code: 'x' }, CLICK, FILL), 'S3')).slice(4), ['click @S3']);
    // The entry of the first step: nothing before it.
    const first = replayToEntry({ id: 't', steps: [entryStep('S1', [CLICK, FILL])] }, 'S1');
    assert.equal(first.until, undefined);
    assert.deepEqual(shape(first), ['click @S1']);
    assert.equal(first.recordedOn, 'a/dev');
    assert.throws(() => replayToEntry(entryTest(FILL), 'S9'), { code: 'step-unknown' });
});

test('replayToEntry: guards keep a step without inputs, a writing click and a stale step back', () => {
    // Only a submit click: no input at all, so none of it runs.
    const submit = replayToEntry(entryTest(CLICK), 'S3');
    assert.deepEqual([shape(submit).slice(4), submit.entry.skipped], [[], 'inputs']);
    // The second click wrote in healthy runs: stop before it.
    const effects = { runs: 2, actions: [{ action: 1, requests: ['GET /api/antrag 200'] }, { action: 2, requests: ['POST /api/antrag 201', 'GET /api/liste 200'] }] };
    const test3 = { id: 't', steps: [entryStep('S1', [CLICK]), entryStep('S2', [FILL], { after: 'S1' }), entryStep('S3', [CLICK, CLICK, FILL], { after: 'S2', effects })] };
    const writing = replayToEntry(test3, 'S3');
    assert.deepEqual([shape(writing).slice(4), writing.entry.skipped], [['click @S3'], 'write']);
    // The same classifier as everywhere: a reads pattern lets the entry pass, a GraphQL query reads, a mutation stops.
    assert.deepEqual(shape(replayToEntry(test3, 'S3', { reads: ['POST /api/antrag'] })).slice(4), ['click @S3', 'click @S3']);
    const graphql = (line) => ({ ...test3, steps: [...test3.steps.slice(0, 2), entryStep('S3', [CLICK, CLICK, FILL], { after: 'S2', effects: { runs: 2, actions: [{ action: 2, requests: [line] }] } })] });
    assert.deepEqual(shape(replayToEntry(graphql('POST /graphql query Tickets 200'), 'S3')).slice(4), ['click @S3', 'click @S3']);
    assert.equal(replayToEntry(graphql('POST /graphql mutation CloseTicket 200'), 'S3').entry.skipped, 'write');
    // Effects learned in another state no longer apply.
    const outdated = { ...test3, steps: [...test3.steps.slice(0, 2), entryStep('S3', [CLICK, CLICK, FILL], { after: 'S2', effects: { ...effects, basis: 'older' } })] };
    assert.deepEqual(shape(replayToEntry(outdated, 'S3')).slice(4), ['click @S3', 'click @S3']);
    // Changed by hand since recording, or never recorded: nothing of it runs.
    const stale = entryTest(CLICK, FILL);
    stale.steps[2] = { ...stale.steps[2], do: 'anders' };
    assert.deepEqual([shape(replayToEntry(stale, 'S3')).slice(4), replayToEntry(stale, 'S3').entry.skipped], [[], 'recording']);
    const bare = { ...stale.steps[2], recording: undefined };
    assert.equal(replayToEntry({ ...stale, steps: [...stale.steps.slice(0, 2), bare] }, 'S3').entry.skipped, 'recording');
});

test('Playback at the entry of a step: its actions belong to it, are neither compared nor learned, and it is not judged', async () => {
    const effects = { S1: { runs: LEARN_RUNS, actions: [{ action: 1, controls: ['+ input "Kategorie" disabled'] }] }, S2: { runs: LEARN_RUNS, actions: [{ action: 1, controls: ['+ button "Absenden"'] }] } };
    const steps = [CLICK, { action: 'check', id: 'S1', code: 'x' }, { ...CLICK, entry: 'S2' }];
    const session = fakeSession();
    const page = session.page();
    let reads = 0;
    page.evaluate = async (fn) => {
        if (fn !== controlsProbe) return healthy;
        reads += 1;
        return reads > 1 ? ['button "Weiter"', 'input "Kategorie" disabled'] : ['button "Weiter"'];
    };
    const clock = fakeClock();
    const out = await playReplay({
        replay: { steps, effects },
        handler: async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok'),
        session: { ...session, page: () => page, trail: { mark: () => 0, since: () => [] } },
        base: 'https://portal.example',
        stepTimeoutMs: 1000,
        sleep: clock.sleep,
        now: clock.now,
    });
    assert.equal(out.broken, null);
    assert.deepEqual([...out.results.keys()], ['S1'], 'S2 is not judged');
    assert.deepEqual([...out.effects.keys()], ['S1'], 'the entry click is not measured, so nothing to learn');
    assert.equal(out.deviations.size, 0);
    // An entry action that fails names its step, and nothing of it ran before: the page is right before it.
    const failing = await play([{ action: 'check', id: 'S1', code: 'x' }, { ...CLICK, entry: 'S2' }], fakeSession({ findAfter: Number.POSITIVE_INFINITY }), async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok'));
    assert.deepEqual([failing.broken.step, failing.broken.clean], ['S2', true]);
    // The step list shows the entry under its step.
    const groups = stepGroups([{ id: 'S1', name: 'A' }, { id: 'S2', name: 'B' }], { steps });
    assert.deepEqual(groups.map(({ id, points }) => [id, points.map(({ id: point }) => point)]), [['S1', ['a1', 'a2']], ['S2', ['a3']]]);
});

test('an unmet check names the expectation, the code stays in the evidence', async () => {
    const steps = [{ action: 'check', id: 'S1', code: 'a' }, { action: 'check', id: 'S2', code: '(()=>false)()', expect: 'The list shows the #home todos.' }];
    const { results } = await playRetry({ retries: {}, passOn: 9, steps });
    assert.match(results.get('S2').note, /nicht erfüllt: The list shows the #home todos\.$/);
    assert.match(results.get('S2').evidence.value, /^\(\(\)=>false\)\(\) => /);
});

test('the replay carries the expectation to the check', () => {
    const spec = { id: 't', steps: [{ id: 'S1', name: 'n', do: 'd', expect: 'Shown.', recording: { actions: [], check: 'true' } }] };
    assert.equal(replayOf(spec).steps.at(-1).expect, 'Shown.');
});

test('the replay carries the designs of recorded steps and the needs of the first pending step', () => {
    const recorded = (id, extra = {}) => ({ id, name: id, do: '', expect: 'x', ...extra, recording: { actions: [], check: 'true', viewport: { width: 390, height: 844 } } });
    const spec = { id: 't', steps: [recorded('S1', { design: 'design/a.html' }), recorded('S2'), { id: 'S3', name: 'S3', do: '', expect: 'y', needs: ['getByRole("button", { name: "Save" })'] }, { id: 'S4', name: 'S4', do: '', expect: 'z', needs: ['getByText("x")'] }] };
    const replay = replayOf(spec);
    assert.deepEqual(replay.designs, { S1: { file: 'design/a.html', viewport: { width: 390, height: 844 } } });
    assert.deepEqual(replay.needs, { step: 'S3', locators: ['getByRole("button", { name: "Save" })'] }, 'only the first pending step');
});

/** Plays two checks that pass; S1 has a design that the judge decides. */
const playDesign = async ({ verdict, designFail, retries, failS2 = false }) => {
    const warnings = [];
    const seen = [];
    const session = { ...fakeSession(), warn: (warning) => warnings.push(warning) };
    const handler = async (command) => {
        seen.push(command.action);
        return command.action === 'check' ? { pass: !(failS2 && command.id === 'S2'), value: true } : 'ok';
    };
    const judged = [];
    const texts = [];
    const judgeDesign = async (design) => {
        judged.push(design.file);
        texts.push(design.texts);
        return verdict === 'not-met'
            ? { file: design.file, verdict, missing: ['button "Speichern"'], extra: [], styleDiffs: ['button "Abbrechen": color #ffffff → #000000'], layoutDiffs: ['Abstand heading "Notiz" → textarea "Notiz": 8px → 32px'], textDiffs: ['Text: heading "Notiz" → "Notizen"'] }
            : { file: design.file, verdict, missing: [], extra: [], styleDiffs: [], layoutDiffs: [], textDiffs: [] };
    };
    const clock = fakeClock();
    const played = await playReplay({
        replay: { steps: TWO_STEPS, designs: { S1: { file: 'design/s1.html' } }, ...(retries === undefined ? {} : { retries }) },
        handler, session, base: 'https://portal.example', stepTimeoutMs: 1000, sleep: clock.sleep, now: clock.now, judgeDesign, runTag: 'CAW-2026112212000000',
        ...(designFail === undefined ? {} : { designFail }),
    });
    return { ...played, warnings, seen, judged, texts };
};

test('design: a design not met fails its step with kind design, the replay goes on without a retry', async () => {
    const played = await playDesign({ verdict: 'not-met', retries: { S1: { times: 2, waitMs: 0 } } });
    assert.equal(played.broken, null, 'no stop');
    assert.equal(played.results.get('S1').status, 'fail');
    assert.equal(played.results.get('S1').kind, 'design');
    assert.equal(played.results.get('S1').evidence.type, 'eval');
    assert.match(played.results.get('S1').note, /S1 entspricht nicht seinem Zielbild.*Fehlt: button "Speichern"/);
    assert.equal(played.results.get('S2').status, 'pass', 'S2 still ran');
    assert.ok(!played.seen.includes('reload'), 'no new attempt');
    assert.deepEqual(played.judged, ['design/s1.html']);
    assert.deepEqual(played.texts, [['CAW-2026112212000000', 'caw-2026112212000000']], 'the run tag is data on both sides');
    assert.match(played.results.get('S1').note, /Texte weichen ab: Text: heading "Notiz" → "Notizen"\..*Layout weicht ab: Abstand heading "Notiz" → textarea "Notiz": 8px → 32px\./);
    const [record] = stepRecords({ ids: ['S1'], ...played });
    assert.equal(record.kind, 'design');
    assert.deepEqual(record.design, { file: 'design/s1.html', verdict: 'not-met', missing: ['button "Speichern"'], extra: [], styleDiffs: ['button "Abbrechen": color #ffffff → #000000'], layoutDiffs: ['Abstand heading "Notiz" → textarea "Notiz": 8px → 32px'], textDiffs: ['Text: heading "Notiz" → "Notizen"'] });
    const failed = failedStep({ ...played, expectations: [{ id: 'S1' }, { id: 'S2' }] });
    assert.equal(failed.kind, 'design');
    assert.equal(failed.id, 'S1');
});

test('design: with design.fail [] a design not met only warns', async () => {
    const warned = await playDesign({ verdict: 'not-met', designFail: [] });
    assert.equal(warned.results.get('S1').status, 'pass');
    assert.equal(warned.warnings[0].type, 'design');
});

test('design and look: one capture per passed check for the look; their kinds fail without stopping', async () => {
    const warnings = [];
    const session = { ...fakeSession(), warn: (warning) => warnings.push(warning) };
    const handler = async (command) => (command.action === 'check' ? { pass: true, value: true } : 'ok');
    const captured = [];
    const capture = async (id) => {
        captured.push(id);
        return { png: Buffer.from(id) };
    };
    const judgeDesign = async (design) => ({ file: design.file, verdict: 'not-met', missing: ['button "Speichern"'], extra: [], styleDiffs: [] });
    const look = async (id, { capture: shot }) => {
        await shot();
        await shot();
        return id === 'S2'
            ? { record: { screenshot: `step-${id}.png`, visual: { verdict: 'changed', styles: ['1 button weniger'] } }, observed: { styles: [] }, fail: { kind: 'visual', text: `${id} sieht anders aus`, evidence: 'x' }, warnings: [{ type: 'visual', text: 'Aussehen geändert' }] }
            : { record: { screenshot: `step-${id}.png` }, observed: { styles: [] } };
    };
    const clock = fakeClock();
    const played = await playReplay({
        replay: { steps: TWO_STEPS, designs: { S1: { file: 'design/s1.html' } } },
        handler, session, base: 'https://portal.example', stepTimeoutMs: 1000, sleep: clock.sleep, now: clock.now, judgeDesign, capture, look, runTag: 'CAW-7',
    });
    assert.deepEqual(captured, ['S1', 'S2'], 'one capture per step');
    assert.equal(played.results.get('S1').kind, 'design');
    assert.match(played.results.get('S1').note, /S1 entspricht nicht seinem Zielbild: design\/s1\.html Fehlt: button "Speichern"/);
    assert.equal(played.results.get('S2').kind, 'visual');
    assert.equal(played.broken, null, 'the replay went on');
    assert.deepEqual(warnings, [{ step: 'S2', type: 'visual', text: 'Aussehen geändert' }]);
    const records = stepRecords({ ids: ['S1', 'S2'], ...played });
    assert.deepEqual(records[0].design, { file: 'design/s1.html', verdict: 'not-met', missing: ['button "Speichern"'], extra: [], styleDiffs: [], layoutDiffs: [], textDiffs: [] });
    assert.equal(records[0].screenshot, 'step-S1.png');
    assert.deepEqual(records[1].visual, { verdict: 'changed', styles: ['1 button weniger'] });
    assert.ok(played.seenLooks.has('S2'));
    // A real failure later in the run comes first; of two looks, the first.
    assert.equal(failedStep({ ...played, expectations: [{ id: 'S1' }, { id: 'S2' }] }).id, 'S1');
});

test('look hints: measured after each passed step with the varying texts, a failing measurement is no hint, nothing in the step records', async () => {
    const handler = async (command) => (command.action === 'check' ? { pass: true, value: true } : 'ok');
    const asked = [];
    const hintLook = async (id, { texts }) => {
        asked.push([id, texts]);
        if (id === 'S2') throw new Error('page gone');
        return { served: false, masks: 0 };
    };
    const clock = fakeClock();
    const played = await playReplay({ replay: { steps: TWO_STEPS }, handler, session: fakeSession(), base: 'https://portal.example', stepTimeoutMs: 1000, sleep: clock.sleep, now: clock.now, hintLook, runTag: 'CAW-7' });
    assert.deepEqual(asked, [['S1', ['CAW-7', 'caw-7']], ['S2', ['CAW-7', 'caw-7']]]);
    assert.deepEqual([...played.lookHints], [['S1', { served: false, masks: 0 }], ['S2', null]]);
    assert.equal(JSON.stringify(stepRecords({ ids: ['S1', 'S2'], ...played })).includes('served'), false);
});

test('design: a later step that really failed comes first, before a design not met', async () => {
    const played = await playDesign({ verdict: 'not-met', failS2: true });
    const failed = failedStep({ ...played, expectations: [{ id: 'S1' }, { id: 'S2' }] });
    assert.equal(failed.id, 'S2');
    assert.equal(failed.kind, undefined);
});
