// Against a small portal in real Chrome (headless, skipped without Chrome): submit button with a random suffix per load,
// state class on body, a menu only for admins. explore must derive a sign-in from it that works for every account, and
// loginSteps must report failures after seconds, not after the timeout.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';


import { explore } from '../src/host/explore.mjs';
import { freshSession, loginSteps, watchBroken } from '../src/host/browser-session.mjs';
import { APP_FRAME, frameView } from '../src/host/app-view.mjs';
import { launchChrome } from './chrome.mjs';

const page = (body, signedIn) => `<!doctype html><html><head><title>Portal</title></head><body class="${signedIn ? 'signed-in' : 'signed-out'}">${body}</body></html>`;
const loginForm = () => `<form method="post" action="/login"><input id="login_user" name="user" type="text"><input id="login_password" name="password" type="password">
  <button type="submit" id="login_${randomBytes(2).toString('hex').replace(/\d/g, 'q')}">Sign in</button></form>`;
let server = null;
let base = '';
let browser = null;

before(async () => {
    server = createServer((req, res) => {
        const signedIn = /session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
        if (req.method === 'POST' && req.url === '/login') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                const form = new URLSearchParams(body);
                if (form.get('password') !== 'secret') {
                    res.end(page(`<p role="alert">Wrong</p>${loginForm()}`, false));
                    return;
                }
                res.writeHead(302, { 'set-cookie': `session=${form.get('user')}; Path=/`, location: '/home' });
                res.end();
            });
            return;
        }
        if (req.url === '/bench') {
            res.end(`<!doctype html><title>Workbench</title><iframe name="${APP_FRAME}" src="/home"></iframe>`);
            return;
        }
        if (req.url === '/home' && signedIn) {
            const admin = signedIn === 'admin' ? '<button id="admin-menu-toggle">Administration</button>' : '';
            res.end(page(`<header>${admin}<a href="/logout" id="logout">Sign out</a></header><main><h1>Start</h1></main>`, true));
            return;
        }
        res.end(page(loginForm(), false));
    });
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launchChrome();
});
after(async () => {
    await browser?.close();
    server?.close();
});

test('explore: sign-in with a random button and a marker for every account, done via button', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const root = mkdtempSync(join(tmpdir(), 'caw-portal-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const context = await browser.newContext();
    const tab = await context.newPage();
    const open = async () => ({ page: tab, consoleErrors: [], foreignHosts: new Set(), close: async () => { await context.close(); } });
    // The human signs in as admin (so they see the menu) and then clicks Done in the window.
    const human = (async () => {
        await tab.waitForSelector('#login_user');
        await new Promise((ok) => { setTimeout(ok, 1500); });
        await tab.fill('#login_user', 'admin');
        await tab.fill('#login_password', 'secret');
        await tab.press('#login_password', 'Enter');
        await tab.waitForSelector('#logout');
        await tab.waitForSelector('[data-caw=explore]', { state: 'attached' });
        await tab.evaluate(() => window.__cawExploreDone());
    })();
    const code = await explore(root, ['--url', `${base}/`], { open, ask: async () => true, detect: () => 'web' });
    await human;
    assert.equal(code, 0);
    const suggestion = JSON.parse(readFileSync(join(root, 'caw/.explore.json'), 'utf8'));
    assert.equal(suggestion.auth.type, 'form');
    assert.equal(suggestion.auth.userSelector, '#login_user');
    assert.equal(suggestion.auth.submitSelector, undefined, 'suffix changes, Enter submits');
    assert.equal(suggestion.auth.signedInSelector, 'body.signed-in', 'not the admin menu');
    assert.equal(suggestion.startUrl, '/home');
});

test('loginSteps: wrong password and wrong marker show up after seconds', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    const tab = await context.newPage();
    const selectors = { user: '#login_user', password: '#login_password' };
    let start = Date.now();
    await assert.rejects(loginSteps(tab, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'wrong', selectors }), /abgelehnt/);
    assert.ok(Date.now() - start < 10_000, `rejected after ${Date.now() - start} ms`);
    start = Date.now();
    await assert.rejects(loginSteps(tab, { url: `${base}/`, marker: '#admin-menu-toggle', login: 'max', password: 'secret', selectors }), (error) => error.code === 'login-failed');
    assert.ok(Date.now() - start < 20_000, `wrong marker after ${Date.now() - start} ms`);
    start = Date.now();
    await assert.rejects(loginSteps(tab, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'secret', selectors: { ...selectors, submit: '#login_kmvu' } }), /submitSelector/);
    assert.ok(Date.now() - start < 10_000);
    await loginSteps(tab, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'secret', selectors });
});

test('loginSteps in the workbench frame: after clearing cookies, restoring a state signs in again and the workbench stays', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    const tab = await context.newPage();
    const selectors = { user: '#login_user', password: '#login_password' };
    await loginSteps(tab, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'secret', selectors });
    await tab.goto(`${base}/bench`);
    const frame = await (await tab.waitForSelector(`iframe[name="${APP_FRAME}"]`)).contentFrame();
    await frame.waitForSelector('body.signed-in');
    const view = frameView(tab, frame);
    /* eslint-disable n/no-unsupported-features/node-builtins -- localStorage and sessionStorage of the browser page */
    await view.evaluate(() => new Promise((ok) => { localStorage.setItem('filter', 'paths'); sessionStorage.setItem('search', 'old'); sessionStorage.setItem('caw-bench-tab', 'console'); const open = indexedDB.open('app', 1); open.onupgradeneeded = () => open.result.createObjectStore('s'); open.onsuccess = () => { open.result.close(); ok(); }; }));
    await freshSession(context, view, base);
    await view.reload();
    assert.deepEqual(await view.evaluate(async () => [localStorage.getItem('filter'), sessionStorage.getItem('search'), sessionStorage.getItem('caw-bench-tab'), (await indexedDB.databases()).map(({ name }) => name)]), [null, null, 'console', []], 'new session, only the workbench tab key stays');
    /* eslint-enable n/no-unsupported-features/node-builtins */
    assert.equal(await view.$('body.signed-in'), null, 'signed out without cookies');
    // Like ensureLoggedIn: watch requests and unsubscribe again, also on the frame.
    const broken = watchBroken(view);
    await loginSteps(view, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'secret', selectors });
    broken.stop();
    assert.notEqual(await view.$('body.signed-in'), null);
    assert.equal(await tab.title(), 'Workbench');
    return undefined;
});
