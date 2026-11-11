import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { prepareOverlay } from '../src/host/overlay.mjs';
import { baseOf, codeTags, nonceOf, ssrMarker, swapPage } from '../src/host/page-swap.mjs';

const project = (t, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-swap-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    return dir;
};

const ENV = 'https://staging.example';
const config = { apps: { web: { dir: '.' } } };
const buildOverlay = async (t, files, { url = ENV, dir = 'dist' } = {}) => {
    const root = project(t, files);
    return prepareOverlay({ root, config, checked: { url, apps: { web: { kind: 'build', dir, statics: [] } } } });
};

// Deployed: Vite build with entry, vendor chunk and stylesheet, plus env.js (project copy) and a portal script.
const DEPLOYED = `<!doctype html><html><head><meta charset="iso-8859-1"><title>Grüße</title>
<script nonce="n0nce" src="/env.js"></script>
<script nonce="n0nce">window.dataLayer=[]</script>
<script type="module" crossorigin nonce="n0nce" src="/assets/index-OLD11111.js" integrity="sha384-alt"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-OLD22222.js">
<link rel="stylesheet" crossorigin href="/assets/index-OLD33333.css" integrity="sha384-alt">
<link rel="icon" href="/favicon.ico">
<script type="application/json" id="data">{"a":1}</script>
</head><body><div id="root"></div><!-- <script src="/assets/alt-OLD44444.js"></script> --></body></html>`;

// Local: different split (two chunks instead of vendor), env.js copied unchanged from public/.
const LOCAL_INDEX = `<!doctype html><html><head><script src="/env.js"></script>
<script type="module" crossorigin src="/assets/index-NEW11111.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-NEW55555.js">
<link rel="modulepreload" crossorigin href="/assets/router-NEW66666.js">
<link rel="stylesheet" crossorigin href="/assets/index-NEW33333.css">
</head><body><div id="root"></div></body></html>`;

const viteFiles = {
    'public/env.js': "window.ENV='local'",
    'dist/env.js': "window.ENV='local'",
    'dist/index.html': LOCAL_INDEX,
    'dist/assets/index-NEW11111.js': 'import"./react-NEW55555.js"',
    'dist/assets/react-NEW55555.js': 'react',
    'dist/assets/router-NEW66666.js': 'router',
    'dist/assets/index-NEW33333.css': 'body{}',
};

test('codeTags: scripts, styles and preloads, not JSON, icons or commented-out tags', () => {
    const tags = codeTags(DEPLOYED, `${ENV}/order/5`);
    assert.deepEqual(tags.map(({ urls, inline }) => (inline ? 'inline' : urls[0])), [
        `${ENV}/env.js`, 'inline', `${ENV}/assets/index-OLD11111.js`, `${ENV}/assets/vendor-OLD22222.js`, `${ENV}/assets/index-OLD33333.css`,
    ]);
    assert.equal(nonceOf(DEPLOYED), 'n0nce');
    assert.equal(baseOf('<base href="/shop/">', `${ENV}/x/y`), `${ENV}/shop/`);
    assert.equal(baseOf('<p>', `${ENV}/x/y`), `${ENV}/x/y`);
});

test('ssrMarker: Next, Nuxt, SvelteKit and Angular SSR, not an ordinary page', () => {
    assert.equal(ssrMarker('<script>self.__next_f.push([1,""])</script>'), 'Next.js');
    assert.equal(ssrMarker('<script id="__NEXT_DATA__" type="application/json">{}</script>'), 'Next.js');
    assert.equal(ssrMarker('<script>window.__NUXT__={}</script>'), 'Nuxt');
    assert.equal(ssrMarker('<script type="application/json" id="__NUXT_DATA__">[]</script>'), 'Nuxt');
    assert.equal(ssrMarker('<a data-sveltekit-preload-data href="/">'), 'SvelteKit');
    assert.equal(ssrMarker('<app-root ng-server-context="ssr">'), 'Angular SSR');
    assert.equal(ssrMarker(DEPLOYED), null);
});

test('swapPage: at the place of the first removed tag, with the page nonce; the rest stays byte for byte', () => {
    const base = `${ENV}/`;
    const local = codeTags('<head><script src="/a-NEW.js"></script></head><body><script src="/b-NEW.js"></script></body>', base);
    const html = '<head><title>x</title><script nonce="abc" src="/a-OLD.js"></script><meta x><link rel="stylesheet" href="/s-OLD.css"></head><body><p>ä</p><script src="/b-OLD.js"></script></body>';
    const swapped = swapPage(html, { base, owned: ({ urls }) => urls.some((url) => url.includes('OLD')), local });
    assert.equal(swapped.html, '<head><title>x</title><script nonce="abc" src="/a-NEW.js"></script><meta x></head><body><p>ä</p><script nonce="abc" src="/b-NEW.js"></script></body>');
    assert.deepEqual(swapped.removed, [`${ENV}/a-OLD.js`, `${ENV}/s-OLD.css`, `${ENV}/b-OLD.js`]);
    const appended = swapPage('<head></head><body><script src="/keep.js"></script></body>', { base, owned: () => false, local });
    assert.equal(appended.html, '<head><script src="/a-NEW.js"></script></head><body><script src="/keep.js"></script><script src="/b-NEW.js"></script></body>', 'nothing removed: appended at the end');
});

test('Overlay build: a different split starts because the page gets the local build tags; env.js, inline and portal stay', async (t) => {
    const overlay = await buildOverlay(t, viteFiles);
    const out = await overlay.rewritePage(DEPLOYED, { url: `${ENV}/order/5` });
    assert.match(out, /<script nonce="n0nce" type="module" crossorigin src="\/assets\/index-NEW11111\.js"><\/script>/, 'with the page nonce');
    assert.equal(out.match(/nonce=/g).length, 6, 'one nonce per tag, none twice');
    assert.match(out, /href="\/assets\/react-NEW55555\.js"/);
    assert.match(out, /href="\/assets\/router-NEW66666\.js"/);
    assert.match(out, /href="\/assets\/index-NEW33333\.css"/);
    assert.doesNotMatch(out, /OLD11111|vendor-OLD22222|index-OLD33333/, 'no deployed code tag of the app');
    assert.equal(out.match(/src="\/env\.js"/g).length, 1, 'env.js stays the environment one, once');
    assert.match(out, /window\.dataLayer=\[\]/);
    assert.match(out, /rel="icon"/);
    assert.match(out, /<!-- <script src="\/assets\/alt-OLD44444\.js"><\/script> -->/, 'comments stay');
    assert.doesNotMatch(out, /integrity/);
    assert.match(out, /Grüße/, 'Latin-1 stays');
    assert.deepEqual(overlay.pages.at(-1).swaps, [{ app: 'web', removed: [`${ENV}/assets/index-OLD11111.js`, `${ENV}/assets/vendor-OLD22222.js`, `${ENV}/assets/index-OLD33333.css`], inserted: 4 }]);
});

test('Overlay build: no swap without a match (sign-in page), with SSR, and when the build has a different base path', async (t) => {
    const overlay = await buildOverlay(t, viteFiles);
    const login = '<html><head><script src="/sso/login.js"></script></head><body><form></form></body></html>';
    assert.equal(await overlay.rewritePage(login, { url: `${ENV}/signin` }), login);
    assert.deepEqual(overlay.pages.at(-1).swaps, [{ app: 'web', skipped: 'no-match' }]);
    const next = DEPLOYED.replace('</body>', '<script>self.__next_f.push([1,""])</script></body>');
    assert.match(await overlay.rewritePage(next, { url: `${ENV}/` }), /index-OLD11111/);
    assert.equal(overlay.pages.at(-1).ssr, 'Next.js');
    // The environment lives under /shop/, the build points to /assets/: the environment pattern does not cover the address.
    const shop = await buildOverlay(t, viteFiles, { url: `${ENV}/shop/` });
    const shopPage = DEPLOYED.replaceAll('"/assets/', '"/shop/assets/');
    assert.match(await shop.rewritePage(shopPage, { url: `${ENV}/shop/` }), /shop\/assets\/index-OLD11111/);
    assert.deepEqual(shop.pages.at(-1).swaps, [{ app: 'web', skipped: 'local-base' }]);
});

test('Overlay build: of several pages the one with the most matches; inline webpack runtime with the asset folder is replaced', async (t) => {
    const overlay = await buildOverlay(t, {
        'dist/index.html': '<head><script defer src="/static/js/main.NEW1a2b3c.js"></script><script>__webpack_public_path__="/static/js/"</script></head>',
        'dist/admin.html': '<head><script defer src="/static/js/admin.NEW9f8e7d.js"></script></head>',
        'dist/static/js/main.NEW1a2b3c.js': 'main',
        'dist/static/js/admin.NEW9f8e7d.js': 'admin',
        'dist/static/js/chunk.NEW4d5e6f.js': 'chunk',
    });
    const deployed = '<head><script>__webpack_public_path__="/static/js/";var old=1</script><script defer src="/static/js/admin.OLD1a2b3c.js"></script><script defer src="/static/js/chunk.OLD4d5e6f.js"></script></head>';
    const out = await overlay.rewritePage(deployed, { url: `${ENV}/admin` });
    assert.equal(out, '<head><script defer src="/static/js/admin.NEW9f8e7d.js"></script></head>', 'admin.html; the chunk in the asset folder is replaced, the old runtime too');
});

test('Diagnosis: SSR, nothing local and scripts from the local asset folder served by the server; the report names the overlay', async (t) => {
    const overlay = await buildOverlay(t, viteFiles);
    assert.deepEqual((({ ssr, local, swapped, mixed }) => ({ ssr, local, swapped, mixed }))(overlay.diagnose()), { ssr: null, local: 0, swapped: false, mixed: [] }, 'nothing loaded: nothing local');
    await overlay.rewritePage(DEPLOYED.replace('</body>', '<script>window.__NUXT__={}</script></body>'), { url: `${ENV}/` });
    assert.equal(overlay.diagnose().ssr, 'Nuxt');
    overlay.served.local.set(`${ENV}/assets/index-NEW11111.js`, 'script');
    overlay.served.server.set(`${ENV}/assets/legacy-OLD77777.js`, 'script');
    overlay.served.server.set(`${ENV}/env.js`, 'script');
    assert.deepEqual(overlay.diagnose().mixed, [`${ENV}/assets/legacy-OLD77777.js`], 'env.js in the root folder is not a mixed state');
    const { renderReport } = await import('../src/shared/report.mjs');
    const report = renderReport({ status: 'pass', testId: 'smoke', target: 'staging', source: 'overlay', overlay: { label: 'dist', local: 3, server: 1, swapped: true } });
    assert.match(report, /Getesteter Stand: lokaler Code über der Umgebung \(--overlay\)\nOverlay: dist; 3 Datei\(en\) lokal, 1 Skript\(e\)\/Stylesheet\(s\) vom Server; Seite getauscht: ja/);
});

test('Overlay dev: tags from the dev server HTML, project copies and foreign scripts stay', async (t) => {
    const root = project(t, { 'public/env.js': "window.ENV='local'" });
    const dev = createServer((request, response) => {
        const path = new URL(request.url, 'http://x').pathname;
        if (path === '/env.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end("window.ENV='local'");
        if (path.startsWith('/src/') || path.startsWith('/@')) return response.writeHead(200, { 'content-type': 'text/javascript' }).end('code');
        return response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><script src="/env.js"></script>
<script type="module">import RefreshRuntime from "/@react-refresh";window.$RefreshReg$=()=>{}</script>
<script type="module" src="/@vite/client"></script></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);
    });
    await new Promise((ok) => { dev.listen(0, '127.0.0.1', ok); });
    t.after(() => dev.close());
    const url = `http://127.0.0.1:${dev.address().port}`;
    const overlay = await prepareOverlay({ root, config, checked: { url: ENV, apps: { web: { kind: 'dev', url, statics: [] } } } });
    const deployed = DEPLOYED.replace('<link rel="icon"', '<script src="https://cdn.example/analytics.js"></script><link rel="icon"');
    const out = await overlay.rewritePage(deployed, { url: `${ENV}/order/5` });
    assert.match(out, /<script nonce="n0nce" type="module">import RefreshRuntime from "\/@react-refresh"/, 'the preamble with nonce');
    assert.match(out, /<script nonce="n0nce" type="module" src="\/@vite\/client"><\/script>/);
    assert.match(out, /<script nonce="n0nce" type="module" src="\/src\/main\.tsx"><\/script><\/body>/);
    assert.doesNotMatch(out, /OLD11111|OLD22222|OLD33333/);
    assert.equal(out.match(/src="\/env\.js"/g).length, 1);
    assert.match(out, /cdn\.example\/analytics\.js/, 'foreign origin stays');
    assert.match(out, /window\.dataLayer/);
});
