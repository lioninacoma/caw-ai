// Workbench and chat in real Chrome: only the chat speaks as the human, the application may navigate the top window itself, a
// reload by the human aborts the test. Skipped without Chrome.
import assert from 'node:assert/strict';
/* global caw -- the workbench's console object, inside page.evaluate callbacks */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';


import { openChat } from '../src/host/chat.mjs';
import { WORKBENCH_MARK_SCRIPT, interceptDocuments } from '../src/host/app-view.mjs';
import { withoutIntegrity } from '../src/ext/overlay/local-build.mjs';
import { CHAT_FRAME, openWorkbench } from '../src/host/workbench.mjs';
import { isTopNavigation } from '../src/host/host-lock.mjs';
import { readPrefs } from '../src/shared/prefs.mjs';
import { launchChrome } from './chrome.mjs';

/**
 * Runs in the application frame, same origin as the workbench: removes the chat iframe's sandbox and reloads it, then keeps
 * looking for the chat's token in the chat document and, once found, decides as the human (abort) with it.
 */
function TAMPER() {
    const chat = top.document.getElementById('chat');
    chat.removeAttribute('sandbox');
    chat.srcdoc = '<p>x</p>';
    setInterval(() => {
        let html = '';
        try {
            html = chat.contentDocument?.documentElement?.innerHTML ?? '';
        } catch { /* opaque: unreadable */ }
        const found = /nonce:"([0-9a-f]+)"/.exec(html);
        if (found === null) return;
        top.__stolen = found[1];
        chat.contentWindow.__cawChat({ type: 'abort', nonce: found[1] });
    }, 5);
}

let browser = null;
let server = null;
let base = '';
const dir = mkdtempSync(join(tmpdir(), 'caw-bench-'));

before(async () => {
    browser = await launchChrome();
    server = createServer((request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        // An application that tampers with the chat as soon as it loads in a workbench (TAMPER below).
        if (request.url.startsWith('/tamper')) {
            response.end(`<h1>App ${request.url}</h1><script>(${TAMPER})()</script>`);
            return;
        }
        // Embedding: the application frame's own document loses X-Frame-Options, a frame inside it keeps them.
        if (request.url.startsWith('/framed')) {
            response.setHeader('x-frame-options', 'DENY');
            response.end(`<h1>App ${request.url}</h1><iframe src="/denied"></iframe>`);
            return;
        }
        if (request.url.startsWith('/denied')) {
            response.setHeader('x-frame-options', 'DENY');
            response.end('<h1>inner</h1>');
            return;
        }
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

/** @param first  (bench) => runs between workbench and chat, e.g. the application tampering with the chat frame first */
const open = async (t, { first } = {}) => {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.newPage();
    await context.pages()[0].addInitScript({ content: WORKBENCH_MARK_SCRIPT });
    const bench = await openWorkbench(context, { appUrl: `${base}/start`, hosts: ['127.0.0.1'] });
    await first?.(bench);
    let aborts = 0;
    let tampered = null;
    const waiting = [];
    const chat = await openChat({ session: { workbench: bench }, logPath: join(dir, `chat-${Date.now()}.log`), onAbort: () => { aborts += 1; }, onWaiting: (line) => waiting.push(line), onTampered: (error) => { tampered = error; } });
    return { context, bench, chat, aborts: () => aborts, tampered: () => tampered, waiting };
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

test('workbench: the application removes the chat sandbox before the chat is written: no token reaches it, the run ends as tampered', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, aborts, tampered } = await open(t, {
        first: async ({ view }) => {
            await view.frame.evaluate(`(${TAMPER})()`);
            // The same-origin document is in place before the host would write the chat.
            assert.ok(await until(() => view.frame.evaluate(() => top.document.getElementById('chat').contentDocument?.body?.textContent === 'x').catch(() => false)));
        },
    });
    await pause(800);
    assert.equal(await bench.page.evaluate(() => window.__stolen ?? null), null, 'the token never landed in a document the application can read');
    assert.equal(aborts(), 0, 'the application decides nothing');
    assert.equal(tampered()?.code, 'chat-tampered');
    assert.equal(chat.available(), false, 'the chat is closed, every open decision ends without an answer');
    assert.equal(await bench.chatFrame().evaluate(() => document.body.textContent), 'x', 'the chat page was not written into it');
});

test('workbench: the application tampers with the chat of a new workbench after a top navigation: the run ends as tampered', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, aborts, tampered } = await open(t);
    const chatBefore = bench.chatFrame();
    await bench.view.frame.evaluate((url) => { top.location.href = url; }, `${base}/tamper`);
    assert.ok(await until(() => bench.chatFrame() !== chatBefore), 'new workbench');
    assert.ok(await until(() => bench.page.evaluate(() => window.workbench !== undefined).catch(() => false)), 'new workbench loaded');
    await pause(1500);
    assert.equal(await bench.page.evaluate(() => window.__stolen ?? null), null, 'no token for the application');
    assert.equal(aborts(), 0, 'the application decides nothing');
    assert.equal(tampered()?.code, 'chat-tampered');
    assert.equal(chat.available(), false);
});

test('workbench: a chat frame reloaded with its sandbox intact before the chat is written is not used either', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    // An opaque document of the application's making: its timer would survive document.open and read the token.
    const { aborts, tampered } = await open(t, {
        first: async ({ view, chatFrame }) => {
            const first = chatFrame();
            await view.frame.evaluate(() => {
                top.document.getElementById('chat').srcdoc = '<script>setInterval(() => { const found = /nonce:"([0-9a-f]+)"/.exec(document.documentElement.innerHTML); if (found) window.__cawChat({ type: "abort", nonce: found[1] }); }, 5)</script>';
            });
            assert.ok(await until(() => first.evaluate(() => document.scripts.length === 1 && !document.querySelector('header')).catch(() => false)));
        },
    });
    await pause(800);
    assert.equal(aborts(), 0);
    assert.equal(tampered()?.code, 'chat-tampered');
});

test('workbench: after the chat is written, a reload of its frame ends the run as tampered; nothing it sends counts', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, aborts, tampered } = await open(t);
    await bench.view.frame.evaluate(`(${TAMPER})()`);
    await pause(800);
    assert.equal(await bench.page.evaluate(() => window.__stolen ?? null), null);
    assert.equal(aborts(), 0);
    assert.equal(tampered()?.code, 'chat-tampered');
    assert.equal(chat.available(), false);
});

test('workbench: keys go to the application, never to the workbench element the application names as its focus', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    assert.ok(await until(async () => (await bench.view.locator('#feld').count()) === 1), 'application loaded');
    await bench.view.frame.evaluate(() => { window.__cawFocus = top.document.getElementById('chat'); });
    await bench.view.keyboard.press('Shift');
    assert.equal(await bench.page.evaluate(() => document.activeElement?.id), 'app', 'the application iframe has the focus, not the chat');
    await bench.view.locator('#feld').focus();
    await bench.page.evaluate(() => document.getElementById('chat').focus());
    await bench.view.keyboard.press('a');
    assert.equal(await bench.view.locator('#feld').inputValue(), 'a', 'the element that last had focus in the application gets the key');
});

test('workbench: the application frame is known by identity, a new name does not make its navigations non-top', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const app = bench.view.frame;
    // The name survives the reload; from then on the frame no longer is caw-app by name.
    await app.evaluate(() => { window.name = 'x'; setTimeout(() => location.reload(), 0); });
    assert.ok(await until(() => app.name() === 'x'), 'renamed');
    const seen = new Promise((ok) => { bench.page.context().on('request', (request) => { if (request.url().endsWith('/umbenannt')) ok(request); }); });
    await app.evaluate((url) => { location.href = url; }, `${base}/umbenannt`);
    const request = await seen;
    assert.equal(request.frame(), app);
    assert.notEqual(request.frame().name(), 'caw-app');
    assert.equal(isTopNavigation(request), true, 'the host lock still treats it as a top-level navigation');
});

test('workbench: only the application frame may be embedded against X-Frame-Options, a frame inside it keeps the header', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    await bench.view.goto(`${base}/framed`);
    assert.equal(await bench.view.frame.evaluate(() => document.querySelector('h1').textContent), 'App /framed', 'the application loads in the workbench');
    const inner = bench.view.frame.childFrames()[0];
    assert.ok(await until(async () => !(await inner.evaluate(() => document.querySelector('h1')?.textContent === 'inner').catch(() => false))), 'inner frame blocked');
    await pause(500);
    assert.notEqual(await inner.evaluate(() => document.querySelector('h1')?.textContent ?? null).catch(() => null), 'inner', 'DENY holds inside the application');
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
    assert.match(await frame.textContent('.decision strong'), /Prüflauf bestanden$/, 'title, preceded by the mark');
    assert.equal(await frame.locator('.decision > ul > li').count(), 1);
    assert.equal(await frame.locator('.decision details').getAttribute('open'), null, 'warnings collapsed');
    assert.deepEqual(waiting, ['Wartet im Chrome-Fenster auf dich: Der Testplan ändert sich erst mit deiner Wahl.'], 'once in the terminal');
    // The application bar says so too, and the pill: the chat waits for the human.
    assert.ok(await until(async () => (await bench.page.textContent('#browserState')) === 'DU BIST DRAN'));
    assert.equal(await bench.page.textContent('#state'), 'Du bist dran');
    assert.equal(await bench.page.getAttribute('#state', 'class'), 'pill on turn');

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
    // The checkpoint is a slash command and Alt+Enter, only while demonstrating.
    assert.match(await frame.textContent('#mark'), /^\/checkpointNur während du vorführstAlt ↵$/);
    assert.match(await frame.getAttribute('#input', 'placeholder'), /Alt\+↵ = Prüfpunkt/);
    chat.progress('Klick: Weiter');
    assert.ok(await until(() => frame.evaluate(() => document.querySelector('details.activity')?.open === true)), 'the actions are open');
});

test('workbench: the logo is an SVG in currentColor; system mode follows the browser live, in workbench and chat', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    assert.equal(await page.locator('header.top svg.logo[role=img][aria-label=caw]').count(), 1);
    const chatFrame = page.frames().find((frame) => frame !== page.mainFrame() && frame.parentFrame() === page.mainFrame() && frame.name() !== 'caw-app');
    const look = (frame) => frame.evaluate(() => [document.documentElement.dataset.pref, document.documentElement.dataset.mode, getComputedStyle(document.documentElement).colorScheme]);
    try {
        await page.emulateMedia({ colorScheme: 'dark' });
        assert.ok(await until(async () => (await look(page.mainFrame()))[1] === 'dark'), 'the workbench turns dark');
        assert.deepEqual(await look(page.mainFrame()), ['system', 'dark', 'dark']);
        assert.ok(await until(async () => (await look(chatFrame))[1] === 'dark'), 'the chat turns dark');
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(10, 12, 13)');
        await page.emulateMedia({ colorScheme: 'light' });
        assert.ok(await until(async () => (await look(page.mainFrame()))[1] === 'light'), 'and light again');
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(247, 248, 248)');
        assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /^Geist/);
        assert.ok(await page.evaluate(() => document.fonts.check('13px Geist')), 'Geist is loaded');
    } finally {
        await page.emulateMedia({ colorScheme: null });
    }
    return undefined;
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
    assert.deepEqual(await chip(), { on: true, kind: 'record', text: 'REC', label: 'Aufnahme', pulse: 'caw-pulse' });
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

test('chat: a click into the input stops the close countdown; the window then waits for "Close window" only', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat } = await open(t);
    const frame = bench.chatFrame();
    await chat.finished({ report: join(dir, 'x.md'), text: '2 von 2 Schritten bestanden.', command: 'caw run t' });
    chat.human.closed();
    let done = false;
    const lingering = chat.linger(1500).then(() => { done = true; });
    assert.ok(await until(() => frame.isVisible('#closeWindow')));
    assert.equal(await frame.isVisible('#input'), true, 'the input stays reachable under the end card');
    assert.match(await frame.getAttribute('#input', 'placeholder'), /Ein Klick hier hält das Fenster offen/);
    await frame.click('#input');
    assert.ok(await until(() => frame.isVisible('#stays')));
    assert.equal((await frame.textContent('#closeWindow')).trim(), 'Fenster schließen');
    assert.equal(await frame.evaluate(() => document.getElementById('input').readOnly), true, 'nothing listens after the run');
    await pause(2500);
    assert.equal(done, false, 'the time no longer closes it');
    await frame.click('#closeWindow');
    await lingering;
    assert.equal(done, true);
});

test('workbench: the badge shows the mode only, the sentence is its tooltip; the breadcrumb names the test; the chips follow', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.newPage();
    const bench = await openWorkbench(context, { appUrl: `${base}/start`, hosts: ['127.0.0.1'], title: 'caw · morning-errand' });
    assert.equal(await bench.page.textContent('#title'), 'morning-errand');
    await bench.facts([['', 'Claude Code nimmt morning-errand auf', 'Claude Code nimmt auf'], ['Umgebung', 'staging']]);
    assert.ok(await until(async () => (await bench.page.textContent('#title')) === 'Claude Code nimmt auf'));
    assert.equal(await bench.page.getAttribute('#title', 'title'), 'Claude Code nimmt morning-errand auf');
    assert.equal(await bench.page.textContent('#crumbTest'), 'morning-errand');
    // The facts by their values, the label in title and aria-label.
    assert.deepEqual(await bench.page.locator('#facts li').allTextContents(), ['staging']);
    assert.equal(await bench.page.getAttribute('#facts li', 'aria-label'), 'Umgebung: staging');
    // Without a badge it shows the sentence.
    await bench.facts([['', 'morning-errand wird ohne Claude Code geprüft']]);
    assert.ok(await until(async () => (await bench.page.locator('#facts li').count()) === 0));
    assert.equal(await bench.page.textContent('#title'), 'morning-errand wird ohne Claude Code geprüft');
    // While the settings are open the badge says so, and comes back with the run's mode.
    await bench.facts([['', 'Claude Code behebt S2 von morning-errand', 'Claude Code behebt S2']]);
    await bench.page.keyboard.press('Control+Comma');
    assert.equal(await bench.page.textContent('#title'), 'Einstellungen');
    await bench.page.keyboard.press('Escape');
    assert.equal(await bench.page.textContent('#title'), 'Claude Code behebt S2');
});

test('workbench: the pill top right is a dot and a word: the chat header labels first, then failed, passed, ready; no step while one runs', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const pill = async () => ((await bench.page.isVisible('#state')) ? `${(await bench.page.getAttribute('#state', 'class')).replace('pill on ', '')}:${await bench.page.textContent('#state')}` : null);
    assert.equal(await pill(), null, 'nothing before the steps');
    await bench.steps([{ id: 'S1', name: 'Eins' }, { id: 'S2', name: 'Zwei' }]);
    assert.equal(await pill(), 'idle:Bereit');
    await bench.step('S1', 'running');
    for (const [state, label] of [['running', 'run:Claude Code arbeitet'], ['testing', 'run:caw arbeitet'], ['pausing', 'turn:Hält an …'], ['paused', 'turn:Pausiert'], ['deciding', null]]) {
        await bench.chatState(state);
        assert.ok(await until(async () => (await pill()) === label), `${state}: ${await pill()}`);
    }
    assert.equal(await bench.page.locator('#state .dot').count(), 0);
    await bench.chatState('closed');
    await bench.step('S1', 'fail', 'kaputt');
    assert.equal(await pill(), 'fail:S1 gescheitert');
    await bench.step('S1', 'pass');
    await bench.step('S2', 'pass');
    assert.equal(await pill(), 'pass:Alle bestanden');
    assert.equal(await bench.page.locator('#state .dot').count(), 1);
    await bench.group({ id: 'reproduce', name: 'Claude Code stellt nach', kind: 'phase', points: [{ id: 'p1', label: 'Suche' }] });
    await bench.point('reproduce', 'p1', 'running');
    assert.equal(await pill(), 'agent:Claude Code stellt nach');
    await bench.mood('aborted');
    assert.equal(await pill(), 'fail:Abgebrochen');
});

test('workbench: the steps get the heading "Durchführung" between preparation and wrap-up; it counts as no step', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const headings = () => bench.page.$$eval('#steps>li', (list) => list.map((li) => `${li.dataset.kind}:${li.dataset.id ?? li.querySelector('.name').textContent}`));
    await bench.steps([{ id: 'prep', name: 'Vorbereitung', kind: 'phase', points: [{ id: 'chrome', label: 'Chrome starten' }] }]);
    assert.deepEqual(await headings(), ['phase:prep'], 'no heading without steps');
    await bench.steps([{ id: 'prep', name: 'Vorbereitung', kind: 'phase' }, { id: 'S1', name: 'Eins' }, { id: 'S2', name: 'Zwei' }, { id: 'end', name: 'Abschluss', kind: 'phase' }]);
    assert.deepEqual(await headings(), ['phase:prep', 'section:Durchführung', 'step:S1', 'step:S2', 'phase:end']);
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

test('workbench: while Claude Code works the chat input is locked and the application keeps its focus; pausing unlocks it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const frame = bench.chatFrame();
    await bench.page.waitForSelector('iframe[name="caw-app"]');
    assert.ok(await until(async () => (await bench.view.locator('#feld').count()) === 1), 'application loaded');
    await frame.waitForFunction(() => typeof window.setStatus === 'function');
    await frame.evaluate(() => window.setStatus('running', 'Claude Code arbeitet', '', 'Anhalten'));
    assert.ok(await until(() => frame.locator('#input').isDisabled()), 'locked while Claude Code works');
    // Claude fills in the application: the field keeps the focus, an open list there would stay open.
    await bench.view.locator('#feld').fill('Meier');
    assert.equal(await bench.view.locator('#feld').evaluate((node) => node.ownerDocument.activeElement === node), true);
    await frame.evaluate(() => window.setStatus('paused', 'Pausiert', '', 'Weiter'));
    assert.ok(await until(async () => !(await frame.locator('#input').isDisabled())), 'unlocked when paused');
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

test('workbench: in App only the chat floats over the app (Ctrl+J, Esc, x), a dot for news, decisions show it, reloads keep it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat } = await open(t);
    const page = bench.page;
    const popped = () => page.evaluate(() => document.body.classList.contains('chat-pop'));
    const dot = () => page.evaluate(() => !document.querySelector('#chatPop .new').hidden);
    await bench.showChat();
    assert.equal(await popped(), false, 'without App only nothing changes');
    await page.keyboard.press('Control+j');
    assert.equal(await popped(), false, 'Ctrl+J only in App only');
    await bench.solo(true);
    assert.equal(await page.isVisible('#chatCard'), false);
    assert.equal(await page.isVisible('#chatPop'), true, 'Chat in the bar');
    // News from the agent while hidden: a dot on Chat.
    chat.say('Das Feld ist gesperrt, weil die Rolle fehlt.');
    assert.ok(await until(dot), 'a dot for a new message');
    await page.keyboard.press('Control+j');
    assert.equal(await popped(), true);
    const box = await page.locator('#chatCard').boundingBox();
    const view = page.viewportSize();
    assert.deepEqual([Math.round(box.width), Math.round(view.width - box.x - box.width), Math.round(view.height - box.y - box.height)], [380, 16, 16], '380 wide, 16 from the edges');
    assert.ok(box.height <= 520);
    assert.equal(await dot(), false, 'showing clears the dot');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat', 'the cursor goes to the chat');
    // Esc in the chat hides it (and cancels nothing); Ctrl+J in the chat too.
    await bench.chatFrame().locator('#input').press('Escape');
    assert.ok(await until(async () => !(await popped())), 'Esc in the chat hides it');
    await page.click('#chatPop');
    assert.equal(await popped(), true);
    await bench.chatFrame().locator('#input').press('Control+j');
    assert.ok(await until(async () => !(await popped())), 'Ctrl+J in the chat hides it');
    await page.click('#chatPop');
    await page.click('#chatHide');
    assert.equal(await popped(), false, 'x hides it');
    // A decision shows it over the app, App only stays.
    await bench.showChat();
    assert.equal(await popped(), true);
    assert.equal(await page.evaluate(() => document.body.classList.contains('solo')), true, 'App only stays');
    // A reload of the workbench keeps it; leaving App only puts the chat back into its pane, F8 brings the overlay back.
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(() => page.evaluate(() => document.body.classList.contains('solo') && document.body.classList.contains('chat-pop')).catch(() => false)), 'kept over a reload');
    await bench.solo(false);
    assert.equal(await page.isVisible('#chatHide'), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('chatCard')).position !== 'fixed'), true, 'back in its pane');
    return undefined;
});

test('workbench: F1 picks a state, without a step up to the last one, stale steps locked', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const picked = [];
    bench.onState(async (testId, step) => { picked.push([testId, step]); });
    const offered = async () => {
        await page.click('#more');
        const visible = await page.isVisible('#menu [data-states]');
        await page.keyboard.press('Escape');
        return visible;
    };
    assert.equal(await offered(), false, 'no Open… without tests');
    await bench.states([
        { id: 'sb-antrag-abbrechen', name: '', writes: true, steps: [{ id: 'S1', name: 'Personensuche', ok: true }, { id: 'S2', name: 'Person wählen', ok: true }, { id: 'S3', name: 'Antrag', ok: false, why: 'stale' }] },
        { id: 'pruefen-liste', name: '', writes: false, steps: [{ id: 'S1', name: 'Liste', ok: true }] },
    ]);
    assert.equal(await offered(), true, 'Open… in the ⋯ menu');
    await page.keyboard.press('F1');
    assert.equal(await page.isVisible('#stateDlg'), true, 'F1 opens the dialog');
    await page.click('#stests .srow >> text=sb-antrag-abbrechen');
    assert.match(await page.textContent('#sfoot'), /bis S2 ab, ohne Claude Code\. Legt dabei neue Daten an\./, 'without a step: up to the last reachable one');
    assert.equal(await page.isDisabled('#ssteps .srow >> text=S3'), true, 'stale is locked');
    await page.click('#sgo');
    await until(() => picked.length === 1);
    assert.deepEqual(picked[0], ['sb-antrag-abbrechen', null].map((value) => value ?? undefined));
    assert.equal(await page.isVisible('#stateDlg'), false);
    await page.keyboard.press('F1');
    await page.click('#ssteps .srow >> text=S1');
    // A picked step means its entry: the steps before it completely, of the step only its navigation.
    assert.equal(await page.textContent('#ssteps .srow[aria-selected=true] .sid'), 'S1');
    assert.match(await page.textContent('#ssteps .srow[aria-selected=true] .nm'), /^S1Personensuche$/);
    assert.match(await page.textContent('#sfoot'), /^Spielt sb-antrag-abbrechen bis zum Einstieg in S1 ab: die Schritte davor ganz, von S1 nur die Navigation, ohne Claude Code./);
    assert.match(await page.textContent('#sgo'), /^Öffnen/);
    await page.click('#sgo');
    await until(() => picked.length === 2);
    assert.deepEqual(picked[1], ['sb-antrag-abbrechen', 'S1']);
    // In solo view F1 still opens the dialog; the narrow bar only leads back.
    await bench.solo(true);
    assert.equal(await page.isVisible('.soloBar [data-states]'), false);
    await page.keyboard.press('F1');
    assert.equal(await page.isVisible('#stateDlg'), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#stateDlg'), false);
    await page.click('.soloBar [data-solo]');
    assert.equal(await page.evaluate(() => document.body.classList.contains('solo')), false, 'back to the workbench');
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

/** A fresh prefs.json for a test that writes settings through the page. */
const ownHome = (t) => {
    const home = mkdtempSync(join(tmpdir(), 'caw-bench-home-'));
    const previous = process.env.CAW_AI_HOME;
    process.env.CAW_AI_HOME = home;
    t.after(() => {
        if (previous === undefined) delete process.env.CAW_AI_HOME;
        else process.env.CAW_AI_HOME = previous;
        rmSync(home, { recursive: true, force: true });
    });
    return home;
};

test('workbench: the ⋯ menu lists every function with its key; arrows, Enter and Esc work, Ctrl+K opens it too', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const home = ownHome(t);
    const { bench } = await open(t);
    const page = bench.page;
    const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
    assert.equal(await page.isVisible('#menu'), false);
    await page.click('#more');
    assert.equal(await page.isVisible('#menu'), true);
    assert.equal(await page.getAttribute('#more', 'aria-expanded'), 'true');
    assert.equal(await focused(), 'mPause', 'the focus is on the first item');
    const shown = await page.locator('#menu .pop-i:visible').evaluateAll((list) => list.map((item) => `${item.querySelector('.nm').textContent} ${item.querySelector('kbd').textContent}`));
    const steps = await page.evaluate(() => document.body.classList.contains('fold-steps'));
    assert.deepEqual(shown, ['Pause F9', 'Anwendung neu laden F5', 'Lauf abbrechen Esc', 'Requests F2', 'Konsole F3', `Schritte ${steps ? 'einblenden' : 'ausblenden'} F4`, 'Chat ausblenden F6', 'Nur Anwendung F8', 'Animationen aus F10', 'Einstellungen Strg ,', 'Tastenkürzel ?']);
    assert.equal(await page.isDisabled('#reload'), true, 'reload only after the hand-over');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'mCancel', 'the locked item is skipped');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(), 'mPause');
    await page.keyboard.press('End');
    assert.equal(await focused(), 'mKeys');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#menu'), false, 'Esc closes');
    assert.equal(await focused(), 'more', 'the focus returns to ⋯');
    // Ctrl+K, then an item by keyboard: Animations off.
    await page.keyboard.press('Control+KeyK');
    assert.equal(await page.isVisible('#menu'), true);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(), 'still');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#menu'), false, 'an item closes the menu');
    assert.equal(await page.evaluate(() => document.body.classList.contains('still')), true);
    assert.equal(await page.getAttribute('#still', 'aria-checked'), 'true');
    assert.ok(await until(() => readPrefs({ CAW_AI_HOME: home }).animations === 'off'), 'remembered');
    // A click on an item: the console opens; the count in the status line closes it again, Esc too.
    await page.click('#more');
    await page.click('#menu [data-tabkey=console]');
    assert.equal(await page.getAttribute('[data-tab=console]', 'aria-selected'), 'true');
    assert.equal(await page.isVisible('#drawer'), true);
    await page.click('.afoot [data-tabkey=console]');
    assert.equal(await page.isVisible('#drawer'), false);
    await page.click('.afoot [data-tabkey=requests]');
    assert.equal(await page.getAttribute('[data-tab=requests]', 'aria-selected'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#drawer'), false, 'Esc closes the drawer');
    return undefined;
});

test('workbench: Ctrl+, opens the settings page; its mode switches workbench and chat live and stays for the next page', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const home = ownHome(t);
    const { bench } = await open(t);
    const page = bench.page;
    const look = (frame) => frame.evaluate(() => [document.documentElement.dataset.pref, document.documentElement.dataset.mode]);
    await bench.settings({
        project: 'errand', config: 'caw.config.json', env: { name: 'local', url: 'http://localhost:4173', agent: true, writable: false, production: false }, role: 'user', code: 'lokaler Build',
        version: 'caw 1.0.0 · Node 22', language: { value: 'de', source: 'env' }, tokenNotice: 'on', prefsFile: '~/prefs.json', personal: { path: '~/caw.md', lines: 12 }, projectNotes: { path: 'caw/caw.md', lines: null },
    });
    assert.equal(await page.textContent('#project'), 'errand', 'the project in the breadcrumb');
    assert.equal(await page.textContent('#envBadge'), 'nur lesen', 'the app bar says the environment is not writable');
    await page.focus('#more');
    await page.keyboard.press('Control+Comma');
    assert.equal(await page.isVisible('#settings'), true);
    assert.equal(await page.isVisible('#app'), false, 'a view of the workbench: the panes step back');
    assert.equal(await page.textContent('#title'), 'Einstellungen');
    assert.equal(await page.textContent('#setLang'), 'Deutsch');
    assert.equal(await page.textContent('#setLangSrc'), 'aus CAW_LANG');
    assert.equal(await page.textContent('#setToken'), 'An');
    assert.equal(await page.isVisible('#setAgentRow'), false, 'no agent when the host does not know it');
    assert.equal(await page.textContent('#setPersonalPath'), '~/caw.md');
    assert.equal(await page.textContent('#setPersonalLines'), '· 12 Zeilen');
    assert.equal(await page.textContent('#setProjectLines'), '· noch nicht angelegt');
    assert.match(await page.textContent('#setRun'), /errand · caw\.config\.json/);
    assert.equal(await page.getAttribute('#setMode [data-mode=system]', 'aria-pressed'), 'true');
    const chat = bench.chatFrame();
    await page.click('#setMode [data-mode=dark]');
    assert.deepEqual(await look(page.mainFrame()), ['dark', 'dark']);
    assert.ok(await until(async () => (await look(chat))[1] === 'dark'), 'the chat turns dark too');
    assert.deepEqual(await look(chat), ['dark', 'dark']);
    assert.ok(await until(() => readPrefs({ CAW_AI_HOME: home }).mode === 'dark'), 'saved');
    await page.click('#setMode [data-mode=light]');
    assert.ok(await until(async () => (await look(chat))[1] === 'light'));
    await page.click('#setMode [data-mode=dark]');
    // The chat ignores a mode from anyone but its parent, and anything but the three modes.
    await page.evaluate(() => document.getElementById('chat').contentWindow.postMessage({ caw: 'mode', pref: 'neon' }, '*'));
    await bench.view.frame.evaluate(() => top.document.getElementById('chat').contentWindow.postMessage({ caw: 'mode', pref: 'light' }, '*'));
    await pause(300);
    assert.deepEqual(await look(chat), ['dark', 'dark']);
    // Animations: the same as F10.
    await page.click('#setStill');
    assert.equal(await page.evaluate(() => document.body.classList.contains('still')), true);
    assert.equal(await page.getAttribute('#setStill', 'aria-checked'), 'false');
    await page.click('#setStill');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#settings'), false, 'Esc goes back to the run');
    assert.equal(await page.isVisible('#app'), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'more', 'the focus returns');
    // Ctrl+, from inside the chat opens it too.
    await chat.locator('body').press('Control+Comma');
    assert.ok(await until(() => page.isVisible('#settings')));
    await page.click('#setBack');
    // A reloaded workbench and its new chat start in the saved mode.
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(async () => (await look(page.mainFrame()).catch(() => []))[0] === 'dark'), 'the workbench');
    assert.ok(await until(async () => (await look(bench.chatFrame()).catch(() => []))[0] === 'dark'), 'the chat');
    return undefined;
});

test('workbench: a hovered step offers to open its state only when F1 offers this test, preselected on test and step', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.newPage();
    const bench = await openWorkbench(context, { appUrl: `${base}/start`, hosts: ['127.0.0.1'], title: 'caw · morning-errand' });
    const page = bench.page;
    await page.setViewportSize({ width: 1600, height: 900 });
    await bench.steps([{ id: 'S1', name: 'Eins' }, { id: 'S2', name: 'Zwei' }, { id: 'S3', name: 'Drei' }]);
    const offer = async (id) => {
        await page.hover(`#steps>li[data-id=${id}]>.head`);
        return (await page.isVisible(`#steps>li[data-id=${id}] .hov .lnk`)) ? page.textContent(`#steps>li[data-id=${id}] .hov .lnk`) : null;
    };
    assert.equal(await offer('S2'), null, 'nothing without F1 states');
    await bench.states([
        { id: 'other', name: '', writes: false, steps: [{ id: 'S1', name: 'x', ok: true }] },
        { id: 'morning-errand', name: '', role: 'user', writes: false, steps: [{ id: 'S1', name: 'Eins', ok: true }, { id: 'S2', name: 'Zwei', ok: true }, { id: 'S3', name: 'Drei', ok: false, why: 'stale' }] },
    ]);
    assert.equal(await offer('S2'), 'Öffnen bis S2');
    assert.equal(await offer('S3'), null, 'not for a step F1 cannot reach');
    await offer('S2');
    await page.click('#steps>li[data-id=S2] .hov .lnk');
    assert.equal(await page.isVisible('#stateDlg'), true);
    assert.equal(await page.textContent('#stests .srow[aria-selected=true] .nm'), 'morning-errand');
    assert.equal(await page.textContent('#ssteps .srow[aria-selected=true] .sid'), 'S2');
    assert.match(await page.textContent('#sfoot'), /bis zum Einstieg in S2/);
    await page.keyboard.press('Escape');
    await offer('S1');
    await page.click('#steps>li[data-id=S1] .hov .ib');
    assert.equal(await page.locator('#ssteps .srow.all[aria-selected=true]').count(), 1, 'the ⋯ opens the whole test');
    await page.click('#scancel');
    assert.equal(await page.isVisible('#stateDlg'), false);
    await bench.states([]);
    assert.equal(await offer('S2'), null, 'gone with the offer');
    return undefined;
});

/** A chat with the page ready; `frame` is the chat document. */
const chatReady = async (t) => {
    const opened = await open(t);
    const frame = opened.bench.chatFrame();
    await frame.waitForFunction(() => typeof window.setStatus === 'function');
    return { ...opened, frame };
};
const visibleIds = (frame) => frame.$$eval('#slash [data-cmd]', (list) => list.filter((b) => !b.hidden).map((b) => `${b.dataset.name}${b.disabled ? ':off' : ''}${b.classList.contains('sel') ? ':sel' : ''}`));

test('chat: "/" at the start opens the commands; arrows and Enter run one, Esc closes, unavailable ones are disabled', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    chat.enter('asking');
    assert.ok(await until(() => frame.evaluate(() => document.body.dataset.state === 'asking')));
    assert.equal(await frame.isVisible('#slash'), false);
    await frame.focus('#input');
    await bench.page.keyboard.type('/');
    assert.equal(await frame.isVisible('#slash'), true, '"/" opens the commands');
    const all = await visibleIds(frame);
    assert.deepEqual(all, ['/element:sel', '/checkpoint:off', '/pause:off', '/open', '/requests', '/console', '/reload', '/app', '/settings', '/keys', '/cancel'], 'checkpoint only while demonstrating, pause only while Claude Code works or is paused');
    assert.equal(await frame.getAttribute('#input', 'aria-activedescendant'), 'pick');
    // Each command shows its key.
    assert.deepEqual(await frame.$$eval('#slash [data-cmd] kbd', (list) => list.map((k) => k.textContent)), ['Alt ↵', 'F9', 'F1', 'F2', 'F3', 'F5', 'F8', 'Strg ,', '?', 'Esc']);
    // Arrows skip the disabled ones; typing filters.
    await bench.page.keyboard.press('ArrowDown');
    assert.deepEqual((await visibleIds(frame)).filter((id) => id.endsWith(':sel')), ['/open:sel']);
    await bench.page.keyboard.press('ArrowUp');
    await bench.page.keyboard.press('ArrowUp');
    assert.deepEqual((await visibleIds(frame)).filter((id) => id.endsWith(':sel')), ['/cancel:sel'], 'wraps around');
    await bench.page.keyboard.type('re');
    assert.deepEqual(await visibleIds(frame), ['/requests:sel', '/reload']);
    // Enter runs it: requests opens the workbench's drawer, the field is empty again.
    await bench.page.keyboard.press('Enter');
    assert.ok(await until(() => bench.page.isVisible('#drawer.open')), 'the requests open in the workbench');
    assert.equal(await bench.page.getAttribute('[data-tab=requests]', 'aria-selected'), 'true');
    assert.equal(await frame.inputValue('#input'), '');
    assert.equal(await frame.isVisible('#slash'), false);
    // Esc closes the list without clearing the field and without asking to cancel.
    await frame.focus('#input');
    await bench.page.keyboard.type('/se');
    assert.equal(await frame.isVisible('#slash'), true);
    await bench.page.keyboard.press('Escape');
    assert.equal(await frame.isVisible('#slash'), false);
    assert.equal(await frame.inputValue('#input'), '/se');
    assert.equal(await frame.evaluate(() => document.body.classList.contains('arming')), false);
    // A disabled command runs nothing on Enter and is not sent as text either.
    await frame.fill('#input', '/checkpoint');
    assert.deepEqual(await visibleIds(frame), ['/checkpoint:off']);
    await bench.page.keyboard.press('Enter');
    assert.equal(await frame.inputValue('#input'), '/checkpoint');
    assert.equal(await frame.locator('.message.human').count(), 0);
    // /settings opens the workbench's settings page.
    await frame.fill('#input', '/settings');
    await bench.page.keyboard.press('Enter');
    assert.ok(await until(() => bench.page.evaluate(() => document.body.classList.contains('settings-on'))), 'the settings open');
    return undefined;
});

test('chat: /checkpoint and Alt+Enter set a checkpoint while demonstrating; /element picks; text with a space is a message', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    chat.enter('showing');
    assert.ok(await until(() => frame.evaluate(() => document.body.dataset.state === 'showing')));
    const lines = [];
    const reading = (async () => { for (let i = 0; i < 3; i += 1) lines.push(await chat.operator.nextLine()); })();
    await frame.focus('#input');
    await bench.page.keyboard.type('/check');
    assert.deepEqual(await visibleIds(frame), ['/checkpoint:sel']);
    await bench.page.keyboard.press('Enter');
    assert.equal(await frame.inputValue('#input'), '/checkpoint ', 'the command goes in front of the text');
    assert.equal(await frame.isVisible('#slash'), false);
    await bench.page.keyboard.type('Die Liste ist leer');
    await bench.page.keyboard.press('Enter');
    await frame.fill('#input', 'Der Haken ist gesetzt');
    await frame.focus('#input');
    await bench.page.keyboard.press('Alt+Enter');
    await frame.fill('#input', '/api ist langsam');
    await bench.page.keyboard.press('Enter');
    await reading;
    assert.deepEqual(lines, [{ checkpoint: 'Die Liste ist leer' }, { checkpoint: 'Der Haken ist gesetzt' }, { note: '/api ist langsam' }]);
    assert.equal(await frame.locator('.message.checkpoint').count(), 2);
    // /element asks the host to pick (its crosshair in the application), like the former Element button.
    await frame.evaluate(() => { const binding = window.__cawChat; window.__cawChat = (event) => { window.sent = [...(window.sent ?? []), event.type]; return binding(event); }; });
    await frame.fill('#input', '/el');
    await bench.page.keyboard.press('Enter');
    assert.deepEqual(await frame.evaluate(() => window.sent), ['pick']);
    assert.equal(await frame.inputValue('#input'), '');
    return undefined;
});

test('chat: the main action sits above the input with Ctrl+Enter; while Claude Code works it is "Pause F9" in the status line', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    // Running: a link with F9 next to the status, no button row under the input.
    assert.ok(await until(() => frame.evaluate(() => document.body.dataset.state === 'running')));
    assert.equal(await frame.getAttribute('#toggle', 'class'), 'lnk');
    assert.match(await frame.textContent('#toggle'), /^Pause\s*F9$/);
    assert.equal(await frame.evaluate(() => document.getElementById('toggle').parentElement.id), 'bar');
    assert.equal(await frame.locator('#form button').evaluateAll((list) => list.filter((b) => b.offsetParent !== null).map((b) => b.id).join(',')), 'send', 'only the send arrow in the field');
    assert.match(await frame.textContent('#hint'), /^\/ Befehle\s*Enter senden\s*Strg ↵ Hauptaktion/);
    // Asking: "Fertig" full width above the input, Ctrl+Enter presses it.
    const lines = [];
    chat.enter('asking');
    assert.ok(await until(() => frame.evaluate(() => document.body.dataset.state === 'asking')));
    assert.match(await frame.getAttribute('#toggle', 'class'), /btn btn-p/);
    assert.match(await frame.textContent('#toggle'), /^Fertig\s*Strg ↵$/);
    const [toggle, form] = await Promise.all([frame.locator('#toggle').boundingBox(), frame.locator('#form').boundingBox()]);
    assert.ok(toggle.y + toggle.height <= form.y, 'above the input');
    assert.ok(Math.abs(toggle.width - form.width) < 2, 'full width');
    const next = chat.operator.nextLine().then((line) => lines.push(line));
    await frame.focus('#input');
    await bench.page.keyboard.press('Control+Enter');
    await next;
    assert.deepEqual(lines, [''], 'Ctrl+Enter is "Fertig"');
    // Planning: "Plan freigeben" is the one main action, Ctrl+Enter approves it.
    let answer;
    const planned = chat.plan({ steps: [{ id: 'S1', name: 'Eins', do: 'Klick', expect: 'Da' }] }).then((value) => { answer = value; });
    assert.ok(await until(() => frame.isVisible('#approve')));
    assert.equal(await frame.isVisible('#toggle'), false);
    assert.match(await frame.getAttribute('#approve', 'class'), /primary big btn btn-p/);
    await frame.focus('#input');
    await bench.page.keyboard.press('Control+Enter');
    await planned;
    assert.deepEqual(answer, { approved: true });
    return undefined;
});

const failureOptions = [{ id: 'ask', label: 'Claude Code die Ursache finden lassen', primary: true }, { id: 'fix', label: 'Schritt beheben' }, { id: 'rerun', label: 'Erneut testen' }, { id: 'close', label: 'Lauf beenden' }];
test('chat: the "Mehr" menu stays inside the chat, and its items take a mouse click', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    const answer = chat.discuss('S3 ist gescheitert', failureOptions, failureCard);
    assert.ok(await until(() => frame.isVisible('#choicesMore')));
    await frame.click('#choicesMore');
    const box = await frame.evaluate(() => { const r = document.getElementById('choicesMoreMenu').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; });
    assert.ok(box.left >= 0 && box.right <= box.width, `menu inside the chat: ${JSON.stringify(box)}`);
    await frame.locator('#choices button', { hasText: 'Lauf beenden' }).click({ timeout: 5000 });
    assert.deepEqual(await answer, { choice: 'close' });
    return undefined;
});
const failureCard = { id: 'S3', reason: 'Der Ring zeigt 0/1', diagnosis: { side: 'app', strength: 'clear', text: 'Sieht nach einem Fehler der Anwendung aus.', findings: ['PATCH /api/todos/1 → 500'] }, warn: 'Den Test anzupassen würde den Fehler nur verdecken.', failures: [], warnings: [] };

test('chat: a failure card shows one primary choice; the others are behind "Mehr", a menu that opens, picks and closes with Esc', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    const answer = chat.discuss('S3 ist gescheitert', failureOptions, failureCard);
    assert.ok(await until(() => frame.isVisible('.message.failure')));
    assert.equal(await frame.textContent('.failure .bdg.fail'), 'Anwendung', 'the category badge');
    assert.match(await frame.textContent('.failure .warnbox'), /nur verdecken/);
    assert.equal(await frame.textContent('#choices button.primary'), 'Claude Code die Ursache finden lassen');
    assert.equal(await frame.isVisible('#choicesMore'), true);
    for (const label of ['Schritt beheben', 'Erneut testen', 'Lauf beenden']) assert.equal(await frame.locator('#choices button', { hasText: label }).isVisible(), false, `${label} behind More`);
    // Opens with a click, the first item gets the focus; arrows move, Esc closes and returns to "Mehr".
    await frame.click('#choicesMore');
    assert.equal(await frame.getAttribute('#choicesMore', 'aria-expanded'), 'true');
    assert.equal(await frame.evaluate(() => document.activeElement.textContent), 'Schritt beheben');
    await bench.page.keyboard.press('ArrowDown');
    assert.equal(await frame.evaluate(() => document.activeElement.textContent), 'Erneut testen');
    await bench.page.keyboard.press('Escape');
    assert.equal(await frame.isVisible('#choicesMoreMenu'), false);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'choicesMore');
    assert.equal(await frame.evaluate(() => document.body.classList.contains('arming')), false, 'Esc only closed the menu');
    // With the keyboard: ArrowDown on "Mehr" opens it, Enter picks.
    await bench.page.keyboard.press('ArrowDown');
    await bench.page.keyboard.press('End');
    assert.equal(await frame.evaluate(() => document.activeElement.textContent), 'Lauf beenden');
    await bench.page.keyboard.press('Enter');
    assert.deepEqual(await answer, { choice: 'close' });
    assert.equal(await frame.isVisible('#choicesMoreMenu'), false, 'closed after the choice');
    return undefined;
});

test('chat: two choices need no menu; a confirming choice in "Mehr" still needs its second click', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    const advice = chat.advice({ side: 'app', title: 'Suche ignoriert Tags', reason: 'Nur der Titel', edits: [{ file: 'server.mjs', line: 197, find: 'a\nb', replace: 'c' }], prompt: 'Auch den Tag prüfen.' },
        [{ id: 'apply', label: 'Änderung übernehmen', primary: true }, { id: 'next', label: 'Weiter', primary: false }]);
    assert.ok(await until(() => frame.isVisible('.message.advice')));
    assert.deepEqual(await frame.$$eval('.advice .dl', (rows) => rows.map((row) => `${row.className}|${row.querySelector('.n').textContent}|${row.querySelector('code').textContent}`)), ['dl del|197|a', 'dl del|198|b', 'dl add|197|c'], 'the diff with line numbers');
    assert.equal(await frame.isVisible('.advice button.copy'), true);
    assert.equal(await frame.locator('#choicesMore').count(), 0);
    assert.equal(await frame.isVisible('#choices button:text-is("Weiter")'), true, 'a single secondary button');
    await frame.click('#choices button:text-is("Weiter")');
    assert.equal(await advice, 'next');
    const decided = chat.choose('deciding', 'Text', [{ id: 'adopt', label: 'Übernehmen', primary: true }, { id: 'keep', label: 'Behalten' }, { id: 'discard', label: 'Verwerfen', confirm: 'Wirklich verwerfen?' }], { title: 'Prüflauf bestanden' });
    assert.ok(await until(() => frame.isVisible('#choicesMore')));
    await frame.click('#choicesMore');
    await frame.click('#choices button:text-is("Verwerfen")');
    assert.equal(await frame.textContent('#choices button.sure'), 'Wirklich verwerfen?');
    assert.equal(await frame.isVisible('#choicesMoreMenu'), true, 'the menu stays open for the second click');
    await frame.click('#choices button.sure');
    assert.equal(await decided, 'discard');
    return undefined;
});

test('chat: the end card has one main action; report and close are beside it or behind "Mehr"', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    await chat.finished({ kind: 'pass', report: join(dir, 'x.md'), text: '4 von 4 Schritten bestanden.', command: 'caw run t', learn: true });
    chat.human.closed();
    const lingering = chat.linger(60000);
    assert.ok(await until(() => frame.isVisible('#next.on')));
    assert.equal(await frame.textContent('#nextTitle'), 'Lauf bestanden');
    assert.equal(await frame.textContent('#nextText'), '4 von 4 Schritten bestanden.');
    assert.match(await frame.textContent('#nextCmd'), /Neuer Lauf: caw run t/);
    assert.ok(await until(async () => (await frame.getAttribute('#learn', 'class')) === 'btn btn-p'), 'Save baselines is the main action');
    assert.equal(await frame.isVisible('#report'), false);
    await frame.click('#nextMore');
    assert.deepEqual(await frame.$$eval('#nextMoreMenu button', (list) => list.map((b) => b.id)), ['report', 'closeWindow']);
    assert.equal(await frame.isVisible('#closeWindow'), true);
    await frame.focus('#nextMoreMenu button');
    await frame.locator('#report').press('Escape');
    assert.equal(await frame.isVisible('#nextMoreMenu'), false);
    await frame.click('#nextMore');
    await frame.click('#closeWindow');
    await lingering;
    return undefined;
});

test('chat: the end card\'s command wraps only between its words, keeps every space and draws "--" in two cells', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    const command = 'caw run first-errand --env local';
    await chat.finished({ kind: 'pass', report: join(dir, 'x.md'), text: '4 von 4 Schritten bestanden.', command, learn: true });
    chat.human.closed();
    const lingering = chat.linger(60000);
    assert.ok(await until(() => frame.isVisible('#next.on')));
    // Narrow enough that the command needs two lines, as in the workbench's chat column.
    const seen = await frame.evaluate(() => {
        const code = document.querySelector('#nextCmd code');
        code.parentElement.style.width = '150px';
        const lines = new Map();
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const widths = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            for (let i = 0; i < node.length; i += 1) {
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const box = range.getBoundingClientRect();
                if (node.data[i] !== ' ') widths.push(box.width);
                if (box.width > 0) lines.set(Math.round(box.top), `${lines.get(Math.round(box.top)) ?? ''}${node.data[i]}`);
            }
        }
        return { text: code.textContent, lines: [...lines.values()].map((line) => line.trim()), widths, ligatures: getComputedStyle(code).fontVariantLigatures };
    });
    assert.equal(seen.text, command, 'the text keeps its spaces, also for a copy');
    assert.ok(seen.lines.length > 1, `wrapped: ${JSON.stringify(seen.lines)}`);
    // Every line is made of whole words of the command.
    const words = command.split(' ');
    for (const line of seen.lines) assert.ok(line.split(' ').every((word) => words.includes(word)), `no word broken: ${JSON.stringify(seen.lines)}`);
    assert.equal(seen.ligatures, 'none');
    assert.ok(Math.max(...seen.widths) - Math.min(...seen.widths) < 0.5, `one cell per character: ${seen.widths}`);
    await frame.click('#nextMore');
    await frame.click('#closeWindow');
    await lingering;
    return undefined;
});

test('chat: a reproduction ends with its findings, the read-only note and Close window as the main action, the report beside it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    await chat.finished({ kind: 'reproduce', report: join(dir, 'x.md'), text: 'Fehler nachgestellt', command: 'caw record bug-x', adopt: true,
        reproduce: { bug: 'Suche findet nichts', observed: 'Leere Liste', expected: 'Zwei Einträge', cause: 'server.mjs:197', readOnly: true } });
    chat.human.closed();
    const lingering = chat.linger(60000);
    assert.ok(await until(() => frame.isVisible('#closeWindow')));
    assert.equal(await frame.textContent('#nextTitle'), 'Fehler nachgestellt');
    assert.equal(await frame.textContent('#nextRepro .quote'), '“Suche findet nichts”');
    assert.deepEqual(await frame.$$eval('#nextRepro dt', (list) => list.map((dt) => dt.textContent)), ['Beobachtet', 'Erwartet', 'Ursache']);
    assert.match(await frame.textContent('#nextRepro .banner.ro'), /Nur lesend/);
    assert.match(await frame.textContent('#nextCmd'), /Entwurf nach caw\/tests kopieren, dann: caw record bug-x/);
    assert.equal(await frame.getAttribute('#closeWindow', 'class'), 'btn btn-p');
    assert.equal(await frame.getAttribute('#report', 'class'), 'btn btn-s');
    assert.equal(await frame.locator('#nextMore').count(), 0);
    await frame.click('#closeWindow');
    await lingering;
    return undefined;
});

test('chat: notices are quiet icon lines, the token notice a card; Claude Code starting shows a spinner and the pill says so', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    chat.notice('Gespeichert: caw/tests/t.yaml');
    assert.ok(await until(() => frame.isVisible('.message.notice')));
    assert.equal(await frame.locator('.message.notice svg').count(), 1);
    chat.starting('Starte Claude');
    assert.ok(await until(() => frame.isVisible('.message.starting:not(.done) .spin')));
    assert.match(await frame.textContent('.message.starting small'), /^00:0\d$/);
    chat.starting('Starte Claude');
    await pause(200);
    assert.equal(await frame.locator('.message.starting').count(), 1, 'preparing and starting show as one line');
    assert.ok(await until(async () => (await bench.page.textContent('#state')) === 'Claude Code startet'), 'the pill while Claude Code starts');
    assert.equal(await bench.page.getAttribute('#state', 'class'), 'pill on agent');
    chat.say('Ich schaue.');
    assert.ok(await until(() => frame.isVisible('.message.starting.done')), 'done once Claude Code speaks');
    assert.ok(await until(async () => (await bench.page.textContent('#state')) === 'Claude Code arbeitet'), 'the pill follows the chat again');
    assert.match(await frame.textContent('.message.claude .who'), /^Claude Code\d\d:\d\d$/, 'with the time');
    const gate = chat.choose('choosing', 'Jetzt arbeitet Claude, das kostet Token.', [{ id: 'go', label: 'Weiter', primary: true }, { id: 'always', label: 'Nicht mehr fragen' }, { id: 'stop', label: 'Ohne Claude Code weiter' }], { kind: 'tokens', text: 'caw fragt einmal pro Lauf.' });
    assert.ok(await until(() => frame.isVisible('.message.tokens')));
    assert.equal(await frame.textContent('.message.tokens strong'), 'Jetzt arbeitet Claude, das kostet Token.');
    await frame.click('#choicesMore');
    await frame.click('#choices button:text-is("Ohne Claude Code weiter")');
    assert.equal(await gate, 'stop');
    return undefined;
});

test('chat: Ctrl+K and ? (when not typing) open the workbench\'s menu and keys; the mode still switches the chat', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, frame } = await chatReady(t);
    const page = bench.page;
    await frame.evaluate(() => window.setStatus('paused', 'Pausiert', '', 'Weiter'));
    await frame.focus('#input');
    await page.keyboard.press('Control+KeyK');
    assert.ok(await until(() => page.isVisible('#menu')), 'Ctrl+K in the chat opens the ⋯ menu');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#menu'), false);
    // ? in the field is text; outside it opens the keys.
    await frame.focus('#input');
    await page.keyboard.type('?');
    assert.equal(await frame.inputValue('#input'), '?');
    assert.equal(await page.evaluate(() => document.body.classList.contains('settings-on')), false);
    await frame.fill('#input', '');
    await frame.focus('#toggle');
    await page.keyboard.type('?');
    assert.ok(await until(() => page.evaluate(() => document.body.classList.contains('settings-on'))), '? opens the keys');
    // The mode picked in the settings switches the chat live, with its cards.
    const look = () => frame.evaluate(() => [document.documentElement.dataset.mode, getComputedStyle(document.body).backgroundColor]);
    await page.click('#setMode [data-mode=dark]');
    assert.ok(await until(async () => (await look())[0] === 'dark'));
    assert.equal((await look())[1], 'rgb(15, 18, 19)', 'the dark panel');
    await page.click('#setMode [data-mode=light]');
    assert.ok(await until(async () => (await look())[0] === 'light'));
    assert.equal((await look())[1], 'rgb(255, 255, 255)');
    return undefined;
});

test('workbench: the console object caw: the app window, what runs here, the footer lists and the host tools', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const top = bench.page.mainFrame();
    assert.equal(await top.evaluate(() => caw.app === document.getElementById('app').contentWindow), true);
    await bench.view.goto(`${base}/start?again`);
    assert.equal(await top.evaluate(() => caw.app.location.search), '?again', 'always the current document');
    await bench.settings({ project: 'shop', test: 'order', mode: 'open', env: { name: 'local', url: base }, role: 'clerk', version: 'caw 1' });
    await bench.steps([{ id: 'S1', name: 'Eins' }]);
    await bench.step('S1', 'running');
    const info = await top.evaluate(() => caw.info);
    assert.deepEqual({ project: info.project, test: info.test, step: info.step, mode: info.mode, env: info.env.name, role: info.role }, { project: 'shop', test: 'order', step: 'S1', mode: 'open', env: 'local', role: 'clerk' });
    assert.match(info.url, /\/start\?again$/);
    assert.deepEqual(await top.evaluate(() => [Array.isArray(caw.requests()), Array.isArray(caw.console())]), [true, true]);
    assert.equal(await top.evaluate(() => caw.ready()), null, 'without a session nothing answers');
    bench.onDebug({ ready: async () => ({ appReady: true, openRequests: 0 }), locator: async (mark) => bench.view.frame.locator(`[data-caw-mark="${mark}"]`).evaluate((node) => node.tagName.toLowerCase()) });
    assert.deepEqual(await top.evaluate(() => caw.ready()), { appReady: true, openRequests: 0 });
    assert.equal(await top.evaluate(() => caw.locator(caw.app.document.body)), 'body');
    assert.equal(await top.evaluate(() => caw.locator('nothing')), null);
    assert.equal(await top.evaluate(() => caw.app.document.querySelectorAll('[data-caw-mark]').length), 0, 'the mark is gone again');
    assert.equal(await top.evaluate(() => Object.isFrozen(caw)), true);
});

test('agent actions: a folded item unfolds to its files and keeps the call as tooltip; the latest action stays in view; "working" right after a message', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    const page = bench.page;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bench.steps(Array.from({ length: 30 }, (_, i) => ({ id: `S${i + 1}`, name: `Schritt ${i + 1}`, kind: 'step' })));
    await bench.group({ id: 'claude', name: 'Develop', kind: 'phase' });
    await bench.point('claude', 'c1', 'running', { kind: 'Claude Code', label: '2 Dateien gelesen', raw: 'Read: a\nRead: b', details: ['p/a.mjs', 'p/b.md'] });
    await bench.point('claude', 'c1', 'pass');
    const item = page.locator('#steps li[data-id=claude] .pts>li[data-id=c1]');
    assert.equal(await item.getAttribute('title'), 'Read: a\nRead: b');
    assert.equal(await item.locator('.det').isVisible(), false, 'folded');
    // Nothing runs, S1 waits far above: the latest action stays in view all the same.
    assert.ok(await until(() => page.evaluate(() => { const track = document.getElementById('track'); const box = track.getBoundingClientRect(); const r = document.querySelector('#steps li[data-id=claude] .pts>li[data-id=c1]').getBoundingClientRect(); return track.scrollTop > 0 && r.top >= box.top && r.bottom <= box.bottom; })), 'the latest action in view');
    await item.locator('.name').click();
    assert.deepEqual(await item.locator('.det li').allTextContents(), ['p/a.mjs', 'p/b.md']);
    // A question in the conversation: "working" at once, until the agent's next entry.
    const answer = chat.develop('Bereit.', [{ id: 'end', label: 'Ende' }]);
    await frame.waitForFunction(() => document.body.dataset.state === 'developing');
    await frame.fill('#input', 'Warum?');
    await frame.press('#input', 'Enter');
    assert.ok(await until(() => frame.isVisible('#thinking')), 'working shows at once');
    await answer;
    // As in develop: the conversation goes on at once.
    chat.develop(undefined, [{ id: 'end', label: 'Ende' }]);
    await pause(300);
    assert.equal(await frame.isVisible('#thinking'), true, 'still working while the agent thinks');
    chat.logLine('[+1.0s] > Read: {"file_path":"/p/a.mjs"}');
    await pause(300);
    assert.equal(await frame.isVisible('#thinking'), true, 'and while it acts');
    chat.say('Weil.');
    assert.ok(await until(async () => !(await frame.isVisible('#thinking'))), 'gone with the answer');
    return undefined;
});
