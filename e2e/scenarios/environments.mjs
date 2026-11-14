// P2 core model against the spa fixture (e2e/spa): environment choice (S8), sign-in and test users per environment with Keycloak
// (A5), HTTP Basic and a gate (A6), several roles (A9), TLS and http exceptions (D6), tenants as environments (D7) and setup
// with the packed CLI (B2). No Claude: the tests carry recordings written by hand and run headless.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { ENVIRONMENTS, ENV_FILE, NETWORK_ENVIRONMENTS, SPA_PORT, baseConfig, writeProject, writeSpaTest } from '../spa/project.mjs';
import { here, newestRunOf, print, run, runDirsOf, startServer, verify } from '../harness.mjs';
import { composeStack, exec, httpAlias, installPacked, preflightPorts } from '../infra.mjs';

const spaDir = join(here, 'spa');
const root = join(spaDir, 'work');
const { validate } = await import('../../src/host/commands.mjs');
const { loadConfigWithNotes, validateConfig } = await import('../../src/shared/config.mjs');
const { effectiveEnvironment } = await import('../../src/shared/environments.mjs');
const { exitOf } = await import('../../src/shared/errors.mjs');
const { listProject } = await import('../../src/host/project-data.mjs');
const { roleCommand, roleOverview } = await import('../../src/host/role-command.mjs');
const { sessionTools } = await import('../../src/host/session-mcp.mjs');

let server = null;
const startSpa = async () => {
    await preflightPorts([SPA_PORT, 18443, 18444, 18081, 18000, 18090]);
    server = await startServer(join(spaDir, 'serve.mjs'), [String(SPA_PORT)], { cwd: spaDir, port: SPA_PORT });
};
const stopSpa = () => { server?.kill(); server = null; };
const spa = { language: 'en', setup: async () => { writeProject(root); await startSpa(); }, teardown: async () => stopSpa() };
const idpStack = composeStack('idp', join(here, 'stacks/idp/compose.yaml'));
// Keycloak takes about 40 s to start: only the scenario that signs in through it brings it up.
const idp = {
    language: 'en',
    setup: async () => {
        writeProject(root);
        await preflightPorts([18180]);
        await idpStack.up();
        await startSpa();
    },
    teardown: async () => {
        stopSpa();
        await idpStack.down();
    },
};
export const scenarios = [];
// Every scenario starts from the whole config and the test users as written; a scenario's own changes end with it.
const fresh = () => {
    setConfig(baseConfig());
    writeFileSync(join(root, 'caw/.env'), `${ENV_FILE}\n`);
    for (const id of ['see-tickets', 'create-ticket']) writeSpaTest(root, id);
};
const scenario = (id, title, group, body, extra = {}) => scenarios.push({ id, title, group, body: async () => { fresh(); await body(); }, ...extra });

/** Everything caw prints while fn runs, plus fn's result. */
const captured = async (fn) => {
    const chunks = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => { chunks.push(String(chunk)); return write.call(process.stdout, chunk, ...rest); };
    try {
        return { value: await fn(), output: chunks.join('') };
    } finally {
        process.stdout.write = write;
    }
};
/** `caw run` headless without chat, as in CI: the exit code, and for an error its code and message (thrown or printed). */
const go = async (args, { env = {} } = {}) => {
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
        const { value, output } = await captured(() => run(root, [...args, '--headless', '--step-timeout', '5s']).then(
            (code) => ({ exit: code }),
            (error) => ({ exit: exitOf(error.code), code: error.code, message: String(error.message) }),
        ));
        // A run that ends in an error returns its exit code and prints the error line: "<test> on <env>: error (<message>) (code: <code>, exit <n>)".
        const line = value.code === undefined ? /: error \((.*)\) \(code: ([\w-]+), exit \d+\)/.exec(output) : null;
        return { ...value, ...(line === null ? {} : { message: line[1], code: line[2] }), output };
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};
const setConfig = (config) => writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify(config, null, 4)}\n`);
const failNote = (id) => (runDirsOf(root, id).length === 0 ? 'no run folder' : (newestRunOf(root, id).result?.results ?? []).find(({ status }) => status !== 'pass')?.note ?? '');
const shown = (result) => `${result.exit} ${result.code ?? ''} ${(result.message ?? '').split('\n')[0]}`;

/** The texts of every file in a zip (the run's trace), inflated; enough for a search, no other zip feature. */
const zipTexts = (file) => {
    const buffer = readFileSync(file);
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return '';
    let at = buffer.readUInt32LE(end + 16);
    const count = buffer.readUInt16LE(end + 10);
    const texts = [];
    for (let index = 0; index < count; index += 1) {
        const method = buffer.readUInt16LE(at + 10);
        const size = buffer.readUInt32LE(at + 20);
        const nameLength = buffer.readUInt16LE(at + 28);
        const extra = buffer.readUInt16LE(at + 30);
        const comment = buffer.readUInt16LE(at + 32);
        const local = buffer.readUInt32LE(at + 42);
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const raw = buffer.subarray(start, start + size);
        texts.push((method === 8 ? inflateRawSync(raw) : raw).toString('latin1'));
        at += 46 + nameLength + extra + comment;
    }
    return texts.join('\n');
};

// ---- S8: which environment a run takes, and where a test runs

const S8_ENVIRONMENTS = { local: ENVIRONMENTS.local, staging: ENVIRONMENTS.staging, qa: { url: `http://north.localhost:${SPA_PORT}`, writable: true } };

scenario('S8', 'Environment selection: the only Claude environment, ambiguity names the candidates, CI never guesses, --all per environment', spa, async () => {
    setConfig(baseConfig(S8_ENVIRONMENTS));
    // The harness runs as CI; the choice by Claude environment is for a developer's machine.
    const outsideCi = { env: { CI: '' } };
    const writing = await go(['create-ticket'], outsideCi);
    verify('(1) a writing test runs on the only Claude environment among its candidates', writing.exit === 0 && newestRunOf(root, 'create-ticket').result?.target === 'local', shown(writing));
    verify('(1) and says why', /Environment: local/.test(writing.output), writing.output.split('\n').find((line) => /Environment/.test(line)) ?? '');
    const reading = await go(['see-tickets'], outsideCi);
    verify('(2) two Claude environments: exit 3 listing them', reading.exit === 3 && /local/.test(reading.message) && /staging/.test(reading.message) && /qa/.test(reading.message), shown(reading));
    const inCi = await go(['create-ticket'], { env: { CI: '1' } });
    verify('(3) in CI with several candidates: exit 3, no choice by Claude', inCi.exit === 3 && /local/.test(inCi.message) && /qa/.test(inCi.message), shown(inCi));
    const before = runDirsOf(root, 'create-ticket').length;
    const all = await go(['--all', '--env', 'staging']);
    verify('(4) --all on staging runs the read-only test only', all.exit === 0 && runDirsOf(root, 'create-ticket').length === before && newestRunOf(root, 'see-tickets').result?.target === 'staging', shown(all));
    writeSpaTest(root, 'create-ticket', { environments: ['staging'] });
    const invalid = await captured(() => Promise.resolve().then(() => validate(root)).then((code) => ({ exit: code }), (error) => ({ exit: exitOf(error.code), message: error.message })));
    verify('(5) a writing test listing a read-only environment: validate exit 3', invalid.value.exit === 3 && /staging/.test(invalid.value.message ?? ''), `${invalid.value.exit} ${(invalid.value.message ?? '').split('\n').find((line) => /staging/.test(line)) ?? ''}`);
    writeSpaTest(root, 'create-ticket');
    const listed = Object.fromEntries(listProject(root).tests.map(({ id, environments }) => [id, environments]));
    verify('(6) list shows the effective environments', JSON.stringify(listed['see-tickets']) === '["local","staging","qa"]' && JSON.stringify(listed['create-ticket']) === '["local","qa"]', JSON.stringify(listed));
});

// ---- A5: sign-in and test users per environment

scenario('A5', 'Sign-in and test users per environment: form on local, Keycloak steps on ci with the __CI set, never mixed, process env first', idp, async () => {
    const local = await go(['see-tickets', '--env', 'local']);
    verify('(1) local: form sign-in with CAW_CLERK_USER/PASSWORD', local.exit === 0, shown(local));
    const ci = await go(['see-tickets', '--env', 'ci']);
    verify('(1) ci: Keycloak sign-in by steps with CAW_CLERK_USER__CI/PASSWORD__CI', ci.exit === 0, `${shown(ci)} ${failNote('see-tickets')}`);
    const admin = await go(['create-ticket', '--env', 'ci']);
    verify('(1) ci: the admin creates through Keycloak as well', admin.exit === 0, `${shown(admin)} ${failNote('create-ticket')}`);
    print('     (2) role add in the window: covered by the unit tests of testUserSet and saveTestUser (no window here)');
    const overview = roleOverview(root, { env: {} });
    const clerk = overview.roles.find(({ name }) => name === 'clerk').environments;
    const set = Object.fromEntries(clerk.map(({ env, set: chosen, state }) => [env, `${chosen}:${state}`]));
    verify('(3) per environment which set applies', set.local === 'default:set' && set.ci === 'env:set' && set['south-ci'] === 'env:set', JSON.stringify(set));
    const envFile = join(root, 'caw/.env');
    writeFileSync(envFile, `${ENV_FILE.split('\n').filter((line) => !line.startsWith('CAW_CLERK_PASSWORD__CI=')).join('\n')}\n`);
    const half = await go(['see-tickets', '--env', 'ci']);
    verify('(4) only CAW_CLERK_USER__CI: credentials-missing naming CAW_CLERK_PASSWORD__CI, the default password not mixed in',
        half.code === 'credentials-missing' && /CAW_CLERK_PASSWORD__CI/.test(half.message) && !/CAW_CLERK_USER__CI/.test(half.message), shown(half));
    writeFileSync(envFile, `${ENV_FILE.replace('CAW_CLERK_PASSWORD=clerk-pw-e2e', 'CAW_CLERK_PASSWORD=wrong-in-file')}\n`);
    const fromProcess = await go(['see-tickets', '--env', 'local'], { env: { CAW_CLERK_PASSWORD: 'clerk-pw-e2e' } });
    verify('(5) the process environment wins over caw/.env for the same name', fromProcess.exit === 0, shown(fromProcess));
    const fromFile = await go(['see-tickets', '--env', 'local']);
    verify('(5) without it the wrong password from the file is used and refused', fromFile.exit === 2 && fromFile.code === 'login-failed', shown(fromFile));
    writeFileSync(envFile, `${ENV_FILE}\n`);
});

// ---- A6: HTTP Basic as the sign-in, and a gate in front of a form

scenario('A6', 'HTTP Basic: the sign-in itself and a gate in front of a form; credentials only to the origin, not in the trace', spa, async () => {
    const basic = await go(['create-ticket', '--env', 'gated']);
    verify('signIn.type basic: passes', basic.exit === 0, `${shown(basic)} ${failNote('create-ticket')}`);
    const { dir } = newestRunOf(root, 'create-ticket');
    const traces = readdirSync(dir).filter((name) => /^trace.*\.zip$/.test(name));
    const traceText = traces.map((name) => zipTexts(join(dir, name))).join('\n');
    const secret = Buffer.from('admin.e2e:admin-pw-e2e').toString('base64');
    verify('the trace has neither the password nor the Authorization value', traces.length > 0 && !traceText.includes('admin-pw-e2e') && !traceText.includes(secret), `${traces.length} trace file(s)`);
    const files = readdirSync(dir).filter((name) => /\.(md|json|log)$/.test(name)).map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
    verify('report, result and logs have no password', !files.includes('admin-pw-e2e'));
    const gated = await go(['create-ticket', '--env', 'gateform']);
    verify('a gate in front of a form sign-in: CAW_GATE_* for the gate, the role\'s account for the form', gated.exit === 0, `${shown(gated)} ${failNote('create-ticket')}`);
    writeFileSync(join(root, 'caw/.env'), `${ENV_FILE.split('\n').filter((line) => !line.startsWith('CAW_GATE_')).join('\n')}\n`);
    const noGate = await go(['create-ticket', '--env', 'gateform']);
    verify('without the gate account: credentials-missing naming CAW_GATE_USER', noGate.code === 'credentials-missing' && /CAW_GATE_USER/.test(noGate.message), shown(noGate));
    writeFileSync(join(root, 'caw/.env'), `${ENV_FILE}\n`);
});

// ---- A9: several roles

scenario('A9', 'Several roles: the admin creates, the clerk sees without creating; a role in use cannot be removed', spa, async () => {
    const admin = await go(['create-ticket', '--env', 'local']);
    verify('admin creates a ticket', admin.exit === 0, `${shown(admin)} ${failNote('create-ticket')}`);
    const clerk = await go(['see-tickets', '--env', 'local']);
    verify('clerk sees the list, without "New ticket" (its own account, not the admin\'s)', clerk.exit === 0, `${shown(clerk)} ${failNote('see-tickets')}`);
    const removed = await roleCommand(root, ['remove', 'clerk'], { out: () => {} }).then((code) => ({ exit: code }), (error) => ({ exit: exitOf(error.code), message: error.message }));
    verify('role remove refuses a role a test uses, naming the test', removed.exit === 3 && /see-tickets/.test(removed.message), shown(removed));
    print('     F1 restore across roles: part of the workbench scenarios (N4)');
});

// ---- D6: TLS and http exceptions

scenario('D6', 'TLS: without insecureTls exit 2 naming the switch, with it the run passes; allowHttp on loopback is a note', spa, async () => {
    const strict = await go(['create-ticket', '--env', 'tls']);
    verify('(1) a self-signed certificate: exit 2 naming environments.tls.insecureTls',
        strict.exit === 2 && strict.code === 'env-certificate' && /environments\.tls\.insecureTls: true/.test(strict.message), shown(strict));
    setConfig(baseConfig({ ...ENVIRONMENTS, tls: { ...ENVIRONMENTS.tls, insecureTls: true } }));
    const allowed = await go(['create-ticket', '--env', 'tls']);
    verify('(1) with insecureTls the run passes', allowed.exit === 0, `${shown(allowed)} ${failNote('create-ticket')}`);
    setConfig(baseConfig({ ...ENVIRONMENTS, local: { ...ENVIRONMENTS.local, allowHttp: true } }));
    const { notes, config } = loadConfigWithNotes(root);
    verify('(3) allowHttp on a loopback address: a note, not an error', config !== undefined && notes.some((note) => /allowHttp/.test(note) && /local/.test(note)), notes.join(' | '));
    setConfig(baseConfig());
});

scenario('D6b', 'http beyond this machine: without allowHttp validate exit 3, with it the run passes and warns', spa, async () => {
    const alias = await httpAlias(18082, SPA_PORT);
    try {
        const remote = { url: alias.url, writable: true };
        const issues = validateConfig(baseConfig({ ...ENVIRONMENTS, remote })).issues;
        verify('(2) without allowHttp: the config is invalid', issues.some((issue) => /remote/.test(issue) && /allowHttp/.test(issue)), issues.join(' | '));
        setConfig(baseConfig({ ...ENVIRONMENTS, remote: { ...remote, allowHttp: true } }));
        const result = await go(['create-ticket', '--env', 'remote']);
        verify('(2) with allowHttp: passes', result.exit === 0, `${shown(result)} ${failNote('create-ticket')}`);
        verify('(2) and warns that it is unencrypted', /plain http/.test(result.output), result.output.split('\n').find((line) => /http/.test(line)) ?? '');
    } finally {
        await alias.close();
        setConfig(baseConfig());
    }
}, { optIn: 'CAW_E2E_LAN' });

// ---- D7: tenants as environments

scenario('D7', 'Tenants as environments: south-ci extends north-ci, its own accounts, the effective config; production not inherited, cycles rejected', spa, async () => {
    const north = await go(['see-tickets', '--env', 'north-ci']);
    verify('(1) the test passes on north-ci', north.exit === 0, `${shown(north)} ${failNote('see-tickets')}`);
    const south = await go(['see-tickets', '--env', 'south-ci']);
    verify('(1)(3) and on south-ci, with the CAW_CLERK_*__SOUTH_CI account only south accepts', south.exit === 0, `${shown(south)} ${failNote('see-tickets')}`);
    const writing = await go(['create-ticket', '--env', 'south-ci']);
    verify('(2) south-ci inherits writable and the sign-in', writing.exit === 0 && effectiveEnvironment(baseConfig(), 'south-ci').writable === true, shown(writing));
    const tool = sessionTools({ root }).find(({ name }) => name === 'caw_config');
    const read = await tool.call({ read: true });
    const effective = read.data?.environments?.['south-ci'];
    verify('(4) caw_config read shows the resolved environment', effective?.url === `http://south.localhost:${SPA_PORT}` && effective?.writable === true && effective?.signIn?.type === 'form',
        JSON.stringify(effective ?? Object.keys(read.data ?? {})));
    const prod = baseConfig({ ...ENVIRONMENTS, 'north-prod': { url: 'https://north.example.test', production: true }, 'south-prod': { extends: 'north-prod', url: 'https://south.example.test' } });
    const prodIssues = validateConfig(prod).issues;
    verify('(5) south-prod extending north-prod without production: invalid (production is not inherited)', prodIssues.some((issue) => /south-prod/.test(issue)), prodIssues.join(' | '));
    const cycle = baseConfig({ ...ENVIRONMENTS, 'north-ci': { ...ENVIRONMENTS['north-ci'], extends: 'south-ci' } });
    const cycleIssues = validateConfig(cycle).issues;
    verify('(6) a cycle of extends: invalid', cycleIssues.some((issue) => /north-ci/.test(issue) && /south-ci/.test(issue)), cycleIssues.join(' | '));
});

// ---- B2: setup with the packed CLI, without Claude Code

scenario('B2', 'Setup with the packed CLI: init writes language and environment flags, persists insecureTls, --explore-only writes no config', spa, async () => {
    const project = mkdtempSync(join(tmpdir(), 'caw-e2e-b2-'));
    try {
        await installPacked(project);
        const caw = (dir, args) => exec(process.execPath, [join(project, 'node_modules/caw-ai/bin/caw.mjs'), ...args], { cwd: dir, env: { ...process.env, CAW_LANG: 'en', INIT_CWD: dir, CI: '' } });
        const newDir = () => mkdtempSync(join(project, 'p-'));
        const a = newDir();
        const first = await caw(a, ['init', '--offline', '--url', `http://app.localhost:${SPA_PORT}`, '--language', 'en', '--no-mcp']);
        const config = existsSync(join(a, 'caw.config.json')) ? JSON.parse(readFileSync(join(a, 'caw.config.json'), 'utf8')) : {};
        verify('(a) init: language en, environment local with claude and writable', first.code === 0 && config.language === 'en' && JSON.stringify(config.environments?.local) === `{"url":"http://app.localhost:${SPA_PORT}","claude":true,"writable":true}`, `${first.code} ${JSON.stringify(config.environments)}`);
        verify('(a) .env.example with the naming convention and .gitignore lines', /CAW_TESTER_USER=\nCAW_TESTER_PASSWORD=/.test(readFileSync(join(a, 'caw/.env.example'), 'utf8'))
            && ['caw/.env', 'caw/.auth/'].every((line) => readFileSync(join(a, '.gitignore'), 'utf8').includes(line)));
        const b = newDir();
        const second = await caw(b, ['init', '--url', 'https://tls.localhost:18444', '--insecure-tls', '--env', 'staging', '--yes', '--no-login', '--no-mcp']);
        const staging = existsSync(join(b, 'caw.config.json')) ? JSON.parse(readFileSync(join(b, 'caw.config.json'), 'utf8')).environments?.staging : undefined;
        verify('(b) --insecure-tls is stored on the named environment (a loopback host: claude and writable, SC-15)', second.code === 0 && staging?.insecureTls === true && staging?.claude === true && staging?.writable === true,
            `${second.code} ${JSON.stringify(staging)} ${second.stderr.split('\n').slice(-3).join(' | ')}`);
        const c = newDir();
        const third = await caw(c, ['init', '--explore-only', '--url', `http://app.localhost:${SPA_PORT}`, '--yes', '--no-login']);
        verify('(c) --explore-only writes only caw/.explore.json', third.code === 0 && existsSync(join(c, 'caw/.explore.json')) && !existsSync(join(c, 'caw.config.json')), `${third.code} ${third.stderr.split('\n').slice(-3).join(' | ')}`);
        print('     (d) http beyond this machine: D6b (CAW_E2E_LAN); (e) reads candidates: P3');
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
});

// ---- P3: network and safety

const networkConfig = (extra = {}) => setConfig({ ...baseConfig(NETWORK_ENVIRONMENTS), ...extra });
const resultOf = (id) => newestRunOf(root, id).result ?? {};
const writesOf = (id) => (resultOf(id).writes ?? []).map(({ label }) => label);
const resultText = (id) => JSON.stringify(resultOf(id));

scenario('S9', 'Write classification: GraphQL queries read, a mutation and a persisted query write, reads keeps a POST search read-only', spa, async () => {
    networkConfig();
    const list = await go(['gql-list', '--env', 'staging']);
    verify('(1) only GraphQL queries: passes on read-only staging, no write request (the sign-in POST does not count either)', list.exit === 0 && writesOf('gql-list').length === 0, `${shown(list)} ${JSON.stringify(writesOf('gql-list'))}`);
    const close = await go(['gql-close', '--env', 'local']);
    verify('(2) a mutation is a write, named by type and operation', close.exit === 0 && JSON.stringify(writesOf('gql-close')) === '["POST /graphql mutation CloseTicket"]', `${shown(close)} ${JSON.stringify(writesOf('gql-close'))}`);
    const persisted = await go(['gql-persisted', '--env', 'local']);
    verify('(3) a persisted query without text is named unknown and counts as a write', persisted.exit === 0 && JSON.stringify(writesOf('gql-persisted')) === '["POST /graphql unknown Tickets"]', JSON.stringify(writesOf('gql-persisted')));
    const plain = await go(['search', '--env', 'local']);
    verify('(4) without reads a POST search is a write', plain.exit === 0 && JSON.stringify(writesOf('search')) === '["POST /api/search"]', JSON.stringify(writesOf('search')));
    networkConfig({ reads: ['POST /api/search'] });
    const named = await go(['search', '--env', 'local']);
    verify('(4) with reads ["POST /api/search"] it stays read-only', named.exit === 0 && writesOf('search').length === 0, JSON.stringify(writesOf('search')));
    print('     (2) promotion at adoption uses these write requests; (5) the open stop on a learned mutation: unit tests (replayToEntry)');
});

scenario('M3', 'Server-rendered app: a POST search with reads passes on a read-only environment; a 422 page is evidence', spa, async () => {
    networkConfig({ reads: ['POST /notes/search'] });
    const search = await go(['notes-search', '--env', 'mpa-staging']);
    verify('the search test passes on read-only mpa-staging without a write request', search.exit === 0 && writesOf('notes-search').length === 0, `${shown(search)} ${failNote('notes-search')} ${JSON.stringify(writesOf('notes-search'))}`);
    networkConfig();
    const without = await go(['notes-search', '--env', 'mpa-staging']);
    verify('without the pattern the form post is a write request', without.exit === 0 && JSON.stringify(writesOf('notes-search')) === '["POST /notes/search"]', JSON.stringify(writesOf('notes-search')));
    const empty = await go(['notes-empty', '--env', 'mpa']);
    verify('a page answering 422 is evidence of the failed step (OPEN-12)', empty.exit !== 0 && /POST \/notes/.test(resultText('notes-empty')) && /422/.test(resultText('notes-empty')), `${shown(empty)} ${failNote('notes-empty')}`);
});

scenario('D4', 'Third-party hosts and the host lock: subresources and iframes load and are listed, navigation elsewhere and production are blocked', spa, async () => {
    networkConfig();
    const page = await go(['third-party', '--env', 'tp']);
    verify('(1) CDN style and script, beacon and payment iframe without allowHosts: passes', page.exit === 0, `${shown(page)} ${failNote('third-party')}`);
    const hosts = (resultOf('third-party').thirdParty ?? []).map(({ host }) => host);
    verify('(2) the report lists cdn, pay and stats as third-party hosts', ['cdn.localhost', 'pay.localhost', 'stats.localhost'].every((host) => hosts.includes(host)), JSON.stringify(hosts));
    const report = readFileSync(join(newestRunOf(root, 'third-party').dir, 'report.md'), 'utf8');
    verify('(2) report.md has the table', /## Third-party hosts/.test(report) && /\| cdn\.localhost \|/.test(report));
    verify('(3) the analytics beacon (POST) does not make the test writing', writesOf('third-party').length === 0, JSON.stringify(writesOf('third-party')));
    const link = await go(['leave-link', '--env', 'tp']);
    verify('(4) a link to another host: the step fails with host-blocked naming the host and allowHosts', link.exit === 1 && /host-blocked/.test(resultText('leave-link')) && /elsewhere\.localhost.*allowHosts/.test(resultText('leave-link')), `${shown(link)} ${failNote('leave-link')}`);
    const popup = await go(['leave-popup', '--env', 'tp']);
    verify('(5) window.open to another host: blocked', popup.exit === 1 && /host-blocked/.test(resultText('leave-popup')) && /elsewhere\.localhost/.test(resultText('leave-popup')), `${shown(popup)} ${failNote('leave-popup')}`);
    print('     (6) caw agent goto to another host is refused before navigating: unit test (agent-commands)');
    const prod = await go(['call-prod', '--env', 'tp']);
    verify('(7) an XHR from tp to the production host is blocked and named', /prod\.localhost/.test(resultText('call-prod')) && /host-blocked/.test(resultText('call-prod')), `${shown(prod)} ${failNote('call-prod')}`);
    const fault = await go(['third-party', '--env', 'tpfault']);
    verify('(8) a throwing third-party script is a warning, the run passes', fault.exit === 0 && /widget fault/.test(JSON.stringify(resultOf('third-party').warnings ?? [])), `${shown(fault)} ${failNote('third-party')}`);
});

scenario('D5', 'Production: a read-only test runs there, writing tests and recording are refused, write requests are blocked at runtime', spa, async () => {
    networkConfig();
    writeSpaTest(root, 'see-tickets', { environments: ['local', 'prod'] });
    const read = await go(['see-tickets', '--env', 'prod']);
    verify('a read-only test recorded on local passes on prod', read.exit === 0, `${shown(read)} ${failNote('see-tickets')}`);
    writeSpaTest(root, 'create-ticket', { environments: ['local', 'prod'] });
    const invalid = await captured(() => Promise.resolve().then(() => validate(root)).then((code) => ({ exit: code }), (error) => ({ exit: exitOf(error.code), message: error.message })));
    verify('a writing test listing prod: validate exit 3', invalid.value.exit === 3 && /prod/.test(invalid.value.message ?? ''), `${invalid.value.exit} ${(invalid.value.message ?? '').split('\n')[0]}`);
    writeSpaTest(root, 'create-ticket');
    const cli = (args) => exec(process.execPath, [join(here, '..', 'bin', 'caw.mjs'), ...args], { cwd: root, env: { ...process.env, CAW_LANG: 'en', CI: '' } });
    const record = await cli(['record', 'see-tickets', '--env', 'prod']);
    verify('record --env prod: exit 3', record.code === 3, `${record.code} ${(record.stderr + record.stdout).split('\n').filter(Boolean).slice(-1)[0] ?? ''}`);
    const open = await cli(['open', '--env', 'prod']);
    verify('open --env prod: exit 3', open.code === 3, `${open.code} ${(open.stderr + open.stdout).split('\n').filter(Boolean).slice(-1)[0] ?? ''}`);
    // Production runs only tests that list it.
    writeSpaTest(root, 'search', { environments: ['local', 'prod'] });
    const blocked = await go(['search', '--env', 'prod']);
    verify('a write request on prod is aborted: the step fails with write-blocked naming it', blocked.exit === 1 && /write-blocked/.test(resultText('search')) && /POST \/api\/search/.test(resultText('search')), `${shown(blocked)} ${failNote('search')}`);
    networkConfig({ reads: ['POST /api/search'] });
    const allowed = await go(['search', '--env', 'prod']);
    verify('named in reads it passes on prod', allowed.exit === 0, `${shown(allowed)} ${failNote('search')}`);
});
