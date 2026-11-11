// Claude access and cost limits: the user's own token or API key reaches the container by name only; model and budget
// from the config or the environment become Claude Code options.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { localAgentEnv } from '../src/host/local-agent.mjs';
import { sandboxRunArgs } from '../src/host/sandbox-config.mjs';
import { claudeArgs, limitArgs, localClaudeArgs } from '../src/sandbox/commands.mjs';
import { claudeLimits, validateConfig } from '../src/shared/config.mjs';

const BASE = {
    environments: { local: { url: 'http://localhost:5173', claude: true, writable: true } },
    auth: { type: 'none' },
    apps: { web: { dir: '.', startUrl: '/' } },
};

test('claudeLimits: config agent.model and agent.maxBudgetUsd, the environment wins, invalid values are left out', () => {
    assert.deepEqual(claudeLimits({}, {}), {});
    assert.deepEqual(claudeLimits({ agent: { model: 'haiku', maxBudgetUsd: 0.5 } }, {}), { CAW_CLAUDE_MODEL: 'haiku', CAW_CLAUDE_BUDGET: '0.5' });
    assert.deepEqual(claudeLimits({ agent: { model: 'haiku', maxBudgetUsd: 0.5 } }, { CAW_CLAUDE_MODEL: 'sonnet', CAW_CLAUDE_BUDGET: '2' }), { CAW_CLAUDE_MODEL: 'sonnet', CAW_CLAUDE_BUDGET: '2' });
    assert.deepEqual(claudeLimits({}, { CAW_CLAUDE_MODEL: 'haiku --dangerously', CAW_CLAUDE_BUDGET: '-1' }), {}, 'no options smuggled in, no negative budget');
});

test('limitArgs: Claude Code options for the container and the local agent', () => {
    assert.deepEqual(limitArgs({}), []);
    assert.deepEqual(limitArgs({ CAW_CLAUDE_MODEL: 'haiku', CAW_CLAUDE_BUDGET: '0.5' }), ['--model', 'haiku', '--max-budget-usd', '0.5']);
    assert.deepEqual(claudeArgs('go', { CAW_CLAUDE_MODEL: 'haiku' }).slice(-2), ['--model', 'haiku']);
    const saved = { model: process.env.CAW_CLAUDE_MODEL, budget: process.env.CAW_CLAUDE_BUDGET };
    process.env.CAW_CLAUDE_MODEL = 'haiku';
    process.env.CAW_CLAUDE_BUDGET = '1';
    try {
        assert.deepEqual(localClaudeArgs('go', { mcpConfig: 'm.json', settings: '{}', systemPromptFile: 's.md' }).slice(-4), ['--model', 'haiku', '--max-budget-usd', '1']);
    } finally {
        for (const [key, value] of [['CAW_CLAUDE_MODEL', saved.model], ['CAW_CLAUDE_BUDGET', saved.budget]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('Docker: only the API key, by name only; no subscription token; the limits with their values', () => {
    const args = sandboxRunArgs({ hostRoot: '/p', containerRoot: '/w', image: 'img', masks: [], name: 'n', hostAgentDir: '/a', containerAgentDir: '/w/a', command: ['x'], limits: { CAW_CLAUDE_MODEL: 'haiku' } });
    const passed = args.flatMap((arg, index) => (arg === '-e' ? [args[index + 1]] : []));
    assert.ok(passed.includes('ANTHROPIC_API_KEY'));
    assert.ok(!passed.some((entry) => entry.startsWith('CLAUDE_CODE_OAUTH_TOKEN')), 'subscription logins stay outside the container');
    assert.ok(passed.includes('CAW_CLAUDE_MODEL=haiku'));
    assert.ok(!passed.some((entry) => /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/.test(entry)), 'never the value');
});

test('local agent: the limits reach the agent process environment', () => {
    const env = localAgentEnv('C:/tmp/agent', { env: { PATH: '' }, limits: { CAW_CLAUDE_BUDGET: '0.5' } });
    assert.equal(env.CAW_CLAUDE_BUDGET, '0.5');
});

test('config: agent.model and agent.maxBudgetUsd are checked up front', () => {
    const issues = (config) => validateConfig(config).issues;
    assert.deepEqual(issues({ ...BASE, agent: { sandbox: 'local', model: 'haiku', maxBudgetUsd: 0.25 } }), []);
    assert.match(issues({ ...BASE, agent: { model: 'haiku sonnet' } }).join('\n'), /agent\.model/);
    assert.match(issues({ ...BASE, agent: { maxBudgetUsd: 0 } }).join('\n'), /agent\.maxBudgetUsd/);
    assert.match(issues({ ...BASE, agent: { budget: 1 } }).join('\n'), /maxBudgetUsd/);
});

test('test files: an unquoted " #" in a step text is an error with line and fix, a quoted one is fine', async () => {
    const { parseTest } = await import('../src/host/test-file.mjs');
    const plan = (expect) => `mutates: true\nsteps:\n  - id: S1\n    name: Add\n    do: Add the todo with the tag "#home".\n    expect: ${expect}\n`;
    assert.throws(() => parseTest(plan('A toast "Added #12" shows.')), /Zeile 6: expect enthält " #" ohne Anführungszeichen/);
    assert.equal(parseTest(plan('\'A toast "Added #12" shows.\'')).steps[0].expect, 'A toast "Added #12" shows.');
});
