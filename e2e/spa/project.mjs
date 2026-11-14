// The project around the spa fixture (e2e/spa/serve.mjs): config with one environment per host name, two tests with
// recordings written by hand as `record` writes them, and the fictitious test users in caw/.env (default set, a set for the
// Keycloak environment ci and one for the tenant south-ci). writeProject() rewrites everything before a group.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseTest, recordingPath, stepHash, testPath, writeTest } from '../../src/host/test-file.mjs';

export const SPA_PORT = 18080;
const http = (host) => `http://${host}.localhost:${SPA_PORT}`;
const button = (name) => `getByRole('button', { name: '${name}', exact: true })`;

/** The sign-in on ci: through Keycloak, which the app redirects to (its host is allowed as a navigation host). */
export const KEYCLOAK_SIGN_IN = {
    type: 'form',
    path: '/login',
    signedInSelector: '#user-menu',
    steps: [{ fill: '#username', with: 'user' }, { fill: '#password', with: 'password' }, { click: '#kc-login' }],
};

/** Every environment the fixture serves; scenarios pick the ones they need. */
export const ENVIRONMENTS = {
    local: { url: http('app'), claude: true, writable: true },
    staging: { url: http('staging'), claude: true },
    ci: { url: http('ci'), writable: true, allowHosts: ['idp.localhost'], signIn: KEYCLOAK_SIGN_IN },
    'north-ci': { url: http('north'), writable: true },
    'south-ci': { extends: 'north-ci', url: http('south') },
    gated: { url: 'https://gate.localhost:18443', writable: true, insecureTls: true, signIn: { type: 'basic', signedInSelector: '#user-menu' } },
    tls: { url: 'https://tls.localhost:18444', writable: true },
    // A Basic gate in front of the form sign-in; its account is CAW_GATE_USER / CAW_GATE_PASSWORD.
    gateform: { url: 'https://gateform.localhost:18443', writable: true, insecureTls: true, gate: { type: 'basic' } },
};

export const baseConfig = (environments = ENVIRONMENTS) => ({
    language: 'en',
    framework: 'web',
    start: '/',
    environments,
    signIn: { type: 'form', path: '/login', userSelector: '#user', passwordSelector: '#password', signedInSelector: '#user-menu' },
    roles: { clerk: {}, admin: {} },
});

/** The test users, fictitious: the default set, ci's Keycloak accounts and the own accounts of the tenant south-ci. */
export const ENV_FILE = [
    'CAW_CLERK_USER=clerk.e2e', 'CAW_CLERK_PASSWORD=clerk-pw-e2e',
    'CAW_ADMIN_USER=admin.e2e', 'CAW_ADMIN_PASSWORD=admin-pw-e2e',
    'CAW_CLERK_USER__CI=qa.clerk', 'CAW_CLERK_PASSWORD__CI=qa-clerk-pw-e2e',
    'CAW_ADMIN_USER__CI=qa.admin', 'CAW_ADMIN_PASSWORD__CI=qa-admin-pw-e2e',
    'CAW_CLERK_USER__SOUTH_CI=south.clerk', 'CAW_CLERK_PASSWORD__SOUTH_CI=south-pw-e2e',
    'CAW_ADMIN_USER__SOUTH_CI=south.admin', 'CAW_ADMIN_PASSWORD__SOUTH_CI=south-admin-pw-e2e',
    'CAW_GATE_USER=gate.e2e', 'CAW_GATE_PASSWORD=gate-pw-e2e',
].join('\n');

/** The tests: steps with name, expect, actions (as in the recording file) and check. */
export const TESTS = {
    // A clerk sees the list but cannot create.
    'see-tickets': {
        role: 'clerk',
        writes: false,
        steps: [{ name: 'Open the list', expect: 'The ticket list is there, without "New ticket".', actions: [{ 'wait-ready': {} }], check: "document.body.dataset.loaded==='true'&&document.querySelector('h1').textContent==='Tickets'&&!document.getElementById('new')" }],
    },
    // An admin creates a ticket.
    'create-ticket': {
        role: 'admin',
        writes: true,
        steps: [{
            name: 'Create a ticket',
            expect: 'The new ticket is in the list.',
            actions: [
                { click: button('New ticket'), path: '/' },
                { fill: "getByRole('textbox', { name: 'Title', exact: true })", value: 'Ticket {{runTag}}', path: '/' },
                { click: button('Save'), path: '/' },
            ],
            check: "document.getElementById('status').textContent==='Saved'&&document.querySelectorAll('#tickets li').length>0",
        }],
    },
};

/** The single-file text of a test (description and recording), as parseTest reads it. */
const testText = (id, { role, writes, steps, environments }) => {
    const lines = [`id: ${id}`, `role: ${role}`, `writes: ${writes}`, ...(environments === undefined ? [] : [`environments: [${environments.join(', ')}]`]), 'steps:'];
    steps.forEach((step, index) => {
        const plain = { id: `S${index + 1}`, name: step.name, do: '', expect: step.expect };
        lines.push(
            `  - id: ${plain.id}`, `    name: ${JSON.stringify(plain.name)}`, '    do: ""', `    expect: ${JSON.stringify(plain.expect)}`,
            '    recording:', `      hash: ${stepHash(plain)}`, ...(index === 0 ? [] : [`      after: S${index}`]),
            '      recordedOn: local', '      recordedAt: 2026-11-14T10:00:00.000Z', '      locale: en-US', '      timezone: Europe/Berlin',
            '      viewport: { width: 1280, height: 800 }',
            '      actions:', ...step.actions.map((action) => `        - ${JSON.stringify(action)}`),
            `      check: ${JSON.stringify(step.check)}`,
        );
    });
    lines.push('knownMessages:', '  - "Saved"');
    return `${lines.join('\n')}\n`;
};

/** Writes one test (optionally with listed environments), replacing what is there. */
export const writeSpaTest = (root, id, extra = {}) => {
    rmSync(testPath(root, id), { force: true });
    rmSync(recordingPath(root, id), { force: true });
    writeTest(root, { ...parseTest(testText(id, { ...TESTS[id], ...extra }), id), id });
};

/** The whole project: config, caw/.env and every test; runs and sessions of earlier runs removed. */
export const writeProject = (root, config = baseConfig()) => {
    rmSync(join(root, '.caw'), { recursive: true, force: true });
    rmSync(join(root, 'caw'), { recursive: true, force: true });
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify(config, null, 4)}\n`);
    writeFileSync(join(root, 'caw/.env'), `${ENV_FILE}\n`);
    for (const id of Object.keys(TESTS)) writeSpaTest(root, id);
};
