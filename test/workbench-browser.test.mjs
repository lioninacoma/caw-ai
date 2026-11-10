// Werkbank und Chat in echtem Chrome: Nur der Chat spricht als Mensch, die Anwendung darf das oberste Fenster selbst navigieren, ein
// Neuladen durch den Menschen bricht den Test ab. Ohne Chrome uebersprungen.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { openChat } from '../src/host/chat.mjs';
import { WORKBENCH_MARK_SCRIPT, interceptDocuments } from '../src/host/app-view.mjs';
import { withoutIntegrity } from '../src/host/local-build.mjs';
import { CHAT_FRAME, openWorkbench } from '../src/host/workbench.mjs';

let browser = null;
let server = null;
let base = '';
const dir = mkdtempSync(join(tmpdir(), 'caw-bench-'));

before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
    server = createServer((request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(`<h1>App ${request.url}</h1><button id="go">Weiter</button>`);
    });
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await browser?.close();
    server?.close();
    rmSync(dir, { recursive: true, force: true });
});

const until = async (check, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise((ok) => { setTimeout(ok, 50); });
    }
    return false;
};

const open = async (t) => {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.newPage();
    await context.pages()[0].addInitScript({ content: WORKBENCH_MARK_SCRIPT });
    const bench = await openWorkbench(context, { appUrl: `${base}/start`, hosts: ['127.0.0.1'] });
    let aborts = 0;
    const waiting = [];
    const chat = await openChat({ session: { workbench: bench }, logPath: join(dir, `chat-${Date.now()}.log`), onAbort: () => { aborts += 1; }, onWaiting: (line) => waiting.push(line) });
    return { context, bench, chat, aborts: () => aborts, waiting };
};

const pause = (ms) => new Promise((ok) => { setTimeout(ok, ms); });

test('Werkbank: Nur der eigene Chat spricht als Mensch, ein nachgebautes iframe namens caw-chat nicht', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, aborts } = await open(t);
    const chat = bench.chatFrame();
    assert.equal(chat.name(), CHAT_FRAME);
    // Die Anwendung teilt den Origin mit der Werkbank: Sie ersetzt den Chat durch ein eigenes iframe gleichen Namens.
    await bench.view.frame.evaluate((name) => {
        top.document.getElementById('chat').remove();
        const fake = top.document.createElement('iframe');
        fake.name = name;
        fake.srcdoc = '<script>window.__cawChat({ type: "abort" })</script>';
        top.document.body.append(fake);
    }, CHAT_FRAME);
    await new Promise((ok) => { setTimeout(ok, 800); });
    assert.equal(aborts(), 0, 'der Nachbau bricht nichts ab');
    assert.equal(bench.chatFrame(), chat, 'der Host sucht den Chat nicht über den Namen');
});

test('Werkbank: Lädt die Anwendung das echte Chat-iframe neu, spricht die neue Seite nicht als Mensch', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, aborts } = await open(t);
    const chat = bench.chatFrame();
    // Derselbe Frame, dasselbe Binding, aber nicht die Seite, die der Host geschrieben hat.
    await bench.view.frame.evaluate(() => {
        top.document.getElementById('chat').srcdoc = '<script>window.__cawChat({ type: "abort" }); window.__cawChat({ type: "abort", nonce: null })</script>';
    });
    await new Promise((ok) => { setTimeout(ok, 800); });
    assert.equal(bench.chatFrame(), chat, 'derselbe Frame');
    assert.equal(aborts(), 0, 'die nachgeladene Seite bricht nichts ab');
});

test('Werkbank: Der echte Chat spricht weiter als Mensch', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, aborts } = await open(t);
    await bench.chatFrame().evaluate(() => document.getElementById('abort').click());
    await bench.chatFrame().evaluate(() => document.getElementById('abort').click()).catch(() => {});
    assert.ok(await until(() => aborts() >= 1), 'Abbrechen im echten Chat kommt an');
});

test('Werkbank: Navigiert die Anwendung das oberste Fenster selbst, läuft der Test weiter; F5 des Menschen bricht ab', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, aborts } = await open(t);
    const page = bench.page;
    const before = bench.chatFrame();
    await bench.view.frame.evaluate((url) => { top.location.href = url; }, `${base}/weiter`);
    assert.ok(await until(async () => bench.chatFrame() !== before && (await page.evaluate(() => window.workbench !== undefined).catch(() => false))), 'neue Werkbank');
    // Der Chat ist wieder da und wieder der echte.
    assert.ok(await until(async () => (await bench.chatFrame().evaluate(() => typeof window.setStatus === 'function').catch(() => false))));
    assert.equal(bench.chatFrame().name(), CHAT_FRAME);
    await new Promise((ok) => { setTimeout(ok, 500); });
    assert.equal(aborts(), 0, 'eine Navigation der Anwendung ist ihr Verhalten');

    await page.reload();
    assert.ok(await until(() => aborts() === 1), 'F5 des Menschen macht den laufenden Test ungültig');
});

test('Werkbank: Popups der Anwendung sind nicht die Werkbank, die Werkbank selbst schon', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench } = await open(t);
    assert.equal(await bench.page.evaluate(() => window.__cawWorkbench === true), true);
    assert.equal(await bench.view.frame.evaluate(() => window.__cawWorkbench === true), false);
    const [popup] = await Promise.all([bench.page.context().waitForEvent('page'), bench.view.frame.evaluate((url) => { window.open(url, '_blank'); }, `${base}/popup`)]);
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(await popup.evaluate(() => window.__cawWorkbench === true), false, 'dort führt der Mensch auch vor');
});

test('Lokaler Code: Auch Popups und neue Tabs der Anwendung bekommen ihr HTML ohne Subresource Integrity', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const sri = createServer((request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.setHeader('content-encoding', 'gzip');
        response.end(gzipSync('<h1 id="x">OK</h1><script integrity="sha384-alt" src="/a.js"></script>'));
    });
    await new Promise((ok) => { sri.listen(0, '127.0.0.1', ok); });
    t.after(() => sri.close());
    const url = `http://127.0.0.1:${sri.address().port}/`;
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await interceptDocuments(context, page, ['127.0.0.1'], { request: context.request, rewrite: withoutIntegrity });
    await page.goto(url);
    const integrity = (target) => target.evaluate(() => document.querySelector('script')?.getAttribute('integrity') ?? null);
    assert.equal(await integrity(page), null, 'die eigene Seite');
    const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate((address) => { window.open(address); }, url)]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator('#x').textContent(), 'OK', 'entpackt und lesbar');
    assert.equal(await integrity(popup), null, 'das Popup');
    const tab = await context.newPage();
    await tab.goto(url);
    assert.equal(await integrity(tab), null, 'ein neuer Tab');
});

test('Chat: Esc leert erst das Feld, dann fragt es den Abbruch nur an, erst ein zweites Esc bricht ab', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, aborts } = await open(t);
    const frame = bench.chatFrame();
    await frame.fill('#input', 'halb getippt');
    await frame.focus('#input');
    await bench.page.keyboard.press('Escape');
    assert.equal(await frame.inputValue('#input'), '', 'das Feld ist leer');
    assert.equal(await frame.evaluate(() => document.getElementById('abort').classList.contains('sure')), false, 'nichts angefragt');
    await bench.page.keyboard.press('Escape');
    assert.match(await frame.textContent('#abort'), /Wirklich abbrechen\? \(Esc\)/);
    assert.equal(await frame.isVisible('#abortNo'), true, 'mit „Nein“');
    await pause(300);
    assert.equal(aborts(), 0, 'ein Esc bricht nicht ab');
    await bench.page.keyboard.press('Escape');
    assert.ok(await until(() => aborts() === 1), 'das zweite Esc bestätigt');
});

test('Chat: Die Entscheidung ist eine Karte, Verwerfen will ein zweites Mal geklickt werden', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, chat, waiting } = await open(t);
    const frame = bench.chatFrame();
    const card = { title: 'Prüflauf bestanden', facts: ['Übernommen würde der ganze Testplan (2 Schritte).'], details: [{ title: 'Warnungen im Bericht', items: ['t.getKey'] }], question: 'Soll das der neue Testplan werden?' };
    const options = [{ id: 'adopt', label: 'Testplan übernehmen (2 Schritte)', primary: true }, { id: 'discard', label: 'Entwurf verwerfen', confirm: 'Wirklich verwerfen?' }];
    let answer;
    const chosen = chat.choose('deciding', 'Text fürs Protokoll', options, card).then((id) => { answer = id; });
    assert.ok(await until(() => frame.isVisible('.decision')), 'die Karte steht');
    assert.equal(await frame.textContent('.decision strong'), 'Prüflauf bestanden');
    assert.equal(await frame.locator('.decision > ul > li').count(), 1);
    assert.equal(await frame.locator('.decision details').getAttribute('open'), null, 'Warnungen zum Aufklappen');
    assert.deepEqual(waiting, ['Wartet im Chrome-Fenster auf dich: Der Testplan ändert sich erst mit deiner Wahl.'], 'einmal im Terminal');
    // Kopfzeile und Leiste der Anwendung sagen es auch.
    assert.ok(await until(async () => (await bench.page.textContent('#state')) === 'DU BIST DRAN'));
    assert.equal(await bench.page.textContent('#browserState'), 'DU BIST DRAN');

    const discard = frame.locator('#choices button', { hasText: 'Entwurf verwerfen' });
    await discard.click();
    assert.equal(await frame.locator('#choices button.sure').textContent(), 'Wirklich verwerfen?');
    await frame.locator('#choices button.no').click();
    await pause(200);
    assert.equal(answer, undefined, '„Nein“ verwirft nichts');
    await frame.locator('#choices button', { hasText: 'Entwurf verwerfen' }).click();
    await frame.locator('#choices button.sure').click();
    await chosen;
    assert.equal(answer, 'discard');
});

test('Werkbank: Vorführen zeigt die Aufnahme, Aktualisieren ist gesperrt, bis der Host es erlaubt', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, chat } = await open(t);
    const frame = bench.chatFrame();
    assert.equal(await bench.page.isDisabled('#reload'), true, 'gesperrt');
    assert.equal(await bench.page.getAttribute('#reload', 'title'), 'Während der Test läuft gesperrt');
    await bench.onRefresh(async () => {});
    assert.equal(await bench.page.isDisabled('#reload'), false, 'erlaubt');
    await bench.onRefresh(null);
    assert.equal(await bench.page.isDisabled('#reload'), true, 'wieder gesperrt');

    chat.enter('showing');
    assert.ok(await until(async () => (await bench.page.textContent('#browserState')) === '● AUFNAHME – deine Klicks zählen'));
    assert.equal(await bench.page.textContent('#stepsHint'), 'Führe den Ablauf in der Anwendung vor.');
    assert.match(await frame.textContent('#toggle'), /Vorführung beenden/);
    assert.equal(await frame.textContent('#mark'), 'Als Prüfpunkt setzen');
    assert.match(await frame.getAttribute('#input', 'placeholder'), /Als Prüfpunkt setzen/);
    chat.progress('Klick: Weiter');
    assert.ok(await until(() => frame.evaluate(() => document.querySelector('details.activity')?.open === true)), 'die Aktionen sind offen');
});

test('Chat: Nach dem Lauf bleibt das Fenster offen, bis der Mensch schließt oder die Zeit um ist', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench, chat } = await open(t);
    const frame = bench.chatFrame();
    await chat.finished({ report: join(dir, 'x.md'), text: '2 von 2 Schritten bestanden.', command: 'caw-ai run t' });
    chat.notice('Gespeichert: caw/tests/t.yaml');
    chat.human.closed();
    let done = false;
    const lingering = chat.linger(60000).then(() => { done = true; });
    assert.ok(await until(() => frame.isVisible('#closeWindow')));
    assert.match(await frame.textContent('#closeWindow'), /Fenster schließen \((60|59)\)/);
    assert.match(await frame.textContent('#messages'), /Gespeichert: caw\/tests\/t\.yaml/);
    assert.equal(done, false);
    await frame.click('#closeWindow');
    await lingering;
    assert.equal(done, true);
    const start = Date.now();
    await chat.linger(300);
    assert.ok(Date.now() - start < 3000, 'ohne Klick nach Ablauf');
});
