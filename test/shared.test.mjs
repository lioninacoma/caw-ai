import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { allTargets, assetPatterns, browserHosts, buildDevlinkConfig, defaultAssetPattern, effectiveConfig, environmentsWith, resolveTarget, validateConfig, writeConfig } from '../src/shared/config.mjs';
import { deriveName } from '../src/host/overlay.mjs';
import { checkTest, withDefaults } from '../src/host/test-file.mjs';
import { CawError } from '../src/shared/errors.mjs';

// A fragment for `extends` lives in the project; here in its own folder, with an absolute path.
const fragmentDir = mkdtempSync(join(tmpdir(), 'caw-fragment-'));
const FRAGMENT = join(fragmentDir, 'basis.json');
writeFileSync(FRAGMENT, JSON.stringify({
    environments: {
        dev: { urls: { nord: 'https://dev.nord.example', sued: 'https://dev.sued.example', west: 'https://dev.west.example' }, claude: true, overlay: true, writable: true },
        test: { urls: { nord: 'https://test.nord.example', sued: 'https://test.sued.example' }, writable: true },
        abnahme: { urls: { nord: 'https://abnahme.nord.example', sued: 'https://abnahme.sued.example' } },
    },
    auth: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: 'body.signed-in' },
    assetUrlPattern: 'proxy\\?file=([^&#]*)',
}));

// Several sites with their own URLs, environments from the fragment.
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

test('valid configs: flat, with sites, without login, with a stored session', () => {
    assert.deepEqual(validateConfig(multiRaw()).issues, []);
    assert.deepEqual(validateConfig(simple()).issues, []);
    const open = withoutAuth();
    assert.deepEqual(validateConfig(open).issues, [], 'without auth: no login, no roles needed');
    assert.deepEqual(validateConfig({ ...simple(), auth: { type: 'storageState', path: '/', signedInSelector: '#menu' }, roles: { kaeufer: {} } }).issues, []);
    assert.deepEqual(validateConfig({ ...simple(), auth: { type: 'basic' } }).issues, []);
    const twoFactor = { ...simple(), auth: { ...simple().auth, codeSelector: '#code' }, roles: { kaeufer: { loginEnv: 'A', passwordEnv: 'B', totpEnv: 'C' } } };
    assert.deepEqual(validateConfig(twoFactor).issues, [], 'a one-time code after the password');
});

test('config: unknown fields are errors, names from earlier versions say where they went', () => {
    assert.match(issues({ ...simple(), gibtsnicht: 1 }), /Unbekanntes Feld: gibtsnicht/);
    assert.equal(issues({ ...simple(), stages: 1 }), 'stages gibt es seit 0.3.0 nicht mehr (stattdessen: environments), siehe docs/upgrading.md');
    assert.equal(issues({ ...simple(), ui: 1 }), 'ui gibt es seit 0.3.0 nicht mehr, siehe docs/upgrading.md');
    for (const key of ['portals', 'login', 'preset']) assert.match(issues({ ...simple(), [key]: 1 }), new RegExp(`^${key} gibt es seit 0\\.3\\.0 nicht mehr \\(stattdessen: `));
    // All old keys of an environment and an app at once, each with its new place.
    const old = simple();
    old.environments.local = { ...old.environments.local, agent: true, localCode: true };
    delete old.environments.local.claude;
    old.apps.shop = { ...old.apps.shop, statics: [], redirects: {}, constants: {} };
    assert.deepEqual(validateConfig(old).issues, [
        'environments.local.agent heißt seit 0.3.0 claude, siehe docs/upgrading.md',
        'environments.local.localCode heißt seit 0.3.0 overlay, siehe docs/upgrading.md',
        'apps.shop.statics heißt seit 0.3.0 apps.shop.overlay.statics, siehe docs/upgrading.md',
        'apps.shop.redirects gibt es seit 0.3.0 nicht mehr, siehe docs/upgrading.md',
        'apps.shop.constants gibt es seit 0.3.0 nicht mehr, siehe docs/upgrading.md',
    ]);
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

test('config: required fields, login per type, fragment only as a file in the project', () => {
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

test('config: the fragment sets defaults, the project wins, environments merged by name', () => {
    const { config } = effectiveConfig({ ...multiRaw(), auth: { ...multi().auth, signedInSelector: '#eigen' }, environments: { test: { writable: false } } });
    assert.equal(config.auth.signedInSelector, '#eigen');
    assert.equal(config.environments.dev.urls.nord, 'https://dev.nord.example');
    assert.equal(config.environments.test.writable, false);
    assert.equal(config.environments.test.urls.sued, 'https://test.sued.example');
});

test('sites: target site/environment, only sites from sites', () => {
    assert.deepEqual(allTargets(multi()), ['nord/dev', 'sued/dev', 'nord/test', 'sued/test', 'nord/abnahme', 'sued/abnahme']);
    assert.match(issues({ ...multiRaw(), sites: ['ost'] }), /Mandant ost hat in keiner Umgebung eine Adresse/);
    assert.match(issues({ ...simple(), sites: ['nord'] }), /Mit sites steht die Adresse je Mandant in urls/);
    assert.match(issues({ ...simple(), environments: { dev: { urls: { a: 'https://a.example' } } } }), /urls gibt es nur mit sites/);
});

test('environments: capabilities from the config, production only explicitly and without Claude', () => {
    assert.deepEqual(environmentsWith(multi(), 'agent'), ['dev']);
    assert.deepEqual(environmentsWith(multi(), 'writable'), ['dev', 'test']);
    assert.deepEqual(environmentsWith(simple(), 'overlay'), ['local']);
    assert.equal(resolveTarget(simple(), 'local').agent, true);
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

test('resolveTarget returns URL and capabilities', () => {
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

test('resolveTarget rejects: unknown, not in sites, malformed', () => {
    for (const bad of ['west/dev', 'nord/prod', 'x/dev', 'nord', 'nord/dev/x']) {
        assert.throws(() => resolveTarget(multi(), bad), CawError, bad);
    }
    for (const bad of ['nord/local', 'prod', '']) assert.throws(() => resolveTarget(simple(), bad), CawError, bad);
});

test('browserHosts takes only URLs of the sites and own exceptions, not Anthropic', () => {
    const hosts = browserHosts({ ...multi(), extraAllowedHosts: ['cdn.example'] });
    assert.ok(!hosts.includes('api.anthropic.com'));
    assert.ok(hosts.includes('dev.nord.example'));
    assert.ok(hosts.includes('abnahme.sued.example'));
    assert.ok(hosts.includes('cdn.example'));
    assert.ok(!hosts.some((h) => h.includes('west')));
    assert.deepEqual(browserHosts(simple()), ['app.localhost', 'staging.shop.example']);
});

const SPEC = { id: 'smoke', app: 'antrag', role: 'kunde', targets: ['nord/dev', 'sued/test'], mutates: false, also: [] };

test('checkTest: valid; without --overlay always the deployed code, even where the overlay would work', () => {
    assert.equal(checkTest(SPEC, 'nord/dev', multi()).source, 'deployed');
    assert.equal(checkTest(SPEC, 'nord/dev', multi(), { overlay: true }).source, 'overlay');
    assert.equal(checkTest(SPEC, 'sued/test', multi()).source, 'deployed');
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
    assert.throws(() => checkTest(spec, 'local', own, { overlay: 'dev' }), (error) => error.code === 'usage' && /--overlay dev geht hier nicht: App shop hat kein overlay\.dev\. Sie hat overlay\.build: --overlay build\./.test(error.message));
    assert.deepEqual(checkTest(spec, 'local', own, { overlay: 'http://localhost:5174' }).apps.shop, { kind: 'dev', url: 'http://localhost:5174', statics: [] }, 'a URL needs no config');
    const both = { ...own, apps: { shop: { ...own.apps.shop, overlay: { build: 'dist', dev: 'http://localhost:5173', devCommand: 'npm run dev' } } } };
    assert.throws(() => checkTest(spec, 'local', both, { overlay: true }), (error) => error.code === 'usage' && /wähle --overlay build oder --overlay dev/.test(error.message));
    assert.deepEqual(checkTest(spec, 'local', both, { overlay: 'dev' }).apps.shop, { kind: 'dev', url: 'http://localhost:5173', command: 'npm run dev', statics: [] });
    const withAdmin = { ...both, apps: { ...both.apps, admin: { dir: 'admin', startUrl: '/' } } };
    assert.throws(() => checkTest({ ...spec, app: 'shop', also: ['admin'] }, 'local', withAdmin, { overlay: 'http://localhost:5174' }), (error) => error.code === 'usage' && /gilt für genau eine App, der Test hat shop, admin/.test(error.message));
    assert.deepEqual(Object.keys(checkTest({ ...spec, app: 'shop', also: ['admin'] }, 'local', withAdmin, { overlay: 'dev' }).apps), ['shop'], 'another app without a source stays deployed');
    assert.throws(() => checkTest(spec, 'local', simple(), { overlay: true }), (error) => error.code === 'usage' && /apps\.shop\.overlay\.build/.test(error.message));
    const extjs = { ...simple(), framework: 'extjs' };
    assert.deepEqual(checkTest(spec, 'local', extjs, { overlay: true }).apps.shop, { kind: 'watch', statics: [] }, 'ExtJS: the watch, without config');
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
    assert.match(issues({ ...simple(), insecureTLS: true }), /Unbekanntes Feld: insecureTLS \(meintest du insecureTls\?\)/);
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', overlya: true } } }), /overlya gibt es dort nicht.*\(meintest du overlay\?\)/);
    assert.doesNotMatch(issues({ ...simple(), zzz: 1 }), /meintest/);
    assert.match(issues({ ...simple(), extraAllowedHosts: ['https://login.example.com/'] }), /"https:\/\/login\.example\.com\/" ist kein Hostname; gemeint ist wohl "login\.example\.com"/);
    assert.match(issues({ ...simple(), extraAllowedHosts: ['a b'] }), /"a b" ist kein Hostname, etwa/);
    const claude = { ...simple(), environments: { local: { url: 'http://app.localhost:5173', claude: true, writable: true } } };
    assert.deepEqual(validateConfig(claude), { ok: true, issues: [], notes: [], todo: [] });
    assert.equal(resolveTarget(claude, 'local').agent, true);
    // No legacy name any more: agent on an environment is an error, with the hint on its new name.
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', agent: true } } }), /environments\.local\.agent heißt seit 0\.3\.0 claude/);
    const buildOnly = { ...claude, apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { build: 'dist' } } } };
    assert.match(validateConfig(buildOnly).notes.join('\n'), /App shop hat overlay, aber keine Umgebung hat "overlay": true/);
});

test('overlay config: pattern and statics; without a source on the app only the deployed code', () => {
    const noEntries = { ...multi(), apps: { antrag: { dir: 'app', startUrl: '/a' } } };
    assert.equal(checkTest(SPEC, 'nord/dev', noEntries).source, 'deployed');
    const own = { ...simple(), assetUrlPattern: '/static/js/(.+\\.js)', apps: { shop: { dir: 'shop', startUrl: '/shop', overlay: { statics: [{ name: 'main.js', path: 'dist/main.js' }] } } } };
    assert.deepEqual(validateConfig(own).issues, []);
    const { assetUrlPattern, ...withoutPattern } = own;
    assert.deepEqual(validateConfig(withoutPattern).issues, [], 'without a pattern the name is the path under the environment');
    assert.match(issues({ ...own, assetUrlPattern: '/static/js/.+' }), /braucht eine Gruppe/);
    assert.match(issues({ ...own, assetUrlPattern: '(' }), /kein gültiger/);
    const built = buildDevlinkConfig(own, resolveTarget(own, 'local'), 'shop');
    assert.equal(built.assetUrlPattern, assetUrlPattern);
    assert.equal(built.authMarker, '#menu');
    assert.deepEqual(built.projects[0], { uuid: built.projects[0].uuid, name: 'shop', active: true, startUrl: '/shop' }, 'the overlay applies the local code');
});

test('overlay config: build, dev, commands and statics are checked up front, not during the run', () => {
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
    assert.equal(app({ devCommand: 'sencha app watch', statics: [{ name: 'C.js', path: 'c.js' }] }, 'extjs'), '', 'ExtJS: the watch needs no source');
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
    assert.throws(() => checkTest(SPEC, 'nord/test', multi()), /targets/);
});

test('checkTest: unknown app or role', () => {
    assert.throws(() => checkTest({ ...SPEC, app: 'x' }, 'nord/dev', multi()), /App/);
    assert.throws(() => checkTest({ ...SPEC, role: 'x' }, 'nord/dev', multi()), /Rolle/);
});

test('checkTest: mutates is rejected on environments without writable', () => {
    const spec = { ...SPEC, mutates: true, targets: ['nord/dev', 'nord/test', 'nord/abnahme'] };
    assert.equal(checkTest(spec, 'nord/dev', multi()).mutates, true);
    assert.equal(checkTest(spec, 'nord/test', multi()).mutates, true);
    assert.throws(() => checkTest(spec, 'nord/abnahme', multi()), /schreibgeschützt/);
});

test('buildDevlinkConfig: environment and start page, no marker without login', () => {
    const cfg = buildDevlinkConfig(multi(), resolveTarget(multi(), 'nord/dev'), 'antrag');
    assert.equal(cfg.portals[0].url, 'https://dev.nord.example');
    assert.equal(cfg.activePortal, cfg.portals[0].uuid);
    assert.equal(cfg.projects[0].startUrl, '/app#start');
    assert.notEqual(cfg.projects[0].uuid, cfg.portals[0].uuid);
    const open = withoutAuth();
    assert.equal(buildDevlinkConfig(open, resolveTarget(open, 'local'), 'shop').authMarker, null);
});

test('browserHosts: production only if the run itself targets it', () => {
    const config = { ...simple(), environments: { ...simple().environments, live: { url: 'https://www.shop.example', production: true } }, extraAllowedHosts: ['www.shop.example', 'sso.example'] };
    assert.deepEqual(validateConfig(config).issues, []);
    const onLocal = browserHosts(config, resolveTarget(config, 'local'));
    assert.ok(!onLocal.includes('www.shop.example'), 'not even via extraAllowedHosts');
    assert.ok(onLocal.includes('sso.example') && onLocal.includes('staging.shop.example'));
    assert.ok(browserHosts(config, resolveTarget(config, 'live')).includes('www.shop.example'));
    assert.ok(!browserHosts(config).includes('www.shop.example'));
});

test('production: also detected as part of a name, explicit false allowed', () => {
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    for (const name of ['prod-de', 'live_eu', 'prd2', 'produktiv-at']) assert.match(at({ [name]: { url: 'https://www.shop.example', claude: true } }), /sieht nach Produktion aus/, name);
    assert.equal(at({ 'live-preview': { url: 'https://preview.shop.example', production: false, claude: true } }), '');
    assert.equal(at({ delivery: { url: 'https://d.shop.example' } }), '', 'no match in the middle of a word');
    assert.match(issues({ ...multiRaw(), sites: ['nord', 'live'] }), /Mandant live sieht nach Produktion aus/);
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
    assert.match(issues({ ...simple(), auth: { ...simple().auth, path: 'https://sso.example/login' } }), /extraAllowedHosts/);
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
