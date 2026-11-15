// Native dialogs, hover and drag in real Chrome (headless): Claude arms a dialog and the recording keeps the decision on the
// opener; an unarmed dialog is dismissed and reported to Claude; the demonstration asks the human; hover and dragTo record and
// act. Skipped without Chrome.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createAgentHandler } from '../src/host/agent-commands.mjs';
import { demonstrate, recordableSteps } from '../src/host/demonstrate.mjs';
import { createDialogs } from '../src/host/dialogs.mjs';
import { createRecorder } from '../src/host/replay.mjs';
import { launchChrome } from './chrome.mjs';

const ORIGIN = 'https://caw.test';
const PAGE = `<!doctype html><title>Dialogs</title><p id="status"></p>
<button onclick="document.getElementById('status').textContent = confirm('Delete order 4711?') ? 'Deleted' : 'Kept'">Delete</button>
<button onclick="const v = prompt('New title', 'Ticket'); document.getElementById('status').textContent = v === null ? 'none' : 'Renamed ' + v">Rename</button>
<div id="menu" onmouseenter="document.getElementById('list').hidden = false"><button>Actions</button><div id="list" hidden><button onclick="document.getElementById('status').textContent = 'Archived'">Archive</button></div></div>
<ul aria-label="To do"><li id="card" draggable="true" ondragstart="event.dataTransfer.setData('text/plain', 'card')">Card 1</li></ul>
<ul aria-label="Done" style="min-height:40px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.append(document.getElementById('card')); document.getElementById('status').textContent = 'Moved'"></ul>`;

let browser = null;
let page = null;
let dir = null;
const dialogs = createDialogs();
before(async () => {
    browser = await launchChrome();
    const context = await browser?.newContext();
    page = await context?.newPage();
    page?.on('dialog', dialogs.handle);
    await page?.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    dir = mkdtempSync(join(tmpdir(), 'caw-dialogs-'));
});
after(async () => {
    await browser?.close();
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
});
const needsChrome = () => browser === null;
const status = () => page.locator('#status').textContent();
const session = () => ({ page: () => page, dialogs, browser: { locale: 'en-US' }, secrets: () => [] });
const recorderOf = () => {
    const handler = createAgentHandler({ session: session(), run: { expectations: [] }, hosts: ['caw.test'], agentDir: dir, onVerdict: () => {} });
    return createRecorder({ handler, session: session(), base: ORIGIN, runTag: 'CAW-1234' });
};
const button = (name) => `getByRole('button', { name: '${name}', exact: true })`;

test('Claude: an unarmed confirm is dismissed and reported; armed, the decision is recorded on the click, a prompt value with the run tag', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    const recorder = recorderOf();
    const unarmed = await recorder.handler({ action: 'click', target: button('Delete') });
    assert.deepEqual(unarmed, { result: 'ok', dialog: { type: 'confirm', message: 'Delete order 4711?', decision: 'dismissed' } });
    assert.equal(await status(), 'Kept');
    assert.equal(await recorder.handler({ action: 'dialog', decision: 'accept' }), 'armed');
    const armed = await recorder.handler({ action: 'click', target: button('Delete') });
    assert.equal(armed.dialog.decision, 'accepted');
    assert.equal(await status(), 'Deleted');
    await recorder.handler({ action: 'dialog', decision: 'accept', value: 'Note CAW-1234' });
    await recorder.handler({ action: 'click', target: button('Rename') });
    assert.equal(await status(), 'Renamed Note CAW-1234');
    assert.deepEqual(recorder.steps.map(({ action, dialog }) => [action, dialog]), [
        ['click', undefined],
        ['click', { type: 'confirm', accept: true, message: 'Delete order ####?' }],
        ['click', { type: 'prompt', accept: true, value: 'Note {{runTag}}', message: 'New title' }],
    ]);
});

test('Claude: hover opens a menu, dragTo moves a card; both are recorded with locators', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    const recorder = recorderOf();
    await recorder.handler({ action: 'hover', target: button('Actions') });
    await recorder.handler({ action: 'click', target: button('Archive') });
    assert.equal(await status(), 'Archived');
    await recorder.handler({ action: 'dragTo', target: "getByText('Card 1', { exact: true })", to: "getByRole('list', { name: 'Done', exact: true })" });
    assert.equal(await status(), 'Moved');
    const [hover, , drag] = recorder.steps;
    assert.deepEqual([hover.action, hover.target], ['hover', button('Actions')]);
    assert.equal(drag.action, 'dragTo');
    assert.match(drag.to, /Done/);
});

test('demonstration: the app\'s confirm asks the human; the answer is applied and goes on the click that opened it', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    const asked = [];
    let done;
    const ended = new Promise((resolve) => { done = resolve; });
    const operator = { nextLine: () => ended };
    const shown = demonstrate({
        session: { ...session(), context: page.context(), ownsPage: (candidate) => candidate === page, closed: new Promise(() => {}) },
        operator,
        ui: { step: () => {} },
        dir,
        onDialog: async (info) => {
            asked.push(`${info.type}: ${info.message}`);
            return { accept: true };
        },
    });
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForTimeout(800);
    done('');
    const items = await shown;
    assert.deepEqual(asked, ['confirm: Delete order 4711?']);
    assert.equal(await status(), 'Deleted');
    const { steps } = recordableSteps(items);
    assert.deepEqual(steps.find(({ action }) => action === 'click')?.dialog, { type: 'confirm', accept: true, message: 'Delete order ####?' });
});
