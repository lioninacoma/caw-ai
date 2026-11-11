import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { auth, init, record, run, starterConfig, validate } from '../src/host/commands.mjs';
import { exitOf } from '../src/shared/errors.mjs';

test('init: passes validate at once, creates no example test, credentials are git-ignored', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-init-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const said = [];
    t.mock.method(console, 'log', (text) => said.push(text));
    init(root);
    assert.equal(validate(root), 0);
    assert.deepEqual(readdirSync(join(root, 'caw', 'tests')), ['.gitkeep'], 'no unrequested example test, but the folder');
    assert.match(readFileSync(join(root, 'caw', 'caw.md'), 'utf8'), /^# Notizen für Claude\n[\s\S]*\n- Beispiel:/);
    assert.match(said.join('\n'), /den ersten Test aufnehmen: caw-ai record <test> --target local\. Ohne passende Selektoren erst caw-ai explore/);
    // If explore just ran, init does not advise running it first.
    const explored = mkdtempSync(join(tmpdir(), 'caw-init-explored-'));
    t.after(() => rmSync(explored, { recursive: true, force: true }));
    said.length = 0;
    init(explored, { explored: true, url: 'http://localhost:5173', login: {} });
    assert.doesNotMatch(said.join('\n'), /explore --url/);
    // An existing caw.md stays as it is.
    writeFileSync(join(explored, 'caw', 'caw.md'), 'eigen');
    init(explored);
    assert.equal(readFileSync(join(explored, 'caw', 'caw.md'), 'utf8'), 'eigen');
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('.caw/') && ignore.includes('caw/.env') && ignore.includes('caw/.auth/'));
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers['caw-ai'], { command: 'node', args: ['node_modules/caw-ai/bin/caw-ai.mjs', 'mcp'] });
});

test('init: extends an existing .mcp.json, leaves the rest alone, and skips it without mcp', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-init-mcp-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { andere: { command: 'x' } } }));
    init(root);
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['andere', 'caw-ai']);
    const other = mkdtempSync(join(tmpdir(), 'caw-init-nomcp-'));
    t.after(() => rmSync(other, { recursive: true, force: true }));
    init(other, { mcp: false });
    assert.throws(() => readFileSync(join(other, '.mcp.json')), /ENOENT/);
});

test('readCredentials: environment before caw/.env, session per target', async (t) => {
    const { readCredentials } = await import('../src/host/run.mjs');
    const { sessionPath } = await import('../src/shared/config.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-cred-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const form = { auth: { type: 'form' }, roles: { kunde: { loginEnv: 'CAW_LOGIN_KUNDE', passwordEnv: 'CAW_PW_KUNDE' } } };
    assert.throws(() => readCredentials(root, form, 'kunde', 'local', {}), /CAW_LOGIN_KUNDE, CAW_PW_KUNDE fehlen: als Umgebungsvariablen oder in caw\/\.env setzen/);
    assert.throws(() => readCredentials(root, form, 'kunde', 'local', { CAW_LOGIN_KUNDE: 'x' }), /CAW_PW_KUNDE fehlt: als Umgebungsvariable oder/);
    mkdirSync(join(root, 'caw'), { recursive: true });
    writeFileSync(join(root, 'caw', '.env'), 'CAW_LOGIN_KUNDE=aus-datei\nCAW_PW_KUNDE=pw-datei\n');
    assert.deepEqual(readCredentials(root, form, 'kunde', 'local', {}), { login: 'aus-datei', password: 'pw-datei' });
    assert.deepEqual(readCredentials(root, form, 'kunde', 'local', { CAW_LOGIN_KUNDE: 'aus-ci' }), { login: 'aus-ci', password: 'pw-datei' });
    const stored = { auth: { type: 'storageState' }, roles: { kunde: {} } };
    assert.equal(sessionPath('nord/staging', 'kunde'), 'caw/.auth/nord/staging/kunde.json');
    assert.throws(() => readCredentials(root, stored, 'kunde', 'staging', {}), /auf staging keine gespeicherte Sitzung.*--target staging/);
    mkdirSync(join(root, 'caw', '.auth', 'staging'), { recursive: true });
    writeFileSync(join(root, sessionPath('staging', 'kunde')), '{}');
    assert.equal(readCredentials(root, stored, 'kunde', 'staging', {}).storageState, join(root, 'caw', '.auth', 'staging', 'kunde.json'));
    assert.throws(() => readCredentials(root, stored, 'kunde', 'local', {}), /auf local/, 'another target\'s session does not count');
});

test('readCredentials: a role with totpEnv yields its TOTP secret, and names it when missing', async (t) => {
    const { readCredentials } = await import('../src/host/run.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-cred-totp-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const form = { auth: { type: 'form' }, roles: { admin: { loginEnv: 'CAW_LOGIN_ADMIN', passwordEnv: 'CAW_PW_ADMIN', totpEnv: 'CAW_TOTP_ADMIN' } } };
    const env = { CAW_LOGIN_ADMIN: 'a', CAW_PW_ADMIN: 'p' };
    assert.throws(() => readCredentials(root, form, 'admin', 'local', env), /CAW_TOTP_ADMIN fehlt/);
    assert.deepEqual(readCredentials(root, form, 'admin', 'local', { ...env, CAW_TOTP_ADMIN: 'GEZDGNBV' }), { login: 'a', password: 'p', totpSecret: 'GEZDGNBV' });
});

test('runMode names the mode and the reason, no mode follows silently from the environment', async () => {
    const { runMode } = await import('../src/host/commands.mjs');
    const base = { withAgent: true, noChat: false, headless: false, inCi: false, withAdvice: false, environments: 'dev' };
    assert.match(runMode(base), /mit Chat\. Fehlende Vergleichswerte lernt/);
    assert.match(runMode({ ...base, withAdvice: true }), /--advise, kostet Token/);
    assert.match(runMode({ ...base, inCi: true }), /Variable CI.*unverändert/);
    assert.match(runMode({ ...base, noChat: true }), /--no-chat/);
    assert.match(runMode({ ...base, headless: true, noChat: true }), /--headless/);
    assert.match(runMode({ ...base, withAgent: false }), /nur auf dev/);
});

test('auth: saves a role\'s session, only with storageState and never on production', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-auth-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const write = (authConfig) => writeFileSync(join(root, 'caw.config.json'), JSON.stringify({
        environments: { local: { url: 'http://app.localhost:5173', claude: true }, live: { url: 'https://www.shop.example', production: true } },
        auth: authConfig,
        apps: { web: { dir: '.', startUrl: '/' } },
        roles: { kunde: authConfig.type === 'form' ? { loginEnv: 'L', passwordEnv: 'P' } : {} },
    }));
    write({ type: 'storageState', path: '/sso', signedInSelector: '#menu' });
    const calls = [];
    const capture = async (options) => {
        calls.push(options);
        return true;
    };
    assert.equal(await auth(root, ['kunde', '--target', 'local'], { capture }), 0);
    assert.equal(calls[0].url, 'http://app.localhost:5173/sso');
    assert.equal(calls[0].signedInSelector, '#menu');
    assert.equal(calls[0].file, join(root, 'caw', '.auth', 'local', 'kunde.json'));
    assert.deepEqual(calls[0].hosts, ['app.localhost'], 'production never in another target\'s host lock');
    assert.equal(await auth(root, ['kunde', '--target', 'local'], { capture: async () => false }), 2, 'window closed: nothing saved');
    await assert.rejects(auth(root, ['kunde', '--target', 'live'], { capture }), /Produktion/);
    await assert.rejects(auth(root, ['gast', '--target', 'local'], { capture }), /Rolle gast/);
    await assert.rejects(auth(root, ['kunde'], { capture }), /Aufruf/);
    write({ type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#menu' });
    await assert.rejects(auth(root, ['kunde', '--target', 'local'], { capture }), /nur mit auth.type storageState/);
    assert.equal(calls.length, 1);
});

test('sandboxBase: image from the config, from the devcontainer, otherwise Node', async (t) => {
    const { DEFAULT_SANDBOX_IMAGE, sandboxBase } = await import('../src/host/commands.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-image-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(sandboxBase(root, {}), { image: DEFAULT_SANDBOX_IMAGE, user: 'node' });
    assert.deepEqual(sandboxBase(root, { sandboxImage: 'own:1' }), { image: 'own:1', user: 'devuser' });
    mkdirSync(join(root, '.devcontainer'));
    writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{ // comment\n "image": "dev:2" }');
    assert.deepEqual(sandboxBase(root, { sandboxUser: 'me' }), { image: 'dev:2', user: 'me' });
});

test('doctor: names the next step per problem, optional items do not block, never values', async (t) => {
    const { doctor, doctorChecks } = await import('../src/host/doctor.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-doctor-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const probed = [];
    const probes = { chrome: async () => {}, claude: () => '2.1.0', docker: async () => { throw new Error('Kein Docker gefunden'); }, reachable: async (url) => { probed.push(url); return url.startsWith('http://'); } };
    const missing = await doctorChecks(root, { env: {}, probes });
    assert.match(missing.find(({ ok }) => !ok).next, /caw-ai init/);
    init(root);
    const initial = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    assert.deepEqual(Object.keys(initial.environments), ['local'], 'no placeholder environment from the template');
    // A real address that does not answer, and a placeholder that is never probed.
    initial.environments.staging = { url: 'https://staging.firma.intern' };
    initial.environments.demo = { url: 'https://demo.example.com' };
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(initial, null, 4));
    writeFileSync(join(root, 'caw', '.env'), 'CAW_LOGIN_TESTER=geheim-login\nCAW_PW_TESTER=geheim-pw\n');
    const lines = [];
    const ui = { success: (text) => lines.push(`ok ${text}`), note: (text) => lines.push(`opt ${text}`), warn: (text) => lines.push(`warn ${text}`) };
    assert.equal(await doctor(root, { ui, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-geheim' }, nodeVersion: '22.4.0', probes }), 0);
    const output = lines.join('\n');
    assert.match(output, /ok OK +Rolle tester: Zugangsdaten gesetzt/);
    assert.match(output, /ok OK +Claude Code 2\.1\.0 \(Claude läuft lokal, ohne Docker\)/);
    assert.doesNotMatch(output, /Docker gefunden|OAUTH_TOKEN/, 'locally neither Docker nor token count');
    assert.match(output, /ok OK +local: http:\/\/localhost:5173 antwortet/);
    assert.match(output, /opt OPTIONAL +staging: https:\/\/staging\.firma\.intern antwortet nicht/);
    assert.match(output, /opt OPTIONAL +demo: https:\/\/demo\.example\.com ist ein Platzhalter\. Die echte Adresse/);
    assert.ok(!probed.some((url) => url.includes('example.com')), 'placeholders are never probed');
    assert.match(output, /ok \d+ in Ordnung, 0 fehlen, \d+ optional offen\. Bereit\. Nächster Schritt: den ersten Test aufnehmen/);
    assert.equal(missing.find(({ ok }) => !ok).text, 'caw.config.json fehlt', 'without a double full stop');
    assert.doesNotMatch(output, /geheim/);
    lines.length = 0;
    assert.equal(await doctor(root, { ui, env: {}, nodeVersion: '20.1.0', probes }), 2, 'too old Node blocks');
    assert.match(lines.join('\n'), /warn FEHLT +Node 20.1.0 ist zu alt/);
    assert.match(lines.join('\n'), /warn .*1 fehlt.*Erst die mit FEHLT beheben/);
    writeFileSync(join(root, '.gitignore'), '# runs\n/.caw\n**/caw/.auth/\n.env\n');
    const loose = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes });
    assert.ok(loose.find(({ text }) => text.startsWith('.gitignore')).ok, 'gitignore compared loosely');
    const withoutClaude = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes: { ...probes, claude: () => undefined } });
    assert.match(withoutClaude.find(({ text }) => /claude/.test(text)).next, /agent\.sandbox "docker"/);
    // A selector explore did not find is TODO: doctor blocks until it is filled in.
    const configPath = join(root, 'caw.config.json');
    const saved = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, saved.replace(/"signedInSelector": "[^"]*"/, '"signedInSelector": "TODO"'));
    const todo = (await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes })).find(({ text }) => /TODO/.test(text));
    assert.ok(todo && !todo.ok && !todo.optional && /auth\.signedInSelector/.test(todo.text), JSON.stringify(todo));
    // Also a TODO path is a gap, not an invalid config: one line naming every TODO field.
    writeFileSync(configPath, saved.replace(/"path": "[^"]*"/, '"path": "TODO"').replace(/"userSelector": "[^"]*"/, '"userSelector": "TODO"'));
    const checks = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes });
    assert.ok(checks.some(({ ok, text }) => ok && /caw\.config\.json ist gültig/.test(text)));
    assert.ok(checks.some(({ ok, text }) => !ok && text === 'auth.path, auth.userSelector stehen noch auf TODO'), JSON.stringify(checks));
    // An invalid config: the first real finding, not just "caw.config.json:".
    writeFileSync(configPath, saved.replace('"local": {', '"local": { "agent": true, "localCode": true,'));
    const broken = (await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes })).find(({ text }) => text.startsWith('caw.config.json'));
    assert.equal(broken.text, 'caw.config.json: environments.local.agent heißt seit 0.3.0 claude, siehe docs/upgrading.md');
    assert.equal(broken.next, 'caw-ai validate zeigt alle 2 Befunde.');
    writeFileSync(configPath, saved);
    // Always Docker in CI: then Docker and token count.
    const inCi = await doctorChecks(root, { env: { CI: 'true', CLAUDE_CODE_OAUTH_TOKEN: 'sk-geheim' }, nodeVersion: '22.4.0', probes });
    assert.ok(inCi.some(({ text, optional }) => optional && /Kein Docker gefunden/.test(text)));
    assert.ok(inCi.some(({ ok, text }) => ok && /CLAUDE_CODE_OAUTH_TOKEN ist gesetzt/.test(text)));
    // --agent chooses as for run: docker checks Docker and token, session only the entry in .mcp.json.
    const docker = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes, agent: 'docker' });
    assert.ok(docker.some(({ text }) => /CLAUDE_CODE_OAUTH_TOKEN fehlt/.test(text)));
    assert.ok(!docker.some(({ text }) => /Claude Code 2/.test(text)));
    rmSync(join(root, '.mcp.json'), { force: true });
    const session = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes, agent: 'session' });
    assert.match(session.find(({ text }) => /mcp\.json/.test(text)).next, /caw-ai skill/);
    writeFileSync(join(root, '.mcp.json'), '{ "mcpServers": { "caw-ai": { "command": "npx", "args": ["caw-ai", "mcp"] } } }');
    assert.ok((await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes, agent: 'session' })).find(({ text }) => /mcp\.json/.test(text)).ok);
});

test('init: detects the framework, takes answers, no role without login', async (t) => {
    const { detectFramework } = await import('../src/host/commands.mjs');
    t.mock.method(console, 'log', () => {});
    const project = (pkg) => {
        const root = mkdtempSync(join(tmpdir(), 'caw-detect-'));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        if (pkg !== undefined) writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
        return root;
    };
    assert.equal(detectFramework(project({ dependencies: { react: '19' } })), 'react');
    assert.equal(detectFramework(project({ dependencies: { '@angular/core': '19' } })), 'angular');
    assert.equal(detectFramework(project({ devDependencies: { vue: '3' } })), 'vue');
    assert.equal(detectFramework(project({ dependencies: { ext: '6.5.3' } })), 'extjs');
    assert.equal(detectFramework(project()), 'web');
    // Repo with backend and frontend/ (no framework in the root, e.g. only caw-ai): folder and framework come from there.
    const { detectApp } = await import('../src/host/commands.mjs');
    const polyglot = project({ devDependencies: { 'caw-ai': '0.1.0' } });
    for (const [dir, pkg] of [['frontend', { dependencies: { react: '19' } }], ['node_modules/x', { dependencies: { vue: '3' } }], ['backend', {}]]) {
        mkdirSync(join(polyglot, dir), { recursive: true });
        writeFileSync(join(polyglot, dir, 'package.json'), JSON.stringify(pkg));
    }
    assert.deepEqual(detectApp(polyglot), { framework: 'react', dir: 'frontend' });
    const mono = project();
    mkdirSync(join(mono, 'apps', 'web'), { recursive: true });
    writeFileSync(join(mono, 'apps', 'web', 'package.json'), JSON.stringify({ dependencies: { '@angular/core': '19' } }));
    assert.deepEqual(detectApp(mono), { framework: 'angular', dir: 'apps/web' });
    init(polyglot, { auth: 'none' });
    assert.equal(JSON.parse(readFileSync(join(polyglot, 'caw.config.json'), 'utf8')).apps.web.dir, 'frontend');
    assert.throws(() => starterConfig({ framework: 'svelte' }), /svelte/);
    assert.throws(() => starterConfig({ auth: 'oauth' }), /oauth/);

    const open = project({ dependencies: { vue: '3' } });
    init(open, { url: 'http://shop.localhost:3000', auth: 'none' });
    const config = JSON.parse(readFileSync(join(open, 'caw.config.json'), 'utf8'));
    assert.equal(config.framework, 'vue');
    assert.deepEqual(config.environments, { local: { url: 'http://shop.localhost:3000', claude: true, writable: true } });
    assert.equal(config.auth, undefined);
    assert.equal(validate(open), 0);

    const sso = project();
    init(sso, { auth: 'storageState' });
    assert.equal(JSON.parse(readFileSync(join(sso, 'caw.config.json'), 'utf8')).auth.type, 'storageState');
    assert.equal(validate(sso), 0);
});

test('missing test: the record hint only names flags the config does not determine', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-hint-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    init(root);
    const file = join(root, 'caw.config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const target = Object.keys(config.environments)[0];
    const keep = (map) => Object.fromEntries(Object.entries(map).slice(0, 1));
    writeFileSync(file, JSON.stringify({ ...config, roles: keep(config.roles), apps: keep(config.apps) }));
    await assert.rejects(run(root, ['gibtsnicht', '--target', target]), (error) => error.code === 'test-missing' && error.message.endsWith(`caw-ai record gibtsnicht --target ${target}`));
    const two = { ...config.roles, zweite: Object.values(config.roles)[0] };
    writeFileSync(file, JSON.stringify({ ...config, roles: two, apps: keep(config.apps) }));
    await assert.rejects(run(root, ['gibtsnicht', '--target', target]), (error) => error.message.endsWith(`--role <${Object.keys(two).join('|')}>`));
    await assert.rejects(record(root, ['neu', '--target', target]), (error) => error.code === 'usage' && /fehlt --role\. Aufruf: caw-ai record neu/.test(error.message));
});

test('skill: only skill and MCP entry, no config; updates an old skill', async (t) => {
    const { installSkill } = await import('../src/host/commands.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-skill-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const said = [];
    t.mock.method(console, 'log', (text) => said.push(text));
    assert.equal(installSkill(root), 0);
    const file = join(root, '.claude', 'skills', 'caw-ai', 'SKILL.md');
    assert.match(readFileSync(file, 'utf8'), /### Set up a project/);
    assert.ok(!existsSync(join(root, 'caw.config.json')), 'no config');
    assert.match(said.join('\n'), /Angelegt: .*SKILL\.md, \.mcp\.json\.\n.*Weiter in Claude Code: „Richte caw-ai ein“/);
    writeFileSync(file, 'old');
    said.length = 0;
    installSkill(root);
    assert.match(said[0], /Aktualisiert:.*SKILL\.md\.$/);
    assert.notEqual(readFileSync(file, 'utf8'), 'old');
});

test('record: options for an already described test may match, only contradictions abort', async () => {
    const { contradicts } = await import('../src/host/commands.mjs');
    const spec = { role: 'nutzer', app: 'web', also: [], mutates: false };
    assert.equal(contradicts(spec, { readOnly: true }), false, 'as in the npm script Claude created');
    assert.equal(contradicts(spec, { role: 'nutzer', app: 'web' }), false);
    assert.equal(contradicts(spec, {}), false);
    assert.equal(contradicts(spec, { role: 'admin' }), true);
    assert.equal(contradicts(spec, { app: 'admin' }), true);
    assert.equal(contradicts(spec, { also: ['zweite'] }), true);
    assert.equal(contradicts({ ...spec, mutates: true }, { readOnly: true }), true);
});

test('init: explore is required, asks for address and roles, checks every answer at once', async (t) => {
    const { PassThrough } = await import('node:stream');
    const { initAnswers } = await import('../src/host/commands.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-init-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    // Without a terminal and --url: the template, login stays TODO; --offline likewise, also with an address and without explore.
    assert.deepEqual(await initAnswers(root, [], { interactive: false }), { answers: { offline: true } });
    assert.deepEqual(await initAnswers(root, ['--offline', '--url', 'http://localhost:3000', '--no-mcp'], { interactive: false, runExplore: async () => { throw new Error('no explore'); } }),
        { answers: { offline: true, url: 'http://localhost:3000', mcp: false } });
    const offline = starterConfig({ offline: true });
    assert.equal(offline.auth.passwordSelector, 'TODO');
    assert.equal(offline.auth.submitSelector, undefined);
    await assert.rejects(initAnswers(root, ['--url', 'ftp://x'], { interactive: false }), /http:\/\/ oder https:\/\//);

    const explored = [];
    const runExplore = async (dir, args, options) => {
        explored.push({ args, options });
        mkdirSync(join(dir, 'caw'), { recursive: true });
        writeFileSync(join(dir, 'caw', '.explore.json'), JSON.stringify({ url: args[1], framework: { value: 'react' }, auth: { type: 'form', path: '/', userSelector: '#user', passwordSelector: '#pass' } }));
        return 0;
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk) => { shown += chunk; });
    const asked = initAnswers(root, ['--insecure-tls'], { interactive: true, runExplore, input, output });
    for (const line of ['ftp://x', '', 'Admin', 'admin, sach-bearbeiter']) {
        await new Promise((resolveTick) => { setTimeout(resolveTick, 20); });
        input.write(`${line}\n`);
    }
    const { answers } = await asked;
    assert.deepEqual(explored, [{ args: ['--url', 'http://localhost:5173', '--insecure-tls'], options: { next: false } }]);
    assert.equal(answers.framework, 'react');
    assert.deepEqual(answers.roles, ['admin', 'sach-bearbeiter']);
    assert.match(shown, /http:\/\/ oder https:\/\//);
    assert.match(shown, /„Admin“: nur Kleinbuchstaben/);
    init(root, answers);
    const config = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    assert.equal(config.auth.signedInSelector, 'TODO', 'what explore did not find');
    assert.deepEqual(config.roles['sach-bearbeiter'], { loginEnv: 'CAW_LOGIN_SACH_BEARBEITER', passwordEnv: 'CAW_PW_SACH_BEARBEITER' });
    assert.match(readFileSync(join(root, 'caw', '.env.example'), 'utf8'), /^# Nach caw\/\.env kopieren[^\n]*\n# [^\n]*\nCAW_LOGIN_ADMIN=\nCAW_PW_ADMIN=\nCAW_LOGIN_SACH_BEARBEITER=\nCAW_PW_SACH_BEARBEITER=\n$/);
    assert.ok(existsSync(join(root, '.claude', 'skills', 'caw-ai', 'SKILL.md')));

    // If explore already ran, init takes its result without asking; the role is then neutral.
    const again = await initAnswers(root, [], { interactive: false, runExplore: async () => { throw new Error('no second explore'); } });
    assert.equal(again.answers.roles, undefined);
    assert.deepEqual(Object.keys(starterConfig(again.answers).roles), ['tester']);
    assert.equal(again.answers.mcp, undefined);
    assert.equal((await initAnswers(root, ['--no-mcp'], { interactive: false })).answers.mcp, false);
    // Window closed or explore aborted: init creates nothing.
    assert.deepEqual(await initAnswers(root, ['--url', 'http://localhost:5173'], { interactive: false, runExplore: async () => 2 }), { code: 2 });
    await assert.rejects(initAnswers(root, ['--from', 'fehlt.json'], { interactive: false }), /fehlt\.json ist nicht lesbar/);
});

test('validate: code per test and target, where an overlay is possible, and TODO', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-validate-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify({
        environments: { local: { url: 'http://localhost:5173', claude: true, writable: true }, dev: { url: 'https://dev.example.com', claude: true, overlay: true } },
        auth: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: 'TODO', signedInSelector: '#m' },
        apps: { web: { dir: '.', startUrl: '/', overlay: { build: 'dist' } } },
        roles: { tester: { loginEnv: 'A', passwordEnv: 'B' } },
    }));
    mkdirSync(join(root, 'caw', 'tests'), { recursive: true });
    const steps = 'steps:\n  - id: S1\n    name: A\n    do: ""\n    expect: B\n';
    writeFileSync(join(root, 'caw', 'tests', 'lesen.yaml'), `mutates: false\n${steps}`);
    const chunks = [];
    const write = t.mock.method(process.stdout, 'write', (chunk) => { chunks.push(String(chunk)); return true; });
    try {
        // A login value still TODO: rejected like an invalid config (exit 3), never "valid".
        assert.throws(() => validate(root), (error) => error.code === 'config-invalid' && exitOf(error.code) === 3
            && /auth\.passwordSelector ist noch TODO: trage den CSS-Selektor des Passwortfelds ein/.test(error.message));
    } finally {
        write.mock.restore();
    }
    assert.doesNotMatch(chunks.join(''), /gültig/);
    const config = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    config.auth.passwordSelector = '#p';
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(config));
    chunks.length = 0;
    const write1 = t.mock.method(process.stdout, 'write', (chunk) => { chunks.push(String(chunk)); return true; });
    try {
        assert.equal(validate(root), 0);
    } finally {
        write1.mock.restore();
    }
    const out = chunks.join('');
    assert.match(out, /lesen \(local\): Dev-Server localhost:5173, dein aktueller Stand\n/);
    assert.match(out, /lesen \(dev\): ausgelieferter Stand; mit --overlay: Overlay, Build dist\n/);
    assert.match(out, /und 1 Test\(s\) sind gültig/);
    // Build and dev server on the app: a bare --overlay requires a choice, validate names both.
    config.apps.web.overlay.dev = 'http://localhost:5173';
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(config));
    const again = [];
    const write2 = t.mock.method(process.stdout, 'write', (chunk) => { again.push(String(chunk)); return true; });
    try {
        assert.equal(validate(root), 0);
    } finally {
        write2.mock.restore();
    }
    assert.match(again.join(''), /lesen \(dev\): ausgelieferter Stand; mit --overlay build bzw\. dev: Overlay, Build dist[^|\n]* \| Overlay, Dev-Server http:\/\/localhost:5173/);
});

test('run and record: TODO in the login aborts before Chrome and Claude', async () => {
    const { openRunSession } = await import('../src/host/run.mjs');
    const config = { auth: { type: 'form', path: '/', userSelector: '#u', passwordSelector: '#p', signedInSelector: 'TODO' }, roles: { tester: {} }, apps: {} };
    await assert.rejects(openRunSession({ root: tmpdir(), config, spec: { role: 'tester' }, checked: { target: 'local', url: 'http://localhost:1' } }),
        (error) => error.code === 'config-invalid' && /auth\.signedInSelector steht noch auf TODO/.test(error.message));
});

test('init for ExtJS: an empty overlay entry, no devCommand, no environment with overlay', () => {
    const config = starterConfig({ framework: 'extjs', appDir: 'apps/Bestellung', url: 'https://dev.firma.intern', auth: 'none' });
    assert.deepEqual(config.apps.web.overlay, {});
    assert.ok(Object.values(config.environments).every((environment) => environment.overlay === undefined));
    assert.equal(starterConfig({ framework: 'react' }).apps.web.overlay, undefined);
});

test('doctor: overlay lines for ExtJS (bootstrap.json, watch, last overlay check), all optional', async (t) => {
    const { doctorChecks } = await import('../src/host/doctor.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-doctor-overlay-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const config = {
        framework: 'extjs',
        environments: { dev: { url: 'https://dev.firma.intern', overlay: true } },
        apps: { web: { dir: 'app', startUrl: '/' } },
    };
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(config));
    mkdirSync(join(root, 'app', 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'app.json'), '{ "name": "Bestellung" }');
    writeFileSync(join(root, 'app', 'app', 'Main.js'), '');
    const probes = { chrome: async () => {}, claude: () => '2.1.0', reachable: async () => true, watch: () => false };
    const overlayLines = (checks) => checks.filter(({ text }) => /^dev, App web/.test(text));
    let lines = overlayLines(await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes }));
    assert.ok(lines.every(({ optional }) => optional), JSON.stringify(lines));
    assert.match(lines[0].text, /bootstrap\.json fehlt/);
    assert.match(lines[0].next, /Starte sencha app watch in app; caw startet ihn nicht selbst/);
    assert.equal(lines[1].text, 'dev, App web: Sencha-Watch läuft nicht');
    assert.equal(lines[2].next, 'caw-ai overlay check --target dev');
    writeFileSync(join(root, 'app', 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/Main.js' }] }));
    mkdirSync(join(root, '.caw'));
    const parts = [{ label: 'Bestellung', kind: 'app', names: ['Bestellung.js'], status: 'local' }, { label: 'modell', kind: 'package', names: ['modell.js'], status: 'deployed' }];
    writeFileSync(join(root, '.caw', 'overlay-check.json'), JSON.stringify({ at: new Date(Date.now() - 5 * 60_000).toISOString(), target: 'dev', app: 'web', state: 'incomplete', parts }));
    lines = overlayLines(await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes: { ...probes, watch: () => true } }));
    assert.deepEqual(lines.map(({ ok, text }) => [ok, text]), [
        [true, 'dev, App web: bootstrap.json passt'],
        [true, 'dev, App web: Sencha-Watch läuft'],
        [true, 'dev, App web: Bestellung lokal (geprüft vor 5 min)'],
        [false, 'dev, App web: modell ausgeliefert (geprüft vor 5 min)'],
    ]);
    assert.match(lines[3].next, /--apply/);
});
