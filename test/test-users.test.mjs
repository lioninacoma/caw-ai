// Test users as roles: caw/.env writing, quoting, .gitignore, config, `caw-ai role` and the window before record/run.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseEnvFile } from '../src/host/linux.mjs';
import { ensureTestUser, hasTestUser } from '../src/host/role-capture.mjs';
import { removeRole, roleCommand, roleOverview, roleTarget } from '../src/host/role-command.mjs';
import { envLiteral, ignoreEnvFile, roleEnvNames, saveTestUser, suggestRole } from '../src/host/test-users.mjs';
import { loadConfig } from '../src/shared/config.mjs';

const tempDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-users-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const project = (t, roles = { tester: { loginEnv: 'CAW_LOGIN_TESTER', passwordEnv: 'CAW_PW_TESTER' } }) => {
    const root = tempDir(t);
    writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify({
        environments: { local: { url: 'http://localhost:5173', claude: true, writable: true }, prod: { url: 'https://example.com', production: true } },
        auth: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#me' },
        apps: { web: { dir: '.', startUrl: '/' } },
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
    writeFileSync(join(root, 'caw/.env'), '# mine\nOTHER=1\nCAW_PW_TESTER=old\n');
    const first = saveTestUser(root, { role: 'tester', user: 'mia', password: "it's secret" });
    assert.deepEqual([first.loginEnv, first.passwordEnv, first.config], ['CAW_LOGIN_TESTER', 'CAW_PW_TESTER', 'present']);
    assert.deepEqual(env(root), { OTHER: '1', CAW_PW_TESTER: "it's secret", CAW_LOGIN_TESTER: 'mia' });
    assert.ok(readFileSync(join(root, 'caw/.env'), 'utf8').startsWith('# mine\n'));
    const second = saveTestUser(root, { role: 'clerk-2', user: 'ben', password: 'pw' });
    assert.equal(second.config, 'added');
    assert.deepEqual(loadConfig(root).roles['clerk-2'], roleEnvNames('clerk-2'));
    assert.equal(env(root).CAW_LOGIN_CLERK_2, 'ben');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8').match(/caw\/\.env/g).length, 1);
    assert.equal(ignoreEnvFile(root), false);
    assert.throws(() => saveTestUser(root, { role: 'Bad Name', user: 'x', password: 'y' }), /Kleinbuchstaben/);
    assert.throws(() => saveTestUser(root, { role: 'ok', user: '', password: 'y' }), /kein Benutzername/);
});

test('saveTestUser without a config: only caw/.env, init adds the role later', (t) => {
    const root = tempDir(t);
    assert.equal(saveTestUser(root, { role: 'tester', user: 'a', password: 'b' }).config, 'none');
    assert.equal(env(root).CAW_LOGIN_TESTER, 'a');
    assert.ok(!existsSync(join(root, 'caw.config.json')));
});

test('suggestRole and hasTestUser', (t) => {
    assert.equal(suggestRole([]), 'tester');
    assert.equal(suggestRole(['tester', 'tester2']), 'tester3');
    const root = project(t);
    const config = loadConfig(root);
    assert.equal(hasTestUser(root, config, 'tester', {}), false);
    assert.equal(hasTestUser(root, config, 'tester', { CAW_LOGIN_TESTER: 'a', CAW_PW_TESTER: 'b' }), true);
    assert.equal(hasTestUser(root, config, 'clerk', {}), false, 'unknown role');
    saveTestUser(root, { role: 'tester', user: 'a', password: 'b' });
    assert.equal(hasTestUser(root, config, 'tester', {}), true);
});

test('role list, remove and target choice', async (t) => {
    const root = project(t, { tester: roleEnvNames('tester'), clerk: roleEnvNames('clerk') });
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw/tests/order.yaml'), 'app: web\nrole: tester\ntargets: [local]\nmutates: false\nsteps:\n  - id: S1\n    name: Open\n    do: Open the start page.\n    expect: The start page is visible.\n');
    saveTestUser(root, { role: 'tester', user: 'a', password: 'b' });
    const overview = roleOverview(root, { env: {} });
    assert.deepEqual(overview.roles.map(({ name, testUser, tests }) => [name, testUser, tests]), [['clerk', false, []], ['tester', true, ['order']]]);
    assert.ok(!JSON.stringify(overview).includes('"a"'), 'never the values');
    assert.throws(() => removeRole(root, 'tester'), /order/);
    saveTestUser(root, { role: 'clerk', user: 'c', password: 'd' });
    removeRole(root, 'clerk');
    assert.equal(loadConfig(root).roles.clerk, undefined);
    assert.equal(env(root).CAW_LOGIN_CLERK, undefined);
    assert.equal(env(root).CAW_LOGIN_TESTER, 'a');
    const config = loadConfig(root);
    assert.equal(roleTarget(config, undefined), 'local', 'the only environment that is not production');
    assert.throws(() => roleTarget(config, 'nowhere'), /Unbekannte Umgebung/);
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
    writeFileSync(join(root, 'caw/tests/review.yaml'), 'app: web\nrole: clerk\ntargets: [local]\nmutates: false\nsteps:\n  - id: S1\n    name: Open\n    do: Open the review list.\n    expect: The review list is visible.\n');
    t.mock.method(console, 'log', () => {});
    const stop = new Error('stop after the window');
    let asked;
    const captureTestUsers = async (dir, options) => {
        asked = options;
        saveTestUser(dir, { role: options.role, user: 'clerk1', password: 'pw' });
        return [options.role];
    };
    // The run would go on to Claude; a failing sandbox ends it right after the role was saved.
    await assert.rejects(record(root, ['review', '--target', 'local', '--agent', 'docker'], { interactive: true, captureTestUsers, docker: { label: 'x', hasToken: async () => { throw stop; } } }), (error) => error === stop);
    assert.equal(asked.role, 'clerk');
    assert.equal(asked.needed, true);
    assert.deepEqual(loadConfig(root).roles.clerk, roleEnvNames('clerk'));
});

test('sessionFollowsOwnPlan: only the session, only read-only, only the plan it wrote', async () => {
    const { sessionFollowsOwnPlan } = await import('../src/host/test-plan.mjs');
    const steps = [{ id: 'S1', name: 'Open', do: 'Open the list.', expect: 'The list is visible.' }];
    const previous = { mutates: false, steps };
    const same = { mutates: false, steps: steps.map((step) => ({ ...step })) };
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous, proposed: same }), true);
    assert.equal(sessionFollowsOwnPlan({ agent: 'local', previous, proposed: same }), false, 'own Claude: card as always');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous: undefined, proposed: same }), false, 'new test from a demonstration');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous: { ...previous, mutates: true }, proposed: { ...same, mutates: true } }), false, 'writing test');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous, proposed: { mutates: false, steps: [{ ...steps[0], expect: 'Something else.' }] } }), false, 'changed plan');
    assert.equal(sessionFollowsOwnPlan({ agent: 'session', previous, proposed: { mutates: false, steps: [...steps, { id: 'S2', name: 'x', do: 'y', expect: 'z' }] } }), false, 'added step');
});
