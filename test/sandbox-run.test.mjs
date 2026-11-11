import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeArgs, claudeEnv } from '../src/sandbox/commands.mjs';

test('Sandbox: Claude may wait for the human as long as the run lasts, without background tasks', () => {
    const env = claudeEnv(30, { PATH: '/bin', BASH_DEFAULT_TIMEOUT_MS: '1' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, String(30 * 60 * 1000));
    assert.equal(env.BASH_MAX_TIMEOUT_MS, String(30 * 60 * 1000));
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    const args = claudeArgs('/caw-ai x');
    assert.deepEqual(args.slice(0, 2), ['-p', '/caw-ai x']);
    assert.match(args[args.indexOf('--disallowedTools') + 1], /\bMonitor\b/);
});
