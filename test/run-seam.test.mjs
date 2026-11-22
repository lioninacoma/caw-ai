// The seam between the flows and a run: executeRun and closeRun with a fake browser session, a chat without a window and a
// scripted playback. What the flows decide must reach the run and its files the same way the workbench does it.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createChat } from '../src/host/chat.mjs';
import { fixFlow, runFlow } from '../src/host/flows.mjs';
import { executeRun } from '../src/host/run.mjs';
import { stepHash } from '../src/host/test-file.mjs';
import { EXIT } from '../src/shared/errors.mjs';

const stepOf = (id) => {
    const step = { id, name: `Schritt ${id}`, do: 'tun', expect: `${id} da` };
    return { ...step, recording: { hash: stepHash(step), recordedOn: 'dev', recordedAt: 'z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [{ action: 'reload' }], check: `return "${id}" !== ""` } };
};
const testOf = (extra = {}) => {
    const steps = [stepOf('S1'), stepOf('S2')];
    return { id: 'kauf', role: 'tester', writes: false, notes: '', steps, expectations: steps.map(({ id, expect }) => ({ id, text: expect })), ...extra };
};
const config = { language: 'de', environments: { dev: { url: 'http://localhost:9', agent: true, writable: true } } };
const checked = { name: 'dev', url: 'http://localhost:9', source: 'deployed', agent: true, writable: true };

/** A browser session without Chrome: no page is ever touched, the run only reads its lists. */
const fakeSession = () => ({
    failures: () => [],
    warnings: () => [],
    writes: () => [],
    secrets: () => [],
    drainFailures: () => [],
    closed: new Promise(() => {}),
    stopTrace: async () => {},
    close: async () => {},
});

/** The playback of a recording: each step passes, except `fail` whose check answered "no" (it evaluated). */
const playback = (fail) => async ({ replay, log }) => {
    const ids = [...new Set(replay.steps.filter(({ action }) => action === 'check').map(({ id }) => id))];
    const results = new Map();
    for (const [index, id] of ids.entries()) {
        log?.({ position: index + 1, number: 1, owner: id, label: 'check' });
        results.set(id, id === fail ? { id, status: 'fail', note: `${id} nicht da`, evidence: { type: 'eval', value: 'false' } } : { id, status: 'pass', evidence: { type: 'eval', value: 'true' } });
    }
    return { results, broken: null, remembered: new Map(), requests: new Map(), effects: new Map(), deviations: new Map(), retried: new Map(), evaluated: new Set(fail === undefined ? [] : [fail]), designs: new Map(), looks: new Map(), seenLooks: new Map(), lookHints: new Map() };
};

/**
 * A run of caw with the seams in place: the chat answers with `answers` in order, one per decision, as the window's buttons do.
 * @returns { execute, decisions } with what each decision offered
 */
const harness = ({ fail, answers = [] }) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-seam-'));
    mkdirSync(join(root, 'caw'), { recursive: true });
    const wishes = [...answers];
    const decisions = [];
    const openChat = async ({ desk }) => {
        const chat = createChat({
            desk,
            show: (who, text, about) => {
                if (['result', 'failure', 'decision'].includes(who)) decisions.push({ who, text, card: about });
            },
            status: (state, options) => {
                if (options === undefined || options === null || !['deciding', 'discussing'].includes(state)) return;
                const ids = options.map(({ id }) => id);
                decisions.at(-1).options = ids;
                const wish = wishes.find((candidate) => ids.includes(candidate));
                if (wish !== undefined) wishes.splice(wishes.indexOf(wish), 1);
                // The click comes after the question is up, like in the window.
                setImmediate(() => chat.human.choose(wish ?? ids.at(-1)));
            },
        });
        return chat;
    };
    const runs = [];
    const execute = async ({ spec, lazyChat, testing, ...call }) => {
        const result = await executeRun(root, config, call.sandbox ?? null, {
            spec,
            checked,
            target: 'dev',
            stepTimeoutMs: 1000,
            maxActions: 10,
            ...call,
            ...(call.conclude === undefined ? {} : { conversation: { transcript: [], lazy: lazyChat !== undefined, testing: testing === true } }),
            seams: { openRunSession: async () => fakeSession(), openChat, playReplay: playback(fail) },
        });
        runs.push(result);
        return result;
    };
    const adopted = [];
    const adopt = (draft, only) => {
        adopted.push({ draft, only });
        return `caw/tests/${draft.id}.yaml`;
    };
    return { root, execute, decisions, runs, adopted, adopt, result: (index = -1) => JSON.parse(readFileSync(join(root, runs.at(index).report.replace(/report\.md$/, 'result.json')), 'utf8')) };
};

test('Seam: a passed check run of a new recording waits for adopting, then writes the test', async () => {
    const h = harness({ answers: ['adopt'] });
    const code = await fixFlow({ draft: testOf(), whole: true, execute: h.execute, adopt: h.adopt, log: () => {}, advising: false });
    assert.equal(code, EXIT.pass);
    assert.deepEqual(h.decisions.map(({ options }) => options), [['adopt', 'discard']]);
    assert.equal(h.adopted.length, 1);
    assert.equal(h.adopted[0].only, undefined);
    assert.equal(h.result().status, 'pass');
    assert.ok(existsSync(join(h.root, h.runs[0].report)));
    // The decision as data: logged with who took it, and answered in the run folder.
    assert.deepEqual(h.result().decisions.map(({ id, option, by }) => [id, option, by]), [['recording.adopt', 'adopt', 'window']]);
    const file = JSON.parse(readFileSync(join(h.root, h.runs[0].report.replace(/report\.md$/, 'decision.json')), 'utf8'));
    assert.deepEqual([file.state, file.id, file.option, file.by], ['answered', 'recording.adopt', 'adopt', 'window']);
});

test('Seam: a failed step in a test run waits on the failure card; closing ends with fail and writes nothing', async () => {
    const h = harness({ fail: 'S2', answers: ['close'] });
    const code = await runFlow({ spec: testOf(), canFix: true, execute: h.execute, adopt: h.adopt, log: () => {}, openSandbox: async () => null });
    assert.equal(code, EXIT.fail);
    assert.equal(h.decisions.length, 1);
    assert.equal(h.decisions[0].who, 'failure');
    assert.deepEqual(h.decisions[0].options, ['fix', 'ask', 'close']);
    assert.deepEqual(h.adopted, []);
    const result = h.result();
    assert.equal(result.status, 'fail');
    assert.equal(result.steps.find(({ id }) => id === 'S2').status, 'fail');
    assert.deepEqual(result.decisions.map(({ id, option }) => [id, option]), [['step.failed', 'close']]);
});

test('Seam: a draft red at its step in the check run offers the red proof; adopting saves it with the run', async () => {
    const h = harness({ fail: 'S2', answers: ['adopt'] });
    const code = await fixFlow({ draft: testOf({ draft: true }), whole: true, execute: h.execute, adopt: h.adopt, log: () => {}, advising: false, head: () => 'abc1234' });
    assert.equal(code, EXIT.pass);
    assert.deepEqual(h.decisions.map(({ options }) => options), [['adopt', 'discard']]);
    assert.equal(h.adopted.length, 1);
    assert.deepEqual(h.adopted[0].draft.red, { step: 'S2', run: h.runs[0].runId, head: 'abc1234' });
});
