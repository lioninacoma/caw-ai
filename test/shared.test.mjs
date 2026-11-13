import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assetPatterns, buildDevlinkConfig, defaultAssetPattern, environmentsWith, navigationHosts, validateConfig, writeConfig } from '../src/shared/config.mjs';
import { effectiveEnvironment } from '../src/shared/environments.mjs';
import { deriveName } from '../src/host/overlay.mjs';
import { checkTest, withDefaults } from '../src/host/test-file.mjs';
import { CawError } from '../src/shared/errors.mjs';

// Tenants as environments: the south ones extend the north ones and only change the address.
const multiRaw = () => ({
    environments: {
        'nord-dev': { url: 'https://dev.nord.example', claude: true, overlay: true, writable: true },
        'sued-dev': { extends: 'nord-dev', url: 'https://dev.sued.example' },
        'nord-test': { url: 'https://test.nord.example', writable: true },
        'sued-test': { extends: 'nord-test', url: 'https://test.sued.example' },
        'nord-abnahme': { url: 'https://abnahme.nord.example' },
        'sued-abnahme': { extends: 'nord-abnahme', url: 'https://abnahme.sued.example' },
    },
    auth: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: 'body.signed-in' },
    assetUrlPattern: 'proxy\\?file=([^&#]*)',
    apps: {
        antrag: {
            dir: 'projects/apps/App',
            startUrl: '/app#start',
            overlay: { statics: [{ name: 'Fa/Const.js', path: 'const.js' }] },
        },
    },
    roles: { kunde: { loginEnv: 'L', passwordEnv: 'P' } },
});
const multi = multiRaw;

// The usual case: one application, a few environments, flat.
const simple = () => ({
    environments: {
        local: { url: 'https://app.localhost:8443', claude: true, overlay: true, writable: true },
        staging: { url: 'https://staging.shop.example' },
    },
    auth: { type: 'form', path: '/anmelden', userSelector: '#mail', passwordSelector: '#pw', submitSelector: 'button[type=submit]', signedInSelector: '#menu' },
    apps: { shop: { dir: 'shop', startUrl: '/shop' } },
    roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B' } },
});

// The simple config without login: no auth, no roles.
const withoutAuth = () => {
    const config = simple();
    delete config.auth;
    delete config.roles;
    return config;
};

const issues = (config) => validateConfig(config).issues.join('\n');

test('valid configs: flat, tenants as environments, without login, with a stored session', () => {
    assert.deepEqual(validateConfig(multiRaw()).issues, []);
    assert.deepEqual(validateConfig(simple()).issues, []);
    const open = withoutAuth();
    assert.deepEqual(validateConfig(open).issues, [], 'without auth: no login, no roles needed');
    assert.deepEqual(validateConfig({ ...simple(), auth: { type: 'storageState', path: '/', signedInSelector: '#menu' }, roles: { kaeufer: {} } }).issues, []);
    assert.deepEqual(validateConfig({ ...simple(), auth: { type: 'basic' } }).issues, []);
    const twoFactor = { ...simple(), auth: { ...simple().auth, codeSelector: '#code' }, roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B', totpEnv: 'C' } } };
    assert.deepEqual(validateConfig(twoFactor).issues, [], 'a one-time code after the password');
});

test('config: unknown fields are errors', () => {
    assert.match(issues({ ...simple(), gibtsnicht: 1 }), /Unbekanntes Feld: gibtsnicht/);
});

test('config: TODO from init is a gap, not an error; doctor and validate list it', () => {
    const todo = { ...simple(), auth: { ...simple().auth, path: 'TODO', signedInSelector: 'TODO' } };
    const result = validateConfig(todo);
    assert.deepEqual(result.issues, [], 'a TODO path is not reported as a wrong path');
    assert.deepEqual(result.todo, ['auth.path', 'auth.signedInSelector']);
    assert.deepEqual(validateConfig(simple()).todo, []);
});

test('config: browser.locale, browser.timezone and readyIgnore', () => {
    assert.equal(issues({ ...simple(), browser: { locale: 'de-DE', timezone: 'Europe/Berlin' }, readyIgnore: ['.uhr', '#ticker'] }), '');
    assert.match(issues({ ...simple(), browser: { locale: 'kein locale!' } }), /browser\.locale muss ein Sprachkürzel sein/);
    assert.match(issues({ ...simple(), browser: { locale: 7 } }), /browser\.locale/);
    assert.match(issues({ ...simple(), browser: { timezone: 'Mars/Olympus' } }), /browser\.timezone muss eine Zeitzone sein/);
    assert.match(issues({ ...simple(), browser: { zone: 'UTC' } }), /browser\.zone gibt es nicht \(erlaubt: channel, executablePath, locale, timezone\)/);
    assert.match(issues({ ...simple(), readyIgnore: '.uhr' }), /readyIgnore muss eine Liste von CSS-Selektoren sein/);
    assert.match(issues({ ...simple(), readyIgnore: [''] }), /readyIgnore/);
});

test('config: required fields, login per type', () => {
    assert.match(issues({}), /environments fehlt/);
    assert.match(issues({}), /apps fehlt/);
    assert.match(issues({ ...simple(), auth: { type: 'form', path: '/login' } }), /braucht userSelector, passwordSelector, signedInSelector/);
    assert.match(issues({ ...simple(), auth: { ...simple().auth, path: 'ohne-slash' } }), /auth\.path/);
    assert.match(issues({ ...simple(), auth: { type: 'sso' } }), /auth\.type/);
    assert.match(issues({ ...simple(), auth: { type: 'basic', userSelector: '#u' } }), /userSelector gibt es dort nicht/);
    assert.match(issues({ ...simple(), roles: undefined }), /roles fehlt/);
    assert.match(issues({ ...simple(), roles: { kaeufer: {} } }), /loginEnv und passwordEnv/);
    assert.match(issues({ ...simple(), auth: { type: 'storageState' }, roles: { kaeufer: { loginEnv: 'A' } } }), /caw\/\.auth\/<ziel>\/kaeufer\.json/);
    assert.match(issues({ ...simple(), messageSelectors: [''] }), /messageSelectors/);
    assert.match(issues({ ...simple(), sandboxUser: 'Root User' }), /sandboxUser/);
    assert.match(issues({ ...simple(), readyTimeoutMs: '5s' }), /readyTimeoutMs/);
    assert.equal(issues({ ...simple(), readyTimeoutMs: 20000 }), '');
});

test('config: keys from before 1.0 name what replaced them; extends between environments is checked', () => {
    assert.match(issues({ ...simple(), sites: ['nord'] }), /sites gibt es nicht mehr: Mandanten sind jetzt Umgebungen/);
    assert.match(issues({ ...simple(), extends: './basis.json' }), /extends gibt es nicht mehr: eine Config je Projekt/);
    assert.match(issues({ ...simple(), insecureTls: true }), /insecureTls heißt jetzt environments\.<env>\.insecureTls/);
    assert.match(issues({ ...simple(), extraAllowedHosts: ['sso.example'] }), /extraAllowedHosts heißt jetzt allowHosts/);
    assert.match(issues({ ...simple(), environments: { dev: { urls: { a: 'https://a.example' } } } }), /environments\.dev\.urls gibt es nicht mehr/);
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    assert.match(at({ sued: { extends: 'nord', url: 'https://s.example' } }), /extends „nord“ ist keine Umgebung/);
    assert.match(at({ a: { extends: 'b', url: 'https://a.example' }, b: { extends: 'a', url: 'https://b.example' } }), /extends läuft im Kreis: a → b → a/);
    assert.match(at({ kopie: { extends: 'staging' } }), /^$/, 'the url comes through extends');
    assert.match(at({ leer: { claude: true } }), /Umgebung leer hat keine url/);
    assert.match(at({ nord_dev: { url: 'https://n.example' } }), /Umgebung „nord_dev“: Kleinbuchstaben, Ziffern und -/);
    // A production child must say so itself; a non-production environment on a production host is refused.
    assert.match(at({ live: { url: 'https://www.shop.example', production: true }, kopie: { extends: 'live', url: 'https://www.shop.example' } }), /Umgebung kopie nutzt den Host www\.shop\.example der Produktionsumgebung live/);
    assert.equal(effectiveEnvironment(multi(), 'sued-dev').claude, true);
    assert.equal(effectiveEnvironment(multi(), 'sued-dev').url, 'https://dev.sued.example');
});

test('config: insecureTls, allowHttp and allowHosts per environment', () => {
    const at = (environments, more = {}) => issues({ ...simple(), ...more, environments: { ...simple().environments, ...environments } });
    assert.equal(at({ intern: { url: 'https://intern.example', insecureTls: true } }), '');
    assert.equal(at({ box: { url: 'http://box.intern.example', allowHttp: true } }), '');
    assert.match(at({ box: { url: 'http://box.intern.example' } }), /allowHttp": true an der Umgebung/);
    assert.match(validateConfig({ ...simple(), environments: { ...simple().environments, local2: { url: 'http://localhost:5174', allowHttp: true } } }).notes.join('\n'), /Umgebung local2: allowHttp wirkt hier nicht/);
    assert.equal(at({ staging: { url: 'https://staging.shop.example', allowHosts: ['sso.example'] } }, { allowHosts: ['cdn.example'] }), '');
    assert.match(at({}, { allowHosts: ['https://login.example.com/'] }), /allowHosts: "https:\/\/login\.example\.com\/" ist eine Adresse; der Hostname reicht: "login\.example\.com"/);
    assert.match(at({ staging: { url: 'https://staging.shop.example', allowHosts: ['a b'] } }), /environments\.staging\.allowHosts: "a b" ist kein Hostname/);
});

test('environments: capabilities from the config, production only explicitly and without Claude', () => {
    assert.deepEqual(environmentsWith(multi(), 'claude'), ['nord-dev', 'sued-dev']);
    assert.deepEqual(environmentsWith(multi(), 'writable'), ['nord-dev', 'sued-dev', 'nord-test', 'sued-test']);
    assert.deepEqual(environmentsWith(simple(), 'overlay'), ['local']);
    assert.equal(effectiveEnvironment(simple(), 'local').claude, true);
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    assert.match(at({ prod: { url: 'https://www.shop.example' } }), /Produktion/);
    assert.match(at({ live: { url: 'https://www.shop.example', production: true, claude: true } }), /Produktion: claude/);
    assert.equal(at({ live: { url: 'https://www.shop.example', production: true } }), '');
    assert.match(at({ local: { url: 'http://app.localhost:5173', claude: 'ja' } }), /claude muss true oder false sein/);
    assert.match(at({ local: { url: 'http://app.localhost:5173', stage: 'x' } }), /stage gibt es dort nicht/);
});

test('config: http only on the own machine (localhost, 127.0.0.1, *.localhost), e.g. for a local Vite server', async () => {
    const { browserArgs } = await import('../src/host/browser-session.mjs');
    const at = (url) => issues({ ...simple(), environments: { local: { url } } });
    for (const url of ['http://app.localhost:5173', 'https://app.localhost:5173', 'http://localhost:5173', 'http://127.0.0.1:5173']) assert.equal(at(url), '', url);
    assert.match(at('http://dev.shop.example'), /http nur auf dem eigenen Rechner.*sonst https/);
    assert.match(at('http://127.0.0.2:5173'), /sonst https/, 'only exactly 127.0.0.1');
    // Chrome: localhost pinned to 127.0.0.1 (not ::1); the IP and foreign hosts are exclusions, because an IP also matches MAP *.
    const rules = browserArgs(['localhost', '127.0.0.1', 'app.localhost', 'shop.example'])[0];
    assert.equal(rules, '--host-resolver-rules=MAP localhost 127.0.0.1, MAP app.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE shop.example');
    // localhost implies 127.0.0.1 and vice versa: webpack-dev-server opens its socket under the host from its configuration.
    assert.equal(browserArgs(['localhost'])[0], '--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    assert.equal(browserArgs(['127.0.0.1'])[0], '--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    assert.equal(browserArgs(['app.localhost'])[0], '--host-resolver-rules=MAP app.localhost 127.0.0.1, MAP * ~NOTFOUND', 'a name under .localhost does not open everything');
    assert.match(at('http://app.localhost:5173/pfad'), /nur der Origin, ohne Pfad/);
    assert.match(at('https://preview.shop.example/'), /ohne \/ am Ende \(https:\/\/preview\.shop\.example\)/);
});

test('the app folder must be relative to and inside the project', () => {
    const withDir = (dir) => {
        const config = multiRaw();
        config.apps.antrag.dir = dir;
        return issues(config);
    };
    for (const dir of [undefined, '', '/abs', 'C:\\x', '../raus', 'a/../../b']) assert.match(withDir(dir), /dir/, String(dir));
    assert.equal(withDir('a/b'), '');
});

test('consoleIgnore must contain valid regular expressions', () => {
    assert.match(issues({ ...simple(), consoleIgnore: ['('] }), /consoleIgnore/);
});

test('effectiveEnvironment returns URL and capabilities; unknown names are rejected', () => {
    assert.deepEqual(effectiveEnvironment(multi(), 'sued-test'), {
        name: 'sued-test', url: 'https://test.sued.example', claude: false, writable: true, production: false,
        signIn: { type: 'none' }, allowHosts: [], insecureTls: false, allowHttp: false, overlay: false,
    });
    assert.equal(effectiveEnvironment(multi(), 'sued-abnahme').writable, false);
    for (const bad of ['west-dev', 'north-dev', 'prod', '']) assert.throws(() => effectiveEnvironment(multi(), bad), CawError, bad);
});

test('navigationHosts: every non-production environment and the allowed hosts, not Anthropic', () => {
    const hosts = navigationHosts({ ...multi(), allowHosts: ['cdn.example'] }, 'nord-dev');
    assert.ok(!hosts.includes('api.anthropic.com'));
    assert.ok(hosts.includes('dev.nord.example'));
    assert.ok(hosts.includes('abnahme.sued.example'));
    assert.ok(hosts.includes('cdn.example'));
    assert.deepEqual(navigationHosts(simple(), 'local'), ['app.localhost', 'staging.shop.example']);
});

const SPEC = { id: 'smoke', app: 'antrag', role: 'kunde', targets: ['nord-dev', 'sued-test'], mutates: false, also: [] };

test('checkTest: valid; without --overlay always the deployed code, even where the overlay would work', () => {
    assert.equal(checkTest(SPEC, 'nord-dev', multi()).source, 'deployed');
    assert.equal(checkTest(SPEC, 'nord-dev', multi(), { overlay: true }).source, 'overlay');
    assert.equal(checkTest(SPEC, 'sued-test', multi()).source, 'deployed');
});

test('checkTest: a role only with a login; with exactly one role it applies', () => {
    const open = withoutAuth();
    const spec = { id: 'offen', app: 'shop', targets: ['local'], mutates: false, also: [] };
    assert.equal(checkTest(spec, 'local', open).source, 'deployed');
    assert.equal(withDefaults(spec, simple()).role, 'kaeufer');
    const two = { ...simple(), roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B' }, admin: { loginEnv: 'C', passwordEnv: 'D' } } };
    assert.throws(() => checkTest(spec, 'local', two), /nennt keine role.*Rollen in caw\.config\.json: kaeufer, admin/);
    assert.throws(() => checkTest({ ...spec, role: 'chef' }, 'local', two), /Unbekannte Rolle: chef \(Rollen in caw\.config\.json: kaeufer, admin\)/);
});

test('which code runs: deployed unless --overlay; if the overlay is not possible, a usage error with the reason', () => {
    const own = { ...simple(), apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { build: 'dist' } } } };
    const spec = { id: 'smoke', mutates: false, also: [] };
    assert.deepEqual(withDefaults(spec, own), { ...spec, app: 'shop', role: 'kaeufer', targets: ['local', 'staging'] }, 'app, role and targets from the config');
    assert.equal(checkTest(spec, 'local', own).source, 'deployed', 'never silently local');
    const build = { kind: 'build', dir: 'dist', statics: [] };
    assert.deepEqual([checkTest(spec, 'local', own, { overlay: true })].map(({ source, apps }) => ({ source, apps })), [{ source: 'overlay', apps: { shop: build } }]);
    assert.deepEqual(checkTest(spec, 'local', own, { overlay: 'build' }).apps.shop, build);
    assert.throws(() => checkTest(spec, 'local', own, { overlay: 'dev' }), (error) => error.code === 'usage' && /--overlay dev geht hier nicht: App shop hat kein overlay\.url\. Sie hat overlay\.build: --overlay build\./.test(error.message));
    assert.deepEqual(checkTest(spec, 'local', own, { overlay: 'http://localhost:5174' }).apps.shop, { kind: 'dev', url: 'http://localhost:5174', statics: [] }, 'a URL needs no config');
    const both = { ...own, apps: { shop: { ...own.apps.shop, overlay: { build: 'dist', url: 'http://localhost:5173', start: 'npm run dev' } } } };
    assert.throws(() => checkTest(spec, 'local', both, { overlay: true }), (error) => error.code === 'usage' && /wähle --overlay build oder --overlay dev/.test(error.message));
    assert.deepEqual(checkTest(spec, 'local', both, { overlay: 'dev' }).apps.shop, { kind: 'dev', url: 'http://localhost:5173', start: 'npm run dev', statics: [] }, 'start is named, never run');
    assert.deepEqual(checkTest(spec, 'local', both, { overlay: 'dev', start: true }).apps.shop, { kind: 'dev', url: 'http://localhost:5173', start: 'npm run dev', command: 'npm run dev', statics: [] }, 'with --start caw may run it');
    const devOnly = { ...own, apps: { shop: { ...own.apps.shop, overlay: { url: 'http://localhost:5173', start: 'npm run dev' } } } };
    assert.deepEqual(checkTest(spec, 'local', devOnly, { overlay: true }).apps.shop, { kind: 'dev', url: 'http://localhost:5173', start: 'npm run dev', statics: [] });
    const withAdmin = { ...both, apps: { ...both.apps, admin: { dir: 'admin', startUrl: '/' } } };
    assert.throws(() => checkTest({ ...spec, app: 'shop', also: ['admin'] }, 'local', withAdmin, { overlay: 'http://localhost:5174' }), (error) => error.code === 'usage' && /gilt für genau eine App, der Test hat shop, admin/.test(error.message));
    assert.deepEqual(Object.keys(checkTest({ ...spec, app: 'shop', also: ['admin'] }, 'local', withAdmin, { overlay: 'dev' }).apps), ['shop'], 'another app without a source stays deployed');
    assert.throws(() => checkTest(spec, 'local', simple(), { overlay: true }), (error) => error.code === 'usage' && /apps\.shop\.overlay\.build/.test(error.message));
    const extjs = { ...simple(), framework: 'extjs' };
    assert.deepEqual(checkTest(spec, 'local', extjs, { overlay: true }).apps.shop, { kind: 'watch', url: 'http://localhost:1841/', statics: [] }, 'ExtJS: the watch at its usual address, without config');
    const extjsAt = { ...extjs, apps: { shop: { ...extjs.apps.shop, overlay: { url: 'http://localhost:1842/', start: 'npm run watch' } } } };
    assert.deepEqual(checkTest(spec, 'local', extjsAt, { overlay: true }).apps.shop, { kind: 'watch', url: 'http://localhost:1842/', start: 'npm run watch', statics: [] });
    assert.deepEqual(checkTest(spec, 'local', extjsAt, { overlay: 'http://localhost:52775/', start: true }).apps.shop,
        { kind: 'watch', url: 'http://localhost:52775/', start: 'npm run watch', command: 'npm run watch', statics: [] }, '--overlay <url> overrides url for ExtJS too');
    assert.throws(() => checkTest(spec, 'local', extjs, { overlay: 'build' }), (error) => error.code === 'usage' && /--overlay build gibt es bei ExtJS nicht/.test(error.message));
    // http on localhost is a dev server: it always runs the own code, an overlay makes no sense. https on *.localhost,
    // however, is a deployed build like any other.
    const at = (url) => ({ ...own, environments: { box: { url, claude: true, overlay: true } } });
    assert.throws(() => checkTest(spec, 'box', at('http://localhost:5173'), { overlay: true }), (error) => error.code === 'usage' && /Umgebung box ist ein Dev-Server \(localhost:5173\)/.test(error.message));
    assert.equal(checkTest(spec, 'box', at('https://shop.localhost:8443'), { overlay: true }).source, 'overlay');
    assert.throws(() => checkTest({ ...spec, targets: ['local'] }, 'staging', own), /Trage staging in targets in caw\/tests\/smoke\.yaml ein/);
    const twoApps = { ...own, apps: { ...own.apps, admin: { dir: 'admin', startUrl: '/' } } };
    assert.throws(() => checkTest(spec, 'local', twoApps), /smoke nennt keine app.*\(shop, admin\)/);
    assert.throws(() => checkTest({ ...spec, app: 'web' }, 'local', twoApps), /Unbekannte App: web \(Apps in caw\.config\.json: shop, admin\)/);
});

test('config: suggestions for typos, notes on settings without effect', () => {
    assert.match(issues({ ...simple(), allowHost: ['x.example'] }), /Unbekanntes Feld: allowHost \(meintest du allowHosts\?\)/);
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', overlya: true } } }), /overlya gibt es dort nicht.*\(meintest du overlay\?\)/);
    assert.doesNotMatch(issues({ ...simple(), zzz: 1 }), /meintest/);
    const claude = { ...simple(), environments: { local: { url: 'http://app.localhost:5173', claude: true, writable: true } } };
    assert.deepEqual(validateConfig(claude), { ok: true, issues: [], notes: [], todo: [] });
    assert.equal(effectiveEnvironment(claude, 'local').claude, true);
    const buildOnly = { ...claude, apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { build: 'dist' } } } };
    assert.match(validateConfig(buildOnly).notes.join('\n'), /App shop hat overlay, aber keine Umgebung hat "overlay": true/);
});

test('overlay config: pattern and statics; without a source on the app only the deployed code', () => {
    const noEntries = { ...multi(), apps: { antrag: { dir: 'app', startUrl: '/a' } } };
    assert.equal(checkTest(SPEC, 'nord-dev', noEntries).source, 'deployed');
    const own = { ...simple(), assetUrlPattern: '/static/js/(.+\\.js)', apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { statics: [{ name: 'main.js', path: 'dist/main.js' }] } } } };
    assert.deepEqual(validateConfig(own).issues, []);
    const { assetUrlPattern, ...withoutPattern } = own;
    assert.deepEqual(validateConfig(withoutPattern).issues, [], 'without a pattern the name is the path under the environment');
    assert.match(issues({ ...own, assetUrlPattern: '/static/js/.+' }), /braucht eine Gruppe/);
    assert.match(issues({ ...own, assetUrlPattern: '(' }), /kein gültiger/);
    const built = buildDevlinkConfig(own, effectiveEnvironment(own, 'local'), 'shop');
    assert.equal(built.assetUrlPattern, assetUrlPattern);
    assert.equal(built.authMarker, '#menu');
    assert.deepEqual(built.projects[0], { uuid: built.projects[0].uuid, name: 'shop', active: true, startUrl: '/shop' }, 'the overlay applies the local code');
});

test('overlay config: url, start, build and statics are checked up front, not during the run', () => {
    const app = (overlay, framework) => issues({ ...simple(), ...(framework === undefined ? {} : { framework }), apps: { shop: { dir: 'shop', startUrl: '/shop', overlay } } });
    assert.equal(app({ build: 'dist/app/browser', url: 'http://localhost:5173', start: 'npm run dev', statics: [{ name: 'a.js', path: 'a.js' }] }), '');
    for (const bad of ['', '/abs', 'C:\\x', '../raus', 3]) assert.match(app({ build: bad }), /overlay\.build muss der relative Pfad/);
    for (const bad of ['localhost:5173', 'ftp://x', 5173]) {
        assert.match(app({ url: bad }), /overlay\.url muss die Adresse des lokalen Code-Servers sein/);
    }
    assert.match(app({ start: 'npm run dev' }), /overlay\.start braucht overlay\.url oder overlay\.build/);
    assert.match(app({ url: 'http://localhost:5173', start: ' ' }), /overlay\.start muss ein Befehl sein/);
    assert.match(app({ devServer: 'http://localhost:5173' }), /unbekanntes Feld overlay\.devServer/);
    assert.match(app({ statics: [{ name: 'x' }] }), /overlay\.statics\[0\] braucht name und path/);
    // .. leaves the app folder (a neighbouring package); whether it stays inside the workspace is checked at run time (static-files).
    assert.equal(app({ statics: [{ name: 'x', path: '../../packages/m/c.js' }] }), '');
    assert.match(app({ statics: [{ name: 'x', path: 'C:/aussen.js' }] }), /overlay\.statics\[0\]/);
    assert.match(app({ statics: 'a.js' }), /overlay\.statics muss eine Liste sein/);
    assert.match(app('dist'), /overlay muss ein Objekt sein/);
    assert.equal(app({ start: 'sencha app watch', statics: [{ name: 'C.js', path: 'c.js' }] }, 'extjs'), '', 'ExtJS: the watch needs no source');
    assert.equal(app({ url: 'http://localhost:1841/', start: 'npm run watch' }, 'extjs'), '', 'ExtJS: the watch at its address, with its start command');
    assert.equal(app({ start: 'npm run watch' }, 'extjs'), '', 'ExtJS: start without url, the watch at its usual address');
    assert.match(app({ url: 'localhost:1841' }, 'extjs'), /overlay\.url muss die Adresse/);
    assert.match(app({ build: 'build' }, 'extjs'), /Bei ExtJS kommt der lokale Code vom Sencha-Watch/);
    assert.match(issues({ ...simple(), apps: { shop: { dir: 'shop', localBuild: 'dist' } } }), /App shop: unbekanntes Feld localBuild\. Eine App kennt dir, startUrl und overlay/);
});

test('overlay: file name from the URL, via assetUrlPattern or as the path under the environment', () => {
    const proxy = 'proxy\\?file=([^&#]*)';
    assert.equal(deriveName('https://p.example/o/proxy?file=Fa/App.js&_dc=1', proxy), 'Fa/App.js');
    assert.equal(deriveName('https://p.example/other.js', proxy), null);
    assert.equal(deriveName('https://shop.example/static/js/main.js?v=3', '/static/js/([^?#]+)'), 'main.js');
    assert.equal(deriveName('https://p.example/o/proxy?file=Fa/App.js', undefined), null, 'nothing without a pattern');
    const under = defaultAssetPattern('https://Shop.Example:443/app/');
    assert.equal(deriveName('https://shop.example/app/assets/index-X1Y2Z3W4.js?v=2', under), 'assets/index-X1Y2Z3W4.js');
    assert.equal(deriveName('https://cdn.example/app/assets/index.js', under), null, 'only the environment');
});

test('assetUrlPattern: a string or a list, one per source; also per app; each entry needs group 1', () => {
    const proxy = '[?&]url=repo:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)';
    const cdn = '^https://cdn\\.example/js/(?:[^?#]*/)?([^/?#]+\\.js)';
    assert.equal(issues({ ...simple(), assetUrlPattern: [proxy, cdn] }), '');
    assert.equal(issues({ ...simple(), apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { assetUrlPattern: cdn } } } }), '');
    assert.match(issues({ ...simple(), assetUrlPattern: [] }), /assetUrlPattern muss ein regulärer Ausdruck sein oder eine Liste davon/);
    assert.match(issues({ ...simple(), assetUrlPattern: [proxy, 3] }), /eine Liste davon/);
    assert.match(issues({ ...simple(), assetUrlPattern: [proxy, '/static/.+'] }), /assetUrlPattern: "\/static\/\.\+" braucht eine Gruppe/);
    assert.match(issues({ ...simple(), apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { assetUrlPattern: '(' } } } }), /apps\.shop\.overlay\.assetUrlPattern: "\(" ist kein gültiger/);
    const both = { ...simple(), assetUrlPattern: proxy, apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { assetUrlPattern: [cdn, proxy] } } } };
    assert.deepEqual(assetPatterns(both, 'shop'), [proxy, cdn], 'the app adds to the top-level list, without duplicates');
    assert.deepEqual(assetPatterns({ assetUrlPattern: [proxy, cdn] }, 'other'), [proxy, cdn]);
    assert.deepEqual(assetPatterns({}, 'shop'), []);
});

test('writeConfig: merges into the file, validates first, writes atomically with 4 spaces; never secrets', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-write-config-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'caw.config.json');
    writeFileSync(file, JSON.stringify({ ...simple(), assetUrlPattern: 'a/([^/]+\\.js)', consoleIgnore: ['x'] }));
    const before = readFileSync(file, 'utf8');
    const invalid = writeConfig(root, { assetUrlPattern: ['('] });
    assert.equal(invalid.ok, false);
    assert.match(invalid.issues.join('\n'), /kein gültiger/);
    assert.equal(readFileSync(file, 'utf8'), before, 'nothing written when invalid');
    const dry = writeConfig(root, { assetUrlPattern: ['a/([^/]+\\.js)', 'b/([^/]+\\.js)'] }, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.config.assetUrlPattern, ['a/([^/]+\\.js)', 'b/([^/]+\\.js)']);
    assert.equal(readFileSync(file, 'utf8'), before, 'dryRun writes nothing');
    const written = writeConfig(root, { assetUrlPattern: ['a/([^/]+\\.js)', 'b/([^/]+\\.js)'], consoleIgnore: null, environments: { staging: { writable: true } } });
    assert.deepEqual(written, { ok: true, issues: [], config: written.config });
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith('{\n    "environments": {') && text.endsWith('}\n'), '4 spaces, trailing newline');
    const saved = JSON.parse(text);
    assert.deepEqual(saved.assetUrlPattern, ['a/([^/]+\\.js)', 'b/([^/]+\\.js)'], 'arrays replace');
    assert.equal(saved.consoleIgnore, undefined, 'null deletes');
    assert.deepEqual(saved.environments.staging, { url: 'https://staging.shop.example', writable: true }, 'objects merge');
    assert.deepEqual(readdirSync(root), ['caw.config.json'], 'no temp file left');
    for (const patch of [{ roles: { kaeufer: { password: 'geheim' } } }, { agent: { token: 'sk' } }, { apiSecret: 'x' }]) {
        const refused = writeConfig(root, patch);
        assert.equal(refused.ok, false);
        assert.match(refused.issues[0], /Geheimnisse gehören nach caw\/\.env/);
    }
    assert.equal(writeConfig(root, { roles: { kaeufer: { loginEnv: 'L2', passwordEnv: 'P2' } }, auth: { passwordSelector: '#pw2' } }).ok, true, 'variable names and selectors are fine');
    assert.equal(writeConfig(mkdtempSync(join(tmpdir(), 'caw-write-none-')), {}).ok, false, 'no config file');
});

test('checkTest: the target must be listed in the test', () => {
    assert.throws(() => checkTest(SPEC, 'nord-test', multi()), /targets/);
});

test('checkTest: unknown app or role', () => {
    assert.throws(() => checkTest({ ...SPEC, app: 'x' }, 'nord-dev', multi()), /App/);
    assert.throws(() => checkTest({ ...SPEC, role: 'x' }, 'nord-dev', multi()), /Rolle/);
});

test('checkTest: mutates is rejected on environments without writable', () => {
    const spec = { ...SPEC, mutates: true, targets: ['nord-dev', 'nord-test', 'nord-abnahme'] };
    assert.equal(checkTest(spec, 'nord-dev', multi()).mutates, true);
    assert.equal(checkTest(spec, 'nord-test', multi()).mutates, true);
    assert.throws(() => checkTest(spec, 'nord-abnahme', multi()), /schreibgeschützt/);
});

test('buildDevlinkConfig: environment and start page, no marker without login', () => {
    const cfg = buildDevlinkConfig(multi(), effectiveEnvironment(multi(), 'nord-dev'), 'antrag');
    assert.equal(cfg.portals[0].url, 'https://dev.nord.example');
    assert.equal(cfg.activePortal, cfg.portals[0].uuid);
    assert.equal(cfg.projects[0].startUrl, '/app#start');
    assert.notEqual(cfg.projects[0].uuid, cfg.portals[0].uuid);
    const open = withoutAuth();
    assert.equal(buildDevlinkConfig(open, effectiveEnvironment(open, 'local'), 'shop').authMarker, null);
});

test('navigationHosts: production only if the run itself is on production, not even via allowHosts', () => {
    const config = { ...simple(), environments: { ...simple().environments, live: { url: 'https://www.shop.example', production: true } }, allowHosts: ['www.shop.example', 'sso.example'] };
    assert.deepEqual(validateConfig(config).issues, []);
    const onLocal = navigationHosts(config, 'local');
    assert.ok(!onLocal.includes('www.shop.example'), 'not even via allowHosts');
    assert.ok(onLocal.includes('sso.example') && onLocal.includes('staging.shop.example'));
    assert.ok(navigationHosts(config, 'live').includes('www.shop.example'));
    assert.ok(!navigationHosts(config).includes('www.shop.example'));
});

test('production: also detected as part of a name, explicit false allowed', () => {
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    for (const name of ['prod-de', 'live-eu', 'prd2', 'produktiv-at']) assert.match(at({ [name]: { url: 'https://www.shop.example', claude: true } }), /sieht nach Produktion aus/, name);
    assert.equal(at({ 'live-preview': { url: 'https://preview.shop.example', production: false, claude: true } }), '');
    assert.equal(at({ delivery: { url: 'https://d.shop.example' } }), '', 'no match in the middle of a word');
});

test('production: the exact names cannot be bypassed with false', () => {
    assert.match(issues({ ...simple(), environments: { ...simple().environments, prod: { url: 'https://www.shop.example', production: false, claude: true } } }), /dem Namen nach Produktion/);
});

test('config: broken values lead to messages, not crashes', () => {
    assert.match(validateConfig(null).issues.join(), /JSON-Objekt/);
    assert.match(issues({ ...simple(), apps: { web: null } }), /App web muss ein Objekt sein/);
    assert.match(issues({ ...simple(), consoleIgnore: 'foo' }), /consoleIgnore muss eine Liste/);
    assert.match(issues({ ...simple(), sandboxImage: 'node:22\nRUN curl x' }), /Image-Referenz/);
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', roles: {} } } }), /roles gibt es dort nicht/);
    const open = withoutAuth();
    assert.match(issues({ ...open, roles: {} }), /Ohne Anmeldung \(auth\) lass roles weg/);
    assert.match(issues({ ...simple(), auth: { ...simple().auth, path: 'https://sso.example/login' } }), /allowHosts/);
});

test('config: browser picks a Chromium browser, default Chrome', async () => {
    const { browserLaunch } = await import('../src/shared/config.mjs');
    assert.deepEqual(browserLaunch({}), { channel: 'chrome' });
    assert.deepEqual(browserLaunch({ browser: { channel: 'msedge' } }), { channel: 'msedge' });
    assert.deepEqual(browserLaunch({ browser: { executablePath: '/opt/chromium/chrome' } }), { executablePath: '/opt/chromium/chrome' });
    assert.equal(issues({ ...simple(), browser: { channel: 'msedge' } }), '');
    assert.match(issues({ ...simple(), browser: { channel: 'firefox' } }), /browser.channel muss einer von/);
    assert.match(issues({ ...simple(), browser: { executablePath: 'chrome.exe' } }), /absoluter Pfad/);
    assert.match(issues({ ...simple(), browser: 'edge' }), /browser muss ein Objekt sein/);
});

test('config: the fields of a role are checked up front, not during the run', () => {
    const role = (fields) => issues({ ...simple(), roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B', ...fields } } });
    assert.equal(role({ totpEnv: 'TOTP_SECRET' }), '');
    assert.match(role({ passwortEnv: 'X' }), /unbekanntes Feld passwortEnv/);
    assert.match(role({ totpEnv: 7 }), /totpEnv muss der Name einer Variable/);
    assert.match(role({ loginEnv: 'mit leerzeichen' }), /loginEnv muss der Name einer Variable/);
});
