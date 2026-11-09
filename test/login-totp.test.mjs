// Anmeldung mit Einmalcode: Ein schon benutzter Code wird abgelehnt, dann einmal mit dem Code des naechsten 30-s-Fensters.
// Dazu die Rechte des Browser-Kontexts: Zwischenablage fuer den Origin der Umgebung.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { grantClipboard, loginSteps } from '../src/host/browser-session.mjs';
import { totp } from '../src/shared/totp.mjs';

const SECRET = 'JBSWY3DPEHPK3PXP';
const SELECTORS = { user: '#user', password: '#pass', code: '#mfa-code' };
const MARKER = 'summary.who';
const WINDOW_MS = 30_000;
const START = 1_800_000_000_000 + 25_000;

/** Anmeldeseite: Nach dem Passwort kommt das Codefeld, `accept(code, versuch)` entscheidet ueber jeden Code. */
const loginPage = (accept) => {
    const state = { signedIn: false, codeVisible: false, passwordGone: false };
    const codes = [];
    const has = (selector) => (selector === MARKER ? state.signedIn : selector === SELECTORS.code ? state.codeVisible : !state.passwordGone);
    const page = {
        codes,
        goto: async () => {},
        url: () => 'https://p.example/login',
        waitForLoadState: async () => {},
        reload: async () => {},
        // Was fehlt, laeuft kurz danach ab, statt die Zeitgrenze abzuwarten.
        waitForSelector: (selector) => new Promise((ok, fail) => {
            const wanted = selector.split(', ');
            if (wanted.some(has)) ok({});
            else setTimeout(() => fail(new Error('Timeout')), 5);
        }),
        $: async (selector) => (has(selector) ? {} : null),
        isVisible: async (selector) => has(selector),
        fill: async (selector, value) => { if (selector === SELECTORS.code) codes.push(value); },
        press: async (selector) => {
            if (selector === SELECTORS.password) {
                state.passwordGone = true;
                state.codeVisible = true;
            } else if (selector === SELECTORS.code && accept(codes.at(-1), codes.length)) {
                state.signedIn = true;
                state.codeVisible = false;
            }
        },
    };
    return page;
};
const clock = () => {
    let time = START;
    const waits = [];
    return { waits, now: () => time, sleep: async (ms) => { waits.push(ms); time += ms; } };
};
const login = (page, time) => loginSteps(page, { url: 'https://p.example/login', marker: MARKER, login: 'a', password: 'b', totpSecret: SECRET, selectors: SELECTORS, now: time.now, sleep: time.sleep });

test('TOTP: Ein abgelehnter, schon benutzter Code wird einmal mit dem Code des nächsten Fensters wiederholt', async () => {
    const used = totp(SECRET, START);
    const page = loginPage((code) => code !== used);
    const time = clock();
    await login(page, time);
    assert.deepEqual(page.codes, [used, totp(SECRET, START + WINDOW_MS)]);
    assert.notEqual(page.codes[0], page.codes[1]);
    assert.ok(time.now() >= Math.ceil(START / WINDOW_MS) * WINDOW_MS, 'erst im nächsten Fenster');
    assert.ok(time.waits.reduce((sum, ms) => sum + ms, 0) <= WINDOW_MS + 2000, 'höchstens ein Fenster gewartet');
});

test('TOTP: Ein angenommener Code wird nicht wiederholt, ein zweites Ablehnen endet als login-failed ohne weitere Versuche', async () => {
    const page = loginPage(() => true);
    await login(page, clock());
    assert.equal(page.codes.length, 1);
    const refused = loginPage(() => false);
    await assert.rejects(login(refused, clock()), (error) => error.code === 'login-failed');
    assert.equal(refused.codes.length, 2, 'genau ein neuer Versuch');
});

test('Zwischenablage: Lesen und Schreiben für den Origin der Umgebung, nicht für andere', async () => {
    const granted = [];
    await grantClipboard({ grantPermissions: async (permissions, options) => { granted.push([permissions, options]); } }, 'https://portal.example:8443/app/start');
    assert.deepEqual(granted, [[['clipboard-read', 'clipboard-write'], { origin: 'https://portal.example:8443' }]]);
});
