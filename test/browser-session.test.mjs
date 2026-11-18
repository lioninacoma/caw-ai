import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isBrowserClosedError, removeProfile, sweepStaleProfiles, trackAgentPages, watchBroken } from '../src/host/browser-session.mjs';
import { createPlaywrightLauncher } from '../src/host/devlink-core.mjs';
import { CawError } from '../src/shared/errors.mjs';

test('launcher: a failure after Chrome started (sign-in) keeps its own message; a real launch failure names Chrome', async () => {
    const login = Object.assign(new CawError('login-failed', 'sign-in'), { afterLaunch: true });
    await assert.rejects(createPlaywrightLauncher(async () => { throw login; }).launch({ profileDir: 'x' }), (error) => error === login);
    const navigation = Object.assign(new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://ci.localhost/login'), { afterLaunch: true });
    await assert.rejects(createPlaywrightLauncher(async () => { throw navigation; }).launch({ profileDir: 'x' }), (error) => error === navigation);
    await assert.rejects(createPlaywrightLauncher(async () => { throw new Error('no Chrome'); }).launch({ profileDir: 'x' }), /Could not launch the host's Chrome/);
});

test('removeProfile: retries while Chrome holds files, and never throws', async () => {
    let calls = 0;
    const busyTwice = () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    assert.equal(await removeProfile('x', { remove: busyTwice, delayMs: 1 }), true);
    assert.equal(calls, 3);

    const always = () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
    assert.equal(await removeProfile('x', { remove: always, attempts: 3, delayMs: 1 }), false);
});

test('sweepStaleProfiles: removes orphans, leaves running sessions and foreign folders alone', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-sweep-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const profile = (name, owner, ownerFile = 'caw-owner') => {
        const path = join(dir, name);
        mkdirSync(path);
        if (owner !== undefined) writeFileSync(join(path, ownerFile), String(owner));
        return path;
    };
    const dead = profile('caw-profile-dead', 111);
    const alive = profile('caw-profile-alive', 222);
    const young = profile('caw-profile-young');
    const old = profile('caw-profile-old');
    utimesSync(old, new Date(0), new Date(0));
    const foreign = profile('other-tool', 111);

    assert.equal(sweepStaleProfiles({ dir, isAlive: (pid) => pid === 222 }), 2);
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(alive), true);
    assert.equal(existsSync(young), true);
    assert.equal(existsSync(foreign), true);
});

test('sweepStaleProfiles: locked profiles and missing folders do not disturb the start', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-sweep-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'caw-profile-locked'));
    writeFileSync(join(dir, 'caw-profile-locked', 'caw-owner'), '1');
    const busy = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    assert.equal(sweepStaleProfiles({ dir, isAlive: () => false, remove: busy }), 0);
    assert.equal(sweepStaleProfiles({ dir: join(dir, 'does-not-exist') }), 0);
});

test('isBrowserClosedError: only closing the browser counts as harmless', () => {
    assert.ok(isBrowserClosedError(new Error('route.fulfill: Target page, context or browser has been closed')));
    assert.ok(!isBrowserClosedError(new Error('Cannot read properties of undefined')));
    assert.ok(!isBrowserClosedError(undefined));
});

test('trackAgentPages: a tab of the human does not count, popups of the application do', () => {
    const main = new EventEmitter();
    const human = new EventEmitter();
    const popup = new EventEmitter();
    const nested = new EventEmitter();
    const pages = trackAgentPages(main);

    assert.equal(pages.current(), main);
    assert.equal(pages.owns(human), false, 'never reported via popup');

    main.emit('popup', popup);
    assert.equal(pages.current(), popup);
    popup.emit('popup', nested);
    assert.equal(pages.current(), nested);
    assert.ok(pages.owns(main) && pages.owns(popup) && pages.owns(nested));

    nested.emit('close');
    assert.equal(pages.current(), popup);
    popup.emit('close');
    assert.equal(pages.current(), main);
    assert.ok(pages.owns(popup), 'late errors of a closed popup still count');
});

test('Embedded: the page accessing the top window is recognised as a consequence of embedding', async () => {
    const { CROSS_ORIGIN_TOP } = await import('../src/host/browser-session.mjs');
    assert.ok(CROSS_ORIGIN_TOP.test("SecurityError: Failed to read a named property 'App' from 'Window': Blocked a frame with origin \"https://portal.example\" from accessing a cross-origin frame."));
    assert.ok(!CROSS_ORIGIN_TOP.test('TypeError: x is not a function'));
});

test('Sign-in: failed requests appear in the message, method and path only', () => {
    const page = new EventEmitter();
    const request = (method, url, errorText) => ({ method: () => method, url: () => url, failure: () => (errorText === undefined ? null : { errorText }) });
    const broken = watchBroken(page, 2);
    assert.equal(broken.text(), '');
    page.emit('requestfailed', request('GET', 'http://app.localhost:5173/api/session?token=secret', 'net::ERR_CONNECTION_REFUSED'));
    page.emit('response', { status: () => 200, request: () => request('GET', 'http://x/ok') });
    page.emit('response', { status: () => 502, request: () => request('POST', 'http://app.localhost:5173/api/login') });
    page.emit('response', { status: () => 502, request: () => request('POST', 'http://app.localhost:5173/api/login') });
    page.emit('response', { status: () => 500, request: () => request('GET', 'http://app.localhost:5173/api/me') });
    const text = broken.text();
    assert.equal(text, 'Gescheiterte Anfragen: GET /api/session (net::ERR_CONNECTION_REFUSED), POST /api/login (HTTP 502) und 1 weitere. Läuft das Backend der Anwendung?');
    assert.doesNotMatch(text, /secret/);
    broken.stop();
    assert.equal(page.listenerCount('requestfailed') + page.listenerCount('response'), 0);
});

test('Writing calls: sign-in, sign-out, session and token do not count, business calls do', async () => {
    const { requestName } = await import('../src/host/network-log.mjs');
    const { classifyRequest } = await import('../src/shared/requests.mjs');
    const kind = (method, path, keys = []) => classifyRequest(requestName({ method, url: `http://localhost:5173${path}` }, keys));
    for (const path of ['/api/login', '/api/auth/logout', '/api/session', '/api/v1/token/refresh', '/oauth/token', '/sign-in', '/j_spring_security_check/../login/', '/api/csrf']) assert.equal(kind('POST', path), 'ignored', path);
    assert.equal(kind('POST', '/api/files'), 'write');
    assert.equal(kind('DELETE', '/api/sessions-archive/3'), 'write', 'only the last segment counts');
    assert.equal(kind('PUT', '/api/user/login-hint'), 'write');
    assert.equal(kind('GET', '/api/files'), 'read');
    assert.equal(kind('GET', '/c?action=save', ['action']), 'read', 'a request key names a request, it does not make a GET writing');
    assert.equal(kind('POST', '/c?action=load', ['action']), 'write', 'a POST through one endpoint writes unless reads names it');
});

test('production write block: any host, sign-in only while caw signs in and only on the sign-in hosts, reads still pass', async () => {
    const { productionWriteName } = await import('../src/host/browser-session.mjs');
    const { compileReads } = await import('../src/shared/requests.mjs');
    const signInHosts = new Set(['shop.example', 'sso.example']);
    const write = (method, url, options = {}, body = {}) => productionWriteName({ method, url, ...body }, { signInHosts, ...options });
    assert.equal(write('POST', 'https://shop.example/api/orders'), 'POST /api/orders');
    assert.equal(write('POST', 'https://collect.analytics.example/v1/events'), 'POST /v1/events', 'a third-party host is no exception');
    assert.equal(write('PUT', 'https://SHOP.example./api/orders/7'), 'PUT /api/orders/:id');
    assert.equal(write('GET', 'https://elsewhere.example/x'), null);
    assert.equal(write('OPTIONS', 'https://shop.example/api/orders'), null);
    assert.equal(write('POST', 'https://shop.example/api/session'), 'POST /api/session', 'a sign-in path outside caw\'s own sign-in writes');
    assert.equal(write('DELETE', 'https://shop.example/api/session'), 'DELETE /api/session');
    assert.equal(write('POST', 'https://sso.example/login', { signingIn: true }), null, 'caw signing in: the sign-in hosts pass');
    assert.equal(write('POST', 'https://tracker.example/collect', { signingIn: true }), 'POST /collect', 'but no other host');
    assert.equal(write('POST', 'https://shop.example/graphql', {}, { postData: JSON.stringify({ query: 'query Me { me { id } }' }), contentType: 'application/json' }), null, 'a GraphQL query reads');
    assert.equal(write('POST', 'https://shop.example/api/search', { reads: compileReads(['POST /api/search']) }), null, 'reads names it');
});

test('Chrome sandbox: the messages of a sandbox that cannot start are recognised, other launch failures are not', async () => {
    const { SANDBOX_FAILURE } = await import('../src/host/browser-session.mjs');
    assert.ok(SANDBOX_FAILURE.test('[FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel or see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md'));
    assert.ok(SANDBOX_FAILURE.test('[FATAL:zygote_host_impl_linux.cc(90)] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.'));
    assert.ok(!SANDBOX_FAILURE.test('browserType.launchPersistentContext: Chromium distribution \'chrome\' is not found'));
});

test('fillSecret: a failed sign-in fill names the field, never the value or Playwright\'s call log', async () => {
    const { fillSecret } = await import('../src/host/browser-session.mjs');
    const playwright = new Error('locator.fill: Error: Element is not an <input>\nCall log:\n  - fill("geheim-123")\n  - locator resolved to <div id="pw">');
    const error = await fillSecret(async () => { throw playwright; }, 'passwordSelector "#pw"').catch((caught) => caught);
    assert.equal(error.code, 'login-failed');
    assert.match(error.message, /passwordSelector "#pw"/);
    assert.doesNotMatch(`${error.message}\n${error.stack}`, /geheim-123|Call log/);
    assert.equal(error.cause, undefined);
});

test('fillSecret in Chrome: Playwright\'s own message would carry the value, caw\'s does not', async (t) => {
    const { launchChrome } = await import('./chrome.mjs');
    const { fillSecret } = await import('../src/host/browser-session.mjs');
    const browser = await launchChrome();
    if (browser === null) return t.skip('no Chrome');
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent('<div id="pw">not a field</div>');
    const raw = await page.locator('#pw').fill('geheim-123', { timeout: 500 }).catch((caught) => caught);
    assert.match(String(raw.message), /geheim-123/, 'the leak this guards against');
    const error = await fillSecret(() => page.locator('#pw').fill('geheim-123', { timeout: 500 }), 'passwordSelector "#pw"').catch((caught) => caught);
    assert.doesNotMatch(`${error.message}\n${error.stack}`, /geheim-123/);
});

test('certificateError: an untrusted certificate becomes an environment error naming insecureTls; anything else stays', async () => {
    const { certificateError } = await import('../src/host/run.mjs');
    const { exitOf } = await import('../src/shared/errors.mjs');
    const cert = new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://tls.localhost:18444/login\nCall log: ...');
    const error = certificateError(cert, { name: 'tls', insecureTls: false });
    assert.equal(error.code, 'env-certificate');
    assert.equal(exitOf(error.code), 2);
    assert.match(error.message, /tls\.localhost:18444.*ERR_CERT_AUTHORITY_INVALID.*environments\.tls\.insecureTls: true/);
    assert.match(certificateError(cert, { name: 'tls', insecureTls: true }).message, /obwohl environments\.tls\.insecureTls gesetzt ist/);
    assert.equal(certificateError(new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://x/'), { name: 'tls' }), null);
    assert.equal(certificateError(new CawError('login-failed', 'net::ERR_CERT_DATE_INVALID at https://x/'), { name: 'tls' }), null);
});
