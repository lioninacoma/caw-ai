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

// Ausgeliefert: Vite-Build mit Einstieg, Vendor-Chunk und Stylesheet, dazu env.js (Projektkopie) und ein Skript des Portals.
const DEPLOYED = `<!doctype html><html><head><meta charset="iso-8859-1"><title>Grüße</title>
<script nonce="n0nce" src="/env.js"></script>
<script nonce="n0nce">window.dataLayer=[]</script>
<script type="module" crossorigin nonce="n0nce" src="/assets/index-OLD11111.js" integrity="sha384-alt"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-OLD22222.js">
<link rel="stylesheet" crossorigin href="/assets/index-OLD33333.css" integrity="sha384-alt">
<link rel="icon" href="/favicon.ico">
<script type="application/json" id="daten">{"a":1}</script>
</head><body><div id="root"></div><!-- <script src="/assets/alt-OLD44444.js"></script> --></body></html>`;

// Lokal: andere Aufteilung (zwei Chunks statt Vendor), env.js aus public/ unveraendert mitkopiert.
const LOCAL_INDEX = `<!doctype html><html><head><script src="/env.js"></script>
<script type="module" crossorigin src="/assets/index-NEW11111.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-NEW55555.js">
<link rel="modulepreload" crossorigin href="/assets/router-NEW66666.js">
<link rel="stylesheet" crossorigin href="/assets/index-NEW33333.css">
</head><body><div id="root"></div></body></html>`;

const viteFiles = {
    'public/env.js': "window.ENV='lokal'",
    'dist/env.js': "window.ENV='lokal'",
    'dist/index.html': LOCAL_INDEX,
    'dist/assets/index-NEW11111.js': 'import"./react-NEW55555.js"',
    'dist/assets/react-NEW55555.js': 'react',
    'dist/assets/router-NEW66666.js': 'router',
    'dist/assets/index-NEW33333.css': 'body{}',
};

test('codeTags: Skripte, Stile und Preloads, nicht JSON, Icons oder Auskommentiertes', () => {
    const tags = codeTags(DEPLOYED, `${ENV}/bestellung/5`);
    assert.deepEqual(tags.map(({ urls, inline }) => (inline ? 'inline' : urls[0])), [
        `${ENV}/env.js`, 'inline', `${ENV}/assets/index-OLD11111.js`, `${ENV}/assets/vendor-OLD22222.js`, `${ENV}/assets/index-OLD33333.css`,
    ]);
    assert.equal(nonceOf(DEPLOYED), 'n0nce');
    assert.equal(baseOf('<base href="/shop/">', `${ENV}/x/y`), `${ENV}/shop/`);
    assert.equal(baseOf('<p>', `${ENV}/x/y`), `${ENV}/x/y`);
});

test('ssrMarker: Next, Nuxt, SvelteKit und Angular SSR, nicht eine gewoehnliche Seite', () => {
    assert.equal(ssrMarker('<script>self.__next_f.push([1,""])</script>'), 'Next.js');
    assert.equal(ssrMarker('<script id="__NEXT_DATA__" type="application/json">{}</script>'), 'Next.js');
    assert.equal(ssrMarker('<script>window.__NUXT__={}</script>'), 'Nuxt');
    assert.equal(ssrMarker('<script type="application/json" id="__NUXT_DATA__">[]</script>'), 'Nuxt');
    assert.equal(ssrMarker('<a data-sveltekit-preload-data href="/">'), 'SvelteKit');
    assert.equal(ssrMarker('<app-root ng-server-context="ssr">'), 'Angular SSR');
    assert.equal(ssrMarker(DEPLOYED), null);
});

test('swapPage: an der Stelle des ersten entfernten Tags, mit der Nonce der Seite; der Rest bleibt Byte fuer Byte', () => {
    const base = `${ENV}/`;
    const local = codeTags('<head><script src="/a-NEW.js"></script></head><body><script src="/b-NEW.js"></script></body>', base);
    const html = '<head><title>x</title><script nonce="abc" src="/a-OLD.js"></script><meta x><link rel="stylesheet" href="/s-OLD.css"></head><body><p>ä</p><script src="/b-OLD.js"></script></body>';
    const swapped = swapPage(html, { base, owned: ({ urls }) => urls.some((url) => url.includes('OLD')), local });
    assert.equal(swapped.html, '<head><title>x</title><script nonce="abc" src="/a-NEW.js"></script><meta x></head><body><p>ä</p><script nonce="abc" src="/b-NEW.js"></script></body>');
    assert.deepEqual(swapped.removed, [`${ENV}/a-OLD.js`, `${ENV}/s-OLD.css`, `${ENV}/b-OLD.js`]);
    const appended = swapPage('<head></head><body><script src="/keep.js"></script></body>', { base, owned: () => false, local });
    assert.equal(appended.html, '<head><script src="/a-NEW.js"></script></head><body><script src="/keep.js"></script><script src="/b-NEW.js"></script></body>', 'nichts entfernt: ans Ende');
});

test('Overlay build: andere Aufteilung startet, weil die Seite die Tags des lokalen Builds bekommt; env.js, Inline und Portal bleiben', async (t) => {
    const overlay = await buildOverlay(t, viteFiles);
    const out = await overlay.rewritePage(DEPLOYED, { url: `${ENV}/bestellung/5` });
    assert.match(out, /<script nonce="n0nce" type="module" crossorigin src="\/assets\/index-NEW11111\.js"><\/script>/, 'mit der Nonce der Seite');
    assert.equal(out.match(/nonce=/g).length, 6, 'je Tag eine Nonce, keine doppelt');
    assert.match(out, /href="\/assets\/react-NEW55555\.js"/);
    assert.match(out, /href="\/assets\/router-NEW66666\.js"/);
    assert.match(out, /href="\/assets\/index-NEW33333\.css"/);
    assert.doesNotMatch(out, /OLD11111|vendor-OLD22222|index-OLD33333/, 'kein ausgelieferter Code-Tag der App');
    assert.equal(out.match(/src="\/env\.js"/g).length, 1, 'env.js bleibt die der Umgebung, einmal');
    assert.match(out, /window\.dataLayer=\[\]/);
    assert.match(out, /rel="icon"/);
    assert.match(out, /<!-- <script src="\/assets\/alt-OLD44444\.js"><\/script> -->/, 'Kommentare bleiben');
    assert.doesNotMatch(out, /integrity/);
    assert.match(out, /Grüße/, 'Latin-1 bleibt');
    assert.deepEqual(overlay.pages.at(-1).swaps, [{ app: 'web', removed: [`${ENV}/assets/index-OLD11111.js`, `${ENV}/assets/vendor-OLD22222.js`, `${ENV}/assets/index-OLD33333.css`], inserted: 4 }]);
});

test('Overlay build: kein Tausch ohne Treffer (Anmeldeseite), bei SSR und wenn der Build einen anderen base-Pfad hat', async (t) => {
    const overlay = await buildOverlay(t, viteFiles);
    const login = '<html><head><script src="/sso/login.js"></script></head><body><form></form></body></html>';
    assert.equal(await overlay.rewritePage(login, { url: `${ENV}/signin` }), login);
    assert.deepEqual(overlay.pages.at(-1).swaps, [{ app: 'web', skipped: 'no-match' }]);
    const next = DEPLOYED.replace('</body>', '<script>self.__next_f.push([1,""])</script></body>');
    assert.match(await overlay.rewritePage(next, { url: `${ENV}/` }), /index-OLD11111/);
    assert.equal(overlay.pages.at(-1).ssr, 'Next.js');
    // Die Umgebung liegt unter /shop/, der Build zeigt auf /assets/: Das Muster der Umgebung erfasst die Adresse nicht.
    const shop = await buildOverlay(t, viteFiles, { url: `${ENV}/shop/` });
    const shopPage = DEPLOYED.replaceAll('"/assets/', '"/shop/assets/');
    assert.match(await shop.rewritePage(shopPage, { url: `${ENV}/shop/` }), /shop\/assets\/index-OLD11111/);
    assert.deepEqual(shop.pages.at(-1).swaps, [{ app: 'web', skipped: 'local-base' }]);
});

test('Overlay build: von mehreren Seiten die mit den meisten Treffern; webpack-Laufzeit inline mit dem Asset-Ordner weicht', async (t) => {
    const overlay = await buildOverlay(t, {
        'dist/index.html': '<head><script defer src="/static/js/main.NEW1a2b3c.js"></script><script>__webpack_public_path__="/static/js/"</script></head>',
        'dist/admin.html': '<head><script defer src="/static/js/admin.NEW9f8e7d.js"></script></head>',
        'dist/static/js/main.NEW1a2b3c.js': 'main',
        'dist/static/js/admin.NEW9f8e7d.js': 'admin',
        'dist/static/js/chunk.NEW4d5e6f.js': 'chunk',
    });
    const deployed = '<head><script>__webpack_public_path__="/static/js/";var old=1</script><script defer src="/static/js/admin.OLD1a2b3c.js"></script><script defer src="/static/js/chunk.OLD4d5e6f.js"></script></head>';
    const out = await overlay.rewritePage(deployed, { url: `${ENV}/admin` });
    assert.equal(out, '<head><script defer src="/static/js/admin.NEW9f8e7d.js"></script></head>', 'admin.html; der Chunk im Asset-Ordner weicht, die alte Laufzeit auch');
});

test('Overlay dev: Tags aus dem HTML des Dev-Servers, Projektkopien und Fremdes bleiben', async (t) => {
    const root = project(t, { 'public/env.js': "window.ENV='lokal'" });
    const dev = createServer((request, response) => {
        const path = new URL(request.url, 'http://x').pathname;
        if (path === '/env.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end("window.ENV='lokal'");
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
    const out = await overlay.rewritePage(deployed, { url: `${ENV}/bestellung/5` });
    assert.match(out, /<script nonce="n0nce" type="module">import RefreshRuntime from "\/@react-refresh"/, 'die Preamble mit Nonce');
    assert.match(out, /<script nonce="n0nce" type="module" src="\/@vite\/client"><\/script>/);
    assert.match(out, /<script nonce="n0nce" type="module" src="\/src\/main\.tsx"><\/script><\/body>/);
    assert.doesNotMatch(out, /OLD11111|OLD22222|OLD33333/);
    assert.equal(out.match(/src="\/env\.js"/g).length, 1);
    assert.match(out, /cdn\.example\/analytics\.js/, 'fremder Origin bleibt');
    assert.match(out, /window\.dataLayer/);
});
