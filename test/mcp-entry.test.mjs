import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureMcpEntry, isNpxEntry, mcpEntry, npxEntry } from '../src/host/mcp-entry.mjs';

const install = (dir) => {
    mkdirSync(join(dir, 'node_modules', 'caw-ai', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'caw-ai', 'bin', 'caw.mjs'), '');
};

test('mcpEntry: the hoisted install of a monorepo, relative to the project folder; without one npx (cmd /c on Windows)', (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'caw-mcp-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const app = join(repo, 'projects', 'apps', 'web');
    mkdirSync(app, { recursive: true });
    assert.deepEqual(mcpEntry(app, 'linux'), { command: 'npx', args: ['caw-ai', 'mcp'] });
    assert.deepEqual(mcpEntry(app, 'win32'), { command: 'cmd', args: ['/c', 'npx', 'caw-ai', 'mcp'] });
    install(repo);
    assert.deepEqual(mcpEntry(app), { command: 'node', args: ['../../../node_modules/caw-ai/bin/caw.mjs', 'mcp'] });
    assert.deepEqual(mcpEntry(repo), { command: 'node', args: ['node_modules/caw-ai/bin/caw.mjs', 'mcp'] });
});

test('isNpxEntry: what claude mcp add writes, on every system; node entries and other servers are not', () => {
    assert.ok(isNpxEntry(npxEntry('linux')));
    assert.ok(isNpxEntry(npxEntry('win32')));
    assert.ok(isNpxEntry({ command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['caw-ai', 'mcp'] }));
    assert.ok(!isNpxEntry({ command: 'node', args: ['node_modules/caw-ai/bin/caw.mjs', 'mcp'] }));
    assert.ok(!isNpxEntry({ command: 'npx', args: ['other-server'] }));
});

test('ensureMcpEntry: adds caw next to other servers; an npx entry moves to the installed copy (env kept); a node entry stays', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-mcp-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const read = () => JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers;
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    assert.equal(ensureMcpEntry(root, 'linux'), 'created');
    assert.deepEqual(read(), { other: { command: 'x' }, caw: { command: 'npx', args: ['caw-ai', 'mcp'] } });
    assert.equal(ensureMcpEntry(root, 'linux'), 'present', 'npx without an installed copy stays');
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { caw: { type: 'stdio', command: 'cmd', args: ['/c', 'npx', 'caw-ai', 'mcp'], env: { A: '1' } } } }));
    install(root);
    assert.equal(ensureMcpEntry(root, 'win32'), 'updated');
    assert.deepEqual(read().caw, { type: 'stdio', command: 'node', args: ['node_modules/caw-ai/bin/caw.mjs', 'mcp'], env: { A: '1' } });
    assert.equal(ensureMcpEntry(root), 'present');
    writeFileSync(join(root, '.mcp.json'), '{ broken');
    assert.equal(ensureMcpEntry(root), 'invalid');
});
