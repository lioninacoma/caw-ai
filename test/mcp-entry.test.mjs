import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MCP_ENTRY, mcpEntry } from '../src/host/commands.mjs';

test('mcpEntry: points to the hoisted install of a monorepo, relative to the project folder', (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'caw-mcp-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const app = join(repo, 'projects', 'apps', 'web');
    mkdirSync(app, { recursive: true });
    assert.deepEqual(mcpEntry(app), MCP_ENTRY);
    mkdirSync(join(repo, 'node_modules', 'caw-ai', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'caw-ai', 'bin', 'caw-ai.mjs'), '');
    assert.deepEqual(mcpEntry(app), { command: 'node', args: ['../../../node_modules/caw-ai/bin/caw-ai.mjs', 'mcp'] });
    assert.deepEqual(mcpEntry(repo), MCP_ENTRY);
});
