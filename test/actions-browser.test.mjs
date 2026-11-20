// The kept layers of replay against real Chrome (headless), with native locators: fill on a select, upload, download, the
// clipboard, a repeated click under the dialog of the first, an optional click. Skipped without Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createAgentHandler, fillField } from '../src/host/agent-commands.mjs';
import { grantClipboard } from '../src/host/browser-session.mjs';
import { playReplay } from '../src/host/replay.mjs';
import { launchChrome } from './chrome.mjs';

const ORIGIN = 'https://caw.test';
let browser = null;
let context = null;
let page = null;
let dir = null;
before(async () => {
    browser = await launchChrome();
    context = await browser?.newContext({ acceptDownloads: true });
    page = await context?.newPage();
    // A page with a real origin: the clipboard only exists in a secure context.
    await page?.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>caw</title>' }));
    dir = mkdtempSync(join(tmpdir(), 'caw-actions-'));
    mkdirSync(join(dir, 'fixtures'));
    writeFileSync(join(dir, 'fixtures', 'brief.pdf'), '%PDF-1.4');
});
after(async () => {
    await browser?.close();
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
});
const needsChrome = () => browser === null;

const play = (steps) => playReplay({
    replay: { steps },
    handler: async (command) => {
        if (command.action !== 'check') return 'ok';
        const value = await page.evaluate(command.code);
        return { pass: value === true, value };
    },
    session: { page: () => page, waitReady: async () => ({ settled: true }) },
    base: ORIGIN,
    // Generous: on slow Windows CI machines the first click with a file chooser takes several seconds.
    stepTimeoutMs: 10000,
    filesDir: dir,
});

test('fill on a select picks the option by value, otherwise by label, in recording and replay', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    await page.setContent('<label>Tag <select id="tag"><option value="">-</option><option value="work">#work</option><option value="home">#home</option></select></label>'
        + '<select id="when"><option>Today</option><option>Tomorrow</option></select><input id="title">');
    await fillField(page.locator('#tag'), 'home', { timeout: 5000 });
    await fillField(page.locator('#when'), 'Tomorrow', { timeout: 5000 });
    await fillField(page.locator('#title'), 'Milk', { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => ['#tag', '#when', '#title'].map((id) => document.querySelector(id).value)), ['home', 'Tomorrow', 'Milk']);

    await page.evaluate(() => { document.querySelector('#tag').value = ''; });
    const { broken } = await play([{ action: 'fill', target: "getByRole('combobox', { name: 'Tag', exact: true })", value: '#work' }]);
    assert.equal(broken, null);
    assert.equal(await page.evaluate(() => document.querySelector('#tag').value), 'work');
    return undefined;
});

test('a field that unlocks the next one only when it is left: replay leaves it, as the pointer going down beside it would', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    // Like an ExtJS combobox: the area is taken on blur, then the sub-area unlocks. An open list must stay open while typing.
    await page.setContent('<label>Bereich <input id="area" onfocus="document.getElementById(\'list\').hidden = false" onblur="if (this.value === \'Sonstiges\') document.getElementById(\'sub\').disabled = false; document.getElementById(\'list\').hidden = true"></label>'
        + '<ul id="list" hidden><li onmousedown="event.preventDefault(); document.getElementById(\'area\').value = \'Sonstiges\'">Sonstiges</li></ul>'
        + '<label>Unterbereich <input id="sub" disabled></label>');
    const { broken } = await play([
        { action: 'fill', target: "getByRole('textbox', { name: 'Bereich', exact: true })", value: 'Sonstiges' },
        { action: 'fill', target: "getByRole('textbox', { name: 'Unterbereich', exact: true })", value: 'Allgemein' },
    ]);
    assert.equal(broken, null);
    assert.equal(await page.locator('#sub').inputValue(), 'Allgemein');
    // The open list lies over the disabled target, as ExtJS's boundlist does: the target is never reachable before leaving.
    await page.setContent('<label>Bereich <input id="area" onfocus="document.getElementById(\'list\').hidden = false" onblur="if (this.value === \'Sonstiges\') document.getElementById(\'sub\').disabled = false; document.getElementById(\'list\').hidden = true"></label>'
        + '<ul id="list" hidden style="position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; margin: 0; background: white"><li>Sonstiges</li></ul>'
        + '<label>Unterbereich <input id="sub" disabled></label>');
    const covered = await play([
        { action: 'fill', target: "getByRole('textbox', { name: 'Bereich', exact: true })", value: 'Sonstiges' },
        { action: 'fill', target: "getByRole('textbox', { name: 'Unterbereich', exact: true })", value: 'Allgemein' },
    ]);
    assert.equal(covered.broken, null);
    assert.equal(await page.locator('#sub').inputValue(), 'Allgemein');
    // Filter typed, entry clicked in the open list: the target is enabled, so nothing leaves the field before the click.
    await page.setContent('<label>Bereich <input id="area" onfocus="document.getElementById(\'list\').hidden = false" onblur="document.getElementById(\'list\').hidden = true"></label>'
        + '<ul id="list" hidden><li onmousedown="event.preventDefault(); document.getElementById(\'area\').value = \'Sonstiges\'">Sonstiges</li></ul>');
    const typed = await play([
        { action: 'fill', target: "getByRole('textbox', { name: 'Bereich', exact: true })", value: 'Sons' },
        { action: 'click', target: "getByRole('listitem').filter({ hasText: /^Sonstiges$/ })" },
    ]);
    // Fails only now and then on Windows CI (click timeout on the list entry): say what the page looked like then.
    const seen = typed.broken === null ? '' : JSON.stringify(await page.evaluate(() => ({ focused: document.activeElement?.id ?? null, listHidden: document.getElementById('list').hidden, area: document.getElementById('area').value, focus: document.hasFocus() })));
    assert.equal(typed.broken, null, `${typed.broken?.message ?? ''} ${seen}`);
    assert.equal(await page.locator('#area').inputValue(), 'Sonstiges');
    return undefined;
});

test('dblclick: a row that opens only on double-click opens on replay; the agent command does the same', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    await page.setContent('<div role="grid"><div role="row" ondblclick="document.title = \'geöffnet \' + (Number(document.title.split(\' \')[1] ?? 0) + 1)"><span role="gridcell">1000001</span></div></div>');
    const { broken } = await play([{ action: 'dblclick', target: "getByRole('row').filter({ hasText: '1000001' })" }]);
    assert.equal(broken, null);
    assert.equal(await page.title(), 'geöffnet 1', 'one double-click, not two');
    const handler = createAgentHandler({ session: { page: () => page }, run: {}, hosts: [], agentDir: dir });
    assert.equal(await handler({ action: 'dblclick', target: "getByRole('row').filter({ hasText: '1000001' })" }), 'ok');
    assert.equal(await page.title(), 'geöffnet 2');
    return undefined;
});

test('upload, Claude: only files from caw/fixtures, through the button\'s file chooser; anything else is refused with what is there', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    await page.setContent('<button onclick="document.getElementById(\'f\').click()">Dateien wählen</button><input type="file" id="f" hidden>');
    const handler = createAgentHandler({ session: { page: () => page }, run: {}, hosts: [], agentDir: dir, filesDir: dir });
    const target = "getByRole('button', { name: 'Dateien wählen', exact: true })";
    assert.deepEqual(await handler({ action: 'upload', target, files: ['fixtures/brief.pdf'] }), { files: ['fixtures/brief.pdf'] });
    assert.equal(await page.evaluate(() => document.getElementById('f').files[0]?.name), 'brief.pdf');
    await assert.rejects(handler({ action: 'upload', target, files: ['../../etc/passwd'] }), /nur Dateien aus caw\/fixtures.*In caw\/fixtures: fixtures\/brief\.pdf/);
    await assert.rejects(handler({ action: 'upload', target, files: [] }), /nur Dateien aus caw\/fixtures/);
    return undefined;
});

test('upload: a hidden file input behind a button gets the file via the file chooser', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    await page.setContent('<button onclick="document.getElementById(\'f\').click()">Dateien wählen</button><input type="file" id="f" hidden>');
    const { broken, results } = await play([
        { action: 'upload', target: "getByRole('button', { name: 'Dateien wählen', exact: true })", files: ['fixtures/brief.pdf'] },
        { action: 'check', id: 'S1', code: "document.getElementById('f').files[0]?.name === 'brief.pdf'" },
    ]);
    assert.equal(broken, null);
    assert.equal(results.get('S1').status, 'pass');
    return undefined;
});

test('upload: a visible file input gets the file directly', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent('<label>Datei <input type="file" id="f"></label>');
    const { broken } = await play([
        { action: 'upload', target: "getByLabel('Datei')", files: ['fixtures/brief.pdf'] },
        { action: 'check', id: 'S1', code: "document.getElementById('f').files.length === 1" },
    ]);
    assert.equal(broken, null);
    return undefined;
});

test('download: the click downloads a file with a matching name; a wrong name fails the step', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent('<a href="data:text/plain,Inhalt" download="akte-7.txt">Exportieren</a>');
    const target = "getByRole('link', { name: 'Exportieren', exact: true })";
    assert.equal((await play([{ action: 'download', target, file: '^akte-\\d+\\.txt$' }])).broken, null);
    const wrong = await play([{ action: 'download', target, file: '\\.zip$' }]);
    assert.equal(wrong.broken.kind, 'check');
    assert.match(wrong.broken.message, /akte-7\.txt/);
    return undefined;
});

test('Clipboard: a check reads what the page copied; the page itself may read only while a check runs', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await grantClipboard(context, `${ORIGIN}/start`);
    await page.goto(`${ORIGIN}/`);
    await page.evaluate("navigator.clipboard.writeText('Prüfsumme 3fa9')");
    const handler = createAgentHandler({ session: { page: () => page }, run: { expectations: [{ id: 'S1' }] }, hosts: [], agentDir: dir });
    const checked = await handler({ action: 'check', id: 'S1', code: "navigator.clipboard.readText().then((text) => text === 'Prüfsumme 3fa9')" });
    assert.equal(checked.pass, true, 'the check reads the clipboard');
    const outside = await page.evaluate('navigator.clipboard.readText().then(() => "read", (error) => error.name)');
    assert.notEqual(outside, 'read', 'outside a check the page cannot read the clipboard');
    return undefined;
});

// Like "Abbrechen" with a confirmation: the first click opens a modal dialog over the button.
const CANCEL = `<button onclick="document.getElementById('d').showModal()">Abbrechen</button>
<dialog id="d" aria-label="Antrag abbrechen?"><p>Wirklich abbrechen?</p><button>Ja</button><button>Nein</button></dialog>`;

test('click: a repeated click whose target is covered by the dialog of the first is skipped instead of waiting for the timeout', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(CANCEL);
    const target = "getByRole('button', { name: 'Abbrechen', exact: true })";
    const start = Date.now();
    const { broken, results } = await play([
        { action: 'click', target },
        { action: 'click', target },
        { action: 'check', id: 'S4', code: "document.getElementById('d').open === true" },
    ]);
    assert.equal(broken, null);
    assert.equal(results.get('S4').status, 'pass');
    assert.match(results.get('S4').note, /Wiederholten Klick übersprungen/);
    assert.ok(Date.now() - start < 8000, `not until the timeout: ${Date.now() - start} ms`);
    return undefined;
});

test('click: a covered target without the same click before stays an error', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`${CANCEL}<button>Speichern</button>`);
    const { broken } = await playReplay({
        replay: { steps: [
            { action: 'click', target: "getByRole('button', { name: 'Abbrechen', exact: true })" },
            { action: 'click', target: "getByRole('button', { name: 'Speichern', exact: true })" },
            { action: 'check', id: 'S4', code: 'true' },
        ] },
        handler: async () => ({ pass: true, value: true }),
        session: { page: () => page, waitReady: async () => ({ settled: true }) },
        base: ORIGIN,
        stepTimeoutMs: 2500,
    });
    assert.notEqual(broken, null);
    assert.equal(broken.kind, 'target');
    return undefined;
});

test('click optional: if the target is missing (cookie banner already gone), the click is dropped after a short time; if present, it is clicked', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const banner = { action: 'click', target: "getByRole('button', { name: 'Alle akzeptieren', exact: true })", optional: true };
    await page.setContent('<button onclick="this.textContent=\'Weiter!\'">Weiter</button>');
    const start = Date.now();
    const absent = await play([banner, { action: 'click', target: "getByRole('button', { name: 'Weiter', exact: true })" }, { action: 'check', id: 'S1', code: "document.querySelector('button').textContent === 'Weiter!'" }]);
    assert.equal(absent.broken, null);
    assert.equal(absent.results.get('S1').status, 'pass');
    assert.match(absent.results.get('S1').note, /Optionalen Klick übersprungen/);
    assert.ok(Date.now() - start < 8000, `not until the timeout: ${Date.now() - start} ms`);

    await page.setContent('<div id="b"><button onclick="document.getElementById(\'b\').remove()">Alle akzeptieren</button></div>');
    const shown = await play([banner, { action: 'check', id: 'S1', code: "document.getElementById('b') === null" }]);
    assert.equal(shown.broken, null);
    assert.equal(shown.results.get('S1').status, 'pass');
    assert.doesNotMatch(shown.results.get('S1').note ?? '', /übersprungen/);
    return undefined;
});
