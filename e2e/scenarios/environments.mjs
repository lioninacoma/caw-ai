// P2 core model against the spa fixture (e2e/spa): environment choice (S8), sign-in and test users per environment with Keycloak
// (A5), HTTP Basic and a gate (A6), several roles (A9), TLS and http exceptions (D6), tenants as environments (D7) and setup
// with the packed CLI (B2). No Claude: the tests carry recordings written by hand and run headless.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import {
    ACTION_ENVIRONMENTS, APP_TOTP, AUTH_ENVIRONMENTS, ENVIRONMENTS, ENV_FILE, LIFECYCLE_ENVIRONMENTS, LIFECYCLE_PORTS, NETWORK_ENVIRONMENTS, SPA_PORT, baseConfig, makeStale, removeActionTests, removeLifecycleTests, removeNetworkTests,
    writeNetworkTests, writeProject, writeSpaTest,
} from '../spa/project.mjs';
import { benchBack, decide, endAction, here, humans, loadTest, newestRunOf, stateOf, open as openCommand, print, quietTokens, record as recordCommand, run, runDirsOf, startServer, verify } from '../harness.mjs';
import { composeStack, exec, httpAlias, installPacked, mcpClient, packTarball, preflightPorts } from '../infra.mjs';

const spaDir = join(here, 'spa');
const root = join(spaDir, 'work');
const { validate } = await import('../../src/host/commands.mjs');
const { loadConfigWithNotes, validateConfig } = await import('../../src/shared/config.mjs');
const { effectiveEnvironment } = await import('../../src/shared/environments.mjs');
const { exitOf } = await import('../../src/shared/errors.mjs');
const { listProject } = await import('../../src/host/project-data.mjs');
const { roleCommand, roleOverview } = await import('../../src/host/role-command.mjs');
const { sessionTools } = await import('../../src/host/session-mcp.mjs');
const { liveListeners, unregisterListener } = await import('../../src/shared/attach.mjs');
const { EXPLORE_FILE, explore: exploreCommand } = await import('../../src/host/explore.mjs');
const { exploreBrowser } = await import('../../src/host/browser-session.mjs');
const { browserArgs } = await import('../../src/host/host-lock.mjs');

let server = null;
const startSpa = async () => {
    await preflightPorts([SPA_PORT, 18443, 18444, 18081, 18000, 18090, ...Object.values(LIFECYCLE_PORTS)]);
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
    removeNetworkTests(root);
    removeLifecycleTests(root);
    removeActionTests(root);
    rmSync(join(root, 'lifecycle.log'), { force: true });
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
    print('     (2) role add writes no values: covered by the unit tests of addRole (caw/.env is filled by hand)');
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
        verify('(a) init: language en, environment local with agent and writable', first.code === 0 && config.language === 'en' && JSON.stringify(config.environments?.local) === `{"url":"http://app.localhost:${SPA_PORT}","agent":true,"writable":true}`, `${first.code} ${JSON.stringify(config.environments)}`);
        verify('(a) .env.example with the naming convention and .gitignore lines', /CAW_TESTER_USER=\nCAW_TESTER_PASSWORD=/.test(readFileSync(join(a, 'caw/.env.example'), 'utf8'))
            && ['caw/.env', 'caw/.auth/'].every((line) => readFileSync(join(a, '.gitignore'), 'utf8').includes(line)));
        const b = newDir();
        const second = await caw(b, ['init', '--url', 'https://tls.localhost:18444', '--insecure-tls', '--env', 'staging', '--yes', '--no-login', '--no-mcp']);
        const staging = existsSync(join(b, 'caw.config.json')) ? JSON.parse(readFileSync(join(b, 'caw.config.json'), 'utf8')).environments?.staging : undefined;
        verify('(b) --insecure-tls is stored on the named environment (a loopback host: agent and writable, SC-15)', second.code === 0 && staging?.insecureTls === true && staging?.agent === true && staging?.writable === true,
            `${second.code} ${JSON.stringify(staging)} ${second.stderr.split('\n').slice(-3).join(' | ')}`);
        const c = newDir();
        const third = await caw(c, ['init', '--explore-only', '--url', `http://app.localhost:${SPA_PORT}`, '--yes', '--no-login']);
        verify('(c) --explore-only writes only caw/.explore.json', third.code === 0 && existsSync(join(c, 'caw/.explore.json')) && !existsSync(join(c, 'caw.config.json')), `${third.code} ${third.stderr.split('\n').slice(-3).join(' | ')}`);
        print('     (d) http beyond this machine: D6b (CAW_E2E_LAN); (e) reads candidates: P3');
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
});

// ---- P6: MCP bootstrap

scenario('B1', 'Bootstrap from a blank folder through MCP: server caw with instructions and caw_guide, caw_init explore and write, the skill caw-attach, list_changed for the overlay', spa, async () => {
    const blank = mkdtempSync(join(tmpdir(), 'caw-e2e-b1-'));
    const tarball = await packTarball();
    // The stand-in for `npx caw-ai mcp` of an unpublished package, as `claude mcp add caw --scope project -- npx caw-ai mcp` starts it.
    const client = mcpClient('npx', ['--yes', '--package', tarball, 'caw', 'mcp'], { cwd: blank, env: { ...process.env, CAW_LANG: 'en', INIT_CWD: blank, CI: '' }, timeoutMs: 300000 });
    try {
        const hello = await client.initialize();
        verify('(2) initialize: name caw, instructions of at most 12 lines naming caw_guide, tools.listChanged',
            hello.serverInfo?.name === 'caw' && typeof hello.instructions === 'string' && hello.instructions.split('\n').length <= 12 && /caw_guide/.test(hello.instructions) && hello.capabilities?.tools?.listChanged === true,
            JSON.stringify({ serverInfo: hello.serverInfo, capabilities: hello.capabilities }));
        const names = async () => (await client.request('tools/list')).tools.map(({ name }) => name);
        const core = ['caw_attach', 'caw_start', 'caw_status', 'caw_selection', 'caw_doctor', 'caw_validate', 'caw_list', 'caw_reproductions', 'caw_config', 'caw_init', 'caw_role', 'caw_guide', 'caw'];
        const listed = await names();
        verify('(3) tools/list: the core tools, no caw_overlay, no caw_explore', JSON.stringify([...listed].sort()) === JSON.stringify([...core].sort()), listed.join(' '));
        const index = await client.callTool('caw_guide');
        const topics = index.structuredContent?.topics?.map(({ name }) => name) ?? [];
        verify('(4) caw_guide lists the core topics, no overlay or extjs', ['overview', 'setup', 'config', 'tests', 'run', 'session', 'agent', 'rules'].every((name) => topics.includes(name)) && !topics.includes('overlay') && !topics.includes('extjs'), topics.join(' '));
        const stale = [];
        for (const topic of topics) {
            const text = (await client.callTool('caw_guide', { topic })).content?.[0]?.text ?? '';
            if (text.trim() === '' || /caw-ai \w|--target|mutates|targets/.test(text)) stale.push(topic);
        }
        verify('(4) every topic is non-empty, without caw-ai <cmd>, --target, mutates or targets', stale.length === 0, stale.join(' '));

        const url = `http://app.localhost:${SPA_PORT}`;
        const explored = await client.callTool('caw_init', { mode: 'explore', url, yes: true });
        const explore = explored.structuredContent?.explore;
        verify('(5) caw_init explore (unattended) returns the suggestions: framework and sign-in', explored.structuredContent?.state === 'done' && explore?.framework !== undefined && explore?.signIn !== undefined,
            `${explored.content?.[0]?.text?.split('\n')[0]} ${JSON.stringify(explore)?.slice(0, 200)}`);
        print('     (5) signing in and naming role clerk in the window: unit tests (no window automation here)');
        const written = await client.callTool('caw_init', { mode: 'write', fromExplore: true, language: 'en' });
        const config = existsSync(join(blank, 'caw.config.json')) ? JSON.parse(readFileSync(join(blank, 'caw.config.json'), 'utf8')) : {};
        verify('(6) caw_init write: a valid config with environment local (agent, writable)', written.isError === false && config.environments?.local?.agent === true && config.environments?.local?.writable === true && validateConfig(config).issues.length === 0,
            `${written.content?.[0]?.text?.split('\n')[0]} ${JSON.stringify(config.environments)}`);
        // Selectors may name a password field (#password); a credential would be a key of its own.
        verify('(7) the config holds no credential', !/"(user|username|password|secret|token|totp)"\s*:/i.test(JSON.stringify(config)), JSON.stringify(config.signIn));
        const mcp = existsSync(join(blank, '.mcp.json')) ? JSON.parse(readFileSync(join(blank, '.mcp.json'), 'utf8')).mcpServers : {};
        verify('(8) the skill caw-attach comes with it; .mcp.json has the entry caw through npx (nothing installed here)', existsSync(join(blank, '.claude', 'skills', 'caw-attach', 'SKILL.md')) && Array.isArray(mcp.caw?.args) && mcp.caw.args.some((arg) => /^caw-ai(@|$)/.test(arg)) && mcp['caw-ai'] === undefined, JSON.stringify(mcp));
        const doctor = await client.callTool('caw_doctor');
        // Unattended nobody signed in: what the window would have filled in blocks, each with its next step, and nothing else.
        const blocking = doctor.structuredContent?.checks?.filter(({ ok, optional }) => !ok && !optional) ?? [];
        verify('(9) caw_doctor: blocking only the signed-in marker and the test user the window would have saved, each with a next step',
            blocking.length === 2 && /signedInSelector is still TODO/.test(blocking[0]?.text) && /CAW_TESTER_USER, CAW_TESTER_PASSWORD are missing/.test(blocking[1]?.text) && blocking.every(({ next }) => typeof next === 'string' && next !== ''),
            JSON.stringify(blocking));

        // W3 (6): adding the overlay block through caw_config announces the overlay tool and topic.
        const patched = await client.callTool('caw_config', { patch: { environments: { dev: { url: 'https://dev.example.com' } }, overlay: { environments: ['dev'], parts: { web: { dir: '.' } } } } });
        const announced = client.notifications.some(({ method }) => method === 'notifications/tools/list_changed');
        verify('(W3.6) the overlay block via caw_config sends tools/list_changed; then caw_overlay and topic overlay are listed',
            patched.isError === false && announced && (await names()).includes('caw_overlay') && (await client.callTool('caw_guide')).structuredContent.topics.some(({ name }) => name === 'overlay'),
            `${patched.content?.[0]?.text?.split('\n')[0]} ${client.notifications.map(({ method }) => method).join(' ')}`);
    } finally {
        await client.close();
        rmSync(blank, { recursive: true, force: true });
    }
});

// ---- P7: export

/** The Playwright test runner for exported specs, pinned to caw's playwright-core version; installed once into e2e/export. */
const exportRunner = async () => {
    const dir = join(here, 'export');
    if (!existsSync(join(dir, 'node_modules', '@playwright', 'test'))) {
        const version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).dependencies['playwright-core'];
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'caw-e2e-export', private: true, type: 'module' }, null, 2));
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const installed = await exec(npm, ['install', '--no-audit', '--no-fund', `@playwright/test@${version}`], { cwd: dir, shell: true });
        if (installed.code !== 0) throw new Error(`installing @playwright/test failed: ${installed.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    }
    return dir;
};

scenario('S10', 'Playwright export: spec, support and config; npx playwright test passes with the run tag, a remembered value, a confirm and a prompt; a renamed button fails in its step; stale is exit 4', spa, async () => {
    actionConfig();
    writeSpaTest(root, 'export-me');
    const replayed = await go(['export-me', '--env', 'extra']);
    verify('(0) caw itself replays the test', replayed.exit === 0, `${shown(replayed)} ${failNote('export-me')}`);
    const runnerDir = await exportRunner();
    const out = join(runnerDir, 'out');
    rmSync(out, { recursive: true, force: true });
    const cli = (args) => exec(process.execPath, [join(here, '..', 'bin', 'caw.mjs'), ...args], { cwd: root, env: { ...process.env, CAW_LANG: 'en', INIT_CWD: root, NO_COLOR: '1' } });
    const exported = await cli(['export', 'export-me', '--env', 'extra', '--out', out]);
    const spec = existsSync(join(out, 'export-me.spec.mjs')) ? readFileSync(join(out, 'export-me.spec.mjs'), 'utf8') : '';
    verify('(1) caw export writes export-me.spec.mjs, caw-support.mjs and playwright.config.mjs', exported.code === 0 && ['export-me.spec.mjs', 'caw-support.mjs', 'playwright.config.mjs'].every((file) => existsSync(join(out, file))),
        `${exported.code} ${exported.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    verify('(2) the dialog decisions are exported with the actions that open them', /caw\.dialog\(\{"accept":true\}, \(\) => page\.getByRole\("button", \{ name: "Delete first", exact: true \}\)\.click\(\)\)/.test(spec)
        && /caw\.dialog\(\{"accept":true,"value":"Note \{\{runTag\}\}"\}/.test(spec), spec.split('\n').filter((line) => line.includes('dialog')).join(' | '));
    // The fixture's fictitious accounts, as CI would pass them.
    const accounts = Object.fromEntries(ENV_FILE.split('\n').filter((line) => /^CAW_\w+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const playwright = () => exec(npx, ['playwright', 'test', '-c', 'out'], { cwd: runnerDir, shell: true, env: { ...process.env, ...accounts, CI: '1' } });
    const passed = await playwright();
    verify('(3) npx playwright test passes: run tag, remembered ticket, confirm and prompt', passed.code === 0 && /1 passed/.test(passed.stdout), `${passed.code} ${passed.stdout.trim().split('\n').slice(-12).join(' | ')}`);
    // Fault: the button was renamed in the app; here the same through the spec.
    writeFileSync(join(out, 'export-me.spec.mjs'), spec.replace('name: "Delete first", exact: true', 'name: "Delete all", exact: true'));
    const failed = await playwright();
    verify('(4) a renamed button fails in its step, S2, naming the locator', failed.code !== 0 && /S2 Delete the first ticket/.test(failed.stdout) && /Delete all/.test(failed.stdout), failed.stdout.trim().split('\n').slice(-12).join(' | '));
    makeStale(root, 'export-me');
    const stale = await cli(['export', 'export-me', '--env', 'extra', '--out', out]);
    verify('(5) a stale test → exit 4 naming record', stale.code === 4 && /caw record export-me@/.test(stale.stderr), `${stale.code} ${stale.stderr.trim().split('\n')[0]}`);
});

// ---- P8: extensions stay out of the core

scenario('X4', 'Extensions stay out of the core: without an overlay block no overlay in help, CLI, validate, doctor and MCP; with it all of them; init on an ExtJS app writes no overlay block', spa, async () => {
    const bin = join(here, '..', 'bin', 'caw.mjs');
    const cli = (args, cwd = root) => exec(process.execPath, [bin, ...args], { cwd, env: { ...process.env, CAW_LANG: 'en', INIT_CWD: cwd, NO_COLOR: '1', CI: '1' } });
    const toolsAndTopics = async () => {
        const client = mcpClient(process.execPath, [bin, 'mcp'], { cwd: root, env: { ...process.env, CAW_LANG: 'en', INIT_CWD: root } });
        try {
            await client.initialize();
            const tools = (await client.request('tools/list')).tools.map(({ name }) => name);
            const topics = (await client.callTool('caw_guide')).structuredContent.topics.map(({ name }) => name);
            return { tools, topics };
        } finally {
            await client.close();
        }
    };
    setConfig(baseConfig());
    writeSpaTest(root, 'see-tickets');
    const help = await cli(['--help']);
    verify('(core) help without the overlay command and --overlay', help.code === 0 && !/overlay/.test(help.stdout), help.stdout.split('\n').filter((line) => /overlay/.test(line)).join(' | '));
    const command = await cli(['overlay', 'status']);
    verify('(core) caw overlay → unknown-command with the extension hint', command.code === 3 && /caw overlay is an extension.*docs\/extensions\/overlay\.md/.test(command.stderr) && /unknown-command/.test(command.stderr), `${command.code} ${command.stderr.trim()}`);
    const flag = await cli(['run', 'see-tickets', '--overlay']);
    verify('(core) --overlay → usage error with the hint, before anything runs', flag.code === 3 && /--overlay is an extension/.test(flag.stderr) && /code: usage/.test(flag.stderr), `${flag.code} ${flag.stderr.trim()}`);
    const checks = `${(await cli(['validate'])).stdout}${(await cli(['doctor'])).stdout}`;
    verify('(core) validate and doctor have no overlay lines', !/overlay|Sencha|watch/i.test(checks), checks.split('\n').filter((line) => /overlay|sencha|watch/i.test(line)).join(' | '));
    const core = await toolsAndTopics();
    verify('(core) MCP: no caw_overlay, no topics overlay or extjs', !core.tools.includes('caw_overlay') && !core.topics.includes('overlay') && !core.topics.includes('extjs'), `${core.tools.join(' ')} / ${core.topics.join(' ')}`);

    setConfig({ ...baseConfig(), environments: { ...ENVIRONMENTS, deployed: { url: 'https://deployed.example.com' } }, overlay: { environments: ['deployed'], parts: { web: { dir: '.', url: 'http://localhost:18599/' } } } });
    const extendedHelp = await cli(['--help']);
    verify('(block) help shows caw overlay and --overlay', /^ {2}overlay status/m.test(extendedHelp.stdout) && /\[--overlay\[=<parts>\]\]/.test(extendedHelp.stdout));
    const status = await cli(['overlay', 'status', '--env', 'deployed']);
    verify('(block) caw overlay status answers about the part (down here), not with the extension hint', !/is an extension/.test(status.stderr) && /down|not ready|18599/i.test(`${status.stdout}${status.stderr}`), `${status.code} ${`${status.stdout}${status.stderr}`.trim().split('\n').slice(0, 2).join(' | ')}`);
    const extended = await toolsAndTopics();
    verify('(block) MCP: caw_overlay and topic overlay', extended.tools.includes('caw_overlay') && extended.topics.includes('overlay'), `${extended.tools.join(' ')} / ${extended.topics.join(' ')}`);
    setConfig(baseConfig());

    const app = mkdtempSync(join(tmpdir(), 'caw-e2e-x4-'));
    try {
        writeFileSync(join(app, 'workspace.json'), '{}');
        const init = await cli(['init', '--offline', '--url', 'http://localhost:1841', '--language', 'en', '--no-mcp'], app);
        const written = existsSync(join(app, 'caw.config.json')) ? JSON.parse(readFileSync(join(app, 'caw.config.json'), 'utf8')) : {};
        verify('(init) an ExtJS app: framework extjs, no overlay block', init.code === 0 && written.framework === 'extjs' && written.overlay === undefined, `${init.code} ${JSON.stringify(written).slice(0, 200)}`);
    } finally {
        rmSync(app, { recursive: true, force: true });
    }
});

// ---- P3: network and safety

const networkConfig = (extra = {}) => {
    setConfig({ ...baseConfig(NETWORK_ENVIRONMENTS), ...extra });
    writeNetworkTests(root);
};
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

scenario('D4b', 'A third-party script logging a console error during an action is a warning, also once the step\'s effects are learned', spa, async () => {
    networkConfig();
    writeSpaTest(root, 'gql-list', { environments: ['tp'], recordedOn: 'tp' });
    await poke('tp', '/test/widget-console-off');
    const learning = [await go(['gql-list', '--env', 'tp', '--learn']), await go(['gql-list', '--env', 'tp', '--learn'])];
    const runs = loadTest(root, 'gql-list').steps[0].recording?.effects?.runs ?? 0;
    verify('(1) two healthy runs learn the click\'s effects', learning.every(({ exit }) => exit === 0) && runs >= 2, `${learning.map(shown).join(' | ')} runs=${runs}`);
    await poke('tp', '/test/widget-console-on');
    const noisy = await go(['gql-list', '--env', 'tp']);
    await poke('tp', '/test/widget-console-off');
    verify('(2) the CDN script\'s console error on the click: the run passes with a warning', noisy.exit === 0 && /event dropped/.test(warningsOf('gql-list')), `${shown(noisy)} ${failNote('gql-list')} ${warningsOf('gql-list')}`);
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
    writeSpaTest(root, 'search', { environments: ['local', 'prod'] });
    const allowed = await go(['search', '--env', 'prod']);
    verify('named in reads it passes on prod', allowed.exit === 0, `${shown(allowed)} ${failNote('search')}`);
});

// ---- P4: environment lifecycle, learning and CI

const lifecycleConfig = (extra = {}) => setConfig({ ...baseConfig(LIFECYCLE_ENVIRONMENTS), ...extra });
/** The lines ctl.mjs wrote for start, stop and reset ("up 18512 life"), and how often a command ran. */
const markers = () => (existsSync(join(root, 'lifecycle.log')) ? readFileSync(join(root, 'lifecycle.log'), 'utf8').split('\n').filter(Boolean) : []);
const ran = (command) => markers().filter((line) => line.startsWith(`${command} `) || line === command).length;
/** Does anything listen on the port? */
const listening = (port) => new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
});
/** A test endpoint of the shared spa server for one environment (by its host name). */
const poke = (host, path) => new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: SPA_PORT, method: 'POST', path, headers: { host: `${host}.localhost:${SPA_PORT}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
});
/** A command function (record, open, validate, run) with extra process variables: its exit code, or the code of its error. */
const callWith = async (env, fn) => {
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
        return await captured(() => Promise.resolve().then(fn).then((code) => ({ exit: code }), (error) => ({ exit: exitOf(error.code), code: error.code, message: String(error.message) })));
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};
const files = (id) => [`caw/tests/${id}.yaml`, `caw/recordings/${id}.yaml`].map((path) => readFileSync(join(root, path), 'utf8'));
/** The test with the learned parts of each recording taken out: what learning may change is network and effects only. */
const withoutLearned = (id) => JSON.stringify(loadTest(root, id).steps.map(({ recording, ...step }) => {
    const rest = { ...recording };
    delete rest.network;
    delete rest.effects;
    return { ...step, recording: rest };
}));
const learnedNetwork = (id) => loadTest(root, id).steps[0].recording?.network;

scenario('S3', 'Baselines are learned by every run outside CI: in the window with a notice, headless too; CI only with --learn', spa, async () => {
    quietTokens();
    const before = files('see-tickets');
    const plain = withoutLearned('see-tickets');
    const watcher = humans(async (chat) => {
        await chat.locator('.message.notice', { hasText: 'Baselines saved for steps' }).waitFor({ timeout: 90000 });
        verify('(1) the chat says which steps get baselines', true);
        await endAction(chat, 'closeWindow', { timeout: 30000 });
    });
    const first = await callWith({ CI: '' }, () => run(root, ['see-tickets', '--env', 'local'], { interactive: true, onChatOpen: watcher.onChatOpen }));
    await watcher.done();
    const after = files('see-tickets');
    // S1 sends no request of its own (the list loads with the page before it): its learned baseline is the empty list.
    verify('(1) a chat run passes, says "learns: yes" and S1 gets its network baseline', first.value.exit === 0 && /learns: yes,/.test(first.output) && Array.isArray(learnedNetwork('see-tickets')), `${shown(first.value)} ${(/Mode on .*/.exec(first.output) ?? [''])[0]}`);
    verify('(1) only network and effects changed: the plan file is identical, the recording otherwise too', after[0] === before[0] && after[1] !== before[1] && withoutLearned('see-tickets') === plain);
    writeSpaTest(root, 'see-tickets');
    const headless = await go(['see-tickets', '--env', 'local'], { env: { CI: '' } });
    verify('(2) a headless run learns too and says so', headless.exit === 0 && Array.isArray(learnedNetwork('see-tickets')) && /learns: yes,/.test(headless.output), `${shown(headless)} ${(/Mode on .*/.exec(headless.output) ?? [''])[0]}`);
    writeSpaTest(root, 'see-tickets');
    const ciBefore = files('see-tickets');
    const ci = await go(['see-tickets', '--env', 'local'], { env: { CI: '1' } });
    verify('(3) CI=1 without --learn never writes', ci.exit === 0 && JSON.stringify(files('see-tickets')) === JSON.stringify(ciBefore) && /learns: no\./.test(ci.output), shown(ci));
    const ciLearn = await go(['see-tickets', '--env', 'local', '--learn'], { env: { CI: '1' } });
    verify('(4) CI=1 with --learn learns', ciLearn.exit === 0 && Array.isArray(learnedNetwork('see-tickets')), shown(ciLearn));
});

scenario('S4', 'CI: --all on an environment caw starts, resets once before the first writing test and stops; JUnit; CI refuses what needs a person', spa, async () => {
    lifecycleConfig();
    for (const id of ['create-second', 'fail-one', 'stale-one']) writeSpaTest(root, id);
    makeStale(root, 'stale-one');
    rmSync(join(root, 'out'), { recursive: true, force: true });
    verify('nothing listens on 18512 before', !await listening(LIFECYCLE_PORTS.life));
    const batch = await go(['--all', '--env', 'life', '--start', '--report', 'junit=out/caw.xml'], { env: { CI: '1' } });
    verify('(1) start runs once and ready is polled', ran('up') === 1 && /Starting life: node \.\.\/ctl\.mjs up 18512/.test(batch.output) && /life is ready\./.test(batch.output), JSON.stringify(markers()));
    verify('(2) reset runs once, before the first writing test', ran('reset') === 1 && markers().indexOf('reset 18512 life') === 1, JSON.stringify(markers()));
    verify('(3) stop runs at the end; nothing listens on 18512 afterwards', ran('down') === 1 && markers().at(-1) === 'down 18512 life' && !await listening(LIFECYCLE_PORTS.life), JSON.stringify(markers()));
    const xml = existsSync(join(root, 'out/caw.xml')) ? readFileSync(join(root, 'out/caw.xml'), 'utf8') : '';
    verify('(4) JUnit: classname caw.life, pass, a failure typed by its assessment with "S<n>: <reason>", needs-recording typed by its code', /classname="caw\.life" name="see-tickets" time="[\d.]+"\/>/.test(xml) && /name="fail-one"[^]*?<failure type="(app|environment|test|unclear)" message="S\d+: /.test(xml) && /name="stale-one"[^]*?<error type="replay-stale"/.test(xml) && /name="create-second" time="[\d.]+"\/>/.test(xml), xml.split('\n').filter((line) => /testcase|failure|error/.test(line)).join(' '));
    verify('(5) exit = the worst run (fail)', batch.exit === 1, shown(batch));
    const claudeLogs = runDirsOf(root, 'see-tickets').concat(runDirsOf(root, 'create-second')).flatMap((dir) => readdirSync(join(root, '.caw/runs', dir)).filter((name) => /claude/i.test(name)));
    verify('(6) no Claude and no sandbox in the run folders', claudeLogs.length === 0 && !/docker/i.test(batch.output), JSON.stringify(claudeLogs));
    const recorded = await callWith({ CI: '1' }, () => recordCommand(root, ['brand-new', '--env', 'life']));
    const opened = await callWith({ CI: '1' }, () => openCommand(root, ['--env', 'life']));
    const explained = await callWith({ CI: '1' }, () => run(root, ['see-tickets', '--env', 'local', '--explain']));
    verify('(7) under CI=1 record, open and run --explain: exit 3, naming CI', [recorded, opened, explained].every(({ value }) => value.exit === 3 && /variable CI set/.test(value.message ?? '')), [recorded, opened, explained].map(({ value }) => shown(value)).join(' | '));
});

scenario('D1', 'Lifecycle: detaching and long-running starts, an environment already up, failing start and reset, never ready, --reset/--no-reset, production refused', spa, async () => {
    lifecycleConfig();
    const detached = await go(['see-tickets', '--env', 'life', '--start']);
    verify('(1) a detaching start (exits 0, server keeps running) and its stop', detached.exit === 0 && JSON.stringify(markers()) === '["up 18512 life","down 18512 life"]' && !await listening(LIFECYCLE_PORTS.life), `${shown(detached)} ${JSON.stringify(markers())}`);
    const foreground = await go(['see-tickets', '--env', 'dev2', '--start']);
    verify('(2) a long-running start (like npm run dev) is ended as a process tree: port 18511 is free afterwards', foreground.exit === 0 && !await listening(LIFECYCLE_PORTS.dev2), shown(foreground));
    rmSync(join(root, 'lifecycle.log'), { force: true });
    await exec(process.execPath, ['../ctl.mjs', 'up', String(LIFECYCLE_PORTS.life)], { cwd: root });
    const reused = await go(['see-tickets', '--env', 'life', '--start']);
    verify('(3) already up: "already running", neither start nor stop runs', reused.exit === 0 && /life is already running: using it, will not stop it\./.test(reused.output) && JSON.stringify(markers()) === '["up 18512 -"]' && await listening(LIFECYCLE_PORTS.life), `${shown(reused)} ${JSON.stringify(markers())}`);
    await exec(process.execPath, ['../ctl.mjs', 'down', String(LIFECYCLE_PORTS.life)], { cwd: root });
    const broken = await go(['see-tickets', '--env', 'broken', '--start']);
    verify('(4) a failing start: env-start-failed, exit 2, with the log tail', broken.exit === 2 && broken.code === 'env-start-failed' && /table tickets is missing/.test(broken.message ?? ''), shown(broken));
    const never = await go(['see-tickets', '--env', 'never', '--start']);
    verify('(5) never ready: env-not-ready, exit 2', never.exit === 2 && never.code === 'env-not-ready' && /never was not ready within 3 s/.test(never.message ?? ''), shown(never));
    rmSync(join(root, 'lifecycle.log'), { force: true });
    const forced = await go(['see-tickets', '--env', 'life', '--start', '--reset']);
    verify('(6) --reset forces a reset before a read-only test', forced.exit === 0 && ran('reset') === 1, `${shown(forced)} ${JSON.stringify(markers())}`);
    rmSync(join(root, 'lifecycle.log'), { force: true });
    const suppressed = await go(['create-ticket', '--env', 'life', '--start', '--no-reset']);
    const automatic = await go(['create-ticket', '--env', 'life', '--start']);
    verify('(6) --no-reset suppresses it before a writing test; without it the writing test gets one', suppressed.exit === 0 && automatic.exit === 0 && ran('reset') === 1 && markers().filter((line) => line.startsWith('up')).length === 2, JSON.stringify(markers()));
    const runsBefore = runDirsOf(root, 'create-ticket').length;
    const badReset = await go(['create-ticket', '--env', 'badreset']);
    verify('(7) a failing reset: env-reset-failed, exit 2, and no test runs', badReset.exit === 2 && badReset.code === 'env-reset-failed' && runDirsOf(root, 'create-ticket').length === runsBefore, shown(badReset));
    const unreachable = await go(['see-tickets', '--env', 'life']);
    verify('without --start an environment that is down: env-unreachable, exit 2, the hint names --start', unreachable.exit === 2 && unreachable.code === 'env-unreachable' && /--start runs its start command \(node \.\.\/ctl\.mjs up 18512\)/.test(unreachable.message ?? ''), shown(unreachable));
    const noCommand = await go(['see-tickets', '--env', 'local', '--start']);
    verify('--start on an environment without start: usage, exit 3', noCommand.exit === 3 && /environment local has no start command/.test(noCommand.message ?? ''), shown(noCommand));
    setConfig({ ...baseConfig({ local: ENVIRONMENTS.local, prod: { url: 'http://prod.localhost:18081', production: true, start: 'node ../ctl.mjs up 18081' } }) });
    const production = await callWith({}, () => validate(root));
    verify('(8) start on a production environment: validate exit 3', production.value.exit === 3 && /prod is production: caw never starts, stops or resets it/.test(production.value.message ?? production.output), `${shown(production.value)} ${production.output.split('\n').find((line) => /prod/.test(line)) ?? ''}`);
    print('     (9) short ids (remember of id 7): OPEN-7, in P5');
});

scenario('D3', 'Slow, cold or flaky backend: a cold first call passes on retry with the attempt in the report, a reset connection is environment, a quick abort is application', spa, async () => {
    // The search only reads: named in reads, a step that sent it may be retried (a write request would forbid the retry).
    lifecycleConfig({ reads: ['POST /api/search'] });
    writeSpaTest(root, 'search-cold');
    writeSpaTest(root, 'search');
    await poke('cold', '/test/reset');
    const cold = await go(['search-cold', '--env', 'cold']);
    const note = (newestRunOf(root, 'search-cold').result?.results ?? [])[0]?.note ?? '';
    verify('a first search of 20 s: the step\'s retry passes, the report names the attempt', cold.exit === 0 && /Passed on attempt 2/.test(note), `${shown(cold)} ${note}`);
    const flaky = await go(['search', '--env', 'flaky']);
    const flakyResult = newestRunOf(root, 'search').result ?? {};
    verify('the search reset by the peer: the assessment says environment', flaky.exit !== 0 && flakyResult.diagnosis?.side === 'environment', `${shown(flaky)} ${JSON.stringify(flakyResult.diagnosis ?? {})}`);
    await poke('abortive', '/test/abort-off');
    // Baselines are learned on the environment the test was recorded on (local); the abort happens on abortive.
    const learned = await go(['search', '--env', 'local', '--learn']);
    await poke('abortive', '/test/abort-on');
    const aborted = await go(['search', '--env', 'abortive']);
    await poke('abortive', '/test/abort-off');
    const abortedResult = newestRunOf(root, 'search').result ?? {};
    verify('the page aborts its own search after 1 ms, without navigating: application, clear (baseline from --learn)', learned.exit === 0 && aborted.exit === 1 && abortedResult.diagnosis?.side === 'app' && abortedResult.diagnosis?.strength === 'clear', `${shown(learned)} | ${shown(aborted)} ${JSON.stringify(abortedResult.diagnosis ?? {})}`);
});

scenario('S11', 'CI triage: --retry-env repeats only an environment failure, the summary and JSON name every attempt; CAW_URL__<ENV> points an environment elsewhere', spa, async () => {
    lifecycleConfig({ reads: ['POST /api/search'] });
    writeSpaTest(root, 'search');
    rmSync(join(root, 'out'), { recursive: true, force: true });
    await poke('abortive', '/test/abort-off');
    // flaky resets every search: the assessment says environment, so --retry-env 1 runs it twice, and the exit stays 1.
    const flaky = await go(['search', '--env', 'flaky', '--retry-env', '1', '--report', 'json=out/flaky.json', '--report', 'summary=out/flaky.md'], { env: { CI: '1' } });
    const json = existsSync(join(root, 'out/flaky.json')) ? JSON.parse(readFileSync(join(root, 'out/flaky.json'), 'utf8')) : {};
    const attempts = json.tests?.[0]?.attempts ?? [];
    verify('(1) flaky: two attempts, both environment, exit 1', flaky.exit === 1 && attempts.length === 2 && attempts.every(({ side }) => side === 'environment') && /attempt 1 failed on the environment, running it again/.test(flaky.output), `${shown(flaky)} ${JSON.stringify(attempts)}`);
    const summary = existsSync(join(root, 'out/flaky.md')) ? readFileSync(join(root, 'out/flaky.md'), 'utf8') : '';
    verify('(2) the summary: FAIL on attempt 2 after the environment, the failed step, environment, the report path', /\| FAIL · on attempt 2, after failures on the environment \| search \| S\d+: .*\| environment problem \((likely|clear)\) \|.*`\.caw\/runs\/[^`]+\/report\.md` \|/.test(summary), summary);
    // An app failure is never repeated: the page aborts its own search on abortive.
    await go(['search', '--env', 'local', '--learn']);
    await poke('abortive', '/test/abort-on');
    const app = await go(['search', '--env', 'abortive', '--retry-env', '2', '--report', 'json=out/app.json'], { env: { CI: '1' } });
    await poke('abortive', '/test/abort-off');
    const appJson = existsSync(join(root, 'out/app.json')) ? JSON.parse(readFileSync(join(root, 'out/app.json'), 'utf8')) : {};
    verify('(3) abortive: one attempt, side app, exit 1', app.exit === 1 && appJson.tests?.[0]?.attempts?.length === 1 && appJson.tests?.[0]?.side === 'app', `${shown(app)} ${JSON.stringify(appJson.tests?.[0] ?? {})}`);
    // flaky pointed at the healthy abortive backend for this process only: the search passes, the mode line names the variable.
    const moved = await go(['search', '--env', 'flaky'], { env: { CAW_URL__FLAKY: LIFECYCLE_ENVIRONMENTS.abortive.url } });
    const config = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    verify('(4) CAW_URL__FLAKY: passes against the other address, named in the mode line, config unchanged', moved.exit === 0 && /Address from CAW_URL__FLAKY: http:\/\/abortive\.localhost/.test(moved.output) && config.environments.flaky.url === LIFECYCLE_ENVIRONMENTS.flaky.url, shown(moved));
    const refused = await go(['search', '--env', 'flaky'], { env: { CAW_URL__LOCAL: 'http://other.localhost:1' } });
    verify('(5) CAW_URL__LOCAL on an agent environment: url-override, exit 3', refused.exit === 3 && refused.code === 'url-override', shown(refused));
});

// ---- P5: actions and data

const actionConfig = (extra = {}) => setConfig({ ...baseConfig(ACTION_ENVIRONMENTS), ...extra });
const warningsOf = (id) => JSON.stringify(resultOf(id).warnings ?? []);

scenario('M2', 'Native dialogs: recorded decisions apply on replay (confirm OK/Cancel, prompt with run tag, beforeunload, alert); unexpected and missing dialogs are warnings', spa, async () => {
    actionConfig();
    for (const id of ['dlg-delete', 'dlg-keep', 'dlg-rename', 'dlg-leave', 'dlg-ping']) writeSpaTest(root, id);
    const deleted = await go(['dlg-delete', '--env', 'extra']);
    verify('(5) confirm accepted on replay: Deleted', deleted.exit === 0, `${shown(deleted)} ${failNote('dlg-delete')}`);
    const kept = await go(['dlg-keep', '--env', 'extra']);
    verify('(1) confirm dismissed (accept: false) on replay: Kept', kept.exit === 0, `${shown(kept)} ${failNote('dlg-keep')}`);
    const renamed = await go(['dlg-rename', '--env', 'extra']);
    verify('(2) prompt answered with "Note {{runTag}}", filled per run', renamed.exit === 0, `${shown(renamed)} ${failNote('dlg-rename')}`);
    const left = await go(['dlg-leave', '--env', 'extra']);
    verify('(3) beforeunload on a dirty form: reload is answered and replayed', left.exit === 0 && !/dialog-unexpected/.test(warningsOf('dlg-leave')), `${shown(left)} ${failNote('dlg-leave')} ${warningsOf('dlg-leave')}`);
    const pinged = await go(['dlg-ping', '--env', 'extra']);
    verify('(5) an alert is accepted', pinged.exit === 0, `${shown(pinged)} ${failNote('dlg-ping')}`);
    const fault = await go(['dlg-ping', '--env', 'extrafault']);
    verify('(6) an unexpected alert is dismissed and listed as dialog-unexpected with its text', fault.exit === 0 && /dialog-unexpected/.test(warningsOf('dlg-ping')) && /Maintenance at ##:##/.test(warningsOf('dlg-ping')) === false && /Maintenance at 22:00/.test(warningsOf('dlg-ping')), `${shown(fault)} ${warningsOf('dlg-ping')}`);
    const missing = await go(['dlg-delete', '--env', 'extrafault']);
    verify('(7) the expected confirm does not come: the step passes with a dialog-missing warning', missing.exit === 0 && /dialog-missing/.test(warningsOf('dlg-delete')), `${shown(missing)} ${warningsOf('dlg-delete')}`);
    print('     (1) demonstration in the chat and (4) the scripted agent arming a dialog: browser unit tests (test/dialogs-browser.test.mjs)');
});

scenario('U4', 'Hover and drag: a menu that opens on hover and a card dragged onto a column replay headless', spa, async () => {
    actionConfig();
    writeSpaTest(root, 'hover-menu');
    writeSpaTest(root, 'drag-card');
    const hover = await go(['hover-menu', '--env', 'extra']);
    verify('hover opens the menu, Archive is clicked', hover.exit === 0, `${shown(hover)} ${failNote('hover-menu')}`);
    const drag = await go(['drag-card', '--env', 'extra']);
    verify('dragTo moves Card 1 into Done', drag.exit === 0, `${shown(drag)} ${failNote('drag-card')}`);
    print('     context menu: after 1.0 (decided)');
});

scenario('U3', 'Popups and new tabs on the app host: target=_blank and window.open replay, the check runs in the new tab', spa, async () => {
    actionConfig();
    writeSpaTest(root, 'popup-help');
    writeSpaTest(root, 'popup-report');
    const help = await go(['popup-help', '--env', 'extra']);
    verify('target=_blank: the check runs in the new tab', help.exit === 0, `${shown(help)} ${failNote('popup-help')}`);
    const report = await go(['popup-report', '--env', 'extra']);
    verify('window.open: the check runs in the popup', report.exit === 0, `${shown(report)} ${failNote('popup-report')}`);
    print('     to a foreign host: blocked (D4)');
});

scenario('U6', 'Viewport: headless replay uses the recorded 600×800 and takes the hamburger path; browser.viewport overrides; the workbench pins the app frame', spa, async () => {
    actionConfig();
    writeSpaTest(root, 'nav-small');
    const small = await go(['nav-small', '--env', 'extra']);
    verify('recorded 600×800: the nav collapses into Menu, the recorded path passes', small.exit === 0, `${shown(small)} ${failNote('nav-small')}`);
    actionConfig({ browser: { viewport: { width: 1280, height: 800 } } });
    const wide = await go(['nav-small', '--env', 'extra']);
    verify('browser.viewport 1280 overrides: no Menu button, the step fails', wide.exit === 1, `${shown(wide)} ${failNote('nav-small')}`);
    actionConfig();
    quietTokens();
    let frame = '';
    const watcher = humans(async (chat) => {
        const bench = chat.page();
        await bench.locator('#appBox.pinned').waitFor({ state: 'attached', timeout: 90000 });
        frame = await bench.evaluate(() => { const app = document.getElementById('app'); return `${app.style.width}x${app.style.height} ${app.style.transform}`; });
        await endAction(chat, 'closeWindow');
    });
    const inBench = await callWith({ CI: '' }, () => run(root, ['nav-small', '--env', 'extra'], { interactive: true, onChatOpen: watcher.onChatOpen }));
    await watcher.done();
    verify('in the workbench the app frame has exactly 600×800 (scaled to fit) and the run passes', inBench.value.exit === 0 && /^600pxx800px scale\(/.test(frame), `${shown(inBench.value)} ${frame}`);
    // After the handover the window is the human's: the app gets the whole pane. "Open again" replays in the recorded size.
    const sizes = [];
    const pinned = (bench) => bench.locator('#appBox.pinned').count();
    const owner = humans(async (chat) => {
        const bench = chat.page();
        await benchBack(chat);
        await stateOf(chat, 'developing');
        sizes.push(['handed over', await pinned(bench)]);
        // The spa project's team language is English.
        await decide(chat, 'Open again');
        sizes.push(['open again', await bench.locator('#appBox.pinned').waitFor({ state: 'attached', timeout: 30000 }).then(() => 1, () => 0)]);
        await chat.locator('.message', { hasText: /restored \(runTag/ }).first().waitFor({ timeout: 90000 });
        sizes.push(['restored', await pinned(bench)]);
        await decide(chat, 'End run');
    });
    await callWith({ CI: '' }, () => openCommand(root, ['nav-small', '--env', 'extra'], { interactive: true, onChatOpen: owner.onChatOpen }));
    await owner.done();
    verify('handed over: whole pane; restoring: recorded size; restored: whole pane again', JSON.stringify(sizes) === JSON.stringify([['handed over', 0], ['open again', 1], ['restored', 0]]), JSON.stringify(sizes));
});

scenario('D2', 'Shared environment with foreign data: look-alikes and a changing order break neither the test nor its learned effects', spa, async () => {
    actionConfig();
    // Recorded on shared: baselines and effects are learned there (two healthy runs fix an effect), then compared.
    writeSpaTest(root, 'create-find', { environments: ['local', 'shared'], recordedOn: 'shared' });
    const first = await go(['create-find', '--env', 'shared', '--learn']);
    const second = await go(['create-find', '--env', 'shared', '--learn']);
    const learned = loadTest(root, 'create-find').steps[0].recording?.effects?.runs ?? 0;
    const third = await go(['create-find', '--env', 'shared']);
    verify('each run finds its own ticket among look-alikes ("Ticket", "Ticket CAW-…") in another order', [first, second, third].every(({ exit }) => exit === 0), [first, second, third].map(shown).join(' | '));
    verify('effects learned on shared (2 runs)', learned >= 2, String(learned));
    verify('no effect deviation from the foreign rows', !/effect/.test(warningsOf('create-find')), warningsOf('create-find'));
});

scenario('M4', 'Dates in en-US: {{date+7}} is filled as MM/DD/YYYY in the recording\'s locale; the server accepts it', spa, async () => {
    actionConfig();
    writeSpaTest(root, 'note-due');
    const due = await go(['note-due', '--env', 'mpaus']);
    verify('the due date in US format passes the server\'s check', due.exit === 0, `${shown(due)} ${failNote('note-due')}`);
    writeFileSync(join(root, 'caw/recordings/note-due.yaml'), readFileSync(join(root, 'caw/recordings/note-due.yaml'), 'utf8').replace('{{date+7}}', '{{today+7}}'));
    const old = await callWith({}, () => validate(root));
    verify('{{today+7}} is refused with its new name {{date+7}}', old.value.exit === 3 && /\{\{today\+7\}\}.*\{\{date\+7\}\}/.test(old.value.message ?? old.output), `${shown(old.value)} ${(old.value.message ?? old.output).split('\n').find((line) => /today/.test(line)) ?? ''}`);
});

// ---- P9: sign-in through Keycloak (A1–A4, A8)

const authConfig = () => setConfig(baseConfig({ ...ENVIRONMENTS, ...AUTH_ENVIRONMENTS }));
/** A test endpoint by environment name, over 127.0.0.1 with its host name (Node does not resolve *.localhost on Windows). */
const endpoint = (env, path, method = 'GET') => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: SPA_PORT, method, path, headers: { host: new URL(AUTH_ENVIRONMENTS[env].url).host } }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
});
const output = (...results) => results.map((result) => result.output ?? '').join('\n');
/** Ends every Keycloak session of a user through the admin API (fictitious bootstrap admin of e2e/stacks/idp/compose.yaml). */
const keycloakLogout = async (username) => {
    const base = 'http://127.0.0.1:18180';
    const token = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin-e2e-fictitious' }),
    }).then((response) => response.json()).then((answer) => answer.access_token);
    const headers = { authorization: `Bearer ${token}` };
    const [user] = await fetch(`${base}/admin/realms/caw-e2e/users?exact=true&username=${username}`, { headers }).then((response) => response.json());
    await fetch(`${base}/admin/realms/caw-e2e/users/${user.id}/logout`, { method: 'POST', headers });
};
/** Signs in as a person would, in a separate Chrome (as `caw role login` does), and stores the session where caw reads it. */
const captureSession = async (env, role, { user, password }) => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: browserArgs([]) });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${AUTH_ENVIRONMENTS[env].url}/login`);
        await page.fill('#username', user);
        await page.fill('#password', password);
        await page.click('#kc-login');
        await page.waitForSelector('#user-menu', { timeout: 30000 });
        const path = join(root, `caw/.auth/${env}/${role}.json`);
        mkdirSync(join(root, `caw/.auth/${env}`), { recursive: true });
        await context.storageState({ path });
        return path;
    } finally {
        await browser.close();
    }
};

scenario('A1', 'OIDC with the IdP on another host: explore proposes steps and allowHosts from the Keycloak pages; the suggestion signs in headless', idp, async () => {
    authConfig();
    const url = AUTH_ENVIRONMENTS.ci.url;
    rmSync(join(root, EXPLORE_FILE), { force: true });
    let browser = null;
    // The person: signs in on the Keycloak page explore opened (headless here), then is done on the app's start page.
    const person = async () => {
        const page = browser.page;
        await page.waitForSelector('#username', { timeout: 30000 });
        await page.fill('#username', 'qa.clerk');
        await page.fill('#password', 'qa-clerk-pw-e2e');
        await page.click('#kc-login');
        await page.waitForSelector('#user-menu', { timeout: 30000 });
    };
    const explored = await callWith({}, () => exploreCommand(root, ['--url', url, '--login'], {
        open: async (options) => { browser = await exploreBrowser({ ...options, headless: true }); return browser; },
        wait: person,
        detect: () => 'web',
        next: false,
    }));
    const suggestion = existsSync(join(root, EXPLORE_FILE)) ? JSON.parse(readFileSync(join(root, EXPLORE_FILE), 'utf8')) : {};
    verify('(1) explore: exit 0, a form sign-in with steps starting on the app path', explored.value.exit === 0 && suggestion.signIn?.type === 'form' && suggestion.signIn?.path === '/', `${shown(explored.value)} ${JSON.stringify(suggestion.signIn)}`);
    verify('(1) the steps fill user and password on Keycloak and submit', JSON.stringify(suggestion.signIn?.steps) === JSON.stringify([{ fill: '#username', with: 'user' }, { fill: '#password', with: 'password' }, { press: 'Enter', on: '#password' }]), JSON.stringify(suggestion.signIn?.steps));
    verify('(1) the IdP host as allowHosts, the signed-in marker from the app', JSON.stringify(suggestion.allowHosts) === '["idp.localhost"]' && ['#user-menu', 'body.signed-in'].includes(suggestion.signIn?.signedInSelector), `${JSON.stringify(suggestion.allowHosts)} ${suggestion.signIn?.signedInSelector}`);
    // The suggestion as init would write it, on the ci environment: a headless run signs in with it.
    const { confidence, ...signIn } = suggestion.signIn ?? {};
    setConfig(baseConfig({ ...ENVIRONMENTS, ci: { ...ENVIRONMENTS.ci, allowHosts: suggestion.allowHosts, signIn } }));
    const ci = await go(['see-tickets', '--env', 'ci']);
    verify('(2) headless CI sign-in with the explored steps passes', ci.exit === 0, `${shown(ci)} ${failNote('see-tickets')} (${confidence})`);
    print('     (3) a second sign-in inside the workbench iframe: open for the acceptance (the workbench embeds only the app\'s own documents, by decision)');
});

scenario('A2', 'IdP on the same host, another port: signIn.path stays the app path "/" and the sign-in passes', idp, async () => {
    authConfig();
    const checked = await callWith({}, () => validate(root));
    verify('the config with path "/" is valid', checked.value.exit === 0, shown(checked.value));
    const local = await go(['see-tickets', '--env', 'localhost']);
    verify('sign-in from http://localhost:18080/ to Keycloak at localhost:18180 passes', local.exit === 0, `${shown(local)} ${failNote('see-tickets')}`);
    const { dir } = newestRunOf(root, 'see-tickets');
    const report = existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : '';
    verify('no 404 at <app>/realms/…', !/18080\/realms/.test(report), report.split('\n').find((line) => /realms/.test(line)) ?? '');
});

scenario('A3', 'Identifier-first: user name page, then password page; an optional "stay signed in" step that never shows is skipped', idp, async () => {
    authConfig();
    const started = Date.now();
    const first = await go(['see-tickets', '--env', 'idfirst']);
    verify('steps fill, click, waitFor, fill, click: passes', first.exit === 0, `${shown(first)} ${failNote('see-tickets')}`);
    verify('the run takes well under a minute (the optional step waits at most 3 s)', Date.now() - started < 60000, `${Math.round((Date.now() - started) / 1000)} s`);
});

/** Waits until a 30 s TOTP window has just begun, so two sign-ins right after each other fall into the same window. */
const windowStart = async () => {
    while (Date.now() % 30000 > 1500) await new Promise((resolve) => { setTimeout(resolve, 200); });
};

scenario('A4', 'One-time codes: the app\'s own (codeSelector) and Keycloak\'s (a with: totp step); a second sign-in in the same window waits for the next code', idp, async () => {
    authConfig();
    await windowStart();
    const first = await go(['create-ticket', '--env', 'totp']);
    const second = await go(['create-ticket', '--env', 'totp']);
    const stats = JSON.parse(await endpoint('totp', '/test/stats'));
    verify('app code: both runs pass', first.exit === 0 && second.exit === 0, `${shown(first)} | ${shown(second)} ${failNote('create-ticket')}`);
    verify('app code: the second sign-in met its used code once and then took the next window', stats.reusedCodes === 1, JSON.stringify(stats));
    const inRuns = (pattern, read) => runDirsOf(root, 'create-ticket').flatMap((name) => readdirSync(join(root, '.caw/runs', name)).filter((file) => pattern.test(file)).map((file) => read(join(root, '.caw/runs', name, file)))).join('\n');
    const runText = inRuns(/\.(md|json|log)$/, (path) => readFileSync(path, 'utf8'));
    const traces = inRuns(/^trace.*\.zip$/, zipTexts);
    verify('the TOTP secret is in no report, result, log, trace or output', !runText.includes(APP_TOTP) && !traces.includes(APP_TOTP) && !output(first, second).includes(APP_TOTP));
    await windowStart();
    const otp = await go(['see-tickets', '--env', 'otp']);
    const otpAgain = await go(['see-tickets', '--env', 'otp']);
    verify('Keycloak code: both runs pass, the second within the same window', otp.exit === 0 && otpAgain.exit === 0, `${shown(otp)} | ${shown(otpAgain)} ${failNote('see-tickets')}`);
});

scenario('A8', 'Stored session: a run with it passes; missing names caw role login; expired names it as well; restored in CI it passes', idp, async () => {
    authConfig();
    print('     (1) caw role login in the window: covered by the unit tests of role-command (no window here); the session is captured with Playwright');
    const missing = await go(['see-tickets', '--env', 'sso']);
    verify('(3) no session file: auth-missing, exit 3, naming caw role login clerk --env sso', missing.exit === 3 && missing.code === 'auth-missing' && /caw role login clerk --env sso/.test(missing.message ?? ''), shown(missing));
    const path = await captureSession('sso', 'clerk', { user: 'qa.clerk', password: 'qa-clerk-pw-e2e' });
    const withSession = await go(['see-tickets', '--env', 'sso']);
    verify('(2) a run with the stored session passes', withSession.exit === 0, `${shown(withSession)} ${failNote('see-tickets')}`);
    // Expired as in real life: the app's session and the IdP's (otherwise Keycloak's own cookie signs the app in again).
    await endpoint('sso', '/test/revoke', 'POST');
    await keycloakLogout('qa.clerk');
    const expired = await go(['see-tickets', '--env', 'sso']);
    verify('(4) the app ended the session: the run ends naming caw role login clerk --env sso', expired.exit !== 0 && /caw role login clerk --env sso/.test(`${expired.message ?? ''} ${expired.output}`), shown(expired));
    // CI: a fresh session file kept in a secret store outside the project, copied into caw/.auth/ before the run.
    rmSync(path);
    const secret = join(mkdtempSync(join(tmpdir(), 'caw-e2e-secret-')), 'clerk.json');
    writeFileSync(secret, readFileSync(await captureSession('sso', 'clerk', { user: 'qa.clerk', password: 'qa-clerk-pw-e2e' })));
    rmSync(path);
    writeFileSync(path, readFileSync(secret));
    rmSync(dirname(secret), { recursive: true, force: true });
    const restored = await callWith({ CI: '1' }, () => run(root, ['see-tickets', '--env', 'sso', '--headless']));
    verify('(5) CI with the session restored from a secret path passes', restored.value.exit === 0, shown(restored.value));
});

// ---- P9: M1, a classic MPA (CSRF, post/redirect/get with flash, pagination)

/** A request to the notes app on its own port, by host name; resolves with the status. */
const notesRequest = (method, path) => new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: 18000, method, path, headers: { host: 'notes.localhost:18000', 'content-type': 'application/x-www-form-urlencoded' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end('user=clerk.e2e&password=clerk-pw-e2e');
});

scenario('M1', 'MPA record and run: sign-in form with a CSRF token, a flash after post/redirect/get, pages by link text; replays in CI', spa, async () => {
    setConfig(baseConfig({ local: ENVIRONMENTS.local, notes: { url: 'http://notes.localhost:18000', writable: true } }));
    writeSpaTest(root, 'notes-paged');
    verify('the app refuses a sign-in without its CSRF token (403)', await notesRequest('POST', '/login') === 403);
    const first = await go(['notes-paged', '--env', 'notes']);
    verify('caw\'s form sign-in carries the token; flash, reload without a second post and the next page pass', first.exit === 0, `${shown(first)} ${failNote('notes-paged')}`);
    const again = await callWith({ CI: '1' }, () => run(root, ['notes-paged', '--env', 'notes', '--headless']));
    verify('the recording replays in CI with more notes than before', again.value.exit === 0, `${shown(again.value)} ${failNote('notes-paged')}`);
    print('     403/422 visible in the assessment: gated by OPEN-12');
});

// ---- P9: U5, live updates and route changes

scenario('U5', 'Live updates: SSE and a WebSocket ticker never block, readyIgnore makes the page quiet, a request aborted by a route change is no finding', spa, async () => {
    const live = { local: ENVIRONMENTS.local, stream: { url: `http://stream.localhost:${SPA_PORT}` } };
    setConfig({ ...baseConfig(live), readyIgnore: ['#live'] });
    writeSpaTest(root, 'live-view');
    const started = Date.now();
    const ignored = await go(['live-view', '--env', 'stream']);
    const seconds = Math.round((Date.now() - started) / 1000);
    const report = () => readFileSync(join(newestRunOf(root, 'live-view').dir, 'report.md'), 'utf8');
    verify('with readyIgnore the run passes quickly: the event stream and the socket are no open requests', ignored.exit === 0 && seconds < 40, `${shown(ignored)} ${failNote('live-view')} ${seconds} s`);
    verify('no "did not get quiet" note with readyIgnore', !/quiet/.test(report()), report().split('\n').find((line) => /quiet/.test(line)) ?? '');
    verify('the aborted slow request of the old view is no finding', !/api\/slow/.test(report()), report().split('\n').find((line) => /api\/slow/.test(line)) ?? '');
    setConfig(baseConfig(live));
    const busy = await go(['live-view', '--env', 'stream']);
    verify('without readyIgnore the start page never settles: app-not-settled, exit 2, naming readyIgnore', busy.exit === 2 && busy.code === 'app-not-settled' && /readyIgnore/.test(busy.message ?? ''), shown(busy));
});

// ---- P9: S2, recording by plan with the Claude Code session as the agent

/** A plan written by hand, as a team writes one before recording: steps without recording. */
const planText = (id, { role, writes, steps }) => `${[`id: ${id}`, `role: ${role}`, `writes: ${writes}`, 'steps:',
    ...steps.flatMap((step, index) => [`  - id: S${index + 1}`, `    name: ${JSON.stringify(step.name)}`, `    do: ${JSON.stringify(step.do)}`, `    expect: ${JSON.stringify(step.expect)}`])].join('\n')}\n`;
const stepsYaml = (steps) => `steps:\n${steps.map((step, index) => `  - id: S${index + 1}\n    name: ${JSON.stringify(step.name)}\n    do: ${JSON.stringify(step.do)}\n    expect: ${JSON.stringify(step.expect)}`).join('\n')}\n`;
const PLANS = {
    'list-plan': { role: 'clerk', writes: false, steps: [{ name: 'Open the list', do: 'Open the ticket list.', expect: 'The ticket list is there.' }] },
    'create-plan': { role: 'admin', writes: true, steps: [{ name: 'Create a ticket', do: 'Create a ticket named with the run tag.', expect: 'It says Saved.' }] },
    // Written as read-only, but closing sends a mutation: recording promotes it to writes: true (H1's server action is such a POST).
    'close-plan': { role: 'clerk', writes: false, steps: [{ name: 'Close the first ticket', do: 'Click "Close first".', expect: 'It says Closed.' }] },
};

/**
 * Records one hand-written plan with the session tools as Claude Code would call them over MCP: caw_start, caw_status, caw. The
 * run itself starts in this process (instead of detached) so the stand-in for the person can use its chat window.
 */
const recordBySession = async (id, act, ...windows) => {
    writeFileSync(join(root, `caw/tests/${id}.yaml`), planText(id, PLANS[id]));
    rmSync(join(root, `caw/recordings/${id}.yaml`), { force: true });
    const people = humans(...windows);
    let finished = null;
    const spawnRun = (node, argv) => {
        finished = callWith({ CI: '' }, () => recordCommand(root, argv.slice(2), { interactive: true, onChatOpen: people.onChatOpen }));
        return { pid: process.pid, unref: () => {} };
    };
    const tools = Object.fromEntries(sessionTools({ root, spawnRun }).map((tool) => [tool.name, tool]));
    const started = await tools.caw_start.call({ command: 'record', test: id, env: 'local' });
    // caw_status returns at every change (sign-in, page loaded): ask again until the run waits for the agent, as Claude does.
    let waiting = await tools.caw_status.call({ wait: 120 });
    for (let tries = 0; tries < 10 && waiting.data?.state === 'running'; tries += 1) waiting = await tools.caw_status.call({ wait: 120 });
    const caw = (args, file) => tools.caw.call(file === undefined ? { args } : { args, file });
    const steps = await act(caw);
    const result = await finished;
    await people.done();
    // The run ran in this process, whose pid stays alive: drop its pid file as a detached run's would be stale now.
    for (const name of readdirSync(join(root, '.caw')).filter((file) => /^session-.*\.log\.pid$/.test(file))) rmSync(join(root, '.caw', name));
    return { started, waiting, steps, result };
};
/** The check run's window: the person adopts the test plan. */
const adopt = (chat) => chat.locator('#choices button', { hasText: /Adopt test plan/ }).click({ timeout: 90000 });
const finishAll = (ids) => JSON.stringify({ expectations: ids.map((sid) => ({ id: sid, status: 'pass', evidence: { type: 'eval', value: 'ok' } })), omit: [] });

scenario('S2', 'Record by plan as the session agent: caw_start, caw_status names the guide topics, caw drives; a read-only plan needs no approval, a writing one does', spa, async () => {
    setConfig(baseConfig({ local: ENVIRONMENTS.local }));
    let readOnlyPlan = '';
    let sawApproval = false;
    const reading = await recordBySession('list-plan', async (caw) => {
        await caw(['task']);
        readOnlyPlan = (await caw(['plan'], stepsYaml(PLANS['list-plan'].steps))).text;
        await caw(['wait-ready']);
        await caw(['check', 'S1', "document.querySelector('h1').textContent==='Tickets'"]);
        return (await caw(['finish'], finishAll(['S1']))).text;
    }, async (chat) => {
        // The recording window: an approval card would put the chat into planning; it closes when the agent finishes.
        sawApproval = await chat.locator('body[data-state=planning]').waitFor({ state: 'attached', timeout: 60000 }).then(() => true, () => false);
    }, adopt);
    const guide = reading.waiting.data?.waiting?.guide ?? [];
    verify('(1) caw_status: the run waits for the session, with the guide topics agent, plan and record', reading.waiting.data?.state === 'waiting' && ['agent', 'plan', 'record'].every((topic) => guide.includes(topic)), `${reading.waiting.data?.state} ${JSON.stringify(guide)}`);
    verify('(2) the unchanged read-only plan is approved without a card', /"approved": true/.test(readOnlyPlan) && !sawApproval, readOnlyPlan.split('\n').slice(0, 3).join(' '));
    const listed = loadTest(root, 'list-plan');
    verify('(3) adopted by the person: exit 0, recorded, writes: false kept (only GET)', reading.result.value.exit === 0 && listed.writes === false && listed.steps[0].recording !== undefined, `${shown(reading.result.value)} writes=${listed.writes}`);
    const meta = listed.steps[0].recording ?? {};
    verify('(3) S1 portability: no environments in the test; the recording has viewport, recordedOn, locale and timezone', listed.environments === undefined && meta.viewport !== undefined && meta.recordedOn === 'local' && typeof meta.locale === 'string' && typeof meta.timezone === 'string', JSON.stringify({ environments: listed.environments, viewport: meta.viewport, recordedOn: meta.recordedOn, locale: meta.locale, timezone: meta.timezone }));
    verify('(4) no token notice for the session agent', !/token/i.test(reading.result.output), reading.result.output.split('\n').find((line) => /token/i.test(line)) ?? '');

    let approvedByPerson = false;
    const writing = await recordBySession('create-plan', async (caw) => {
        const task = (await caw(['task'])).text;
        const tag = /CAW-\d+/.exec(task)?.[0] ?? 'CAW-0';
        await caw(['plan'], stepsYaml(PLANS['create-plan'].steps));
        await caw(['click', "getByRole('button', { name: 'New ticket', exact: true })"]);
        await caw(['fill', "getByRole('textbox', { name: 'Title', exact: true })", `Ticket ${tag}`]);
        await caw(['click', "getByRole('button', { name: 'Save', exact: true })"]);
        await caw(['check', 'S1', "document.getElementById('status').textContent==='Saved'"]);
        return (await caw(['finish'], finishAll(['S1']))).text;
    }, async (chat) => {
        await stateOf(chat, 'planning');
        approvedByPerson = await chat.locator('#approve').isVisible();
        await chat.locator('#approve').click();
    }, adopt);
    const created = loadTest(root, 'create-plan');
    verify('(5) the writing plan shows the approval card; adopted, the test writes and replays', approvedByPerson && writing.result.value.exit === 0 && created.writes === true, `${shown(writing.result.value)} ${writing.steps.split('\n')[0]}`);
    const replay = await go(['create-plan', '--env', 'local']);
    verify('(6) the recording replays without Claude', replay.exit === 0, `${shown(replay)} ${failNote('create-plan')}`);
    const closing = await recordBySession('close-plan', async (caw) => {
        await caw(['task']);
        await caw(['plan'], stepsYaml(PLANS['close-plan'].steps));
        await caw(['click', "getByRole('button', { name: 'Close first', exact: true })"]);
        await caw(['check', 'S1', "document.getElementById('status').textContent==='Closed'"]);
        return (await caw(['finish'], finishAll(['S1']))).text;
    }, async () => {}, adopt);
    verify('(7) a read-only plan that sent a write while recording becomes writes: true, with a warning naming it', closing.result.value.exit === 0 && loadTest(root, 'close-plan').writes === true && /CloseTicket/.test(closing.result.output), `${shown(closing.result.value)} ${closing.result.output.split('\n').find((line) => /CloseTicket|writes/.test(line)) ?? ''}`);
    for (const id of Object.keys(PLANS)) for (const path of [`caw/tests/${id}.yaml`, `caw/recordings/${id}.yaml`]) rmSync(join(root, path), { force: true });
});

scenario('S2c', 'open --attach: waits in header and chat, links after the handover, chat never blocks the session, working only from the message to the answer', spa, async () => {
    setConfig(baseConfig({ local: ENVIRONMENTS.local }));
    // Sessions of earlier scenarios listened with this process's pid and still count as alive: none may answer this window.
    for (const { key } of liveListeners(root)) unregisterListener(root, key);
    // The session runs in this process: its tools as Claude Code calls them over MCP, its listener with this pid.
    const tools = Object.fromEntries(sessionTools({ root }).map((tool) => [tool.name, tool]));
    const caw = (args) => tools.caw.call({ args });
    const working = (chat) => chat.evaluate(() => document.body.classList.contains('awaiting'));
    const seen = {};
    const owner = humans(async (chat) => {
        const bench = chat.page();
        await benchBack(chat);
        seen.workbench = await bench.locator('body:not(.solo)').count();
        // (1) Nobody listens yet: the header and the chat say whom the window waits for.
        seen.waitingFact = await bench.locator('#facts li', { hasText: 'Waiting for' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
        seen.waitingLine = await chat.locator('.message', { hasText: 'type /caw-attach' }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
        // (2) The session attaches: the window connects by itself.
        seen.key = (await tools.caw_attach.call({})).data?.key;
        seen.connected = await chat.locator('.message', { hasText: `connected (session ${seen.key})` }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        seen.connectedFact = await bench.locator('#facts li', { hasText: seen.key }).waitFor({ timeout: 10000 }).then(() => true, () => false);
        // (3) It reads its task: no "working" without a question. Its chat returns at once.
        let status = await tools.caw_status.call({ wait: 60 });
        for (let tries = 0; tries < 10 && status.data?.state !== 'waiting'; tries += 1) status = await tools.caw_status.call({ wait: 60 });
        await caw(['task']);
        const started = Date.now();
        const empty = await caw(['chat']);
        seen.quickChat = Date.now() - started < 5000 && /No new message/.test(empty.text);
        seen.idleAfterTask = !(await working(chat));
        // (4) The person asks: working until the session answers with say.
        await chat.locator('#input').fill('Why is Save disabled?');
        await chat.page().keyboard.press('Enter');
        seen.workingOnMessage = await chat.waitForFunction(() => document.body.classList.contains('awaiting'), null, { timeout: 10000 }).then(() => true, () => false);
        seen.message = (await caw(['chat'])).text;
        seen.stillWorking = await working(chat);
        await caw(['say', 'Because the form is empty.']);
        seen.offAfterSay = await chat.waitForFunction(() => !document.body.classList.contains('awaiting'), null, { timeout: 10000 }).then(() => true, () => false);
        await decide(chat, 'End run');
    });
    try {
        await callWith({ CI: '' }, () => openCommand(root, ['--env', 'local', '--role', 'clerk', '--attach'], { interactive: true, onChatOpen: owner.onChatOpen }));
        await owner.done();
    } finally {
        // The listener lives with this process: later scenarios must not find it.
        if (seen.key !== undefined) unregisterListener(root, seen.key);
    }
    verify('(0) after the handover the workbench stays (not App only)', seen.workbench === 1, JSON.stringify(seen));
    verify('(1) waiting: "○ Waiting for …" in the header and the /caw-attach line in the chat', seen.waitingFact && seen.waitingLine, JSON.stringify(seen));
    verify('(2) caw_attach connects the open window by itself; the header names the key', seen.connected && seen.connectedFact, JSON.stringify(seen));
    verify('(3) the attached session\'s chat returns at once without a message, and reading the task shows no "working"', seen.quickChat && seen.idleAfterTask, JSON.stringify(seen));
    verify('(4) the message turns "working" on, chat delivers it without turning it off, say turns it off', seen.workingOnMessage && /Why is Save disabled/.test(seen.message ?? '') && seen.stillWorking && seen.offAfterSay, JSON.stringify(seen));
});
