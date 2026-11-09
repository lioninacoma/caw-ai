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
