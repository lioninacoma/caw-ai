// Workbench and chat in real Chrome: only the chat speaks as the human, the application may navigate the top window itself, a
// reload by the human aborts the test. Skipped without Chrome.
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

test('workbench: only the own chat speaks as the human, a fake iframe named caw-chat does not', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, aborts } = await open(t);
    const chat = bench.chatFrame();
    assert.equal(chat.name(), CHAT_FRAME);
    // The application shares the origin with the workbench: it replaces the chat with its own iframe of the same name.
    await bench.view.frame.evaluate((name) => {
        top.document.getElementById('chat').remove();
        const fake = top.document.createElement('iframe');
        fake.name = name;
        fake.srcdoc = '<script>window.__cawChat({ type: "abort" })</script>';
        top.document.body.append(fake);
    }, CHAT_FRAME);
    await new Promise((ok) => { setTimeout(ok, 800); });
    assert.equal(aborts(), 0, 'the fake aborts nothing');
    assert.equal(bench.chatFrame(), chat, 'the host does not look up the chat by name');
});

test('workbench: if the application reloads the real chat iframe, the new page does not speak as the human', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, aborts } = await open(t);
    const chat = bench.chatFrame();
    // Same frame, same binding, but not the page the host wrote.
    await bench.view.frame.evaluate(() => {
        top.document.getElementById('chat').srcdoc = '<script>window.__cawChat({ type: "abort" }); window.__cawChat({ type: "abort", nonce: null })</script>';
    });
    await new Promise((ok) => { setTimeout(ok, 800); });
    assert.equal(bench.chatFrame(), chat, 'the same frame');
    assert.equal(aborts(), 0, 'the reloaded page aborts nothing');
});

test('workbench: the real chat still speaks as the human', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, aborts } = await open(t);
    await bench.chatFrame().evaluate(() => document.getElementById('abort').click());
    await bench.chatFrame().evaluate(() => document.getElementById('abort').click()).catch(() => {});
    assert.ok(await until(() => aborts() >= 1), 'abort in the real chat arrives');
});

test('workbench: if the application navigates the top window itself the test continues; the human pressing F5 aborts', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, aborts } = await open(t);
    const page = bench.page;
    const chatBefore = bench.chatFrame();
    await bench.view.frame.evaluate((url) => { top.location.href = url; }, `${base}/weiter`);
    assert.ok(await until(async () => bench.chatFrame() !== chatBefore && page.evaluate(() => window.workbench !== undefined).catch(() => false)), 'new workbench');
    // The chat is back, and it is the real one again.
    assert.ok(await until(async () => bench.chatFrame().evaluate(() => typeof window.setStatus === 'function').catch(() => false)));
    assert.equal(bench.chatFrame().name(), CHAT_FRAME);
    await new Promise((ok) => { setTimeout(ok, 500); });
    assert.equal(aborts(), 0, 'a navigation by the application is its behaviour');

    await page.reload();
    assert.ok(await until(() => aborts() === 1), 'the human pressing F5 invalidates the running test');
});

test('workbench: application popups are not the workbench, the workbench itself is', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    assert.equal(await bench.page.evaluate(() => window.__cawWorkbench === true), true);
    assert.equal(await bench.view.frame.evaluate(() => window.__cawWorkbench === true), false);
    const [popup] = await Promise.all([bench.page.context().waitForEvent('page'), bench.view.frame.evaluate((url) => { window.open(url, '_blank'); }, `${base}/popup`)]);
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(await popup.evaluate(() => window.__cawWorkbench === true), false, 'the human demonstrates there too');
});

test('local code: application popups and new tabs also get their HTML without subresource integrity', async (t) => {
    if (browser === null) return t.skip('no Chrome');
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
    assert.equal(await integrity(page), null, 'the page itself');
    const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate((address) => { window.open(address); }, url)]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator('#x').textContent(), 'OK', 'decompressed and readable');
    assert.equal(await integrity(popup), null, 'the popup');
    const tab = await context.newPage();
    await tab.goto(url);
    assert.equal(await integrity(tab), null, 'a new tab');
});

test('local code: an ISO-8859-1 page keeps its umlauts even when rewritten', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const latinServer = createServer((request, response) => {
        response.setHeader('content-type', 'text/html; charset=iso-8859-1');
        response.end(Buffer.from('<h1 id="x">Grüße</h1><script integrity="sha384-alt" src="/a.js"></script>', 'latin1'));
    });
    await new Promise((ok) => { latinServer.listen(0, '127.0.0.1', ok); });
    t.after(() => latinServer.close());
    const url = `http://127.0.0.1:${latinServer.address().port}/`;
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await interceptDocuments(context, page, ['127.0.0.1'], { request: context.request, rewrite: withoutIntegrity });
    await page.goto(url);
    assert.equal(await page.locator('#x').textContent(), 'Grüße', 'the page itself');
    assert.equal(await page.evaluate(() => document.querySelector('script').getAttribute('integrity')), null);
    const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate((address) => { window.open(address); }, url)]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator('#x').textContent(), 'Grüße', 'a popup');
});

test('chat: Esc first clears the field, then only asks to abort, only a second Esc aborts', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, aborts } = await open(t);
    const frame = bench.chatFrame();
    await frame.fill('#input', 'halb getippt');
    await frame.focus('#input');
    await bench.page.keyboard.press('Escape');
    assert.equal(await frame.inputValue('#input'), '', 'the field is empty');
    assert.equal(await frame.evaluate(() => document.getElementById('abort').classList.contains('sure')), false, 'nothing asked');
    await bench.page.keyboard.press('Escape');
    assert.match(await frame.textContent('#abort'), /Wirklich abbrechen\? \(Esc\)/);
    assert.equal(await frame.isVisible('#abortNo'), true, 'with "Nein"');
    await pause(300);
    assert.equal(aborts(), 0, 'one Esc does not abort');
    await bench.page.keyboard.press('Escape');
    assert.ok(await until(() => aborts() === 1), 'the second Esc confirms');
});

test('chat: the decision is a card, discard needs a second click', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, waiting } = await open(t);
    const frame = bench.chatFrame();
    const card = { title: 'Prüflauf bestanden', facts: ['Übernommen würde der ganze Testplan (2 Schritte).'], details: [{ title: 'Warnungen im Bericht', items: ['t.getKey'] }], question: 'Soll das der neue Testplan werden?' };
    const options = [{ id: 'adopt', label: 'Testplan übernehmen (2 Schritte)', primary: true }, { id: 'discard', label: 'Entwurf verwerfen', confirm: 'Wirklich verwerfen?' }];
    let answer;
    const chosen = chat.choose('deciding', 'Text fürs Protokoll', options, card).then((id) => { answer = id; });
    assert.ok(await until(() => frame.isVisible('.decision')), 'the card is shown');
    assert.match(await frame.textContent('.decision strong'), /Prüflauf bestanden$/, 'title, preceded by the theme mark');
    assert.equal(await frame.locator('.decision > ul > li').count(), 1);
    assert.equal(await frame.locator('.decision details').getAttribute('open'), null, 'warnings collapsed');
    assert.deepEqual(waiting, ['Wartet im Chrome-Fenster auf dich: Der Testplan ändert sich erst mit deiner Wahl.'], 'once in the terminal');
    // The application bar says so too. The pill top right only knows the four chat header labels: there is none here.
    assert.ok(await until(async () => (await bench.page.textContent('#browserState')) === 'DU BIST DRAN'));
    assert.equal(await bench.page.isVisible('#state'), false, 'no pill without a label');

    const discard = frame.locator('#choices button', { hasText: 'Entwurf verwerfen' });
    await discard.click();
    assert.equal(await frame.locator('#choices button.sure').textContent(), 'Wirklich verwerfen?');
    await frame.locator('#choices button.no').click();
    await pause(200);
    assert.equal(answer, undefined, '"Nein" discards nothing');
    await frame.locator('#choices button', { hasText: 'Entwurf verwerfen' }).click();
    await frame.locator('#choices button.sure').click();
    await chosen;
    assert.equal(answer, 'discard');
});

test('workbench: demonstrating shows recording, refresh is locked until the host allows it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat } = await open(t);
    const frame = bench.chatFrame();
    assert.equal(await bench.page.isDisabled('#reload'), true, 'locked');
    assert.equal(await bench.page.getAttribute('#reload', 'title'), 'Während der Test läuft gesperrt');
    await bench.onRefresh(async () => {});
    assert.equal(await bench.page.isDisabled('#reload'), false, 'allowed');
    await bench.onRefresh(null);
    assert.equal(await bench.page.isDisabled('#reload'), true, 'locked again');

    chat.enter('showing');
    assert.ok(await until(async () => (await bench.page.textContent('#browserState')) === '● AUFNAHME – deine Klicks zählen'));
    assert.equal(await bench.page.textContent('#stepsHint'), 'Führe den Ablauf in der Anwendung vor.');
    assert.match(await frame.textContent('#toggle'), /Vorführung beenden/);
    assert.equal(await frame.textContent('#mark'), 'Als Prüfpunkt setzen');
    assert.match(await frame.getAttribute('#input', 'placeholder'), /Als Prüfpunkt setzen/);
    chat.progress('Klick: Weiter');
    assert.ok(await until(() => frame.evaluate(() => document.querySelector('details.activity')?.open === true)), 'the actions are open');
});

test('workbench: the chip at the top right shows record, play and pause and survives a reload', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const chip = () => page.evaluate(() => {
        const node = document.getElementById('transport');
        return { on: node.classList.contains('on'), kind: node.dataset.kind, text: node.textContent, label: node.getAttribute('aria-label'), pulse: getComputedStyle(node.querySelector('i')).animationName };
    });
    assert.equal((await chip()).on, false, 'no chip without a run');
    await bench.transport('record');
    assert.deepEqual(await chip(), { on: true, kind: 'record', text: 'REC', label: 'Aufnahme', pulse: 'caw-rec' });
    await page.evaluate(() => document.body.classList.add('still'));
    assert.equal((await chip()).pulse, 'none', 'animations off: no pulse');
    await page.evaluate(() => document.body.classList.remove('still'));
    await bench.chatState('paused');
    assert.deepEqual(await chip(), { on: true, kind: 'pause', text: 'PAUSE', label: 'Pausiert', pulse: 'none' }, 'F9');
    await bench.chatState('running');
    assert.equal((await chip()).kind, 'record', 'recording again');
    await bench.transport('play');
    assert.deepEqual(await chip(), { on: true, kind: 'play', text: 'PLAY', label: 'Wiedergabe', pulse: 'none' });
    await bench.mood('aborted');
    assert.equal((await chip()).kind, 'pause', 'cancelled');
    await bench.mood('wait');
    assert.equal((await chip()).kind, 'play');
    await bench.onRefresh(async () => {});
    assert.equal((await chip()).kind, 'pause', 'handed over');
    await bench.onRefresh(null);
    // Reloading the whole workbench (here by the app itself) brings the chip back.
    await bench.view.frame.evaluate((url) => { top.location.href = url; }, `${base}/weiter`);
    assert.ok(await until(async () => (await chip().catch(() => ({}))).kind === 'play'), 'PLAY again after the reload');
    await bench.transport(null);
    assert.equal((await chip()).on, false);
});

test('chat: after the run the window stays open until the human closes it or the time is up', async (t) => {
    if (browser === null) return t.skip('no Chrome');
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
    assert.ok(Date.now() - start < 3000, 'without a click after the timeout');
});

test('workbench: the pill top right shows only the four chat header labels, without a step', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const pill = async () => ((await bench.page.isVisible('#state')) ? bench.page.textContent('#state') : null);
    await bench.steps([{ id: 'S1', name: 'Eins' }]);
    await bench.step('S1', 'running');
    for (const [state, label] of [['running', 'Claude arbeitet'], ['testing', 'caw-ai arbeitet'], ['pausing', 'Hält an …'], ['paused', '‖ Pausiert'], ['deciding', null]]) {
        await bench.chatState(state);
        assert.ok(await until(async () => (await pill()) === label), `${state}: ${await pill()}`);
    }
});

test('workbench: if Claude fills an application field while the human types in the chat, focus stays in the chat', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const frame = bench.chatFrame();
    await bench.page.waitForSelector('iframe[name="caw-app"]');
    assert.ok(await until(async () => (await bench.view.locator('#feld').count()) === 1), 'application loaded');
    await frame.waitForSelector('#input');
    await frame.click('#input');
    await bench.page.keyboard.type('Hal');
    // Claude fills in the application, as in a run via keepChatFocus.
    await bench.view.keepChatFocus(() => bench.view.locator('#feld').fill('Meier'));
    await bench.page.keyboard.type('lo');
    assert.equal(await frame.inputValue('#input'), 'Hallo', 'kept typing in the chat');
    assert.equal(await bench.view.locator('#feld').inputValue(), 'Meier', 'none of it in the form');
    return undefined;
});

test('workbench: solo view and the open tab survive a reload of the whole workbench', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    await bench.solo(true);
    assert.equal(await bench.page.evaluate(() => document.body.classList.contains('solo')), true);
    await bench.page.evaluate(() => document.querySelector('[data-tab=console]').click());
    // Like "empty cache and hard reload" from the DevTools: the top document anew.
    await bench.page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(() => bench.page.evaluate(() => document.body.classList.contains('solo')).catch(() => false)), 'solo view stays');
    assert.ok(await until(() => bench.page.evaluate(() => document.getElementById('drawer')?.classList.contains('open')).catch(() => false)), 'console stays open');
    await bench.solo(false);
    assert.equal(await bench.page.evaluate(() => document.body.classList.contains('solo')), false);
    return undefined;
});

test('workbench: F1 picks a state, without a step up to the last one, stale steps locked', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const picked = [];
    bench.onState(async (testId, step) => { picked.push([testId, step]); });
    assert.equal(await page.isVisible('.fkeys [data-states]'), false, 'no F1 without tests');
    await bench.states([
        { id: 'sb-antrag-abbrechen', name: '', mutates: true, steps: [{ id: 'S1', name: 'Personensuche', ok: true }, { id: 'S2', name: 'Person wählen', ok: true }, { id: 'S3', name: 'Antrag', ok: false, why: 'stale' }] },
        { id: 'pruefen-liste', name: '', mutates: false, steps: [{ id: 'S1', name: 'Liste', ok: true }] },
    ]);
    assert.equal(await page.isVisible('.fkeys [data-states]'), true);
    await page.keyboard.press('F1');
    assert.equal(await page.isVisible('#stateDlg'), true, 'F1 opens the dialog');
    await page.click('#stests .srow >> text=sb-antrag-abbrechen');
    assert.match(await page.textContent('#sfoot'), /bis S2 ab, ohne Claude\. Legt dabei neue Daten an\./, 'without a step: up to the last reachable one');
    assert.equal(await page.isDisabled('#ssteps .srow >> text=S3'), true, 'stale is locked');
    await page.click('#sgo');
    await until(() => picked.length === 1);
    assert.deepEqual(picked[0], ['sb-antrag-abbrechen', null].map((value) => value ?? undefined));
    assert.equal(await page.isVisible('#stateDlg'), false);
    await page.keyboard.press('F1');
    await page.click('#ssteps .srow >> text=S1');
    await page.click('#sgo');
    await until(() => picked.length === 2);
    assert.deepEqual(picked[1], ['sb-antrag-abbrechen', 'S1']);
    // In solo view F1 sits in the narrow bar.
    await bench.solo(true);
    assert.equal(await page.isVisible('.soloBar [data-states]'), true);
    return undefined;
});
