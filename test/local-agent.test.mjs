import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { LOCAL_ALLOWED, LOCAL_DENY, LOCAL_TOOLS, localClaudeArgs, writeLocalSetup } from '../src/sandbox/commands.mjs';
import { AGENT_COMMANDS, commandLine, createMcpHandler, serveMcp } from '../src/sandbox/mcp.mjs';
import { claudeVersion, localAgentEnv, localCommand, requireClaude } from '../src/host/local-agent.mjs';
import { resolveClaude } from '../src/shared/claude-bin.mjs';
import { agentSandbox, validateConfig } from '../src/shared/config.mjs';

const tempDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-local-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

test('Lokal: nur Lesen und das Tool caw, keine Shell, nichts wird gefragt, Geheimnisse gesperrt', () => {
    const args = localClaudeArgs('Der Lauf x ist offen.', { mcpConfig: 'm.json', settings: 's.json', systemPromptFile: 'a.md' });
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--setting-sources') + 1], '', 'keine allow-Regeln aus Nutzer- oder Projekteinstellungen');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.deepEqual(LOCAL_ALLOWED, ['Read(./**)', 'Grep(./**)', 'Glob(./**)', 'mcp__caw__caw'], 'nur im Projekt lesen');
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) assert.ok(!args.join(' ').includes(tool), tool);
    for (const pattern of ['Read(.env)', 'Grep(caw/.auth/**)', 'Glob(.git/**)', 'Read(.caw/**)', 'Read(**/.npmrc)']) assert.ok(LOCAL_DENY.includes(pattern), pattern);
});

test('Lokal: Einrichtung im Agent-Ordner, die Anleitung ist der Skill mit Vorspann', (t) => {
    const dir = tempDir(t);
    const setup = writeLocalSetup(dir, { CAW_COLOR: '1' });
    const mcp = JSON.parse(readFileSync(setup.mcpConfig, 'utf8')).mcpServers.caw;
    assert.deepEqual(mcp.args.slice(-1), ['mcp-agent']);
    assert.equal(mcp.env.CAW_AGENT_DIR, dir);
    assert.equal(mcp.env.CAW_SANDBOX, '1');
    assert.equal(JSON.parse(readFileSync(setup.settings, 'utf8')).disableAllHooks, true);
    // Aus den Nutzereinstellungen nur die Verbindung, nie Rechte.
    const home = tempDir(t);
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://proxy:8080' }, model: 'opus', permissions: { allow: ['Read'] }, additionalDirectories: ['/'] }));
    const carried = JSON.parse(readFileSync(writeLocalSetup(dir, { CLAUDE_CONFIG_DIR: home }).settings, 'utf8'));
    assert.deepEqual(carried.env, { HTTPS_PROXY: 'http://proxy:8080' });
    assert.equal(carried.model, 'opus');
    assert.equal(carried.additionalDirectories, undefined);
    assert.deepEqual(Object.keys(carried.permissions), ['deny']);
    const guide = readFileSync(setup.systemPromptFile, 'utf8');
    assert.match(guide, /^Du laeufst lokal/);
    assert.match(guide, /## Ablauf in der Sandbox/);
    assert.doesNotMatch(guide, /^---/m, 'ohne Frontmatter des Skills');
});

test('MCP: Befehle wie in der Sandbox, Dateien als Inhalt, Host-Befehle abgelehnt', (t) => {
    const dir = tempDir(t);
    const files = [];
    const write = (content) => { files.push(content); return join(dir, 'f.txt'); };
    assert.deepEqual(commandLine({ args: ['click', 'e12'] }, write), ['click', 'e12']);
    assert.deepEqual(commandLine({ args: ['plan'], file: 'steps: []' }, write), ['plan', '--file', join(dir, 'f.txt')]);
    assert.deepEqual(files, ['steps: []']);
    assert.throws(() => commandLine({ args: ['run', 'x'] }, write), /Unbekannter Befehl: run/);
    assert.throws(() => commandLine({ args: ['sandbox-run'] }, write), /Unbekannter Befehl/);
    assert.throws(() => commandLine({ args: ['finish'] }, write), /braucht den Inhalt in file/);
    assert.throws(() => commandLine({ args: ['snapshot'], file: 'x' }, write), /nimmt kein file/);
    assert.throws(() => commandLine({ args: [] }, write), /args muss/);
    for (const host of ['init', 'record', 'fix', 'auth', 'doctor', 'mcp-agent', 'firewall-check']) assert.ok(!AGENT_COMMANDS.has(host), host);
});

test('MCP: Protokoll mit initialize, tools/list und tools/call; Dateien werden danach geloescht', async (t) => {
    const dir = tempDir(t);
    const calls = [];
    const handler = createMcpHandler({
        agentDir: dir,
        run: async (args) => {
            calls.push(args);
            if (args[0] === 'finish') assert.equal(readFileSync(args[2], 'utf8'), '{"expectations":[]}');
            return args[0] === 'goto' ? { code: 3, out: 'Ziel nicht erlaubt' } : { code: 0, out: `${args[0]} ok\n` };
        },
    });
    const init = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const list = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map(({ name }) => name), ['caw']);
    const snap = await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'caw', arguments: { args: ['snapshot'] } } });
    assert.deepEqual(snap.result, { content: [{ type: 'text', text: 'snapshot ok' }], isError: false });
    const done = await handler({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'caw', arguments: { args: ['finish'], file: '{"expectations":[]}' } } });
    assert.equal(done.result.isError, false);
    assert.ok(!existsSync(calls[1][2]), 'Datei geloescht');
    const denied = await handler({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'caw', arguments: { args: ['goto', 'https://example.com'] } } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /Ziel nicht erlaubt\n\(Exit 3\)/);
    const bad = await handler({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'caw', arguments: { args: ['init'] } } });
    assert.equal(bad.result.isError, true);
    assert.deepEqual(calls.map(([command]) => command), ['snapshot', 'finish', 'goto'], 'abgelehnte Befehle laufen nie');
    const unknown = await handler({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
    assert.equal(unknown.error.code, -32601);
});

test('MCP: eine Nachricht je Zeile ueber stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = [];
    output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter(Boolean)));
    const served = serveMcp(createMcpHandler({ agentDir: tmpdir(), run: async () => ({ code: 0, out: '' }) }), { input, output });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nkaputt\n');
    input.end();
    await served;
    await new Promise((ok) => { setImmediate(ok); });
    const answers = lines.map((line) => JSON.parse(line));
    assert.deepEqual(answers.find(({ id }) => id === 1), { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal(answers.find(({ id }) => id === null).error.code, -32700);
});

test('Lokaler Agent: caw-ai aus diesem Paket, Kennzeichen fuer den Agenten, Claude Code im PATH', (t) => {
    const dir = tempDir(t);
    const [node, bin, ...rest] = localCommand(['caw-ai', 'sandbox-run', '--run-id', 'x']);
    assert.equal(node, process.execPath);
    assert.match(bin, /caw-ai\.mjs$/);
    assert.deepEqual(rest, ['sandbox-run', '--run-id', 'x']);
    assert.deepEqual(localCommand(['bash', '-c', 'x']), ['bash', '-c', 'x']);
    const env = localAgentEnv(dir, { color: true, env: { Path: 'C:\\bin' } });
    assert.equal(env.CAW_SANDBOX, '1');
    assert.equal(env.CAW_AGENT_LOCAL, '1');
    assert.equal(env.CAW_AGENT_DIR, dir);
    assert.equal(env.CAW_COLOR, '1');
    assert.ok(env.Path.startsWith(join(dir, '.bin')) && env.Path.endsWith('C:\\bin'), 'PATH-Schreibweise von Windows bleibt');
    assert.ok(existsSync(join(dir, '.bin', 'caw-ai')) && existsSync(join(dir, '.bin', 'caw-ai.cmd')));
    const found = { file: 'claude', args: [] };
    assert.equal(claudeVersion(() => ({ status: 0, stdout: '2.1.319 (Claude Code)\n' }), found), '2.1.319');
    assert.equal(claudeVersion(() => ({ error: new Error('ENOENT') }), found), undefined);
    assert.equal(claudeVersion(() => ({ status: 0, stdout: '2.1.319' }), null), undefined, 'nicht gefunden');
    assert.throws(() => requireClaude(() => ({ status: 1, stdout: '' }), found), /nicht im PATH/);
    // Windows: nativ vor npm; npm-Installation ueber das Node-Skript, nie ueber die Shell.
    const where = (stdout) => () => ({ status: 0, stdout });
    assert.deepEqual(resolveClaude({ platform: 'win32', run: where('C:\\a\\claude.cmd\r\nC:\\b\\claude.exe\r\n') }), { file: 'C:\\b\\claude.exe', args: [] });
    const npm = resolveClaude({ platform: 'win32', run: where('C:\\npm\\claude.cmd\r\n'), exists: () => true, node: 'node.exe' });
    assert.equal(npm.file, 'node.exe');
    assert.match(npm.args[0], /claude-code[\\/]cli\.js$/);
    assert.equal(resolveClaude({ platform: 'win32', run: where('C:\\npm\\claude.cmd\r\n'), exists: () => false }), undefined);
    assert.deepEqual(resolveClaude({ platform: 'linux' }), { file: 'claude', args: [] });
});

test('Config: agent.sandbox, Standard lokal, in CI immer Docker', () => {
    assert.equal(agentSandbox({}, {}), 'local');
    assert.equal(agentSandbox({ agent: { sandbox: 'docker' } }, {}), 'docker');
    assert.equal(agentSandbox({ agent: { sandbox: 'local' } }, { CI: 'true' }), 'docker');
    const base = { framework: 'web', environments: { local: { url: 'http://app.localhost:5173', agent: true } }, auth: { type: 'none' }, apps: { app: { path: '/' } } };
    const issues = (agent) => validateConfig({ ...base, agent }).issues.filter((issue) => issue.startsWith('agent')).join('\n');
    assert.equal(issues({ sandbox: 'docker' }), '');
    assert.match(issues({ sandbox: 'vm' }), /agent\.sandbox muss einer von local, docker/);
    assert.match(issues({ image: 'x' }), /agent\.image gibt es nicht/);
    assert.match(issues('docker'), /agent muss ein Objekt sein/);
});

test('Session als Agent: Marke nur waehrend des Laufs, fremde Marke bleibt, toter Prozess zaehlt nicht', async (t) => {
    const { announceSessionAgent, findSessionAgent, markerPath } = await import('../src/shared/session-agent.mjs');
    const root = tempDir(t);
    assert.equal(findSessionAgent(root), undefined);
    const agent = announceSessionAgent({ root, runId: 'r1', agentDir: join(root, 'a'), mode: 'run', hint: 'Lauf r1' });
    assert.equal(findSessionAgent(root).agentDir, join(root, 'a'));
    const newer = announceSessionAgent({ root, runId: 'r2', agentDir: join(root, 'b'), mode: 'talk', hint: 'Lauf r2' });
    await agent.stop();
    assert.equal(findSessionAgent(root).runId, 'r2', 'die Marke des neueren Laufs bleibt');
    await newer.stop();
    assert.ok(!existsSync(markerPath(root)));
    announceSessionAgent({ root, runId: 'r3', agentDir: 'x', mode: 'run', hint: '', pid: 2 ** 22 + 12345 });
    assert.equal(findSessionAgent(root), undefined, 'Prozess gibt es nicht mehr');
});

test('caw-ai mcp: Lauf starten mit --agent session, Status, Auswahl, caw nur mit wartendem Lauf', async (t) => {
    const { sessionMcpHandler, startRun } = await import('../src/host/session-mcp.mjs');
    const { announceSessionAgent } = await import('../src/shared/session-agent.mjs');
    const root = tempDir(t);
    const spawned = [];
    const spawnRun = (file, args, options) => { spawned.push({ args, options }); return { pid: 999999, unref: () => {} }; };
    const calls = [];
    const handler = sessionMcpHandler({ root, spawnRun, run: async (args, env) => { calls.push({ args, env }); return { code: 0, out: 'ok' }; } });
    const call = async (name, args) => (await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
    const list = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map(({ name }) => name), ['caw_start', 'caw_status', 'caw_selection', 'caw']);
    assert.ok(list.result.tools.every((tool) => tool.call === undefined && tool.inputSchema !== undefined));

    assert.match((await call('caw_status', {})).content[0].text, /Kein Lauf wartet/);
    const started = await call('caw_start', { command: 'record', args: ['bestellung', '--target', 'local'] });
    assert.match(started.content[0].text, /Gestartet \(pid 999999\)/);
    assert.deepEqual(spawned[0].args.slice(-5), ['record', 'bestellung', '--target', 'local', '--agent', 'session'].slice(-5));
    assert.equal(spawned[0].args.at(-1), 'session');
    assert.equal(spawned[0].options.cwd, root);
    assert.equal((await call('caw_start', { command: 'init', args: [] })).isError, true);
    assert.equal((await call('caw_start', { command: 'run', args: ['x', '--agent', 'docker'] })).isError, true);

    // Der gestartete Prozess (pid 999999) lebt nicht: caw_status sagt, dass der Lauf beendet ist, statt nur „wartet nicht“.
    assert.match((await call('caw_status', {})).content[0].text, /der letzte ist beendet/);
    const denied = await call('caw', { args: ['snapshot'] });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /caw_start/);
    assert.equal(calls.length, 0);

    const agent = announceSessionAgent({ root, runId: 'r9', agentDir: join(root, 'agent'), mode: 'run', hint: 'Der Lauf r9 ist offen.' });
    t.after(() => agent.stop());
    assert.match((await call('caw_status', {})).content[0].text, /Lauf r9 wartet auf dich \(run\)/);
    assert.equal((await call('caw', { args: ['snapshot'] })).isError, false);
    assert.equal(calls[0].env.CAW_AGENT_DIR, join(root, 'agent'));
    assert.match((await call('caw_selection', {})).content[0].text, /Noch kein Element/);
    assert.throws(() => startRun({ root, command: 'run', args: 'x' }), /args muss/);
    agent.stop();

    // Ein Lauf, dessen Prozess noch lebt, aber gerade nicht auf die Session wartet: caw_status sagt das, caw_start wartet.
    const log = readdirSync(join(root, '.caw')).find((name) => name.endsWith('.log.pid'));
    writeFileSync(join(root, '.caw', log), String(process.pid));
    assert.ok((await call('caw_status', {})).content[0].text.includes(`Ein Lauf läuft (pid ${process.pid}), wartet aber gerade nicht`));
    const second = await call('caw_start', { command: 'run', args: ['x'] });
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /läuft noch/);
});

test('Chat: Element geht beim Klären und Entwickeln mit, Wahl ist dort möglich', async () => {
    const { createChat } = await import('../src/host/chat.mjs');
    const states = [];
    const chat = createChat({ status: (state) => states.push(state) });
    const element = { label: 'button "Senden"' };
    assert.equal(chat.canPick(), false);
    const discussed = chat.discuss('S2 ist gescheitert.', [{ id: 'fix', label: 'Schritt beheben' }]);
    assert.equal(chat.canPick(), true, 'beim Klären');
    chat.attach(element);
    chat.human.message('Was ist damit?');
    assert.deepEqual(await discussed, { message: 'Was ist damit?', element });
    const developing = chat.develop('Zustand S2 steht.', [{ id: 'end', label: 'Beenden' }]);
    assert.equal(states.at(-1), 'developing');
    assert.equal(chat.canPick(), true, 'beim Entwickeln');
    chat.attach(element);
    assert.deepEqual(chat.takeElement(), element);
    assert.equal(chat.takeElement(), null);
    chat.human.choose('end');
    assert.deepEqual(await developing, { choice: 'end' });
    chat.human.closed();
    assert.equal(await chat.develop('x', []), null);
});
