import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ago, describeCode, newestFile, staleBuildWarnings } from '../src/host/code-source.mjs';
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

const CONFIG = { apps: { web: { dir: '.', startUrl: '/', localBuild: 'dist/local' } } };
const SPEC = { id: 'smoke', app: 'web', also: [] };

test('Code-Zeile: lokaler Build mit Zeitpunkt, ausgelieferter Stand mit Grund, validate ohne Zeit', (t) => {
    const root = project(t, { built: NOW - 3 * MIN, changed: NOW - 10 * MIN });
    const local = describeCode(CONFIG, SPEC, { source: 'watch' }, { root, now: NOW });
    assert.match(local, /^lokaler Build \(dist\/local, gebaut \d\d:\d\d, vor 3 min\)$/);
    assert.equal(describeCode(CONFIG, SPEC, { source: 'watch', sourceReason: '--code local' }), 'lokaler Build aus dist/local; --code local');
    assert.equal(describeCode(CONFIG, SPEC, { source: 'deployed', sourceReason: 'Umgebung staging hat kein localCode' }), 'ausgelieferter Stand (Umgebung staging hat kein localCode)');
    const statics = { assetUrlPattern: '/s/(.+)', apps: { web: { dir: 'apps/web', statics: [{ name: 'a.js', path: 'a.js' }] } } };
    assert.equal(describeCode(statics, SPEC, { source: 'watch' }), 'lokaler Build aus statics in apps/web');
});

test('Veralteter Build: Warnung, wenn eine Quelle jünger ist als der Build, sonst nicht', (t) => {
    const stale = project(t, { built: NOW - 30 * MIN, changed: NOW - 12 * MIN });
    assert.deepEqual(staleBuildWarnings(stale, CONFIG, SPEC, { source: 'watch' }, NOW),
        ['Der lokale Build (dist/local) ist älter als deine letzte Änderung (src/x.tsx, vor 12 min). Läuft der Build-Watch? Sonst --code deployed.']);
    assert.deepEqual(staleBuildWarnings(stale, CONFIG, SPEC, { source: 'deployed' }, NOW), [], 'ohne lokalen Code keine Warnung');
    const fresh = project(t, { built: NOW - 3 * MIN, changed: NOW - 12 * MIN });
    assert.deepEqual(staleBuildWarnings(fresh, CONFIG, SPEC, { source: 'watch' }, NOW), []);
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
    createUi({ fancy: false, out: (text) => lines.push(text) }).header({ mode: 'Testlauf', test: 'smoke', target: 'staging', source: 'deployed', code: 'ausgelieferter Stand (Umgebung staging hat kein localCode)' });
    assert.deepEqual(lines, ['[caw-ai] Testlauf: smoke auf staging', '[caw-ai] Code: ausgelieferter Stand (Umgebung staging hat kein localCode)']);
    const fancy = [];
    createUi({ fancy: true, out: (text) => fancy.push(text) }).header({ mode: 'Testlauf', test: 'smoke', target: 'local', source: 'watch', code: 'lokaler Build (dist)' });
    assert.match(fancy.join('\n'), /Code: lokaler Build \(dist\)/);
});
