// Workbench and chat in real Chrome: only the chat speaks as the human, the application may navigate the top window itself, a
// reload by the human aborts the test. Skipped without Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';


import { openChat } from '../src/host/chat.mjs';
import { WORKBENCH_MARK_SCRIPT, interceptDocuments } from '../src/host/app-view.mjs';
import { withoutIntegrity } from '../src/ext/overlay/local-build.mjs';
import { CHAT_FRAME, openWorkbench } from '../src/host/workbench.mjs';
import { readPrefs } from '../src/shared/prefs.mjs';
import { loadTheme, themesFolder } from '../src/shared/theme-package.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let server = null;
let base = '';
const dir = mkdtempSync(join(tmpdir(), 'caw-bench-'));

before(async () => {
    browser = await launchChrome();
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

test('workbench: a form POST into the top window that the session refuses is not sent (it would pass the context routes)', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const posts = [];
    const app = createServer((request, response) => {
        if (request.method === 'POST') posts.push(request.url);
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<p id="app">App</p>');
    });
    await new Promise((ok) => { app.listen(0, '127.0.0.1', ok); });
    t.after(() => app.close());
    const url = `http://127.0.0.1:${app.address().port}`;
    const submit = async (refuse) => {
        const context = await browser.newContext();
        t.after(() => context.close());
        const page = await context.newPage();
        const asked = [];
        await interceptDocuments(context, page, ['127.0.0.1'], { workbench: () => '<p id="bench">Bench</p>', request: context.request, refuse: (request) => { asked.push(request); return refuse; } });
        await page.goto(`${url}/`);
        await page.evaluate((action) => {
            const form = document.createElement('form');
            form.method = 'post';
            form.action = action;
            form.innerHTML = '<input name="amount" value="5">';
            document.body.append(form);
            form.submit();
        }, `${url}/api/transfer`);
        await pause(800);
        return asked;
    };
    const refused = await submit(true);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].method, 'POST');
    assert.equal(refused[0].postData, 'amount=5');
    assert.deepEqual(posts, [], 'refused: the server never saw it');
    await submit(false);
    assert.deepEqual(posts, ['/api/transfer'], 'allowed: sent once by caw');
});

test('workbench: Local Network Access blocks a served page reaching another loopback origin; the permission for the app origin lets it through', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const api = createServer((request, response) => {
        response.setHeader('access-control-allow-origin', '*');
        response.end('api');
    });
    await new Promise((ok) => { api.listen(0, '127.0.0.1', ok); });
    t.after(() => api.close());
    const other = `http://localhost:${api.address().port}/data`;
    const reach = async (grant) => {
        const context = await browser.newContext();
        t.after(() => context.close());
        // Like the workbench: the document comes from Playwright, not from the network, so Chrome counts it as public.
        if (grant) await context.grantPermissions(['local-network-access'], { origin: base });
        const page = await context.newPage();
        await page.route(`${base}/served`, (route) => route.fulfill({ contentType: 'text/html', body: '<p>served</p>' }));
        await page.goto(`${base}/served`);
        return page.evaluate((url) => fetch(url).then((response) => response.text(), (error) => String(error)), other);
    };
    assert.match(await reach(false), /Failed to fetch/, 'without the permission (why caw grants it)');
    assert.equal(await reach(true), 'api');
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
    // While Claude works the input is locked; paused, the human writes.
    await frame.waitForFunction(() => typeof window.setStatus === 'function');
    await frame.evaluate(() => window.setStatus('paused', 'Pausiert', '', 'Weiter'));
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

test('workbench: the raven is an easter egg; "animations off" stops the hearts instead of freezing them', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const logo = page.locator('header.top [data-raven]');
    const look = await logo.evaluate((node) => ({ cursor: getComputedStyle(node).cursor, tab: node.tabIndex }));
    assert.deepEqual(look, { cursor: 'default', tab: -1 }, 'no hand cursor, not in the tab order');
    await logo.hover();
    assert.equal(await logo.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'no frame on hover');
    await logo.click();
    const hearts = () => page.evaluate(() => [...document.querySelectorAll('.caw-heart')].map((node) => ({ shown: getComputedStyle(node).display !== 'none', size: getComputedStyle(node).fontSize })));
    const flying = await hearts();
    assert.ok(flying.length > 0 && flying.every(({ shown, size }) => shown && size === '14px'), 'small hearts rise');
    await page.evaluate(() => document.body.classList.add('still'));
    assert.ok((await hearts()).every(({ shown }) => !shown), 'animations off: hearts in flight disappear at once');
    assert.ok(await until(async () => (await hearts()).length === 0, 4000), 'and are removed, not left frozen');
    await logo.click();
    assert.equal((await hearts()).length, 0, 'animations off: a click sends up no hearts');
    await page.evaluate(() => document.body.classList.remove('still'));
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
    assert.equal((await chip()).on, false, 'cancelled: nothing runs, no chip');
    await bench.mood('wait');
    assert.equal((await chip()).kind, 'play');
    await bench.transport(null);
    await bench.chatState('paused');
    assert.equal((await chip()).on, false, 'F9 without a running run: no chip');
    await bench.chatState('running');
    await bench.transport('play');
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
    await chat.finished({ report: join(dir, 'x.md'), text: '2 von 2 Schritten bestanden.', command: 'caw run t' });
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

test('workbench: the title is one sentence with the test name in it, the chips follow', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.newPage();
    const bench = await openWorkbench(context, { appUrl: `${base}/start`, hosts: ['127.0.0.1'], title: 'caw · morning-errand' });
    assert.equal(await bench.page.textContent('#title'), 'morning-errand');
    await bench.facts([['', 'Claude nimmt morning-errand auf'], ['Umgebung', 'staging']]);
    assert.ok(await until(async () => (await bench.page.textContent('#title')) === 'Claude nimmt morning-errand auf'));
    // The words around the test's name in the accent colour, the name itself plain.
    assert.deepEqual(await bench.page.locator('#title .cmd').allTextContents(), ['Claude nimmt ', ' auf']);
    assert.deepEqual(await bench.page.locator('#facts li').allTextContents(), ['Umgebungstaging']);
    await bench.facts([['', 'morning-errand wird ohne Claude geprüft']]);
    assert.ok(await until(async () => (await bench.page.locator('#facts li').count()) === 0));
    assert.deepEqual(await bench.page.locator('#title .cmd').allTextContents(), [' wird ohne Claude geprüft']);
});

test('workbench: the pill top right shows only the four chat header labels, without a step', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const pill = async () => ((await bench.page.isVisible('#state')) ? bench.page.textContent('#state') : null);
    await bench.steps([{ id: 'S1', name: 'Eins' }]);
    await bench.step('S1', 'running');
    for (const [state, label] of [['running', 'Claude arbeitet'], ['testing', 'caw arbeitet'], ['pausing', 'Hält an …'], ['paused', '‖ Pausiert'], ['deciding', null]]) {
        await bench.chatState(state);
        assert.ok(await until(async () => (await pill()) === label), `${state}: ${await pill()}`);
    }
});

test('workbench: the steps get the heading "Durchführung" between preparation and wrap-up; it counts as no step', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const headings = () => bench.page.$$eval('#steps>li', (list) => list.map((li) => `${li.dataset.kind}:${li.dataset.id ?? li.textContent.replace(/[^A-ZÄÖÜ]/g, '')}`));
    await bench.steps([{ id: 'prep', name: 'Vorbereitung', kind: 'phase', points: [{ id: 'chrome', label: 'Chrome starten' }] }]);
    assert.deepEqual(await headings(), ['phase:prep'], 'no heading without steps');
    await bench.steps([{ id: 'prep', name: 'Vorbereitung', kind: 'phase' }, { id: 'S1', name: 'Eins' }, { id: 'S2', name: 'Zwei' }, { id: 'end', name: 'Abschluss', kind: 'phase' }]);
    assert.deepEqual(await headings(), ['phase:prep', 'section:DURCHFÜHRUNG', 'step:S1', 'step:S2', 'phase:end']);
    const total = () => bench.page.textContent('#steps>li[data-kind=section] .ms');
    await bench.step('S1', 'running');
    await bench.step('S1', 'pass');
    assert.equal(await bench.page.textContent('#tally'), '1/2');
    await bench.step('S2', 'running');
    assert.equal(await total(), '', 'no total while a step runs');
    await bench.step('S2', 'pass');
    assert.match(await total(), /^\d+ ms$/, 'the total of the steps, like the phases');
    await bench.group({ id: 'claude', name: 'Fehler klären', kind: 'phase' });
    assert.equal((await headings()).filter((entry) => entry.startsWith('section:')).length, 1);
});

test('workbench: while Claude works the chat input is locked and the application keeps its focus; pausing unlocks it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const frame = bench.chatFrame();
    await bench.page.waitForSelector('iframe[name="caw-app"]');
    assert.ok(await until(async () => (await bench.view.locator('#feld').count()) === 1), 'application loaded');
    await frame.waitForFunction(() => typeof window.setStatus === 'function');
    await frame.evaluate(() => window.setStatus('running', 'Claude arbeitet', '', 'Anhalten'));
    assert.ok(await until(() => frame.locator('#input').isDisabled()), 'locked while Claude works');
    // Claude fills in the application: the field keeps the focus, an open list there would stay open.
    await bench.view.locator('#feld').fill('Meier');
    assert.equal(await bench.view.locator('#feld').evaluate((node) => node.ownerDocument.activeElement === node), true);
    await frame.evaluate(() => window.setStatus('paused', 'Pausiert', '', 'Weiter'));
    assert.ok(await until(async () => !(await frame.locator('#input').isDisabled())), 'unlocked when paused');
    return undefined;
});

test('workbench: a theme chosen in the dialog brings its own stylesheet and fonts at once, in workbench and chat, without reloading the app', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const chatFrame = bench.page.frames().find((frame) => frame !== bench.page.mainFrame() && frame.parentFrame() === bench.page.mainFrame() && frame.name() !== 'caw-app');
    const own = (frame) => frame.evaluate(() => document.querySelector('style[data-caw-theme-css]')?.textContent ?? '');
    // The app iframe keeps its document: a marker set now must still be there afterwards.
    const app = bench.page.frame({ name: 'caw-app' }) ?? bench.page.mainFrame().childFrames()[0];
    await app.evaluate(() => { window.cawStays = true; });
    try {
        for (const name of ['glas', 'terminal']) {
            const result = await bench.page.evaluate((theme) => window.cawTheme('use', theme), name);
            assert.equal(result.ok, true, name);
            const { css } = loadTheme(name);
            assert.equal(await own(bench.page.mainFrame()), css ?? '', `workbench: ${name}`);
            assert.equal(await own(chatFrame), css ?? '', `chat: ${name}`);
            assert.equal(await bench.page.evaluate(() => document.querySelector('style[data-caw-theme-live]')?.textContent.includes(':root{')), true);
        }
        // The mode switch in the dialog: workbench and chat turn light at once, with the light colours and scheme.
        const scheme = (frame) => frame.evaluate(() => [document.documentElement.dataset.scheme, getComputedStyle(document.documentElement).colorScheme]);
        await bench.page.keyboard.press('F7');
        await bench.page.locator('#tmode button', { hasText: 'Hell' }).click();
        await bench.page.waitForFunction(() => document.documentElement.dataset.scheme === 'light');
        assert.deepEqual(await scheme(bench.page.mainFrame()), ['light', 'light']);
        assert.deepEqual(await scheme(chatFrame), ['light', 'light']);
        assert.equal(await bench.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--screen').trim()), loadTheme('terminal', process.env, 'light').colors.screen);
        assert.equal(await bench.page.locator('#tmode button[aria-checked=true]').textContent(), 'Hell');
        await bench.page.locator('#tmode button', { hasText: 'Dunkel' }).click();
        await bench.page.waitForFunction(() => document.documentElement.dataset.scheme === 'dark');
        assert.deepEqual(await scheme(chatFrame), ['dark', 'dark']);
        // Nothing in the dialog edits a theme: no fields, no save, rename or delete; the folder for own themes is named.
        assert.equal(await bench.page.locator('#themeDlg input, #themeDlg details').count(), 0);
        assert.equal(await bench.page.locator('#themeDlg .tnote code').textContent(), themesFolder());
        assert.deepEqual(await bench.page.locator('#tthemes .tcard b').allTextContents(), ['Studio', 'Terminal', 'Raster', 'Glas']);
        // A theme folder added while the workbench is open shows up the next time the dialog opens. It has one mode: light only,
        // so dark is greyed out.
        const folder = join(themesFolder(), 'tag');
        mkdirSync(folder, { recursive: true });
        t.after(() => rmSync(folder, { recursive: true, force: true }));
        writeFileSync(join(folder, 'theme.json'), JSON.stringify({ themeApi: 1, name: 'tag', base: 'studio', label: 'Tag', scheme: 'light', colors: { screen: '#fafafa', pane: '#ffffff', text: '#111111' } }));
        await bench.page.keyboard.press('Escape');
        await bench.page.keyboard.press('F7');
        const tag = bench.page.locator('#tthemes .tcard', { hasText: 'Tag' });
        await tag.waitFor();
        assert.match(await tag.textContent(), /eigenes, auf Studio · Hell$/);
        await tag.click();
        await bench.page.locator('#tthemes .tcard[aria-checked=true]', { hasText: 'Tag' }).waitFor();
        await bench.page.waitForFunction(() => document.documentElement.dataset.scheme === 'light');
        assert.equal(await bench.page.locator('#tmode button', { hasText: 'Dunkel' }).isDisabled(), true);
        assert.equal(await bench.page.locator('#tmode button', { hasText: 'Hell' }).getAttribute('aria-checked'), 'true');
        assert.equal(await bench.page.locator('#tmode').getAttribute('title'), 'Dieses Theme hat nur einen hellen Modus.');
        assert.equal(await app.evaluate(() => window.cawStays === true), true, 'the app was not reloaded');
    } finally {
        await bench.page.evaluate(() => window.cawTheme('mode', 'dark')).catch(() => {});
        await bench.page.evaluate(() => window.cawTheme('use', 'terminal')).catch(() => {});
    }
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

test('workbench: a decision in the chat ends App only, so the question is visible; without App only nothing changes', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const solo = () => bench.page.evaluate(() => document.body.classList.contains('solo'));
    await bench.showChat();
    assert.equal(await solo(), false);
    await bench.solo(true);
    assert.equal(await solo(), true);
    await bench.showChat();
    assert.equal(await solo(), false, 'steps and chat are back');
    assert.equal(await bench.page.isVisible('#chatCard'), true);
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
        { id: 'sb-antrag-abbrechen', name: '', writes: true, steps: [{ id: 'S1', name: 'Personensuche', ok: true }, { id: 'S2', name: 'Person wählen', ok: true }, { id: 'S3', name: 'Antrag', ok: false, why: 'stale' }] },
        { id: 'pruefen-liste', name: '', writes: false, steps: [{ id: 'S1', name: 'Liste', ok: true }] },
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
    // A picked step means its entry: the steps before it completely, of the step only its navigation.
    assert.match(await page.textContent('#ssteps .srow[aria-selected=true]'), /S1 {2}Personensuche$/);
    assert.match(await page.textContent('#sfoot'), /^Spielt sb-antrag-abbrechen bis zum Einstieg in S1 ab: die Schritte davor ganz, von S1 nur die Navigation, ohne Claude\./);
    assert.match(await page.textContent('#sgo'), /ÖFFNEN/);
    await page.click('#sgo');
    await until(() => picked.length === 2);
    assert.deepEqual(picked[1], ['sb-antrag-abbrechen', 'S1']);
    // In solo view F1 sits in the narrow bar.
    await bench.solo(true);
    assert.equal(await page.isVisible('.soloBar [data-states]'), true);
    return undefined;
});

test('workbench: the application reaches the bindings via top, but sets no tokenNotice and no unknown state', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    // The bindings write the real prefs.json: here into a temporary folder.
    const home = mkdtempSync(join(tmpdir(), 'caw-bench-home-'));
    const previous = process.env.CAW_AI_HOME;
    process.env.CAW_AI_HOME = home;
    t.after(() => {
        if (previous === undefined) delete process.env.CAW_AI_HOME;
        else process.env.CAW_AI_HOME = previous;
        rmSync(home, { recursive: true, force: true });
    });
    const { bench } = await open(t);
    const picked = [];
    bench.onState(async (...args) => { picked.push(args); });
    await bench.states([{ id: 'liste', name: '', role: 'sb', writes: false, steps: [{ id: 'S1', name: 'Liste', ok: true }, { id: 'S2', name: 'X', ok: false, why: 'stale' }] }]);
    // Same origin: the application calls the workbench's bindings through top, and they see the main frame as the caller.
    await bench.view.evaluate(() => Promise.all([top.cawPref('tokenNotice', 'off'), top.cawPref('animations', 'off')]));
    await bench.view.evaluate(() => Promise.all([top.cawState('unknown'), top.cawState('liste', 'S2'), top.cawState('liste', 'pretend text')]));
    assert.deepEqual(readPrefs({ CAW_AI_HOME: home }), { animations: 'off' }, 'only the cosmetic key');
    assert.deepEqual(picked, [], 'only reachable states from the catalogue');
    await bench.view.evaluate(() => top.cawState('liste'));
    assert.deepEqual(picked, [['liste', undefined, { name: '', role: 'sb', until: 'S1' }]], 'the host passes on what it knows itself');
    return undefined;
});
