// explore: heuristics against a real DOM in Chrome (headless), skipped without Chrome; summary and init --from without a browser.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';


import { buildSuggestions, explore, keepStable, startUrlOf, suggestConsoleIgnore, suggestSignedIn, surveyPage } from '../src/host/explore.mjs';
import { answersFromExplore, starterConfig } from '../src/host/commands.mjs';
import { validateConfig } from '../src/shared/config.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

const LOGIN = `<main><h1>Sign in</h1><form>
  <label>Email <input id="email" type="email" autocomplete="username"></label>
  <label>Password <input id="pw" type="password"></label>
  <button type="submit" data-testid="login-submit">Sign in</button>
</form><div role="alert"></div></main>`;
const HOME = `<header><nav aria-label="Main"><a href="#" id="nav-decks">Decks</a></nav>
  <button data-testid="user-menu">Mia</button><button id="logout-1234">Sign out</button></header>
  <main><h1>Decks</h1><div class="toast-container"></div><button id="ext-gen123">x</button><div id="_r_b_">r</div><div id="«r3»">r</div></main>`;

test('explore: sign-in form, stable selectors and signed-in marker from a real DOM', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(LOGIN);
    const login = await page.evaluate(surveyPage, 600);
    assert.deepEqual(login.login, { userSelector: '#email', passwordSelector: '#pw', submitSelector: '[data-testid="login-submit"]', submitText: 'Sign in', submitsWithEnter: true });
    assert.deepEqual(login.messages, ['[role=alert]']);
    await page.setContent(HOME);
    const home = await page.evaluate(surveyPage, 600);
    assert.equal(home.login, null);
    assert.ok(!home.markers.some(({ selector }) => /ext-gen|logout-1234|_r_b_|r3/.test(selector)), 'generated ids are dropped, React useId too');
    assert.ok(home.messages.includes('.toast-container'));
    const signedIn = suggestSignedIn(login, home);
    assert.equal(signedIn.selector, 'nav[aria-label="Main"]', 'the named main navigation is on every page');
    assert.equal(signedIn.confidence, 'certain');
    assert.ok(signedIn.alternatives.some(({ selector }) => selector === '[data-testid="user-menu"]'));
});

// Like some portals: submit button with a random suffix per load, side menu only for accounts with admin rights, state on body.
const portal = (suffix, signedIn) => `<form id="login-form">
  <input id="portlet_login" type="text"><input id="portlet_password" type="password">
  <button type="submit" id="portlet_${suffix}">Sign in</button></form>
  <button class="product-menu-toast-toggle">2</button><div class="portlet-toast">Notice</div>
  <script>${signedIn ? "document.body.classList.add('signed-in')" : "document.body.classList.add('signed-out')"}</script>`;

test('explore: random ids are dropped on the second load, state on body beats menus', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(portal('kmvu', false));
    const first = await page.evaluate(surveyPage, 600);
    assert.equal(first.login.submitSelector, '#portlet_kmvu', 'on its own the suffix looks stable');
    assert.ok(first.messages.includes('.portlet-toast'));
    assert.ok(!first.messages.includes('.product-menu-toast-toggle'), 'a button is not a message');
    await page.setContent(portal('qzxa', false));
    const stable = keepStable(first, await page.evaluate(surveyPage, 600));
    assert.equal(stable.login.submitSelector, null);
    assert.equal(stable.login.userSelector, '#portlet_login');
    assert.ok(!stable.markers.some(({ selector }) => selector === '#portlet_kmvu'));
    const home = { url: 'https://portal.example/home', markers: [{ selector: '#product-menu-toggle', text: '', tag: 'button' }], stateClasses: ['body.signed-in'] };
    const signedIn = suggestSignedIn(stable, home);
    assert.equal(signedIn.selector, 'body.signed-in');
    assert.equal(signedIn.why, 'Zustand an html/body, für jedes Konto gleich');
    // Enter submits the form: no submitSelector in the suggestion.
    const form = buildSuggestions({ url: 'https://portal.example/', seen: { before: first, loginPage: first, after: home } });
    assert.equal(form.auth.submitSelector, undefined);
    assert.equal(form.auth.signedInSelector, 'body.signed-in');
});

test('explore: suggestions for form, SSO and no sign-in; console noise without numbers', () => {
    const loginPage = { url: 'http://app.localhost:5173/login?next=/', login: { userSelector: '#email', passwordSelector: '#pw', submitSelector: null }, markers: [], messages: [] };
    const home = { url: 'http://app.localhost:5173/decks', framework: 'react', markers: [{ selector: '[data-testid="user-menu"]', text: 'Mia', tag: 'button' }], messages: ['[role=status]'] };
    const form = buildSuggestions({ url: 'http://app.localhost:5173/start', seen: { before: loginPage, loginPage, after: home }, consoleErrors: ['Failed to load resource: 404 (http://x/a.png)'], detected: 'react' });
    assert.equal(form.url, 'http://app.localhost:5173');
    assert.deepEqual(form.framework, { value: 'react', confidence: 'certain', why: 'zur Laufzeit erkannt' });
    assert.deepEqual(form.auth, { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#pw', signedInSelector: '[data-testid="user-menu"]', confidence: 'certain' });
    assert.equal(form.startUrl, '/decks');
    assert.equal(form.consoleIgnore, undefined, 'HTTP errors before sign-in do not become consoleIgnore, that would hide them all');
    const sso = buildSuggestions({ url: 'https://app.example.com', seen: { before: { ...home, markers: [] }, loginPage: null, after: home }, foreignHosts: ['login.microsoftonline.com'] });
    assert.equal(sso.auth.type, 'storageState');
    assert.match(sso.notes.join(' '), /login\.microsoftonline\.com.*caw-ai auth/);
    const none = buildSuggestions({ url: 'http://app.localhost:5173', seen: { before: home, loginPage: null, after: home }, detected: 'web' });
    assert.equal(none.auth.type, 'none');
    // http on the local machine stays as it is; other http hosts get a note.
    const plain = buildSuggestions({ url: 'http://localhost:5173/x', seen: { before: home, loginPage: null, after: home } });
    assert.equal(plain.url, 'http://localhost:5173');
    assert.ok(!plain.notes.some((note) => /https|localhost/.test(note)), plain.notes.join(' '));
    assert.match(buildSuggestions({ url: 'http://intranet:8080', seen: { before: home, loginPage: null, after: home } }).notes[0], /intranet ohne https/);
    assert.equal(suggestSignedIn(home, home), null);
    // A named navigation beats a meaningless id, even with a long text.
    const nav = suggestSignedIn(loginPage, { markers: [{ selector: '#main-area', text: 'x', tag: 'div' }, { selector: 'nav[aria-label="Breadcrumbs"]', text: 'Start', tag: 'nav' }, { selector: 'nav[aria-label="Main navigation"]', text: 'Files Start All files Review Settings', tag: 'nav' }] });
    assert.equal(nav.selector, 'nav[aria-label="Main navigation"]');
    assert.equal(nav.confidence, 'certain');
    assert.deepEqual(suggestConsoleIgnore(['short', 'Uncaught TypeError: x is 12 not a function\n at y']), ['Uncaught TypeError: x is \\d+ not a function']);
    // Every suggestion is a valid regex and matches its own message, also with brackets and special characters.
    const noisy = ["Uncaught TypeError: Cannot read properties of undefined (reading 'name')", 'Request 3 failed after 1200ms [retry?] +x'];
    for (const [i, pattern] of suggestConsoleIgnore(noisy).entries()) assert.ok(new RegExp(pattern).test(noisy[i]), pattern);
});

test('init --from: suggestions from explore yield a valid config', () => {
    const suggestion = { url: 'http://app.localhost:5173', framework: { value: 'react' }, auth: { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#pw', submitSelector: '[data-testid="login-submit"]', signedInSelector: '[data-testid="user-menu"]', confidence: 'certain' }, startUrl: '/decks', messageSelectors: ['[role=status]'] };
    const config = starterConfig(answersFromExplore(suggestion));
    assert.equal(config.framework, 'react');
    assert.equal(config.environments.local.url, 'http://app.localhost:5173');
    assert.deepEqual(config.auth, { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#pw', signedInSelector: '[data-testid="user-menu"]', submitSelector: '[data-testid="login-submit"]' });
    assert.equal(config.apps.web.startUrl, '/decks');
    assert.deepEqual(config.messageSelectors, ['[role=status]']);
    assert.deepEqual(validateConfig(config, tmpdir()).issues.filter((issue) => !/dir|environments\.staging/.test(issue)), []);
    const without = starterConfig(answersFromExplore({ url: 'http://app.localhost:5173', framework: { value: 'web' }, auth: { type: 'none' } }));
    assert.equal(without.auth, undefined);
    // Without a signed-in marker (as with some apps): TODO instead of the template's real-looking placeholder.
    const partial = starterConfig(answersFromExplore({ url: 'http://localhost:5173', framework: { value: 'react' }, auth: { type: 'form', path: '/', userSelector: '#user', passwordSelector: '#pass', confidence: 'likely' } }));
    assert.deepEqual(partial.auth, { type: 'form', path: '/', userSelector: '#user', passwordSelector: '#pass', signedInSelector: 'TODO' });
    assert.throws(() => answersFromExplore({}), /explore/);
});

test('explore: flow with a fake browser writes only caw/.explore.json', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-explore-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const surveys = [
        { url: 'http://127.0.0.1:1/login', login: { userSelector: '#u', passwordSelector: '#p', submitSelector: null }, markers: [], messages: [], framework: null },
        { url: 'http://127.0.0.1:1/home', login: null, markers: [{ selector: '#logout', text: 'Sign out', tag: 'a' }], messages: [], framework: 'vue' },
    ];
    let closed = false;
    const fakePage = {
        goto: async () => {},
        waitForLoadState: async () => {},
        on: () => {},
        // The survey returns the pages in order; the form check sees a loaded page without a password field.
        evaluate: async (fn) => (fn === surveyPage ? surveys.shift() : { form: false, loaded: true }),
    };
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => res.end('ok'));
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/`;
    const code = await explore(root, ['--url', url, '--yes'], { open: async () => ({ page: fakePage, consoleErrors: [], foreignHosts: new Set(), close: async () => { closed = true; } }), wait: async () => {}, ask: async () => true, detect: () => 'web' });
    assert.equal(code, 0);
    assert.ok(closed);
    const written = JSON.parse(readFileSync(join(root, 'caw/.explore.json'), 'utf8'));
    assert.equal(written.auth.signedInSelector, '#logout');
    assert.equal(written.framework.value, 'vue');
    assert.ok(!existsSync(join(root, 'caw.config.json')), 'no config');
    await assert.rejects(explore(root, ['--url', 'ftp://x'], { wait: async () => {} }), /Aufruf: caw-ai explore/);
});

test('explore without signing in (--yes on an app with a login): the sign-in page is never the start page', () => {
    const loginPage = { url: 'http://localhost:4174/login', login: { userSelector: '#user', passwordSelector: '#password', submitSelector: null }, markers: [], messages: [] };
    // Nobody signed in: the page at the end is still the sign-in page.
    const unattended = buildSuggestions({ url: 'http://localhost:4174', seen: { before: loginPage, loginPage, after: loginPage } });
    assert.equal(unattended.startUrl, '/');
    assert.equal(unattended.auth.path, '/login');
    assert.equal(startUrlOf('http://localhost:4174/app/', loginPage), '/app/', 'the given address, if it is not the sign-in page');
    assert.equal(startUrlOf('http://localhost:4174/login', loginPage), '/');
    // Signed in: the page the human chose.
    assert.equal(startUrlOf('http://localhost:4174', { url: 'http://localhost:4174/todos?day=1', login: null }), '/todos?day=1');
    // init then writes "/" as startUrl.
    assert.equal(starterConfig({ ...answersFromExplore(unattended), language: 'de' }).apps.web.startUrl, '/');
});
