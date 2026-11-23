import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { pollChannel, sendCommand } from '../src/shared/channel.mjs';

const channel = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-channel-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const serveUntil = async (dir, handler, promise) => {
    let running = true;
    const loop = (async () => {
        while (running) {
            await pollChannel(dir, handler);
            await new Promise((resolveTick) => { setTimeout(resolveTick, 5); });
        }
    })();
    try {
        return await promise;
    } finally {
        running = false;
        await loop;
    }
};

test('command and answer pass through the channel and leave nothing behind', async (t) => {
    const dir = channel(t);
    const value = await serveUntil(dir, (command) => `echo ${command.action}`, sendCommand(dir, { action: 'x' }));
    assert.equal(value, 'echo x');
    assert.deepEqual(readdirSync(dir), []);
});

test('finish: the host takes the verdict before its answer reaches the agent; "Verdict accepted" is printed only for an accepted one, which then exits 0', async (t) => {
    const { finish } = await import('../src/sandbox/commands.mjs');
    const { EXIT } = await import('../src/shared/errors.mjs');
    const dir = channel(t);
    const agentDir = mkdtempSync(join(tmpdir(), 'caw-agent-'));
    t.after(() => rmSync(agentDir, { recursive: true, force: true }));
    const before = { sandbox: process.env.CAW_SANDBOX, dir: process.env.CAW_AGENT_DIR };
    process.env.CAW_SANDBOX = '1';
    process.env.CAW_AGENT_DIR = agentDir;
    t.after(() => { for (const [key, value] of [['CAW_SANDBOX', before.sandbox], ['CAW_AGENT_DIR', before.dir]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    const printed = [];
    t.mock.method(console, 'log', (line) => { printed.push(line); });
    const results = join(dir, 'e.json');
    writeFileSync(results, '{"expectations":[]}');
    const channelDir = join(agentDir, '.channel');
    mkdirSync(channelDir);
    // When the host accepts the verdict (run.mjs then removes the agent's container), the agent has no answer yet: whatever
    // its script does after `caw agent finish` may never run.
    let answeredAtVerdict;
    const accept = () => { answeredAtVerdict = readdirSync(channelDir).some((name) => name.startsWith('res-')); return { status: 'fail' }; };
    assert.equal(await serveUntil(channelDir, accept, finish(results)), EXIT.pass);
    assert.equal(answeredAtVerdict, false);
    assert.deepEqual(printed, ['Verdict accepted: fail']);
    // Rejected: no such line.
    const reject = () => { throw Object.assign(new Error('incomplete'), { code: 'finish-rejected' }); };
    await assert.rejects(serveUntil(channelDir, reject, finish(results)), /incomplete/);
    assert.deepEqual(printed, ['Verdict accepted: fail']);
});

test('host errors reach the client with their code', async (t) => {
    const dir = channel(t);
    const failing = () => { throw Object.assign(new Error('no'), { code: 'host-blocked' }); };
    await serveUntil(dir, failing, assert.rejects(sendCommand(dir, { action: 'x' }), { code: 'host-blocked', message: 'no' }));
});

test('broken JSON: the answer does not quote the file content', async (t) => {
    const dir = channel(t);
    writeFileSync(join(dir, 'cmd-a.json'), 'SECRET CONTENT');
    await pollChannel(dir, () => assert.fail('must not run'));
    const answer = readFileSync(join(dir, 'res-a.json'), 'utf8');
    assert.match(answer, /command-invalid/);
    assert.doesNotMatch(answer, /SECRET/);
});

test('a symlink as command is not read', { skip: process.platform === 'win32' && 'needs symlink rights on Windows' }, async (t) => {
    const dir = channel(t);
    const secret = join(dir, '..', `secret-${Date.now()}.json`);
    writeFileSync(secret, '{"action":"x"}');
    t.after(() => rmSync(secret, { force: true }));
    symlinkSync(secret, join(dir, 'cmd-a.json'));
    await pollChannel(dir, () => assert.fail('must not run'));
    assert.match(readFileSync(join(dir, 'res-a.json'), 'utf8'), /command-invalid/);
});

test('an entry that cannot be deleted does not break the host and is handled only once', async (t) => {
    const dir = channel(t);
    mkdirSync(join(dir, 'cmd-a.json'));
    const ignored = new Set();
    await pollChannel(dir, () => assert.fail('must not run'), ignored);
    assert.ok(ignored.has('cmd-a.json'));
    await pollChannel(dir, () => assert.fail('must not run'), ignored);
    const value = await serveUntil(dir, () => 'continue', sendCommand(dir, { action: 'x' }));
    assert.equal(value, 'continue');
});

test('non-matching file names are ignored, no path out of the folder', async (t) => {
    const dir = channel(t);
    writeFileSync(join(dir, 'cmd-..%2Fx.json'), '{}');
    writeFileSync(join(dir, 'other.json'), '{}');
    await pollChannel(dir, () => assert.fail('must not run'));
    assert.ok(existsSync(join(dir, 'other.json')));
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('res-')).length, 0);
});
