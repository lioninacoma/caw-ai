// Attach: a session listens under a short key, a run with --attach binds to it, hears when it goes and when it comes back, and
// sends it lines that `caw attach --watch` prints for the session's Monitor.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { KEY_PATTERN, eventsFile, isAttachValue, liveListeners, listenerOf, matchListeners, newKey, registerListener, sendEvent, unregisterListener } from '../src/shared/attach.mjs';
import { createSessionLink } from '../src/host/session-link.mjs';
import { attachCommand } from '../src/host/attach-command.mjs';
import { parseRunArgs } from '../src/host/linux.mjs';
import { parseReproduceArgs } from '../src/host/reproduce.mjs';

const project = (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-attach-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
};
const until = async (check, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return true;
        await new Promise((ok) => { setTimeout(ok, 20); });
    }
    return false;
};

test('attach: keys have a digit, so a short test name is never one; a listener counts only alive and with its token', (t) => {
    const root = project(t);
    const key = newKey(root);
    assert.match(key, KEY_PATTERN);
    assert.equal(isAttachValue('shop'), false, 'a test name');
    assert.equal(isAttachValue('k7f2'), true);
    assert.equal(isAttachValue('3f2a9c1b'), true, 'the start of a session id');
    assert.equal(isAttachValue('smoke'), false);
    registerListener(root, { key, sessionId: '3f2a9c1b-0000-4000-8000-000000000000', agent: 'Claude Code' });
    assert.equal(listenerOf(root, key).agent, 'Claude Code');
    assert.deepEqual(matchListeners(liveListeners(root), '3f2a9c1b').map((entry) => entry.key), [key]);
    assert.deepEqual(matchListeners(liveListeners(root), 'z9z9'), []);
    // Planted next to it: no token kept by caw, or a process that does not exist.
    writeFileSync(join(root, '.caw', 'attach', 'p1a1.json'), JSON.stringify({ key: 'p1a1', pid: process.pid, token: 'guessed' }));
    registerListener(root, { key: 'd1e1', pid: 2 ** 22 + 4321 });
    assert.deepEqual(liveListeners(root).map((entry) => entry.key), [key]);
    unregisterListener(root, key);
    assert.equal(listenerOf(root, key), undefined);
});

test('attach: a run binds to the only listener, waits with several, says lost and binds to the session that comes back', async (t) => {
    const root = project(t);
    const states = [];
    const first = newKey(root);
    registerListener(root, { key: first, agent: 'Claude Code' });
    const second = 'm3q9';
    registerListener(root, { key: second });
    const several = createSessionLink({ root, pollMs: 20, onState: (state, extra) => states.push([state, extra.candidates?.length ?? 0]) });
    t.after(() => several.stop());
    assert.equal(several.key(), null, 'two listen, none named');
    assert.deepEqual(states[0], ['waiting', 2]);
    const named = createSessionLink({ root, want: first, pollMs: 20 });
    t.after(() => named.stop());
    assert.equal(named.key(), first);
    assert.equal(named.agent(), 'Claude Code');
    named.tell('caw: run r1 waits for you (develop).');
    assert.match(String((await import('node:fs')).readFileSync(eventsFile(root, first), 'utf8')), /run r1 waits for you/);
    const seen = [];
    unregisterListener(root, second);
    const only = createSessionLink({ root, pollMs: 20, onState: (state, { key }) => seen.push(`${state}:${key}`) });
    t.after(() => only.stop());
    assert.equal(only.key(), first, 'now the only one');
    unregisterListener(root, first);
    assert.ok(await until(() => only.state() === 'lost'), 'the session went away');
    only.tell('nobody hears this');
    registerListener(root, { key: 'n4w5' });
    assert.ok(await until(() => only.state() === 'back'));
    assert.equal(only.key(), 'n4w5');
    assert.equal(await only.connected(), 'n4w5');
    assert.deepEqual(seen, [`connected:${first}`, `lost:${first}`, 'back:n4w5']);
});

test('attach: caw attach --watch prints each line once, from the end, and ends when the listener is gone', async (t) => {
    const root = project(t);
    const key = newKey(root);
    registerListener(root, { key });
    sendEvent(root, key, 'old line, sent before the watch');
    const lines = [];
    let alive = true;
    const watching = attachCommand(root, ['--watch', key], { out: (line) => lines.push(line), pollMs: 20, alive: () => alive });
    sendEvent(root, key, 'caw chat (run r1): the person wrote\n"why disabled?"');
    appendFileSync(eventsFile(root, key), 'half');
    assert.ok(await until(() => lines.length === 2));
    appendFileSync(eventsFile(root, key), ' a line\n');
    assert.ok(await until(() => lines.length === 3));
    alive = false;
    assert.equal(await watching, 0);
    assert.match(lines[0], /listening as/);
    assert.equal(lines[1], 'caw chat (run r1): the person wrote "why disabled?"', 'one line, no break');
    assert.equal(lines[2], 'half a line');
    assert.match(lines.at(-1), /is gone/);
    await assert.rejects(attachCommand(root, ['--watch', 'shop']), (error) => error.code === 'usage');
});

test('attach: --attach alone, with a key or =, never eats a test name; not with --agent; --agent knows no session any more', () => {
    assert.equal(parseRunArgs('open', ['--attach', '--env', 'local']).attach, true);
    assert.equal(parseRunArgs('open', ['--attach', 'k7f2']).attach, 'k7f2');
    assert.equal(parseRunArgs('open', ['--attach=3f2a9c1b']).attach, '3f2a9c1b');
    const open = parseRunArgs('open', ['--attach', 'shop']);
    assert.deepEqual([open.attach, open.test], [true, 'shop']);
    assert.equal(parseRunArgs('run', ['smoke', '--attach']).attach, true);
    assert.equal(parseRunArgs('record', ['smoke@S3', '--attach', 'k7f2']).attach, 'k7f2');
    assert.throws(() => parseRunArgs('open', ['--attach', '--agent', 'local']), /--attach.*--agent|--agent.*--attach/);
    assert.throws(() => parseRunArgs('open', ['--agent', 'session']), /local, docker/);
    assert.equal(parseReproduceArgs(['Bug', '--attach', 'k7f2'], { root: tmpdir() }).attach, 'k7f2');
    assert.equal(parseReproduceArgs(['--attach', 'Bug text'], { root: tmpdir() }).attach, true);
});

test('attach: the task an attached session gets says the person started the run, for a recording that submitting the plan and following it is their request', async () => {
    const { sessionHint } = await import('../src/host/run.mjs');
    const recording = sessionHint('run', 'r1', { creating: true });
    assert.match(recording, /submit the plan with plan, follow it once the person approved it/);
    assert.match(recording, /The person started this recording in caw and attached it to you: submitting the plan and following it is what they asked for/);
    for (const mode of ['run', 'advise', 'talk', 'reproduce', 'develop']) {
        assert.match(sessionHint(mode, 'r1'), /run r1.*The person started this run in caw and attached it to you: carrying out this task is what they asked for/i, mode);
    }
    // The guide topics and the skill say the same for what the session reads.
    const { readFileSync } = await import('node:fs');
    for (const file of ['templates/guide/attach.md', 'templates/guide/session.md']) {
        assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /\*\*Whose request\.\*\* A run that waits for you was started by the person in caw[\s\S]*submitting the plan \(`plan`, or `caw agent plan`\) and following it/, file);
    }
    assert.match(readFileSync(new URL('../templates/skills/caw-attach/SKILL.md', import.meta.url), 'utf8'), /The person started\s+that run in caw \(or asked you to start it\): its task is their request/);
});
