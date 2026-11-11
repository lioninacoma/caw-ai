import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { browserArgs, isBrowserClosedError, removeProfile, sweepStaleProfiles, trackAgentPages, unwrapLaunchError, watchBroken } from '../src/host/browser-session.mjs';
import { CawError } from '../src/shared/errors.mjs';

test('unwrapLaunchError: the sign-in error surfaces, anything else stays as it is', () => {
    const login = new CawError('login-failed', 'sign-in');
    assert.equal(unwrapLaunchError(new Error('Could not launch', { cause: login })), login);
    const other = new Error('Could not launch', { cause: new Error('no Chrome') });
    assert.equal(unwrapLaunchError(other), other);
    assert.equal(unwrapLaunchError(login), login);
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

test('browserArgs: everything blocked except the hosts, no proxy, no WebRTC, never a CDP port', () => {
    const args = browserArgs(['portal.example', 'sso.example']);
    assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE portal.example, EXCLUDE sso.example'));
    assert.ok(args.includes('--no-proxy-server'));
    assert.ok(args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(!args.some((arg) => arg.includes('remote-debugging')));
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
    const { writeLabel } = await import('../src/host/browser-session.mjs');
    const label = (method, path) => writeLabel({ method, url: `http://localhost:5173${path}` });
    for (const path of ['/api/login', '/api/auth/logout', '/api/session', '/api/v1/token/refresh', '/oauth/token', '/sign-in', '/j_spring_security_check/../login/', '/api/csrf']) assert.equal(label('POST', path), null, path);
    assert.equal(label('POST', '/api/files'), 'POST /api/files');
    assert.equal(label('DELETE', '/api/sessions-archive/3'), 'DELETE /api/sessions-archive/3', 'only the last segment counts');
    assert.equal(label('PUT', '/api/user/login-hint'), 'PUT /api/user/login-hint');
    assert.equal(label('GET', '/api/files'), null);
    assert.equal(writeLabel({ method: 'POST', url: 'http://x/c?action=login' }, ['action']), 'action login', 'requestKeys take precedence');
});
