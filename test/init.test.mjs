import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { auth, init, record, run, starterConfig, validate } from '../src/host/commands.mjs';

test('init: besteht validate sofort, legt keinen Beispieltest an, die Zugangsdaten sind ignoriert', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-init-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const said = [];
    t.mock.method(console, 'log', (text) => said.push(text));
    init(root);
    assert.equal(validate(root), 0);
    assert.deepEqual(readdirSync(join(root, 'caw', 'tests')), ['.gitkeep'], 'kein ungefragter Beispieltest, aber der Ordner');
    assert.match(readFileSync(join(root, 'caw', 'caw.md'), 'utf8'), /^# Notizen für Claude\n[\s\S]*\n- Beispiel:/);
    assert.match(said.join('\n'), /den ersten Test aufnehmen: caw-ai record <test> --target local\. Ohne passende Selektoren erst caw-ai explore/);
    // Lief explore eben, rät init nicht, es erst laufen zu lassen.
    const explored = mkdtempSync(join(tmpdir(), 'caw-init-explored-'));
    t.after(() => rmSync(explored, { recursive: true, force: true }));
    said.length = 0;
    init(explored, { explored: true, url: 'http://localhost:5173', login: {} });
    assert.doesNotMatch(said.join('\n'), /explore --url/);
    // Ein vorhandenes caw.md bleibt, wie es ist.
    writeFileSync(join(explored, 'caw', 'caw.md'), 'eigen');
    init(explored);
    assert.equal(readFileSync(join(explored, 'caw', 'caw.md'), 'utf8'), 'eigen');
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('.caw/') && ignore.includes('caw/.env') && ignore.includes('caw/.auth/'));
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers['caw-ai'], { command: 'node', args: ['node_modules/caw-ai/bin/caw-ai.mjs', 'mcp'] });
});

test('init: ergänzt eine vorhandene .mcp.json, lässt sie sonst stehen, ohne mcp gar nicht', (t) => {
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

test('readCredentials: Umgebung vor caw/.env, Sitzung je Ziel', async (t) => {
    const { readCredentials } = await import('../src/host/run.mjs');
    const { sessionPath } = await import('../src/shared/config.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-cred-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const form = { auth: { type: 'form' }, roles: { kunde: { loginEnv: 'CAW_LOGIN_KUNDE', passwordEnv: 'CAW_PW_KUNDE' } } };
    assert.throws(() => readCredentials(root, form, 'kunde', 'local', {}), /CAW_LOGIN_KUNDE, CAW_PW_KUNDE fehlt/);
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
    assert.throws(() => readCredentials(root, stored, 'kunde', 'local', {}), /auf local/, 'Sitzung eines anderen Ziels zählt nicht');
});

test('readCredentials: eine Rolle mit totpEnv liefert ihr TOTP-Geheimnis, fehlt es, wird es genannt', async (t) => {
    const { readCredentials } = await import('../src/host/run.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-cred-totp-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const form = { auth: { type: 'form' }, roles: { admin: { loginEnv: 'CAW_LOGIN_ADMIN', passwordEnv: 'CAW_PW_ADMIN', totpEnv: 'CAW_TOTP_ADMIN' } } };
    const env = { CAW_LOGIN_ADMIN: 'a', CAW_PW_ADMIN: 'p' };
    assert.throws(() => readCredentials(root, form, 'admin', 'local', env), /CAW_TOTP_ADMIN fehlt/);
    assert.deepEqual(readCredentials(root, form, 'admin', 'local', { ...env, CAW_TOTP_ADMIN: 'GEZDGNBV' }), { login: 'a', password: 'p', totpSecret: 'GEZDGNBV' });
});

test('runMode nennt den Modus samt Grund, kein Modus ergibt sich still aus der Umgebung', async () => {
    const { runMode } = await import('../src/host/commands.mjs');
    const base = { withAgent: true, noChat: false, headless: false, inCi: false, withAdvice: false, environments: 'dev' };
    assert.match(runMode(base), /mit Chat\. Fehlende Vergleichswerte lernt/);
    assert.match(runMode({ ...base, withAdvice: true }), /--advise, kostet Token/);
    assert.match(runMode({ ...base, inCi: true }), /Variable CI.*unverändert/);
    assert.match(runMode({ ...base, noChat: true }), /--no-chat/);
    assert.match(runMode({ ...base, headless: true, noChat: true }), /--headless/);
    assert.match(runMode({ ...base, withAgent: false }), /nur auf dev/);
});

test('auth: speichert die Sitzung einer Rolle, nur bei storageState und nie auf Produktion', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-auth-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const write = (auth) => writeFileSync(join(root, 'caw.config.json'), JSON.stringify({
        environments: { local: { url: 'http://app.localhost:5173', agent: true }, live: { url: 'https://www.shop.example', production: true } },
        auth,
        apps: { web: { dir: '.', startUrl: '/' } },
        roles: { kunde: auth.type === 'form' ? { loginEnv: 'L', passwordEnv: 'P' } : {} },
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
    assert.deepEqual(calls[0].hosts, ['app.localhost'], 'Produktion nie in der Host-Sperre eines anderen Ziels');
    assert.equal(await auth(root, ['kunde', '--target', 'local'], { capture: async () => false }), 2, 'Fenster geschlossen: nichts gespeichert');
    await assert.rejects(auth(root, ['kunde', '--target', 'live'], { capture }), /Produktion/);
    await assert.rejects(auth(root, ['gast', '--target', 'local'], { capture }), /Rolle gast/);
    await assert.rejects(auth(root, ['kunde'], { capture }), /Aufruf/);
    write({ type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#menu' });
    await assert.rejects(auth(root, ['kunde', '--target', 'local'], { capture }), /nur mit auth.type storageState/);
    assert.equal(calls.length, 1);
});

test('sandboxBase: Image aus der Config, aus dem Devcontainer, sonst Node', async (t) => {
    const { DEFAULT_SANDBOX_IMAGE, sandboxBase } = await import('../src/host/commands.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-image-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(sandboxBase(root, {}), { image: DEFAULT_SANDBOX_IMAGE, user: 'node' });
    assert.deepEqual(sandboxBase(root, { sandboxImage: 'eigen:1' }), { image: 'eigen:1', user: 'devuser' });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, '.devcontainer'));
    writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{ // Kommentar\n "image": "dev:2" }');
    assert.deepEqual(sandboxBase(root, { sandboxUser: 'ich' }), { image: 'dev:2', user: 'ich' });
});

test('doctor: nennt je Problem den nächsten Schritt, Optionales hält nicht auf, nie Werte', async (t) => {
    const { doctor, doctorChecks } = await import('../src/host/doctor.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-doctor-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const probes = { chrome: async () => {}, claude: () => '2.1.0', docker: async () => { throw new Error('Kein Docker gefunden'); }, reachable: async (url) => url.startsWith('http://') };
    const missing = await doctorChecks(root, { env: {}, probes });
    assert.match(missing.find(({ ok }) => !ok).next, /caw-ai init/);
    init(root);
    writeFileSync(join(root, 'caw', '.env'), 'CAW_LOGIN_TESTER=geheim-login\nCAW_PW_TESTER=geheim-pw\n');
    const lines = [];
    const ui = { success: (text) => lines.push(`ok ${text}`), note: (text) => lines.push(`opt ${text}`), warn: (text) => lines.push(`warn ${text}`) };
    assert.equal(await doctor(root, { ui, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-geheim' }, nodeVersion: '22.4.0', probes }), 0);
    const text = lines.join('\n');
    assert.match(text, /ok OK +Rolle tester: Zugangsdaten gesetzt/);
    assert.match(text, /ok OK +Claude Code 2\.1\.0 \(Claude läuft lokal, ohne Docker\)/);
    assert.doesNotMatch(text, /Docker gefunden|OAUTH_TOKEN/, 'lokal zählen weder Docker noch Token');
    assert.match(text, /ok OK +local: http:\/\/localhost:5173 antwortet/);
    assert.match(text, /opt OPTIONAL +staging: https:\/\/staging.example.com antwortet nicht/);
    assert.match(text, /ok \d+ in Ordnung, 0 fehlen, \d+ optional offen\. Bereit\. Nächster Schritt: den ersten Test aufnehmen/);
    assert.equal(missing.find(({ ok }) => !ok).text, 'caw.config.json fehlt', 'ohne doppelten Punkt');
    assert.doesNotMatch(text, /geheim/);
    lines.length = 0;
    assert.equal(await doctor(root, { ui, env: {}, nodeVersion: '20.1.0', probes }), 2, 'zu altes Node hält auf');
    assert.match(lines.join('\n'), /warn FEHLT +Node 20.1.0 ist zu alt/);
    assert.match(lines.join('\n'), /warn .*1 fehlt.*Erst die mit FEHLT beheben/);
    writeFileSync(join(root, '.gitignore'), '# Laeufe\n/.caw\n**/caw/.auth/\n.env\n');
    const loose = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes });
    assert.ok(loose.find(({ text }) => text.startsWith('.gitignore')).ok, 'gitignore locker verglichen');
    const withoutClaude = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes: { ...probes, claude: () => undefined } });
    assert.match(withoutClaude.find(({ text }) => /claude/.test(text)).next, /agent\.sandbox "docker"/);
    // Ein Selektor, den explore nicht fand, steht auf TODO: doctor haelt auf, bis er eingetragen ist.
    const configPath = join(root, 'caw.config.json');
    const saved = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, saved.replace(/"signedInSelector": "[^"]*"/, '"signedInSelector": "TODO"'));
    const todo = (await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes })).find(({ text }) => /TODO/.test(text));
    assert.ok(todo && !todo.ok && !todo.optional && /auth\.signedInSelector/.test(todo.text), JSON.stringify(todo));
    writeFileSync(configPath, saved);
    // In CI immer Docker: Dann zaehlen Docker und Token.
    const inCi = await doctorChecks(root, { env: { CI: 'true', CLAUDE_CODE_OAUTH_TOKEN: 'sk-geheim' }, nodeVersion: '22.4.0', probes });
    assert.ok(inCi.some(({ text, optional }) => optional && /Kein Docker gefunden/.test(text)));
    assert.ok(inCi.some(({ ok, text }) => ok && /CLAUDE_CODE_OAUTH_TOKEN ist gesetzt/.test(text)));
    // --agent waehlt wie bei run: docker prueft Docker und Token, session nur den Eintrag in .mcp.json.
    const docker = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes, agent: 'docker' });
    assert.ok(docker.some(({ text }) => /CLAUDE_CODE_OAUTH_TOKEN fehlt/.test(text)));
    assert.ok(!docker.some(({ text }) => /Claude Code 2/.test(text)));
    rmSync(join(root, '.mcp.json'), { force: true });
    const session = await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes, agent: 'session' });
    assert.match(session.find(({ text }) => /mcp\.json/.test(text)).next, /caw-ai skill/);
    writeFileSync(join(root, '.mcp.json'), '{ "mcpServers": { "caw-ai": { "command": "npx", "args": ["caw-ai", "mcp"] } } }');
    assert.ok((await doctorChecks(root, { env: {}, nodeVersion: '22.4.0', probes, agent: 'session' })).find(({ text }) => /mcp\.json/.test(text)).ok);
});

test('init: erkennt das Framework, nimmt Antworten an, ohne Anmeldung keine Rolle', async (t) => {
    const { detectFramework, starterConfig } = await import('../src/host/commands.mjs');
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
    // Repo mit Backend und frontend/ (ohne Framework im Wurzelordner, etwa nur caw-ai): Ordner und Framework kommen von dort.
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

test('Fehlender Test: Der Hinweis zum Aufnehmen nennt nur Flags, die die Config nicht eindeutig vorgibt', async (t) => {
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

test('skill: nur Skill und MCP-Eintrag, ohne Config; bringt einen alten Skill auf den Stand', async (t) => {
    const { installSkill } = await import('../src/host/commands.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-skill-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const said = [];
    t.mock.method(console, 'log', (text) => said.push(text));
    assert.equal(installSkill(root), 0);
    const file = join(root, '.claude', 'skills', 'caw-ai', 'SKILL.md');
    assert.match(readFileSync(file, 'utf8'), /### Projekt einrichten/);
    assert.ok(!existsSync(join(root, 'caw.config.json')), 'keine Config');
    assert.match(said.join('\n'), /Angelegt: .*SKILL\.md, \.mcp\.json\.\nWeiter in Claude Code: „Richte caw-ai ein“/);
    writeFileSync(file, 'alt');
    said.length = 0;
    installSkill(root);
    assert.match(said[0], /^Aktualisiert: .*SKILL\.md\.$/);
    assert.notEqual(readFileSync(file, 'utf8'), 'alt');
});

test('record: Angaben zu einem schon beschriebenen Test dürfen passen, nur Widersprüche brechen ab', async () => {
    const { contradicts } = await import('../src/host/commands.mjs');
    const spec = { role: 'nutzer', app: 'web', also: [], mutates: false };
    assert.equal(contradicts(spec, { readOnly: true }), false, 'wie im npm-Skript, das Claude anlegte');
    assert.equal(contradicts(spec, { role: 'nutzer', app: 'web' }), false);
    assert.equal(contradicts(spec, {}), false);
    assert.equal(contradicts(spec, { role: 'admin' }), true);
    assert.equal(contradicts(spec, { app: 'admin' }), true);
    assert.equal(contradicts(spec, { also: ['zweite'] }), true);
    assert.equal(contradicts({ ...spec, mutates: true }, { readOnly: true }), true);
});

test('init: explore ist Pflicht, fragt nach Adresse und Rollen, prüft jede Antwort sofort', async (t) => {
    const { PassThrough } = await import('node:stream');
    const { initAnswers } = await import('../src/host/commands.mjs');
    const root = mkdtempSync(join(tmpdir(), 'caw-init-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    // Ohne Terminal und ohne --url: die Vorlage, die Anmeldung bleibt TODO; --offline ebenso, auch mit Adresse und ohne explore.
    assert.deepEqual(await initAnswers(root, [], { interactive: false }), { answers: { offline: true } });
    assert.deepEqual(await initAnswers(root, ['--offline', '--url', 'http://localhost:3000', '--no-mcp'], { interactive: false, runExplore: async () => { throw new Error('kein explore'); } }),
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
        await new Promise((ok) => { setTimeout(ok, 20); });
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
    assert.equal(config.auth.signedInSelector, 'TODO', 'was explore nicht fand');
    assert.deepEqual(config.roles['sach-bearbeiter'], { loginEnv: 'CAW_LOGIN_SACH_BEARBEITER', passwordEnv: 'CAW_PW_SACH_BEARBEITER' });
    assert.match(readFileSync(join(root, 'caw', '.env.example'), 'utf8'), /^# Nach caw\/\.env kopieren[^\n]*\n# [^\n]*\nCAW_LOGIN_ADMIN=\nCAW_PW_ADMIN=\nCAW_LOGIN_SACH_BEARBEITER=\nCAW_PW_SACH_BEARBEITER=\n$/);
    assert.ok(existsSync(join(root, '.claude', 'skills', 'caw-ai', 'SKILL.md')));

    // Lief explore schon, nimmt init das Ergebnis ohne Fragen; die Rolle ist dann neutral.
    const again = await initAnswers(root, [], { interactive: false, runExplore: async () => { throw new Error('kein zweites explore'); } });
    assert.equal(again.answers.roles, undefined);
    assert.deepEqual(Object.keys(starterConfig(again.answers).roles), ['tester']);
    assert.equal(again.answers.mcp, undefined);
    assert.equal((await initAnswers(root, ['--no-mcp'], { interactive: false })).answers.mcp, false);
    // Fenster geschlossen oder Abbruch in explore: init legt nichts an.
    assert.deepEqual(await initAnswers(root, ['--url', 'http://localhost:5173'], { interactive: false, runExplore: async () => 2 }), { code: 2 });
    await assert.rejects(initAnswers(root, ['--from', 'fehlt.json'], { interactive: false }), /fehlt\.json ist nicht lesbar/);
});

test('validate: je Test und Ziel der Code, wo das Overlay ginge, TODO und alte Namen', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-validate-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify({
        environments: { local: { url: 'http://localhost:5173', agent: true, writable: true }, dev: { url: 'https://dev.example.com', claude: true, overlay: true } },
        auth: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: 'TODO', signedInSelector: '#m' },
        apps: { web: { dir: '.', startUrl: '/', localBuild: 'dist' } },
        roles: { tester: { loginEnv: 'A', passwordEnv: 'B' } },
    }));
    mkdirSync(join(root, 'caw', 'tests'), { recursive: true });
    const steps = 'steps:\n  - id: S1\n    name: A\n    do: ""\n    expect: B\n';
    writeFileSync(join(root, 'caw', 'tests', 'lesen.yaml'), `mutates: false\n${steps}`);
    const chunks = [];
    const write = t.mock.method(process.stdout, 'write', (chunk) => { chunks.push(String(chunk)); return true; });
    try {
        assert.equal(validate(root), 0);
    } finally {
        write.mock.restore();
    }
    const out = chunks.join('');
    assert.match(out, /lesen \(local\): Dev-Server localhost:5173, dein aktueller Stand\n/);
    assert.match(out, /lesen \(dev\): ausgelieferter Stand; mit --overlay: Overlay, lokaler Build aus dist\n/);
    assert.match(out, /auth\.passwordSelector ist noch TODO: trage den CSS-Selektor des Passwortfelds ein/);
    assert.match(out, /Umgebung local: agent heißt jetzt claude/);
    assert.match(out, /und 1 Test\(s\) sind gültig/);
});

test('run und record: TODO in der Anmeldung bricht vor Chrome und Claude ab', async () => {
    const { openRunSession } = await import('../src/host/run.mjs');
    const config = { auth: { type: 'form', path: '/', userSelector: '#u', passwordSelector: '#p', signedInSelector: 'TODO' }, roles: { tester: {} }, apps: {} };
    await assert.rejects(openRunSession({ root: tmpdir(), config, spec: { role: 'tester' }, checked: { target: 'local', url: 'http://localhost:1' } }),
        (error) => error.code === 'config-invalid' && /auth\.signedInSelector steht noch auf TODO/.test(error.message));
});
