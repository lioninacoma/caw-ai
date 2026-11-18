// explore: heuristics against a real DOM in Chrome (headless), skipped without Chrome; summary and init --from without a browser.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';


import { buildSuggestions, explore, idpSteps, keepStable, startOf, suggestConsoleIgnore, suggestSignedIn, surveyPage } from '../src/host/explore.mjs';
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
    assert.equal(form.signIn.submitSelector, undefined);
    assert.equal(form.signIn.signedInSelector, 'body.signed-in');
});

// Sign-in pages of an IdP shaped like Keycloak's (fictitious): one page with both fields, identifier-first, a one-time code.
const IDP_BOTH = `<form id="kc-form-login" method="post"><input id="username" name="username" type="text" autocomplete="username">
  <input id="password" name="password" type="password"><input id="kc-login" type="submit" value="Sign In"></form>`;
const IDP_USER = `<form id="kc-form-login" method="post"><input id="username" name="username" type="text" autocomplete="username">
  <input id="kc-login" type="submit" value="Sign In"></form>`;
const IDP_PASSWORD = `<form id="kc-form-login" method="post"><input id="password" name="password" type="password">
  <input id="kc-login" type="submit" value="Sign In"></form>`;
const IDP_CODE = `<form id="kc-otp-login-form" method="post"><input id="otp" name="otp" type="text" autocomplete="one-time-code">
  <input id="kc-login" type="submit" value="Sign In"></form>`;

test('explore: sign-in steps from the pages of an IdP, identifier-first and one-time code included', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const surveyOf = async (html) => {
        await page.setContent(html);
        return { ...await page.evaluate(surveyPage, 600), url: 'http://idp.localhost:18180/realms/caw-e2e/protocol/openid-connect/auth' };
    };
    const both = await surveyOf(IDP_BOTH);
    const user = await surveyOf(IDP_USER);
    const password = await surveyOf(IDP_PASSWORD);
    const code = await surveyOf(IDP_CODE);
    assert.deepEqual(user.entry, { kind: 'user', selector: '#username', submitSelector: '#kc-login', submitsWithEnter: true });
    assert.deepEqual(code.entry, { kind: 'code', selector: '#otp', submitSelector: '#kc-login', submitsWithEnter: true });
    assert.equal(both.entry, null, 'a page with a password is a login, not an entry');
    // A real submit button: Enter on the field submits, as the app's own form sign-in does.
    assert.deepEqual(idpSteps([both]), [{ fill: '#username', with: 'user' }, { fill: '#password', with: 'password' }, { press: 'Enter', on: '#password' }]);
    assert.deepEqual(idpSteps([user, password, code]), [
        { fill: '#username', with: 'user' }, { press: 'Enter', on: '#username' },
        { fill: '#password', with: 'password' }, { press: 'Enter', on: '#password' },
        { fill: '#otp', with: 'totp' }, { press: 'Enter', on: '#otp' },
    ]);
    assert.equal(idpSteps([password]), null, 'without the user name the steps are incomplete');
    assert.equal(idpSteps([]), null);

    const home = { url: 'http://ci.localhost:18080/', markers: [{ selector: '#user-menu', text: 'qa.clerk', tag: 'span' }], messages: [] };
    const start = { url: 'http://ci.localhost:18080/', markers: [], messages: [] };
    const suggestion = buildSuggestions({ url: 'http://ci.localhost:18080', seen: { before: start, loginPage: null, after: home }, foreignHosts: ['idp.localhost'], idpPages: [user, password], signInFrom: '/login' });
    assert.deepEqual(suggestion.signIn, { type: 'form', path: '/login', steps: idpSteps([user, password]), signedInSelector: '#user-menu', confidence: 'certain' });
    assert.deepEqual(suggestion.allowHosts, ['idp.localhost']);
    assert.match(suggestion.notes.join(' '), /idp\.localhost.*allowHosts/);
    const config = starterConfig(answersFromExplore(suggestion));
    assert.deepEqual(config.signIn, { type: 'form', path: '/login', steps: idpSteps([user, password]), signedInSelector: '#user-menu' });
    assert.deepEqual(config.environments.local.allowHosts, ['idp.localhost']);
    assert.equal(validateConfig(config).ok, true);
    // Pages caw cannot fill: the stored session stays the suggestion.
    const unknown = buildSuggestions({ url: 'http://ci.localhost:18080', seen: { before: start, loginPage: null, after: home }, foreignHosts: ['sso.example.com'], idpPages: [{ ...start, login: null, entry: null }] });
    assert.equal(unknown.signIn.type, 'session');
});

test('explore: suggestions for form, SSO and no sign-in; console noise without numbers', () => {
    const loginPage = { url: 'http://app.localhost:5173/login?next=/', login: { userSelector: '#email', passwordSelector: '#pw', submitSelector: null }, markers: [], messages: [] };
    const home = { url: 'http://app.localhost:5173/decks', framework: 'react', markers: [{ selector: '[data-testid="user-menu"]', text: 'Mia', tag: 'button' }], messages: ['[role=status]'] };
    const form = buildSuggestions({ url: 'http://app.localhost:5173/start', seen: { before: loginPage, loginPage, after: home }, consoleErrors: ['Failed to load resource: 404 (http://x/a.png)'], detected: 'react' });
    assert.equal(form.url, 'http://app.localhost:5173');
    assert.deepEqual(form.framework, { value: 'react', confidence: 'certain', why: 'zur Laufzeit erkannt' });
    assert.deepEqual(form.signIn, { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#pw', signedInSelector: '[data-testid="user-menu"]', confidence: 'certain' });
    assert.equal(form.start, '/decks');
    assert.equal(form.consoleIgnore, undefined, 'HTTP errors before sign-in do not become consoleIgnore, that would hide them all');
    const sso = buildSuggestions({ url: 'https://app.example.com', seen: { before: { ...home, markers: [] }, loginPage: null, after: home }, foreignHosts: ['login.microsoftonline.com'] });
    assert.equal(sso.signIn.type, 'session');
    assert.match(sso.notes.join(' '), /login\.microsoftonline\.com.*caw role login/);
    const none = buildSuggestions({ url: 'http://app.localhost:5173', seen: { before: home, loginPage: null, after: home }, detected: 'web' });
    assert.equal(none.signIn.type, 'none');
    assert.equal(none.reads, undefined, 'no write seen, no reads suggestion');
    // Write requests seen while exploring become reads candidates, only as a likely suggestion with a note.
    const searched = buildSuggestions({ url: 'http://app.localhost:5173', seen: { before: home, loginPage: null, after: home }, writes: ['POST /api/search', 'POST /api/audit'] });
    assert.deepEqual(searched.reads, { value: ['POST /api/audit', 'POST /api/search'], confidence: 'likely' });
    assert.match(searched.notes.join(' '), /POST \/api\/audit, POST \/api\/search.*reads/);
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
    const suggestion = { url: 'http://app.localhost:5173', framework: { value: 'react' }, signIn: { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#pw', submitSelector: '[data-testid="login-submit"]', signedInSelector: '[data-testid="user-menu"]', confidence: 'certain' }, start: '/decks', messageSelectors: ['[role=status]'] };
    const config = starterConfig(answersFromExplore({ ...suggestion, reads: { value: ['POST /api/search'], confidence: 'likely' } }));
    assert.equal(config.reads, undefined, 'reads candidates stay a suggestion');
    assert.equal(config.framework, 'react');
    assert.equal(config.environments.local.url, 'http://app.localhost:5173');
    assert.deepEqual(config.signIn, { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#pw', signedInSelector: '[data-testid="user-menu"]', submitSelector: '[data-testid="login-submit"]' });
    assert.equal(config.start, '/decks');
    assert.deepEqual(config.messageSelectors, ['[role=status]']);
    assert.deepEqual(validateConfig(config, tmpdir()).issues.filter((issue) => !/dir|environments\.staging/.test(issue)), []);
    const without = starterConfig(answersFromExplore({ url: 'http://app.localhost:5173', framework: { value: 'web' }, signIn: { type: 'none' } }));
    assert.equal(without.signIn, undefined);
    // Without a signed-in marker (as with some apps): TODO instead of the template's real-looking placeholder.
    const partial = starterConfig(answersFromExplore({ url: 'http://localhost:5173', framework: { value: 'react' }, signIn: { type: 'form', path: '/', userSelector: '#user', passwordSelector: '#pass', confidence: 'likely' } }));
    assert.deepEqual(partial.signIn, { type: 'form', path: '/', userSelector: '#user', passwordSelector: '#pass', signedInSelector: 'TODO' });
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
    assert.equal(written.signIn.signedInSelector, '#logout');
    assert.equal(written.framework.value, 'vue');
    assert.ok(!existsSync(join(root, 'caw.config.json')), 'no config');
    await assert.rejects(explore(root, ['--url', 'ftp://x'], { wait: async () => {} }), /Aufruf: caw init --explore-only/);
});

test('explore without signing in (--yes on an app with a login): the sign-in page is never the start page', () => {
    const loginPage = { url: 'http://localhost:4174/login', login: { userSelector: '#user', passwordSelector: '#password', submitSelector: null }, markers: [], messages: [] };
    // Nobody signed in: the page at the end is still the sign-in page.
    const unattended = buildSuggestions({ url: 'http://localhost:4174', seen: { before: loginPage, loginPage, after: loginPage } });
    assert.equal(unattended.start, '/');
    assert.equal(unattended.signIn.path, '/login');
    assert.equal(startOf('http://localhost:4174/app/', loginPage), '/app/', 'the given address, if it is not the sign-in page');
    assert.equal(startOf('http://localhost:4174/login', loginPage), '/');
    // Signed in: the page the human chose.
    // Without the query: it can carry a session token or an id, and the start goes into caw/.explore.json and the config.
    assert.equal(startOf('http://localhost:4174', { url: 'http://localhost:4174/todos?day=1&token=abc', login: null }), '/todos');
    assert.equal(startOf('http://localhost:4174/app?sid=1', loginPage), '/app');
    // init then writes "/" as start.
    assert.equal(starterConfig({ ...answersFromExplore(unattended), language: 'de' }).start, '/');
});
