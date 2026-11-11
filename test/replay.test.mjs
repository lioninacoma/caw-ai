import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplay, createRecorder, failedStep, playReplay, replayVerdict, isPositional, positionalActions, stepLabel, swapToken } from '../src/host/replay.mjs';
import { targetLabel } from '../src/host/framework/index.mjs';
import { extjs } from '../src/host/framework/extjs.mjs';
import { classifyFailure, renderReport, stackOrigin } from '../src/shared/report.mjs';
import { controlsProbe } from '../src/host/effects.mjs';

const runbook = { expectations: [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }] };
const NEXT_BUTTON = { xtype: 'app_actionButton', text: 'Weiter', part: 'button.x-button-el' };

// A locator whose description the test decides. describeLocator calls locator.evaluate.
const pageWith = (describe) => ({ locator: (selector) => ({ evaluate: async () => describe(selector) }) });

const recorderWith = (describe, handler = async () => 'ok') => createRecorder({
    handler,
    session: { page: () => pageWith(describe) },
    base: 'https://portal.example',
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
    await recorder.handler({ action: 'wait-ready', store: 'antraege', minCount: 1 });
    await recorder.handler({ action: 'click', target: 'e1' });
    await recorder.handler({ action: 'wait-ready', store: 'liste' });
    await recorder.handler({ action: 'wait-ready' });
    assert.deepEqual(recorder.steps, [
        { action: 'wait-ready', store: 'antraege', minCount: 1, timeoutMs: 60_000 },
        { action: 'click', target: NEXT_BUTTON },
        { action: 'wait-ready', store: 'liste' },
    ]);
});

test('Recorder: dates close to the recording day become relative', async () => {
    const recorder = createRecorder({ handler: async () => 'ok', session: { page: () => pageWith(() => NEXT_BUTTON) }, base: 'https://portal.example', now: () => new Date(2026, 10, 7) });
    await recorder.handler({ action: 'fill', target: 'e1', value: '21.11.2026' });
    assert.deepEqual(recorder.steps, [{ action: 'fill', target: NEXT_BUTTON, value: '{{today+14}}' }]);
});

test('swapToken: remembered values only as whole tokens and only in inputs, checks, URLs and target texts', () => {
    const step = { action: 'click', value: '2026', code: "t === 'Nr 2026' && d === '07.11.2026' && k === 'VG-2026' && 'x2026'", url: '/vorgang/2026?a=2026', target: { css: '#v2026', own: 'Vorgang 2026.', inside: { role: 'row', name: '2026 offen' } } };
    assert.deepEqual(swapToken(step, '2026', '{{nr}}'), {
        action: 'click',
        value: '{{nr}}',
        code: "t === 'Nr {{nr}}' && d === '07.11.2026' && k === 'VG-2026' && 'x2026'",
        url: '/vorgang/{{nr}}?a={{nr}}',
        target: { css: '#v2026', own: 'Vorgang {{nr}}.', inside: { role: 'row', name: '{{nr}} offen' } },
    });
});

test('Recorder: messages belong to the action before them and are dropped with it', async () => {
    const shown = ['Willkommen'];
    const recorder = createRecorder({
        handler: async () => 'ok',
        session: { page: () => ({ ...pageWith(() => NEXT_BUTTON), evaluate: async () => ({ messages: [...shown] }) }) },
        base: 'https://portal.example',
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

test('positionalActions: targets chosen only by position or as a later equal match are listed', () => {
    const spec = { steps: [
        { id: 'S1', recording: { actions: [{ action: 'click', target: { role: 'button', name: 'Weiter', index: 0 } }] } },
        { id: 'S2', recording: { actions: [{ action: 'click', target: { xtype: 'button', part: 'button.x-button-el', index: 5 } }] } },
        { id: 'S3', recording: { actions: [{ action: 'click', target: { role: 'button', name: 'Bearbeiten', index: 2 } }] } },
    ] };
    assert.equal(isPositional(spec.steps[0].recording.actions[0].target), false, 'the first of several equal ones is a name');
    assert.equal(isPositional(spec.steps[2].recording.actions[0].target), true, 'the third "Bearbeiten" depends on the order');
    assert.deepEqual(positionalActions(spec).map((line) => line.split(' ')[0]), ['S2', 'S3']);
    assert.deepEqual(positionalActions(spec, new Set(['S1'])), []);
});

test('Recorder: a target that cannot be described is reported, not silently skipped', async () => {
    const recorder = recorderWith(() => null);
    await recorder.handler({ action: 'click', target: 'e1' });
    assert.equal(recorder.steps.length, 0);
    assert.match(recorder.problems[0], /e1.*nicht stabil/);
});

test('Recorder: goto becomes portable, denied targets are recorded as such', async () => {
    const recorder = recorderWith(() => NEXT_BUTTON, async (command) => {
        if (command.url.includes('evil')) throw Object.assign(new Error('nein'), { code: 'target-denied' });
        return 'ok';
    });
    await recorder.handler({ action: 'goto', url: 'https://portal.example/app?x=1#start' });
    await assert.rejects(recorder.handler({ action: 'goto', url: 'https://evil.example/' }), { code: 'target-denied' });
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

/** Page with elements that only become clickable after a number of queries. */
const fakeSession = ({ findAfter = 0, click = async () => {}, ready } = {}) => {
    let polls = 0;
    const element = { click, fill: async () => {}, type: async () => {} };
    const page = {
        evaluateHandle: async () => {
            polls += 1;
            return { asElement: () => (polls > findAfter ? element : null), dispose: async () => {} };
        },
        waitForLoadState: async () => {},
    };
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
    const deny = async () => { throw Object.assign(new Error('nein'), { code: 'target-denied' }); };
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
    const page = { ...pageWith(() => NEXT_BUTTON), url: () => 'https://portal.example/app?x=1#start', evaluate: async () => ({ ...healthy, messages: ['Wirklich abbrechen? Ja Nein'] }) };
    const recorder = createRecorder({ handler: async () => 'ok', session: { page: () => page }, base: 'https://portal.example' });
    await recorder.handler({ action: 'click', target: 'e1' });
    assert.deepEqual([...recorder.messages], ['Wirklich abbrechen? Ja Nein']);
    assert.equal(recorder.steps[0].path, '/app');
});

test('Names in messages', () => {
    assert.equal(targetLabel(NEXT_BUTTON), 'app_actionButton "Weiter"');
    assert.equal(targetLabel({ part: 'a', own: 'Link' }), 'a "Link"');
    assert.equal(stepLabel({ action: 'click', target: NEXT_BUTTON }), 'click app_actionButton "Weiter"');
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
    recorder.forgetChecks(new Set(['S2', 'S3']));
    assert.deepEqual(recorder.steps.map(({ action, id }) => (id === undefined ? action : `${action} ${id}`)), ['click', 'check S1', 'click', 'click']);
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
        page.locator = () => ({ ariaSnapshot: async () => '- main' });
        const clock = fakeClock();
        const effects = { S1: { runs: 2, actions: [{ action: 1, controls: ['+ input "Kategorie" disabled'] }] } };
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
    const { stepGroups } = await import('../src/host/replay.mjs');
    const steps = [{ id: 'S1', name: 'Anmelden', expect: 'Startseite offen' }, { id: 'S2', name: 'Akte', expect: 'Akte steht da' }, { id: 'S3', name: 'Noch offen', expect: 'x' }];
    const replay = { steps: [
        { action: 'fill', target: { label: 'Passwort' }, value: 'geheim' },
        { action: 'click', target: { role: 'button', text: 'Anmelden' } },
        { action: 'wait-ready' },
        { action: 'check', id: 'S1' },
        { action: 'press', key: 'Enter' },
        { action: 'check', id: 'S2' },
        { action: 'screenshot', name: 'ende' },
    ] };
    const groups = stepGroups(steps, replay);
    assert.deepEqual(groups.map(({ id, points }) => [id, points.map(({ id: point }) => point)]), [['S1', ['a1', 'a2', 'a3', 'a4']], ['S2', ['a5', 'a6', 'a7']], ['S3', []]]);
    assert.deepEqual(groups[0].points.map(({ kind, label }) => `${kind} ${label}`), ['Eingabe „Passwort“', 'Klick „Anmelden“', 'Warten Seite ruhig', 'Prüfung Startseite offen']);
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
    const page = { locator: () => ({ evaluate: async () => ({ role: 'button', name: 'Alle akzeptieren' }) }), url: () => 'https://p.example/a', evaluate: async () => ({ messages: [] }) };
    let absent = false;
    const recorder = createRecorder({ handler: async () => (absent ? 'absent' : 'ok'), session: { page: () => page }, base: 'https://p.example' });
    await recorder.handler({ action: 'click', target: 'e1', optional: true });
    absent = true;
    await recorder.handler({ action: 'click', target: 'e1', optional: true });
    absent = false;
    await recorder.handler({ action: 'click', target: 'e2' });
    assert.equal(recorder.steps.length, 2);
    assert.equal(recorder.steps[0].optional, true);
    assert.equal(recorder.steps[1].optional, undefined);
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
    for (const action of ['click', 'fill', 'type', 'press', 'goto', 'reload']) {
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
    assert.equal(transportOf({ steps: [{ id: 'S1' }], until: 'S1' }), 'play', '--until replays first');
    assert.equal(transportOf({ steps: [] }), 'pause', 'open hands over at once');
});
