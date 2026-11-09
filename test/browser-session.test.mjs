import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { browserArgs, isBrowserClosedError, removeProfile, sweepStaleProfiles, trackAgentPages, unwrapLaunchError, watchBroken } from '../src/host/browser-session.mjs';
import { CawError } from '../src/shared/errors.mjs';

test('unwrapLaunchError: Der Anmeldefehler kommt zum Vorschein, Fremdes bleibt, wie es ist', () => {
    const login = new CawError('login-failed', 'Anmeldung');
    assert.equal(unwrapLaunchError(new Error('Could not launch', { cause: login })), login);
    const other = new Error('Could not launch', { cause: new Error('kein Chrome') });
    assert.equal(unwrapLaunchError(other), other);
    assert.equal(unwrapLaunchError(login), login);
});

test('removeProfile: wiederholt, solange Chrome Dateien festhält, und wirft nie', async () => {
    let calls = 0;
    const busyTwice = () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('belegt'), { code: 'EBUSY' });
    };
    assert.equal(await removeProfile('x', { remove: busyTwice, delayMs: 1 }), true);
    assert.equal(calls, 3);

    const always = () => { throw Object.assign(new Error('belegt'), { code: 'EPERM' }); };
    assert.equal(await removeProfile('x', { remove: always, attempts: 3, delayMs: 1 }), false);
});

test('sweepStaleProfiles: entfernt Verwaistes, lässt laufende Sitzungen und Fremdes in Ruhe', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-sweep-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const profile = (name, owner, ownerFile = 'caw-owner') => {
        const path = join(dir, name);
        mkdirSync(path);
        if (owner !== undefined) writeFileSync(join(path, ownerFile), String(owner));
        return path;
    };
    const dead = profile('caw-profile-tot', 111);
    const alive = profile('caw-profile-lebt', 222);
    const young = profile('caw-profile-jung');
    const old = profile('caw-profile-alt');
    utimesSync(old, new Date(0), new Date(0));
    const foreign = profile('anderes-tool', 111);

    assert.equal(sweepStaleProfiles({ dir, isAlive: (pid) => pid === 222 }), 2);
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(alive), true);
    assert.equal(existsSync(young), true);
    assert.equal(existsSync(foreign), true);
});

test('sweepStaleProfiles: Belegte Profile und fehlende Ordner stören den Start nicht', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-sweep-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'caw-profile-belegt'));
    writeFileSync(join(dir, 'caw-profile-belegt', 'caw-owner'), '1');
    const busy = () => { throw Object.assign(new Error('belegt'), { code: 'EBUSY' }); };
    assert.equal(sweepStaleProfiles({ dir, isAlive: () => false, remove: busy }), 0);
    assert.equal(sweepStaleProfiles({ dir: join(dir, 'gibt-es-nicht') }), 0);
});

test('isBrowserClosedError: nur das Schliessen des Browsers gilt als harmlos', () => {
    assert.ok(isBrowserClosedError(new Error('route.fulfill: Target page, context or browser has been closed')));
    assert.ok(!isBrowserClosedError(new Error('Cannot read properties of undefined')));
    assert.ok(!isBrowserClosedError(undefined));
});

test('browserArgs: alles gesperrt außer den Hosts, kein Proxy, kein WebRTC, nie ein CDP-Port', () => {
    const args = browserArgs(['portal.example', 'sso.example']);
    assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE portal.example, EXCLUDE sso.example'));
    assert.ok(args.includes('--no-proxy-server'));
    assert.ok(args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(!args.some((arg) => arg.includes('remote-debugging')));
});

test('trackAgentPages: Ein Tab des Menschen zählt nicht, Popups der Anwendung schon', () => {
    const main = new EventEmitter();
    const human = new EventEmitter();
    const popup = new EventEmitter();
    const nested = new EventEmitter();
    const pages = trackAgentPages(main);

    assert.equal(pages.current(), main);
    assert.equal(pages.owns(human), false, 'nie über popup gemeldet');

    main.emit('popup', popup);
    assert.equal(pages.current(), popup);
    popup.emit('popup', nested);
    assert.equal(pages.current(), nested);
    assert.ok(pages.owns(main) && pages.owns(popup) && pages.owns(nested));

    nested.emit('close');
    assert.equal(pages.current(), popup);
    popup.emit('close');
    assert.equal(pages.current(), main);
    assert.ok(pages.owns(popup), 'Späte Fehler eines geschlossenen Popups zählen weiter');
});

test('Eingebettet: Zugriff der Seite auf das oberste Fenster erkennt die Werkbank als Folge der Einbettung', async () => {
    const { CROSS_ORIGIN_TOP } = await import('../src/host/browser-session.mjs');
    assert.ok(CROSS_ORIGIN_TOP.test("SecurityError: Failed to read a named property 'App' from 'Window': Blocked a frame with origin \"https://portal.example\" from accessing a cross-origin frame."));
    assert.ok(!CROSS_ORIGIN_TOP.test('TypeError: x is not a function'));
});

test('Anmeldung: Gescheiterte Anfragen stehen in der Meldung, nur Methode und Pfad', () => {
    const page = new EventEmitter();
    const request = (method, url, errorText) => ({ method: () => method, url: () => url, failure: () => (errorText === undefined ? null : { errorText }) });
    const broken = watchBroken(page, 2);
    assert.equal(broken.text(), '');
    page.emit('requestfailed', request('GET', 'http://app.localhost:5173/api/session?token=geheim', 'net::ERR_CONNECTION_REFUSED'));
    page.emit('response', { status: () => 200, request: () => request('GET', 'http://x/ok') });
    page.emit('response', { status: () => 502, request: () => request('POST', 'http://app.localhost:5173/api/login') });
    page.emit('response', { status: () => 502, request: () => request('POST', 'http://app.localhost:5173/api/login') });
    page.emit('response', { status: () => 500, request: () => request('GET', 'http://app.localhost:5173/api/me') });
    const text = broken.text();
    assert.equal(text, 'Gescheiterte Anfragen: GET /api/session (net::ERR_CONNECTION_REFUSED), POST /api/login (HTTP 502) und 1 weitere. Läuft das Backend der Anwendung?');
    assert.doesNotMatch(text, /geheim/);
    broken.stop();
    assert.equal(page.listenerCount('requestfailed') + page.listenerCount('response'), 0);
});

test('Schreibende Aufrufe: An- und Abmelden, Sitzung und Token zählen nicht, Fachliches schon', async () => {
    const { writeLabel } = await import('../src/host/browser-session.mjs');
    const label = (method, path) => writeLabel({ method, url: `http://localhost:5173${path}` });
    for (const path of ['/api/login', '/api/auth/logout', '/api/session', '/api/v1/token/refresh', '/oauth/token', '/sign-in', '/j_spring_security_check/../login/', '/api/csrf']) assert.equal(label('POST', path), null, path);
    assert.equal(label('POST', '/api/akten'), 'POST /api/akten');
    assert.equal(label('DELETE', '/api/sessions-archive/3'), 'DELETE /api/sessions-archive/3', 'nur der letzte Teil zählt');
    assert.equal(label('PUT', '/api/user/login-hint'), 'PUT /api/user/login-hint');
    assert.equal(label('GET', '/api/akten'), null);
    assert.equal(writeLabel({ method: 'POST', url: 'http://x/c?action=login' }, ['action']), 'action login', 'requestKeys gehen vor');
});
