// Robustness of the replay core without a browser: run tags, values in code, ids in paths, pinned language and time zone,
// warnings when the page never gets quiet, signals and the plan gate.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { browserRegion, readyIgnoreOf } from '../src/host/browser-session.mjs';
import { zonedNow } from '../src/host/dates.mjs';
import { NEEDS_PLAN, onAbortSignals } from '../src/host/run.mjs';
import { buildReplay, createRecorder, newRunTag, playReplay, recordedBrowser, replayOf, samePath, swapText, swapToken } from '../src/host/replay.mjs';

const fakeClock = () => {
    let at = 0;
    return { now: () => at, sleep: async (ms) => { at += ms; } };
};

test('run tag: milliseconds and two random digits, digits only, CAW- prefix', () => {
    const at = new Date('2026-11-05T18:52:33.120Z');
    assert.equal(newRunTag(at, () => 0.07), 'CAW-2026110518523312007');
    assert.notEqual(newRunTag(at, () => 0.07), newRunTag(at, () => 0.08), 'same millisecond, other digits');
    for (let index = 0; index < 20; index += 1) assert.match(newRunTag(), /^CAW-\d{19}$/);
});

test('values in code: quotes, backslashes, ${ and line breaks stay one literal in every quote type', () => {
    const value = 'O\'Brien "the" `x` ${y} a\\b\nc';
    for (const code of ["text === '{{name}}'", 'text === "{{name}}"', 'text === `{{name}}`']) {
        const step = swapText({ action: 'check', id: 'S1', code, value: '{{name}}' }, '{{name}}', value);
        assert.equal(new Function('text', `return ${step.code};`)(value), true, code);
        assert.equal(step.value, value, 'a fill value stays raw');
    }
    assert.equal(swapText('plain {{name}}', '{{name}}', "O'B"), "plain O'B", 'outside a step nothing is escaped');
});

test('replay fills remembered values into check code escaped', async () => {
    const seen = [];
    const handler = async (command) => {
        seen.push(command);
        if (command.action === 'remember') return { name: 'name', value: "O'Brien" };
        return { pass: true, value: true };
    };
    const replay = { steps: [{ action: 'remember', name: 'name', code: 'x' }, { action: 'check', id: 'S1', code: "document.title === '{{name}}'" }] };
    await playReplay({ replay, handler, session: { page: () => ({}), waitReady: async () => ({ settled: true }) }, base: 'https://p.example', stepTimeoutMs: 1000, ...fakeClock() });
    assert.equal(seen.at(-1).code, "document.title === 'O\\'Brien'");
});

test('ids in paths: the recording keeps a placeholder, the page comparison tolerates placeholder segments', async () => {
    assert.deepEqual(swapToken({ action: 'click', target: "getByRole('button', { name: 'Save', exact: true })", path: '/todos/1045/edit' }, '1045', '{{todoId}}').path, '/todos/{{todoId}}/edit');
    assert.equal(swapToken({ action: 'click', path: '/todos/10456' }, '1045', '{{todoId}}').path, '/todos/10456', 'only whole tokens');
    const page = { locator: () => ({}), url: () => 'https://p.example/todos/1045', evaluate: async () => ({ messages: [] }) };
    const recorder = createRecorder({ handler: async () => 'ok', session: { page: () => page }, base: 'https://p.example', remembered: new Map([['{{todoId}}', '1045']]), recordTarget: async () => "getByRole('button', { name: 'Save', exact: true })" });
    await recorder.handler({ action: 'click', target: 'e1' });
    assert.equal(recorder.steps[0].path, '/todos/{{todoId}}');
    assert.equal(samePath('/todos/1046', '/todos/{{todoId}}'), true);
    assert.equal(samePath('/todos/1046/edit', '/todos/{{todoId}}'), false);
    assert.equal(samePath('/orders/1046', '/todos/{{todoId}}'), false);
    assert.equal(samePath('/akte-caw-1', '/akte-{{runTagLower}}'), true);
    assert.equal(samePath('/todos/1046', '/todos/1045'), false, 'without a placeholder the path must be equal');
});

test('language and time zone: config first, then the recording, then the host; invalid values are skipped', () => {
    const host = { locale: 'en-US', timeZone: 'UTC' };
    assert.deepEqual(browserRegion({}, {}, host), { locale: 'en-US', timezone: 'UTC' });
    assert.deepEqual(browserRegion({}, { locale: 'de-DE', timezone: 'Europe/Berlin' }, host), { locale: 'de-DE', timezone: 'Europe/Berlin' });
    assert.deepEqual(browserRegion({ browser: { locale: 'fr-FR', timezone: 'Europe/Paris' } }, { locale: 'de-DE', timezone: 'Europe/Berlin' }, host), { locale: 'fr-FR', timezone: 'Europe/Paris' });
    assert.deepEqual(browserRegion({ browser: { locale: 'not a locale!', timezone: 'Mars/Base' } }, {}, host), { locale: 'en-US', timezone: 'UTC' });
    assert.deepEqual(readyIgnoreOf({ readyIgnore: ['.ticker', 3, '', '#clock'] }), ['.ticker', '#clock']);
    assert.deepEqual(readyIgnoreOf({}), []);
});

test('language and time zone: stored with every recorded step and handed to replay; nothing recorded yet has none', () => {
    const recorder = { problems: [], steps: [{ action: 'check', id: 'S1', code: 'true' }], messages: new Set() };
    const spec = { id: 't', steps: [{ id: 'S1', name: 'a', do: 'b', expect: 'c' }] };
    const { candidate } = buildReplay({ recorder, outcome: { status: 'pass', results: [] }, spec, target: 'local', browser: { locale: 'de-DE', timezone: 'Europe/Berlin' } });
    assert.equal(candidate.steps[0].recording.locale, 'de-DE');
    assert.equal(candidate.steps[0].recording.timezone, 'Europe/Berlin');
    assert.deepEqual(replayOf(candidate).browser, { locale: 'de-DE', timezone: 'Europe/Berlin' });
    assert.deepEqual(recordedBrowser([{ recording: { actions: [] } }]), {});
});

test('the browser\'s today: dates are filled in the pinned time zone, not the host\'s', () => {
    const late = new Date('2026-11-05T23:30:00Z');
    const berlin = zonedNow('Europe/Berlin', late);
    assert.equal(berlin.getDate(), 6);
    assert.equal(berlin.getHours(), 0);
    assert.equal(zonedNow('UTC', late).getDate(), 5);
    assert.equal(zonedNow(undefined, late), late);
    assert.equal(zonedNow('Mars/Base', late), late);
});

test('a page that never gets quiet: one warning per step naming readyIgnore, replay goes on', async () => {
    const warnings = [];
    const session = { page: () => ({ waitForLoadState: async () => {} }), waitReady: async () => ({ settled: false }), warn: (entry) => warnings.push(entry) };
    const handler = async (command) => (command.action === 'check' ? { pass: true, value: true } : 'ok');
    const replay = { steps: [{ action: 'reload' }, { action: 'reload' }, { action: 'check', id: 'S1', code: 'true' }, { action: 'reload' }, { action: 'check', id: 'S2', code: 'true' }] };
    const { results } = await playReplay({ replay, handler, session, base: 'https://p.example', stepTimeoutMs: 1000, ...fakeClock() });
    assert.equal(results.get('S2').status, 'pass');
    assert.deepEqual(warnings.map(({ text }) => text.match(/^In (S\d)/)[1]), ['S1', 'S2']);
    assert.match(warnings[0].text, /readyIgnore/);
});

test('signals: SIGINT, SIGTERM and SIGHUP end a run alike, each once, and can be removed', () => {
    const target = new EventEmitter();
    const seen = [];
    const stop = onAbortSignals((signal) => seen.push(signal), { signals: ['SIGINT', 'SIGTERM', 'SIGHUP'], target });
    target.emit('SIGTERM', 'SIGTERM');
    target.emit('SIGTERM', 'SIGTERM');
    target.emit('SIGHUP', 'SIGHUP');
    assert.deepEqual(seen, ['SIGTERM', 'SIGHUP']);
    stop();
    target.emit('SIGINT', 'SIGINT');
    assert.equal(target.listenerCount('SIGINT'), 0);
    assert.deepEqual(seen, ['SIGTERM', 'SIGHUP']);
});

test('plan gate: eval changes the page like a click and needs the approved plan; snapshot does not', () => {
    assert.ok(NEEDS_PLAN.has('eval'));
    assert.ok(!NEEDS_PLAN.has('snapshot'));
});

test('viewport: browser.viewport before the recorded one; recordedBrowser takes the newest recorded viewport', async () => {
    const host = { locale: 'en-US', timeZone: 'UTC' };
    const recorded = { locale: 'de-DE', timezone: 'Europe/Berlin', viewport: { width: 1280, height: 800 } };
    assert.deepEqual(browserRegion({}, recorded, host).viewport, { width: 1280, height: 800 });
    assert.deepEqual(browserRegion({ browser: { viewport: { width: 1920, height: 1200 } } }, recorded, host).viewport, { width: 1920, height: 1200 });
    assert.equal(browserRegion({}, { viewport: { width: 1, height: 1 } }, host).viewport, undefined, 'an invalid size is skipped');
    const steps = [
        { recording: { locale: 'de-DE', timezone: 'Europe/Berlin', viewport: { width: 1024, height: 768 } } },
        { recording: { locale: 'de-DE', timezone: 'Europe/Berlin' } },
        {},
    ];
    assert.deepEqual(recordedBrowser(steps), { locale: 'de-DE', timezone: 'Europe/Berlin', viewport: { width: 1024, height: 768 } });
    assert.deepEqual(recordedBrowser([]), {});
});
