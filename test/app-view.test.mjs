import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { embeddableHeaders, frameView, fromWorkbenchSource, postBody, sourceTag } from '../src/host/app-view.mjs';
import { browserArgs, trackAgentPages } from '../src/host/browser-session.mjs';
import { embedsApp } from '../src/host/run.mjs';

test('Werkbank-Skripte tragen einen eigenen Namen: Ihre Meldungen zählen nie zur Anwendung', () => {
    assert.match(sourceTag, /sourceURL=caw-werkbank\.js/);
    assert.ok(fromWorkbenchSource('caw-werkbank.js'));
    assert.ok(fromWorkbenchSource('    at refresh (caw-werkbank.js:12:3)'));
    assert.ok(fromWorkbenchSource('about:srcdoc'));
    assert.ok(!fromWorkbenchSource('https://portal.example/app.js'));
    assert.ok(!fromWorkbenchSource(undefined));
});

test('postBody: Formulardaten aus CDP, auch in mehreren Teilen', () => {
    assert.equal(postBody({ postDataEntries: [{ bytes: Buffer.from('a=1&').toString('base64') }, { bytes: Buffer.from('b=2').toString('base64') }] }).toString(), 'a=1&b=2');
    assert.equal(postBody({ postData: 'x=y' }).toString(), 'x=y');
    assert.equal(postBody({}), undefined);
});

test('embeddableHeaders: X-Frame-Options weg, aus der CSP nur frame-ancestors', () => {
    assert.equal(embeddableHeaders([{ name: 'Content-Type', value: 'text/html' }]), null, 'nichts zu ändern');
    assert.deepEqual(embeddableHeaders([
        { name: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { name: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'self'; img-src *" },
        { name: 'Set-Cookie', value: 'a=1' },
    ]), [
        { name: 'Content-Security-Policy', value: "default-src 'self'; img-src *" },
        { name: 'Set-Cookie', value: 'a=1' },
    ]);
    assert.deepEqual(embeddableHeaders([{ name: 'content-security-policy', value: "frame-ancestors 'none'" }]), [], 'leere CSP fällt weg');
    assert.equal(embeddableHeaders([{ name: 'Content-Security-Policy', value: "default-src 'self'" }]), null);
});

test('embedsApp: mit Mensch immer die Werkbank, unter jeder Adresse, ohne ihn das eigene Fenster', () => {
    assert.equal(embedsApp(true), true);
    assert.equal(embedsApp(false), false);
    assert.equal(embedsApp(undefined), false);
});

test('browserArgs: .localhost zeigt auf Loopback, statt das System zu fragen', () => {
    const args = browserArgs(['portal.localhost', 'caw-ui.portal.localhost', 'sso.example']);
    assert.ok(args.includes('--host-resolver-rules=MAP portal.localhost 127.0.0.1, MAP caw-ui.portal.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE sso.example'));
});

// Ein Frame, wie Playwright ihn liefert: Seite und Elternframe.
const fakeFrame = (page, parent = null) => ({ page: () => page, parentFrame: () => parent });

test('trackAgentPages mit Werkbank: Die Anwendung ist der Frame, Werkbank und Chat zählen nicht', () => {
    const bench = new EventEmitter();
    const pages = trackAgentPages(bench);
    const top = fakeFrame(bench);
    const app = fakeFrame(bench, top);
    const inner = fakeFrame(bench, app);
    const chat = fakeFrame(bench, top);
    const view = { frame: app };
    pages.embed(bench, view);

    assert.equal(pages.current(), view);
    assert.ok(pages.owns(view));
    assert.equal(pages.pageOf(app), view);
    assert.equal(pages.pageOf(inner), view, 'iframes der Anwendung gehören dazu');
    assert.equal(pages.pageOf(top), false);
    assert.equal(pages.pageOf(chat), false);
    assert.equal(pages.pageOf(null), null, 'Worker: lieber mitzählen');

    const popup = new EventEmitter();
    bench.emit('popup', popup);
    assert.equal(pages.current(), popup);
    assert.equal(pages.pageOf(fakeFrame(popup)), popup);
    popup.emit('close');
    assert.equal(pages.current(), view);
});

test('frameView: Neuladen und Navigation betreffen nur den Frame', async () => {
    const calls = [];
    const page = new EventEmitter();
    page.locator = (selector) => ({ screenshot: async () => { calls.push(`shot ${selector}`); return Buffer.from('png'); } });
    const frame = {
        url: () => 'https://portal.localhost:8443/app',
        goto: async (url) => { calls.push(`goto ${url}`); },
        evaluate: async () => { calls.push('location.reload'); },
        waitForNavigation: async () => {},
        waitForLoadState: async () => {},
        locator: (selector) => ({ ariaSnapshot: async () => `snapshot ${selector}` }),
        childFrames: () => [],
        isDetached: () => false,
    };
    let attached = frame;
    page.frame = ({ name }) => (name === 'caw-app' ? attached : null);
    const view = frameView(page, frame);
    await view.reload();
    await view.screenshot();
    assert.equal(await view.ariaSnapshot({ mode: 'ai' }), 'snapshot body');
    assert.deepEqual(calls, ['location.reload', 'shot iframe[name="caw-app"]'], 'echtes Neuladen, auch bei # in der Adresse');
    assert.deepEqual(view.frames(), [frame]);

    let loaded = 0;
    view.on('domcontentloaded', () => { loaded += 1; });
    page.emit('framenavigated', { other: true });
    page.emit('framenavigated', frame);
    await new Promise((ok) => { setImmediate(ok); });
    assert.equal(loaded, 1, 'nur die Navigation des eigenen Frames');

    // Die Werkbank wurde neu geladen: neues iframe, die Sicht folgt ihm.
    const fresh = { ...frame, url: () => 'https://portal.localhost:8443/neu' };
    attached = fresh;
    assert.equal(view.url(), 'https://portal.localhost:8443/neu');
    assert.equal(view.frame, fresh);
});
