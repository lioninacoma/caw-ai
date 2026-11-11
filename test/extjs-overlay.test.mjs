import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appBuildNames, checkAppFiles, createWatchSource, expectedParts, parseSenchaJson, replaceable } from '../src/host/framework/extjs-overlay.mjs';
import { deriveName, scriptNames, suggestAssetPatterns } from '../src/host/overlay.mjs';
import { defaultAssetPattern } from '../src/shared/config.mjs';

const write = (file, text) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
};

/** An app with package bestellung-modell, as Sencha Cmd creates it: app.json, package.json, bootstrap.json. */
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

test('Sencha JSON: comments and trailing commas, a string with // stays', () => {
    assert.deepEqual(parseSenchaJson('{\n // Kommentar\n "a": "http://x", /* b */ "c": [1,],\n}'), { a: 'http://x', c: [1] });
});

test('App build name: output.js.path from app.json, also per stage; a leading placeholder is fine', (t) => {
    assert.deepEqual([...appBuildNames(app(t))], ['Bestellung.js']);
    const staged = app(t, { appJson: { name: 'B', output: { js: { path: '${build.id}/b.js' } }, production: { output: { js: { path: 'b.min.js' } } } } });
    assert.deepEqual([...appBuildNames(staged)].sort(), ['b.js', 'b.min.js']);
    assert.deepEqual([...appBuildNames(app(t, { appJson: { name: 'B', output: { js: 'b2.js' } } }))], ['b2.js']);
});

test('App build name: without output.js the app properties, otherwise app.js like Sencha Cmd', (t) => {
    const dir = app(t, { appJson: { name: 'Pruefen', output: { base: 'x' } } });
    assert.deepEqual([...appBuildNames(dir)], ['app.js']);
    write(join(dir, '.sencha/app/defaults.properties'), '# Kommentar\napp.output.js=${app.name}.js\napp.output.js.path=${app.output.js}\n');
    assert.deepEqual([...appBuildNames(dir)], ['Pruefen.js']);
});

test('What gets replaced: app and own packages from bootstrap.json, never Ext JS itself', (t) => {
    const parts = replaceable(app(t), checkAppFiles(app(t)));
    assert.deepEqual([...parts.keys()].sort(), ['Bestellung.js', 'bestellung-modell-debug.js', 'bestellung-modell.js']);
    assert.deepEqual(parts.get('Bestellung.js').paths, ['app/Application.js', 'app/view/Main.js']);
    assert.equal(parts.has('ext.js'), false);
});

test('A build name for both app and package is an error, not a choice', (t) => {
    const dir = app(t, { appJson: { name: 'B', output: { js: { path: 'bestellung-modell.js' } } } });
    assert.throws(() => replaceable(dir, checkAppFiles(dir)), (error) => error.code === 'overlay-ambiguous' && /bestellung-modell\.js/.test(error.message));
});

test('Watch source: name from the last path segment of the request, sources in load order, fresh from disk', (t) => {
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

test('Watch source: two requests from different folders with the same build name replace neither', (t) => {
    const source = createWatchSource(app(t, { appJson: { name: 'B' } }));
    assert.ok(source.resolve('Anerkennung/app.js'));
    assert.throws(() => source.resolve('Zertifizierung/app.js'), (error) => error.code === 'overlay-ambiguous' && /Zertifizierung\/app\.js/.test(error.message));
});

test('checkAppFiles: missing, unreadable, empty or stale bootstrap.json, with a hint about the watch', (t) => {
    assert.throws(() => checkAppFiles(app(t, { bootstrap: null })), (error) => error.code === 'watch-missing' && /Watch/.test(error.message));
    const dir = app(t);
    writeFileSync(join(dir, 'bootstrap.json'), '{ halb');
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-missing');
    writeFileSync(join(dir, 'bootstrap.json'), '{"loadOrder":[]}');
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-missing');
    writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/Application.js' }, { path: 'app/weg.js' }] }));
    assert.throws(() => checkAppFiles(dir), (error) => error.code === 'watch-stale' && /app\/weg\.js/.test(error.message));
});

test('Expected parts: app and packages, x.js and x-debug.js as one part, never Ext JS itself', (t) => {
    assert.deepEqual(expectedParts(app(t)), [
        { label: 'Bestellung', kind: 'app', names: ['Bestellung.js'] },
        { label: 'bestellung-modell', kind: 'package', names: ['bestellung-modell.js', 'bestellung-modell-debug.js'] },
    ]);
    assert.throws(() => expectedParts(app(t, { bootstrap: null })), (error) => error.code === 'watch-missing');
});

// The FA214 dev portal: the theme via a plain path (local through the default pattern), app and packages via the proxy (deployed).
const PORTAL = 'https://devportal-kammern.ovsoftware.com';
const PROXY = `${PORTAL}/o/FormProxyServlet?url=inubitrepository:///Root/`;
const FA214_URLS = [
    'Fachanwendung214/AllgemeineVorgangsbearbeitungAntragsdaten.js',
    'Fachanwendung214/AllgemeineVorgangsbearbeitungAntragstellung.js',
    'Fachanwendung214/AllgemeineVorgangsbearbeitungModel.js',
    'Fachanwendung214/FA214Constants.js',
    'public/PackagesExtJS6/aekwl-komponenten.js',
    'public/PackagesExtJS6/AllgemeineRueckfrage.js',
    'public/PackagesExtJS6/Constants.js',
    'public/PackagesExtJS6/Functions.js',
    'public/PackagesExtJS6/modernDokumenteHochladen.js',
    'public/PackagesExtJS6/modernPersonensuche.js',
].map((path) => `${PROXY}${path}`);
const FA214_THEME = `${PORTAL}/html/js/extjs6/build/modern/aekwl-theme-material/aekwl-theme-material.js`;
const FA214_EXPECTED = ['AllgemeineVorgangsbearbeitungAntragstellung.js', 'AllgemeineVorgangsbearbeitungAntragsdaten.js', 'AllgemeineVorgangsbearbeitungModel.js',
    'aekwl-komponenten.js', 'aekwl-theme-material.js', 'modernDokumenteHochladen.js', 'modernProzesse.js'];

test('scriptNames: the last path segment and .js values in the query, decoded, without a pattern', () => {
    assert.deepEqual(scriptNames(`${PROXY}public/PackagesExtJS6/aekwl-komponenten.js`), ['FormProxyServlet', 'aekwl-komponenten.js']);
    assert.deepEqual(scriptNames(FA214_THEME), ['aekwl-theme-material.js']);
    assert.deepEqual(scriptNames('https://p.example/proxy?file=Fa%2FApp.js&_dc=1'), ['proxy', 'App.js']);
    assert.deepEqual(scriptNames('nicht eine URL'), []);
});

test('Pattern finder: the 11 real FA214 scripts yield one proxy pattern, shaped like the FA214 workaround', () => {
    const current = { patterns: [defaultAssetPattern(PORTAL)], local: [FA214_THEME] };
    const expected = FA214_EXPECTED.flatMap((name) => [name, name.replace(/\.js$/, '-debug.js')]);
    const missed = FA214_URLS.filter((url) => scriptNames(url).some((name) => expected.includes(name)));
    assert.equal(missed.length, 5, 'app, Antragsdaten, Model, aekwl-komponenten, modernDokumenteHochladen');
    const { suggestions, unresolved } = suggestAssetPatterns({ urls: missed, expected, current });
    assert.deepEqual(unresolved, []);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].source, `${PORTAL}/o/FormProxyServlet?url=inubitrepository:///Root/`);
    assert.equal(suggestions[0].pattern, '[?&]url=inubitrepository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)');
    assert.deepEqual(suggestions[0].urls, missed);
    // The same shape as the hand-written workaround in FA214's caw.config.json: every name resolves the same way.
    const workaround = 'url=inubitrepository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)';
    for (const url of FA214_URLS) assert.equal(deriveName(url, suggestions[0].pattern), deriveName(url, workaround));
    assert.equal(deriveName(FA214_THEME, suggestions[0].pattern), null, 'the theme keeps its default name');
});

test('Pattern finder: three sources (plain path, proxy parameter, second proxy) yield one pattern per missing source', () => {
    const expected = ['App.js', 'modell.js', 'theme.js', 'extra.js'];
    const urls = [
        'https://cdn.example/static/js/v2/theme.js',
        'https://cdn.example/static/js/v3/extra.js?v=1',
        'https://portal.example/o/Proxy?url=repo:///Root/Fa/App.js',
        'https://portal.example/o/Proxy?url=repo:///Root/public/modell.js&_dc=7',
        'https://portal.example/data/Get?file=lib/other.js',
    ];
    const { suggestions, unresolved } = suggestAssetPatterns({ urls, expected: [...expected, 'other.js'], current: { patterns: [defaultAssetPattern('https://portal.example')], local: ['https://portal.example/js/local.js'] } });
    assert.deepEqual(suggestions.map(({ source }) => source), ['https://cdn.example/static/js/', 'https://portal.example/o/Proxy?url=repo:///Root/', 'https://portal.example/data/Get?file=lib/']);
    for (const { pattern, urls: group } of suggestions) {
        for (const url of group) assert.ok(expected.concat('other.js').includes(deriveName(url, pattern).split('/').at(-1)), `${pattern} ${url}`);
    }
    assert.equal(suggestions[0].pattern, '^https://cdn\\.example/static/js/(?:[^?#]*/)?([^/?#]+\\.js)');
    assert.equal(suggestions[2].urls.length, 1);
    assert.deepEqual(unresolved, []);
    // An encoded value the pattern cannot split: reported, not guessed.
    const encoded = suggestAssetPatterns({ urls: ['https://p.example/proxy?file=lib%2Fa.js', 'https://p.example/proxy?file=x%2Fb.js'], expected: ['a.js', 'b.js'] });
    assert.deepEqual(encoded.suggestions, []);
    assert.equal(encoded.unresolved[0].source, 'https://p.example/proxy?file=');
});
