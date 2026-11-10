import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appBuildNames, checkAppFiles, createWatchSource, parseSenchaJson, replaceable } from '../src/host/framework/extjs-overlay.mjs';

const write = (file, text) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
};

/** Eine App mit Paket bestellung-modell, so wie Sencha Cmd sie anlegt: app.json, package.json, bootstrap.json. */
const app = (t, { appJson = { name: 'Bestellung', output: { js: { path: 'Bestellung.js' } } }, bootstrap } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-extjs-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, 'bestellung');
    write(join(dir, 'app.json'), `// von Sencha Cmd\n${JSON.stringify(appJson, null, 2)}`);
    write(join(dir, 'package.json'), JSON.stringify({ name: 'bestellung' }));
    write(join(dir, 'app/Application.js'), 'Ext.define("App.Application");');
    write(join(dir, 'app/view/Main.js'), 'Ext.define("App.view.Main");');
    write(join(root, 'packages/bestellung-modell/src/Model.js'), 'Ext.define("Fx.Model");');
    write(join(root, 'ext/classic/Button.js'), 'Ext.define("Ext.Button");');
    const order = [
        { path: '../ext/classic/Button.js' },
        { path: '../packages/bestellung-modell/src/Model.js' },
        { path: 'app/Application.js' },
        { path: 'app/view/Main.js' },
    ];
    if (bootstrap !== null) write(join(dir, 'bootstrap.json'), JSON.stringify(bootstrap ?? { loadOrder: order, packages: { ext: { files: [0] }, 'bestellung-modell': { files: [1] } } }));
    return dir;
};

test('Sencha-JSON: Kommentare und Komma am Ende, Text mit // bleibt', () => {
    assert.deepEqual(parseSenchaJson('{\n // Kommentar\n "a": "http://x", /* b */ "c": [1,],\n}'), { a: 'http://x', c: [1] });
});

test('Build-Name der App: output.js.path aus app.json, auch je Stage; ein Platzhalter davor stoert nicht', (t) => {
    assert.deepEqual([...appBuildNames(app(t))], ['Bestellung.js']);
    const staged = app(t, { appJson: { name: 'B', output: { js: { path: '${build.id}/b.js' } }, production: { output: { js: { path: 'b.min.js' } } } } });
    assert.deepEqual([...appBuildNames(staged)].sort(), ['b.js', 'b.min.js']);
    assert.deepEqual([...appBuildNames(app(t, { appJson: { name: 'B', output: { js: 'b2.js' } } }))], ['b2.js']);
});

test('Build-Name der App: ohne output.js die Properties der App, sonst app.js wie Sencha Cmd', (t) => {
    const dir = app(t, { appJson: { name: 'Pruefen', output: { base: 'x' } } });
    assert.deepEqual([...appBuildNames(dir)], ['app.js']);
    write(join(dir, '.sencha/app/defaults.properties'), '# Kommentar\napp.output.js=${app.name}.js\napp.output.js.path=${app.output.js}\n');
    assert.deepEqual([...appBuildNames(dir)], ['Pruefen.js']);
});

test('Was ersetzt wird: App und eigene Pakete aus bootstrap.json, nie Ext JS selbst', (t) => {
    const parts = replaceable(app(t), checkAppFiles(app(t)));
    assert.deepEqual([...parts.keys()].sort(), ['Bestellung.js', 'bestellung-modell-debug.js', 'bestellung-modell.js']);
    assert.deepEqual(parts.get('Bestellung.js').paths, ['app/Application.js', 'app/view/Main.js']);
    assert.equal(parts.has('ext.js'), false);
});

test('Ein Build-Name fuer App und Paket zugleich ist ein Fehler statt einer Wahl', (t) => {
    const dir = app(t, { appJson: { name: 'B', output: { js: { path: 'bestellung-modell.js' } } } });
    assert.throws(() => replaceable(dir, checkAppFiles(dir)), (error) => error.code === 'overlay-ambiguous' && /bestellung-modell\.js/.test(error.message));
});

test('Watch-Quelle: der Name aus dem Request ueber den letzten Pfadteil, Quellen in Ladereihenfolge, frisch von der Platte', (t) => {
    const dir = app(t);
    const source = createWatchSource(dir);
    const appCode = source.resolve('Bestellung/Bestellung.js');
    assert.equal(appCode.kind, 'app');
    assert.equal(appCode.body, 'Ext.define("App.Application");\nExt.define("App.view.Main");\n');
    assert.match(source.resolve('Bestellung/bestellung-modell.js').body, /Fx\.Model/);
    assert.equal(source.resolve('Bestellung/ext.js'), null);
    assert.equal(source.resolve('Bestellung/Anderes.js'), null);
    writeFileSync(join(dir, 'app/view/Main.js'), 'Ext.define("App.view.Main2");');
    assert.match(source.resolve('Bestellung/Bestellung.js').body, /Main2/);
    assert.deepEqual(source.replaced().sort(), ['Bestellung.js', 'bestellung-modell.js']);
});

test('Watch-Quelle: zwei Requests aus verschiedenen Ordnern mit demselben Build-Namen ersetzen keinen', (t) => {
    const source = createWatchSource(app(t, { appJson: { name: 'B' } }));
    assert.ok(source.resolve('Anerkennung/app.js'));
    assert.throws(() => source.resolve('Zertifizierung/app.js'), (error) => error.code === 'overlay-ambiguous' && /Zertifizierung\/app\.js/.test(error.message));
});

test('checkAppFiles: ohne bootstrap.json, unlesbar, leer oder veraltet, mit Hinweis auf den Watch', (t) => {
    assert.throws(() => checkAppFiles(app(t, { bootstrap: null })), (error) => error.code === 'watch-missing' && /Watch/.test(error.message));
    const dir = app(t);
    writeFileSync(join(dir, 'bootstrap.json'), '{ halb');
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-missing');
    writeFileSync(join(dir, 'bootstrap.json'), '{"loadOrder":[]}');
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-missing');
    writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/Application.js' }, { path: 'app/weg.js' }] }));
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-stale' && /app\/weg\.js/.test(error.message));
});
