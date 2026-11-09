import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createWatchClient } from '../src/host/devlink-core.mjs';
import { APP_FILES_BASE, checkAppFiles, createFileTransport } from '../src/host/app-files.mjs';

const app = (t, bootstrap) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-app-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, 'apps/a');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(dir, 'src/x.js'), 'x-inhalt');
    writeFileSync(join(root, 'pkg/y.js'), 'y-inhalt');
    if (bootstrap !== undefined) writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify(bootstrap));
    return dir;
};
const good = { loadOrder: [{ path: 'src/x.js' }, { path: '../../pkg/y.js' }], packages: { P: { files: [0, 1] } } };

test('devlink liest Bootstrap und Quellen über den Datei-Transport von der Platte', async (t) => {
    const client = createWatchClient(createFileTransport(app(t, good)), { baseUrl: APP_FILES_BASE });
    const bootstrap = await client.getBootstrap();
    assert.deepEqual(bootstrap.packages.P.files, [0, 1]);
    assert.equal(await client.readWatch('src/x.js'), 'x-inhalt');
});

test('Datei-Transport löst ../ relativ zur App auf, das darf keine URL wegnormalisieren', async (t) => {
    const client = createWatchClient(createFileTransport(app(t, good)), { baseUrl: APP_FILES_BASE });
    assert.equal(await client.readWatch('../../pkg/y.js'), 'y-inhalt');
});

test('Datei-Transport ignoriert Cache-Parameter und meldet Fehlendes als Fehler', async (t) => {
    const client = createWatchClient(createFileTransport(app(t, good)), { baseUrl: APP_FILES_BASE });
    assert.equal(await client.readWatch('src/x.js?_dc=1'), 'x-inhalt');
    await assert.rejects(client.readWatch('src/gibtsnicht.js'), /watch bad-status/);
});

test('checkAppFiles: vollständig ist in Ordnung', (t) => {
    assert.doesNotThrow(() => checkAppFiles(app(t, good)));
});

test('checkAppFiles: ohne bootstrap.json läuft kein Test und die Meldung nennt den Watch', (t) => {
    assert.throws(() => checkAppFiles(app(t)), (error) => error.code === 'watch-missing' && /Watch/.test(error.message));
});

test('checkAppFiles: unbrauchbares bootstrap.json', (t) => {
    const dir = app(t, good);
    writeFileSync(join(dir, 'bootstrap.json'), '{ halb');
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-missing');
    writeFileSync(join(dir, 'bootstrap.json'), '{"loadOrder":[]}');
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-missing');
});

test('checkAppFiles: fehlende Dateien heissen veraltet und werden genannt', (t) => {
    const dir = app(t, { loadOrder: [{ path: 'src/x.js' }, { path: 'src/weg.js' }] });
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-stale' && /src\/weg\.js/.test(error.message));
});
