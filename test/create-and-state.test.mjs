import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAgentHandler } from '../src/host/agent-commands.mjs';
import { createChat, parseClaudeLog, tailLines } from '../src/host/chat.mjs';
import { captureInPage, demonstrate, feedLabel, itemLabel, recordableSteps } from '../src/host/demonstrate.mjs';
import { RUN_TAG_PLACEHOLDER, createRecorder, dropNumbers, fillRun, newRunTag, playReplay, tagRun, tidyNumbers } from '../src/host/replay.mjs';
import { readContext } from '../src/host/run.mjs';
import { withStepBudget } from '../src/host/step-budget.mjs';
import { isAllowedFailure, renderReport } from '../src/shared/report.mjs';

test('Step budget: counts every action, failed ones too; reading is free', async () => {
    const seen = [];
    const budget = withStepBudget(async ({ action }) => {
        seen.push(action);
        if (action === 'click') throw new Error('covered');
        return 'ok';
    }, 2);
    await budget.handler({ action: 'snapshot' });
    await budget.handler({ action: 'eval' });
    await assert.rejects(budget.handler({ action: 'click' }), /covered/);
    await budget.handler({ action: 'goto' });
    assert.equal(budget.used(), 2);
    await assert.rejects(budget.handler({ action: 'fill' }), { code: 'step-limit' });
    assert.deepEqual(seen, ['snapshot', 'eval', 'click', 'goto'], 'the rejected step does not reach the browser');
    await budget.handler({ action: 'finish' });
});

test('Run tag: the recording keeps the placeholder, every replay inserts its own', async () => {
    const id = newRunTag(new Date('2026-11-05T18:52:33Z'));
    assert.equal(id, 'CAW-20261105185233');
    const page = { locator: () => ({ evaluate: async () => ({ xtype: 'liste', own: `Vorgang ${id}` }) }), url: () => 'https://p.example/a', evaluate: async () => ({ messages: [] }) };
    const recorder = createRecorder({ handler: async (command) => (command.action === 'check' ? { pass: true } : 'ok'), session: { page: () => page }, base: 'https://p.example', runTag: id });
    await recorder.handler({ action: 'fill', target: 'e1', value: `Anliegen ${id}` });
    await recorder.handler({ action: 'click', target: 'e2' });
    await recorder.handler({ action: 'check', id: 'S1', code: `text.includes('${id}')` });
    assert.equal(recorder.steps[0].value, `Anliegen ${RUN_TAG_PLACEHOLDER}`);
    assert.equal(recorder.steps[1].target.own, `Vorgang ${RUN_TAG_PLACEHOLDER}`);
    assert.equal(recorder.steps[2].code, `text.includes('${RUN_TAG_PLACEHOLDER}')`);
    // Baseline values come from the first healthy run, never from Claude's session with its misclicks.
    const withNet = createRecorder({ handler: async () => ({ pass: true }), session: { page: () => page, network: { mark: () => 0, since: () => [{ name: 'GET /umweg', outcome: 'ok', status: 200, ms: 1 }] } }, base: 'https://p.example' });
    await withNet.handler({ action: 'check', id: 'S1', code: 'true' });
    assert.deepEqual(withNet.steps, [{ action: 'check', id: 'S1', code: 'true' }]);

    const seen = [];
    const session = {
        page: () => ({ evaluate: async () => ({ messages: [], extLoaded: true, signedIn: true }), evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }), waitForLoadState: async () => {} }),
        waitReady: async () => {},
        failures: () => [],
    };
    await playReplay({
        replay: { steps: [recorder.steps[2]] },
        handler: async (command) => { seen.push(command); return { pass: true, value: true }; },
        session,
        base: 'https://p.example',
        stepTimeoutMs: 100,
        runTag: 'CAW-2',
    });
    assert.equal(seen[0].code, "text.includes('CAW-2')");
});

test('Recording: a status note present while recording counts as known and does not warn in every run', async () => {
    const page = { locator: () => ({ evaluate: async () => ({ xtype: 'a', own: 'A' }) }), url: () => 'https://p.example/a', evaluate: async () => ({ appLoaded: true, signedIn: true, messages: [], notes: ['EULA nicht angenommen.'] }) };
    const recorder = createRecorder({ handler: async () => ({ pass: true }), session: { page: () => page }, base: 'https://p.example' });
    await recorder.handler({ action: 'check', id: 'S1', code: 'true' });
    assert.ok([...recorder.messages].includes('EULA nicht angenommen.'));
});

test('Demonstration: the chat echoes every recorded action; checkpoints and failures it shows anyway', () => {
    assert.equal(feedLabel({ action: 'click', target: { role: 'link', name: 'Alle Akten' } }), 'Klick link "Alle Akten"');
    assert.equal(feedLabel({ action: 'fill', target: { role: 'textbox', name: 'Passwort' }, secret: true }), 'Eingabe in ein Passwortfeld, wird nicht aufgezeichnet');
    assert.equal(feedLabel({ action: 'press', key: 'Enter' }), 'Taste Enter');
    assert.match(feedLabel({ action: 'navigated', url: '/b' }), /Seitenwechsel nach \/b/);
    for (const action of ['checkpoint', 'note', 'failure']) assert.equal(feedLabel({ action, text: 'x' }), null);
});

test('Lower-case run tag: URLs derived from names get their own placeholder', async () => {
    const id = 'CAW-20261108172351';
    const page = { locator: () => ({ evaluate: async () => ({ xtype: 'a', own: 'Akte' }) }), url: () => 'https://p.example/a', evaluate: async () => ({ messages: [] }) };
    const recorder = createRecorder({ handler: async () => ({ pass: true }), session: { page: () => page }, base: 'https://p.example', runTag: id });
    const code = `location.pathname.startsWith('/akten/akte-caw-20261108172351') && h1 === 'Akte ${id}'`;
    await recorder.handler({ action: 'check', id: 'S1', code });
    assert.equal(recorder.steps[0].code, "location.pathname.startsWith('/akten/akte-{{runTagLower}}') && h1 === 'Akte {{runTag}}'");
    assert.equal(fillRun(recorder.steps[0], 'CAW-7').code, "location.pathname.startsWith('/akten/akte-caw-7') && h1 === 'Akte CAW-7'");
    assert.deepEqual(tagRun({ a: 'x' }, id), { a: 'x' });
});

test('Demonstration: only actions with a stable target and no secret are directly replayable', () => {
    const target = { xtype: 'b', text: 'Weiter' };
    const { steps, problems } = recordableSteps([
        { action: 'click', target, path: '/a' },
        { action: 'checkpoint', text: 'Maske da', path: '/a' },
        { action: 'fill', target: { xtype: 'p' }, secret: true, path: '/a' },
        { action: 'click', target: null, hint: 'div', path: '/a' },
        { action: 'navigated', url: '/b#vorgang/4711', path: '/b' },
    ]);
    assert.deepEqual(steps, [{ action: 'click', target, path: '/a' }], 'a navigation is only a hint, never a fixed goto');
    assert.match(itemLabel({ action: 'navigated', url: '/b' }), /nur Hinweis/);
    assert.equal(problems.length, 2);
    assert.equal(itemLabel({ action: 'click', target }), 'click b "Weiter"');
    assert.match(itemLabel({ action: 'click', target: null, hint: 'div' }), /ohne stabile/);
});

test('Demonstration: text becomes a checkpoint with screenshot; an empty line ends it, so does closing the window', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-show-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bindings = {};
    const context = {
        exposeBinding: async (name, callback) => { bindings[name] = callback; },
        addInitScript: async () => {},
        pages: () => [],
        on: () => {},
    };
    const page = { screenshot: async () => Buffer.from('png'), url: () => 'https://p.example/a?geheim=1' };
    const never = new Promise(() => {});
    const lines = ['  Maske da ', ''];
    const session = { context, ownsPage: (candidate) => candidate === page, page: () => page, closed: never };
    const silent = { step: () => {} };
    const items = await demonstrate({
        session,
        ui: silent,
        dir,
        operator: {
            nextLine: async () => {
                bindings.__cawCapture({ page }, { action: 'click', target: { xtype: 'b' }, path: '/a' });
                bindings.__cawCapture({ page: {} }, { action: 'click', target: { xtype: 'fremder-tab' }, path: '/a' });
                return lines.shift();
            },
        },
    });
    assert.deepEqual(items.map(({ action }) => action), ['click', 'checkpoint', 'click']);
    assert.deepEqual(items[1], { action: 'checkpoint', text: 'Maske da', path: '/a', screenshot: 'punkt-1.png' });

    const closing = { ...session, context: { ...context }, closed: Promise.resolve() };
    const none = await demonstrate({ session: closing, ui: silent, dir, operator: { nextLine: () => never } });
    assert.deepEqual(none, []);
});

test('Demonstration in the browser: passwords stay in the page, fields come before the key', () => {
    const sent = [];
    const listeners = {};
    class Field {
        constructor(type, value) { Object.assign(this, { type, value }); }
    }
    const scope = {
        window: { __cawCapture: (event) => sent.push(event) },
        location: { pathname: '/a' },
        document: { activeElement: null },
        HTMLInputElement: Field,
        HTMLTextAreaElement: class {},
        Element: Field,
        addEventListener: (name, callback) => { listeners[name] = callback; },
    };
    const run = new Function(...Object.keys(scope), `(${captureInPage})('__cawCapture', (element) => ({ part: element.type }), ['checkbox']);`);
    run(...Object.values(scope));

    const secret = new Field('password', 'geheim');
    listeners.focusin({ target: secret });
    secret.value = 'noch geheimer';
    listeners.change({ target: secret });
    assert.equal(JSON.stringify(sent).includes('geheim'), false);
    assert.equal(sent[0].secret, true);

    sent.length = 0;
    const field = new Field('text', '');
    listeners.focusin({ target: field });
    field.value = 'Text';
    listeners.keydown({ isTrusted: true, key: 'Enter', target: field });
    listeners.change({ target: field });
    assert.deepEqual(sent.map(({ action, value, key }) => [action, value ?? key]), [['fill', 'Text'], ['press', 'Enter']], 'no duplicate from the late change event');

    sent.length = 0;
    listeners.click({ isTrusted: false, target: field });
    listeners.keydown({ isTrusted: true, key: 'a', target: field });
    assert.deepEqual(sent, [], 'synthetic clicks and ordinary keys do not count');
});

test('Report: lists writing calls, not their parameters', () => {
    const report = renderReport({ status: 'pass', testId: 'r', target: 'a/dev', source: 'overlay', writes: [{ label: 'connector HTTP-X', count: 2 }] });
    assert.match(report, /## Schreibende Aufrufe[\s\S]*connector HTTP-X \(2x\)/);
    assert.doesNotMatch(renderReport({ status: 'pass', testId: 'r', target: 'a/dev', source: 'overlay' }), /Schreibende/);
});

test('Demonstration: a reload is a hint in the recording; refresh only reloads the page', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-reload-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const handlers = {};
    let navType = 'reload';
    const frame = { evaluate: async (fn) => (typeof fn === 'function' ? navType : undefined), waitForLoadState: async () => {}, url: () => 'https://p.example/a#liste' };
    const page = { url: () => frame.url(), screenshot: async () => Buffer.from('png'), on: (name, callback) => { handlers[name] = callback; }, mainFrame: () => frame, frames: () => [frame] };
    const context = { exposeBinding: async () => {}, addInitScript: async () => {}, pages: () => [page], on: () => {} };
    let refresh = 'never set';
    let reloads = 0;
    const workbench = { page: {}, view: { frame }, onRefresh: (handler) => { refresh = handler; } };
    let clock = 0;
    const lines = [
        async () => {
            // F5 on the same URL, then a real navigation long after the last click
            await refresh();
            handlers.framenavigated(frame);
            await new Promise((ok) => { setTimeout(ok, 5); });
            // A form posting to the same URL is not a reload
            navType = 'navigate';
            handlers.framenavigated(frame);
            await new Promise((ok) => { setTimeout(ok, 5); });
            clock += 10000;
            frame.url = () => 'https://p.example/b';
            handlers.framenavigated(frame);
            return { note: 'Backend war noch nicht warm' };
        },
        async () => '',
    ];
    const items = await demonstrate({
        session: { context, ownsPage: () => true, page: () => page, closed: new Promise(() => {}), workbench, reloadPage: async () => { reloads += 1; } },
        ui: { step: () => {} },
        dir,
        now: () => clock,
        operator: { nextLine: () => lines.shift()() },
    });
    assert.deepEqual(items.map(({ action }) => action), ['reloaded', 'navigated', 'note']);
    assert.deepEqual(items[0], { action: 'reloaded', url: '/a#liste', path: '/a' });
    assert.match(itemLabel(items[0]), /^Seite neu geladen: \/a#liste \(nur Hinweis\)$/);
    assert.equal(reloads, 1, 'refresh reloads the page during the demonstration');
    assert.equal(refresh, null, 'afterwards refresh is blocked again');
    assert.deepEqual(recordableSteps(items).steps, [], 'a reload does not become a fixed step');
});

test('Demonstration: help in the same run does not overwrite earlier screenshots', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-png-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'punkt-1.png'), 'alt');
    const page = { screenshot: async () => Buffer.from('neu'), url: () => 'https://p.example/a' };
    const context = { exposeBinding: async () => {}, addInitScript: async () => {}, pages: () => [], on: () => {} };
    const lines = ['Zweiter', ''];
    const items = await demonstrate({
        session: { context, ownsPage: () => true, page: () => page, closed: new Promise(() => {}) },
        ui: { step: () => {} },
        dir,
        operator: { nextLine: async () => lines.shift() },
    });
    assert.equal(items[0].screenshot, 'punkt-2.png');
});

test('Demonstration: Ctrl+C aborts instead of continuing with half a demonstration', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-int-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const context = { exposeBinding: async () => {}, addInitScript: async () => {}, pages: () => [], on: () => {} };
    let aborted = false;
    const running = demonstrate({
        session: { context, ownsPage: () => true, page: () => ({}), closed: new Promise(() => {}) },
        ui: { step: () => {} },
        dir,
        operator: { nextLine: ({ signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) },
    });
    await new Promise((ok) => { setTimeout(ok, 20); });
    process.emit('SIGINT');
    await assert.rejects(running, { code: 'aborted' });
    assert.equal(aborted, true, 'the pending input is ended');
});

const RECORDED = [
    { action: 'goto', url: '/a' },
    { action: 'wait-ready' },
    { action: 'click', target: { xtype: 'tab', text: 'Falsch' } },
    { action: 'wait-ready' },
    { action: 'check', id: 'S1', code: 'a' },
];

test('Detours: numbers are parsed and strictly validated', () => {
    assert.deepEqual(dropNumbers(RECORDED, undefined), []);
    assert.deepEqual(dropNumbers(RECORDED, [3, '1-2', 3]), [1, 2, 3]);
    assert.throws(() => dropNumbers(RECORDED, 3), { code: 'finish-rejected' });
    assert.throws(() => dropNumbers(RECORDED, ['drei']), { code: 'finish-rejected' });
    assert.throws(() => dropNumbers(RECORDED, [0]), { code: 'finish-rejected' });
    assert.throws(() => dropNumbers(RECORDED, ['4-99']), { code: 'finish-rejected' });
    assert.throws(() => dropNumbers(RECORDED, ['3-2']), { code: 'finish-rejected' });
    assert.throws(() => dropNumbers(RECORDED, [5]), /a check \(S1\)/);
    assert.throws(() => dropNumbers(RECORDED, ['4-5']), /a check/);
});

test('Detours: dropping lists the steps, shortens them and leaves no duplicate wait-ready', () => {
    const recorder = createRecorder({ handler: async () => 'ok', session: { page: () => ({}) }, base: 'https://p.example' });
    recorder.addSteps(RECORDED);
    assert.match(recorder.list()[2], /^3 click tab "Falsch"$/);
    recorder.drop([3]);
    assert.deepEqual(recorder.steps.map(({ action }) => action), ['goto', 'wait-ready', 'check']);
});

test('Report: dropped steps are listed', () => {
    const report = renderReport({ status: 'pass', testId: 'r', target: 'a/dev', source: 'overlay', dropped: ['3 click tab "Falsch"'] });
    assert.match(report, /## Aus der Aufzeichnung gestrichen[\s\S]*3 click tab "Falsch"/);
});

test('caw.md: is read; missing or empty yields nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'caw-context-'));
    try {
        assert.equal(readContext(root), undefined);
        mkdirSync(join(root, 'caw'));
        writeFileSync(join(root, 'caw/caw.md'), ' \n');
        assert.equal(readContext(root), undefined);
        writeFileSync(join(root, 'caw/caw.md'), '## Suche\nMerkt sich alles.\n');
        assert.equal(readContext(root), '## Suche\nMerkt sich alles.');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('consoleIgnore: allows known messages, but never HTTP 500 and above', () => {
    const patterns = [/getKey is not a function/, /HTTP 500/, /DataProxy/];
    assert.equal(isAllowedFailure({ type: 'pageerror', text: 'TypeError: t.getKey is not a function' }, undefined, patterns), true);
    assert.equal(isAllowedFailure({ type: 'pageerror', text: 'TypeError: anderes' }, undefined, patterns), false);
    assert.equal(isAllowedFailure({ type: 'requestfailed', text: 'net::ERR' }, 'https://p/o/DataProxy', patterns), true);
    assert.equal(isAllowedFailure({ type: 'http', text: 'HTTP 500' }, 'https://p/o/DataProxy', patterns), false);
});

const rememberPage = { locator: () => ({ evaluate: async () => ({ xtype: 'gridcell', own: 'Nr 20262140000260' }) }), url: () => 'https://p.example/a', evaluate: async () => ({ messages: [] }) };
const rememberRecorder = () => createRecorder({
    handler: async (command) => {
        if (command.action === 'remember') return { name: command.name, value: '20262140000260' };
        return command.action === 'check' ? { pass: true } : 'ok';
    },
    session: { page: () => rememberPage },
    base: 'https://p.example',
});

test('remember: later steps store the placeholder, earlier ones stay, even after dropping', async () => {
    const recorder = rememberRecorder();
    await recorder.handler({ action: 'fill', target: 'e1', value: 'vorher 20262140000260' });
    await recorder.handler({ action: 'remember', name: 'vorgangsnr', code: 'lies()' });
    await recorder.handler({ action: 'fill', target: 'e2', value: '20262140000260' });
    await recorder.handler({ action: 'click', target: 'e3' });
    await recorder.handler({ action: 'check', id: 'S1', code: "x === '20262140000260'" });
    assert.equal(recorder.steps[2].value, '{{vorgangsnr}}');
    assert.equal(recorder.steps[3].target.own, 'Nr {{vorgangsnr}}');
    assert.equal(recorder.steps[4].code, "x === '{{vorgangsnr}}'");
    recorder.drop([4]);
    assert.equal(recorder.steps[0].value, 'vorher 20262140000260');
    assert.deepEqual(recorder.list().at(1), '2 remember vorgangsnr');
    assert.throws(() => dropNumbers(recorder.steps, [2]), /remembers vorgangsnr/);
});

test('remember: replay reads the value again and waits until it is there', async () => {
    const seen = [];
    let tries = 0;
    const session = {
        page: () => ({ evaluate: async () => ({ messages: [], extLoaded: true, signedIn: true }), waitForLoadState: async () => {} }),
        waitReady: async () => {},
        failures: () => [],
    };
    const handler = async (command) => {
        seen.push(command);
        if (command.action !== 'remember') return { pass: true, value: true };
        tries += 1;
        if (tries === 1) throw new Error('not yet');
        return { name: command.name, value: '20262140000999' };
    };
    const { broken, results } = await playReplay({
        replay: { steps: [{ action: 'remember', name: 'vorgangsnr', code: 'lies()' }, { action: 'check', id: 'S1', code: "x === '{{vorgangsnr}}'" }] },
        handler,
        session,
        base: 'https://p.example',
        stepTimeoutMs: 1000,
        sleep: async () => {},
    });
    assert.equal(broken, null);
    assert.equal(results.get('S1').status, 'pass');
    assert.equal(seen.at(-1).code, "x === '20262140000999'");
});

test('remember: the host rejects empty, short and reserved values', async () => {
    let result = '20262140000260';
    const handler = createAgentHandler({ session: { page: () => ({ evaluate: async () => result }) }, run: { expectations: [] }, hosts: [], agentDir: '.', onVerdict: () => {} });
    assert.deepEqual(await handler({ action: 'remember', name: 'nr', code: 'x' }), { name: 'nr', value: '20262140000260' });
    result = 20262140000260;
    assert.equal((await handler({ action: 'remember', name: 'nr', code: 'x' })).value, '20262140000260');
    for (const bad of ['', '12', null]) {
        result = bad;
        await assert.rejects(handler({ action: 'remember', name: 'nr', code: 'x' }), { code: 'usage' });
    }
    result = '20262140000260';
    await assert.rejects(handler({ action: 'remember', name: 'runTag', code: 'x' }), { code: 'usage' });
    await assert.rejects(handler({ action: 'remember', name: 'a b', code: 'x' }), { code: 'usage' });
});

test('Chat: a message holds every browser command until Claude has read it', () => {
    const shown = [];
    const chat = createChat({ show: (who, text) => shown.push([who, text]) });
    chat.gate();
    chat.human.message('  nimm den anderen Tab ');
    chat.human.message('   ');
    assert.throws(() => chat.gate(), { code: 'human-message' });
    assert.deepEqual(chat.takeUnread(), ['nimm den anderen Tab']);
    chat.gate();
    chat.say('Mache ich');
    assert.deepEqual(shown, [['human', 'nimm den anderen Tab'], ['claude', 'Mache ich']]);
    assert.throws(() => chat.say(' '), { code: 'usage' });
});

test('Chat: pause leaves time for input, only continue returns', async () => {
    const states = [];
    const chat = createChat({ status: (state) => states.push(state) });
    chat.human.toggle();
    assert.equal(chat.paused(), true);
    assert.throws(() => chat.gate(), { code: 'human-message' });
    chat.human.toggle();
    assert.equal(chat.paused(), false, 'while Claude is not yet waiting, the pause can be withdrawn');
    chat.human.toggle();
    chat.enter('paused');
    const first = chat.operator.nextLine();
    chat.human.message('Eins');
    assert.deepEqual(await first, { note: 'Eins' });
    chat.human.message('Zwei', { checkpoint: true });
    assert.deepEqual(await chat.operator.nextLine(), { note: 'Zwei' }, 'text does not end the pause, and only a demonstration creates checkpoints');
    const end = chat.operator.nextLine();
    chat.human.toggle();
    assert.equal(await end, '');
    chat.leave();
    chat.gate();
    assert.deepEqual(states, ['pausing', 'running', 'pausing', 'paused', 'paused', 'running']);
});

test('Chat: an answer to a question ends the wait at once, and a closed window blocks nothing', async () => {
    const chat = createChat();
    chat.enter('asking');
    chat.human.message('Sonstiges');
    assert.deepEqual(await chat.operator.nextLine(), { note: 'Sonstiges' });
    assert.equal(await chat.operator.nextLine(), '');
    chat.leave();
    chat.human.toggle();
    chat.enter('paused');
    const pending = chat.operator.nextLine();
    chat.human.closed();
    assert.equal(await pending, null);
    chat.leave();
    chat.gate();
    assert.equal(chat.available(), false);
});

test('Chat: aborted input stops reading', async () => {
    const chat = createChat();
    chat.enter('paused');
    const input = new AbortController();
    const pending = chat.operator.nextLine({ signal: input.signal });
    input.abort();
    assert.equal(await pending, null);
});

test('Chat: while demonstrating, the human separates context and checkpoint', async () => {
    const shown = [];
    const chat = createChat({ show: (who, text) => shown.push([who, text]) });
    chat.enter('showing');
    chat.human.message('Das Feld muss leer sein');
    chat.human.message('Maske ist da', { checkpoint: true });
    assert.deepEqual(await chat.operator.nextLine(), { note: 'Das Feld muss leer sein' });
    assert.deepEqual(await chat.operator.nextLine(), { checkpoint: 'Maske ist da' });
    assert.deepEqual(shown, [['human', 'Das Feld muss leer sein'], ['checkpoint', 'Maske ist da']]);
});

test('Chat: a picked element attaches to the next message and is not lost without text', async () => {
    const shown = [];
    const chat = createChat({ show: (who, text, about) => shown.push([who, text, about]) });
    const element = { label: 'button "Weiter"', target: { xtype: 'button', text: 'Weiter' }, tag: 'button', text: 'Weiter' };
    assert.equal(chat.canPick(), false, 'not while Claude is working');
    chat.enter('paused');
    assert.equal(chat.canPick(), true);
    chat.attach(element);
    chat.human.message('Der hier');
    assert.deepEqual(await chat.operator.nextLine(), { note: 'Der hier', element });
    assert.deepEqual(shown, [['human', 'Der hier', 'button "Weiter"']]);
    chat.human.message('Ohne');
    assert.deepEqual(await chat.operator.nextLine(), { note: 'Ohne' });
    chat.attach(element);
    chat.human.toggle();
    assert.deepEqual(await chat.operator.nextLine(), { note: 'This is the element I mean.', element });
    assert.equal(await chat.operator.nextLine(), '');
    chat.leave();
    chat.enter('showing');
    chat.attach(element);
    chat.detach();
    chat.human.message('Weg');
    assert.deepEqual(await chat.operator.nextLine(), { note: 'Weg' });
});

test('Demonstration: notes keep their order but create neither a step nor a checkpoint', () => {
    assert.equal(itemLabel({ action: 'note', text: 'leer lassen' }), 'Hinweis: leer lassen');
    assert.equal(itemLabel({ action: 'note', text: 'der', element: { label: 'button' } }), 'Hinweis zu button: der');
    assert.deepEqual(recordableSteps([{ action: 'note', text: 'x', path: '/a' }]), { steps: [], problems: [] });
});

test('Chat: the Claude log becomes messages and actions, the conversation itself is not duplicated', () => {
    assert.deepEqual(parseClaudeLog('[+47.0s] Suche ist da. ⏎ Ich suche.'), { kind: 'text', text: 'Suche ist da. Ich suche.' });
    assert.equal(parseClaudeLog('[+143.7s] Claude beendet nach 142 s.'), null);
    assert.deepEqual(parseClaudeLog('[+47.6s] > Bash: caw-ai fill f4 "Wege"; caw-ai press Enter'), { kind: 'activity', text: 'fill f4 "Wege"; press Enter' });
    assert.deepEqual(parseClaudeLog('[+47.6s] > Bash: caw-ai fill f4 "Wege" && caw-ai press Enter'), { kind: 'activity', text: 'fill f4 "Wege" && press Enter' });
    assert.equal(parseClaudeLog('[+1.0s] > Bash: caw-ai say "Hallo"'), null);
    // The local agent calls caw via MCP: the human reads the same command, without internal names and JSON.
    assert.deepEqual(parseClaudeLog('[+2.0s] > mcp__caw__caw: {"args":["snapshot"]}'), { kind: 'activity', text: 'snapshot' });
    assert.deepEqual(parseClaudeLog('[+2.0s] > mcp__caw__caw: {"args":["click","button \\"Senden\\""]}'), { kind: 'activity', text: 'click button "Senden"' });
    assert.deepEqual(parseClaudeLog('[+2.0s] > mcp__caw__caw: {"args":["check","S1","document.title === \'x\'"]}'), { kind: 'activity', text: 'check S1 document.title === \'x\'' });
    assert.deepEqual(parseClaudeLog('[+2.0s] > mcp__caw__caw: {"args":["fill","f4","Hans Muster"]}'), { kind: 'activity', text: 'fill f4 "Hans Muster"' });
    assert.equal(parseClaudeLog('[+2.0s] > mcp__caw__caw: {"args":["say","Alles da"]}'), null, 'say is in the chat anyway');
    assert.equal(parseClaudeLog('[+2.0s] > mcp__caw__caw: {"args":["say","Al'), null, 'no say even when truncated');
    assert.deepEqual(parseClaudeLog('[+2.0s] > mcp__caw__caw: {"args":["eval","document.querySelector(\\"#a'), { kind: 'activity', text: 'eval document.querySelector("#a…' });
    assert.deepEqual(parseClaudeLog('[+2.0s] > Read: caw/caw.md'), { kind: 'activity', text: 'Read: caw/caw.md' });
    assert.deepEqual(parseClaudeLog('[+1.0s] > Bash: grep x mein-caw.log'), { kind: 'activity', text: 'grep x mein-caw.log' }, 'only the command, not every word');
    assert.deepEqual(parseClaudeLog('[+1.0s] > Read: /a.md'),{ kind: 'activity', text: 'Read: /a.md' });
    assert.equal(parseClaudeLog('[+1.0s] > Bash: caw-ai chat'), null);
    assert.equal(parseClaudeLog('[+1.0s] > Bash: caw-ai chat; caw-ai click e1').kind, 'activity');
    assert.equal(parseClaudeLog('irgendwas'), null);
    assert.equal(parseClaudeLog('[+1.0s] '), null);
});

test('Chat: tailing delivers only complete lines, each once', () => {
    let text = '';
    const seen = [];
    const stop = tailLines(() => text, (line) => seen.push(line), 60_000);
    text = 'eins\nzw';
    stop();
    assert.deepEqual(seen, ['eins']);
    const again = [];
    const stopAgain = tailLines(() => 'a\nb\n', (line) => again.push(line), 60_000);
    stopAgain();
    stopAgain();
    assert.deepEqual(again, ['a', 'b']);
});

test('Chat: log and questions appear in the window, nothing after the end', () => {
    const shown = [];
    const chat = createChat({ show: (who, text) => shown.push([who, text]) });
    chat.logLine('[+1.0s] Ich schaue.');
    chat.logLine('[+1.2s] > Bash: caw-ai snapshot');
    chat.ask('Welcher Bereich?');
    chat.human.closed();
    chat.logLine('[+2.0s] Zu spät.');
    // Free text is a note, not a message: it goes with the actions.
    assert.deepEqual(shown, [['activity', 'Ich schaue.'], ['activity', 'snapshot'], ['question', 'Welcher Bereich?']]);
});

const VIEW = { repairing: false, notes: '', steps: [{ id: 'S1', name: 'Los', do: 'Tu es', expect: 'Da' }] };

test('Plan: a message is a change request, the button approves, and the wait lets nothing through', async () => {
    const shown = [];
    const states = [];
    const chat = createChat({ show: (who, value, about) => shown.push({ who, value, about }), status: (state) => states.push(state) });
    const first = chat.plan(VIEW);
    assert.equal(states.at(-1), 'planning');
    assert.equal(chat.canPick(), true);
    chat.human.message('Nimm den anderen Bereich');
    assert.deepEqual(await first, { approved: false, feedback: 'Nimm den anderen Bereich' });
    assert.equal(states.at(-1), 'running');
    assert.deepEqual(chat.takeUnread(), [], 'the change request already is the answer');
    const second = chat.plan(VIEW);
    chat.human.toggle();
    assert.deepEqual(await second, { approved: true });
    assert.equal(chat.paused(), false, 'approving does not pause');
    const cards = shown.filter(({ who }) => who === 'plan');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].about, VIEW, 'the card gets the structure, the log a text');
    assert.equal(cards[0].value, 'S1 Los: Da');
});

test('Plan: a picked element attaches to the change request', async () => {
    const chat = createChat();
    const pending = chat.plan(VIEW);
    const element = { label: 'combobox Bereich' };
    chat.attach(element);
    chat.human.message('Hier den Standard lassen');
    assert.deepEqual(await pending, { approved: false, feedback: 'Hier den Standard lassen', element });
});

test('Plan: closing the window or cancelling ends the wait', async () => {
    const aborted = [];
    const chat = createChat({ onAbort: () => aborted.push(true) });
    const pending = chat.plan(VIEW);
    chat.human.abort();
    assert.deepEqual(await pending, { approved: false, feedback: null });
    assert.equal(aborted.length, 1);
    const closing = createChat();
    const waiting = closing.plan(VIEW);
    closing.human.closed();
    assert.deepEqual(await waiting, { approved: false, feedback: null });
    assert.deepEqual(await closing.plan(VIEW), { approved: false, feedback: null });
});

test('Choice: only offered buttons count, and the question is in the chat', async () => {
    const shown = [];
    const states = [];
    const chat = createChat({ show: (who, value) => shown.push([who, value]), status: (state, options) => states.push([state, options]) });
    const options = [{ id: 'adopt', label: 'Testplan übernehmen' }, { id: 'discard', label: 'Verwerfen' }];
    const pending = chat.choose('deciding', 'Übernehmen?', options);
    assert.deepEqual(states.at(-1), ['deciding', options]);
    chat.human.choose('fremd');
    chat.human.toggle();
    assert.equal(states.at(-1)[0], 'deciding');
    chat.human.choose('adopt');
    assert.equal(await pending, 'adopt');
    assert.deepEqual(shown, [['question', 'Übernehmen?'], ['human', 'Testplan übernehmen']]);
    const closing = createChat();
    const waiting = closing.choose('choosing', 'Wie?', options);
    closing.human.closed();
    assert.equal(await waiting, null);
});

test('Verification run in the chat: progress only, the button does nothing', () => {
    const states = [];
    const shown = [];
    const chat = createChat({ show: (who, value) => shown.push([who, value]), status: (state) => states.push(state) });
    chat.verifying();
    assert.equal(states.at(-1), 'verifying');
    chat.human.toggle();
    assert.equal(chat.paused(), false);
    chat.progress('1/3 click weiter');
    assert.deepEqual(shown, [['activity', '1/3 click weiter']]);
});

test('Tidying by the tool: screenshots and the first of two fills on the same field', () => {
    const field = { xtype: 'textfield', label: 'A' };
    const steps = [
        { action: 'click', target: field },
        { action: 'fill', target: field, value: 'x' },
        { action: 'wait-ready' },
        { action: 'fill', target: field, value: 'y' },
        { action: 'screenshot', name: 'a.png' },
        { action: 'fill', target: { xtype: 'textfield', label: 'B' }, value: 'z' },
        { action: 'click', target: field },
        { action: 'fill', target: { xtype: 'textfield', label: 'B' }, value: 'zz' },
    ];
    assert.deepEqual(tidyNumbers(steps), [2, 5]);
    assert.deepEqual(tidyNumbers(steps, [7]), [2, 5, 6], 'what Claude drops no longer sits in between');
});

test('Preparation in the chat: progress only, then Claude works', () => {
    const states = [];
    const chat = createChat({ status: (state) => states.push(state) });
    chat.preparing();
    chat.human.toggle();
    assert.equal(chat.paused(), false);
    chat.preparing(false);
    // The ignored click gets its state back, so the page re-enables the blocked button.
    assert.deepEqual(states, ['preparing', 'preparing', 'running']);
});

test('Done after the demonstration: immediately "handing over", a second click changes nothing, a new demonstration starts clean', async () => {
    const states = [];
    const chat = createChat({ status: (state) => states.push(state) });
    chat.enter('showing');
    chat.human.toggle();
    assert.equal(await chat.operator.nextLine(), '');
    assert.equal(states.at(-1), 'handing');
    chat.human.toggle();
    assert.equal(states.at(-1), 'handing', 'second click: no pause, no second handover');
    assert.equal(chat.paused(), false);
    chat.enter('showing');
    assert.equal(states.at(-1), 'showing', 'nothing demonstrated: it starts over');
    chat.human.closed();
    assert.equal(chat.available(), false);
});

test('Discussing a failure: a message or a button answers, a card interrupts, then the conversation is open again', async () => {
    const shown = [];
    const states = [];
    const chat = createChat({ show: (who, value) => shown.push([who, value]), status: (state) => states.push(state) });
    const options = [{ id: 'fix', label: 'Schritt beheben' }, { id: 'close', label: 'Schließen' }];
    chat.testing();
    assert.equal(states.at(-1), 'testing');
    const first = chat.discuss('S2 ist gescheitert.', options);
    assert.equal(states.at(-1), 'discussing');
    chat.human.message('Warum?');
    assert.deepEqual(await first, { message: 'Warum?' });
    assert.deepEqual(chat.takeUnread(), [], 'the message already is the answer');
    const second = chat.discuss(undefined, options);
    const card = chat.advice({ side: 'test', title: 'Warten' }, [{ id: 'accept', label: 'Übernehmen' }]);
    assert.equal(states.at(-1), 'reviewing');
    chat.human.choose('accept');
    assert.equal(await card, 'accept');
    assert.equal(states.at(-1), 'discussing', 'after the card the conversation continues');
    chat.human.choose('fix');
    assert.deepEqual(await second, { choice: 'fix' });
    assert.deepEqual(shown.filter(([who]) => who === 'question'), [['question', 'S2 ist gescheitert.']]);
    const closing = createChat();
    const waiting = closing.discuss('Und?', options);
    closing.human.closed();
    assert.equal(await waiting, null);
});

test('remember: a remembered value containing the run tag becomes the placeholder, not just the tag inside it', async () => {
    const recorder = createRecorder({
        handler: async (command) => (command.action === 'remember' ? { name: 'nr', value: 'Vorgang CAW-7' } : { pass: true }),
        session: { page: () => rememberPage },
        base: 'https://p.example',
        runTag: 'CAW-7',
    });
    await recorder.handler({ action: 'fill', target: 'e1', value: 'Vorgang CAW-7' });
    await recorder.handler({ action: 'remember', name: 'nr', code: 'lies()' });
    await recorder.handler({ action: 'check', id: 'S1', code: "x === 'Vorgang CAW-7'" });
    assert.equal(recorder.steps[0].value, 'Vorgang {{runTag}}', 'before remembering only the tag applies');
    assert.equal(recorder.steps[2].code, "x === '{{nr}}'");
});

test('Recording: the last demonstration stays reusable for a day; empty and foreign ones do not count', async (t) => {
    const { lastDemonstration } = await import('../src/host/commands.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-reuse-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (name, items) => {
        mkdirSync(join(root, '.caw/runs', name), { recursive: true });
        if (items !== undefined) writeFileSync(join(root, '.caw/runs', name, 'vorfuehrung.json'), JSON.stringify(items));
    };
    assert.equal(lastDemonstration(root, 'x'), null);
    put('2026-11-08T12-26-03-652Z-x-vorfuehrung', [{ action: 'click' }]);
    put('2026-11-08T12-35-34-782Z-x-vorfuehrung', [{ action: 'note', text: 'warm' }, { action: 'click' }]);
    put('2026-11-08T12-40-00-000Z-x-vorfuehrung');
    put('2026-11-08T12-45-00-000Z-y-vorfuehrung', [{ action: 'click' }]);
    const now = Date.parse('2026-11-08T13:00:00Z');
    const last = lastDemonstration(root, 'x', now);
    assert.equal(last.items.length, 2);
    assert.equal(last.at, Date.parse('2026-11-08T12:35:34.782Z'));
    assert.match(last.dir, /12-35-34-782Z-x-vorfuehrung$/);
    assert.equal(lastDemonstration(root, 'x', now + 2 * 24 * 3600 * 1000), null, 'not after a day');
});

test('Demonstration: application failures appear in place, the human sees them at once, evidence is in the folder', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-fail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const failures = [{ type: 'pageerror', text: 'alt' }];
    const page = { url: () => 'https://p.example/a', screenshot: async () => Buffer.from('png') };
    const context = { exposeBinding: async () => {}, addInitScript: async () => {}, pages: () => [], on: () => {} };
    const told = [];
    const lines = [
        async () => {
            failures.push({ type: 'http', text: 'HTTP 500', url: 'https://p.example/abschliessen' });
            await new Promise((ok) => { setTimeout(ok, 30); });
            return { note: 'Abschließen geht nicht' };
        },
        async () => '',
    ];
    const items = await demonstrate({
        session: { context, ownsPage: () => true, page: () => page, closed: new Promise(() => {}), failures: () => failures, network: { mark: () => 3, since: (mark) => [{ name: `POST /abschliessen ab ${mark}` }] } },
        ui: { step: () => {} },
        dir,
        pollMs: 5,
        onFailure: (item) => told.push(itemLabel(item)),
        operator: { nextLine: () => lines.shift()() },
    });
    assert.deepEqual(items.map(({ action }) => action), ['failure', 'note']);
    assert.deepEqual(told, ['Fehler der Anwendung, http: HTTP 500 (https://p.example/abschliessen)']);
    assert.deepEqual(recordableSteps(items).steps, []);
    const { readFileSync } = await import('node:fs');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fehler.json'), 'utf8')).map(({ text }) => text), ['HTTP 500'], 'only failures of this demonstration');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'netzwerk.json'), 'utf8')), [{ name: 'POST /abschliessen ab 3' }]);
});
