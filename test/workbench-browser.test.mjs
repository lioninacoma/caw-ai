// Workbench and chat in real Chrome: only the chat speaks as the human, the application may navigate the top window itself, a
// reload by the human aborts the test. Skipped without Chrome.
import assert from 'node:assert/strict';
/* global caw -- the workbench's console object, inside page.evaluate callbacks */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';


import { decideReproduced } from '../src/host/flows.mjs';
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
const open = async (t, { first, desk, transcript, flow, viewport } = {}) => {
    const context = await browser.newContext(viewport === undefined ? {} : { viewport });
    t.after(() => context.close());
    await context.newPage();
    await context.pages()[0].addInitScript({ content: WORKBENCH_MARK_SCRIPT });
    const bench = await openWorkbench(context, { appUrl: `${base}/start`, hosts: ['127.0.0.1'], ...(flow === undefined ? {} : { flow, title: 'caw · reproduce' }) });
    await first?.(bench);
    let aborts = 0;
    let tampered = null;
    const waiting = [];
    const logPath = join(dir, `chat-${Date.now()}.log`);
    const chat = await openChat({ session: { workbench: bench }, logPath, onAbort: () => { aborts += 1; }, onWaiting: (line) => waiting.push(line), onTampered: (error) => { tampered = error; }, desk, ...(transcript === undefined ? {} : { transcript }) });
    return { context, bench, chat, aborts: () => aborts, tampered: () => tampered, waiting, logPath };
};

const pause = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
// The chat names and takes the platform's modifier: ⌘ on macOS, Ctrl elsewhere.
const MOD = process.platform === 'darwin' ? '⌘' : 'Strg';

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
    // The check needs the new chat to be written; a slow machine takes longer than a fixed pause.
    assert.ok(await until(() => tampered()?.code === 'chat-tampered'), 'the run ends as tampered');
    assert.equal(await bench.page.evaluate(() => window.__stolen ?? null), null, 'no token for the application');
    assert.equal(aborts(), 0, 'the application decides nothing');
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
    await interceptDocuments(context, page, ['127.0.0.1'], { rewrite: withoutIntegrity });
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
        await interceptDocuments(context, page, ['127.0.0.1'], { workbench: () => '<p id="bench">Bench</p>', refuse: (request) => { asked.push(request); return refuse; } });
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
    await interceptDocuments(context, page, ['127.0.0.1'], { rewrite: withoutIntegrity });
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
    assert.deepEqual(waiting, ['Wartet im Chrome-Fenster auf dich: Soll das der neue Testplan werden?'], 'once in the terminal, with the question the card asks');
    // The panel is the one place that says so: no pill in the header, no status word in the application bar.
    assert.equal(await bench.page.locator('#state, #browserState, .pill').count(), 0);

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

test('chat: a decision card with checkboxes, none ticked; the ticked ones go along with the button, then the card leaves the panel', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat } = await open(t);
    const frame = bench.chatFrame();
    const card = { title: 'Prüflauf bestanden', facts: [], question: 'Soll das der neue Testplan werden?', picks: { title: 'Look fester Bildschirme vergleichen?', text: 'Sicher ist das nicht.', items: [{ id: 'S2', label: 'Formular' }, { id: 'S3', label: 'Hilfe' }] } };
    const options = [{ id: 'adopt', label: 'Testplan übernehmen (3 Schritte)', primary: true }, { id: 'discard', label: 'Entwurf verwerfen', confirm: 'Wirklich verwerfen?' }];
    const chosen = chat.choosePicks('deciding', 'Text fürs Protokoll', options, card);
    assert.ok(await until(() => frame.isVisible('.decision fieldset.picks')), 'the checkboxes are in the card');
    assert.equal(await frame.textContent('.decision fieldset.picks legend'), 'Look fester Bildschirme vergleichen?');
    const boxes = frame.locator('.decision fieldset.picks input[type=checkbox]');
    assert.equal(await boxes.count(), 2);
    assert.deepEqual(await boxes.evaluateAll((list) => list.map((box) => box.checked)), [false, false], 'none ticked');
    // Reachable by its label, as a screen reader names it.
    await frame.getByRole('checkbox', { name: 'S3 Hilfe' }).check();
    await frame.locator('#choices button', { hasText: 'Testplan übernehmen' }).click();
    assert.deepEqual(await chosen, { choice: 'adopt', picked: ['S3'] });
    assert.ok(await until(async () => (await frame.locator('#card .decision').count()) === 0), 'the card leaves the panel after the choice');
    assert.ok(await until(async () => /Testplan übernehmen \(3 Schritte\): S3/.test(await frame.textContent('#hist .h-card .t'))), 'the history says what was ticked');
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
    assert.ok(await until(async () => /^Nur Testdaten verwenden/.test(await frame.textContent('#status'))), 'the panel warns: test data only');
    assert.match(await frame.textContent('#toggle'), /Vorführung beenden/);
    // The checkpoint is a slash command and Alt+Enter, only while demonstrating.
    assert.match(await frame.textContent('#mark'), /^\/checkpointNur während du vorführstAlt ↵$/);
    assert.match(await frame.getAttribute('#input', 'placeholder'), /Alt\+↵ = Prüfpunkt/);
    chat.progress('Klick: Weiter');
    assert.ok(await until(async () => (await frame.locator('#lines li').last().textContent()).startsWith('Klick: Weiter')), 'every click shows in the panel');
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

test('workbench: no transport chip in the header; the panel says recording and paused, F9 stays at "Pause"', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    const page = bench.page;
    assert.equal(await page.locator('#transport, header .tp').count(), 0, 'one status display: the panel');
    assert.ok(await until(async () => (await frame.textContent('#workLabel')) === 'Claude Code arbeitet'));
    await bench.transport('record');
    assert.ok(await until(async () => (await frame.textContent('#workLabel')) === 'Claude Code nimmt auf'), 'recording, in the working block');
    assert.match(await frame.textContent('#toggle'), /^Pause\s*F9$/, 'the F9 hint under what runs');
    chat.enter('paused');
    assert.ok(await until(async () => (await frame.textContent('#workLabel')) === 'Pausiert'), 'paused, in the working block');
    chat.leave();
    assert.ok(await until(async () => (await frame.textContent('#workLabel')) === 'Claude Code nimmt auf'));
    await bench.transport('play');
    assert.ok(await until(async () => (await frame.textContent('#workLabel')) === 'Claude Code arbeitet'), 'only recording is named');
    // Reloading the whole workbench (here by the app itself) keeps it.
    await bench.transport('record');
    await bench.view.frame.evaluate((url) => { top.location.href = url; }, `${base}/weiter`);
    assert.ok(await until(async () => (await bench.chatFrame().textContent('#workLabel').catch(() => '')) === 'Claude Code nimmt auf'), 'after the reload');
    assert.equal(await page.locator('#transport').count(), 0);
    return undefined;
});

test('workbench: an action kind gets the width it needs in the 240 px steps column, without ellipsis', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off', steps: 'open' }));
    t.after(() => writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' })));
    const { bench } = await open(t);
    const page = bench.page;
    const kinds = ['select', 'click', 'fill', 'check', 'goto', 'press', 'Klick', 'Doppelklick', 'Hochladen', 'Prüfung'];
    await bench.steps([{ id: 'S1', name: 'Auf morgen schieben', points: kinds.map((kind, index) => ({ id: `a${index}`, kind, label: '„Tomorrow“' })) }]);
    await page.click('#steps>li[data-id=S1]>.head>button.text');
    assert.ok(await until(() => page.isVisible('#steps>li[data-id=S1] .pts li[data-id=a0]')));
    // 240 px from 1500 px on, 220 px below.
    for (const [width, column] of [[1600, 240], [1280, 220]]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await until(async () => Math.round((await page.locator('#stepsCard').boundingBox()).width) === column), `${column} px`);
        const shown = await page.$$eval('#steps>li[data-id=S1] .pts .kind', (list) => list.map((node) => {
            const name = node.parentElement.querySelector('.name').getBoundingClientRect();
            const box = node.getBoundingClientRect();
            return { kind: node.textContent, cut: node.scrollWidth > node.clientWidth, overlaps: box.right > name.left + 0.5 };
        }));
        assert.deepEqual(shown, kinds.map((kind) => ({ kind, cut: false, overlaps: false })), `${column} px`);
        // The names start in one column.
        const lefts = await page.$$eval('#steps>li[data-id=S1] .pts .name', (list) => list.map((node) => Math.round(node.getBoundingClientRect().left)));
        assert.equal(new Set(lefts).size, 1);
    }
    return undefined;
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
    assert.match(await frame.textContent('#hist'), /Gespeichert: caw\/tests\/t\.yaml/, 'in the history');
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
    // Before the run's mode is known the header names the test once: in the breadcrumb, no badge repeating it.
    assert.equal(await bench.page.textContent('#crumbTest'), 'morning-errand');
    assert.equal(await bench.page.isVisible('#title'), false, 'no badge with the same name');
    assert.equal((await bench.page.textContent('header.top')).split('morning-errand').length - 1, 1, 'the name once');
    await bench.facts([['', 'Claude Code nimmt morning-errand auf', 'Claude Code nimmt auf'], ['Umgebung', 'staging']]);
    assert.ok(await until(async () => (await bench.page.textContent('#title')) === 'Claude Code nimmt auf'));
    assert.equal(await bench.page.getAttribute('#title', 'title'), 'Claude Code nimmt morning-errand auf');
    assert.equal(await bench.page.textContent('#crumbTest'), 'morning-errand');
    // The facts by their values, the label in title and aria-label.
    assert.deepEqual(await bench.page.locator('#facts li').allTextContents(), ['staging']);
    assert.equal(await bench.page.getAttribute('#facts li', 'aria-label'), 'Umgebung: staging');
    // Without a mode no badge (the sentence would repeat the test); the sentence is the breadcrumb's tooltip.
    await bench.facts([['', 'morning-errand wird ohne Claude Code geprüft']]);
    assert.ok(await until(async () => (await bench.page.locator('#facts li').count()) === 0));
    assert.equal(await bench.page.isVisible('#title'), false);
    assert.equal(await bench.page.getAttribute('#crumbTest', 'title'), 'morning-errand wird ohne Claude Code geprüft');
    assert.equal((await bench.page.textContent('header.top')).split('morning-errand').length - 1, 1, 'the name once');
    // While the settings are open the badge says so, and comes back with the run's mode.
    await bench.facts([['', 'Claude Code behebt S2 von morning-errand', 'Claude Code behebt S2']]);
    await bench.page.keyboard.press('Control+Comma');
    assert.equal(await bench.page.textContent('#title'), 'Einstellungen');
    await bench.page.keyboard.press('Escape');
    assert.equal(await bench.page.textContent('#title'), 'Claude Code behebt S2');
    assert.equal(await bench.page.isVisible('#title'), true);
    // Settings over a run without a mode: the badge says "Einstellungen" and goes again.
    await bench.facts([['', 'morning-errand wird ohne Claude Code geprüft']]);
    await bench.page.keyboard.press('Control+Comma');
    assert.equal(await bench.page.textContent('#title'), 'Einstellungen');
    await bench.page.keyboard.press('Escape');
    assert.equal(await bench.page.isVisible('#title'), false);
});

test('workbench: the steps are hidden until shown; "Schritte" carries the tally; a step unfolds its actions, a failed one by itself; the choice is remembered', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    // No own choice yet.
    writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' }));
    t.after(() => writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' })));
    const { bench } = await open(t);
    const page = bench.page;
    assert.equal(await page.isVisible('#stepsCard'), false, 'hidden by default');
    assert.equal(await page.getAttribute('#stepsToggle', 'aria-expanded'), 'false');
    assert.equal(await page.textContent('#tally'), 'noch keine');
    await bench.steps([{ id: 'S1', name: 'Eins', points: [{ id: 'a', kind: 'click', label: 'Weiter' }] }, { id: 'S2', name: 'Zwei', points: [{ id: 'b', kind: 'check', label: 'Da' }] }]);
    assert.equal(await page.textContent('#tally'), '0/2');
    await bench.step('S1', 'running');
    assert.equal(await page.textContent('#tally'), '● 0/2');
    await bench.step('S1', 'pass');
    assert.equal(await page.isVisible('#stepsCard'), false, 'known steps do not show it');
    await bench.step('S2', 'running');
    await bench.step('S2', 'fail', 'weg');
    await bench.mood('fail');
    assert.equal(await page.textContent('#tally'), '✗ 1/2');
    assert.ok(await until(() => page.isVisible('#stepsCard')), 'a failed step shows them, without an own choice');
    assert.equal(await page.isVisible('#steps>li[data-id=S2] .pts li[data-id=b]'), true, 'the failed step unfolded');
    assert.equal(await page.isVisible('#steps>li[data-id=S1] .pts li[data-id=a]'), false, 'the others only as a line');
    await page.click('#steps>li[data-id=S1]>.head>button.text');
    assert.equal(await page.isVisible('#steps>li[data-id=S1] .pts li[data-id=a]'), true, 'a click unfolds its actions');
    assert.equal(await page.getAttribute('#steps>li[data-id=S1]>.head>button.text', 'aria-expanded'), 'true');
    await page.keyboard.press('F4');
    assert.ok(await until(async () => !(await page.isVisible('#stepsCard'))), 'F4 hides them');
    assert.equal(readPrefs().steps, 'closed', 'remembered');
    await page.click('#stepsToggle');
    assert.ok(await until(() => page.isVisible('#stepsCard')));
    assert.equal(await page.getAttribute('#stepsToggle', 'aria-expanded'), 'true');
    assert.equal(readPrefs().steps, 'open');
    return undefined;
});

test('workbench: one status display: the panel says what runs; no pill in the header, no status word in the application bar', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    assert.equal(await bench.page.locator('#state, #browserState, .pill').count(), 0);
    chat.testing();
    assert.ok(await until(async () => (await frame.textContent('#workLabel')) === 'caw arbeitet'));
    assert.equal(await frame.textContent('#status'), 'Testlauf ohne Claude Code.');
    assert.equal(await frame.locator('#bar').count(), 0, 'no status line under it');
    assert.equal(await frame.isVisible('#thinking'), false, 'no second spinner');
    return undefined;
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

test('workbench: the chat over the app shows the newest message that came while it was hidden', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat } = await open(t);
    const page = bench.page;
    chat.develop('Bereit.', [{ id: 'end', label: 'Ende' }]);
    await bench.chatFrame().waitForFunction(() => document.body.dataset.state === 'developing');
    for (let i = 1; i <= 12; i++) chat.say(`Nachricht ${i}: ${'Text '.repeat(30)}`);
    await bench.solo(true);
    await page.click('#chatPop');
    assert.ok(await until(() => page.evaluate(() => document.body.classList.contains('chat-pop'))));
    await page.click('#chatPop');
    assert.ok(await until(async () => !(await page.evaluate(() => document.body.classList.contains('chat-pop')))));
    chat.say('Hallo');
    assert.ok(await until(() => page.evaluate(() => !document.querySelector('#chatPop .new').hidden)), 'a dot');
    await page.click('#chatPop');
    const lastInView = () => bench.chatFrame().evaluate(() => {
        const box = document.getElementById('now').getBoundingClientRect();
        const last = [...document.querySelectorAll('#thread .message')].at(-1).getBoundingClientRect();
        return last.bottom <= box.bottom + 1 && last.top >= box.top - 1;
    });
    assert.ok(await until(lastInView), 'the newest message is in view');
    return undefined;
});

test('workbench: Ctrl+J in the application while developing puts the cursor into the chat input over the app', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat } = await open(t);
    assert.ok(await until(async () => (await bench.view.locator('#feld').count()) === 1), 'application loaded');
    chat.develop('Bereit.', [{ id: 'end', label: 'Ende' }]);
    await bench.chatFrame().waitForFunction(() => document.body.dataset.state === 'developing');
    await bench.solo(true);
    await bench.view.locator('#feld').press('Control+j');
    assert.ok(await until(() => bench.page.evaluate(() => document.body.classList.contains('chat-pop'))), 'the chat over the app');
    assert.ok(await until(() => bench.chatFrame().evaluate(() => document.activeElement?.id === 'input')), 'the cursor in the chat input');
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
    await page.keyboard.press('ControlOrMeta+Comma');
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
    await chat.locator('body').press('ControlOrMeta+Comma');
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
    await page.evaluate(() => document.body.classList.remove('fold-steps'));
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
const chatReady = async (t, options) => {
    const opened = await open(t, options);
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
    assert.equal(await frame.locator('#thread .message.checkpoint').count(), 2);
    // /element asks the host to pick (its crosshair in the application), like the former Element button.
    await frame.evaluate(() => { const binding = window.__cawChat; window.__cawChat = (event) => { window.sent = [...(window.sent ?? []), event.type]; return binding(event); }; });
    await frame.fill('#input', '/el');
    await bench.page.keyboard.press('Enter');
    assert.deepEqual(await frame.evaluate(() => window.sent), ['pick']);
    assert.equal(await frame.inputValue('#input'), '');
    return undefined;
});

test('chat: the main action sits in the panel with Ctrl+Enter; while Claude Code works it is "Pause F9" under what runs', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    // Running: a link with F9 next to the status, no button row under the input.
    assert.ok(await until(() => frame.evaluate(() => document.body.dataset.state === 'running')));
    assert.equal(await frame.getAttribute('#toggle', 'class'), 'lnk');
    assert.match(await frame.textContent('#toggle'), /^Pause\s*F9$/);
    assert.equal(await frame.evaluate(() => document.getElementById('toggle').parentElement.id), 'now', 'in the panel, under what runs');
    assert.equal(await frame.locator('#form button').evaluateAll((list) => list.filter((b) => b.offsetParent !== null).map((b) => b.id).join(',')), 'send', 'only the send arrow in the field');
    assert.equal(await frame.locator('#hint').count(), 0, 'no line that only explains the keys');
    assert.equal(await frame.textContent('#inputLabel'), 'Hinweis an Claude Code', 'while the agent works: a hint');
    // Asking: "Fertig" full width above the input, Ctrl+Enter presses it.
    const lines = [];
    chat.enter('asking');
    assert.ok(await until(() => frame.evaluate(() => document.body.dataset.state === 'asking')));
    assert.match(await frame.getAttribute('#toggle', 'class'), /btn btn-p/);
    assert.match(await frame.textContent('#toggle'), new RegExp(`^Fertig\\s*${MOD} ↵$`));
    const [toggle, form] = await Promise.all([frame.locator('#toggle').boundingBox(), frame.locator('#form').boundingBox()]);
    assert.ok(toggle.y + toggle.height <= form.y, 'above the input');
    assert.ok(Math.abs(toggle.width - form.width) < 2, 'full width');
    const next = chat.operator.nextLine().then((line) => lines.push(line));
    await frame.focus('#input');
    await bench.page.keyboard.press('ControlOrMeta+Enter');
    await next;
    assert.deepEqual(lines, [''], 'Ctrl+Enter is "Fertig"');
    // Planning: "Plan freigeben" is the one main action, Ctrl+Enter approves it.
    let answer;
    const planned = chat.plan({ steps: [{ id: 'S1', name: 'Eins', do: 'Klick', expect: 'Da' }] }).then((value) => { answer = value; });
    assert.ok(await until(() => frame.isVisible('#approve')));
    assert.equal(await frame.isVisible('#toggle'), false);
    assert.match(await frame.getAttribute('#approve', 'class'), /primary big btn btn-p/);
    await frame.focus('#input');
    await bench.page.keyboard.press('ControlOrMeta+Enter');
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

test('chat: the end card has one main action, closing the window; the report beside it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    await chat.finished({ kind: 'pass', report: join(dir, 'x.md'), text: '4 von 4 Schritten bestanden.', command: 'caw run t' });
    chat.human.closed();
    const lingering = chat.linger(60000);
    assert.ok(await until(() => frame.isVisible('#next.on')));
    assert.equal(await frame.textContent('#nextTitle'), 'Lauf bestanden');
    assert.equal(await frame.textContent('#nextText'), '4 von 4 Schritten bestanden.');
    assert.match(await frame.textContent('#nextCmd'), /Neuer Lauf: caw run t/);
    assert.ok(await until(async () => (await frame.getAttribute('#closeWindow', 'class'))?.includes('btn-p')), 'closing is the main action');
    assert.equal(await frame.isVisible('#report'), true, 'the report beside it');
    assert.match(await frame.getAttribute('#report', 'class'), /btn-s/);
    assert.equal(await frame.isVisible('#nextMore'), false, 'nothing behind More');
    await frame.click('#closeWindow');
    await lingering;
    return undefined;
});

test('chat: the end card\'s command wraps only between its words, keeps every space and draws "--" in two cells', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    const command = 'caw run first-errand --env local';
    await chat.finished({ kind: 'pass', report: join(dir, 'x.md'), text: '4 von 4 Schritten bestanden.', command });
    chat.human.closed();
    const lingering = chat.linger(60000);
    assert.ok(await until(() => frame.isVisible('#next.on')));
    // Narrow enough that the command needs two lines, as in the workbench's chat column.
    const seen = await frame.evaluate(() => {
        const code = document.querySelector('#nextCmd code');
        code.closest('.cmd').style.width = '200px';
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
    assert.match(await frame.textContent('#nextCmd'), /Den Fehler im Test festhalten: caw record bug-x/);
    assert.equal(await frame.getAttribute('#closeWindow', 'class'), 'btn btn-p');
    assert.equal(await frame.getAttribute('#report', 'class'), 'btn btn-s');
    assert.equal(await frame.locator('#nextMore').count(), 0);
    await frame.click('#closeWindow');
    await lingering;
    return undefined;
});

test('chat: while something runs the panel shows the last lines, notices too; the history keeps them; the agent starting shows the time; the token notice is a card', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    chat.notice('Gespeichert: caw/tests/t.yaml');
    assert.ok(await until(async () => (await frame.locator('#lines li').count()) === 1));
    assert.equal(await frame.textContent('#lines li span:nth-child(2)'), 'Gespeichert: caw/tests/t.yaml');
    assert.equal(await frame.locator('#hist .h-line[data-who=notice] svg').count(), 1, 'a quiet icon line in the history');
    chat.starting('Starte Claude');
    assert.ok(await until(async () => /^0:0\d$/.test(await frame.textContent('#lines li:last-child small'))), 'with the time since');
    chat.starting('Starte Claude');
    await pause(200);
    assert.equal(await frame.locator('#lines li', { hasText: 'Starte Claude' }).count(), 1, 'preparing and starting show as one line');
    for (let i = 0; i < 6; i += 1) chat.progress(`Aktion ${i}`);
    assert.ok(await until(async () => (await frame.locator('#lines li').count()) === 4), 'only the last few lines');
    chat.say('Ich schaue.');
    assert.ok(await until(() => frame.isVisible('#thread .message.claude')));
    assert.match(await frame.textContent('#thread .message.claude .who'), /^Claude Code\d\d:\d\d$/, 'with the time');
    const gate = chat.choose('choosing', 'Jetzt arbeitet Claude, das kostet Token.', [{ id: 'go', label: 'Weiter', primary: true }, { id: 'always', label: 'Nicht mehr fragen' }, { id: 'stop', label: 'Ohne Claude Code weiter' }], { kind: 'tokens' });
    assert.ok(await until(() => frame.isVisible('#card .message.tokens')));
    assert.equal(await frame.textContent('.message.tokens strong'), 'Jetzt arbeitet Claude, das kostet Token.');
    assert.equal(await frame.isVisible('#work'), false, 'the card instead of the lines');
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
    await page.click('#stepsToggle');
    await page.click('#steps>li[data-id=claude]>.head>button.text');
    t.after(() => writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' })));
    const item = page.locator('#steps li[data-id=claude] .pts>li[data-id=c1]');
    assert.equal(await item.getAttribute('title'), 'Read: a\nRead: b');
    assert.equal(await item.locator('.det').isVisible(), false, 'folded');
    // Nothing runs, S1 waits far above: the latest action stays in view all the same.
    assert.ok(await until(() => page.evaluate(() => { const track = document.getElementById('track'); const box = track.getBoundingClientRect(); const r = document.querySelector('#steps li[data-id=claude] .pts>li[data-id=c1]').getBoundingClientRect(); return track.scrollTop > 0 && r.top >= box.top && r.bottom <= box.bottom; })), 'the latest action in view');
    await item.locator('.name').click();
    assert.deepEqual(await item.locator('.det li').allTextContents(), ['p/a.mjs', 'p/b.md']);
    // A question in the conversation: "working" from the message until the agent waits for the person again (run.mjs says so).
    const answer = chat.develop('Bereit.', [{ id: 'end', label: 'Ende' }]);
    await frame.waitForFunction(() => document.body.dataset.state === 'developing');
    await frame.fill('#input', 'Warum?');
    await frame.press('#input', 'Enter');
    await answer;
    chat.develop(undefined, [{ id: 'end', label: 'Ende' }]);
    await pause(300);
    assert.equal(await frame.isVisible('#thinking'), false, 'nobody works yet: no spinner of its own');
    chat.working(true);
    assert.ok(await until(() => frame.isVisible('#thinking')), 'working once an agent hears it');
    chat.logLine('[+1.0s] > Read: {"file_path":"/p/a.mjs"}');
    chat.say('Verstanden, ich passe das an.');
    await pause(300);
    assert.equal(await frame.isVisible('#thinking'), true, 'an interim message does not end it');
    chat.working(false);
    assert.ok(await until(async () => !(await frame.isVisible('#thinking'))), 'gone once the agent waits for the person');
    return undefined;
});

test('chat: an answered card leaves the panel as one line in the history with the answer and who gave it; no echo of the button', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    let answerFromOutside = null;
    const desk = { open: (decision, answer) => { answerFromOutside = answer; }, settle: () => {} };
    const { bench, chat, logPath } = await open(t, { desk });
    const frame = bench.chatFrame();
    const chosen = chat.choose('deciding', 'Text', [{ id: 'adopt', label: 'Testplan übernehmen (2 Schritte)', primary: true }, { id: 'discard', label: 'Entwurf verwerfen' }], { title: 'Prüflauf bestanden' }, { id: 'plan.adopt' });
    assert.ok(await until(() => frame.isVisible('#card .decision')));
    await frame.click('#choices button.primary');
    assert.equal(await chosen, 'adopt');
    assert.ok(await until(async () => (await frame.locator('#card > *').count()) === 0), 'the panel is free again');
    assert.equal(await frame.locator('.message.human').count(), 0, 'no "You" bubble with the button');
    const first = frame.locator('#hist .h-card').first();
    assert.equal(await first.locator('.t').textContent(), 'Testplan übernehmen (2 Schritte)');
    assert.equal(await first.locator('small').textContent(), 'Prüflauf bestanden');
    assert.equal(await first.locator('.mk').textContent(), '✓');
    // Answered by caw (a draft in the window): the line says so.
    const auto = chat.choose('deciding', 'Plan', [{ id: 'approve', label: 'Plan freigeben', primary: true }], { title: 'Ablaufplan' }, { id: 'plan.approve' });
    assert.ok(await until(() => frame.isVisible('#card .decision')));
    answerFromOutside({ option: 'approve', by: 'auto' });
    assert.equal(await auto, 'approve');
    assert.ok(await until(async () => (await frame.locator('#hist .h-card').count()) === 2 && (await frame.locator('#card > *').count()) === 0));
    assert.equal(await frame.locator('#hist .h-card').last().locator('.tx').textContent(), 'Plan freigebenvon caw · Ablaufplan');
    // chat.log keeps the record: the button and who answered.
    assert.match(readFileSync(logPath, 'utf8'), /human: Testplan übernehmen \(2 Schritte\)[\s\S]*notice: Plan freigeben: von caw gewählt/);
    return undefined;
});

test('chat: earlier windows of the same run are not replayed into the panel; the history has them under their window', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const at = Date.now() - 60000;
    const transcript = [['window', '', null, at], ['activity', 'Task gelesen', null, at], ['result', 'Alte Karte', { kind: 'result', tone: 'fail', title: 'Alte Karte', phase: 'test' }, at], ['human', 'Weiter', { answer: true }, at], ['notice', 'Gleich öffnet sich ein neues Fenster.', null, at], ['claude', 'Ich war hier.', null, at]];
    const { bench, chat } = await open(t, { transcript });
    const frame = bench.chatFrame();
    await frame.waitForFunction(() => typeof window.setStatus === 'function');
    assert.ok(await until(async () => (await frame.locator('#hist > li').count()) > 0));
    assert.equal(await frame.locator('#card > *, #thread > *, #lines > *').count(), 0, 'nothing of before in the panel');
    assert.deepEqual(await frame.$$eval('#hist .h-sep', (list) => list.map((li) => li.textContent)), ['Fenster 1', 'Fenster 2']);
    assert.match(await frame.textContent('#hist'), /Task gelesen.*Weiter.*Alte Karte.*Gleich öffnet sich ein neues Fenster\..*Ich war hier\./s);
    // This window's entries go into the panel.
    chat.notice('Jetzt');
    assert.ok(await until(async () => (await frame.locator('#lines li').count()) === 1));
    assert.equal(await frame.textContent('#histCount'), '1 erledigt · 5 Einträge');
    return undefined;
});

test('chat: "Verlauf" at the bottom counts entries and answered cards; it opens over the panel, a line opens its card, Esc closes it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    assert.equal(await frame.textContent('#histCount'), '');
    chat.progress('Klick: Weiter');
    chat.notice('Gespeichert: caw/tests/t.yaml');
    const chosen = chat.choose('deciding', 'Text', [{ id: 'go', label: 'Los', primary: true }], { title: 'Karte' });
    assert.ok(await until(() => frame.isVisible('#choices button.primary')));
    await frame.click('#choices button.primary');
    await chosen;
    assert.ok(await until(async () => (await frame.textContent('#histCount')) === '1 erledigt · 3 Einträge'));
    assert.equal(await frame.isVisible('#history'), false);
    await frame.click('#histBtn');
    assert.ok(await until(() => frame.isVisible('#history')));
    assert.equal(await frame.getAttribute('#histBtn', 'aria-expanded'), 'true');
    assert.deepEqual(await frame.$$eval('#hist > li', (list) => list.map((li) => li.className)), ['h-act', 'h-line', 'h-line h-card']);
    await frame.click('#hist .h-card summary');
    assert.ok(await until(() => frame.isVisible('#hist .h-card .message.decision')), 'the card itself');
    await bench.page.keyboard.press('Escape');
    assert.ok(await until(async () => !(await frame.isVisible('#history'))));
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'histBtn');
    assert.equal(await frame.evaluate(() => document.body.classList.contains('arming')), false, 'Esc only closed the history');
    return undefined;
});

test('workbench: the comparison with the target design is a page of its own (F7, Esc); tabs side by side, overlaid and differences only; a card marks its element in both images; a reload keeps it and compares anew; a capture shows the app', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, context } = await open(t);
    const page = bench.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    // Two images at the recorded size: the app with a red button, the design with a green one at the same place.
    const maker = await context.newPage();
    await maker.setViewportSize({ width: 1280, height: 720 });
    const shot = async (color) => {
        await maker.setContent(`<body style="margin:0;background:#fff"><button style="position:absolute;left:100px;top:200px;width:160px;height:40px;background:${color}">Speichern</button></body>`);
        return { src: `data:image/png;base64,${(await maker.screenshot()).toString('base64')}`, width: 1280, height: 720 };
    };
    const app = await shot('#e5533a');
    const design = await shot('#5f8f6b');
    await maker.close();
    const button = { x: 100, y: 200, width: 160, height: 40 };
    const data = (deviations, met = false) => ({
        step: { id: 'S2', name: 'Notiz speichern' }, file: 'design/note.html', viewport: { width: 1280, height: 720 }, run: '21-45-37', met,
        design, app, deviations, extra: ['link "Hilfe"'],
        steps: [{ id: 'S1', name: 'Anmelden', status: 'met', count: 0 }, { id: 'S2', name: 'Notiz speichern', status: met ? 'met' : 'deviations', count: deviations.length }, { id: 'S3', name: 'Exportieren', status: 'pending' }],
    });
    const two = [
        { kind: 'style', text: 'button "Speichern": background-color #5f8f6b → #e5533a', design: button, app: button },
        { kind: 'missing', text: 'heading "Notiz"', design: { x: 100, y: 120, width: 200, height: 30 } },
    ];
    await bench.viewport({ width: 1280, height: 720 });
    await bench.design(data(two), { open: true });
    const state = () => page.evaluate(() => ({
        design: document.body.dataset.design,
        shown: !document.getElementById('cmp').hidden,
        benchInert: document.querySelector('#bench>.panes').inert,
        view: document.getElementById('cmpPanel').dataset.view,
        tabs: [...document.querySelectorAll('.cmp-tabs [role=tab]')].map((tab) => `${tab.textContent}:${tab.getAttribute('aria-selected')}:${tab.tabIndex}`),
        shots: [...document.querySelectorAll('#cmpPanel .shot-s')].map((box) => box.dataset.kind),
        focus: document.activeElement?.id ?? '',
        title: document.getElementById('cmpStep').textContent,
        badge: document.getElementById('cmpBadge').textContent,
        cards: [...document.querySelectorAll('#cmpCards .dev')].map((card) => `${card.querySelector('.num').textContent} ${card.querySelector('.kind').textContent}:${card.getAttribute('aria-pressed')}`),
        rail: [...document.querySelectorAll('#cmpSteps li')].map((li) => `${li.querySelector('.sid').textContent} ${li.querySelector('.stt').textContent}${li.getAttribute('aria-current') === 'step' ? ' *' : ''}`),
        build: !document.getElementById('cmpBuild').hidden,
    }));
    assert.ok(await until(async () => (await state()).shown), 'the comparison opens on the first comparison');
    const first = await state();
    assert.equal(first.design, 'open');
    assert.equal(first.benchInert, true, 'the workbench below is inert');
    assert.equal(first.view, 'side');
    assert.deepEqual(first.tabs, ['Nebeneinander:true:0', 'Überlagert:false:-1', 'Nur Unterschiede:false:-1']);
    assert.deepEqual(first.shots, ['app', 'design']);
    assert.equal(first.focus, 'cmpStep', 'the focus is on the page');
    assert.equal(first.title, 'S2 Notiz speichern');
    assert.equal(first.badge, 'nicht erfüllt');
    assert.deepEqual(first.cards, ['1 Stil:true', '2 Fehlt:false'], 'numbered, the first selected');
    assert.deepEqual(first.rail, ['S1 erfüllt', 'S2 2 Abw. *', 'S3 ausstehend']);
    assert.equal(first.build, false, 'nobody answers the build button yet');
    // Nebeneinander (here one above the other, see below): both images at one scale, the selected deviation marked in both.
    const marks = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#cmpPanel .shot-s')].map((box) => [box.dataset.kind,
        [...box.querySelectorAll('.mk-box')].map((mark) => ({ i: mark.dataset.i, left: Math.round(parseFloat(mark.style.left)), top: Math.round(parseFloat(mark.style.top)), width: Math.round(parseFloat(mark.style.width)) }))])));
    const scales = () => page.evaluate(() => [...document.querySelectorAll('#cmpPanel .shot-in')].map((inner) => inner.getBoundingClientRect().width / 1280));
    const [scale] = await scales();
    assert.ok(scale >= 0.75 && scale <= 1, String(scale));
    // The frame lies 2 px around the element's box.
    const at = (value, by = 0) => Math.round(value * scale + by);
    assert.deepEqual(await marks(), { app: [{ i: '0', left: at(100, -2), top: at(200, -2), width: at(160, 4) }], design: [{ i: '0', left: at(100, -2), top: at(200, -2), width: at(160, 4) }] });
    // The second card: missing, so only in the design.
    await page.click('#cmpCards li:nth-child(2) .dev');
    assert.deepEqual((await state()).cards, ['1 Stil:false', '2 Fehlt:true']);
    assert.deepEqual(await marks(), { app: [], design: [{ i: '1', left: at(100, -2), top: at(120, -2), width: at(200, 4) }] });
    assert.match(await page.locator('#cmpCards li:nth-child(2) small').textContent(), /Fehlt in der App/);
    await page.click('#cmpCards li:nth-child(1) .dev');
    // Scrolling one image scrolls the other (once the card's own scrolling is over).
    await pause(300);
    await page.evaluate(() => { document.querySelector('.shot-s[data-kind=app]').scrollTop = 60; });
    assert.ok(await until(() => page.evaluate(() => document.querySelector('.shot-s[data-kind=design]').scrollTop === document.querySelector('.shot-s[data-kind=app]').scrollTop)), 'scrolled together');
    // Tabs: a click, then the arrow keys go round them.
    await page.click('#cmpTab-overlay');
    const overlay = await state();
    assert.equal(overlay.view, 'overlay');
    assert.deepEqual(overlay.shots, ['overlay']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.shot-in img.over')).opacity), '0.5', 'the design half transparent over the app');
    assert.equal(await page.locator('.shot-s[data-kind=overlay] .mk-box').count(), 2, 'the element in the app and in the design');
    await page.keyboard.press('ArrowRight');
    const diff = await state();
    assert.equal(diff.view, 'diff');
    assert.equal(diff.focus, 'cmpTab-diff');
    assert.equal(await page.locator('.shot-s[data-kind=design] .mk-box').count(), 2, 'differences only: every deviation marked');
    assert.equal(await page.locator('.shot-s[data-kind=design] svg mask rect').count(), 3, 'the rest faded, two holes');
    await page.keyboard.press('ArrowRight');
    assert.equal((await state()).view, 'side', 'round again');
    // F7 closes and opens; Esc closes, the workbench is no longer inert.
    await page.keyboard.press('F7');
    assert.ok(await until(async () => (await state()).design === 'closed'));
    assert.equal((await state()).shown, false);
    await page.keyboard.press('F7');
    assert.ok(await until(async () => (await state()).shown));
    await page.keyboard.press('Escape');
    assert.ok(await until(async () => (await state()).design === 'closed'), 'Esc closes it');
    assert.equal((await state()).benchInert, false);
    // A reload keeps it closed and, as the host does, compares anew: the page shows what the host passes then.
    bench.onReload(() => bench.design(data([two[0]])));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(async () => (await state()).design === 'closed'), 'still closed');
    await pause(300);
    await page.keyboard.press('F7');
    assert.ok(await until(async () => (await state()).shown));
    assert.ok(await until(async () => (await state()).rail[1] === 'S2 1 Abw. *'), 'compared anew');
    assert.deepEqual((await state()).cards, ['1 Stil:true']);
    assert.equal((await state()).view, 'side', 'the view stays per window');
    // Open across a reload too.
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(async () => (await state()).shown), 'open after the reload');
    // While the host operates the app the page steps aside.
    await bench.designAside(true);
    assert.equal((await state()).shown, false);
    assert.equal((await state()).benchInert, false);
    await bench.designAside(false);
    assert.equal((await state()).shown, true);
    // A capture of the app: the frame unscaled at its size, over the page.
    const png = await bench.unscaled(() => bench.view.screenshot({ scale: 'css' }));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 720]);
    // The build button, once someone answers it: back to the workbench, the host asked.
    let asked = 0;
    await bench.onDesignBuild(() => { asked += 1; });
    assert.ok(await until(async () => (await state()).build));
    await page.click('#cmpBuild');
    assert.ok(await until(() => asked === 1));
    assert.equal((await state()).design, 'closed');
    // Met: no cards, no build button.
    await bench.design(data([], true), { open: true });
    assert.ok(await until(async () => (await state()).shown));
    const met = await state();
    assert.equal(met.badge, 'erfüllt');
    assert.deepEqual(met.cards, []);
    assert.equal(met.build, false);
    assert.equal(await page.locator('#cmpNone').isVisible(), true);
    // Gone: the page closes, F7 does nothing.
    await bench.design(null);
    assert.ok(await until(async () => (await state()).design === undefined && !(await state()).shown));
    await page.keyboard.press('F7');
    assert.equal((await state()).shown, false);
    assert.equal(await page.evaluate(() => document.getElementById('mDesign').hidden), true);
    return undefined;
});

test('workbench: the comparison starts at the left edge of both images and scrolls sideways to a deviation only when it is out of view', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, context } = await open(t);
    const page = bench.page;
    // So narrow that even one above the other the 75 % images are wider than the panel.
    await page.setViewportSize({ width: 1000, height: 900 });
    const maker = await context.newPage();
    await maker.setViewportSize({ width: 1280, height: 1600 });
    await maker.setContent('<body style="margin:0;background:#f4ece0"><h1 style="position:absolute;left:24px;top:60px;margin:0">Feed the raven</h1></body>');
    const picture = { src: `data:image/png;base64,${(await maker.screenshot()).toString('base64')}`, width: 1280, height: 1600 };
    await maker.close();
    // A whole page, taller than the column. One deviation in the left part (inside the column at the left edge), one far right,
    // both low on the page.
    const near = { x: 450, y: 1300, width: 120, height: 40 };
    const far = { x: 1100, y: 1320, width: 120, height: 40 };
    await bench.viewport({ width: 1280, height: 800 });
    await bench.design({
        step: { id: 'S5', name: 'Notiz' }, file: 'design/note.html', viewport: { width: 1280, height: 800 }, run: '21-45-37', met: false, design: picture, app: picture, extra: [],
        deviations: [{ kind: 'style', text: 'button "Save note": background-color', design: near, app: near }, { kind: 'text', text: 'text: heading "Note" → "Notes"', design: far, app: far }],
        steps: [{ id: 'S5', name: 'Notiz', status: 'deviations', count: 2 }],
    }, { open: true });
    assert.ok(await until(() => page.evaluate(() => !document.getElementById('cmp').hidden)), 'open');
    const view = () => page.evaluate(() => [...document.querySelectorAll('#cmpPanel .shot-s')].map((box) => ({ kind: box.dataset.kind, left: Math.round(box.scrollLeft), top: Math.round(box.scrollTop), width: box.clientWidth, wide: box.scrollWidth })));
    await pause(300);
    const first = await view();
    assert.ok(first.every(({ wide, width }) => wide > width), 'at 75 % wider than the column');
    assert.deepEqual(first.map(({ left }) => left), [0, 0], 'starts at the left edge, the heading whole');
    // The near deviation lies inside the column at the left edge: selecting it only moves the height.
    await page.click('#cmpCards li:nth-child(1) .dev');
    await pause(300);
    const near1 = await view();
    assert.deepEqual(near1.map(({ left }) => left), [0, 0], 'still at the left edge');
    assert.ok(near1.every(({ top }) => top > 0), 'scrolled down to the deviation');
    // The far one: out of view to the right, so the images scroll sideways until it is in view.
    await page.click('#cmpCards li:nth-child(2) .dev');
    await pause(300);
    const second = await view();
    for (const shot of second) {
        const scale = shot.wide / 1280;
        assert.ok(shot.left > 0, 'scrolled sideways');
        assert.ok(far.x * scale >= shot.left && (far.x + far.width) * scale <= shot.left + shot.width, `the element in view: ${JSON.stringify(shot)}`);
    }
    // Back to the near one: in view again from the left edge.
    await page.click('#cmpCards li:nth-child(1) .dev');
    await pause(300);
    assert.deepEqual((await view()).map(({ left }) => left), [0, 0], 'back at the left edge');
    // Another tab starts at the left edge too.
    await page.click('#cmpTab-diff');
    await pause(300);
    assert.deepEqual((await view()).map(({ left }) => left), [0, 0], 'differences only from the left edge');
    return undefined;
});

test('workbench: in a narrow window side by side would fall below 75 %, so app and design stand one above the other in the full width; a wide window keeps them side by side', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, context } = await open(t);
    const page = bench.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    const maker = await context.newPage();
    await maker.setViewportSize({ width: 1280, height: 1600 });
    await maker.setContent('<body style="margin:0;background:#f4ece0"><h1 style="position:absolute;left:24px;top:60px;margin:0">Feed the raven</h1></body>');
    const picture = { src: `data:image/png;base64,${(await maker.screenshot()).toString('base64')}`, width: 1280, height: 1600 };
    await maker.close();
    const high = { x: 100, y: 200, width: 160, height: 40 };
    const low = { x: 300, y: 1300, width: 120, height: 40 };
    await bench.viewport({ width: 1280, height: 800 });
    await bench.design({
        step: { id: 'S5', name: 'Notiz' }, file: 'design/note.html', viewport: { width: 1280, height: 800 }, run: '21-45-37', met: false, design: picture, app: picture, extra: [],
        deviations: [{ kind: 'style', text: 'button "Save note": background-color', design: high, app: high }, { kind: 'text', text: 'text: heading "Note" → "Notes"', design: low, app: low }],
        steps: [{ id: 'S5', name: 'Notiz', status: 'deviations', count: 2 }],
    }, { open: true });
    assert.ok(await until(() => page.evaluate(() => !document.getElementById('cmp').hidden)), 'open');
    const layout = () => page.evaluate(() => ({
        panel: Math.round(document.getElementById('cmpPanel').getBoundingClientRect().width),
        shots: [...document.querySelectorAll('#cmpPanel .shot')].map((shot) => {
            const box = shot.getBoundingClientRect();
            const scroll = shot.querySelector('.shot-s');
            return {
                label: shot.querySelector('.shot-h b').textContent, scale: shot.querySelector('.shot-h .sc').textContent,
                left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), width: Math.round(box.width),
                image: Math.round(shot.querySelector('.shot-in').getBoundingClientRect().width), view: scroll.clientWidth, scrollTop: Math.round(scroll.scrollTop),
                marks: [...scroll.querySelectorAll('.mk-box')].map((mark) => `${mark.dataset.i}@${Math.round(parseFloat(mark.style.left))},${Math.round(parseFloat(mark.style.top))}`),
            };
        }),
    }));
    await pause(300);
    // 1440 wide: a column beside the other would show the 1280 wide app below 75 %, so the images stand one above the other.
    const narrow = await layout();
    const [app, design] = narrow.shots;
    assert.deepEqual([app.label, design.label], ['App', 'Zielbild'], 'labelled');
    assert.ok(design.top >= app.bottom, `the design below the app: ${JSON.stringify(narrow)}`);
    assert.ok(app.width === narrow.panel && design.width === narrow.panel, 'each in the full width');
    const scale = app.image / 1280;
    assert.ok(scale >= 0.75 && scale <= 1 && app.image <= app.view, `fits at a readable scale: ${JSON.stringify(narrow)}`);
    assert.equal(design.image, app.image);
    assert.equal(app.scale, `${Math.round(scale * 100)} %`);
    assert.deepEqual(app.marks, [`0@${Math.round(100 * scale - 2)},${Math.round(200 * scale - 2)}`], 'the marker at the scale');
    assert.deepEqual(design.marks, app.marks);
    // A card scrolls both images to its element; scrolling one scrolls the other.
    await page.click('#cmpCards li:nth-child(2) .dev');
    await pause(300);
    const low1 = await layout();
    assert.ok(low1.shots.every((shot) => shot.scrollTop > 0 && shot.marks[0].startsWith('1@')), `scrolled to the element: ${JSON.stringify(low1)}`);
    await page.evaluate(() => { document.querySelector('.shot-s[data-kind=app]').scrollTop = 40; });
    assert.ok(await until(() => page.evaluate(() => document.querySelector('.shot-s[data-kind=design]').scrollTop === 40)), 'scrolled together');
    // 2560 wide: a column holds the app at 75 % or more, so side by side again.
    await page.setViewportSize({ width: 2560, height: 1440 });
    await pause(300);
    const wide = await layout();
    const [app2, design2] = wide.shots;
    assert.ok(app2.right <= design2.left && app2.top === design2.top, `side by side: ${JSON.stringify(wide)}`);
    assert.ok(app2.image / 1280 >= 0.75 && app2.image <= app2.view, `at 75 % or more, whole: ${JSON.stringify(wide)}`);
    assert.ok(app2.marks.length === 1 && design2.marks.length === 1, 'marked in both');
    return undefined;
});

test('F8 with the focus in the app switches App only, both ways', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const solo = () => page.evaluate(() => document.body.classList.contains('solo'));
    const app = page.frameLocator('#app');
    await app.locator('body').click();
    await page.keyboard.press('F8');
    assert.ok(await until(solo), 'App only from the app');
    await app.locator('body').click();
    await page.keyboard.press('F8');
    assert.ok(await until(async () => !(await solo())), 'and back');
    return undefined;
});

test('workbench: below 1000 px the comparison page\'s rail lies across the top with every step\'s name and status, folded or not (there is no toggle there)', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    await page.setViewportSize({ width: 900, height: 800 });
    const pixel = { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', width: 1, height: 1 };
    await bench.design({ step: { id: 'S2', name: 'Speichern' }, file: 'design/s2.html', viewport: { width: 1, height: 1 }, run: 'r', met: true, design: pixel, app: pixel, deviations: [], extra: [],
        steps: [{ id: 'S2', name: 'Speichern', status: 'met', count: 0 }, { id: 'S3', name: 'Exportieren', status: 'pending' }] }, { open: true });
    assert.ok(await until(() => page.evaluate(() => !document.getElementById('cmp').hidden)), 'open');
    const shown = () => page.evaluate(() => ({
        toggle: getComputedStyle(document.getElementById('cmpRailToggle')).display,
        texts: [...document.querySelectorAll('#cmpSteps li')].map((li) => [...li.querySelectorAll('.nm, .stt')].map((node) => (node.getBoundingClientRect().width > 4 ? node.textContent : '')).join(' · ')),
    }));
    assert.deepEqual(await shown(), { toggle: 'none', texts: ['Speichern · erfüllt', 'Exportieren · ausstehend'] });
    return undefined;
});

test('F7 after the comparison gave the focus back to the app opens it again (as a message, a task later); Esc then closes it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const page = bench.page;
    const pixel = { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', width: 1, height: 1 };
    // As open --design: the host drove the app through the step, the focus is in the app when the page opens.
    await page.frameLocator('#app').locator('#go').click();
    await bench.design({ step: { id: 'S2', name: 'Speichern' }, file: 'design/s2.html', viewport: { width: 1, height: 1 }, run: 'r', met: true, design: pixel, app: pixel, deviations: [], extra: [], steps: [] }, { open: true });
    const state = () => page.evaluate(() => ({ design: document.body.dataset.design, focus: document.activeElement?.id ?? '' }));
    assert.ok(await until(async () => (await state()).design === 'open'));
    await page.keyboard.press('F7');
    assert.deepEqual(await state(), { design: 'closed', focus: 'app' }, 'closed, the focus back in the app');
    await page.keyboard.press('F7');
    assert.ok(await until(async () => (await state()).design === 'open'), 'F7 in the app reaches the workbench');
    assert.equal((await state()).focus, 'cmpStep');
    await page.keyboard.press('Escape');
    assert.ok(await until(async () => (await state()).design === 'closed'));
    return undefined;
});

test('console tools in the app context too (the DevTools switch there after picking an element); an app keeps its own caw', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t);
    const app = bench.page.frames().find((frame) => frame.name() === 'caw-app');
    assert.equal(await app.evaluate(() => caw === top.caw && typeof caw.help === 'function'), true);
    assert.equal(await app.evaluate(() => { window.caw = 'own'; return caw; }), 'own', 'an assignment by the app wins');
    assert.equal(await bench.page.evaluate(() => typeof window.caw.help), 'function', 'the workbench keeps its tools');
    return undefined;
});

test('chat: an advice card starts with its icon and heading, never with "null" (every icon the chat uses exists)', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    chat.advice({ side: 'test', title: 'Answer in German', target: 'home/caw.md (personal)', reason: 'Because.', changes: [{ label: 'Section "Language"', before: '', after: '- Answer me in German.' }] }, [{ id: 'adopt', label: 'Übernehmen', primary: true }]);
    assert.ok(await until(() => frame.isVisible('.message.advice')));
    assert.match(await frame.evaluate(() => document.querySelector('.message.advice').innerText), /^Empfehlung für den Test/i);
    assert.equal(await frame.locator('.message.advice strong svg').count(), 1, 'the agent icon');
    chat.say('Hallo.');
    assert.ok(await until(async () => (await frame.locator('#thread .message.claude .who svg').count()) === 1), 'the sender has its icon too');
    return undefined;
});

test('chat: an exception while the answer from the window is processed (the desk fails to settle) goes to stderr and chat.log instead of vanishing in Playwright', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const errors = [];
    t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
    const desk = { open: () => {}, settle: () => { throw new Error('EPERM: operation not permitted, rename decision.json'); } };
    const { bench, chat, logPath } = await open(t, { desk });
    const frame = bench.chatFrame();
    void chat.choose('deciding', 'Beheben?', [{ id: 'fix', label: 'Beheben lassen', primary: true }], { title: 'Rot' }, { id: 'fix-or-not' });
    assert.ok(await until(() => frame.isVisible('#choices button')));
    await frame.locator('#choices button', { hasText: 'Beheben lassen' }).click();
    assert.ok(await until(() => errors.some((line) => line.includes('EPERM: operation not permitted, rename decision.json'))), 'on stderr');
    assert.match(errors.find((line) => line.includes('EPERM')), /^caw: Der Chat konnte die Antwort aus dem Fenster nicht verarbeiten \(choose\): /);
    assert.match(readFileSync(logPath, 'utf8'), /error: Der Chat konnte die Antwort aus dem Fenster nicht verarbeiten \(choose\): EPERM: operation not permitted, rename decision\.json/);
    return undefined;
});

// The bar of the guided flow as a person (and a screen reader) has it: each step with * for the current one and ✓ for a done one.
const barOf = (page) => page.$$eval('#flow > li', (items) => items.map((li) => `${li.querySelector('.nm').textContent}${li.getAttribute('aria-current') === 'step' ? ' *' : ''}${li.classList.contains('done') ? ' ✓' : ''}`));
const BUG = '„Moving a todo to Tomorrow shows Someday“';
const fixAt = (at) => ({ kind: 'fix', title: BUG, at });

test('workbench: the guided flow names its five steps across the window from its start, done ticked, the current one marked; a card moves it on, adopted ticks all', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat } = await open(t, { flow: fixAt('start') });
    const { page } = bench;
    const steps = ['Nachstellen', 'Test erstellen', 'Beheben', 'Erneut testen', 'Übernehmen'];
    const at = (n) => steps.map((name, i) => `${name}${i === n ? ' *' : ''}${i < n ? ' ✓' : ''}`);
    assert.deepEqual(await barOf(page), at(0), 'before any card, while the agent works');
    assert.equal(await page.getAttribute('#flow', 'aria-label'), 'Fehlerbehebung');
    const box = await page.locator('#flow').boundingBox();
    const top = await page.locator('header.top').boundingBox();
    const width = await page.evaluate(() => innerWidth);
    assert.deepEqual([Math.round(box.x), Math.round(box.width), Math.round(box.y)], [0, width, Math.round(top.y + top.height)], 'below the header, over the whole width');
    assert.equal(await page.locator('#flow .nm').evaluateAll((list) => list.filter((node) => node.getBoundingClientRect().width > 20).length), 5, 'all five are named');
    for (const [phase, n] of [['test', 1], ['fix', 2], ['again', 3], ['adopt', 4]]) {
        chat.phase(phase);
        assert.ok(await until(async () => JSON.stringify(await barOf(page)) === JSON.stringify(at(n))), `${phase} while working`);
    }
    for (const [phase, n] of [['test', 1], ['fix', 2], ['adopt', 4], ['done', 5]]) {
        chat.result({ kind: 'result', tone: 'info', title: 'Karte', phase });
        assert.ok(await until(async () => JSON.stringify(await barOf(page)) === JSON.stringify(at(n))), `${phase} with a card`);
    }
    assert.equal(await page.locator('#flow [aria-current]').count(), 0, 'all done');
    assert.match(await page.textContent('#flow li:first-child'), /erledigt/, 'done, also for a screen reader');
    // A reload of the workbench keeps where it stands.
    await bench.view.frame.evaluate((url) => { top.location.href = url; }, `${base}/weiter`);
    assert.ok(await until(async () => JSON.stringify(await barOf(page).catch(() => [])) === JSON.stringify(at(5))), 'after a reload');
    assert.equal(await bench.chatFrame().locator('#phases, ol.phases').count(), 0, 'only once, not in the panel');
    return undefined;
});

test('workbench: a design draft has its own five steps and shows its name; without the guided flow there is no bar', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t, { flow: { kind: 'design', title: 'note', at: 'fix' } });
    assert.deepEqual(await barOf(bench.page), ['Entwurf ✓', 'Test erstellen ✓', 'Umsetzen *', 'Erneut testen', 'Übernehmen']);
    assert.equal(await bench.page.getAttribute('#flow', 'aria-label'), 'Zielbild');
    assert.equal(await bench.page.textContent('#crumbTest'), 'note');
    const plain = await open(t);
    plain.chat.phase('fix');
    plain.chat.result({ kind: 'result', tone: 'info', title: 'Karte', phase: 'fix' });
    await plain.bench.chatFrame().waitForSelector('#card .card');
    assert.equal(await plain.bench.page.isVisible('#flow'), false);
    return undefined;
});

test('workbench: in the guided flow the header says what it is about, no test, no mode; settings keep their title', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const long = `„${'Moving a todo to Tomorrow shows Someday. '.repeat(12)}“`;
    const { bench } = await open(t, { flow: { kind: 'fix', title: long, at: 'start' } });
    const { page } = bench;
    await bench.facts([['', long], ['Umgebung', 'local']]);
    assert.equal(await page.textContent('#crumbTest'), long);
    assert.equal(await page.getAttribute('#crumbTest', 'title'), long, 'in full as the tooltip');
    const cut = await page.$eval('#crumbTest', (node) => ({ ellipsis: getComputedStyle(node).textOverflow, cut: node.scrollWidth > node.clientWidth, height: node.getBoundingClientRect().height }));
    assert.deepEqual([cut.ellipsis, cut.cut, cut.height < 30], ['ellipsis', true, true], 'one line, shortened');
    assert.doesNotMatch(await page.innerText('header.top'), /reproduce|bug-/, 'neither the run nor the draft by its id');
    assert.equal(await page.isVisible('#title'), false, 'no badge');
    assert.equal(await page.isVisible('.crumb .sl'), false);
    await page.keyboard.press('Control+,');
    assert.ok(await until(() => page.isVisible('#title')));
    assert.equal(await page.textContent('#title'), 'Einstellungen');
    assert.equal(await page.isVisible('#flow'), true);
    return undefined;
});

test('workbench: the bar of the guided flow leaves the app its area (pinned size, F4, F6) and goes with the application alone; narrow it names only the current step', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await open(t, { flow: fixAt('test'), viewport: { width: 1280, height: 720 } });
    const { page } = bench;
    await bench.viewport({ width: 1280, height: 720 });
    const fits = async () => {
        await page.waitForFunction(() => { const box = document.getElementById('appBox').getBoundingClientRect(); const app = document.getElementById('app').getBoundingClientRect(); return app.width <= box.width + 1 && app.height <= box.height + 1 && box.bottom <= innerHeight + 1; });
        const [bar, panes] = [await page.locator('#flow').boundingBox(), await page.locator('.panes').boundingBox()];
        assert.equal(Math.round(bar.y + bar.height), Math.round(panes.y), 'the panes begin below the bar');
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'nothing scrolls');
    };
    await fits();
    await page.keyboard.press('F4');
    await fits();
    await page.keyboard.press('F6');
    await fits();
    // Both are remembered: as before for the next window.
    await page.keyboard.press('F4');
    await page.keyboard.press('F6');
    await page.keyboard.press('F8');
    assert.ok(await until(async () => !(await page.isVisible('#flow'))), 'the application only');
    await page.keyboard.press('F8');
    assert.ok(await until(() => page.isVisible('#flow')));
    // The comparison page covers header and bar.
    await page.evaluate(() => { document.body.classList.add('cmp-on'); document.getElementById('cmp').hidden = false; });
    assert.equal(await page.evaluate(() => { const bar = document.getElementById('flow').getBoundingClientRect(); return document.getElementById('cmp').contains(document.elementFromPoint(bar.x + 30, bar.y + bar.height / 2)); }), true);
    await page.evaluate(() => { document.body.classList.remove('cmp-on'); document.getElementById('cmp').hidden = true; });

    await page.setViewportSize({ width: 560, height: 800 });
    const narrow = await page.$$eval('#flow > li', (items) => items.map((li) => [li.querySelector('.nm').textContent, li.querySelector('.nm').getBoundingClientRect().width > 20]));
    assert.deepEqual(narrow, [['Nachstellen', false], ['Test erstellen', true], ['Beheben', false], ['Erneut testen', false], ['Übernehmen', false]], 'the others stay for screen readers');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling');
    return undefined;
});

test('chat: in the guided flow the panel shows the current activity with its time and one button; no heading, no status sentence, only warnings', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t, { flow: fixAt('start') });
    const seen = (selector) => frame.$eval(selector, (node) => { const box = node.getBoundingClientRect(); return box.width > 2 && box.height > 2; });
    const rows = () => frame.$$eval('#lines li', (list) => list.filter((li) => li.getBoundingClientRect().height > 0).map((li) => li.children[1].textContent));
    chat.advising(true);
    assert.ok(await until(async () => JSON.stringify(await rows()) === '["Claude Code startet"]'), 'until the first activity');
    chat.logLine('[+1.0s] > Read: {"file_path":"server.mjs"}');
    chat.logLine('[+2.0s] > caw agent goto /todos');
    assert.ok(await until(async () => JSON.stringify(await rows()) === '["/todos geöffnet"]'), 'only the current one');
    assert.match(await frame.textContent('#lines li:last-child small'), /^0:0\d$/);
    assert.ok(await until(async () => (await frame.textContent('#lines li:last-child small')) !== '0:00'), 'the time counts');
    assert.deepEqual([await seen('#workLabel'), await seen('#status')], [false, false], 'the bar says it');
    assert.equal(await frame.getAttribute('#status', 'role'), 'status', 'the live region stays');
    assert.match(await frame.textContent('#status'), /ohne Schreibzugriff/, 'for screen readers');
    assert.deepEqual([await frame.isVisible('#abort'), await frame.isVisible('#toggle')], [true, false]);
    assert.ok(await until(() => bench.page.$eval('body', (body) => body.classList.contains('acting'))), 'the agent operates the app');
    // Recording: the warning stays, Pause is the button.
    chat.phase('test');
    chat.advising(false);
    assert.ok(await until(() => seen('#status')));
    assert.equal(await frame.textContent('#status'), 'Vor Eingaben in der Anwendung pausieren.');
    assert.equal(await seen('#workLabel'), false);
    assert.match(await frame.textContent('#toggle'), /^Pause\s*F9$/);
    assert.deepEqual([await frame.isVisible('#toggle'), await frame.isVisible('#abort'), await frame.isVisible('#ask')], [true, false, false]);
    chat.enter('paused');
    assert.ok(await until(() => frame.isVisible('#abort')));
    assert.equal(await seen('#status'), true, 'entries are recorded: a warning');
    chat.leave();
    // Testing again: neither heading nor sentence, the activity of before is gone.
    chat.phase('again');
    chat.testing();
    assert.ok(await until(async () => JSON.stringify(await rows()) === '["Test startet"]'));
    assert.deepEqual([await seen('#workLabel'), await seen('#status')], [false, false]);
    assert.ok(await until(() => bench.page.$eval('body', (body) => !body.classList.contains('acting'))));
    return undefined;
});

test('chat: the card after reproducing: the facts and three buttons, the title only for screen readers and the history', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame, waiting } = await chatReady(t, { flow: fixAt('start') });
    const answer = decideReproduced(chat, { test: 'bug-x', outcome: { observed: 'When: Someday', expected: 'When: Tomorrow', cause: 'server.mjs:215' } });
    await frame.waitForSelector('#choices .btn');
    assert.deepEqual(await frame.$$eval('#card .kv > *', (list) => list.map((node) => node.textContent)), ['Beobachtet', 'When: Someday', 'Erwartet', 'When: Tomorrow', 'Ursache', 'server.mjs:215']);
    assert.deepEqual(await frame.$$eval('#choices .btn', (list) => list.map((b) => [b.textContent, b.classList.contains('btn-p')])), [['Test erstellen und beheben', true], ['Nur Test erstellen', false], ['Später', false]], 'all visible, one main action');
    const boxes = await frame.$$eval('#choices .btn', (list) => list.map((b) => ({ y: b.getBoundingClientRect().y, width: b.getBoundingClientRect().width })));
    assert.equal(new Set(boxes.map(({ width }) => width)).size, 1, 'the same width');
    assert.ok(boxes[0].y < boxes[1].y && boxes[1].y < boxes[2].y, 'one under the other');
    const title = await frame.$eval('#card .card > strong', (node) => [node.textContent, node.getBoundingClientRect().width]);
    assert.deepEqual([title[0], title[1] <= 2], ['Fehler nachgestellt', true], 'the bar says it');
    assert.match((await barOf(bench.page)).join(' '), /Nachstellen ✓ Test erstellen \*/);
    assert.ok(await until(() => waiting.length > 0));
    assert.match(waiting.at(-1), /Fehler nachgestellt/);
    await frame.click('#choices .btn >> nth=1');
    assert.equal(await answer, 'test-only');
    assert.ok(await until(async () => /Nur Test erstellen/.test(await frame.textContent('#hist'))));
    assert.match(await frame.textContent('#hist'), /Fehler nachgestellt/);
    return undefined;
});

test('chat: a card of the guided flow lists facts, also the changed files with their lines, and a title the bar does not say', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame, waiting } = await chatReady(t, { flow: fixAt('again') });
    const rows = [{ label: 'Schritt', text: 'S2 Summe' }, { label: 'Prüfung', text: "sum==='Total: 5'", code: true }, { label: 'Geändert', items: [{ code: 'server.mjs', text: '+1 −1' }, { code: 'web/new.js' }] }];
    const card = { kind: 'result', tone: 'next', title: 'Fehler behoben', rows, muted: 'Später: caw run bug-x', phase: 'adopt' };
    void chat.choose('deciding', card.title, [{ id: 'promote', label: 'Übernehmen', primary: true }, { id: 'later', label: 'Später' }], card);
    await frame.waitForSelector('#choices .btn');
    assert.equal(await frame.isVisible('#card .card > strong'), true);
    assert.deepEqual(await frame.$$eval('#card dl.kv dt', (list) => list.map((dt) => dt.textContent)), ['Schritt', 'Prüfung', 'Geändert']);
    assert.deepEqual(await frame.$$eval('#card dl.kv dd .it', (list) => list.map((line) => line.textContent)), ['server.mjs+1 −1', 'web/new.js']);
    assert.equal(await frame.textContent('#card dl.kv dd code'), "sum==='Total: 5'", 'the check as code');
    assert.ok(await until(() => waiting.length > 0));
    assert.equal(waiting.at(-1), 'Wartet im Chrome-Fenster auf dich: Fehler behoben: Später: caw run bug-x', 'the terminal line keeps title and consequence only');
    return undefined;
});

test('workbench: outside the guided flow either the badge or the panel says what runs, never both', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench, chat, frame } = await chatReady(t);
    await bench.facts([['', 'morning-errand wird ohne Claude Code abgespielt', 'Wiedergabe']]);
    chat.testing();
    assert.ok(await until(async () => (await frame.textContent('#workLabel')) === 'caw arbeitet'));
    assert.ok(await until(async () => !(await bench.page.isVisible('#title'))), 'the panel says it');
    void chat.choose('deciding', 'Fertig?', [{ id: 'close', label: 'Schließen', primary: true }], { kind: 'result', tone: 'info', title: 'Fertig?' });
    assert.ok(await until(() => bench.page.isVisible('#title')), 'the card says what waits, the badge which run');
    assert.equal(await frame.isVisible('#work'), false);
    return undefined;
});

test('chat: the terminal names the token notice it waits for', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, waiting } = await open(t);
    const chosen = chat.choose('choosing', 'Claude Code arbeitet jetzt, das kostet Token.', [{ id: 'go', label: 'Weiter', primary: true }], { kind: 'tokens', text: 'x' });
    assert.ok(await until(() => waiting.length === 1));
    assert.deepEqual(waiting, ['Wartet im Chrome-Fenster auf dich: Claude Code arbeitet jetzt, das kostet Token.']);
    chat.closed?.();
    void chosen;
    return undefined;
});

test('chat: a choice marked beside stays a secondary button next to the one main action', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { chat, frame } = await chatReady(t);
    const beside = { id: 'self', label: 'Ich behebe selbst', beside: true };
    const agent = { id: 'agent', label: 'Beheben lassen', primary: true };
    const first = chat.choose('deciding', 'Text', [agent, beside, { id: 'later', label: 'Später' }], { title: 'Festgehalten' });
    assert.ok(await until(() => frame.isVisible('#choices button.btn-p')));
    const shown = () => frame.$$eval('#choices button', (all) => all.filter((b) => b.checkVisibility()).map((b) => `${b.textContent}|${b.classList.contains('btn-p') ? 'p' : 's'}`));
    assert.deepEqual(await shown(), ['Beheben lassen|p', 'Ich behebe selbst|s', 'Später|s']);
    await frame.click('#choices button:text-is("Später")');
    assert.equal(await first, 'later');
    const second = chat.choose('deciding', 'Text', [agent, beside, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }], { title: 'Festgehalten' });
    assert.ok(await until(() => frame.isVisible('#choicesMore')));
    assert.deepEqual((await shown()).slice(0, 2), ['Beheben lassen|p', 'Ich behebe selbst|s']);
    await frame.click('#choices button:text-is("Ich behebe selbst")');
    assert.equal(await second, 'self');
    return undefined;
});

test('workbench: updates keep the running spinner turning, a new row takes over its angle', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { bench } = await chatReady(t);
    const page = bench.page;
    await bench.steps([{ id: 'S1', name: 'Eins', kind: 'step' }, { id: 'claude', name: 'Zwei', kind: 'step' }, { id: 'S2', name: 'Drei', kind: 'step' }]);
    await bench.step('S1', 'running');
    await page.evaluate(() => { document.body.classList.remove('fold-steps'); for (const li of document.querySelectorAll('#steps>li')) li.classList.add('open'); });
    await bench.point('claude', 'c1', 'running', { label: 'a' });
    await page.evaluate(() => { for (const s of document.querySelectorAll('#steps .spinner')) s.dataset.kept = '1'; });
    const count = await page.locator('#steps .spinner').count();
    assert.ok(count > 0, 'something turns');
    await bench.point('claude', 'c1', 'running', { label: 'b' });
    assert.equal(await page.locator('#steps .spinner[data-kept]').count(), count, 'the same spinners after an update');
    const turn = () => page.evaluate(() => { const s = [...document.querySelectorAll('#steps .spinner')].find((one) => one.getAnimations().length > 0); return { at: performance.now() / 900, progress: s.getAnimations()[0].effect.getComputedTiming().progress, id: s.closest('li').dataset.id }; });
    await page.waitForTimeout(350);
    const first = await turn();
    await bench.step('S2', 'running');
    const next = await turn();
    assert.notEqual(next.id, first.id, 'another row turns now');
    // Both as the angle a spinner turning since the page opened would have.
    const apart = Math.abs(((next.progress - next.at) - (first.progress - first.at)) % 1);
    assert.ok(Math.min(apart, 1 - apart) < 0.1, `one angle: ${JSON.stringify({ first, next })}`);
    return undefined;
});
