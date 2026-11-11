// Sign-in with a one-time code: an already used code is rejected, then retried once with the code of the next 30 s window.
// Plus the browser context permissions: clipboard for the environment's origin.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { grantClipboard, loginSteps } from '../src/host/browser-session.mjs';
import { totp } from '../src/shared/totp.mjs';

const SECRET = 'JBSWY3DPEHPK3PXP';
const SELECTORS = { user: '#user', password: '#pass', code: '#mfa-code' };
const MARKER = 'summary.who';
const WINDOW_MS = 30_000;
const START = 1_800_000_000_000 + 25_000;

/** Sign-in page: the code field follows the password, `accept(code, attempt)` decides on every code. */
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
        // Whatever is missing times out shortly after, instead of waiting for the real timeout.
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

test('TOTP: a rejected, already used code is retried once with the code of the next window', async () => {
    const used = totp(SECRET, START);
    const page = loginPage((code) => code !== used);
    const time = clock();
    await login(page, time);
    assert.deepEqual(page.codes, [used, totp(SECRET, START + WINDOW_MS)]);
    assert.notEqual(page.codes[0], page.codes[1]);
    assert.ok(time.now() >= Math.ceil(START / WINDOW_MS) * WINDOW_MS, 'only in the next window');
    assert.ok(time.waits.reduce((sum, ms) => sum + ms, 0) <= WINDOW_MS + 2000, 'waited at most one window');
});

test('TOTP: an accepted code is not repeated, a second rejection ends as login-failed without further attempts', async () => {
    const page = loginPage(() => true);
    await login(page, clock());
    assert.equal(page.codes.length, 1);
    const refused = loginPage(() => false);
    await assert.rejects(login(refused, clock()), (error) => error.code === 'login-failed');
    assert.equal(refused.codes.length, 2, 'exactly one retry');
});

test('Clipboard: read and write for the environment origin, not for others', async () => {
    const granted = [];
    await grantClipboard({ grantPermissions: async (permissions, options) => { granted.push([permissions, options]); } }, 'https://portal.example:8443/app/start');
    assert.deepEqual(granted, [[['clipboard-read', 'clipboard-write'], { origin: 'https://portal.example:8443' }]]);
});
