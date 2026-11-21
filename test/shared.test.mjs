import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assetPatterns, buildDevlinkConfig, defaultAssetPattern, environmentsWith, navigationHosts, validateConfig, writeConfig } from '../src/shared/config.mjs';
import { agentHosts, blockedHosts, effectiveEnvironment, startPath } from '../src/shared/environments.mjs';
import { deriveName } from '../src/ext/overlay/overlay.mjs';
import { checkTest, withDefaults } from '../src/host/test-file.mjs';
import { CawError } from '../src/shared/errors.mjs';

// Tenants as environments: the south ones extend the north ones and only change the address.
const multiRaw = () => ({
    environments: {
        'nord-dev': { url: 'https://dev.nord.example', agent: true, writable: true },
        'sued-dev': { extends: 'nord-dev', url: 'https://dev.sued.example' },
        'nord-test': { url: 'https://test.nord.example', writable: true },
        'sued-test': { extends: 'nord-test', url: 'https://test.sued.example' },
        'nord-abnahme': { url: 'https://abnahme.nord.example' },
        'sued-abnahme': { extends: 'nord-abnahme', url: 'https://abnahme.sued.example' },
    },
    signIn: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: 'body.signed-in' },
    start: '/app#start',
    overlay: {
        environments: ['nord-dev', 'sued-dev'],
        assetUrlPattern: 'proxy\\?file=([^&#]*)',
        parts: { antrag: { dir: 'projects/apps/App', statics: [{ name: 'Fa/Const.js', path: 'const.js' }] } },
    },
    roles: { kunde: {} },
});
const multi = multiRaw;

// The usual case: one application, a few environments, flat.
const simple = () => ({
    environments: {
        local: { url: 'https://app.localhost:8443', agent: true, writable: true },
        staging: { url: 'https://staging.shop.example' },
    },
    signIn: { type: 'form', path: '/anmelden', userSelector: '#mail', passwordSelector: '#pw', submitSelector: 'button[type=submit]', signedInSelector: '#menu' },
    start: '/shop',
    roles: { kaeufer: {} },
});

// The simple config without sign-in: no signIn (type none), no roles.
const withoutAuth = () => {
    const config = simple();
    delete config.signIn;
    delete config.roles;
    return config;
};

const issues = (config) => validateConfig(config).issues.join('\n');

test('valid configs: flat, tenants as environments, without login, with a stored session', () => {
    assert.deepEqual(validateConfig(multiRaw()).issues, []);
    assert.deepEqual(validateConfig(simple()).issues, []);
    const open = withoutAuth();
    assert.deepEqual(validateConfig(open).issues, [], 'without signIn: no sign-in, no roles needed');
    assert.deepEqual(validateConfig({ ...simple(), signIn: { type: 'session', path: '/', signedInSelector: '#menu' }, roles: { kaeufer: {} } }).issues, []);
    assert.deepEqual(validateConfig({ ...simple(), signIn: { type: 'basic' } }).issues, []);
    const twoFactor = { ...simple(), signIn: { ...simple().signIn, codeSelector: '#code' }, roles: { kaeufer: {} } };
    assert.deepEqual(validateConfig(twoFactor).issues, [], 'a one-time code after the password');
});

test('config: unknown fields are errors', () => {
    assert.match(issues({ ...simple(), gibtsnicht: 1 }), /Unbekanntes Feld: gibtsnicht/);
});

test('config: TODO from init is a gap, not an error; doctor and validate list it', () => {
    const todo = { ...simple(), signIn: { ...simple().signIn, path: 'TODO', signedInSelector: 'TODO' } };
    const result = validateConfig(todo);
    assert.deepEqual(result.issues, [], 'a TODO path is not reported as a wrong path');
    assert.deepEqual(result.todo, ['signIn.path', 'signIn.signedInSelector']);
    const perEnv = { ...simple(), environments: { ...simple().environments, staging: { url: 'https://staging.shop.example', signIn: { type: 'session', signedInSelector: 'TODO' } } } };
    assert.deepEqual(validateConfig(perEnv).todo, ['environments.staging.signIn.signedInSelector']);
    assert.deepEqual(validateConfig(simple()).todo, []);
});

test('config: browser.locale, browser.timezone and readyIgnore', () => {
    assert.equal(issues({ ...simple(), browser: { locale: 'de-DE', timezone: 'Europe/Berlin' }, readyIgnore: ['.uhr', '#ticker'] }), '');
    assert.match(issues({ ...simple(), browser: { locale: 'kein locale!' } }), /browser\.locale muss ein Sprachkürzel sein/);
    assert.match(issues({ ...simple(), browser: { locale: 7 } }), /browser\.locale/);
    assert.match(issues({ ...simple(), browser: { timezone: 'Mars/Olympus' } }), /browser\.timezone muss eine Zeitzone sein/);
    assert.match(issues({ ...simple(), browser: { zone: 'UTC' } }), /browser\.zone gibt es nicht \(erlaubt: channel, executablePath, locale, timezone, viewport, noSandbox\)/);
    assert.equal(issues({ ...simple(), browser: { viewport: { width: 1280, height: 800 } } }), '');
    for (const viewport of [{ width: 100, height: 800 }, { width: 1280 }, { width: 1280.5, height: 800 }, { width: 1280, height: 800, scale: 2 }, '1280x800']) {
        assert.match(issues({ ...simple(), browser: { viewport } }), /browser\.viewport muss \{ "width": 320–7680, "height": 240–4320 \}/, JSON.stringify(viewport));
    }
    // Removed before 1.0, named with what replaced it.
    assert.equal(issues({ ...simple(), language: 'fr' }), '', 'any team language');
    for (const source of ['.', 'frontend', false]) assert.equal(issues({ ...simple(), source }), '', String(source));
    for (const source of ['/abs', '../other', true, '']) assert.match(issues({ ...simple(), source }), /source muss der relative Pfad/, String(source));
    for (const language of ['Deutsch', 'de-DE', 7]) assert.match(issues({ ...simple(), language }), /ist kein Sprachkürzel/, String(language));
    assert.match(issues({ ...simple(), maxSteps: 50 }), /maxSteps heißt jetzt maxActions/);
    assert.equal(issues({ ...simple(), maxActions: 50 }), '');
    assert.match(issues({ ...simple(), maxActions: 0 }), /maxActions muss eine positive ganze Zahl sein/);
    assert.match(issues({ ...simple(), readyIgnore: '.uhr' }), /readyIgnore muss eine Liste von CSS-Selektoren sein/);
    assert.match(issues({ ...simple(), readyIgnore: [''] }), /readyIgnore/);
    // effects.fail names effect lists; view lines are none.
    assert.equal(issues({ ...simple(), effects: { fail: ['controls', 'requests', 'responses', 'console'] } }), '');
    assert.match(issues({ ...simple(), effects: { fail: ['controls', 'view'] } }), /effects\.fail muss eine Liste aus controls, requests, responses, console sein/);
});

test('config: required fields, login per type', () => {
    assert.match(issues({}), /environments fehlt/);
    assert.doesNotMatch(issues({}), /start/, 'start has a default');
    assert.match(issues({ ...simple(), signIn: { type: 'form', path: '/login' } }), /signIn \(form\) braucht signedInSelector, userSelector, passwordSelector, oder steps/);
    assert.match(issues({ ...simple(), signIn: { ...simple().signIn, path: 'ohne-slash' } }), /signIn\.path ist ein Pfad auf der Umgebung/);
    assert.match(issues({ ...simple(), signIn: { type: 'sso' } }), /signIn\.type muss eins von none, form, basic, session sein/);
    assert.match(issues({ ...simple(), signIn: { type: 'basic', userSelector: '#u' } }), /signIn \(basic\): userSelector ist dort nicht erlaubt/);
    assert.match(issues({ ...simple(), roles: undefined }), /roles fehlt/);
    assert.match(issues({ ...simple(), signIn: { type: 'session' } }), /signIn \(session\) braucht signedInSelector/);
    // Per environment: a session on staging, form on local; roles stay required.
    const mixed = { ...simple(), environments: { ...simple().environments, staging: { url: 'https://staging.shop.example', signIn: { type: 'session', signedInSelector: '#menu' } } } };
    assert.equal(issues(mixed), '');
    assert.match(issues({ ...mixed, environments: { ...mixed.environments, staging: { url: 'https://staging.shop.example', signIn: 'form' } } }), /environments\.staging\.signIn muss ein Objekt mit type sein/);
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
    // The overlay moved into its own block.
    assert.match(issues({ ...simple(), environments: { local: { url: 'https://app.localhost:8443', overlay: true } } }), /environments\.local\.overlay heißt jetzt overlay\.environments/);
    assert.match(issues({ ...simple(), assetUrlPattern: 'a/(.+)' }), /assetUrlPattern heißt jetzt overlay\.assetUrlPattern/);
    // One application per project: apps went, its start path is the top-level start.
    assert.match(issues({ ...simple(), apps: { shop: { dir: 'shop', startUrl: '/shop' } } }), /apps gibt es nicht mehr: eine Anwendung je Projekt: ihr Startpfad ist "start"/);
    for (const bad of ['shop', '//cdn.example/x', 3, '']) assert.match(issues({ ...simple(), start: bad }), /start muss ein Pfad sein, der mit \/ beginnt/, String(bad));
    for (const good of ['/', '/app#orders', '/shop?tab=2']) assert.equal(issues({ ...simple(), start: good }), '', good);
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    assert.match(at({ sued: { extends: 'nord', url: 'https://s.example' } }), /extends "nord" ist keine Umgebung/);
    assert.match(at({ a: { extends: 'b', url: 'https://a.example' }, b: { extends: 'a', url: 'https://b.example' } }), /extends läuft im Kreis: a → b → a/);
    assert.match(at({ kopie: { extends: 'staging' } }), /^$/, 'the url comes through extends');
    assert.match(at({ leer: { agent: true } }), /Umgebung leer hat keine url/);
    assert.match(at({ nord_dev: { url: 'https://n.example' } }), /Umgebung "nord_dev": Kleinbuchstaben, Ziffern und -/);
    // A production child must say so itself; a non-production environment on a production host is refused.
    assert.match(at({ live: { url: 'https://www.shop.example', production: true }, kopie: { extends: 'live', url: 'https://www.shop.example' } }), /Umgebung kopie nutzt den Host www\.shop\.example der Produktionsumgebung live/);
    assert.equal(effectiveEnvironment(multi(), 'sued-dev').agent, true);
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
    assert.deepEqual(environmentsWith(multi(), 'agent'), ['nord-dev', 'sued-dev']);
    assert.deepEqual(environmentsWith(multi(), 'writable'), ['nord-dev', 'sued-dev', 'nord-test', 'sued-test']);
    assert.equal(effectiveEnvironment(simple(), 'local').agent, true);
    const at = (environments) => issues({ ...simple(), environments: { ...simple().environments, ...environments } });
    assert.match(at({ prod: { url: 'https://www.shop.example' } }), /Produktion/);
    assert.match(at({ live: { url: 'https://www.shop.example', production: true, agent: true } }), /Produktion: agent/);
    assert.equal(at({ live: { url: 'https://www.shop.example', production: true } }), '');
    assert.match(at({ local: { url: 'http://app.localhost:5173', agent: 'ja' } }), /agent muss true oder false sein/);
    assert.match(at({ local: { url: 'http://app.localhost:5173', stage: 'x' } }), /stage gibt es dort nicht/);
});

test('config: http only on the own machine (localhost, 127.0.0.1, *.localhost), e.g. for a local Vite server', async () => {
    const at = (url) => issues({ ...simple(), environments: { local: { url } } });
    for (const url of ['http://app.localhost:5173', 'https://app.localhost:5173', 'http://localhost:5173', 'http://127.0.0.1:5173']) assert.equal(at(url), '', url);
    assert.match(at('http://dev.shop.example'), /http nur auf dem eigenen Rechner.*sonst https/);
    assert.match(at('http://127.0.0.2:5173'), /sonst https/, 'only exactly 127.0.0.1');
    assert.match(at('http://app.localhost:5173/pfad'), /nur der Origin, ohne Pfad/);
    assert.match(at('https://preview.shop.example/'), /ohne \/ am Ende \(https:\/\/preview\.shop\.example\)/);
});

test('a part\'s folder must be relative to and inside the project', () => {
    const withDir = (dir) => {
        const config = multiRaw();
        config.overlay.parts.antrag.dir = dir;
        return issues(config);
    };
    for (const dir of [undefined, '', '/abs', 'C:\\x', '../raus', 'a/../../b']) assert.match(withDir(dir), /overlay\.parts\.antrag\.dir muss der relative Pfad/, String(dir));
    assert.equal(withDir('a/b'), '');
});

test('consoleIgnore must contain valid regular expressions', () => {
    assert.match(issues({ ...simple(), consoleIgnore: ['('] }), /consoleIgnore/);
});

test('effectiveEnvironment returns URL and capabilities; unknown names are rejected', () => {
    assert.deepEqual(effectiveEnvironment(multi(), 'sued-test'), {
        name: 'sued-test', url: 'https://test.sued.example', agent: false, writable: true, production: false,
        signIn: multi().signIn, allowHosts: [], thirdPartyHosts: [], insecureTls: false, allowHttp: false, ready: { path: '/', timeoutMs: 60000 },
    });
    const own = { ...multi(), environments: { ...multi().environments, 'sued-test': { extends: 'nord-test', url: 'https://test.sued.example', signIn: { type: 'none' } } } };
    assert.deepEqual(effectiveEnvironment(own, 'sued-test').signIn, { type: 'none' }, 'an environment\'s own signIn replaces the top-level one');
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

test('agentHosts: navigation hosts plus thirdPartyHosts (top level and the environment\'s), never production; hosts normalized', () => {
    const config = {
        ...simple(),
        environments: { ...simple().environments, local: { ...simple().environments.local, thirdPartyHosts: ['Fonts.Example.'] }, live: { url: 'https://Shop.Example./', production: true } },
        allowHosts: ['SSO.example'],
        thirdPartyHosts: ['cdn.example', 'shop.example'],
    };
    assert.deepEqual(agentHosts(config, 'local'), ['app.localhost', 'staging.shop.example', 'sso.example', 'cdn.example', 'fonts.example']);
    assert.deepEqual(blockedHosts(config, 'local'), ['shop.example'], 'a trailing dot or upper case in the URL does not slip past the block');
    assert.ok(!agentHosts(config, 'staging').includes('fonts.example'), 'another environment\'s list does not count');
});

const SPEC = { id: 'smoke', role: 'kunde', environments: ['nord-dev', 'sued-test'], writes: false };

test('checkTest: valid; without --overlay always the deployed code, even where the overlay would work', () => {
    assert.equal(checkTest(SPEC, 'nord-dev', multi()).source, 'deployed');
    assert.equal(checkTest(SPEC, 'nord-dev', multi(), { overlay: true }).source, 'overlay');
    assert.equal(checkTest(SPEC, 'sued-test', multi()).source, 'deployed');
});

test('checkTest: a role only with a login; with exactly one role it applies', () => {
    const open = withoutAuth();
    const spec = { id: 'offen', environments: ['local'], writes: false };
    assert.equal(checkTest(spec, 'local', open).source, 'deployed');
    assert.equal(withDefaults(spec, simple()).role, 'kaeufer');
    const two = { ...simple(), roles: { kaeufer: {}, admin: {} } };
    assert.throws(() => checkTest(spec, 'local', two), /offen nennt keine role, und caw\.config\.json hat mehrere \(kaeufer, admin\)/);
    assert.throws(() => checkTest({ ...spec, role: 'chef' }, 'local', two), /Unbekannte Rolle: chef \(Rollen in caw\.config\.json: kaeufer, admin\)/);
});

test('which code runs: deployed unless --overlay; if the overlay is not possible, a usage error with the reason', () => {
    const withParts = (parts, extra = {}) => ({ ...simple(), ...extra, overlay: { environments: ['local'], parts } });
    const own = withParts({ shop: { dir: 'shop', build: 'dist' } });
    const spec = { id: 'smoke', writes: false };
    const code = (config, overlay, options = {}) => {
        const { source, parts, skipped } = checkTest(spec, 'local', config, { overlay, ...options });
        return { source, parts, skipped };
    };
    assert.deepEqual(withDefaults(spec, own), { ...spec, role: 'kaeufer', runsOn: ['local', 'staging'] }, 'role and where it runs from the config; environments stay unwritten');
    assert.equal(checkTest(spec, 'local', own).source, 'deployed', 'never silently local');
    const build = { kind: 'build', dir: 'dist', statics: [] };
    assert.deepEqual(code(own, true), { source: 'overlay', parts: { shop: build }, skipped: [] });
    assert.deepEqual(code(own, 'build').parts.shop, build);
    assert.throws(() => code(own, 'dev'), (error) => error.code === 'usage' && /--overlay dev geht hier nicht: Teil shop hat kein url\. Er hat build: --overlay=shop:build\./.test(error.message));
    assert.deepEqual(code(own, 'http://localhost:5174').parts.shop, { kind: 'dev', url: 'http://localhost:5174', statics: [] }, 'a URL needs no config');
    const both = withParts({ shop: { dir: 'shop', build: 'dist', url: 'http://localhost:5173', start: 'npm run dev' } });
    assert.throws(() => code(both, true), (error) => error.code === 'usage' && /wähle --overlay=shop:build oder --overlay=shop:dev/.test(error.message));
    assert.deepEqual(code(both, 'dev').parts.shop, { kind: 'dev', url: 'http://localhost:5173', start: 'npm run dev', statics: [] }, 'start is named, never run');
    assert.deepEqual(code(both, 'dev', { start: true }).parts.shop, { kind: 'dev', url: 'http://localhost:5173', start: 'npm run dev', command: 'npm run dev', statics: [] }, 'with --start caw may run it');
    assert.deepEqual(code(both, 'shop:build').parts.shop, { kind: 'build', dir: 'dist', start: 'npm run dev', statics: [] });
    const devOnly = withParts({ shop: { dir: 'shop', url: 'http://localhost:5173', start: 'npm run dev' } });
    assert.deepEqual(code(devOnly, true).parts.shop, { kind: 'dev', url: 'http://localhost:5173', start: 'npm run dev', statics: [] });
    // Several parts: all with their source, the ones without stay deployed; a list names exactly the parts it wants.
    const dev = { kind: 'dev', url: 'http://localhost:5173', statics: [] };
    const two = withParts({ shop: { dir: 'shop', build: 'dist', url: 'http://localhost:5173' }, admin: { dir: 'admin' } });
    assert.throws(() => code(two, 'http://localhost:5174'), (error) => error.code === 'usage' && /gilt für genau einen Teil, overlay\.parts hat shop, admin/.test(error.message));
    assert.deepEqual(code(two, 'dev'), { source: 'overlay', parts: { shop: dev }, skipped: ['admin'] }, 'a part without a source stays deployed');
    assert.deepEqual(code(two, 'shop:build'), { source: 'overlay', parts: { shop: build }, skipped: [] }, 'parts not listed stay deployed');
    assert.throws(() => code(two, 'admin'), /--overlay geht hier nicht: Teil admin hat keine Quelle/);
    assert.throws(() => code(two, 'shop:dev,admin:dev'), /--overlay admin:dev geht hier nicht: Teil admin hat kein url\./);
    assert.throws(() => code(two, 'shp'), /Einen Teil "shp" gibt es nicht \(meintest du shop\?\)\. Teile: shop, admin/);
    assert.throws(() => code(two, 'shop,build'), /build steht allein/);
    assert.throws(() => code(two, 'Shop!'), /"Shop!" geht nicht/);
    const none = withParts({ shop: { dir: 'shop' }, admin: { dir: 'admin' } });
    assert.throws(() => code(none, true), /Kein Teil hat eine Quelle/);
    assert.throws(() => code(none, 'build'), /--overlay build geht hier nicht: Kein Teil hat build\./);
    // Without the block, or on an environment it does not list.
    assert.throws(() => checkTest(spec, 'local', simple(), { overlay: true }), (error) => error.code === 'usage' && /braucht einen Block "overlay"/.test(error.message));
    const elsewhere = { ...own, overlay: { ...own.overlay, environments: ['staging'] } };
    assert.throws(() => checkTest(spec, 'local', elsewhere, { overlay: true }), /--overlay geht auf Umgebung local nicht: overlay\.environments erlaubt staging/);
    const extjs = withParts({ shop: { dir: 'shop' } }, { framework: 'extjs' });
    assert.deepEqual(code(extjs, true).parts.shop, { kind: 'watch', url: 'http://localhost:1841/', statics: [] }, 'ExtJS: the watch at its usual address, without config');
    const extjsAt = withParts({ shop: { dir: 'shop', url: 'http://localhost:1842/', start: 'npm run watch' } }, { framework: 'extjs' });
    assert.deepEqual(code(extjsAt, true).parts.shop, { kind: 'watch', url: 'http://localhost:1842/', start: 'npm run watch', statics: [] });
    assert.deepEqual(code(extjsAt, 'http://localhost:52775/', { start: true }).parts.shop,
        { kind: 'watch', url: 'http://localhost:52775/', start: 'npm run watch', command: 'npm run watch', statics: [] }, '--overlay <url> overrides url for ExtJS too');
    assert.throws(() => code(extjs, 'build'), (error) => error.code === 'usage' && /--overlay build gibt es bei ExtJS nicht/.test(error.message));
    // http on localhost is a dev server: it always runs the own code, an overlay makes no sense. https on *.localhost,
    // however, is a deployed build like any other.
    const at = (url) => ({ ...own, environments: { box: { url, agent: true } }, overlay: { ...own.overlay, environments: ['box'] } });
    assert.throws(() => checkTest(spec, 'box', at('http://localhost:5173'), { overlay: true }), (error) => error.code === 'usage' && /Umgebung box ist ein Dev-Server \(localhost:5173\)/.test(error.message));
    assert.equal(checkTest(spec, 'box', at('https://shop.localhost:8443'), { overlay: true }).source, 'overlay');
    assert.throws(() => checkTest({ ...spec, environments: ['local'] }, 'staging', own), /Trage staging in environments in caw\/tests\/smoke\.yaml ein/);
});

test('config: suggestions for typos, notes on settings without effect', () => {
    assert.match(issues({ ...simple(), allowHost: ['x.example'] }), /Unbekanntes Feld: allowHost \(meintest du allowHosts\?\)/);
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', writabel: true } } }), /writabel gibt es dort nicht.*\(meintest du writable\?\)/);
    assert.doesNotMatch(issues({ ...simple(), zzz: 1 }), /meintest/);
    const claude = { ...simple(), environments: { local: { url: 'http://app.localhost:5173', agent: true, writable: true } } };
    assert.deepEqual(validateConfig(claude), { ok: true, issues: [], notes: [], todo: [] });
    assert.equal(effectiveEnvironment(claude, 'local').agent, true);
});

test('overlay config: environments, parts, pattern and statics; without --overlay only the deployed code', () => {
    assert.equal(checkTest(SPEC, 'nord-dev', multi()).source, 'deployed');
    const parts = { shop: { dir: 'shop', statics: [{ name: 'main.js', path: 'dist/main.js' }] } };
    const own = { ...simple(), overlay: { environments: ['local'], assetUrlPattern: '/static/js/(.+\\.js)', parts } };
    assert.deepEqual(validateConfig(own).issues, []);
    assert.deepEqual(validateConfig({ ...own, overlay: { environments: ['local'], parts } }).issues, [], 'without a pattern the name is the path under the environment');
    const pattern = (assetUrlPattern) => issues({ ...own, overlay: { ...own.overlay, assetUrlPattern } });
    assert.match(pattern('/static/js/.+'), /overlay\.assetUrlPattern: "\/static\/js\/\.\+" braucht eine Gruppe/);
    assert.match(pattern('('), /kein gültiger/);
    const built = buildDevlinkConfig(own, effectiveEnvironment(own, 'local'), '/shop');
    assert.equal(built.assetUrlPattern, own.overlay.assetUrlPattern);
    assert.equal(built.authMarker, '#menu');
    assert.deepEqual(built.projects[0], { uuid: built.projects[0].uuid, name: 'app', active: true, startUrl: '/shop' }, 'the overlay applies the local code');
    // The block: environments that exist, are not production and not a dev server here; at least one part with a valid name.
    const block = (overlay, environments = {}) => issues({ ...simple(), environments: { ...simple().environments, ...environments }, overlay });
    assert.match(block('x'), /overlay muss ein Objekt mit environments und parts sein/);
    assert.match(block({ environments: ['local'], parts, apps: {} }), /overlay: unbekanntes Feld apps/);
    assert.match(block({ parts }), /overlay\.environments muss mindestens eine Umgebung nennen/);
    assert.match(block({ environments: [], parts }), /overlay\.environments muss mindestens eine Umgebung nennen/);
    assert.match(block({ environments: ['qa'], parts }), /overlay\.environments: Umgebung "qa" gibt es nicht\. Bekannt: local, staging/);
    assert.match(block({ environments: ['live'], parts }, { live: { url: 'https://www.shop.example', production: true } }), /overlay\.environments: live ist Produktion/);
    assert.match(block({ environments: ['box'], parts }, { box: { url: 'http://localhost:5173' } }), /overlay\.environments: box ist ein Dev-Server auf diesem Rechner \(localhost:5173\)/);
    assert.equal(block({ environments: ['box'], parts }, { box: { url: 'https://shop.localhost:8443' } }), '', 'https on *.localhost is a deployed build');
    assert.match(block({ environments: ['local'] }), /overlay\.parts muss mindestens einen Teil nennen/);
    assert.match(block({ environments: ['local'], parts: {} }), /overlay\.parts muss mindestens einen Teil nennen/);
    for (const name of ['build', 'dev', 'Shop', 'a_b']) assert.match(block({ environments: ['local'], parts: { [name]: { dir: '.' } } }), /ist kein gültiger Name/, name);
    assert.equal(block({ environments: ['local'], parts: { shop: { dir: 'shop' }, 'admin-2': { dir: 'admin' } } }), '', 'a part without a source is valid: --overlay skips it');
});

test('overlay config: a part\'s url, start, build and statics are checked up front, not during the run', () => {
    const app = (part, framework) => issues({
        ...simple(), ...(framework === undefined ? {} : { framework }),
        overlay: { environments: ['local'], parts: { shop: typeof part === 'object' && part !== null ? { dir: 'shop', ...part } : part } },
    });
    assert.equal(app({ build: 'dist/app/browser', url: 'http://localhost:5173', start: 'npm run dev', statics: [{ name: 'a.js', path: 'a.js' }] }), '');
    for (const bad of ['', '/abs', 'C:\\x', '../raus', 3]) assert.match(app({ build: bad }), /overlay\.parts\.shop\.build muss der relative Pfad/);
    for (const bad of ['localhost:5173', 'ftp://x', 5173]) {
        assert.match(app({ url: bad }), /overlay\.parts\.shop\.url muss die Adresse des lokalen Code-Servers sein/);
    }
    assert.match(app({ start: 'npm run dev' }), /overlay\.parts\.shop\.start braucht url oder build/);
    assert.match(app({ url: 'http://localhost:5173', start: ' ' }), /overlay\.parts\.shop\.start muss ein Befehl sein/);
    assert.match(app({ devServer: 'http://localhost:5173' }), /overlay\.parts\.shop: unbekanntes Feld devServer/);
    assert.match(app({ statics: [{ name: 'x' }] }), /overlay\.parts\.shop\.statics\[0\] braucht name und path/);
    // .. leaves the part folder (a neighbouring package); whether it stays inside the workspace is checked at run time (static-files).
    assert.equal(app({ statics: [{ name: 'x', path: '../../packages/m/c.js' }] }), '');
    assert.match(app({ statics: [{ name: 'x', path: 'C:/aussen.js' }] }), /statics\[0\]/);
    assert.match(app({ statics: 'a.js' }), /overlay\.parts\.shop\.statics muss eine Liste sein/);
    assert.match(app('dist'), /overlay\.parts\.shop muss ein Objekt sein/);
    assert.equal(app({ start: 'sencha app watch', statics: [{ name: 'C.js', path: 'c.js' }] }, 'extjs'), '', 'ExtJS: the watch needs no source');
    assert.equal(app({ url: 'http://localhost:1841/', start: 'npm run watch' }, 'extjs'), '', 'ExtJS: the watch at its address, with its start command');
    assert.equal(app({ start: 'npm run watch' }, 'extjs'), '', 'ExtJS: start without url, the watch at its usual address');
    assert.match(app({ url: 'localhost:1841' }, 'extjs'), /overlay\.parts\.shop\.url muss die Adresse/);
    assert.match(app({ build: 'build' }, 'extjs'), /Bei ExtJS kommt der lokale Code vom Sencha-Watch/);
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

test('assetUrlPattern: a string or a list, one per source; also per part; each entry needs group 1', () => {
    const proxy = '[?&]url=repo:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)';
    const cdn = '^https://cdn\\.example/js/(?:[^?#]*/)?([^/?#]+\\.js)';
    const at = (assetUrlPattern, part = {}) => ({ ...simple(), overlay: { environments: ['local'], ...(assetUrlPattern === undefined ? {} : { assetUrlPattern }), parts: { shop: { dir: 'shop', ...part } } } });
    assert.equal(issues(at([proxy, cdn])), '');
    assert.equal(issues(at(undefined, { assetUrlPattern: cdn })), '');
    assert.match(issues(at([])), /overlay\.assetUrlPattern muss ein regulärer Ausdruck sein oder eine Liste davon/);
    assert.match(issues(at([proxy, 3])), /eine Liste davon/);
    assert.match(issues(at([proxy, '/static/.+'])), /overlay\.assetUrlPattern: "\/static\/\.\+" braucht eine Gruppe/);
    assert.match(issues(at(undefined, { assetUrlPattern: '(' })), /overlay\.parts\.shop\.assetUrlPattern: "\(" ist kein gültiger/);
    assert.deepEqual(assetPatterns(at(proxy, { assetUrlPattern: [cdn, proxy] }), 'shop'), [proxy, cdn], 'the part adds to the block\'s list, without duplicates');
    assert.deepEqual(assetPatterns(at([proxy, cdn]), 'other'), [proxy, cdn]);
    assert.deepEqual(assetPatterns({}, 'shop'), []);
});

test('writeConfig: merges into the file, validates first, writes atomically with 4 spaces; never secrets', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-write-config-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'caw.config.json');
    writeFileSync(file, JSON.stringify({ ...simple(), overlay: { environments: ['local'], assetUrlPattern: 'a/([^/]+\\.js)', parts: { shop: { dir: 'shop' } } }, consoleIgnore: ['x'] }));
    const before = readFileSync(file, 'utf8');
    const invalid = writeConfig(root, { overlay: { assetUrlPattern: ['('] } });
    assert.equal(invalid.ok, false);
    assert.match(invalid.issues.join('\n'), /kein gültiger/);
    assert.equal(readFileSync(file, 'utf8'), before, 'nothing written when invalid');
    const dry = writeConfig(root, { overlay: { assetUrlPattern: ['a/([^/]+\\.js)', 'b/([^/]+\\.js)'] } }, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.config.overlay.assetUrlPattern, ['a/([^/]+\\.js)', 'b/([^/]+\\.js)']);
    assert.equal(readFileSync(file, 'utf8'), before, 'dryRun writes nothing');
    const written = writeConfig(root, { overlay: { assetUrlPattern: ['a/([^/]+\\.js)', 'b/([^/]+\\.js)'] }, consoleIgnore: null, environments: { staging: { allowHosts: ['login.shop.example'] } } });
    assert.deepEqual(written, { ok: true, issues: [], config: written.config });
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith('{\n    "environments": {') && text.endsWith('}\n'), '4 spaces, trailing newline');
    const saved = JSON.parse(text);
    assert.deepEqual(saved.overlay.assetUrlPattern, ['a/([^/]+\\.js)', 'b/([^/]+\\.js)'], 'arrays replace');
    assert.deepEqual(saved.overlay.parts, { shop: { dir: 'shop' } }, 'nested objects merge');
    assert.equal(saved.consoleIgnore, undefined, 'null deletes');
    assert.deepEqual(saved.environments.staging, { url: 'https://staging.shop.example', allowHosts: ['login.shop.example'] }, 'objects merge');
    assert.deepEqual(readdirSync(root), ['caw.config.json'], 'no temp file left');
    for (const patch of [{ roles: { kaeufer: { password: 'geheim' } } }, { agent: { token: 'sk' } }, { apiSecret: 'x' }]) {
        const refused = writeConfig(root, patch);
        assert.equal(refused.ok, false);
        assert.match(refused.issues[0], /Geheimnisse gehören nach caw\/\.env/);
    }
    assert.equal(writeConfig(root, { roles: { kaeufer: {} }, signIn: { passwordSelector: '#pw2' } }).ok, true, 'variable names and selectors are fine');
    assert.equal(writeConfig(mkdtempSync(join(tmpdir(), 'caw-write-none-')), {}).ok, false, 'no config file');
});

test('writeConfig: refuses guarded keys (commands, environment flags, browser, sandbox, agent mode) and names them', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-write-guarded-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'caw.config.json');
    const config = { ...simple(), environments: { ...simple().environments, live: { url: 'https://shop.example', production: true } },
        overlay: { environments: ['staging'], parts: { shop: { dir: 'shop', url: 'http://localhost:5173', start: 'npm run dev' } } } };
    writeFileSync(file, JSON.stringify(config));
    const before = readFileSync(file, 'utf8');
    const refusals = [
        [{ environments: { local: { start: 'calc.exe' } } }, 'environments.local.start'],
        [{ environments: { local: { reset: 'rm -rf /' } } }, 'environments.local.reset'],
        [{ environments: { local: { ready: { path: '/x' } } } }, 'environments.local.ready'],
        [{ environments: { staging: { agent: true } } }, 'environments.staging.agent'],
        [{ environments: { staging: { writable: true } } }, 'environments.staging.writable'],
        [{ environments: { staging: { allowHttp: true } } }, 'environments.staging.allowHttp'],
        [{ environments: { staging: { insecureTls: true } } }, 'environments.staging.insecureTls'],
        [{ environments: { local: { agent: null } } }, 'environments.local.agent'],
        [{ environments: { staging: { extends: 'local' } } }, 'environments.staging.agent'],
        [{ environments: { live: null } }, 'environments.live.production'],
        [{ environments: { live: null, shop: { url: 'https://shop.example', agent: true } } }, 'environments.shop.agent'],
        [{ environments: { other: { url: 'https://other.example', agent: true } } }, 'environments.other.agent'],
        [{ environments: { other: { extends: 'local', url: 'https://other.localhost' } } }, 'environments.other.writable'],
        [{ overlay: { parts: { shop: { start: 'evil' } } } }, 'overlay.parts.shop.start'],
        [{ overlay: { parts: { admin: { dir: 'admin', url: 'http://localhost:4200', start: 'evil' } } } }, 'overlay.parts.admin.start'],
        [{ lintCommand: 'evil' }, 'lintCommand'],
        [{ sandboxImage: 'evil/image' }, 'sandboxImage'],
        [{ sandboxUser: 'root' }, 'sandboxUser'],
        [{ browser: { executablePath: '/opt/evil/chrome' } }, 'browser.executablePath'],
        [{ agent: { mode: 'session' } }, 'agent.mode'],
    ];
    for (const [patch, key] of refusals) {
        for (const dryRun of [false, true]) {
            const refused = writeConfig(root, patch, { dryRun });
            assert.equal(refused.ok, false, JSON.stringify(patch));
            assert.ok(refused.guarded.includes(key), `${JSON.stringify(patch)}: ${refused.guarded}`);
            assert.match(refused.issues[0], /Nicht über caw_config geändert: .*ausdrückliches Ja im Gespräch, auch wenn deine Edits automatisch freigegeben werden.*Edit-Werkzeug in caw\.config\.json/);
        }
    }
    assert.equal(readFileSync(file, 'utf8'), before, 'nothing written');
    // Everything else still goes through, also a new environment without guarded keys and unchanged values written again.
    assert.equal(writeConfig(root, { environments: { qa: { url: 'https://qa.shop.example' } } }).ok, true);
    assert.equal(writeConfig(root, { environments: { local: { agent: true, writable: true } }, overlay: { parts: { shop: { url: 'http://localhost:5174' } } } }).ok, true);
    assert.equal(writeConfig(root, { environments: { qa: null } }).ok, true, 'an environment without guarded keys may go');
});

test('checkTest: the environment must be one the test runs on', () => {
    assert.throws(() => checkTest(SPEC, 'nord-test', multi()), /smoke läuft nicht auf nord-test, nur auf nord-dev, sued-test\. Trage nord-test in environments/);
});

test('checkTest: unknown role', () => {
    assert.throws(() => checkTest({ ...SPEC, role: 'x' }, 'nord-dev', multi()), /Rolle/);
});

test('checkTest: a writing test is rejected on environments without writable', () => {
    // Listed: the test itself is invalid, wherever it runs.
    const listed = { ...SPEC, writes: true, environments: ['nord-dev', 'nord-test', 'nord-abnahme'] };
    assert.throws(() => checkTest(listed, 'nord-dev', multi()), (error) => error.code === 'test-invalid' && /nicht auf nord-abnahme laufen: Die Umgebung ist schreibgeschützt/.test(error.message));
    const prod = { environments: { ...multi().environments, live: { url: 'https://www.nord.example', production: true } } };
    assert.throws(() => checkTest({ ...listed, environments: ['nord-dev', 'live'] }, 'nord-dev', { ...multi(), ...prod }), /nicht auf live laufen: Das ist Produktion/);
    assert.equal(checkTest({ ...listed, writes: false, environments: ['nord-dev', 'live'] }, 'live', { ...multi(), ...prod }).writes, false, 'a read-only test may list production');
    // Not listed: the default is the writable environments; --env on another one is write-protected.
    const spec = { ...SPEC, writes: true };
    delete spec.environments;
    assert.equal(checkTest(spec, 'nord-dev', multi()).writes, true);
    assert.equal(checkTest(spec, 'nord-test', multi()).writes, true);
    assert.throws(() => checkTest(spec, 'nord-abnahme', multi()), (error) => error.code === 'write-protected' && /schreibgeschützt/.test(error.message));
});

test('buildDevlinkConfig: environment and start page, no marker without login', () => {
    const cfg = buildDevlinkConfig(multi(), effectiveEnvironment(multi(), 'nord-dev'), startPath(multi(), {}));
    assert.equal(cfg.portals[0].url, 'https://dev.nord.example');
    assert.equal(cfg.activePortal, cfg.portals[0].uuid);
    assert.equal(cfg.projects[0].startUrl, '/app#start');
    assert.notEqual(cfg.projects[0].uuid, cfg.portals[0].uuid);
    const open = withoutAuth();
    assert.equal(buildDevlinkConfig(open, effectiveEnvironment(open, 'local'), '/shop').authMarker, null);
    assert.equal(startPath(multi(), { start: '/pruefen' }), '/pruefen', 'a test may begin elsewhere');
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
    for (const name of ['prod-de', 'live-eu', 'prd2', 'produktiv-at']) assert.match(at({ [name]: { url: 'https://www.shop.example', agent: true } }), /sieht nach Produktion aus/, name);
    assert.equal(at({ 'live-preview': { url: 'https://preview.shop.example', production: false, agent: true } }), '');
    assert.equal(at({ delivery: { url: 'https://d.shop.example' } }), '', 'no match in the middle of a word');
});

test('production: the exact names cannot be bypassed with false', () => {
    assert.match(issues({ ...simple(), environments: { ...simple().environments, prod: { url: 'https://www.shop.example', production: false, agent: true } } }), /dem Namen nach Produktion/);
});

test('config: broken values lead to messages, not crashes', () => {
    assert.match(validateConfig(null).issues.join(), /JSON-Objekt/);
    assert.match(issues({ ...simple(), start: null }), /start muss ein Pfad sein/);
    assert.match(issues({ ...simple(), consoleIgnore: 'foo' }), /consoleIgnore muss eine Liste/);
    assert.match(issues({ ...simple(), sandboxImage: 'node:22\nRUN curl x' }), /Image-Referenz/);
    assert.match(issues({ ...simple(), environments: { local: { url: 'http://app.localhost:5173', roles: {} } } }), /roles gibt es dort nicht/);
    const open = withoutAuth();
    assert.match(issues({ ...open, roles: { kaeufer: {} } }), /roles: Keine Umgebung meldet sich an \(überall signIn vom Typ none\), lass roles weg/);
    assert.match(issues({ ...simple(), signIn: { ...simple().signIn, path: 'https://sso.example/login' } }), /allowHosts/);
});

test('config: browser picks a Chromium browser, default Chrome', async () => {
    const { browserLaunch } = await import('../src/shared/config.mjs');
    assert.deepEqual(browserLaunch({}), { channel: 'chrome', chromiumSandbox: true });
    assert.deepEqual(browserLaunch({ browser: { channel: 'msedge' } }), { channel: 'msedge', chromiumSandbox: true });
    assert.deepEqual(browserLaunch({ browser: { executablePath: '/opt/chromium/chrome' } }), { executablePath: '/opt/chromium/chrome', chromiumSandbox: true });
    // Chrome's sandbox is always on; only the explicit, unsafe opt-out turns it off.
    assert.deepEqual(browserLaunch({ browser: { noSandbox: true } }), { channel: 'chrome', chromiumSandbox: false });
    assert.equal(issues({ ...simple(), browser: { noSandbox: true } }), '');
    assert.match(issues({ ...simple(), browser: { noSandbox: 'yes' } }), /browser\.noSandbox muss true oder false sein/);
    // thirdPartyHosts: host names like allowHosts, top level and per environment.
    assert.equal(issues({ ...simple(), thirdPartyHosts: ['fonts.example'] }), '');
    assert.match(issues({ ...simple(), thirdPartyHosts: ['https://fonts.example/css'] }), /thirdPartyHosts: "https:\/\/fonts\.example\/css" ist eine Adresse/);
    assert.equal(issues({ ...simple(), browser: { channel: 'msedge' } }), '');
    assert.match(issues({ ...simple(), browser: { channel: 'firefox' } }), /browser.channel muss einer von/);
    assert.match(issues({ ...simple(), browser: { executablePath: 'chrome.exe' } }), /absoluter Pfad/);
    // Only a browser on this machine: no network share, no device namespace, nothing a process holds open under /proc.
    for (const path of ['\\\\host\\share\\chrome.exe', '//host/share/chrome', '\\\\?\\C:\\chrome.exe', '\\\\.\\pipe\\x', '/proc/self/fd/3', '/proc']) {
        assert.match(issues({ ...simple(), browser: { executablePath: path } }), /auf diesem Rechner/, path);
    }
    assert.equal(issues({ ...simple(), browser: { executablePath: '/opt/chromium/chrome' } }), '');
    assert.match(issues({ ...simple(), browser: 'edge' }), /browser muss ein Objekt sein/);
});

test('config: a role is an empty object; the test user follows the naming convention', () => {
    const role = (fields) => issues({ ...simple(), roles: { kaeufer: fields } });
    assert.equal(role({}), '');
    assert.match(role({ passwortEnv: 'X' }), /Rolle kaeufer: passwortEnv ist nicht erlaubt; eine Rolle ist ein leeres Objekt \{\}/);
    assert.match(role('kaeufer'), /Rolle kaeufer muss ein leeres Objekt sein/);
    // Removed before 1.0: named with what replaced them.
    for (const key of ['loginEnv', 'passwordEnv', 'totpEnv']) assert.match(role({ [key]: 'X' }), new RegExp(`roles\\.kaeufer\\.${key} gibt es nicht mehr: der Testnutzer folgt der Namenskonvention CAW_<ROLLE>_USER`));
    assert.match(issues({ ...simple(), roles: { gate: {} } }), /Die Rolle "gate" ist reserviert/);
    assert.match(issues({ ...simple(), roles: {} }), /roles muss ein Objekt mit mindestens einer Rolle sein/);
});

test('config: a Basic gate per environment, never together with a basic sign-in', () => {
    const gated = (gate, signIn) => issues({ ...simple(), environments: { ...simple().environments, staging: { url: 'https://staging.shop.example', gate, ...(signIn === undefined ? {} : { signIn }) } } });
    assert.equal(gated({ type: 'basic' }), '');
    assert.match(gated({ type: 'form' }), /environments\.staging\.gate muss \{ "type": "basic" \} sein; die Zugangsdaten sind CAW_GATE_USER und CAW_GATE_PASSWORD/);
    assert.match(gated({ type: 'basic', user: 'x' }), /environments\.staging\.gate muss/);
    assert.match(gated({ type: 'basic' }, { type: 'basic' }), /Umgebung staging: Gate und signIn vom Typ basic wären beide HTTP-Basic-Zugangsdaten/);
});
