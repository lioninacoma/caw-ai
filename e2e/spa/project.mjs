// The project around the spa fixture (e2e/spa/serve.mjs): config with one environment per host name, two tests with
// recordings written by hand as `record` writes them, and the fictitious test users in caw/.env (default set, a set for the
// Keycloak environment ci and one for the tenant south-ci). writeProject() rewrites everything before a group.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The environments of the network scenarios (P3): third-party content, a production stack and the server-rendered notes app. */
export const NETWORK_ENVIRONMENTS = {
    local: ENVIRONMENTS.local,
    staging: ENVIRONMENTS.staging,
    tp: { url: http('tp'), writable: true },
    tpfault: { url: http('tpfault'), writable: true },
    prod: { url: 'http://prod.localhost:18081', production: true },
    mpa: { url: 'http://mpa.localhost:18000', writable: true },
    'mpa-staging': { url: 'http://mpa-staging.localhost:18000' },
};

/** Ports of the environments caw starts itself (P4): life detaches, dev2 runs in the foreground, 18513 never answers. */
export const LIFECYCLE_PORTS = { life: 18512, dev2: 18511, never: 18513 };
const ctl = (args) => `node ../ctl.mjs ${args}`;
/**
 * The environments of the lifecycle scenarios (P4), with the commands a team would write: life like docker compose up -d --wait /
 * down / exec seed, dev2 like npm run dev, broken and never as starts that fail or never get ready, badreset with a failing
 * reset, and the backend faults cold, flaky and abortive on the shared server.
 */
export const LIFECYCLE_ENVIRONMENTS = {
    local: ENVIRONMENTS.local,
    life: { url: 'http://life.localhost:18512', writable: true, start: ctl('up 18512'), stop: ctl('down 18512'), reset: ctl('reset 18512'), ready: { path: '/healthz' } },
    dev2: { url: 'http://dev2.localhost:18511', writable: true, start: 'node ../serve.mjs 18511 --only', ready: { path: '/healthz', timeoutMs: 20000 } },
    broken: { url: 'http://broken.localhost:18513', writable: true, start: ctl('fail') },
    never: { url: 'http://never.localhost:18513', writable: true, start: ctl('hang'), ready: { timeoutMs: 3000 } },
    badreset: { url: http('north'), writable: true, reset: ctl('fail') },
    cold: { url: http('cold'), writable: true },
    flaky: { url: http('flaky'), writable: true },
    abortive: { url: http('abortive'), writable: true },
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


const textbox = (name) => `getByRole('textbox', { name: '${name}', exact: true })`;
const link = (name) => `getByRole('link', { name: '${name}', exact: true })`;
/** The network scenarios' tests (P3): GraphQL, search, third-party content, blocked navigation, production, the notes app. */
export const NETWORK_TESTS = {
    'gql-list': { role: 'clerk', writes: false, steps: [{ name: 'Load via GraphQL', expect: 'The list is loaded.', actions: [{ click: button('Load via GraphQL'), path: '/' }], check: "document.getElementById('status').textContent.startsWith('Loaded')" }] },
    'gql-close': { role: 'clerk', writes: false, steps: [{ name: 'Close the first ticket', expect: 'It says Closed.', actions: [{ click: button('Close first'), path: '/' }], check: "document.getElementById('status').textContent==='Closed'" }] },
    'gql-persisted': { role: 'clerk', writes: false, steps: [{ name: 'Refresh by persisted query', expect: 'The list is loaded.', actions: [{ click: button('Refresh'), path: '/' }], check: "document.getElementById('status').textContent.startsWith('Loaded')" }] },
    search: { role: 'clerk', writes: false, steps: [{ name: 'Search', expect: 'The search answers.', actions: [{ fill: textbox('Search'), value: 'x', path: '/' }, { click: button('Search'), path: '/' }], check: "document.getElementById('status').textContent.startsWith('Found')" }] },
    'third-party': { role: 'clerk', writes: false, steps: [{ name: 'Open the page', expect: 'CDN script and payment widget are there.', actions: [{ 'wait-ready': {} }], check: "window.widgetLoaded===true&&!!document.getElementById('pay')" }] },
    'leave-link': { role: 'clerk', writes: false, steps: [{ name: 'Follow the foreign link', expect: 'Still on the app.', actions: [{ click: link('Elsewhere'), path: '/' }], check: "location.hostname.startsWith('tp')" }] },
    'leave-popup': { role: 'clerk', writes: false, steps: [{ name: 'Open the foreign popup', expect: 'Still on the app.', actions: [{ click: button('Popup'), path: '/' }], check: "location.hostname.startsWith('tp')" }] },
    'call-prod': { role: 'clerk', writes: false, steps: [{ name: 'Call production', expect: 'Production is not reached.', actions: [{ click: button('Call production'), path: '/' }], check: "document.getElementById('status').textContent==='Production blocked'" }] },
    'notes-search': { role: 'clerk', writes: false, steps: [{ name: 'Search notes', expect: 'The search answers.', actions: [{ fill: textbox('Search'), value: 'x', path: '/' }, { click: button('Search'), path: '/' }], check: "document.getElementById('message').textContent.startsWith('Found')" }] },
    'notes-empty': { role: 'clerk', writes: true, steps: [{ name: 'Add a note without title', expect: 'The note is in the list.', actions: [{ click: button('Add note'), path: '/' }], check: "document.querySelectorAll('#notes li').length>0" }] },
};

/** The lifecycle scenarios' tests (P4): a second writing test, one that fails, one made stale, and one that needs its retry. */
export const LIFECYCLE_TESTS = {
    'create-second': { ...TESTS['create-ticket'] },
    'fail-one': { role: 'clerk', writes: false, steps: [{ name: 'Open the list', expect: 'The page is called Nope.', actions: [{ 'wait-ready': {} }], check: "document.title==='Nope'" }] },
    'stale-one': { ...TESTS['see-tickets'] },
    'search-cold': { ...NETWORK_TESTS.search, steps: NETWORK_TESTS.search.steps.map((step) => ({ ...step, retry: { times: 2, waitMs: 500 } })) },
};

/** The single-file text of a test (description and recording), as parseTest reads it. */
const testText = (id, { role, writes, steps, environments }) => {
    const lines = [`id: ${id}`, `role: ${role}`, `writes: ${writes}`, ...(environments === undefined ? [] : [`environments: [${environments.join(', ')}]`]), 'steps:'];
    steps.forEach((step, index) => {
        const plain = { id: `S${index + 1}`, name: step.name, do: '', expect: step.expect };
        lines.push(
            `  - id: ${plain.id}`, `    name: ${JSON.stringify(plain.name)}`, '    do: ""', `    expect: ${JSON.stringify(plain.expect)}`,
            ...(step.retry === undefined ? [] : [`    retry: ${JSON.stringify(step.retry)}`]),
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
    writeTest(root, { ...parseTest(testText(id, { ...(TESTS[id] ?? NETWORK_TESTS[id] ?? LIFECYCLE_TESTS[id]), ...extra }), id), id });
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

/** The network scenarios' tests, written only for them: elsewhere --all would run them on every environment. */
export const writeNetworkTests = (root) => { for (const id of Object.keys(NETWORK_TESTS)) writeSpaTest(root, id); };
export const removeNetworkTests = (root) => {
    for (const id of Object.keys(NETWORK_TESTS)) {
        rmSync(testPath(root, id), { force: true });
        rmSync(recordingPath(root, id), { force: true });
    }
};

/** The lifecycle scenarios' tests, written only for them (as the network tests). */
export const removeLifecycleTests = (root) => {
    for (const id of Object.keys(LIFECYCLE_TESTS)) {
        rmSync(testPath(root, id), { force: true });
        rmSync(recordingPath(root, id), { force: true });
    }
};

/** Makes a test stale: its plan's expected result changes, its recording stays (needs recording, exit 4). */
export const makeStale = (root, id) => {
    const path = testPath(root, id);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/expect: .*/, 'expect: "The list is there, sorted by date."'));
};
