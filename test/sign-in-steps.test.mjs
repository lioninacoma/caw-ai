// signIn.steps in real Chrome (headless, skipped without Chrome): an identifier-first sign-in with a tenant field, a password
// page, a one-time code that the first time is refused (same 30 s window), and an optional "Stay signed in?" prompt.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import { stepSignIn } from '../src/host/browser-session.mjs';
import { totp } from '../src/shared/totp.mjs';
import { launchChrome } from './chrome.mjs';

const SECRET = 'GEZDGNBVGY3TQOJQ';
const WINDOW_MS = 30_000;
// The clock of the test: 5 s into a 30 s window. The server accepts only the code of the following window, like an app that
// refuses a code already used in this window.
const START = 1_700_000_105_000;
const accepted = totp(SECRET, (Math.floor(START / WINDOW_MS) + 1) * WINDOW_MS);

const html = (body) => `<!doctype html><html><head><title>IdP</title></head><body>${body}</body></html>`;
let server = null;
let base = '';
let browser = null;
let askStay = true;

const readForm = (req) => new Promise((ok) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => ok(new URLSearchParams(body)));
});
const cookie = (req, name) => new RegExp(`${name}=([\\w-]+)`).exec(req.headers.cookie ?? '')?.[1];
const go = (res, location, cookies = []) => {
    res.writeHead(302, { location, ...(cookies.length === 0 ? {} : { 'set-cookie': cookies.map((entry) => `${entry}; Path=/`) }) });
    res.end();
};

before(async () => {
    server = createServer(async (req, res) => {
        if (req.method === 'POST') {
            const form = await readForm(req);
            if (req.url === '/user') return form.get('tenant') === 'nord' && form.get('user') === 'mia' ? go(res, '/password', ['stage=password']) : go(res, '/');
            if (req.url === '/password') return form.get('password') === 'secret' ? go(res, '/code', ['stage=code']) : go(res, '/password');
            if (req.url === '/code') return form.get('code') === accepted ? go(res, askStay ? '/stay' : '/home', askStay ? ['stage=stay'] : ['stage=in']) : go(res, '/code');
            if (req.url === '/stay') return go(res, '/home', ['stage=in']);
        }
        const stage = cookie(req, 'stage');
        if (req.url === '/home' && stage === 'in') return res.end(html('<header id="user-menu">mia</header>'));
        if (req.url === '/password' && stage === 'password') return res.end(html('<form method="post" action="/password"><input id="pw" name="password" type="password"></form>'));
        if (req.url === '/code' && stage === 'code') return res.end(html('<form method="post" action="/code"><input id="code" name="code" autocomplete="one-time-code"></form>'));
        if (req.url === '/stay' && stage === 'stay') return res.end(html('<form method="post" action="/stay"><p>Stay signed in?</p><button id="stay-yes">Yes</button></form>'));
        return res.end(html('<form method="post" action="/user"><input id="tenant" name="tenant"><input id="ident" name="user"><button id="next">Next</button></form>'));
    });
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launchChrome();
});
after(async () => {
    await browser?.close();
    server?.close();
});

const STEPS = [
    { fill: '#tenant', value: 'nord' },
    { fill: '#ident', with: 'user' },
    { click: '#next' },
    { fill: '#pw', with: 'password' },
    { press: 'Enter', on: '#pw' },
    { fill: '#code', with: 'totp' },
    { press: 'Enter', on: '#code' },
    { click: '#stay-yes', optional: true },
];

test('stepSignIn: steps in order; a refused code is sent once more from the totp step with the next window\'s code; codes reported for masking', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    const tab = await context.newPage();
    let time = START;
    const codes = [];
    askStay = true;
    await stepSignIn(tab, {
        url: `${base}/`, marker: '#user-menu', steps: STEPS, login: 'mia', password: 'secret', totpSecret: SECRET,
        onCode: (code) => codes.push(code), now: () => time, sleep: async (ms) => { time += ms; },
    });
    assert.equal(await tab.locator('#user-menu').textContent(), 'mia');
    assert.equal(codes.length, 2, 'the first code was refused, the second taken');
    assert.equal(codes[1], accepted);
});

test('stepSignIn: an optional step whose element does not come is skipped; a missing required one names the step, never a value', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    const tab = await context.newPage();
    // Starting in the next window: the first code is taken.
    let time = (Math.floor(START / WINDOW_MS) + 1) * WINDOW_MS + 2000;
    askStay = false;
    const started = Date.now();
    await stepSignIn(tab, { url: `${base}/`, marker: '#user-menu', steps: STEPS, login: 'mia', password: 'secret', totpSecret: SECRET, now: () => time, sleep: async (ms) => { time += ms; } });
    assert.ok(Date.now() - started < 15_000, `optional step skipped after ${Date.now() - started} ms`);
    await context.clearCookies();
    const broken = [STEPS[0], STEPS[1], { click: '#weiter', timeoutMs: 500 }];
    await assert.rejects(stepSignIn(tab, { url: `${base}/`, marker: '#user-menu', steps: broken, login: 'mia', password: 'secret' }),
        (error) => error.code === 'login-failed' && /Anmeldeschritt 3 \(click #weiter\): Das Element erschien nicht \(auf \/\)/.test(error.message) && !/mia|secret/.test(error.message));
});
