// upload, download and the clipboard against real Chrome (headless). Skipped without Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { grantClipboard } from '../src/host/browser-session.mjs';
import { playReplay } from '../src/host/replay.mjs';

const ORIGIN = 'https://caw.test';
let browser = null;
let context = null;
let page = null;
let dir = null;
before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
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

test('upload: a hidden file input behind a button gets the file via the file chooser', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/`);
    await page.setContent('<button onclick="document.getElementById(\'f\').click()">Dateien wählen</button><input type="file" id="f" hidden>');
    const { broken, results } = await play([
        { action: 'upload', target: { role: 'button', name: 'Dateien wählen' }, files: ['fixtures/brief.pdf'] },
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
        { action: 'upload', target: { role: 'textbox', name: 'Datei' }, files: ['fixtures/brief.pdf'] },
        { action: 'check', id: 'S1', code: "document.getElementById('f').files.length === 1" },
    ]);
    assert.equal(broken, null);
    return undefined;
});

test('download: the click downloads a file with a matching name; a wrong name fails the step', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent('<a href="data:text/plain,Inhalt" download="akte-7.txt">Exportieren</a>');
    const target = { role: 'link', name: 'Exportieren' };
    assert.equal((await play([{ action: 'download', target, file: '^akte-\\d+\\.txt$' }])).broken, null);
    const wrong = await play([{ action: 'download', target, file: '\\.zip$' }]);
    assert.equal(wrong.broken.kind, 'check');
    assert.match(wrong.broken.message, /akte-7\.txt/);
    return undefined;
});

test('Clipboard: with the permission for the origin a check reads what the page copied', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await grantClipboard(context, `${ORIGIN}/start`);
    await page.goto(`${ORIGIN}/`);
    await page.evaluate("navigator.clipboard.writeText('Prüfsumme 3fa9')");
    assert.equal(await page.evaluate('navigator.clipboard.readText()'), 'Prüfsumme 3fa9');
    return undefined;
});

// Like "Abbrechen" with a confirmation: the first click opens a modal dialog over the button.
const CANCEL = `<button onclick="document.getElementById('d').showModal()">Abbrechen</button>
<dialog id="d" aria-label="Antrag abbrechen?"><p>Wirklich abbrechen?</p><button>Ja</button><button>Nein</button></dialog>`;

test('click: a repeated click whose target is covered by the dialog of the first is skipped instead of waiting for the timeout', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(CANCEL);
    const target = { role: 'button', name: 'Abbrechen' };
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
            { action: 'click', target: { role: 'button', name: 'Abbrechen' } },
            { action: 'click', target: { role: 'button', name: 'Speichern' } },
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
    const banner = { action: 'click', target: { role: 'button', name: 'Alle akzeptieren' }, optional: true };
    await page.setContent('<button onclick="this.textContent=\'Weiter!\'">Weiter</button>');
    const start = Date.now();
    const absent = await play([banner, { action: 'click', target: { role: 'button', name: 'Weiter' } }, { action: 'check', id: 'S1', code: "document.querySelector('button').textContent === 'Weiter!'" }]);
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
