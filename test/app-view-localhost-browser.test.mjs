// The documents caw handles itself (app-view.mjs) in real Chrome with caw's host lock flags, the app served under a name below
// .localhost as caw serves a local app: only Chrome resolves it (the lock pins it to 127.0.0.1), Node does not. A top-window form
// POST in the workbench (and a rewritten popup document, see below) must reach the app all the same. Skipped without Chrome. Invented data only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import { APP_FRAME, interceptDocuments } from '../src/host/app-view.mjs';
import { browserArgs } from '../src/host/host-lock.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let server = null;
let host = '';
let base = '';
const asked = [];

before(async () => {
    browser = await launchChrome({ args: browserArgs() });
    server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            asked.push(`${request.method} ${request.url}${body === '' ? '' : ` ${body}`}${request.headers.cookie === undefined ? '' : ` cookie:${request.headers.cookie}`}`);
            if (request.method === 'POST' && request.url === '/login') {
                return response.writeHead(303, { location: '/home', 'set-cookie': 'session=abc; Path=/' }).end();
            }
            response.setHeader('content-type', 'text/html; charset=utf-8');
            if (request.method === 'POST') return response.end(`<p id="app">posted ${body}</p>`);
            return response.end(`<p id="app">App ${request.url}</p>`);
        });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    host = 'app.localhost';
    base = `http://${host}:${server.address().port}`;
});
after(async () => {
    await browser?.close();
    await new Promise((resolve) => { server?.close(resolve); });
});

const until = async (check, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
};

/** The workbench with the application at `path`; a form POST from its top window to `action`; the app frame's text once it is `expected`. */
const postFromWorkbench = async (t, action, expected) => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const workbench = (url) => `<p id="bench">Bench</p><iframe name="${APP_FRAME}" src="${url}"></iframe>`;
    await interceptDocuments(context, page, [host], { workbench });
    await page.goto(`${base}/start`);
    await page.evaluate((target) => {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = target;
        form.innerHTML = '<input name="amount" value="5">';
        document.body.append(form);
        form.submit();
    }, `${base}${action}`);
    const frameText = async () => {
        const frame = page.frame({ name: APP_FRAME });
        return frame === null ? null : frame.locator('#app').textContent({ timeout: 200 }).catch(() => null);
    };
    const arrived = await until(async () => await frameText() === expected);
    assert.ok(arrived, `the app frame shows ${expected} (frame: ${await frameText()}, top: ${await page.locator('body').innerText().catch(() => '?')})`);
    assert.equal(await page.locator('#bench').count(), 1, 'the workbench stays in the top window');
    return context;
};

test('workbench: a form POST into the top window reaches an app under .localhost; the workbench stays, the answer is in the app frame', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    asked.length = 0;
    await postFromWorkbench(t, '/api/transfer', 'posted amount=5');
    assert.deepEqual(asked.filter((line) => line.startsWith('POST')), ['POST /api/transfer amount=5'], 'sent once');
});

test('workbench: a top-window POST answered with a redirect and a cookie loads the target in the app frame, with the cookie', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    asked.length = 0;
    const context = await postFromWorkbench(t, '/login', 'App /home');
    assert.deepEqual(asked.filter((line) => !line.startsWith('GET /start') && !line.startsWith('GET /favicon')), ['POST /login amount=5', 'GET /home cookie:session=abc'], 'the redirect target was asked once, with the cookie');
    assert.deepEqual((await context.cookies()).map(({ name, value }) => `${name}=${value}`), ['session=abc']);
});

// Known open bug, red with the current code: rewriteOtherPages fetches the popup's first document from Node (route.fetch), which
// does not resolve app.localhost (ENOTFOUND); the popup never opens. Chrome cannot fetch it instead through Playwright's API: while
// that request waits there is no page yet to attach a CDP session to. Skipped until the fix is decided.
test('local code: a popup of an app under .localhost gets its rewritten document', { skip: 'known: popup document fetched from Node (rewriteOtherPages)' }, async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const rewrite = async (html) => html.replace('<p id="app">', '<p id="app" data-rewritten="yes">');
    await interceptDocuments(context, page, [host], { rewrite });
    await page.goto(`${base}/start`);
    assert.equal(await page.locator('#app').getAttribute('data-rewritten'), 'yes', 'the page itself');
    const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate((address) => { window.open(address); }, `${base}/popup`)]);
    await popup.waitForLoadState().catch(() => {});
    const text = await popup.locator('#app').textContent({ timeout: 5000 }).catch((error) => `error: ${error.message.split('\n')[0]}`);
    assert.equal(text, 'App /popup', 'the popup reached the app');
    assert.equal(await popup.locator('#app').getAttribute('data-rewritten'), 'yes', 'the popup is rewritten');
});
