import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { maskArgs, parseJsonc, projectImage, renderDockerfile, sandboxRunArgs, toolFingerprint } from '../src/host/sandbox-config.mjs';

const FA = `{
    // comment with "quotes" and https://url
    "name": "fa-workspace",
    "image": "docker.example/app-workspace:1.0.0",
    "mounts": [
        "source=\${localEnv:HOME}/.ssh,target=/home/devuser/.ssh-host,type=bind,readonly",
    ],
    /* Block */
    "appPort": [1841],
}`;

test('parseJsonc handles comments and trailing commas, leaves strings alone', () => {
    const c = parseJsonc(FA);
    assert.equal(c.image, 'docker.example/app-workspace:1.0.0');
    assert.equal(c.mounts.length, 1);
    assert.deepEqual(parseJsonc('{"a":"// none, }"}'), { a: '// none, }' });
});

test('projectImage takes the project image, build is clearly rejected', () => {
    assert.equal(projectImage({ image: 'i:1' }), 'i:1');
    assert.throws(() => projectImage({ build: { dockerfile: 'x' } }), /image/);
});

test('Dockerfile: base image, Claude, tool, firewall, no browser and no secret', () => {
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

test('maskArgs hides Git, Claude configuration, earlier runs and all .env files, test accounts included', (t) => {
    const args = maskArgs(project(t), '/w', 'C:\\empty').join(' ');
    assert.match(args, /--tmpfs \/w\/\.git/);
    assert.match(args, /--tmpfs \/w\/\.claude/);
    assert.match(args, /--tmpfs \/w\/\.caw/);
    assert.match(args, /source=C:\\empty,target=\/w\/\.env,readonly/);
    assert.match(args, /target=\/w\/projects\/a\/\.env,readonly/);
    assert.match(args, /target=\/w\/projects\/a\/\.env\.local,readonly/);
    assert.match(args, /target=\/w\/caw\/\.env,readonly/);
    assert.doesNotMatch(args, /\.env\.example/);
    assert.doesNotMatch(args, /node_modules/);
});

test('maskArgs handles .git as a file (worktree) and missing folders', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-mask-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere');
    const args = maskArgs(root, '/w', 'C:\\empty').join(' ');
    assert.match(args, /source=C:\\empty,target=\/w\/\.git,readonly/);
    assert.doesNotMatch(args, /\.claude/);
});

test('maskArgs follows no symlinks', (t) => {
    const root = project(t);
    symlinkSync(join(root, 'projects'), join(root, 'loop'), 'junction');
    assert.doesNotMatch(maskArgs(root, '/w', 'C:\\empty').join(' '), /loop/);
});

test('sandbox: folder read-only, only the agent folder writable, only Anthropic, token only by name', () => {
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
    assert.match(joined, /-e ANTHROPIC_API_KEY(?!=)/);
    assert.doesNotMatch(joined, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(joined, /--security-opt=no-new-privileges/);
    assert.doesNotMatch(joined, /-p |--publish|docker\.sock|--privileged/);
    assert.deepEqual(args.slice(-3), ['img', 'caw-ai', 'x']);
});

test('toolFingerprint depends on image and content, not on line endings', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-tool-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.js'), 'a\nb\n');
    const first = toolFingerprint(dir, ['src'], 'img:1');
    writeFileSync(join(dir, 'src/a.js'), 'a\r\nb\r\n');
    assert.equal(toolFingerprint(dir, ['src'], 'img:1'), first);
    assert.notEqual(toolFingerprint(dir, ['src'], 'img:2'), first);
    writeFileSync(join(dir, 'src/a.js'), 'changed');
    assert.notEqual(toolFingerprint(dir, ['src'], 'img:1'), first);
});

test('maskArgs hides sessions, Git at any depth, .ENV, keys and build folders', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-mask-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['caw/.auth', 'sub/.git', 'build', 'keys']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['caw/.auth/customer.json', 'build/.env', 'keys/.ENV', 'keys/server.pem', 'keys/id_ed25519', '.npmrc', 'vendor.git.txt']) writeFileSync(join(root, file), 'X=1');
    writeFileSync(join(root, 'sub2.git'), 'x');
    mkdirSync(join(root, 'mod'));
    writeFileSync(join(root, 'mod', '.git'), 'gitdir: ../.git/modules/mod');
    const args = maskArgs(root, '/w', 'C:\\empty').join(' ');
    assert.match(args, /--tmpfs \/w\/caw\/\.auth/);
    assert.match(args, /--tmpfs \/w\/sub\/\.git/);
    assert.match(args, /target=\/w\/mod\/\.git,readonly/);
    for (const file of ['build/\\.env', 'keys/\\.ENV', 'keys/server\\.pem', 'keys/id_ed25519', '\\.npmrc']) assert.match(args, new RegExp(`target=/w/${file},readonly`), file);
    assert.doesNotMatch(args, /vendor\.git\.txt|sub2\.git/);
    assert.doesNotMatch(args, /customer\.json/, 'the folder suffices, the file inside is not masked separately');
});

test('maskArgs hides cloud, SSH and Docker credentials and further secret files', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-mask-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['.aws', 'home/.SSH', '.docker', 'docker', 'certs']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['.aws/credentials', 'home/.SSH/id_ed25519', '.docker/config.json', 'docker/config.json', 'certs/store.jks', 'certs/a.p12',
        'prod.env', '.envrc', '.pypirc', '.yarnrc.yml', 'credentials.json', 'app.js']) writeFileSync(join(root, file), 'X=1');
    const args = maskArgs(root, '/w', 'C:\\empty').join(' ');
    assert.match(args, /--tmpfs \/w\/\.aws( |$)/);
    assert.match(args, /--tmpfs \/w\/home\/\.SSH( |$)/);
    for (const file of ['.docker/config.json', 'certs/store.jks', 'certs/a.p12', 'prod.env', '.envrc', '.pypirc', '.yarnrc.yml', 'credentials.json']) {
        assert.ok(args.includes(`target=/w/${file},readonly`), file);
    }
    assert.ok(!args.includes('/w/docker/config.json') && !args.includes('app.js'), 'only Docker\'s own login folder, no code');
});
