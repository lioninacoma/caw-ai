import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ago, describeCode, newestFile } from '../src/host/code-source.mjs';
import { staleBuild } from '../src/host/overlay.mjs';
import { createUi } from '../src/shared/ui.mjs';

const at = (path, ms) => utimesSync(path, ms / 1000, ms / 1000);
const NOW = Date.parse('2026-11-10T14:05:00Z');
const MIN = 60_000;

/** Ein Projekt mit Quellen unter src und einem Build unter dist/local. */
const project = (t, { built, changed }) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-code-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['src', 'dist/local/assets', 'node_modules/x', '.angular/cache', 'caw/tests']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'dist/local/assets/index-A1B2C3D4.js'), '');
    at(join(root, 'dist/local/assets/index-A1B2C3D4.js'), built);
    writeFileSync(join(root, 'src/x.tsx'), '');
    at(join(root, 'src/x.tsx'), changed);
    // Juenger, zaehlt aber nicht: Abhaengigkeiten, Caches, Testplaene und Doku.
    for (const file of ['node_modules/x/a.js', '.angular/cache/b.js', 'caw/tests/smoke.yaml', 'README.md']) {
        writeFileSync(join(root, file), '');
        at(join(root, file), NOW);
    }
    return root;
};

const CONFIG = { apps: { web: { dir: '.', startUrl: '/', overlay: { build: 'dist/local' } } } };
const SPEC = { id: 'smoke', app: 'web', also: [] };
const BUILD = { source: 'overlay', apps: { web: { kind: 'build', dir: 'dist/local', statics: [] } } };

test('Code-Zeile: Overlay nennt die Quelle, beim Build mit Zeitpunkt; sonst der ausgelieferte Stand; validate ohne Zeit', (t) => {
    const root = project(t, { built: NOW - 3 * MIN, changed: NOW - 10 * MIN });
    assert.match(describeCode(CONFIG, SPEC, BUILD, { root, now: NOW }), /^Overlay, Build dist\/local, gebaut \d\d:\d\d, vor 3 min$/);
    assert.equal(describeCode(CONFIG, SPEC, BUILD), 'Overlay, Build dist/local');
    assert.equal(describeCode(CONFIG, SPEC, { source: 'overlay', apps: { web: { kind: 'dev', url: 'http://localhost:5174', statics: [] } } }), 'Overlay, Dev-Server http://localhost:5174');
    const statics = [{ name: 'a.js', path: 'a.js' }];
    assert.equal(describeCode(CONFIG, SPEC, { source: 'overlay', apps: { web: { kind: 'watch', statics } } }), 'Overlay, Sencha-Watch in ., dazu 1 aus overlay.statics');
    assert.equal(describeCode(CONFIG, SPEC, { source: 'overlay', apps: { web: { kind: 'files', statics } } }), 'Overlay, 1 feste Datei(en) aus overlay.statics');
    const two = { apps: { web: { dir: 'web' }, admin: { dir: 'admin' } } };
    assert.equal(describeCode(two, SPEC, { source: 'overlay', apps: { web: { kind: 'build', dir: 'web/dist' }, admin: { kind: 'dev', url: 'http://localhost:5200' } } }),
        'Overlay, Build web/dist (App web); Dev-Server http://localhost:5200 (App admin)');
    assert.equal(describeCode(CONFIG, SPEC, { source: 'deployed' }), 'ausgelieferter Stand');
    assert.equal(describeCode(CONFIG, SPEC, { source: 'deployed', url: 'http://localhost:5173' }), 'Dev-Server localhost:5173, dein aktueller Stand');
    assert.equal(describeCode(CONFIG, SPEC, { source: 'deployed', url: 'https://shop.localhost:8443' }), 'ausgelieferter Stand', 'https auf *.localhost ist ein Build');
});

test('Veralteter Build: eine Quelle juenger als der Build, ohne Abhaengigkeiten, Caches, Testplaene und Doku', (t) => {
    const stale = project(t, { built: NOW - 30 * MIN, changed: NOW - 12 * MIN });
    assert.deepEqual(staleBuild(join(stale, 'dist/local'), stale, stale, NOW), { file: 'src/x.tsx', ago: 'vor 12 min' });
    const fresh = project(t, { built: NOW - 3 * MIN, changed: NOW - 12 * MIN });
    assert.equal(staleBuild(join(fresh, 'dist/local'), fresh, fresh, NOW), null);
});

test('newestFile: begrenzt den Weg, überspringt Ordner mit Punkt und Builds', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-newest-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'dist'));
    for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `f${index}.js`), '');
    writeFileSync(join(root, 'dist/neu.js'), '');
    assert.equal(newestFile(join(root, 'leer')), null);
    assert.ok(!newestFile(root).path.includes('dist'));
    assert.ok(newestFile(root, { max: 2 }) !== null);
    assert.equal(ago(30_000), 'gerade eben');
    assert.equal(ago(3 * 60 * MIN), 'vor 3 h');
});

test('Kopf eines Laufs: Die Code-Zeile steht auch ohne Terminal da', () => {
    const lines = [];
    createUi({ fancy: false, out: (text) => lines.push(text) }).header({ mode: 'Testlauf', test: 'smoke', target: 'staging', source: 'deployed', code: 'ausgelieferter Stand' });
    assert.deepEqual(lines, ['[caw-ai] Testlauf: smoke auf staging', '[caw-ai] Code: ausgelieferter Stand']);
    const fancy = [];
    createUi({ fancy: true, out: (text) => fancy.push(text) }).header({ mode: 'Testlauf', test: 'smoke', target: 'local', source: 'overlay', code: 'Overlay, Build dist' });
    assert.match(fancy.join('\n'), /Code: Overlay, Build dist/);
});
