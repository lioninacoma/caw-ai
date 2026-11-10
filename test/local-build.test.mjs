import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { contentTypeOf, hasBuild, moduleAlias, resolveLocalBuild, sameButHash } from '../src/host/local-build.mjs';

const build = (t, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-build-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    return dir;
};

test('Hash-Vergleich: Vite, Angular und webpack, aber nicht Namen, die nur ähnlich sind', () => {
    assert.equal(sameButHash('index-D-7xQ_aZ.js', 'index-Bq9k1LmZ.js'), true, 'Vite, Hash mit - und _');
    assert.equal(sameButHash('main-ABCD1234.js', 'main-ZYXW9876.js'), true, 'Angular');
    assert.equal(sameButHash('main.0a1b2c3d4e5f6a7b.js', 'main.9f8e7d6c5b4a3f2e.js'), true, 'webpack');
    assert.equal(sameButHash('index-AAAA1111.js', 'index-AAAA1111.js'), false, 'gleich ist kein Hash-Unterschied');
    assert.equal(sameButHash('index-AAAA1111.js', 'index-BBBB2222.css'), false, 'andere Endung');
    assert.equal(sameButHash('index-AAAA1111.js', 'Info-BBBB2222.js'), false, 'anderer Name');
    assert.equal(sameButHash('index-AAAA1111.js', 'index-BBBB222.js'), false, 'andere Hash-Länge');
    assert.equal(sameButHash('my-button.js', 'my-dialog.js'), false, 'kein Hash: nur Kleinbuchstaben');
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

test('checkLocalBuild: ohne Build sagt der Lauf, welcher Ordner fehlt', async (t) => {
    const { checkLocalBuild } = await import('../src/host/app-files.mjs');
    const root = build(t, { 'dist/assets/index-A1B2C3D4.js': 'x' });
    checkLocalBuild(root, 'dist');
    checkLocalBuild(root, undefined);
    assert.throws(() => checkLocalBuild(root, 'local'), (error) => error.code === 'watch-missing' && /local/.test(error.message));
});

test('devlink: Build-Ordner liefert Dateien mit Typ und als Bytes, Seiten nie', async (t) => {
    const { createInterceptionHandler, parseConfig } = await import('../src/host/devlink-core.mjs');
    const dir = build(t, { 'assets/index-NEW11111.js': 'neu', 'assets/index-NEW11111.css': 'body{}' });
    const config = {
        activePortal: 'p', assetUrlPattern: '^https://app\\.example/([^?#]+)', authMarker: null,
        portals: [{ uuid: 'p', name: 'test', url: 'https://app.example' }],
        projects: [{ uuid: 'a', name: 'web', active: true, redirects: [], constants: [], statics: [], builds: [{ uuid: 'b', localDir: dir, active: true }] }],
    };
    assert.equal(parseConfig(config).ok, true);
    assert.deepEqual(parseConfig(config).issues, []);
    const handle = createInterceptionHandler({ config, portalUrl: 'https://app.example', onFailure: 'fail' }, { log: () => {} });
    const answer = async (url, type = 'script') => {
        let result = null;
        const route = { fulfill: async (response) => { result = { fulfill: response }; }, continue: async () => { result = 'continue'; }, abort: async () => { result = 'abort'; } };
        await handle(route, url, type);
        return result;
    };
    const js = await answer('https://app.example/assets/index-OLD00000.js?v=1');
    assert.equal(js.fulfill.contentType, 'application/javascript');
    assert.ok(Buffer.isBuffer(js.fulfill.body));
    assert.equal(js.fulfill.body.toString(), 'neu');
    assert.equal((await answer('https://app.example/assets/index-OLD00000.css', 'stylesheet')).fulfill.contentType, 'text/css');
    assert.equal(await answer('https://app.example/assets/other-ABCD1234.js'), 'continue');
    assert.equal(await answer('https://app.example/assets/index-OLD00000.js', 'document'), 'continue');
    assert.equal(await answer('https://other.example/assets/index-OLD00000.js'), 'continue');
});

test('moduleAlias: ein ES-Modul unter deploytem Namen verweist auf das lokale, damit es nur einmal läuft', async (t) => {
    assert.equal(moduleAlias('index-NEW.js', 'import{a as b}from"./x.js";console.log(b)'), 'import "./index-NEW.js";\nexport * from "./index-NEW.js";\n');
    assert.match(moduleAlias('main-NEW.js', 'const a=1;export{a as default,c as d};'), /export \{ default \} from "\.\/main-NEW\.js"/);
    assert.equal(moduleAlias('main.0a1b2c3d.js', '(()=>{var e={};self.webpackChunk=[]})();'), null, 'klassisches Skript');
    assert.equal(moduleAlias('index-NEW.css', 'import"x";'), null);
    assert.doesNotMatch(moduleAlias('index-NEW.js', 'import{a}from"./x.js";const l="Set as default";export{a as b};'), /default/, '„as default“ in einem String ist kein Export');
    assert.match(moduleAlias('index-NEW.js', 'export default 1;'), /export \{ default \}/);

    const { createInterceptionHandler } = await import('../src/host/devlink-core.mjs');
    const dir = build(t, { 'assets/index-NEW11111.js': 'import"./vendor-AAAA1111.js";export{x as default};' });
    const config = {
        activePortal: 'p', assetUrlPattern: '^https://app\\.example/([^?#]+)', authMarker: null,
        portals: [{ uuid: 'p', name: 'test', url: 'https://app.example' }],
        projects: [{ uuid: 'a', name: 'web', active: true, redirects: [], constants: [], statics: [], builds: [{ uuid: 'b', localDir: dir, active: true }] }],
    };
    const handle = createInterceptionHandler({ config, portalUrl: 'https://app.example', onFailure: 'fail' }, { log: () => {} });
    const bodyOf = async (url) => {
        let body;
        await handle({ fulfill: async (response) => { body = String(response.body); } }, url, 'script');
        return body;
    };
    assert.match(await bodyOf('https://app.example/assets/index-OLD00000.js'), /^import "\.\/index-NEW11111\.js";/);
    assert.match(await bodyOf('https://app.example/assets/index-NEW11111.js'), /^import"\.\/vendor/, 'unter eigenem Namen der Inhalt');
});
