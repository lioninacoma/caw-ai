// Overlay in real Chrome: the deployed page (nonce CSP, integrity) gets the tags of the local build with a different chunk split.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';


import { interceptDocuments } from '../src/host/app-view.mjs';
import { prepareOverlay, routeOverlay } from '../src/host/overlay.mjs';
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
