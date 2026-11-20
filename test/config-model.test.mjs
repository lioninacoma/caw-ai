// The environment and credential model: extends, defaults, choosing without --env, navigation hosts, test users by name.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig, urlOverride, urlVariable, validateConfig, withUrlOverrides, writeConfig } from '../src/shared/config.mjs';
import { credentialNames, credentialState, resolveCredentials, roleLinePattern } from '../src/shared/credentials.mjs';
import {
    NAME, chooseEnvironment, effectiveEnvironment, effectiveEnvironments, environmentCandidates, environmentNames, navigationHosts,
    startPath, testEnvironments,
} from '../src/shared/environments.mjs';

const config = {
    start: '/home',
    signIn: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#menu' },
    allowHosts: ['idp.example.test'],
    environments: {
        local: { url: 'http://localhost:5173', agent: true, writable: true },
        'north-dev': { url: 'https://north.dev.example.test', agent: true, allowHosts: ['cdn.example.test'], insecureTls: true },
        'south-dev': { extends: 'north-dev', url: 'https://south.dev.example.test' },
        ci: { url: 'http://localhost:8080', writable: true, signIn: { type: 'none' } },
        prod: { url: 'https://www.example.test', production: true },
        'prod-south': { extends: 'prod', url: 'https://south.example.test', production: true },
    },
};

test('effectiveEnvironment: extends inherits everything but production, values replace, signIn falls back to the top level', () => {
    assert.deepEqual(environmentNames(config), ['local', 'north-dev', 'south-dev', 'ci', 'prod', 'prod-south']);
    const south = effectiveEnvironment(config, 'south-dev');
    assert.deepEqual(south, {
        name: 'south-dev', url: 'https://south.dev.example.test', agent: true, writable: false, production: false,
        signIn: config.signIn, allowHosts: ['cdn.example.test'], thirdPartyHosts: [], insecureTls: true, allowHttp: false, ready: { path: '/', timeoutMs: 60000 },
    });
    assert.deepEqual(effectiveEnvironment(config, 'ci').signIn, { type: 'none' }, 'an environment signIn replaces the top level as a whole');
    // production is not inherited: the child must say it itself.
    const child = { environments: { prod: { url: 'https://x.test', production: true }, copy: { extends: 'prod', url: 'https://y.test' } } };
    assert.equal(effectiveEnvironment(child, 'copy').production, false);
    assert.equal(effectiveEnvironment(config, 'prod-south').production, true);
    assert.throws(() => effectiveEnvironment(config, 'stagin'), (error) => error.code === 'env-invalid' && /Umgebung "stagin" gibt es nicht/.test(error.message));
    const cycle = { environments: { a: { extends: 'b', url: 'https://a.test' }, b: { extends: 'a', url: 'https://b.test' } } };
    assert.throws(() => effectiveEnvironment(cycle, 'a'), /extends läuft im Kreis: a → b → a/);
    assert.deepEqual(Object.keys(effectiveEnvironments(cycle)), [], 'unresolvable environments are left out of the list');
});

test('lifecycle keys: inherited, ready filled with defaults; validated per environment and after extends', () => {
    const lifecycle = {
        signIn: { type: 'none' },
        environments: {
            ci: { url: 'http://localhost:18080', writable: true, start: 'docker compose up -d --wait', stop: 'docker compose down -v', reset: 'npm run seed', ready: { path: '/healthz' } },
            ci2: { extends: 'ci', url: 'http://localhost:18081' },
        },
    };
    assert.deepEqual(validateConfig(lifecycle).issues, []);
    const ci2 = effectiveEnvironment(lifecycle, 'ci2');
    assert.deepEqual([ci2.start, ci2.stop, ci2.reset, ci2.ready], ['docker compose up -d --wait', 'docker compose down -v', 'npm run seed', { path: '/healthz', timeoutMs: 60000 }]);
    assert.equal(effectiveEnvironment(config, 'local').start, undefined);
    const issues = (environments) => validateConfig({ signIn: { type: 'none' }, environments }).issues;
    assert.match(issues({ a: { url: 'http://localhost:1', start: '' } }).join('\n'), /a: start muss ein Shell-Befehl sein/);
    assert.match(issues({ a: { url: 'http://localhost:1', start: 'x', ready: { path: 'healthz' } } }).join('\n'), /a: ready ist/);
    assert.match(issues({ a: { url: 'http://localhost:1', start: 'x', ready: { timeoutMs: 500 } } }).join('\n'), /a: ready ist/);
    assert.match(issues({ a: { url: 'http://localhost:1', start: 'x', ready: { timeoutMs: 1000, wait: 1 } } }).join('\n'), /a: ready ist/);
    assert.match(issues({ a: { url: 'http://localhost:1', stop: 'x' } }).join('\n'), /a: stop nur zusammen mit start/);
    assert.match(issues({ a: { url: 'http://localhost:1', reset: 'x' } }).join('\n'), /a: reset schreibt Daten/);
    assert.match(issues({ prod: { url: 'https://p.test', production: true, start: 'x', stop: 'y' } }).join('\n'), /prod ist Produktion: caw startet, stoppt und setzt sie nie zurück \(start, stop nicht erlaubt\)/);
    // Inherited commands count on production too: production is not inherited, the commands are.
    assert.match(issues({ dev: { url: 'http://localhost:1', start: 'x' }, live: { extends: 'dev', url: 'https://l.test', production: true } }).join('\n'), /live ist Produktion/);
});

test('names: lowercase, digits and -, at most 32 characters; no underscore (maps 1:1 to the variable suffix)', () => {
    for (const ok of ['local', 'north-dev', 'ci2', 'a'.repeat(32)]) assert.ok(NAME.test(ok), ok);
    for (const bad of ['north_dev', 'Local', '2ci', '-x', 'a'.repeat(33), '']) assert.ok(!NAME.test(bad), bad);
});

test('testEnvironments: explicit list as given, otherwise every non-production environment, only writable ones for a writing test', () => {
    assert.deepEqual(testEnvironments(config, { writes: false }), ['local', 'north-dev', 'south-dev', 'ci']);
    assert.deepEqual(testEnvironments(config, { writes: true }), ['local', 'ci']);
    assert.deepEqual(testEnvironments(config, { writes: false, environments: ['local', 'prod'] }), ['local', 'prod']);
    assert.equal(startPath(config, {}), '/home');
    assert.equal(startPath(config, { start: '/orders' }), '/orders');
    assert.equal(startPath({}, {}), '/');
});

test('chooseEnvironment: given, the only candidate, for run outside CI the only one with Claude; production never by itself', () => {
    assert.deepEqual(chooseEnvironment(config, { given: 'ci', candidates: [], command: 'run' }), { name: 'ci', why: 'given' });
    assert.throws(() => chooseEnvironment(config, { given: 'nope', candidates: [], command: 'run' }), { code: 'env-invalid' });
    const writing = environmentCandidates(config, { command: 'run', specs: [{ writes: true }] });
    assert.deepEqual(writing, ['local', 'ci']);
    assert.deepEqual(chooseEnvironment(config, { candidates: writing, command: 'run' }), { name: 'local', why: 'onlyClaude' });
    assert.throws(() => chooseEnvironment(config, { candidates: writing, command: 'run', ci: true }), (error) => error.code === 'usage' && /--env fehlt: local, ci/.test(error.message));
    // A prod smoke test that lists only production: never chosen without --env.
    assert.throws(() => chooseEnvironment(config, { candidates: environmentCandidates(config, { command: 'run', specs: [{ writes: false, environments: ['prod'] }] }), command: 'run' }), /Keine Umgebung passt/);
    // record: only environments with Claude, writable for a writing test.
    assert.deepEqual(environmentCandidates(config, { command: 'record', specs: [{ writes: true }] }), ['local']);
    assert.deepEqual(environmentCandidates(config, { command: 'record', specs: [{ writes: false }] }), ['local', 'north-dev', 'south-dev']);
    assert.deepEqual(environmentCandidates(config, { command: 'record', writes: false }), ['local', 'north-dev', 'south-dev']);
    assert.deepEqual(environmentCandidates(config, { command: 'record' }), ['local']);
    assert.deepEqual(environmentCandidates(config, { command: 'open' }), ['local', 'north-dev', 'south-dev']);
});

test('navigationHosts: all non-production hosts, the own one, allowHosts of project and environment; production only on production', () => {
    assert.deepEqual(navigationHosts(config, 'north-dev'), ['north.dev.example.test', 'localhost', 'south.dev.example.test', 'idp.example.test', 'cdn.example.test']);
    assert.ok(!navigationHosts(config, 'local').includes('www.example.test'));
    assert.ok(navigationHosts(config, 'prod').includes('www.example.test'));
    // An exception never re-enables production.
    const leaky = { ...config, allowHosts: ['www.example.test'] };
    assert.ok(!navigationHosts(leaky, 'local').includes('www.example.test'));
});

test('credentials: default set, environment set as a whole, process environment wins, missing names named exactly', () => {
    assert.deepEqual(credentialNames('clerk-lead', 'south-dev'), {
        default: { user: 'CAW_CLERK_LEAD_USER', password: 'CAW_CLERK_LEAD_PASSWORD', totp: 'CAW_CLERK_LEAD_TOTP' },
        env: { user: 'CAW_CLERK_LEAD_USER__SOUTH_DEV', password: 'CAW_CLERK_LEAD_PASSWORD__SOUTH_DEV', totp: 'CAW_CLERK_LEAD_TOTP__SOUTH_DEV' },
    });
    const fileEnv = { CAW_CLERK_USER: 'file-user', CAW_CLERK_PASSWORD: 'file-pass', CAW_CLERK_USER__CI: 'ci-user', CAW_CLERK_PASSWORD__CI: 'ci-pass' };
    assert.deepEqual(resolveCredentials({ who: 'clerk', env: 'local', sources: { fileEnv } }), { set: 'default', names: { user: 'CAW_CLERK_USER', password: 'CAW_CLERK_PASSWORD' }, user: 'file-user', password: 'file-pass' });
    assert.equal(resolveCredentials({ who: 'clerk', env: 'ci', sources: { fileEnv } }).user, 'ci-user');
    assert.equal(resolveCredentials({ who: 'clerk', env: 'local', sources: { fileEnv, processEnv: { CAW_CLERK_USER: 'secret-user' } } }).user, 'secret-user');
    // Only the user for the environment: never mixed with the default password.
    assert.throws(() => resolveCredentials({ who: 'clerk', env: 'staging', sources: { fileEnv: { ...fileEnv, CAW_CLERK_USER__STAGING: 'x' } } }),
        (error) => error.code === 'credentials-missing' && /CAW_CLERK_PASSWORD__STAGING fehlt/.test(error.message) && !error.message.includes('file-pass'));
    assert.throws(() => resolveCredentials({ who: 'clerk', env: 'local', totp: true, sources: { fileEnv } }), /CAW_CLERK_TOTP/);
    assert.deepEqual(credentialState({ who: 'admin', env: 'local', sources: { fileEnv } }), { set: null, names: { user: 'CAW_ADMIN_USER', password: 'CAW_ADMIN_PASSWORD' }, missing: ['CAW_ADMIN_USER', 'CAW_ADMIN_PASSWORD'] });
    assert.deepEqual(credentialState({ who: 'clerk', env: 'ci', sources: { fileEnv } }).set, 'env');
});

test('roleLinePattern: exactly the role\'s lines, both sets; another role with the same prefix stays', () => {
    const pattern = roleLinePattern('clerk');
    for (const line of ['CAW_CLERK_USER=a', 'CAW_CLERK_PASSWORD__SOUTH_DEV="b"', 'export CAW_CLERK_TOTP=c']) assert.ok(pattern.test(line), line);
    for (const line of ['CAW_CLERK_LEAD_USER=a', 'CAW_CLERKS_USER=a', '# CAW_CLERK_USER=a', 'CAW_CLERK_USERNAME=a']) assert.ok(!pattern.test(line), line);
});

test('CAW_URL__<ENV>: points a test environment at a preview for this process; its children keep their address', () => {
    const withPreview = { ...config, environments: { ...config.environments, 'pr-preview': { url: 'https://pr.example.test', writable: true }, 'pr-child': { extends: 'pr-preview' } } };
    const changed = withUrlOverrides(withPreview, { CAW_URL__PR_PREVIEW: 'https://pr-42.preview.example.test', PATH: '/bin' });
    assert.equal(effectiveEnvironment(changed, 'pr-preview').url, 'https://pr-42.preview.example.test');
    assert.equal(effectiveEnvironment(changed, 'pr-child').url, 'https://pr.example.test', 'the variable names one environment only');
    assert.equal(withPreview.environments['pr-preview'].url, 'https://pr.example.test', 'the given config is not changed');
    assert.equal(withUrlOverrides(withPreview, {}), withPreview);
    assert.equal(urlVariable('pr-preview'), 'CAW_URL__PR_PREVIEW');
    // http on this machine as for the config itself.
    assert.equal(effectiveEnvironment(withUrlOverrides(config, { CAW_URL__CI: 'http://localhost:9090' }), 'ci').url, 'http://localhost:9090');
});

test('CAW_URL__<ENV>: refused for production, agent environments, a production host, an invalid origin and an unknown name', () => {
    const refused = (env, pattern) => assert.throws(() => withUrlOverrides(config, env), (error) => error.code === 'url-override' && pattern.test(error.message), JSON.stringify(env));
    refused({ CAW_URL__PROD: 'https://other.example.test' }, /CAW_URL__PROD würde die Produktionsumgebung prod umlenken/);
    refused({ CAW_URL__LOCAL: 'http://localhost:1234' }, /CAW_URL__LOCAL: Auf local darf der Agent arbeiten/);
    refused({ CAW_URL__NORTH_DEV: 'https://x.example.test' }, /Auf north-dev darf der Agent arbeiten/);
    refused({ CAW_URL__CI: 'https://www.example.test' }, /www\.example\.test ist der Host einer Produktionsumgebung; ci dorthin gelenkt würde die Produktionssperre aufheben/);
    refused({ CAW_URL__CI: 'https://south.example.test' }, /Host einer Produktionsumgebung/);
    refused({ CAW_URL__CI: 'http://preview.example.test' }, /CAW_URL__CI: "http:\/\/preview\.example\.test": http nur auf dem eigenen Rechner/);
    refused({ CAW_URL__CI: 'https://preview.example.test/app' }, /nur der Origin/);
    refused({ CAW_URL__CI: '' }, /ist keine Adresse/);
    refused({ CAW_URL__STAGING: 'https://s.example.test' }, /CAW_URL__STAGING nennt keine Umgebung der Konfiguration; möglich: CAW_URL__LOCAL, .*CAW_URL__CI/);
});

test('CAW_URL__<ENV>: loadConfig applies it, writeConfig never writes it back', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-url-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify({ environments: { preview: { url: 'https://preview.example.test', writable: true } } }, null, 4));
    const before = process.env.CAW_URL__PREVIEW;
    process.env.CAW_URL__PREVIEW = 'https://pr-7.preview.example.test';
    t.after(() => {
        if (before === undefined) delete process.env.CAW_URL__PREVIEW;
        else process.env.CAW_URL__PREVIEW = before;
    });
    assert.equal(loadConfig(root).environments.preview.url, 'https://pr-7.preview.example.test');
    assert.equal(urlOverride('preview'), 'https://pr-7.preview.example.test');
    assert.equal(writeConfig(root, { consoleIgnore: ['x'] }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8')).environments.preview.url, 'https://preview.example.test');
});
