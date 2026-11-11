// Gegen ein kleines Portal in echtem Chrome (headless, ohne Chrome uebersprungen): Absendeknopf mit zufaelligem Kuerzel je Laden,
// Zustandsklasse am body, ein Menue nur fuer Verwalter. explore muss daraus eine Anmeldung ableiten, die fuer jedes Konto traegt, und
// loginSteps muss Fehlschlaege nach Sekunden melden, nicht nach der Zeitgrenze.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { explore } from '../src/host/explore.mjs';
import { loginSteps } from '../src/host/browser-session.mjs';

const page = (body, signedIn) => `<!doctype html><html><head><title>Portal</title></head><body class="${signedIn ? 'signed-in' : 'signed-out'}">${body}</body></html>`;
const loginForm = () => `<form method="post" action="/login"><input id="login_user" name="user" type="text"><input id="login_password" name="password" type="password">
  <button type="submit" id="login_${randomBytes(2).toString('hex').replace(/\d/g, 'q')}">Anmelden</button></form>`;
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
                if (form.get('password') !== 'geheim') {
                    res.end(page(`<p role="alert">Falsch</p>${loginForm()}`, false));
                    return;
                }
                res.writeHead(302, { 'set-cookie': `session=${form.get('user')}; Path=/`, location: '/home' });
                res.end();
            });
            return;
        }
        if (req.url === '/home' && signedIn) {
            const admin = signedIn === 'admin' ? '<button id="admin-menu-toggle">Verwaltung</button>' : '';
            res.end(page(`<header>${admin}<a href="/logout" id="logout">Abmelden</a></header><main><h1>Start</h1></main>`, true));
            return;
        }
        res.end(page(loginForm(), false));
    });
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
});
after(async () => {
    await browser?.close();
    server?.close();
});

test('explore: Anmeldung mit zufälligem Knopf und Marke für jedes Konto, Fertig per Knopf', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const root = mkdtempSync(join(tmpdir(), 'caw-portal-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const context = await browser.newContext();
    const tab = await context.newPage();
    const open = async () => ({ page: tab, consoleErrors: [], foreignHosts: new Set(), close: async () => { await context.close(); } });
    // Der Mensch: meldet sich als Verwalter an (er sieht also das Menue) und klickt dann im Fenster auf Fertig.
    const human = (async () => {
        await tab.waitForSelector('#login_user');
        await new Promise((ok) => { setTimeout(ok, 1500); });
        await tab.fill('#login_user', 'admin');
        await tab.fill('#login_password', 'geheim');
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
    assert.equal(suggestion.auth.submitSelector, undefined, 'Kürzel wechselt, Enter sendet');
    assert.equal(suggestion.auth.signedInSelector, 'body.signed-in', 'nicht das Menü des Verwalters');
    assert.equal(suggestion.startUrl, '/home');
});

test('loginSteps: falsches Passwort und falsche Marke fallen nach Sekunden auf', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    const tab = await context.newPage();
    const selectors = { user: '#login_user', password: '#login_password' };
    let start = Date.now();
    await assert.rejects(loginSteps(tab, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'falsch', selectors }), /abgelehnt/);
    assert.ok(Date.now() - start < 10_000, `abgelehnt nach ${Date.now() - start} ms`);
    start = Date.now();
    await assert.rejects(loginSteps(tab, { url: `${base}/`, marker: '#admin-menu-toggle', login: 'max', password: 'geheim', selectors }), (error) => error.code === 'login-failed');
    assert.ok(Date.now() - start < 20_000, `Marke falsch nach ${Date.now() - start} ms`);
    start = Date.now();
    await assert.rejects(loginSteps(tab, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'geheim', selectors: { ...selectors, submit: '#login_kmvu' } }), /submitSelector/);
    assert.ok(Date.now() - start < 10_000);
    await loginSteps(tab, { url: `${base}/`, marker: 'body.signed-in', login: 'max', password: 'geheim', selectors });
});
