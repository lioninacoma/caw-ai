import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { saveTestUser } from '../src/host/test-users.mjs';
import { sessionMcpHandler, startArgs } from '../src/host/session-mcp.mjs';
import { initProject, listProject, validateProject } from '../src/host/project-data.mjs';

const TEMPLATE = readFileSync(new URL('../templates/caw.config.example.json', import.meta.url), 'utf8');
const STEPS = 'mutates: false\nsteps:\n  - id: S1\n    name: Öffnen\n    do: ""\n    expect: Startseite\n  - id: S2\n    name: Bestellen\n    do: ""\n    expect: Bestätigung\n';
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
    const doctor = (await call('caw_doctor', { agent: 'session' })).structuredContent;
    assert.ok(Array.isArray(doctor.checks) && doctor.checks.length > 0);
    assert.equal(doctor.counts.ok + doctor.counts.blocking + doctor.counts.optional, doctor.checks.length);
    assert.ok(doctor.checks.every((check) => typeof check.ok === 'boolean' && typeof check.text === 'string'));

    const validated = await call('caw_validate');
    assert.match(validated.content[0].text, /validate: Config und 1 Tests sind in Ordnung/);
    const data = validated.structuredContent;
    assert.equal(data.ok, true);
    assert.deepEqual(data.config, { issues: [], todo: [], notes: data.config.notes });
    assert.equal(data.tests[0].id, 'bestellung');
    assert.deepEqual(data.tests[0].problems, []);
    assert.equal(data.tests[0].code[0].target, 'local');
    assert.match(data.tests[0].hints[0], /bestellung\.yaml/);

    const listed = (await call('caw_list')).structuredContent;
    assert.equal(listed.config, 'ok');
    assert.deepEqual(listed.tests[0], {
        id: 'bestellung', app: 'web', role: 'tester', targets: ['local'], mutates: false, recording: { state: 'none', stale: [] },
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
    assert.equal(listed.tests[0].app, null);
});

test('caw_config: read returns raw and effective config, patch goes through writeConfig and refuses an invalid result', async (t) => {
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
    assert.equal(read.structuredContent.effective.framework, 'web');

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

    rmSync(join(root, 'caw.config.json'));
    assert.equal((await call('caw_config', {})).structuredContent.state, 'missing');
});

test('caw_init: offline without questions, existing files stay, explore first when only a url is given', async (t) => {
    const root = tempDir(t);
    const { call } = session(root);
    const first = await call('caw_init', { offline: true, roles: ['admin', 'sachbearbeiter'] });
    const data = first.structuredContent;
    assert.equal(data.state, 'done');
    assert.ok(['caw.config.json', 'caw/.env.example', '.claude/skills/caw-ai/SKILL.md', 'caw/caw.md', '.mcp.json', '.gitignore'].every((file) => data.created.includes(file)), data.created.join(', '));
    assert.ok(data.todo.includes('auth.path'));
    assert.match(first.content[0].text, /Noch TODO: auth\./);
    const config = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.roles), ['admin', 'sachbearbeiter']);
    assert.match(readFileSync(join(root, 'caw', '.env.example'), 'utf8'), /CAW_PW_SACHBEARBEITER=/);

    const again = (await call('caw_init', { offline: true })).structuredContent;
    assert.deepEqual(again.created, []);
    assert.ok(again.skipped.includes('caw.config.json'));
    assert.deepEqual(again.todo, data.todo, 'TODO of the config on disk');

    const fresh = tempDir(t);
    assert.equal(initProject(fresh, { url: 'http://localhost:5173' }).state, 'explore-first');
    assert.ok(!existsSync(join(fresh, 'caw.config.json')));
    writeFileSync(join(fresh, 'x.json'), JSON.stringify({ url: 'http://localhost:5173', auth: { type: 'none' }, framework: { value: 'react' } }));
    const explored = initProject(fresh, { fromExplore: 'x.json', noMcp: true });
    assert.equal(explored.explored, true);
    assert.ok(!explored.created.includes('.mcp.json'));
    assert.equal(JSON.parse(readFileSync(join(fresh, 'caw.config.json'), 'utf8')).environments.local.url, 'http://localhost:5173');
    assert.equal((await session(fresh).call('caw_init', { url: 'ftp://x' })).isError, true);
});

test('caw_explore: spawned detached with --login/--no-login or --yes, never asks on stdin', async (t) => {
    const root = tempDir(t);
    const { call, spawned } = session(root);
    assert.equal((await call('caw_explore', { url: 'http://localhost:5173' })).isError, true, 'login or yes is required');
    const started = await call('caw_explore', { url: 'http://localhost:5173', login: false, insecureTls: true, wait: false });
    assert.match(started.content[0].text, /explore gestartet/);
    assert.deepEqual(spawned[0].args.slice(1), ['explore', '--url', 'http://localhost:5173', '--no-login', '--insecure-tls']);
    assert.equal(spawned[0].options.stdio[0], 'ignore');
    assert.equal(started.structuredContent.state, 'started');
});

test('caw_explore waits for the window and returns the suggestions with the saved roles', async (t) => {
    const root = tempDir(t);
    let polls = 0;
    // The window is open for two polls; meanwhile explore writes its result.
    const alive = () => {
        polls += 1;
        if (polls === 2) {
            mkdirSync(join(root, 'caw'), { recursive: true });
            writeFileSync(join(root, 'caw', '.explore.json'), JSON.stringify({ url: 'http://localhost:5173', framework: { value: 'react' }, roles: ['clerk'] }));
        }
        return polls < 3;
    };
    const { call } = session(root, { windowWait: { alive, pollMs: 1 } });
    const done = await call('caw_explore', { url: 'http://localhost:5173', login: true });
    assert.equal(done.structuredContent.state, 'done');
    assert.deepEqual(done.structuredContent.explore.roles, ['clerk']);
    assert.match(done.content[0].text, /clerk/);
    // Closed without a result: an error with the last output; still open after the time limit: running.
    const closed = await session(tempDir(t), { windowWait: { alive: () => false } }).call('caw_explore', { url: 'http://localhost:5173', login: true });
    assert.equal(closed.isError, true);
    assert.equal(closed.structuredContent.state, 'ended');
    const open = await session(tempDir(t), { windowWait: { alive: () => true, pollMs: 1, timeoutMs: 5 } }).call('caw_explore', { url: 'http://localhost:5173', yes: true });
    assert.equal(open.structuredContent.state, 'running');
});

test('caw_role add waits for the window and names the roles that got a test user', async (t) => {
    const root = project(t);
    let polls = 0;
    const alive = () => {
        polls += 1;
        if (polls === 2) saveTestUser(root, { role: 'clerk', user: 'c', password: 'secret-value' });
        return polls < 3;
    };
    const { call, spawned } = session(root, { windowWait: { alive, pollMs: 1 } });
    const done = await call('caw_role', { action: 'add', name: 'clerk', target: 'local' });
    assert.deepEqual(spawned.at(-1).args.slice(1), ['role', 'add', 'clerk', '--target', 'local']);
    assert.equal(done.structuredContent.state, 'done');
    assert.deepEqual(done.structuredContent.saved, ['clerk']);
    assert.ok(!JSON.stringify(done).includes('secret-value'), 'never the values');
    const nothing = await session(root, { windowWait: { alive: () => false } }).call('caw_role', { action: 'add', name: 'auditor' });
    assert.equal(nothing.isError, true);
    assert.deepEqual(nothing.structuredContent.saved, []);
});

test('caw_explore: its result shows up in caw_status once written', async (t) => {
    const root = tempDir(t);
    const { call } = session(root);
    await call('caw_explore', { url: 'http://localhost:5173', yes: true, wait: false });
    mkdirSync(join(root, 'caw'), { recursive: true });
    writeFileSync(join(root, 'caw', '.explore.json'), JSON.stringify({ url: 'http://localhost:5173', framework: { value: 'react' } }));
    const status = (await call('caw_status')).structuredContent;
    assert.equal(status.state, 'ended');
    assert.equal(status.started.command, 'explore');
    assert.deepEqual(status.explore.framework, { value: 'react' });
});

test('caw_start: typed fields build the command line, mixing with args and wrong fields are refused', async (t) => {
    assert.deepEqual(startArgs({ command: 'run', test: 'bestellung', target: 'dev', until: 'S4', overlay: 'dev', headless: true }),
        ['bestellung', '--target', 'dev', '--until', 'S4', '--overlay=dev', '--headless']);
    assert.deepEqual(startArgs({ command: 'fix', test: 'bestellung', step: 'S3', overlay: true }), ['bestellung', 'S3', '--overlay']);
    assert.deepEqual(startArgs({ command: 'open', target: 'dev', overlay: 'http://localhost:1841' }), ['--target', 'dev', '--overlay=http://localhost:1841']);
    assert.deepEqual(startArgs({ command: 'record', args: ['x', '--target', 'local'] }), ['x', '--target', 'local']);
    assert.throws(() => startArgs({ command: 'run', test: 'x', args: ['x'] }), /nicht beides/);
    assert.throws(() => startArgs({ command: 'record', test: 'x', until: 'S2' }), /until gilt nicht für record/);
    assert.throws(() => startArgs({ command: 'fix', test: 'x' }), /fix braucht step/);
    assert.throws(() => startArgs({ command: 'open', test: 'x' }), /test gilt nicht für open/);
    assert.throws(() => startArgs({ command: 'run', test: 'x', overlay: 'irgendwo' }), /overlay muss/);
    assert.throws(() => startArgs({ command: 'run', test: '--all' }), /ungültigen Wert/);

    const root = project(t);
    const { call, spawned } = session(root, { overlayPreconditions: () => ({ state: 'ready' }) });
    const started = await call('caw_start', { command: 'run', test: 'bestellung', target: 'local', until: 'S2' });
    assert.equal(started.isError, false);
    assert.equal(started.structuredContent.state, 'started');
    assert.deepEqual(spawned[0].args.slice(1), ['run', 'bestellung', '--target', 'local', '--until', 'S2', '--agent', 'session']);
    assert.ok(started.content[0].text.startsWith('Gestartet'));
    const meta = JSON.parse(readFileSync(join(root, started.structuredContent.log.replace(/\.log$/, '.log.json')), 'utf8'));
    assert.equal(meta.command, 'run');
});

test('caw_start: open is allowed, config problems come back with their code', async (t) => {
    const root = project(t, { config: null });
    const { call, spawned } = session(root);
    const missing = await call('caw_start', { command: 'open', target: 'local' });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.code, 'config-missing');
    assert.equal(spawned.length, 0);
    writeFileSync(join(root, 'caw.config.json'), '{ kaputt');
    assert.equal((await call('caw_start', { command: 'open' })).structuredContent.code, 'config-invalid');
    writeFileSync(join(root, 'caw.config.json'), TEMPLATE);
    await call('caw_start', { command: 'open', target: 'local' });
    assert.deepEqual(spawned[0].args.slice(1), ['open', '--target', 'local', '--agent', 'session']);
});

test('caw_start with overlay: a missing watch returns the command instead of starting', async (t) => {
    const root = project(t);
    const asked = [];
    const overlayPreconditions = (dir, config, options) => {
        asked.push({ dir, options, framework: config.framework });
        return { state: 'watch-missing', framework: 'extjs', appDir: 'projects/apps/App', command: 'sencha app watch' };
    };
    const { call, spawned } = session(root, { overlayPreconditions });
    const result = await call('caw_start', { command: 'run', test: 'bestellung', target: 'local', overlay: true });
    assert.equal(spawned.length, 0, 'nothing started');
    assert.deepEqual(result.structuredContent, { state: 'watch-missing', command: 'sencha app watch', appDir: 'projects/apps/App', framework: 'extjs' });
    assert.match(result.content[0].text, /Nicht gestartet \(watch-missing\).*projects\/apps\/App: sencha app watch/);
    assert.deepEqual(asked[0].options, { target: 'local', app: 'web' });
    // Raw args with --overlay are checked as well; without overlay there is no check.
    await call('caw_start', { command: 'record', args: ['bestellung', '--target=local', '--overlay=build'] });
    assert.equal(asked.length, 2);
    assert.equal(spawned.length, 0);
    await call('caw_start', { command: 'run', test: 'bestellung' });
    assert.equal(asked.length, 2);
    assert.equal(spawned.length, 1);
});

test('caw_overlay_check: runs the CLI with --json, returns its result; falls back to the file; timeout is an error', async (t) => {
    const root = project(t);
    const calls = [];
    const result = { state: 'ready', parts: [{ label: 'app', status: 'local' }], missed: [], notLoaded: [], suggestion: null };
    let reply = { code: 0, out: `[caw-ai] noise\n${JSON.stringify(result)}\n`, err: '' };
    const execCli = async (args, options) => { calls.push({ args, options }); return typeof reply === 'function' ? reply() : reply; };
    const { call } = session(root, { execCli });
    const checked = await call('caw_overlay_check', { target: 'dev', app: 'antrag', apply: true });
    assert.deepEqual(calls[0].args, ['overlay', 'check', '--json', '--target', 'dev', '--app', 'antrag', '--apply']);
    assert.equal(calls[0].options.timeoutMs, 180_000);
    assert.deepEqual(checked.structuredContent, { ...result, exit: 0 });
    assert.match(checked.content[0].text, /overlay check: ready/);

    reply = () => {
        mkdirSync(join(root, '.caw'), { recursive: true });
        writeFileSync(join(root, '.caw', 'overlay-check.json'), JSON.stringify({ ...result, state: 'incomplete' }));
        return { code: 2, out: '', err: 'unvollständig' };
    };
    const fromFile = await call('caw_overlay_check');
    assert.equal(fromFile.structuredContent.state, 'incomplete');
    assert.equal(fromFile.structuredContent.exit, 2);
    assert.equal(fromFile.isError, false);

    reply = { code: null, out: '', err: '', timedOut: true };
    const late = await call('caw_overlay_check');
    assert.equal(late.isError, true);
    assert.equal(late.structuredContent.state, 'timeout');
    assert.equal((await call('caw_overlay_check', { target: '--apply' })).isError, true);
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
    assert.deepEqual([data.command, data.test, data.target], ['run', 'bestellung', 'local']);
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
