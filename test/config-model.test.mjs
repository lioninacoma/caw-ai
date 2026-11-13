// The environment and credential model: extends, defaults, choosing without --env, navigation hosts, test users by name.
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
        local: { url: 'http://localhost:5173', claude: true, writable: true },
        'north-dev': { url: 'https://north.dev.example.test', claude: true, allowHosts: ['cdn.example.test'], insecureTls: true },
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
        name: 'south-dev', url: 'https://south.dev.example.test', claude: true, writable: false, production: false,
        signIn: config.signIn, allowHosts: ['cdn.example.test'], insecureTls: true, allowHttp: false,
    });
    assert.deepEqual(effectiveEnvironment(config, 'ci').signIn, { type: 'none' }, 'an environment signIn replaces the top level as a whole');
    // production is not inherited: the child must say it itself.
    const child = { environments: { prod: { url: 'https://x.test', production: true }, copy: { extends: 'prod', url: 'https://y.test' } } };
    assert.equal(effectiveEnvironment(child, 'copy').production, false);
    assert.equal(effectiveEnvironment(config, 'prod-south').production, true);
    assert.throws(() => effectiveEnvironment(config, 'stagin'), (error) => error.code === 'env-invalid' && /Umgebung „stagin“ gibt es nicht/.test(error.message));
    const cycle = { environments: { a: { extends: 'b', url: 'https://a.test' }, b: { extends: 'a', url: 'https://b.test' } } };
    assert.throws(() => effectiveEnvironment(cycle, 'a'), /extends läuft im Kreis: a → b → a/);
    assert.deepEqual(Object.keys(effectiveEnvironments(cycle)), [], 'unresolvable environments are left out of the list');
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
