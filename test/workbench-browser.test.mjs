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
        response.end(`<h1>App ${request.url}</h1><button id="go">Weiter</button><label>Name <input id="feld"></label>`);
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

test('Lokaler Code: Eine Seite in ISO-8859-1 behält ihre Umlaute, auch wenn sie umgeschrieben wird', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const server = createServer((request, response) => {
        response.setHeader('content-type', 'text/html; charset=iso-8859-1');
        response.end(Buffer.from('<h1 id="x">Grüße</h1><script integrity="sha384-alt" src="/a.js"></script>', 'latin1'));
    });
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/`;
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await interceptDocuments(context, page, ['127.0.0.1'], { request: context.request, rewrite: withoutIntegrity });
    await page.goto(url);
    assert.equal(await page.locator('#x').textContent(), 'Grüße', 'die eigene Seite');
    assert.equal(await page.evaluate(() => document.querySelector('script').getAttribute('integrity')), null);
    const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate((address) => { window.open(address); }, url)]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator('#x').textContent(), 'Grüße', 'ein Popup');
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
    assert.match(await frame.textContent('.decision strong'), /Prüflauf bestanden$/, 'Titel, davor die Marke des Themes');
    assert.equal(await frame.locator('.decision > ul > li').count(), 1);
    assert.equal(await frame.locator('.decision details').getAttribute('open'), null, 'Warnungen zum Aufklappen');
    assert.deepEqual(waiting, ['Wartet im Chrome-Fenster auf dich: Der Testplan ändert sich erst mit deiner Wahl.'], 'einmal im Terminal');
    // Die Leiste der Anwendung sagt es auch. Die Pill oben rechts kennt nur die vier Labels des Chat-Kopfs: Hier hat sie keines.
    assert.ok(await until(async () => (await bench.page.textContent('#browserState')) === 'DU BIST DRAN'));
    assert.equal(await bench.page.isVisible('#state'), false, 'keine Pill ohne Label');

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

test('Werkbank: Der Chip oben rechts zeigt Aufnahme, Wiedergabe und Pause und bleibt nach dem Neuladen', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const chip = () => page.evaluate(() => {
        const node = document.getElementById('transport');
        return { on: node.classList.contains('on'), kind: node.dataset.kind, text: node.textContent, label: node.getAttribute('aria-label'), pulse: getComputedStyle(node.querySelector('i')).animationName };
    });
    assert.equal((await chip()).on, false, 'ohne Lauf kein Chip');
    await bench.transport('record');
    assert.deepEqual(await chip(), { on: true, kind: 'record', text: 'REC', label: 'Aufnahme', pulse: 'caw-rec' });
    await page.evaluate(() => document.body.classList.add('still'));
    assert.equal((await chip()).pulse, 'none', 'Animationen aus: kein Pulsieren');
    await page.evaluate(() => document.body.classList.remove('still'));
    await bench.chatState('paused');
    assert.deepEqual(await chip(), { on: true, kind: 'pause', text: 'PAUSE', label: 'Pausiert', pulse: 'none' }, 'F9');
    await bench.chatState('running');
    assert.equal((await chip()).kind, 'record', 'weiter aufnehmen');
    await bench.transport('play');
    assert.deepEqual(await chip(), { on: true, kind: 'play', text: 'PLAY', label: 'Wiedergabe', pulse: 'none' });
    await bench.mood('aborted');
    assert.equal((await chip()).kind, 'pause', 'abgebrochen');
    await bench.mood('wait');
    assert.equal((await chip()).kind, 'play');
    await bench.onRefresh(async () => {});
    assert.equal((await chip()).kind, 'pause', 'übergeben');
    await bench.onRefresh(null);
    // Reloading the whole workbench (here by the app itself) brings the chip back.
    await bench.view.frame.evaluate((url) => { top.location.href = url; }, `${base}/weiter`);
    assert.ok(await until(async () => (await chip().catch(() => ({}))).kind === 'play'), 'nach dem Neuladen wieder PLAY');
    await bench.transport(null);
    assert.equal((await chip()).on, false);
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

test('Werkbank: Die Pill oben rechts zeigt nur die vier Labels des Chat-Kopfs, ohne Schritt', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench } = await open(t);
    const pill = async () => ((await bench.page.isVisible('#state')) ? bench.page.textContent('#state') : null);
    await bench.steps([{ id: 'S1', name: 'Eins' }]);
    await bench.step('S1', 'running');
    for (const [state, label] of [['running', 'Claude arbeitet'], ['testing', 'caw-ai arbeitet'], ['pausing', 'Hält an …'], ['paused', '‖ Pausiert'], ['deciding', null]]) {
        await bench.chatState(state);
        assert.ok(await until(async () => (await pill()) === label), `${state}: ${await pill()}`);
    }
});

test('Werkbank: Füllt Claude ein Feld der Anwendung, während der Mensch im Chat tippt, bleibt der Fokus im Chat', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench } = await open(t);
    const frame = bench.chatFrame();
    await bench.page.waitForSelector('iframe[name="caw-app"]');
    assert.ok(await until(async () => (await bench.view.locator('#feld').count()) === 1), 'Anwendung geladen');
    await frame.waitForSelector('#input');
    await frame.click('#input');
    await bench.page.keyboard.type('Hal');
    // Claude füllt in der Anwendung, wie im Lauf über keepChatFocus.
    await bench.view.keepChatFocus(() => bench.view.locator('#feld').fill('Meier'));
    await bench.page.keyboard.type('lo');
    assert.equal(await frame.inputValue('#input'), 'Hallo', 'weiter im Chat getippt');
    assert.equal(await bench.view.locator('#feld').inputValue(), 'Meier', 'nichts davon in der Maske');
    return undefined;
});

test('Werkbank: Nur Anwendung und der offene Reiter überstehen das Neuladen der ganzen Werkbank', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench } = await open(t);
    await bench.solo(true);
    assert.equal(await bench.page.evaluate(() => document.body.classList.contains('solo')), true);
    await bench.page.evaluate(() => document.querySelector('[data-tab=console]').click());
    // Wie „Cache leeren und hart neu laden“ aus den DevTools: das oberste Dokument neu.
    await bench.page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(() => bench.page.evaluate(() => document.body.classList.contains('solo')).catch(() => false)), 'Nur Anwendung bleibt');
    assert.ok(await until(() => bench.page.evaluate(() => document.getElementById('drawer')?.classList.contains('open')).catch(() => false)), 'Konsole bleibt offen');
    await bench.solo(false);
    assert.equal(await bench.page.evaluate(() => document.body.classList.contains('solo')), false);
    return undefined;
});

test('Werkbank: F1 wählt einen Zustand, ohne Schritt bis zum letzten, veraltete Schritte gesperrt', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const picked = [];
    bench.onState(async (test, step) => { picked.push([test, step]); });
    assert.equal(await page.isVisible('.fkeys [data-states]'), false, 'ohne Tests kein F1');
    await bench.states([
        { id: 'sb-antrag-abbrechen', name: '', mutates: true, steps: [{ id: 'S1', name: 'Personensuche', ok: true }, { id: 'S2', name: 'Person wählen', ok: true }, { id: 'S3', name: 'Antrag', ok: false, why: 'stale' }] },
        { id: 'pruefen-liste', name: '', mutates: false, steps: [{ id: 'S1', name: 'Liste', ok: true }] },
    ]);
    assert.equal(await page.isVisible('.fkeys [data-states]'), true);
    await page.keyboard.press('F1');
    assert.equal(await page.isVisible('#stateDlg'), true, 'F1 öffnet den Dialog');
    await page.click('#stests .srow >> text=sb-antrag-abbrechen');
    assert.match(await page.textContent('#sfoot'), /bis S2 ab, ohne Claude\. Legt dabei neue Daten an\./, 'ohne Schritt: bis zum letzten herstellbaren');
    assert.equal(await page.isDisabled('#ssteps .srow >> text=S3'), true, 'veraltet gesperrt');
    await page.click('#sgo');
    await until(() => picked.length === 1);
    assert.deepEqual(picked[0], ['sb-antrag-abbrechen', null].map((value) => value ?? undefined));
    assert.equal(await page.isVisible('#stateDlg'), false);
    await page.keyboard.press('F1');
    await page.click('#ssteps .srow >> text=S1');
    await page.click('#sgo');
    await until(() => picked.length === 2);
    assert.deepEqual(picked[1], ['sb-antrag-abbrechen', 'S1']);
    // Im Vollbild steht F1 in der schmalen Leiste.
    await bench.solo(true);
    assert.equal(await page.isVisible('.soloBar [data-states]'), true);
    return undefined;
});
