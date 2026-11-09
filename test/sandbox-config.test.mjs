import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { maskArgs, parseJsonc, projectImage, renderDockerfile, sandboxRunArgs, toolFingerprint } from '../src/host/sandbox-config.mjs';

const FA = `{
    // Kommentar mit "Anfuehrung" und https://url
    "name": "fa-workspace",
    "image": "docker.example/app-workspace:1.0.0",
    "mounts": [
        "source=\${localEnv:HOME}/.ssh,target=/home/devuser/.ssh-host,type=bind,readonly",
    ],
    /* Block */
    "appPort": [1841],
}`;

test('parseJsonc versteht Kommentare und nachgestellte Kommata, schont Strings', () => {
    const c = parseJsonc(FA);
    assert.equal(c.image, 'docker.example/app-workspace:1.0.0');
    assert.equal(c.mounts.length, 1);
    assert.deepEqual(parseJsonc('{"a":"// kein, }"}'), { a: '// kein, }' });
});

test('projectImage nimmt das Image des Projekts, build wird klar abgewiesen', () => {
    assert.equal(projectImage({ image: 'i:1' }), 'i:1');
    assert.throws(() => projectImage({ build: { dockerfile: 'x' } }), /image/);
});

test('Dockerfile: Basisimage, Claude, Tool, Firewall, kein Browser und kein Geheimnis', () => {
    const df = renderDockerfile({ image: 'img:1', user: 'devuser' });
    assert.match(df, /^FROM img:1$/m);
    assert.doesNotMatch(df, /playwright|chromium/i);
    assert.match(df, /claude-code/);
    assert.match(df, /ENTRYPOINT/);
    assert.doesNotMatch(df, /\{\{/);
    assert.doesNotMatch(df, /OAUTH_TOKEN/);
});

const project = (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-mask-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['.git', '.claude', 'caw', 'projects/a', 'node_modules/x', '.caw/runs']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['caw/.env', 'projects/a/.env', 'projects/a/.env.local', 'projects/a/.env.example', 'node_modules/x/.env', '.env']) writeFileSync(join(root, file), 'X=1');
    return root;
};

test('maskArgs blendet Git, Claude-Konfiguration, frühere Läufe und alle .env aus, auch die Testkonten', (t) => {
    const args = maskArgs(project(t), '/w', 'C:\\leer').join(' ');
    assert.match(args, /--tmpfs \/w\/\.git/);
    assert.match(args, /--tmpfs \/w\/\.claude/);
    assert.match(args, /--tmpfs \/w\/\.caw/);
    assert.match(args, /source=C:\\leer,target=\/w\/\.env,readonly/);
    assert.match(args, /target=\/w\/projects\/a\/\.env,readonly/);
    assert.match(args, /target=\/w\/projects\/a\/\.env\.local,readonly/);
    assert.match(args, /target=\/w\/caw\/\.env,readonly/);
    assert.doesNotMatch(args, /\.env\.example/);
    assert.doesNotMatch(args, /node_modules/);
});

test('maskArgs behandelt .git als Datei (Worktree) und fehlende Ordner', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-mask-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, '.git'), 'gitdir: /anderswo');
    const args = maskArgs(root, '/w', 'C:\\leer').join(' ');
    assert.match(args, /source=C:\\leer,target=\/w\/\.git,readonly/);
    assert.doesNotMatch(args, /\.claude/);
});

test('maskArgs folgt keinen Symlinks', (t) => {
    const root = project(t);
    symlinkSync(join(root, 'projects'), join(root, 'schleife'), 'junction');
    assert.doesNotMatch(maskArgs(root, '/w', 'C:\\leer').join(' '), /schleife/);
});

test('Sandbox: Ordner read-only, nur der Agent-Ordner beschreibbar, nur Anthropic, Token nur als Name', () => {
    const agentPath = '/w/p/.caw/runs/r1/agent';
    const args = sandboxRunArgs({ hostRoot: 'C:\\p', containerRoot: '/w/p', image: 'img', masks: ['--tmpfs', '/w/p/.git'], name: 'n1', hostAgentDir: 'C:\\p\\agent', containerAgentDir: agentPath, command: ['caw-ai', 'x'] });
    const joined = args.join(' ');
    assert.ok(args.includes('type=bind,source=C:\\p,target=/w/p,readonly'));
    assert.ok(args.includes(`type=bind,source=C:\\p\\agent,target=${agentPath}`));
    assert.ok(args.includes('--rm'));
    assert.match(joined, /--name n1/);
    assert.match(joined, /--workdir \/w\/p/);
    assert.ok(args.includes('CAW_ALLOWED_HOSTS=api.anthropic.com'));
    assert.ok(args.includes(`CAW_AGENT_DIR=${agentPath}`));
    assert.match(joined, /-e CLAUDE_CODE_OAUTH_TOKEN(?!=)/);
    assert.match(joined, /--security-opt=no-new-privileges/);
    assert.doesNotMatch(joined, /-p |--publish|docker\.sock|--privileged/);
    assert.deepEqual(args.slice(-3), ['img', 'caw-ai', 'x']);
});

test('toolFingerprint hängt von Image und Inhalt ab, nicht von Zeilenenden', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-tool-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.js'), 'a\nb\n');
    const first = toolFingerprint(dir, ['src'], 'img:1');
    writeFileSync(join(dir, 'src/a.js'), 'a\r\nb\r\n');
    assert.equal(toolFingerprint(dir, ['src'], 'img:1'), first);
    assert.notEqual(toolFingerprint(dir, ['src'], 'img:2'), first);
    writeFileSync(join(dir, 'src/a.js'), 'anders');
    assert.notEqual(toolFingerprint(dir, ['src'], 'img:1'), first);
});

test('maskArgs verdeckt Sitzungen, Git in jeder Tiefe, .ENV, Schlüssel und build-Ordner', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-mask-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['caw/.auth', 'sub/.git', 'build', 'keys']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['caw/.auth/kunde.json', 'build/.env', 'keys/.ENV', 'keys/server.pem', 'keys/id_ed25519', '.npmrc', 'vendor.git.txt']) writeFileSync(join(root, file), 'X=1');
    writeFileSync(join(root, 'sub2.git'), 'x');
    mkdirSync(join(root, 'mod'));
    writeFileSync(join(root, 'mod', '.git'), 'gitdir: ../.git/modules/mod');
    const args = maskArgs(root, '/w', 'C:\leer').join(' ');
    assert.match(args, /--tmpfs \/w\/caw\/\.auth/);
    assert.match(args, /--tmpfs \/w\/sub\/\.git/);
    assert.match(args, /target=\/w\/mod\/\.git,readonly/);
    for (const file of ['build/\.env', 'keys/\.ENV', 'keys/server\.pem', 'keys/id_ed25519', '\.npmrc']) assert.match(args, new RegExp(`target=/w/${file},readonly`), file);
    assert.doesNotMatch(args, /vendor\.git\.txt|sub2\.git/);
    assert.doesNotMatch(args, /kunde\.json/, 'der Ordner reicht, die Datei darin wird nicht einzeln verdeckt');
});
