// Test users as roles: caw/.env writing, quoting, .gitignore, config, `caw role` and the window before record/run.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseEnvFile } from '../src/host/linux.mjs';
import { ensureTestUser, hasTestUser, roleRounds } from '../src/host/role-capture.mjs';
import { removeRole, roleCommand, roleOverview, roleTarget } from '../src/host/role-command.mjs';
import { envLiteral, ignoreEnvFile, saveTestUser, suggestRole, testUserSet } from '../src/host/test-users.mjs';
import { loadConfig } from '../src/shared/config.mjs';

const tempDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-users-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const project = (t, roles = { tester: {} }) => {
    const root = tempDir(t);
    writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify({
        environments: { local: { url: 'http://localhost:5173', claude: true, writable: true }, prod: { url: 'https://example.com', production: true } },
        signIn: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#me' },
        start: '/',
        roles,
    }, null, 4)}\n`);
    return root;
};
const env = (root) => parseEnvFile(readFileSync(join(root, 'caw/.env'), 'utf8'));

test('envLiteral: every value reads back unchanged through the .env parser', () => {
    for (const value of ['plain', 'p@ss:w0rd!', 'with space', "it's", 'say "hi"', 'a\\nb', "both ' and \"", '#hash', ' lead']) {
        assert.equal(parseEnvFile(`X=${envLiteral(value)}`).X, value, value);
    }
    assert.throws(() => envLiteral('two\nlines'), /Zeilenumbruch/);
    assert.throws(() => envLiteral('\'"`'), /Anführungszeichen/);
});

test('saveTestUser: writes caw/.env, keeps other lines, adds the role to the config and .gitignore once', (t) => {
    const root = project(t);
    mkdirSync(join(root, 'caw'));
    writeFileSync(join(root, 'caw/.env'), '# mine\nOTHER=1\nCAW_TESTER_PASSWORD=old\n');
    const first = saveTestUser(root, { role: 'tester', user: 'mia', password: "it's secret" });
    assert.deepEqual([first.names, first.set, first.config], [['CAW_TESTER_USER', 'CAW_TESTER_PASSWORD'], 'default', 'present']);
    assert.deepEqual(env(root), { OTHER: '1', CAW_TESTER_PASSWORD: "it's secret", CAW_TESTER_USER: 'mia' });
    assert.ok(readFileSync(join(root, 'caw/.env'), 'utf8').startsWith('# mine\n'));
    const second = saveTestUser(root, { role: 'clerk-2', user: 'ben', password: 'pw' });
    assert.equal(second.config, 'added');
    assert.deepEqual(loadConfig(root).roles['clerk-2'], {}, 'a role is an empty object');
    assert.equal(env(root).CAW_CLERK_2_USER, 'ben');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8').match(/caw\/\.env/g).length, 1);
    assert.equal(ignoreEnvFile(root), false);
    assert.throws(() => saveTestUser(root, { role: 'Bad Name', user: 'x', password: 'y' }), /Kleinbuchstaben/);
    assert.throws(() => saveTestUser(root, { role: 'ok', user: '', password: 'y' }), /kein Benutzername/);
});

test('testUserSet (SC-7): the default set first, the same user in place, another user as the set of the environment', () => {
    assert.deepEqual(testUserSet({}, 'clerk', 'staging', 'mia'), { set: 'default', names: { user: 'CAW_CLERK_USER', password: 'CAW_CLERK_PASSWORD', totp: 'CAW_CLERK_TOTP' } });
    const file = { CAW_CLERK_USER: 'mia', CAW_CLERK_PASSWORD: 'x' };
    assert.equal(testUserSet(file, 'clerk', 'staging', 'mia').set, 'default', 'same user: updated in place');
    assert.deepEqual(testUserSet(file, 'clerk', 'staging', 'qa-01'), { set: 'env', names: { user: 'CAW_CLERK_USER__STAGING', password: 'CAW_CLERK_PASSWORD__STAGING', totp: 'CAW_CLERK_TOTP__STAGING' } });
    const both = { ...file, CAW_CLERK_USER__STAGING: 'qa-01', CAW_CLERK_PASSWORD__STAGING: 'y' };
    assert.equal(testUserSet(both, 'clerk', 'staging', 'qa-01').set, 'env', 'the set that applies to staging, in place');
    assert.equal(testUserSet(both, 'clerk', 'staging', 'mia').set, 'env', 'staging has its own set: a different user replaces it, never the default');
    assert.equal(testUserSet(file, 'clerk', undefined, 'other').set, 'default', 'without an environment (explore): the default set');
    assert.equal(testUserSet(file, 'clerk-lead', 'staging-south', 'x').names.user, 'CAW_CLERK_LEAD_USER');
    assert.equal(testUserSet({ CAW_CLERK_LEAD_USER: 'a' }, 'clerk-lead', 'staging-south', 'x').names.user, 'CAW_CLERK_LEAD_USER__STAGING_SOUTH');
});

test('saveTestUser per environment: a second account goes to the set of that environment, values never mixed', (t) => {
    const root = project(t);
    assert.equal(saveTestUser(root, { role: 'tester', user: 'mia', password: 'a', env: 'local' }).set, 'default');
    const second = saveTestUser(root, { role: 'tester', user: 'qa', password: 'b', env: 'staging' });
    assert.deepEqual([second.set, second.names], ['env', ['CAW_TESTER_USER__STAGING', 'CAW_TESTER_PASSWORD__STAGING']]);
    saveTestUser(root, { role: 'tester', user: 'mia', password: 'c', env: 'local' });
    assert.deepEqual(env(root), { CAW_TESTER_USER: 'mia', CAW_TESTER_PASSWORD: 'c', CAW_TESTER_USER__STAGING: 'qa', CAW_TESTER_PASSWORD__STAGING: 'b' });
});

test('saveTestUser without a config: only caw/.env, init adds the role later', (t) => {
    const root = tempDir(t);
    assert.equal(saveTestUser(root, { role: 'tester', user: 'a', password: 'b' }).config, 'none');
    assert.equal(env(root).CAW_TESTER_USER, 'a');
    assert.ok(!existsSync(join(root, 'caw.config.json')));
});

test('suggestRole and hasTestUser', (t) => {
    assert.equal(suggestRole([]), 'tester');
    assert.equal(suggestRole(['tester', 'tester2']), 'tester3');
    const root = project(t);
    const config = loadConfig(root);
    assert.equal(hasTestUser(root, config, 'tester', 'local', {}), false);
    assert.equal(hasTestUser(root, config, 'tester', 'local', { CAW_TESTER_USER: 'a', CAW_TESTER_PASSWORD: 'b' }), true);
    assert.equal(hasTestUser(root, config, 'tester', 'local', { CAW_TESTER_USER__LOCAL: 'a' }), false, 'an incomplete set of the environment counts, not the default');
    assert.equal(hasTestUser(root, config, 'clerk', 'local', {}), false, 'unknown role');
    saveTestUser(root, { role: 'tester', user: 'a', password: 'b' });
    assert.equal(hasTestUser(root, config, 'tester', 'local', {}), true);
    const open = { ...config, environments: { local: { ...config.environments.local, signIn: { type: 'none' } } } };
    assert.equal(hasTestUser(root, open, 'clerk', 'local', {}), true, 'no password needed where nothing signs in');
});

test('role list, remove and target choice', async (t) => {
    const root = project(t, { tester: {}, clerk: {}, 'clerk-lead': {} });
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw/tests/order.yaml'), 'role: tester\nenvironments: [local]\nwrites: false\nsteps:\n  - id: S1\n    name: Open\n    do: Open the start page.\n    expect: The start page is visible.\n');
    saveTestUser(root, { role: 'tester', user: 'a', password: 'b' });
    const overview = roleOverview(root, { env: {} });
    const states = (data) => data.roles.map(({ name, environments, tests }) => [name, environments.map(({ env: at, state }) => `${at}:${state}`), tests]);
    assert.deepEqual(states(overview), [['clerk', ['local:missing'], []], ['clerk-lead', ['local:missing'], []], ['tester', ['local:set'], ['order']]], 'production is never listed');
    assert.deepEqual(overview.roles.find(({ name }) => name === 'clerk').environments[0].missing, ['CAW_CLERK_USER', 'CAW_CLERK_PASSWORD']);
    assert.ok(!JSON.stringify(overview).includes('"a"'), 'never the values');
    assert.throws(() => removeRole(root, 'tester'), /order/);
    saveTestUser(root, { role: 'clerk', user: 'c', password: 'd' });
    saveTestUser(root, { role: 'clerk', user: 'c2', password: 'd2', env: 'staging' });
    saveTestUser(root, { role: 'clerk-lead', user: 'e', password: 'f' });
    assert.deepEqual(removeRole(root, 'clerk').removed, ['CAW_CLERK_USER', 'CAW_CLERK_PASSWORD', 'CAW_CLERK_USER__STAGING', 'CAW_CLERK_PASSWORD__STAGING']);
    assert.equal(loadConfig(root).roles.clerk, undefined);
    assert.equal(env(root).CAW_CLERK_USER, undefined);
    assert.equal(env(root).CAW_CLERK_USER__STAGING, undefined);
    assert.equal(env(root).CAW_CLERK_LEAD_USER, 'e', 'clerk-lead is another role');
    assert.equal(env(root).CAW_TESTER_USER, 'a');
    removeRole(root, 'clerk-lead');
    const config = loadConfig(root);
    assert.equal(roleTarget(config, undefined), 'local', 'the only environment that is not production');
    assert.throws(() => roleTarget(config, 'nowhere'), /Unbekannte Umgebung/);
    // Tenants are environments: two open ones and no single one for Claude means asking; production is never chosen by itself.
    const tenants = {
        ...config,
        environments: { 'north-dev': { url: 'https://n.example.com', claude: true }, 'south-dev': { extends: 'north-dev', url: 'https://s.example.com' }, prod: { url: 'https://n.prod.example.com', production: true } },
    };
    assert.equal(roleTarget(tenants, 'south-dev'), 'south-dev');
    assert.throws(() => roleTarget(tenants, 'dev'), /Unbekannte Umgebung dev\. Bekannt: north-dev, south-dev, prod/);
    assert.throws(() => roleTarget(tenants, undefined), /north-dev, south-dev/, 'two open environments: ask');
    assert.equal(roleTarget({ ...tenants, environments: { 'north-dev': tenants.environments['north-dev'], prod: tenants.environments.prod } }, undefined), 'north-dev');
    const lines = [];
    assert.equal(await roleCommand(root, ['list', '--json'], { out: (line) => lines.push(line) }), 0);
    assert.equal(JSON.parse(lines[0]).roles.length, 1);
    let asked;
    const code = await roleCommand(root, ['add', 'auditor'], { out: () => {}, capture: async (_root, options) => { asked = options; return ['auditor']; } });
    assert.equal(code, 0);
    assert.deepEqual(asked, { target: 'local', role: 'auditor' });
    assert.equal(await roleCommand(root, ['add'], { out: () => {}, capture: async () => [] }), 3);
    await assert.rejects(roleCommand(root, ['add', 'A B'], { out: () => {} }), /Kleinbuchstaben/);
});

test('ensureTestUser: only with a person and only when the test user is missing; a needed role must be saved', async (t) => {
    const root = project(t);
    const config = loadConfig(root);
    let calls = 0;
    const capture = async (_root, options) => { calls += 1; assert.equal(options.needed, true); assert.match(options.reason, /order/); return [options.role]; };
    assert.equal(await ensureTestUser(root, config, { role: 'tester', target: 'local', test: 'order', interactive: false, capture }), false);
    assert.equal(calls, 0, 'nobody there to sign in');
    assert.equal(await ensureTestUser(root, config, { role: 'clerk', target: 'local', test: 'order', interactive: true, capture }), true);
    assert.equal(calls, 1);
    await assert.rejects(ensureTestUser(root, config, { role: 'clerk', target: 'local', test: 'order', interactive: true, capture: async () => [] }), { code: 'credentials-missing' });
    saveTestUser(root, { role: 'tester', user: 'a', password: 'b' });
    assert.equal(await ensureTestUser(root, config, { role: 'tester', target: 'local', test: 'order', interactive: true, capture }), false);
    assert.equal(calls, 1, 'already has a test user');
});

test('record: a test plan with a new role opens the sign-in window first, then the role exists', async (t) => {
    const { record } = await import('../src/host/commands.mjs');
    const root = project(t);
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw/tests/review.yaml'), 'role: clerk\nenvironments: [local]\nwrites: false\nsteps:\n  - id: S1\n    name: Open\n    do: Open the review list.\n    expect: The review list is visible.\n');
    t.mock.method(console, 'log', () => {});
    const stop = new Error('stop after the window');
    let asked;
    const captureTestUsers = async (dir, options) => {
        asked = options;
        saveTestUser(dir, { role: options.role, user: 'clerk1', password: 'pw' });
        return [options.role];
    };
    // The run would go on to Claude; a failing sandbox ends it right after the role was saved.
    await assert.rejects(record(root, ['review', '--env', 'local', '--agent', 'docker'], { interactive: true, captureTestUsers, docker: { label: 'x', hasToken: async () => { throw stop; } } }), (error) => error === stop);
    assert.equal(asked.role, 'clerk');
    assert.equal(asked.needed, true);
    assert.deepEqual(loadConfig(root).roles.clerk, {});
    assert.equal(env(root).CAW_CLERK_USER, 'clerk1');
});

test('sessionFollowsOwnPlan: only the session, only read-only, only the plan it wrote', async () => {
    const { sessionFollowsOwnPlan } = await import('../src/host/test-plan.mjs');
    const steps = [{ id: 'S1', name: 'Open', do: 'Open the list.', expect: 'The list is visible.' }];
    const previous = { writes: false, steps };
    const same = { writes: false, steps: steps.map((step) => ({ ...step })) };
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous, proposed: same }), true);
    assert.equal(sessionFollowsOwnPlan({ agent: 'local', previous, proposed: same }), false, 'own Claude: card as always');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous: undefined, proposed: same }), false, 'new test from a demonstration');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous: { ...previous, writes: true }, proposed: { ...same, writes: true } }), false, 'writing test');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous, proposed: { writes: false, steps: [{ ...steps[0], expect: 'Something else.' }] } }), false, 'changed plan');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous, proposed: { writes: false, steps: [...steps, { id: 'S2', name: 'x', do: 'y', expect: 'z' }] } }), false, 'added step');
});

test('roleRounds: a role named on the command line is saved right after the sign-in, without asking for the name', async (t) => {
    const root = project(t);
    const phases = [];
    const capture = { credentials: { user: 'mia', password: 'pw' }, onRole: null, onNext: null };
    const saved = await roleRounds({ root, page: null, capture, setPhase: async (detail) => { phases.push(detail); }, signOut: async () => {}, givenRole: 'member', closed: new Promise(() => {}) });
    assert.deepEqual(saved, ['member']);
    assert.deepEqual(phases, [{ phase: 'done', role: 'member' }], 'no role card');
    assert.equal(env(root).CAW_MEMBER_USER, 'mia');
});
