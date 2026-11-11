// explore: Heuristiken gegen echtes DOM in Chrome (headless), ohne Chrome uebersprungen; Zusammenfassung und init --from ohne Browser.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { buildSuggestions, explore, keepStable, suggestConsoleIgnore, suggestSignedIn, surveyPage } from '../src/host/explore.mjs';
import { answersFromExplore, starterConfig } from '../src/host/commands.mjs';
import { validateConfig } from '../src/shared/config.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

const LOGIN = `<main><h1>Anmelden</h1><form>
  <label>E-Mail <input id="email" type="email" autocomplete="username"></label>
  <label>Passwort <input id="pw" type="password"></label>
  <button type="submit" data-testid="login-submit">Anmelden</button>
</form><div role="alert"></div></main>`;
const HOME = `<header><nav aria-label="Haupt"><a href="#" id="nav-decks">Decks</a></nav>
  <button data-testid="user-menu">Mia</button><button id="logout-1234">Abmelden</button></header>
  <main><h1>Decks</h1><div class="toast-container"></div><button id="ext-gen123">x</button><div id="_r_b_">r</div><div id="«r3»">r</div></main>`;

test('explore: Anmeldeformular, stabile Selektoren und Marke für angemeldet aus echtem DOM', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(LOGIN);
    const login = await page.evaluate(surveyPage, 600);
    assert.deepEqual(login.login, { userSelector: '#email', passwordSelector: '#pw', submitSelector: '[data-testid="login-submit"]', submitText: 'Anmelden', submitsWithEnter: true });
    assert.deepEqual(login.messages, ['[role=alert]']);
    await page.setContent(HOME);
    const home = await page.evaluate(surveyPage, 600);
    assert.equal(home.login, null);
    assert.ok(!home.markers.some(({ selector }) => /ext-gen|logout-1234|_r_b_|r3/.test(selector)), 'erzeugte Kennungen fallen weg, auch React useId');
    assert.ok(home.messages.includes('.toast-container'));
    const signedIn = suggestSignedIn(login, home);
    assert.equal(signedIn.selector, 'nav[aria-label="Haupt"]', 'die benannte Hauptnavigation steht auf jeder Seite');
    assert.equal(signedIn.confidence, 'certain');
    assert.ok(signedIn.alternatives.some(({ selector }) => selector === '[data-testid="user-menu"]'));
});

// Wie manche Portale: Absendeknopf mit zufaelligem Kuerzel je Laden, Seitenmenue nur fuer Konten mit Verwaltungsrechten, Zustand am body.
const portal = (suffix, signedIn) => `<form id="login-form">
  <input id="portlet_login" type="text"><input id="portlet_password" type="password">
  <button type="submit" id="portlet_${suffix}">Anmelden</button></form>
  <button class="product-menu-toast-toggle">2</button><div class="portlet-toast">Hinweis</div>
  <script>${signedIn ? "document.body.classList.add('signed-in')" : "document.body.classList.add('signed-out')"}</script>`;

test('explore: zufällige Kennungen fallen beim zweiten Laden weg, Zustand am body schlägt Menüs', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(portal('kmvu', false));
    const first = await page.evaluate(surveyPage, 600);
    assert.equal(first.login.submitSelector, '#portlet_kmvu', 'einzeln sieht das Kuerzel stabil aus');
    assert.ok(first.messages.includes('.portlet-toast'));
    assert.ok(!first.messages.includes('.product-menu-toast-toggle'), 'ein Knopf ist keine Meldung');
    await page.setContent(portal('qzxa', false));
    const stable = keepStable(first, await page.evaluate(surveyPage, 600));
    assert.equal(stable.login.submitSelector, null);
    assert.equal(stable.login.userSelector, '#portlet_login');
    assert.ok(!stable.markers.some(({ selector }) => selector === '#portlet_kmvu'));
    const after = { url: 'https://portal.example/home', markers: [{ selector: '#product-menu-toggle', text: '', tag: 'button' }], stateClasses: ['body.signed-in'] };
    const signedIn = suggestSignedIn(stable, after);
    assert.equal(signedIn.selector, 'body.signed-in');
    assert.equal(signedIn.why, 'Zustand an html/body, für jedes Konto gleich');
    // Enter sendet das Formular: kein submitSelector im Vorschlag.
    const form = buildSuggestions({ url: 'https://portal.example/', seen: { before: first, loginPage: first, after } });
    assert.equal(form.auth.submitSelector, undefined);
    assert.equal(form.auth.signedInSelector, 'body.signed-in');
});

test('explore: Vorschläge für Formular, SSO und ohne Anmeldung; Konsolenrauschen ohne Zahlen', () => {
    const loginPage = { url: 'http://app.localhost:5173/login?next=/', login: { userSelector: '#email', passwordSelector: '#pw', submitSelector: null }, markers: [], messages: [] };
    const after = { url: 'http://app.localhost:5173/decks', framework: 'react', markers: [{ selector: '[data-testid="user-menu"]', text: 'Mia', tag: 'button' }], messages: ['[role=status]'] };
    const form = buildSuggestions({ url: 'http://app.localhost:5173/start', seen: { before: loginPage, loginPage, after }, consoleErrors: ['Failed to load resource: 404 (http://x/a.png)'], detected: 'react' });
    assert.equal(form.url, 'http://app.localhost:5173');
    assert.deepEqual(form.framework, { value: 'react', confidence: 'certain', why: 'zur Laufzeit erkannt' });
    assert.deepEqual(form.auth, { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#pw', signedInSelector: '[data-testid="user-menu"]', confidence: 'certain' });
    assert.equal(form.startUrl, '/decks');
    assert.equal(form.consoleIgnore, undefined, 'HTTP-Fehler vor der Anmeldung werden kein consoleIgnore, das verdeckte alle');
    const sso = buildSuggestions({ url: 'https://app.example.com', seen: { before: { ...after, markers: [] }, loginPage: null, after }, foreignHosts: ['login.microsoftonline.com'] });
    assert.equal(sso.auth.type, 'storageState');
    assert.match(sso.notes.join(' '), /login\.microsoftonline\.com.*caw-ai auth/);
    const none = buildSuggestions({ url: 'http://app.localhost:5173', seen: { before: after, loginPage: null, after }, detected: 'web' });
    assert.equal(none.auth.type, 'none');
    // http auf dem eigenen Rechner bleibt, wie es ist; andere http-Hosts bekommen einen Hinweis.
    const plain = buildSuggestions({ url: 'http://localhost:5173/x', seen: { before: after, loginPage: null, after } });
    assert.equal(plain.url, 'http://localhost:5173');
    assert.ok(!plain.notes.some((note) => /https|localhost/.test(note)), plain.notes.join(' '));
    assert.match(buildSuggestions({ url: 'http://intranet:8080', seen: { before: after, loginPage: null, after } }).notes[0], /intranet ohne https/);
    assert.equal(suggestSignedIn(after, after), null);
    // Eine benannte Navigation schlaegt eine Kennung ohne Bedeutung, auch mit langem Text.
    const nav = suggestSignedIn(loginPage, { markers: [{ selector: '#main-area', text: 'x', tag: 'div' }, { selector: 'nav[aria-label="Brotkrumen"]', text: 'Start', tag: 'nav' }, { selector: 'nav[aria-label="Hauptnavigation"]', text: 'Akten Start Alle Akten Prüfung Einstellungen', tag: 'nav' }] });
    assert.equal(nav.selector, 'nav[aria-label="Hauptnavigation"]');
    assert.equal(nav.confidence, 'certain');
    assert.deepEqual(suggestConsoleIgnore(['kurz', 'Uncaught TypeError: x is 12 not a function\n at y']), ['Uncaught TypeError: x is \\d+ not a function']);
    // Jeder Vorschlag ist ein gueltiger Ausdruck und trifft seine eigene Meldung, auch mit Klammern und Sonderzeichen.
    const noisy = ["Uncaught TypeError: Cannot read properties of undefined (reading 'name')", 'Request 3 failed after 1200ms [retry?] +x'];
    for (const [i, pattern] of suggestConsoleIgnore(noisy).entries()) assert.ok(new RegExp(pattern).test(noisy[i]), pattern);
});

test('init --from: Vorschläge von explore ergeben eine gültige Config', () => {
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
    // Ohne Marke fuer „angemeldet“ (wie bei manchen Apps): TODO statt des echt aussehenden Platzhalters der Vorlage.
    const partial = starterConfig(answersFromExplore({ url: 'http://localhost:5173', framework: { value: 'react' }, auth: { type: 'form', path: '/', userSelector: '#user', passwordSelector: '#pass', confidence: 'likely' } }));
    assert.deepEqual(partial.auth, { type: 'form', path: '/', userSelector: '#user', passwordSelector: '#pass', signedInSelector: 'TODO' });
    assert.throws(() => answersFromExplore({}), /explore/);
});

test('explore: Ablauf mit Fake-Browser schreibt nur caw/.explore.json', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-explore-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const surveys = [
        { url: 'http://127.0.0.1:1/login', login: { userSelector: '#u', passwordSelector: '#p', submitSelector: null }, markers: [], messages: [], framework: null },
        { url: 'http://127.0.0.1:1/home', login: null, markers: [{ selector: '#logout', text: 'Abmelden', tag: 'a' }], messages: [], framework: 'vue' },
    ];
    let closed = false;
    const fakePage = {
        goto: async () => {},
        waitForLoadState: async () => {},
        on: () => {},
        // Die Umfrage liefert die Seiten der Reihe nach; die Abfrage des Formulars sieht eine fertige Seite ohne Passwortfeld.
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
    assert.ok(!existsSync(join(root, 'caw.config.json')), 'keine Config');
    await assert.rejects(explore(root, ['--url', 'ftp://x'], { wait: async () => {} }), /Aufruf: caw-ai explore/);
});
