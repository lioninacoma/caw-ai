import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { embeddableHeaders, frameView, fromWorkbenchSource, postBody, rewriteBytes, sourceTag } from '../src/host/app-view.mjs';
import { browserArgs, trackAgentPages } from '../src/host/browser-session.mjs';
import { embedsApp } from '../src/host/run.mjs';

test('Workbench scripts carry their own name: their messages never count for the application', () => {
    assert.match(sourceTag, /sourceURL=caw-werkbank\.js/);
    assert.ok(fromWorkbenchSource('caw-werkbank.js'));
    assert.ok(fromWorkbenchSource('    at refresh (caw-werkbank.js:12:3)'));
    assert.ok(fromWorkbenchSource('about:srcdoc'));
    assert.ok(!fromWorkbenchSource('https://portal.example/app.js'));
    assert.ok(!fromWorkbenchSource(undefined));
});

test('postBody: form data from CDP, also in several parts', () => {
    assert.equal(postBody({ postDataEntries: [{ bytes: Buffer.from('a=1&').toString('base64') }, { bytes: Buffer.from('b=2').toString('base64') }] }).toString(), 'a=1&b=2');
    assert.equal(postBody({ postData: 'x=y' }).toString(), 'x=y');
    assert.equal(postBody({}), undefined);
});

test('embeddableHeaders: X-Frame-Options removed, only frame-ancestors from the CSP', () => {
    assert.equal(embeddableHeaders([{ name: 'Content-Type', value: 'text/html' }]), null, 'nothing to change');
    assert.deepEqual(embeddableHeaders([
        { name: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { name: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'self'; img-src *" },
        { name: 'Set-Cookie', value: 'a=1' },
    ]), [
        { name: 'Content-Security-Policy', value: "default-src 'self'; img-src *" },
        { name: 'Set-Cookie', value: 'a=1' },
    ]);
    assert.deepEqual(embeddableHeaders([{ name: 'content-security-policy', value: "frame-ancestors 'none'" }]), [], 'an empty CSP is dropped');
    assert.equal(embeddableHeaders([{ name: 'Content-Security-Policy', value: "default-src 'self'" }]), null);
});

test('embedsApp: with a human always the workbench, at any address; without one the plain window', () => {
    assert.equal(embedsApp(true), true);
    assert.equal(embedsApp(false), false);
    assert.equal(embedsApp(undefined), false);
});

test('browserArgs: .localhost points to loopback instead of asking the system', () => {
    const args = browserArgs(['portal.localhost', 'caw-ui.portal.localhost', 'sso.example']);
    assert.ok(args.includes('--host-resolver-rules=MAP portal.localhost 127.0.0.1, MAP caw-ui.portal.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE sso.example'));
});

// A frame as Playwright provides it: page and parent frame.
const fakeFrame = (page, parent = null) => ({ page: () => page, parentFrame: () => parent });

test('trackAgentPages with workbench: the application is the frame, workbench and chat do not count', () => {
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
    assert.equal(pages.pageOf(inner), view, 'iframes of the application belong to it');
    assert.equal(pages.pageOf(top), false);
    assert.equal(pages.pageOf(chat), false);
    assert.equal(pages.pageOf(null), null, 'workers: better to count them');

    const popup = new EventEmitter();
    bench.emit('popup', popup);
    assert.equal(pages.current(), popup);
    assert.equal(pages.pageOf(fakeFrame(popup)), popup);
    popup.emit('close');
    assert.equal(pages.current(), view);
});

test('frameView: reload and navigation only affect the frame', async () => {
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
    assert.deepEqual(calls, ['location.reload', 'shot iframe[name="caw-app"]'], 'a real reload, even with # in the address');
    assert.deepEqual(view.frames(), [frame]);

    let loaded = 0;
    view.on('domcontentloaded', () => { loaded += 1; });
    page.emit('framenavigated', { other: true });
    page.emit('framenavigated', frame);
    await new Promise((ok) => { setImmediate(ok); });
    assert.equal(loaded, 1, 'only the own frame navigation');

    // The workbench was reloaded: new iframe, the view follows it.
    const fresh = { ...frame, url: () => 'https://portal.localhost:8443/new' };
    attached = fresh;
    assert.equal(view.url(), 'https://portal.localhost:8443/new');
    assert.equal(view.frame, fresh);
});

test('rewriteBytes: the page stays byte for byte in its encoding, only the changed part is new', async () => {
    const swap = (html) => html.replace('a.js', 'b.js');
    const latin1 = Buffer.from('<h1>Grüße</h1><script src="a.js"></script>', 'latin1');
    assert.deepEqual(await rewriteBytes(latin1, swap, 'http://x/'), Buffer.from('<h1>Grüße</h1><script src="b.js"></script>', 'latin1'));
    const utf8 = Buffer.from('<h1>Grüße €</h1><script src="a.js"></script>', 'utf8');
    assert.equal((await rewriteBytes(utf8, swap, 'http://x/')).toString('utf8'), '<h1>Grüße €</h1><script src="b.js"></script>');
    assert.equal(await rewriteBytes(utf8, (html) => html, 'http://x/'), utf8, 'unchanged: exactly the same bytes');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<script src="a.js">', 'utf16le')]);
    assert.equal(await rewriteBytes(utf16, swap, 'http://x/'), utf16, 'UTF-16 stays as it is');
    let seen = null;
    await rewriteBytes(utf8, (html, info) => { seen = info.url; return html; }, 'http://x/page');
    assert.equal(seen, 'http://x/page', 'rewrite knows the page address');
});
