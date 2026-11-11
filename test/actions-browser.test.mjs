// upload, download und die Zwischenablage gegen echtes Chrome (headless). Ohne Chrome uebersprungen.
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
    // Eine Seite mit echtem Origin: Die Zwischenablage gibt es nur in einem sicheren Kontext.
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
    // Grosszuegig: Auf langsamen CI-Rechnern unter Windows braucht der erste Klick mit Dateiauswahl mehrere Sekunden.
    stepTimeoutMs: 10000,
    filesDir: dir,
});

test('upload: Ein verstecktes Dateifeld hinter einem Knopf bekommt die Datei über die Dateiauswahl', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
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

test('upload: Ein sichtbares Dateifeld bekommt die Datei direkt', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent('<label>Datei <input type="file" id="f"></label>');
    const { broken } = await play([
        { action: 'upload', target: { role: 'textbox', name: 'Datei' }, files: ['fixtures/brief.pdf'] },
        { action: 'check', id: 'S1', code: "document.getElementById('f').files.length === 1" },
    ]);
    assert.equal(broken, null);
    return undefined;
});

test('download: Der Klick lädt eine Datei mit passendem Namen, ein falscher Name lässt den Schritt scheitern', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent('<a href="data:text/plain,Inhalt" download="akte-7.txt">Exportieren</a>');
    const target = { role: 'link', name: 'Exportieren' };
    assert.equal((await play([{ action: 'download', target, file: '^akte-\\d+\\.txt$' }])).broken, null);
    const wrong = await play([{ action: 'download', target, file: '\\.zip$' }]);
    assert.equal(wrong.broken.kind, 'check');
    assert.match(wrong.broken.message, /akte-7\.txt/);
    return undefined;
});

test('Zwischenablage: Mit dem Recht für den Origin liest eine Prüfung, was die Seite kopiert hat', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await grantClipboard(context, `${ORIGIN}/start`);
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(() => navigator.clipboard.writeText('Prüfsumme 3fa9'));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Prüfsumme 3fa9');
    return undefined;
});

// Wie „Abbrechen“ mit Rueckfrage: Der erste Klick oeffnet einen modalen Dialog ueber dem Knopf.
const CANCEL = `<button onclick="document.getElementById('d').showModal()">Abbrechen</button>
<dialog id="d" aria-label="Antrag abbrechen?"><p>Wirklich abbrechen?</p><button>Ja</button><button>Nein</button></dialog>`;

test('click: Ein wiederholter Klick, dessen Ziel der Dialog des ersten verdeckt, wird übersprungen statt bis zum Zeitlimit zu warten', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
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
    assert.ok(Date.now() - start < 8000, `nicht bis zum Zeitlimit: ${Date.now() - start} ms`);
    return undefined;
});

test('click: Ein verdecktes Ziel ohne gleichen Klick davor bleibt ein Fehler', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
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

test('click optional: Fehlt das Ziel (Cookie-Banner schon weg), fällt der Klick nach kurzer Zeit weg; ist es da, wird geklickt', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    const banner = { action: 'click', target: { role: 'button', name: 'Alle akzeptieren' }, optional: true };
    await page.setContent('<button onclick="this.textContent=\'Weiter!\'">Weiter</button>');
    const start = Date.now();
    const absent = await play([banner, { action: 'click', target: { role: 'button', name: 'Weiter' } }, { action: 'check', id: 'S1', code: "document.querySelector('button').textContent === 'Weiter!'" }]);
    assert.equal(absent.broken, null);
    assert.equal(absent.results.get('S1').status, 'pass');
    assert.match(absent.results.get('S1').note, /Optionalen Klick übersprungen/);
    assert.ok(Date.now() - start < 8000, `nicht bis zum Zeitlimit: ${Date.now() - start} ms`);

    await page.setContent('<div id="b"><button onclick="document.getElementById(\'b\').remove()">Alle akzeptieren</button></div>');
    const shown = await play([banner, { action: 'check', id: 'S1', code: "document.getElementById('b') === null" }]);
    assert.equal(shown.broken, null);
    assert.equal(shown.results.get('S1').status, 'pass');
    assert.doesNotMatch(shown.results.get('S1').note ?? '', /übersprungen/);
    return undefined;
});
