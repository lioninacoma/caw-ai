// Overlay in real Chrome: the deployed page (nonce CSP, integrity) gets the tags of the local build with a different chunk split.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';


import { interceptDocuments } from '../src/host/app-view.mjs';
import { incompleteText, prepareOverlay, routeOverlay } from '../src/host/overlay.mjs';
import { launchChrome } from './chrome.mjs';

let browser;
let server;
let origin;
let root;

// Deployed: an entry that needs a vendor chunk. Local: an entry with two other chunks. If the local entry only got the deployed name
// (per-request mapping), its chunks would still load but the vendor preload would go nowhere; with the swap the page loads exactly
// the local set.
const DEPLOYED_PAGE = `<!doctype html><html><head><meta charset="iso-8859-1"><title>Grüße</title>
<script nonce="r4nd0m" src="/env.js"></script>
<script type="module" nonce="r4nd0m" src="/assets/index-OLD11111.js" integrity="sha384-deployed"></script>
<link rel="modulepreload" href="/assets/vendor-OLD22222.js">
</head><body><p id="text">Grüße</p></body></html>`;

before(async () => {
    browser = await launchChrome();
    root = mkdtempSync(join(tmpdir(), 'caw-overlay-browser-'));
    const files = {
        'public/env.js': 'window.ENV = "lokal";',
        'dist/env.js': 'window.ENV = "lokal";',
        'dist/index.html': '<!doctype html><html><head><script src="/env.js"></script><script type="module" src="/assets/index-NEW11111.js"></script><link rel="modulepreload" href="/assets/a-NEW33333.js"></head><body></body></html>',
        'dist/assets/index-NEW11111.js': 'import { a } from "./a-NEW33333.js"; import { b } from "./b-NEW44444.js"; window.BUILD = `lokal ${a}${b}`;',
        'dist/assets/a-NEW33333.js': 'export const a = "A";',
        'dist/assets/b-NEW44444.js': 'export const b = "B";',
    };
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(root, name, '..'), { recursive: true });
        writeFileSync(join(root, name), text);
    }
    server = createServer((request, response) => {
        const path = new URL(request.url, 'http://x').pathname;
        const js = { 'content-type': 'text/javascript' };
        if (path === '/env.js') return response.writeHead(200, js).end('window.ENV = "staging";');
        if (path === '/assets/index-OLD11111.js') return response.writeHead(200, js).end('import { v } from "./vendor-OLD22222.js"; window.BUILD = `deployed ${v}`;');
        if (path === '/assets/vendor-OLD22222.js') return response.writeHead(200, js).end('export const v = "V";');
        return response.writeHead(200, {
            'content-type': 'text/html; charset=iso-8859-1',
            'content-security-policy': "script-src 'nonce-r4nd0m' 'strict-dynamic'",
        }).end(Buffer.from(DEPLOYED_PAGE, 'latin1'));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await browser?.close();
    server?.close();
    rmSync(root, { recursive: true, force: true });
});

test('Overlay build in the browser: local state despite different split, nonce CSP and integrity; env.js from the server; Latin-1 kept', async (t) => {
    if (browser === null) {
        t.skip('no Chrome');
        return;
    }
    const overlay = await prepareOverlay({ root, config: { apps: { web: { dir: '.' } } }, checked: { url: origin, apps: { web: { kind: 'build', dir: 'dist', statics: [] } } } });
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    const problems = [];
    await routeOverlay(context, overlay, { onProblem: (error) => problems.push(error.message) });
    await interceptDocuments(context, page, ['127.0.0.1'], { request: context.request, rewrite: overlay.rewritePage });
    await page.goto(`${origin}/bestellung/5`);
    await page.waitForFunction(() => window.BUILD !== undefined);
    assert.equal(await page.evaluate(() => window.BUILD), 'lokal AB');
    assert.equal(await page.evaluate(() => window.ENV), 'staging', 'the environment sets env.js');
    assert.equal(await page.textContent('#text'), 'Grüße');
    assert.deepEqual(errors, []);
    assert.deepEqual(problems, []);
    assert.equal(overlay.pages.at(-1).swaps[0].inserted, 2, 'entry and preload; env.js not twice');
    const seen = overlay.diagnose();
    assert.deepEqual({ ssr: seen.ssr, local: seen.local, swapped: seen.swapped, mixed: seen.mixed, label: seen.label }, { ssr: null, local: 3, swapped: true, mixed: [], label: 'dist' });
    assert.ok(seen.server >= 1, 'env.js from the server');
});

// A portal like FA214: the theme via a plain path, app and package through a proxy servlet with the repository path as parameter.
const PORTAL_PAGE = `<!doctype html><html><head>
<script src="/html/js/theme/theme.js"></script>
<script src="/o/FormProxyServlet?url=inubitrepository:///Root/public/PackagesExtJS6/modell.js"></script>
<script src="/o/FormProxyServlet?url=inubitrepository:///Root/Fachanwendung214/Bestellung.js"></script>
</head><body></body></html>`;

test('Overlay watch in the browser: app and package via a proxy parameter are a mixed state with a pattern; with it the load is local', async (t) => {
    if (browser === null) {
        t.skip('no Chrome');
        return;
    }
    const project = mkdtempSync(join(tmpdir(), 'caw-overlay-portal-'));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    const files = {
        'app/app.json': JSON.stringify({ name: 'Bestellung', output: { js: { path: 'Bestellung.js' } } }),
        'app/app/Main.js': 'window.APP = `lokal ${window.MODELL}`;',
        'packages/modell/src/M.js': 'window.MODELL = "lokal";',
        'packages/theme/src/T.js': 'window.THEME = "lokal";',
        'app/bootstrap.json': JSON.stringify({ loadOrder: [{ path: '../packages/theme/src/T.js' }, { path: '../packages/modell/src/M.js' }, { path: 'app/Main.js' }], packages: { theme: { files: [0] }, modell: { files: [1] } } }),
    };
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(project, name, '..'), { recursive: true });
        writeFileSync(join(project, name), text);
    }
    const portal = createServer((request, response) => {
        const url = new URL(request.url, 'http://x');
        const js = { 'content-type': 'text/javascript' };
        if (url.pathname === '/html/js/theme/theme.js') return response.writeHead(200, js).end('window.THEME = "deployed";');
        if (url.pathname === '/o/FormProxyServlet') {
            const file = url.searchParams.get('url') ?? '';
            if (file.endsWith('/modell.js')) return response.writeHead(200, js).end('window.MODELL = "deployed";');
            if (file.endsWith('/Bestellung.js')) return response.writeHead(200, js).end('window.APP = `deployed ${window.MODELL}`;');
            return response.writeHead(404).end();
        }
        return response.writeHead(200, { 'content-type': 'text/html' }).end(PORTAL_PAGE);
    });
    await new Promise((resolve) => { portal.listen(0, '127.0.0.1', resolve); });
    t.after(() => portal.close());
    const portalUrl = `http://127.0.0.1:${portal.address().port}`;
    const open = async (config) => {
        const overlay = await prepareOverlay({ root: project, config: { framework: 'extjs', apps: { web: { dir: 'app' } }, ...config }, checked: { url: portalUrl, apps: { web: { kind: 'watch', statics: [] } } }, deps: { running: () => true } });
        const context = await browser.newContext();
        t.after(() => context.close());
        await routeOverlay(context, overlay);
        const page = await context.newPage();
        await page.goto(`${portalUrl}/group/start`);
        await page.waitForFunction(() => window.APP !== undefined);
        return { overlay, state: await page.evaluate(() => ({ app: window.APP, theme: window.THEME })) };
    };
    // Only the default pattern: the theme comes local, app and package deployed. That is the mixed state the run refuses.
    const mixed = await open({});
    assert.deepEqual(mixed.state, { app: 'deployed deployed', theme: 'lokal' });
    const seen = mixed.overlay.diagnose();
    assert.deepEqual(seen.missed.map(({ part }) => part).sort(), ['Bestellung', 'modell']);
    assert.equal(seen.suggestions.length, 1);
    assert.equal(seen.suggestions[0].pattern, '[?&]url=inubitrepository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)');
    assert.match(incompleteText(seen), /"\[\?&\]url=inubitrepository:\/\/\/Root\//);
    // With the suggested pattern everything expected comes local.
    const fixed = await open({ assetUrlPattern: [seen.suggestions[0].pattern] });
    assert.deepEqual(fixed.state, { app: 'lokal lokal', theme: 'lokal' });
    const complete = fixed.overlay.diagnose();
    assert.deepEqual(complete.missed, []);
    assert.deepEqual(complete.parts.map(({ status }) => status), ['local', 'local', 'local']);
});
