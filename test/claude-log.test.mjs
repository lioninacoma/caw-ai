import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeFailureReason } from '../src/host/linux.mjs';
import { colorEnabled, painter } from '../src/shared/color.mjs';
import { colorLine, formatClaudeLine, stampLine } from '../src/sandbox/claude-log.mjs';

const event = (value) => JSON.stringify(value);
const assistant = (...content) => event({ type: 'assistant', message: { content } });

test('formatClaudeLine shows text and commands but no tool results or internals', () => {
    assert.deepEqual(formatClaudeLine(assistant({ type: 'text', text: ' Checking E1. ' })), ['Checking E1.']);
    assert.deepEqual(formatClaudeLine(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'caw-ai\n  snapshot' } })), ['> Bash: caw-ai ⏎ snapshot']);
    assert.deepEqual(formatClaudeLine(assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/a' } })), ['> Read: {"file_path":"/a"}']);
    assert.deepEqual(formatClaudeLine(assistant({ type: 'thinking', thinking: 'secret' })), []);
    assert.deepEqual(formatClaudeLine(event({ type: 'user', message: { content: [{ type: 'tool_result', content: 'page' }] } })), []);
    assert.deepEqual(formatClaudeLine(event({ type: 'system', subtype: 'init', tools: [] })), []);
});

test('formatClaudeLine shortens long inputs', () => {
    const [line] = formatClaudeLine(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(2000) } }));
    assert.ok(line.length < 600);
    assert.ok(line.endsWith(' ...'));
});

test('formatClaudeLine passes non-JSON through and drops empty lines', () => {
    assert.deepEqual(formatClaudeLine('start error: no module'), ['start error: no module']);
    assert.deepEqual(formatClaudeLine('   '), []);
    assert.deepEqual(formatClaudeLine(event({ type: 'new' })), []);
});

test('formatClaudeLine reports completion, errors and retries', () => {
    assert.deepEqual(formatClaudeLine(event({ duration_ms: 12400, is_error: false, result: 'summary', type: 'result' })), ['Claude finished after 12 s.']);
    assert.match(formatClaudeLine(event({ duration_ms: 1000, is_error: true, result: 'Failed to authenticate', type: 'result' }))[0], /with an error: Failed to authenticate/);
    assert.match(formatClaudeLine(event({ type: 'system', subtype: 'api_retry', attempt: 2, error_status: 401, error: 'authentication_failed' }))[0], /401.*attempt 2/);
});

test('formatClaudeLine appends turns, tokens and cost to the completion line, only what is present', () => {
    const usage = { input_tokens: 1200, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4300, output_tokens: 6400 };
    assert.deepEqual(formatClaudeLine(event({ type: 'result', duration_ms: 42_000, num_turns: 12, usage, total_cost_usd: 0.3125 })),
        ['Claude finished after 42 s · 12 turns · 86k tokens in / 6k out · $0.31.']);
    assert.deepEqual(formatClaudeLine(event({ type: 'result', duration_ms: 1000, num_turns: 1, total_cost_usd: 0 })), ['Claude finished after 1 s · 1 turn · $0.00.']);
    assert.deepEqual(formatClaudeLine(event({ type: 'result', duration_ms: 1000, usage: { output_tokens: 850 } })), ['Claude finished after 1 s · 850 tokens out.']);
    assert.deepEqual(formatClaudeLine(event({ type: 'result', duration_ms: 1000, usage: { input_tokens: 1_250_000, output_tokens: 'x' }, total_cost_usd: null })),
        ['Claude finished after 1 s · 1.3M tokens in.']);
    assert.deepEqual(formatClaudeLine(event({ type: 'result', duration_ms: 1000, is_error: true, result: 'boom', num_turns: 3, total_cost_usd: 0.05 })),
        ['Claude finished after 1 s · 3 turns · $0.05 with an error: boom']);
});

test('a login error in the log is still recognised as a token problem on the host', () => {
    const lines = formatClaudeLine(event({ type: 'result', is_error: true, duration_ms: 1, result: 'Failed to authenticate. API Error: 401 Invalid bearer token' }));
    assert.match(claudeFailureReason(1, lines.join('\n')), /ANTHROPIC_API_KEY/);
});

test('stampLine prefixes the seconds since start', () => {
    assert.equal(stampLine('x', 1000, 13400), '[+12.4s] x\n');
});

test('stampLine strips control characters so page text cannot control the terminal', () => {
    assert.equal(stampLine('a\u001b[2Jb\u0007\r\nc\td', 0, 0), '[+0.0s] a[2Jb\nc\td\n');
});

test('colorLine colours by line kind and leaves Claude\'s text unchanged', () => {
    const paint = painter(true);
    assert.equal(colorLine('[+1.0s] > Bash: x\n', paint), `${paint.dim('[+1.0s]')} ${paint.cyan('> Bash: x')}\n`);
    assert.equal(colorLine('[+1.0s] API error 401\n', paint), `${paint.dim('[+1.0s]')} ${paint.yellow('API error 401')}\n`);
    assert.equal(colorLine('[+1.0s] Claude finished after 1 s with an error: x\n', paint), `${paint.dim('[+1.0s]')} ${paint.red('Claude finished after 1 s with an error: x')}\n`);
    assert.equal(colorLine('[+1.0s] Checking\nE1\n', paint), `${paint.dim('[+1.0s]')} Checking\nE1\n`);
});

test('without colour the terminal line equals the log line', () => {
    const paint = painter(false);
    for (const line of ['[+1.0s] > Bash: x\n', '[+1.0s] Text\nmore\n', '[+1.0s] Claude finished after 1 s.\n']) assert.equal(colorLine(line, paint), line);
});

test('colorEnabled: NO_COLOR wins, FORCE_COLOR forces, otherwise the terminal decides', () => {
    assert.equal(colorEnabled({ env: {}, isTTY: true }), true);
    assert.equal(colorEnabled({ env: {}, isTTY: false }), false);
    assert.equal(colorEnabled({ env: {}, isTTY: undefined }), false);
    assert.equal(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false }), true);
    assert.equal(colorEnabled({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true }), false);
});
