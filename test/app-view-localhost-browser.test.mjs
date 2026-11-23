// The documents caw handles itself (app-view.mjs) in real Chrome with caw's host lock flags, the app served under a name below
// .localhost as caw serves a local app: Chrome resolves it through the lock (pinned to 127.0.0.1); whether Node resolves it too
// depends on the network (a DNS server may answer *.localhost with loopback, many do not). A top-window form POST in the
// workbench (and a rewritten popup document, see below) must reach the app all the same. Skipped without Chrome. Invented data only.
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
// A name only Chrome resolves on every network: .invalid never resolves (RFC 6761), the test pins it like the lock pins .localhost.
const CHROME_ONLY = 'popup.caw.invalid';

before(async () => {
    const [rules, ...rest] = browserArgs();
    browser = await launchChrome({ args: [`${rules}, MAP ${CHROME_ONLY} 127.0.0.1`, ...rest] });
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

/** The app under `appHost` with the local code laid over it; a popup to /popup. @returns the popup and the URLs caw named */
const openPopup = async (t, appHost) => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const rewrite = async (html) => html.replace('<p id="app">', '<p id="app" data-rewritten="yes">');
    const unrewritten = [];
    const appBase = `http://${appHost}:${server.address().port}`;
    await interceptDocuments(context, page, [appHost], { rewrite, onUnrewritten: (url) => unrewritten.push(url) });
    await page.goto(`${appBase}/start`);
    assert.equal(await page.locator('#app').getAttribute('data-rewritten'), 'yes', 'the page itself');
    const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.evaluate((address) => { window.open(address); }, `${appBase}/popup`)]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator('#app').textContent({ timeout: 5000 }), 'App /popup', 'the popup reached the app');
    return { popup, unrewritten, appBase };
};

// rewriteOtherPages fetches a popup's first document from Node (no page exists yet to ask Chrome through). For a name only Chrome
// resolves (as app.localhost on a network whose DNS does not answer .localhost) that fails. Owner decision: the popup then opens as
// the server delivers it, without the local code, and caw says so. The name is one no network resolves, so the case is the same
// everywhere; app.localhost itself resolves in Node on some networks, and then the next test's case applies.
test('local code: a popup of an app under a name only Chrome resolves opens without the local code, and caw names it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { popup, unrewritten, appBase } = await openPopup(t, CHROME_ONLY);
    assert.equal(await popup.locator('#app').getAttribute('data-rewritten'), null, 'the popup runs the deployed code');
    assert.deepEqual(unrewritten, [`${appBase}/popup`]);
});

test('local code: a popup of an app under a name Node resolves too gets the local code, nothing to name', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const { popup, unrewritten } = await openPopup(t, '127.0.0.1');
    assert.equal(await popup.locator('#app').getAttribute('data-rewritten'), 'yes', 'the popup runs the local code');
    assert.deepEqual(unrewritten, []);
});
