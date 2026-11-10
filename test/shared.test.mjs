import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { allTargets, browserHosts, buildDevlinkConfig, defaultAssetPattern, effectiveConfig, environmentsWith, resolveTarget, validateConfig } from '../src/shared/config.mjs';
import { deriveName } from '../src/host/overlay.mjs';
import { checkTest, withDefaults } from '../src/host/test-file.mjs';
import { CawError } from '../src/shared/errors.mjs';

// Ein Fragment fuer `extends` liegt im Projekt; hier in einem eigenen Ordner, mit absolutem Pfad.
const fragmentDir = mkdtempSync(join(tmpdir(), 'caw-fragment-'));
const FRAGMENT = join(fragmentDir, 'basis.json');
writeFileSync(FRAGMENT, JSON.stringify({
    environments: {
        dev: { urls: { nord: 'https://dev.nord.example', sued: 'https://dev.sued.example', west: 'https://dev.west.example' }, agent: true, overlay: true, writable: true },
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
            overlay: { statics: [{ name: 'Fa/Const.js', path: 'const.js' }] },
        },
    },
    roles: { kunde: { loginEnv: 'L', passwordEnv: 'P' } },
});
const multi = () => effectiveConfig(multiRaw()).config;

// Der Normalfall: eine Anwendung, ein paar Umgebungen, flach.
const simple = () => ({
    environments: {
        local: { url: 'https://app.localhost:8443', agent: true, overlay: true, writable: true },
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
    assert.deepEqual(environmentsWith(simple(), 'overlay'), ['local']);
    assert.equal(resolveTarget(simple(), 'local').agent, true);
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    assert.match(at({ prod: { url: 'https://www.shop.example' } }), /Produktion/);
    assert.match(at({ live: { url: 'https://www.shop.example', production: true, agent: true } }), /Produktion: claude/);
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
    // Chrome: localhost fest auf 127.0.0.1 (nicht ::1); die IP und fremde Hosts sind Ausnahmen, denn auch eine IP trifft MAP *.
    const rules = browserArgs(['localhost', '127.0.0.1', 'app.localhost', 'shop.example'])[0];
    assert.equal(rules, '--host-resolver-rules=MAP localhost 127.0.0.1, MAP app.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE shop.example');
    // Mit localhost auch 127.0.0.1 und umgekehrt: webpack-dev-server oeffnet seinen Socket unter dem Host aus seiner Konfiguration.
    assert.equal(browserArgs(['localhost'])[0], '--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    assert.equal(browserArgs(['127.0.0.1'])[0], '--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    assert.equal(browserArgs(['app.localhost'])[0], '--host-resolver-rules=MAP app.localhost 127.0.0.1, MAP * ~NOTFOUND', 'ein Name unter .localhost gibt nicht alles frei');
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
        url: 'https://test.nord.example', writable: true, agent: false, overlay: false, production: false,
    });
    assert.deepEqual(resolveTarget(simple(), 'staging'), {
        target: 'staging', environment: 'staging',
        url: 'https://staging.shop.example', writable: false, agent: false, overlay: false, production: false,
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

const SPEC = { id: 'smoke', app: 'antrag', role: 'kunde', targets: ['nord/dev', 'sued/test'], mutates: false, also: [] };

test('checkTest: gültig; ohne --overlay immer der ausgelieferte Stand, auch wo das Overlay ginge', () => {
    assert.equal(checkTest(SPEC, 'nord/dev', multi()).source, 'deployed');
    assert.equal(checkTest(SPEC, 'nord/dev', multi(), { overlay: true }).source, 'overlay');
    assert.equal(checkTest(SPEC, 'sued/test', multi()).source, 'deployed');
});

test('checkTest: Rolle nur, wenn es eine Anmeldung gibt; mit genau einer Rolle gilt sie', () => {
    const { auth, roles, ...open } = simple();
    const spec = { id: 'offen', app: 'shop', targets: ['local'], mutates: false, also: [] };
    assert.equal(checkTest(spec, 'local', open).source, 'deployed');
    assert.equal(withDefaults(spec, simple()).role, 'kaeufer');
    const two = { ...simple(), roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B' }, admin: { loginEnv: 'C', passwordEnv: 'D' } } };
    assert.throws(() => checkTest(spec, 'local', two), /nennt keine role.*Rollen in caw\.config\.json: kaeufer, admin/);
    assert.throws(() => checkTest({ ...spec, role: 'chef' }, 'local', two), /Unbekannte Rolle: chef \(Rollen in caw\.config\.json: kaeufer, admin\)/);
});

test('Welcher Code läuft: ausgeliefert, außer --overlay; geht das Overlay nicht, ein Aufruffehler mit Grund', () => {
    const own = { ...simple(), apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { build: 'dist' } } } };
    const spec = { id: 'smoke', mutates: false, also: [] };
    assert.deepEqual(withDefaults(spec, own), { ...spec, app: 'shop', role: 'kaeufer', targets: ['local', 'staging'] }, 'app, role und targets aus der Config');
    assert.equal(checkTest(spec, 'local', own).source, 'deployed', 'nie still lokal');
    const build = { kind: 'build', dir: 'dist', statics: [] };
    assert.deepEqual([checkTest(spec, 'local', own, { overlay: true })].map(({ source, apps }) => ({ source, apps })), [{ source: 'overlay', apps: { shop: build } }]);
    assert.deepEqual(checkTest(spec, 'local', own, { overlay: 'build' }).apps.shop, build);
    assert.throws(() => checkTest(spec, 'local', own, { overlay: 'dev' }), (error) => error.code === 'usage' && /--overlay dev geht hier nicht: App shop hat kein overlay\.dev\. Sie hat overlay\.build: --overlay build\./.test(error.message));
    assert.deepEqual(checkTest(spec, 'local', own, { overlay: 'http://localhost:5174' }).apps.shop, { kind: 'dev', url: 'http://localhost:5174', statics: [] }, 'eine Adresse braucht keine Config');
    const both = { ...own, apps: { shop: { ...own.apps.shop, overlay: { build: 'dist', dev: 'http://localhost:5173', devCommand: 'npm run dev' } } } };
    assert.throws(() => checkTest(spec, 'local', both, { overlay: true }), (error) => error.code === 'usage' && /wähle --overlay build oder --overlay dev/.test(error.message));
    assert.deepEqual(checkTest(spec, 'local', both, { overlay: 'dev' }).apps.shop, { kind: 'dev', url: 'http://localhost:5173', command: 'npm run dev', statics: [] });
    const withAdmin = { ...both, apps: { ...both.apps, admin: { dir: 'admin', startUrl: '/' } } };
    assert.throws(() => checkTest({ ...spec, app: 'shop', also: ['admin'] }, 'local', withAdmin, { overlay: 'http://localhost:5174' }), (error) => error.code === 'usage' && /gilt für genau eine App, der Test hat shop, admin/.test(error.message));
    assert.deepEqual(Object.keys(checkTest({ ...spec, app: 'shop', also: ['admin'] }, 'local', withAdmin, { overlay: 'dev' }).apps), ['shop'], 'eine weitere App ohne Quelle bleibt ausgeliefert');
    assert.throws(() => checkTest(spec, 'local', simple(), { overlay: true }), (error) => error.code === 'usage' && /apps\.shop\.overlay\.build/.test(error.message));
    const extjs = { ...simple(), framework: 'extjs' };
    assert.deepEqual(checkTest(spec, 'local', extjs, { overlay: true }).apps.shop, { kind: 'watch', statics: [] }, 'ExtJS: der Watch, ohne Config');
    assert.throws(() => checkTest(spec, 'local', extjs, { overlay: 'build' }), (error) => error.code === 'usage' && /--overlay build gibt es bei ExtJS nicht/.test(error.message));
    // http auf localhost ist ein Dev-Server: Dort laeuft immer der eigene Stand, ein Overlay ergibt keinen Sinn. https auf *.localhost
    // ist dagegen ein ausgelieferter Build wie jeder andere.
    const at = (url) => ({ ...own, environments: { box: { url, claude: true, overlay: true } } });
    assert.throws(() => checkTest(spec, 'box', at('http://localhost:5173'), { overlay: true }), (error) => error.code === 'usage' && /Umgebung box ist ein Dev-Server \(localhost:5173\)/.test(error.message));
    assert.equal(checkTest(spec, 'box', at('https://shop.localhost:8443'), { overlay: true }).source, 'overlay');
    assert.throws(() => checkTest({ ...spec, targets: ['local'] }, 'staging', own), /Trage staging in targets in caw\/tests\/smoke\.yaml ein/);
    const twoApps = { ...own, apps: { ...own.apps, admin: { dir: 'admin', startUrl: '/' } } };
    assert.throws(() => checkTest(spec, 'local', twoApps), /smoke nennt keine app.*\(shop, admin\)/);
    assert.throws(() => checkTest({ ...spec, app: 'web' }, 'local', twoApps), /Unbekannte App: web \(Apps in caw\.config\.json: shop, admin\)/);
});

test('Config: Vorschläge bei Tippfehlern, claude statt agent, Hinweise auf Einstellungen ohne Wirkung', () => {
    assert.match(issues({ ...simple(), insecureTLS: true }), /Unbekanntes Feld: insecureTLS \(meintest du insecureTls\?\)/);
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', overlya: true } } }), /overlya gibt es dort nicht.*\(meintest du overlay\?\)/);
    assert.doesNotMatch(issues({ ...simple(), zzz: 1 }), /meintest/);
    assert.match(issues({ ...simple(), extraAllowedHosts: ['https://login.example.com/'] }), /"https:\/\/login\.example\.com\/" ist kein Hostname; gemeint ist wohl "login\.example\.com"/);
    assert.match(issues({ ...simple(), extraAllowedHosts: ['a b'] }), /"a b" ist kein Hostname, etwa/);
    const claude = { ...simple(), environments: { local: { url: 'http://app.localhost:5173', claude: true, writable: true } } };
    assert.deepEqual(validateConfig(claude), { ok: true, issues: [], notes: [] });
    assert.equal(resolveTarget(claude, 'local').agent, true);
    const old = validateConfig(simple());
    assert.deepEqual(old.issues, [], 'agent gilt weiter');
    assert.match(old.notes.join('\n'), /Umgebung local: agent heißt jetzt claude/);
    const buildOnly = { ...claude, apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { build: 'dist' } } } };
    assert.match(validateConfig(buildOnly).notes.join('\n'), /App shop hat overlay, aber keine Umgebung hat "overlay": true/);
});

test('Overlay-Config: Muster und statics; ohne Quelle an der App gibt es nur den ausgelieferten Stand', () => {
    const noEntries = { ...multi(), apps: { antrag: { dir: 'app', startUrl: '/a' } } };
    assert.equal(checkTest(SPEC, 'nord/dev', noEntries).source, 'deployed');
    const own = { ...simple(), assetUrlPattern: '/static/js/(.+\\.js)', apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { statics: [{ name: 'main.js', path: 'dist/main.js' }] } } } };
    assert.deepEqual(validateConfig(own).issues, []);
    const { assetUrlPattern, ...withoutPattern } = own;
    assert.deepEqual(validateConfig(withoutPattern).issues, [], 'ohne Muster ist der Name der Pfad unter der Umgebung');
    assert.match(issues({ ...own, assetUrlPattern: '/static/js/.+' }), /braucht eine Gruppe/);
    assert.match(issues({ ...own, assetUrlPattern: '(' }), /kein gültiger/);
    const built = buildDevlinkConfig(own, resolveTarget(own, 'local'), 'shop');
    assert.equal(built.assetUrlPattern, assetUrlPattern);
    assert.equal(built.authMarker, '#menu');
    assert.deepEqual(built.projects[0], { uuid: built.projects[0].uuid, name: 'shop', active: true, startUrl: '/shop' }, 'den lokalen Code spielt das Overlay ein');
});

test('Overlay-Config: build, dev, Befehle und statics werden geprüft, nicht erst im Lauf', () => {
    const app = (overlay, framework) => issues({ ...simple(), ...(framework === undefined ? {} : { framework }), apps: { shop: { dir: 'shop', startUrl: '/shop', overlay } } });
    assert.equal(app({ build: 'dist/app/browser', buildCommand: 'npm run build', dev: 'http://localhost:5173', devCommand: 'npm run dev', statics: [{ name: 'a.js', path: 'a.js' }] }), '');
    for (const bad of ['', '/abs', 'C:\\x', '../raus', 3]) assert.match(app({ build: bad }), /overlay\.build muss der relative Pfad/);
    for (const bad of ['localhost:5173', 'ftp://x', 5173]) assert.match(app({ dev: bad }), /overlay\.dev muss die Adresse des Dev-Servers sein/);
    assert.match(app({ buildCommand: 'npm run build' }), /overlay\.buildCommand braucht overlay\.build/);
    assert.match(app({ dev: 'http://localhost:5173', devCommand: '' }), /overlay\.devCommand muss ein Befehl sein/);
    assert.match(app({ devServer: 'http://localhost:5173' }), /unbekanntes Feld overlay\.devServer/);
    assert.match(app({ statics: [{ name: 'x' }] }), /overlay\.statics\[0\] braucht name und path/);
    assert.match(app({ statics: [{ name: 'x', path: '../aussen.js' }] }), /overlay\.statics\[0\]/);
    assert.match(app({ statics: 'a.js' }), /overlay\.statics muss eine Liste sein/);
    assert.match(app('dist'), /overlay muss ein Objekt sein/);
    assert.equal(app({ devCommand: 'sencha app watch', statics: [{ name: 'C.js', path: 'c.js' }] }, 'extjs'), '', 'ExtJS: der Watch braucht keine Quelle');
    assert.match(app({ build: 'build' }, 'extjs'), /Bei ExtJS kommt der lokale Code vom Sencha-Watch/);
    assert.match(issues({ ...simple(), apps: { shop: { dir: 'shop', localBuild: 'dist' } } }), /App shop: unbekanntes Feld localBuild\. Eine App kennt dir, startUrl und overlay/);
});

test('Overlay: Dateiname aus der URL, nach assetUrlPattern oder als Pfad unter der Umgebung', () => {
    const proxy = 'proxy\\?file=([^&#]*)';
    assert.equal(deriveName('https://p.example/o/proxy?file=Fa/App.js&_dc=1', proxy), 'Fa/App.js');
    assert.equal(deriveName('https://p.example/other.js', proxy), null);
    assert.equal(deriveName('https://shop.example/static/js/main.js?v=3', '/static/js/([^?#]+)'), 'main.js');
    assert.equal(deriveName('https://p.example/o/proxy?file=Fa/App.js', undefined), null, 'ohne Muster nichts');
    const under = defaultAssetPattern('https://Shop.Example:443/app/');
    assert.equal(deriveName('https://shop.example/app/assets/index-X1Y2Z3W4.js?v=2', under), 'assets/index-X1Y2Z3W4.js');
    assert.equal(deriveName('https://cdn.example/app/assets/index.js', under), null, 'nur die Umgebung');
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

test('buildDevlinkConfig: Umgebung und Startseite, ohne Anmeldung kein Marker', () => {
    const cfg = buildDevlinkConfig(multi(), resolveTarget(multi(), 'nord/dev'), 'antrag');
    assert.equal(cfg.portals[0].url, 'https://dev.nord.example');
    assert.equal(cfg.activePortal, cfg.portals[0].uuid);
    assert.equal(cfg.projects[0].startUrl, '/app#start');
    assert.notEqual(cfg.projects[0].uuid, cfg.portals[0].uuid);
    const { auth, roles, ...open } = simple();
    assert.equal(buildDevlinkConfig(open, resolveTarget(open, 'local'), 'shop').authMarker, null);
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

test('Config: Die Felder einer Rolle werden geprüft, nicht erst im Lauf', () => {
    const role = (fields) => issues({ ...simple(), roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B', ...fields } } });
    assert.equal(role({ totpEnv: 'TOTP_SECRET' }), '');
    assert.match(role({ passwortEnv: 'X' }), /unbekanntes Feld passwortEnv/);
    assert.match(role({ totpEnv: 7 }), /totpEnv muss der Name einer Variable/);
    assert.match(role({ loginEnv: 'mit leerzeichen' }), /loginEnv muss der Name einer Variable/);
});
