import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { allTargets, browserHosts, buildDevlinkConfig, effectiveConfig, environmentsWith, resolveTarget, validateConfig } from '../src/shared/config.mjs';
import { checkTest } from '../src/host/test-file.mjs';
import { CawError } from '../src/shared/errors.mjs';

// Ein Fragment fuer `extends` liegt im Projekt; hier in einem eigenen Ordner, mit absolutem Pfad.
const fragmentDir = mkdtempSync(join(tmpdir(), 'caw-fragment-'));
const FRAGMENT = join(fragmentDir, 'basis.json');
writeFileSync(FRAGMENT, JSON.stringify({
    environments: {
        dev: { urls: { nord: 'https://dev.nord.example', sued: 'https://dev.sued.example', west: 'https://dev.west.example' }, agent: true, localCode: true, writable: true },
        test: { urls: { nord: 'https://test.nord.example', sued: 'https://test.sued.example' }, writable: true },
        abnahme: { urls: { nord: 'https://abnahme.nord.example', sued: 'https://abnahme.sued.example' } },
    },
    auth: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: 'body.signed-in' },
    assetUrlPattern: 'proxy\\?file=([^&#]*)',
}));

// Mehrere Mandanten unter eigenen Adressen, Umgebungen aus dem Fragment.
const multiRaw = () => ({
    extends: FRAGMENT,
    sites: ['nord', 'sued'],
    apps: {
        antrag: {
            dir: 'projects/apps/App',
            startUrl: '/app#start',
            redirects: [{ name: 'Fa/App.js', app: true }, { name: 'Fa/Model.js', target: 'Model' }],
            statics: [{ name: 'Fa/Const.js', path: 'projects/const.js' }],
        },
    },
    roles: { kunde: { loginEnv: 'L', passwordEnv: 'P' } },
});
const multi = () => effectiveConfig(multiRaw()).config;

// Der Normalfall: eine Anwendung, ein paar Umgebungen, flach.
const simple = () => ({
    environments: {
        local: { url: 'http://app.localhost:5173', agent: true, localCode: true, writable: true },
        staging: { url: 'https://staging.shop.example' },
    },
    auth: { type: 'form', path: '/anmelden', userSelector: '#mail', passwordSelector: '#pw', submitSelector: 'button[type=submit]', signedInSelector: '#menu' },
    apps: { shop: { dir: 'shop', startUrl: '/shop' } },
    roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B' } },
});

const issues = (config) => validateConfig(config).issues.join('\n');

test('gültige Configs: flach, mit Mandanten, ohne Anmeldung, mit gespeicherter Sitzung', () => {
    assert.deepEqual(validateConfig(multiRaw()).issues, []);
    assert.deepEqual(validateConfig(simple()).issues, []);
    const { auth, roles, ...open } = simple();
    assert.deepEqual(validateConfig(open).issues, [], 'ohne auth: keine Anmeldung, keine Rollen nötig');
    assert.deepEqual(validateConfig({ ...simple(), auth: { type: 'storageState', path: '/', signedInSelector: '#menu' }, roles: { kaeufer: {} } }).issues, []);
    assert.deepEqual(validateConfig({ ...simple(), auth: { type: 'basic' } }).issues, []);
    const twoFactor = { ...simple(), auth: { ...simple().auth, codeSelector: '#code' }, roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B', totpEnv: 'C' } } };
    assert.deepEqual(validateConfig(twoFactor).issues, [], 'ein Einmalcode nach dem Passwort');
});

test('Config: alte Namen werden mit dem neuen genannt, kein Rückfall', () => {
    assert.match(issues({ ...simple(), portals: ['x'] }), /portals gibt es nicht mehr/);
    assert.match(issues({ ...simple(), customPortals: {} }), /environments\.<name>\.url/);
    assert.match(issues({ ...simple(), stages: {} }), /stages heißt jetzt environments/);
    assert.match(issues({ ...simple(), login: {} }), /login steht jetzt in auth/);
    assert.match(issues({ ...simple(), authMarker: '#m' }), /auth\.signedInSelector/);
    assert.match(issues({ ...simple(), preset: './x.json' }), /preset heißt jetzt extends/);
    assert.match(issues({ ...simple(), writableStages: [] }), /writable/);
    assert.match(issues({ ...simple(), ui: { embed: false } }), /ui gibt es nicht mehr/);
    assert.match(issues({ ...simple(), gibtsnicht: 1 }), /Unbekanntes Feld: gibtsnicht/);
});

test('Config: Pflichtfelder, Anmeldung je Art, Fragment nur als Datei im Projekt', () => {
    assert.match(issues({}), /environments fehlt/);
    assert.match(issues({}), /apps fehlt/);
    assert.match(issues({ ...simple(), auth: { type: 'form', path: '/login' } }), /braucht userSelector, passwordSelector, signedInSelector/);
    assert.match(issues({ ...simple(), auth: { ...simple().auth, path: 'ohne-slash' } }), /auth\.path/);
    assert.match(issues({ ...simple(), auth: { type: 'sso' } }), /auth\.type/);
    assert.match(issues({ ...simple(), auth: { type: 'basic', userSelector: '#u' } }), /userSelector gibt es dort nicht/);
    assert.match(issues({ ...simple(), roles: undefined }), /roles fehlt/);
    assert.match(issues({ ...simple(), roles: { kaeufer: {} } }), /loginEnv und passwordEnv/);
    assert.match(issues({ ...simple(), auth: { type: 'storageState' }, roles: { kaeufer: { loginEnv: 'A' } } }), /caw\/\.auth\/<ziel>\/kaeufer\.json/);
    assert.match(issues({ ...multiRaw(), extends: 'basis' }), /Das Fragment liegt im Projekt/);
    assert.match(issues({ ...multiRaw(), extends: './fehlt.json' }), /lässt sich nicht lesen/);
    assert.match(issues({ ...simple(), messageSelectors: [''] }), /messageSelectors/);
    assert.match(issues({ ...simple(), sandboxUser: 'Root User' }), /sandboxUser/);
    assert.match(issues({ ...simple(), readyTimeoutMs: '5s' }), /readyTimeoutMs/);
    assert.equal(issues({ ...simple(), readyTimeoutMs: 20000 }), '');
});

test('Config: Fragment gibt vor, das Projekt gewinnt, Umgebungen je Name zusammengeführt', () => {
    const { config } = effectiveConfig({ ...multiRaw(), auth: { ...multi().auth, signedInSelector: '#eigen' }, environments: { test: { writable: false } } });
    assert.equal(config.auth.signedInSelector, '#eigen');
    assert.equal(config.environments.dev.urls.nord, 'https://dev.nord.example');
    assert.equal(config.environments.test.writable, false);
    assert.equal(config.environments.test.urls.sued, 'https://test.sued.example');
});

test('Mandanten: Ziel mandant/umgebung, nur Mandanten aus sites', () => {
    assert.deepEqual(allTargets(multi()), ['nord/dev', 'sued/dev', 'nord/test', 'sued/test', 'nord/abnahme', 'sued/abnahme']);
    assert.match(issues({ ...multiRaw(), sites: ['ost'] }), /Mandant ost hat in keiner Umgebung eine Adresse/);
    assert.match(issues({ ...simple(), sites: ['nord'] }), /Mit sites steht die Adresse je Mandant in urls/);
    assert.match(issues({ ...simple(), environments: { dev: { urls: { a: 'https://a.example' } } } }), /urls gibt es nur mit sites/);
});

test('Umgebungen: Fähigkeiten aus der Config, Produktion nur ausdrücklich und ohne Claude', () => {
    assert.deepEqual(environmentsWith(multi(), 'agent'), ['dev']);
    assert.deepEqual(environmentsWith(multi(), 'writable'), ['dev', 'test']);
    assert.deepEqual(environmentsWith(simple(), 'localCode'), ['local']);
    assert.equal(resolveTarget(simple(), 'local').agent, true);
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    assert.match(at({ prod: { url: 'https://www.shop.example' } }), /Produktion/);
    assert.match(at({ live: { url: 'https://www.shop.example', production: true, agent: true } }), /Produktion: agent/);
    assert.equal(at({ live: { url: 'https://www.shop.example', production: true } }), '');
    assert.match(at({ local: { url: 'http://app.localhost:5173', agent: 'ja' } }), /agent muss true oder false sein/);
    assert.match(at({ local: { url: 'http://app.localhost:5173', stage: 'x' } }), /stage gibt es dort nicht/);
});

test('Config: http nur auf dem eigenen Rechner (localhost, 127.0.0.1, *.localhost), etwa für einen lokalen Vite-Server', async () => {
    const { browserArgs } = await import('../src/host/browser-session.mjs');
    const at = (url) => issues({ ...simple(), environments: { local: { url } } });
    for (const url of ['http://app.localhost:5173', 'https://app.localhost:5173', 'http://localhost:5173', 'http://127.0.0.1:5173']) assert.equal(at(url), '', url);
    assert.match(at('http://dev.shop.example'), /http nur auf dem eigenen Rechner.*sonst https/);
    assert.match(at('http://127.0.0.2:5173'), /sonst https/, 'nur genau 127.0.0.1');
    // Chrome: localhost fest auf 127.0.0.1 (nicht ::1), die IP braucht keine Regel, fremde Hosts sind Ausnahmen.
    const rules = browserArgs(['localhost', '127.0.0.1', 'app.localhost', 'shop.example'])[0];
    assert.equal(rules, '--host-resolver-rules=MAP localhost 127.0.0.1, MAP app.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE shop.example');
    assert.match(at('http://app.localhost:5173/pfad'), /nur der Origin, ohne Pfad/);
    assert.match(at('https://preview.shop.example/'), /ohne \/ am Ende \(https:\/\/preview\.shop\.example\)/);
});

test('App-Ordner muss relativ zum Projekt und innerhalb liegen', () => {
    const withDir = (dir) => {
        const config = multiRaw();
        config.apps.antrag.dir = dir;
        return issues(config);
    };
    for (const dir of [undefined, '', '/abs', 'C:\\x', '../raus', 'a/../../b']) assert.match(withDir(dir), /dir/, String(dir));
    assert.equal(withDir('a/b'), '');
});

test('consoleIgnore muss gültige reguläre Ausdrücke enthalten', () => {
    assert.match(issues({ ...simple(), consoleIgnore: ['('] }), /consoleIgnore/);
});

test('resolveTarget liefert Adresse und Fähigkeiten', () => {
    assert.deepEqual(resolveTarget(multi(), 'nord/test'), {
        target: 'nord/test', site: 'nord', environment: 'test',
        url: 'https://test.nord.example', writable: true, agent: false, localCode: false, production: false,
    });
    assert.deepEqual(resolveTarget(simple(), 'staging'), {
        target: 'staging', environment: 'staging',
        url: 'https://staging.shop.example', writable: false, agent: false, localCode: false, production: false,
    });
    assert.equal(resolveTarget(multi(), 'sued/abnahme').writable, false);
});

test('resolveTarget weist ab: unbekannt, nicht in sites, Formfehler', () => {
    for (const bad of ['west/dev', 'nord/prod', 'x/dev', 'nord', 'nord/dev/x']) {
        assert.throws(() => resolveTarget(multi(), bad), CawError, bad);
    }
    for (const bad of ['nord/local', 'prod', '']) assert.throws(() => resolveTarget(simple(), bad), CawError, bad);
});

test('browserHosts nimmt nur Adressen der Mandanten aus sites und eigene Ausnahmen, nicht Anthropic', () => {
    const hosts = browserHosts({ ...multi(), extraAllowedHosts: ['cdn.example'] });
    assert.ok(!hosts.includes('api.anthropic.com'));
    assert.ok(hosts.includes('dev.nord.example'));
    assert.ok(hosts.includes('abnahme.sued.example'));
    assert.ok(hosts.includes('cdn.example'));
    assert.ok(!hosts.some((h) => h.includes('west')));
    assert.deepEqual(browserHosts(simple()), ['app.localhost', 'staging.shop.example']);
});

const SPEC = { id: 'smoke', app: 'antrag', role: 'kunde', targets: ['nord/dev', 'sued/test'], source: 'watch', mutates: false, also: [] };

test('checkTest: gültig, ohne lokalen Code wird deployed', () => {
    assert.equal(checkTest(SPEC, 'nord/dev', multi()).source, 'watch');
    assert.equal(checkTest(SPEC, 'sued/test', multi()).source, 'deployed');
});

test('checkTest: Rolle nur, wenn es eine Anmeldung gibt', () => {
    const { auth, roles, ...open } = simple();
    const spec = { id: 'offen', app: 'shop', targets: ['local'], source: 'watch', mutates: false, also: [] };
    assert.equal(checkTest(spec, 'local', open).source, 'deployed');
    assert.throws(() => checkTest(spec, 'local', simple()), /nennt keine role/);
});

test('Lokaler Code: Muster aus der Config, ohne Einträge oder Muster gibt es nur den deployten Stand', () => {
    const noEntries = { ...multi(), apps: { antrag: { dir: 'app', startUrl: '/a' } } };
    assert.equal(checkTest(SPEC, 'nord/dev', noEntries).source, 'deployed');
    const own = { ...simple(), assetUrlPattern: '/static/js/(.+\\.js)', apps: { shop: { dir: 'shop', startUrl: '/shop', statics: [{ name: 'main.js', path: 'dist/main.js' }] } } };
    assert.deepEqual(validateConfig(own).issues, []);
    const { assetUrlPattern, ...withoutPattern } = own;
    assert.match(issues(withoutPattern), /shop nennen lokalen Code.*assetUrlPattern fehlt/);
    assert.match(issues({ ...own, assetUrlPattern: '/static/js/.+' }), /braucht eine Gruppe/);
    assert.match(issues({ ...own, assetUrlPattern: '(' }), /kein gültiger/);
    const built = buildDevlinkConfig(own, resolveTarget(own, 'local'), 'shop', 'watch', '/p');
    assert.equal(built.assetUrlPattern, assetUrlPattern);
    assert.equal(built.authMarker, '#menu');
    assert.deepEqual(built.projects[0].redirects, []);
    assert.equal(built.projects[0].statics[0].localPath, '/p/dist/main.js');
});

test('Lokaler Code: Dateiname aus der URL nach assetUrlPattern', async () => {
    const { deriveRepoPath } = await import('../src/host/devlink-core.mjs');
    const proxy = 'proxy\\?file=([^&#]*)';
    assert.equal(deriveRepoPath('https://p.example/o/proxy?file=Fa/App.js&_dc=1', proxy), 'Fa/App.js');
    assert.equal(deriveRepoPath('https://p.example/other.js', proxy), null);
    assert.equal(deriveRepoPath('https://shop.example/static/js/main.js?v=3', '/static/js/([^?#]+)'), 'main.js');
    assert.equal(deriveRepoPath('https://p.example/o/proxy?file=Fa/App.js', undefined), null, 'ohne Muster nichts');
});

test('checkTest: Ziel muss im Test stehen', () => {
    assert.throws(() => checkTest(SPEC, 'nord/test', multi()), /targets/);
});

test('checkTest: unbekannte App oder Rolle', () => {
    assert.throws(() => checkTest({ ...SPEC, app: 'x' }, 'nord/dev', multi()), /App/);
    assert.throws(() => checkTest({ ...SPEC, role: 'x' }, 'nord/dev', multi()), /Rolle/);
});

test('checkTest: mutates wird auf Umgebungen ohne writable abgewiesen', () => {
    const spec = { ...SPEC, mutates: true, targets: ['nord/dev', 'nord/test', 'nord/abnahme'] };
    assert.equal(checkTest(spec, 'nord/dev', multi()).mutates, true);
    assert.equal(checkTest(spec, 'nord/test', multi()).mutates, true);
    assert.throws(() => checkTest(spec, 'nord/abnahme', multi()), /schreibgeschützt/);
});

test('buildDevlinkConfig: Watch-Quelle ergibt Redirects, Statics mit absolutem Pfad', () => {
    const cfg = buildDevlinkConfig(multi(), resolveTarget(multi(), 'nord/dev'), 'antrag', 'watch', '/workspaces/X');
    assert.equal(cfg.portals[0].url, 'https://dev.nord.example');
    assert.equal(cfg.activePortal, cfg.portals[0].uuid);
    const p = cfg.projects[0];
    assert.equal(p.redirects[0].app, true);
    assert.equal(p.redirects[0].target, null);
    assert.equal(p.redirects[1].target, 'Model');
    assert.equal(p.statics[0].localPath, '/workspaces/X/projects/const.js');
    const uuids = [cfg.portals[0].uuid, p.uuid, ...p.redirects.map((r) => r.uuid), ...p.statics.map((s) => s.uuid)];
    assert.equal(new Set(uuids).size, uuids.length);
});

test('buildDevlinkConfig: Quelle deployed ersetzt nichts, ohne Anmeldung kein Marker', () => {
    const p = buildDevlinkConfig(multi(), resolveTarget(multi(), 'nord/test'), 'antrag', 'deployed', '/w').projects[0];
    assert.deepEqual([p.redirects, p.constants, p.statics], [[], [], []]);
    const { auth, roles, ...open } = simple();
    assert.equal(buildDevlinkConfig(open, resolveTarget(open, 'local'), 'shop', 'deployed', '/w').authMarker, null);
});

test('browserHosts: Produktion nur, wenn der Lauf selbst darauf zielt', () => {
    const config = { ...simple(), environments: { ...simple().environments, live: { url: 'https://www.shop.example', production: true } }, extraAllowedHosts: ['www.shop.example', 'sso.example'] };
    assert.deepEqual(validateConfig(config).issues, []);
    const onLocal = browserHosts(config, resolveTarget(config, 'local'));
    assert.ok(!onLocal.includes('www.shop.example'), 'auch nicht über extraAllowedHosts');
    assert.ok(onLocal.includes('sso.example') && onLocal.includes('staging.shop.example'));
    assert.ok(browserHosts(config, resolveTarget(config, 'live')).includes('www.shop.example'));
    assert.ok(!browserHosts(config).includes('www.shop.example'));
});

test('Produktion: auch als Namensbestandteil erkannt, ausdrücklich false erlaubt', () => {
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    for (const name of ['prod-de', 'live_eu', 'prd2', 'produktiv-at']) assert.match(at({ [name]: { url: 'https://www.shop.example', agent: true } }), /sieht nach Produktion aus/, name);
    assert.equal(at({ 'live-preview': { url: 'https://preview.shop.example', production: false, agent: true } }), '');
    assert.equal(at({ delivery: { url: 'https://d.shop.example' } }), '', 'kein Treffer mitten im Wort');
    assert.match(issues({ ...multiRaw(), sites: ['nord', 'live'] }), /Mandant live sieht nach Produktion aus/);
});

test('Produktion: die genauen Namen lassen sich nicht mit false umgehen', () => {
    assert.match(issues({ ...simple(), environments: { ...simple().environments, prod: { url: 'https://www.shop.example', production: false, agent: true } } }), /dem Namen nach Produktion/);
});

test('Config: kaputte Werte führen zu Meldungen, nicht zu Abstürzen', () => {
    assert.match(validateConfig(null).issues.join(), /JSON-Objekt/);
    assert.match(issues({ ...simple(), apps: { web: null } }), /App web muss ein Objekt sein/);
    assert.match(issues({ ...simple(), consoleIgnore: 'foo' }), /consoleIgnore muss eine Liste/);
    assert.match(issues({ ...simple(), sandboxImage: 'node:22\nRUN curl x' }), /Image-Referenz/);
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', roles: {} } } }), /roles gibt es dort nicht/);
    const { auth, roles, ...open } = simple();
    assert.match(issues({ ...open, roles: {} }), /Ohne Anmeldung \(auth\) lass roles weg/);
    assert.match(issues({ ...simple(), auth: { ...simple().auth, path: 'https://sso.example/login' } }), /extraAllowedHosts/);
});

test('Config: browser wählt einen Chromium-Browser, Standard Chrome', async () => {
    const { browserLaunch } = await import('../src/shared/config.mjs');
    assert.deepEqual(browserLaunch({}), { channel: 'chrome' });
    assert.deepEqual(browserLaunch({ browser: { channel: 'msedge' } }), { channel: 'msedge' });
    assert.deepEqual(browserLaunch({ browser: { executablePath: '/opt/chromium/chrome' } }), { executablePath: '/opt/chromium/chrome' });
    assert.equal(issues({ ...simple(), browser: { channel: 'msedge' } }), '');
    assert.match(issues({ ...simple(), browser: { channel: 'firefox' } }), /browser.channel muss einer von/);
    assert.match(issues({ ...simple(), browser: { executablePath: 'chrome.exe' } }), /absoluter Pfad/);
    assert.match(issues({ ...simple(), browser: 'edge' }), /browser muss ein Objekt sein/);
});
