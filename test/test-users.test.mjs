// Roles and test users: caw adds roles and lists the variable names, the human fills caw/.env by hand; caw never writes values.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { removeRole, roleCommand, roleOverview } from '../src/host/role-command.mjs';
import { addRole, ignoreEnvFile, roleVariables } from '../src/host/test-users.mjs';
import { loadConfig } from '../src/shared/config.mjs';

const tempDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-users-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const project = (t, roles = { tester: {} }, signIn = { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#me' }) => {
    const root = tempDir(t);
    writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify({
        environments: { local: { url: 'http://localhost:5173', claude: true, writable: true }, prod: { url: 'https://example.com', production: true } },
        signIn,
        start: '/',
        roles,
    }, null, 4)}\n`);
    return root;
};
const writeEnv = (root, text) => {
    mkdirSync(join(root, 'caw'), { recursive: true });
    writeFileSync(join(root, 'caw/.env'), text);
};

test('role add: the role in the config, its names in caw/.env.example, caw/.env in .gitignore; caw/.env is never written', (t) => {
    const root = project(t);
    writeEnv(root, '# mine\nOTHER=1\n');
    const before = readFileSync(join(root, 'caw/.env'), 'utf8');
    const added = addRole(root, 'clerk-2');
    assert.deepEqual([added.config, added.variables, added.gitignore], ['added', ['CAW_CLERK_2_USER', 'CAW_CLERK_2_PASSWORD'], true]);
    assert.deepEqual(loadConfig(root).roles['clerk-2'], {}, 'a role is an empty object');
    assert.equal(readFileSync(join(root, 'caw/.env'), 'utf8'), before, 'caw/.env untouched');
    const example = readFileSync(join(root, 'caw/.env.example'), 'utf8');
    assert.match(example, /^CAW_CLERK_2_USER=$/m);
    assert.match(example, /^CAW_CLERK_2_PASSWORD=$/m);
    // Again: nothing doubled, the role is known.
    assert.equal(addRole(root, 'clerk-2').config, 'present');
    assert.equal(readFileSync(join(root, 'caw/.env.example'), 'utf8').match(/CAW_CLERK_2_USER=/g).length, 1);
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8').match(/caw\/\.env/g).length, 1);
    assert.equal(ignoreEnvFile(root), false);
    assert.throws(() => addRole(root, 'Bad Name'), /Kleinbuchstaben/);
});

test('role variables: one-time code where a sign-in asks for it, none where nothing signs in with a password', (t) => {
    const totp = loadConfig(project(t, { tester: {} }, { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', codeSelector: '#otp', signedInSelector: '#me' }));
    assert.deepEqual(roleVariables(totp, 'clerk'), ['CAW_CLERK_USER', 'CAW_CLERK_PASSWORD', 'CAW_CLERK_TOTP']);
    assert.deepEqual(roleVariables({ environments: { local: { url: 'http://localhost:5173' } }, signIn: { type: 'none' } }, 'clerk'), []);
});

test('role list, remove: never values; remove leaves caw/.env as it is and names what is left there', async (t) => {
    const root = project(t, { tester: {}, clerk: {}, 'clerk-lead': {} });
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw/tests/order.yaml'), 'role: tester\nenvironments: [local]\nwrites: false\nsteps:\n  - id: S1\n    name: Open\n    do: Open the start page.\n    expect: The start page is visible.\n');
    writeEnv(root, 'CAW_TESTER_USER=a\nCAW_TESTER_PASSWORD=b\nCAW_CLERK_USER=c\nCAW_CLERK_PASSWORD=d\nCAW_CLERK_USER__STAGING=c2\nCAW_CLERK_LEAD_USER=e\n');
    const envBefore = readFileSync(join(root, 'caw/.env'), 'utf8');
    const overview = roleOverview(root, { env: {} });
    const states = (data) => data.roles.map(({ name, environments, tests }) => [name, environments.map(({ env: at, state }) => `${at}:${state}`), tests]);
    assert.deepEqual(states(overview), [['clerk', ['local:set'], []], ['clerk-lead', ['local:missing'], []], ['tester', ['local:set'], ['order']]], 'production is never listed');
    assert.deepEqual(overview.roles.find(({ name }) => name === 'clerk-lead').environments[0].missing, ['CAW_CLERK_LEAD_PASSWORD']);
    assert.ok(!/"[abcde]2?"/.test(JSON.stringify(overview)), 'never the values');
    assert.throws(() => removeRole(root, 'tester'), /order/);
    assert.deepEqual(removeRole(root, 'clerk').leftInEnv, ['CAW_CLERK_USER', 'CAW_CLERK_PASSWORD', 'CAW_CLERK_USER__STAGING'], 'clerk-lead is another role');
    assert.equal(loadConfig(root).roles.clerk, undefined);
    assert.equal(readFileSync(join(root, 'caw/.env'), 'utf8'), envBefore, 'caw/.env untouched');
    const lines = [];
    assert.equal(await roleCommand(root, ['list', '--json'], { out: (line) => lines.push(line) }), 0);
    assert.equal(JSON.parse(lines[0]).roles.length, 2);
    t.mock.method(console, 'log', () => {});
    assert.equal(await roleCommand(root, ['add', 'auditor'], { out: () => {} }), 0);
    assert.deepEqual(loadConfig(root).roles.auditor, {});
    await assert.rejects(roleCommand(root, ['add'], { out: () => {} }), /Aufruf: caw role/, 'the name is required');
    await assert.rejects(roleCommand(root, ['add', 'x', '--env', 'local'], { out: () => {} }), /Aufruf: caw role/, 'add has no environment: no window');
    await assert.rejects(roleCommand(root, ['add', 'A B'], { out: () => {} }), /Kleinbuchstaben/);
});

test('record and run: a role without a test user stops with credentials-missing naming the variables, no window', async (t) => {
    const { record } = await import('../src/host/commands.mjs');
    const root = project(t, { tester: {}, clerk: {} });
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw/tests/review.yaml'), 'role: clerk\nenvironments: [local]\nwrites: false\nsteps:\n  - id: S1\n    name: Open\n    do: Open the review list.\n    expect: The review list is visible.\n');
    t.mock.method(console, 'log', () => {});
    await assert.rejects(
        record(root, ['review', '--env', 'local', '--agent', 'docker'], { interactive: true, docker: { label: 'x', hasToken: async () => true } }),
        (error) => error.code === 'credentials-missing' && /CAW_CLERK_USER, CAW_CLERK_PASSWORD/.test(error.message),
    );
    assert.ok(!existsSync(join(root, 'caw/.env')), 'nothing written');
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
