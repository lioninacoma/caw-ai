import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { contentTypeOf, hasBuild, moduleAlias, resolveLocalBuild, sameButHash } from '../src/host/local-build.mjs';
import { prepareOverlay, routeOverlay } from '../src/host/overlay.mjs';

const build = (t, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-build-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    return dir;
};

/** Ein Projekt mit Build unter dist, das Overlay darueber und die Antwort der Route wie im Browser. */
const overlayOf = async (t, files, { command } = {}) => {
    const root = build(t, Object.fromEntries(Object.entries(files).map(([name, text]) => [`dist/${name}`, text])));
    const checked = { url: 'https://app.example', apps: { web: { kind: 'build', dir: 'dist', statics: [], ...(command === undefined ? {} : { command }) } } };
    const overlay = await prepareOverlay({ root, config: { apps: { web: { dir: '.' } } }, checked });
    let handler;
    await routeOverlay({ route: async (match, handle) => { handler = handle; }, routeWebSocket: async () => { throw new Error('ohne Dev-Server kein WebSocket'); } }, overlay);
    const answer = async (url, type = 'script') => {
        let result = null;
        const request = { url: () => url, resourceType: () => type };
        await handler({ request: () => request, fulfill: async (response) => { result = { fulfill: response }; }, fallback: async () => { result = 'fallback'; }, abort: async () => { result = 'abort'; } });
        return result;
    };
    return { root, overlay, answer };
};

test('Hash-Vergleich: Vite, Angular und webpack, aber nicht Namen, die nur ähnlich sind', () => {
    assert.equal(sameButHash('index-D-7xQ_aZ.js', 'index-Bq9k1LmZ.js'), true, 'Vite, Hash mit - und _');
    assert.equal(sameButHash('main-ABCD1234.js', 'main-ZYXW9876.js'), true, 'Angular');
    assert.equal(sameButHash('main.0a1b2c3d4e5f6a7b.js', 'main.9f8e7d6c5b4a3f2e.js'), true, 'webpack');
    assert.equal(sameButHash('index-AAAA1111.js', 'index-AAAA1111.js'), false, 'gleich ist kein Hash-Unterschied');
    assert.equal(sameButHash('index-AAAA1111.js', 'index-BBBB2222.css'), false, 'andere Endung');
    assert.equal(sameButHash('index-AAAA1111.js', 'Info-BBBB2222.js'), false, 'anderer Name');
    assert.equal(sameButHash('index-AAAA1111.js', 'index-BBBB222.js'), true, 'andere Hash-Länge, etwa nach einer anderen Bundler-Einstellung');
    assert.equal(sameButHash('main.0a1b2c', 'main.9f8e7d'), false, 'ohne Endung kein Hash');
    assert.equal(sameButHash(`app-${'a1'.repeat(32)}.js`, 'app-B2C3D4E5.js'), true, 'Digest mit 64 Zeichen');
    assert.equal(sameButHash(`app-${'a1'.repeat(33)}.js`, 'app-B2C3D4E5.js'), false, 'mehr als 64 Zeichen ist kein Hash');
    assert.equal(sameButHash('app-AB1.js', 'app-CD2.js'), false, 'weniger als 6 Zeichen ist kein Hash');
    assert.equal(sameButHash('main.0a1b2c3d.chunk.js', 'main.9f8e7d6c.chunk.js'), true, 'Hash vor mehreren Endungen');
    assert.equal(sameButHash('main.0a1b2c3d.chunk.js', 'main.9f8e7d6c.js'), false, 'andere Endungen');
    assert.equal(sameButHash('main.js', 'main-A1B2C3D4.js'), true, 'fester Name gegen gehashten');
    assert.equal(sameButHash('main-A1B2C3D4.js', 'main.js'), true);
    assert.equal(sameButHash('styles.css', 'styles.0a1b2c3d4e.css'), true);
    assert.equal(sameButHash('main.js', 'main-button.js'), false, 'ein Wort ist kein Hash');
    assert.equal(sameButHash('my-button.js', 'my-dialog.js'), false, 'kein Hash: nur Kleinbuchstaben');
    assert.equal(sameButHash('my-button.js', 'my-dialog.js', { loose: true }), true, 'nur wenn die lokale Seite die Datei laedt');
    assert.equal(sameButHash('main.js', 'main.js'), false);
});

test('resolveLocalBuild: exakt, bis auf den Hash, eindeutig oder gar nicht', (t) => {
    const dir = build(t, {
        'assets/index-NEW11111.js': 'neu',
        'assets/index-NEW11111.css': 'css',
        'assets/Info-CCCC3333.js': 'info',
        'chunk-AAAA1111.js': 'a',
        'chunk-BBBB2222.js': 'b',
        'main-LOCAL123.js': 'main',
    });
    assert.deepEqual(resolveLocalBuild(dir, 'assets/Info-CCCC3333.js'), { file: join(dir, 'assets', 'Info-CCCC3333.js'), contentType: 'application/javascript' });
    assert.equal(resolveLocalBuild(dir, 'assets/index-OLD99999.js').file, join(dir, 'assets', 'index-NEW11111.js'));
    assert.deepEqual(resolveLocalBuild(dir, 'assets/index-OLD99999.css'), { file: join(dir, 'assets', 'index-NEW11111.css'), contentType: 'text/css', alias: 'index-NEW11111.css' });
    assert.equal(resolveLocalBuild(dir, 'main-DEPLOYED.js').file, join(dir, 'main-LOCAL123.js'));
    assert.equal(resolveLocalBuild(dir, 'chunk-DEPLOYED.js'), null, 'mehrdeutig: kommt vom Server');
    assert.equal(resolveLocalBuild(dir, 'assets/logo-ABCD1234.svg'), null);
    assert.equal(resolveLocalBuild(dir, 'info'), null, 'SPA-Route');
    assert.equal(resolveLocalBuild(dir, '../secret-ABCD1234.js'), null);
    assert.equal(resolveLocalBuild(join(dir, 'fehlt'), 'main-X.js'), null);
});

test('resolveLocalBuild: mehrere Dateien gleichen Namens bis auf den Hash, die lokale Seite nennt den Einstieg', (t) => {
    // Vite nennt auch einen lazy Chunk aus pages/x/index.tsx `index-…js`.
    const dir = build(t, {
        'index.html': '<script type="module" crossorigin src="/assets/index-NEW11111.js"></script>',
        'assets/index-NEW11111.js': 'entry',
        'assets/index-LAZY2222.js': 'lazy',
    });
    assert.equal(resolveLocalBuild(dir, 'assets/index-OLD99999.js').file, join(dir, 'assets', 'index-NEW11111.js'));
    const unnamed = build(t, { 'assets/index-NEW11111.js': 'entry', 'assets/index-LAZY2222.js': 'lazy' });
    assert.equal(resolveLocalBuild(unnamed, 'assets/index-OLD99999.js'), null, 'ohne Seite bleibt es mehrdeutig');
});

test('resolveLocalBuild: der Watch-Build schreibt neu, der Ordner wird neu gelesen', (t) => {
    const dir = build(t, { 'main-AAAA1111.js': 'a' });
    assert.equal(resolveLocalBuild(dir, 'main-OLD00000.js').file, join(dir, 'main-AAAA1111.js'));
    rmSync(join(dir, 'main-AAAA1111.js'));
    writeFileSync(join(dir, 'main-BBBB2222.js'), 'b');
    // Auf manchen Dateisystemen ist die mtime grob; sicherstellen, dass sie sich aendert.
    utimesSync(dir, new Date(), new Date(Date.now() + 5000));
    assert.equal(resolveLocalBuild(dir, 'main-OLD00000.js').file, join(dir, 'main-BBBB2222.js'));
});

test('contentTypeOf und hasBuild', (t) => {
    assert.equal(contentTypeOf('a.mjs'), 'application/javascript');
    assert.equal(contentTypeOf('a.woff2'), 'font/woff2');
    assert.equal(contentTypeOf('a.js.map'), 'application/json');
    assert.equal(contentTypeOf('a.unknown'), 'application/octet-stream');
    assert.equal(hasBuild(build(t, { 'browser/main-X.js': 'x' })), true);
    assert.equal(hasBuild(build(t, { 'index.html': 'x' })), true, 'eine Seite reicht');
    assert.equal(hasBuild(build(t, { 'app/browser/index.html': 'x', 'app/browser/main-X.js': 'x' })), false, 'zu weit oben');
    assert.equal(hasBuild(join(tmpdir(), 'caw-gibt-es-nicht')), false);
});

test('Overlay build: ohne Build, zu weit oben oder veraltet endet der Lauf vor dem Browser mit dem Grund', async (t) => {
    const root = build(t, { 'src/x.js': 'x', 'dist/app/browser/index.html': 'x', 'dist/app/browser/main-A1B2C3D4.js': 'x' });
    const config = { apps: { web: { dir: '.' } } };
    const checked = (dir, command) => ({ url: 'https://app.example', apps: { web: { kind: 'build', dir, statics: [], ...(command === undefined ? {} : { command }) } } });
    await assert.rejects(prepareOverlay({ root, config, checked: checked('local') }), (error) => error.code === 'overlay-not-ready' && /Im Build-Ordner local liegt kein Build/.test(error.message));
    await assert.rejects(prepareOverlay({ root, config, checked: checked('dist') }), (error) => /Setze "overlay": \{ "build": "dist\/app\/browser" \}/.test(error.message));
    await prepareOverlay({ root, config, checked: checked('dist/app/browser') });
    const past = Date.now() / 1000 - 600;
    utimesSync(join(root, 'dist/app/browser/main-A1B2C3D4.js'), past, past);
    utimesSync(join(root, 'dist/app/browser/index.html'), past, past);
    await assert.rejects(prepareOverlay({ root, config, checked: checked('dist/app/browser') }), (error) => /ist älter als deine letzte Änderung \(src\/x\.js/.test(error.message) && /overlay\.buildCommand/.test(error.message));
});

test('Overlay build: Ist der Build alt und steht buildCommand in der Config, baut caw selbst und prueft danach', async (t) => {
    const root = build(t, { 'src/x.js': 'x', 'dist/main.js': 'alt' });
    const past = Date.now() / 1000 - 600;
    utimesSync(join(root, 'dist/main.js'), past, past);
    const lines = [];
    const config = { apps: { web: { dir: '.' } } };
    const command = `node -e "require('fs').writeFileSync('dist/main.js','neu')"`;
    await prepareOverlay({ root, config, checked: { url: 'https://app.example', apps: { web: { kind: 'build', dir: 'dist', statics: [], command } } }, info: (text) => lines.push(text) });
    assert.match(lines.join('\n'), /Baue mit node -e/);
    const failing = { url: 'https://app.example', apps: { web: { kind: 'build', dir: 'dist', statics: [], command: 'node -e "process.exit(3)"' } } };
    utimesSync(join(root, 'dist/main.js'), past, past);
    await assert.rejects(prepareOverlay({ root, config, checked: failing }), (error) => error.code === 'overlay-not-ready' && /ist gescheitert/.test(error.message));
});

test('Overlay build: Dateien mit Typ und als Bytes, nie gecacht; Seiten, fremde Hosts und Unbekanntes vom Server', async (t) => {
    const { answer } = await overlayOf(t, { 'assets/index-NEW11111.js': 'neu', 'assets/index-NEW11111.css': 'body{}' });
    const js = await answer('https://app.example/assets/index-OLD00000.js?v=1');
    assert.equal(js.fulfill.contentType, 'application/javascript');
    assert.equal(js.fulfill.headers['cache-control'], 'no-store');
    assert.ok(Buffer.isBuffer(js.fulfill.body));
    assert.equal(js.fulfill.body.toString(), 'neu');
    assert.equal((await answer('https://app.example/assets/index-OLD00000.css', 'stylesheet')).fulfill.contentType, 'text/css');
    assert.equal(await answer('https://app.example/assets/other-ABCD1234.js'), 'fallback');
    assert.equal(await answer('https://app.example/assets/index-OLD00000.js', 'document'), 'fallback');
    assert.equal(await answer('https://other.example/assets/index-OLD00000.js'), 'fallback');
});

test('moduleAlias: ein ES-Modul unter deploytem Namen verweist auf das lokale, damit es nur einmal läuft', async (t) => {
    assert.equal(moduleAlias('index-NEW.js', 'import{a as b}from"./x.js";console.log(b)'), 'import "./index-NEW.js";\nexport * from "./index-NEW.js";\n');
    assert.match(moduleAlias('main-NEW.js', 'const a=1;export{a as default,c as d};'), /export \{ default \} from "\.\/main-NEW\.js"/);
    assert.equal(moduleAlias('main.0a1b2c3d.js', '(()=>{var e={};self.webpackChunk=[]})();'), null, 'klassisches Skript');
    assert.equal(moduleAlias('index-NEW.css', 'import"x";'), null);
    assert.doesNotMatch(moduleAlias('index-NEW.js', 'import{a}from"./x.js";const l="Set as default";export{a as b};'), /default/, '„as default“ in einem String ist kein Export');
    assert.match(moduleAlias('index-NEW.js', 'export default 1;'), /export \{ default \}/);

    const { answer } = await overlayOf(t, { 'assets/index-NEW11111.js': 'import"./vendor-AAAA1111.js";export{x as default};' });
    const bodyOf = async (url) => String((await answer(url)).fulfill.body);
    assert.match(await bodyOf('https://app.example/assets/index-OLD00000.js'), /^import "\.\/index-NEW11111\.js";/);
    assert.match(await bodyOf('https://app.example/assets/index-NEW11111.js'), /^import"\.\/vendor/, 'unter eigenem Namen der Inhalt');
});
