// Decisions as data: stable ids, a language-neutral context, options with a gate; the run folder holds the waiting one, and
// the window, the session or a run without a window answers it. The window's cards stay as they were (flows tests).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createChat } from '../src/host/chat.mjs';
import { DECISIONS, FREE, HUMAN, PHASE_DECISIONS, autoOption, decide, decisionOf, endOption, harmlessAdopt, notedOf } from '../src/host/decisions.mjs';
import { ANSWER_FILE, DECISION_FILE, answerRefusal, createDesk, readDecision, writeAnswer } from '../src/host/decision-desk.mjs';
import { fingerprint, forgetSpawnerKey, newKeyPair, signAnswer, spawnerHandover, spawnerKey, verifyAnswer } from '../src/host/decision-proof.mjs';
import { fixPhase } from '../src/host/bugfix.mjs';
import { offerRecordRed, runFlow } from '../src/host/flows.mjs';
import { sessionMcpHandler } from '../src/host/session-mcp.mjs';
import { stepHash } from '../src/host/test-file.mjs';
import { renderReport } from '../src/shared/report.mjs';
import { EXIT, worstExit } from '../src/shared/errors.mjs';

const tempDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-decisions-'));
    // The desk's polling does not hold a run's process open; in a test something else has to.
    const alive = setInterval(() => {}, 1000);
    t.after(() => {
        clearInterval(alive);
        rmSync(dir, { recursive: true, force: true });
    });
    return dir;
};
const option = (id) => ({ id, label: id });
// The run's key pair and that of the session's MCP server it trusts: answers carry the server's proof (decision-proof.mjs).
const runKeys = newKeyPair();
const sessionKeys = newKeyPair();
const trust = { keys: runKeys, trusted: () => [sessionKeys.publicKey] };
const answerAs = (dir, answer, keys = sessionKeys) => writeAnswer(dir, signAnswer(keys, runKeys.publicKey, answer));
const tick = () => new Promise((done) => { setImmediate(done); });
const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise((done) => { setTimeout(done, 10); });
};

test('Gates: the plan is free to approve only unchanged and read-only; a changed expectation makes adopting the person\'s', () => {
    const plan = (context) => decisionOf('plan.approve', [option('approve'), option('revise')], context);
    assert.equal(plan({ changed: false, writes: false }).options[0].gate, FREE);
    assert.equal(plan({ changed: true, writes: false }).options[0].gate, HUMAN);
    assert.equal(plan({ changed: false, writes: true }).gate, HUMAN);
    assert.equal(plan({ changed: false, writes: false }).gate, FREE);

    const same = { samePlan: true, expectChange: [], known: [], removed: [], fixed: [], stale: [], seen: [] };
    assert.equal(harmlessAdopt(same), true);
    for (const [key, value] of [['samePlan', false], ['expectChange', [{ step: 'S2', before: 'a', after: 'b' }]], ['known', ['Gespeichert']], ['removed', ['S3']], ['fixed', ['S2']], ['stale', ['S2']], ['seen', ['console: x']]]) {
        assert.equal(harmlessAdopt({ ...same, [key]: value }), false, key);
        assert.equal(decisionOf('recording.adopt', [option('adopt'), option('discard')], { ...same, [key]: value }).options[0].gate, HUMAN, key);
    }
    assert.deepEqual(decisionOf('recording.adopt', [option('adopt'), option('discard')], same).options.map(({ gate }) => gate), [FREE, FREE]);
    // The first recording: its known messages are the baseline, nothing else changes; the log names them.
    const first = { ...same, firstRecording: true, known: ['Gespeichert'] };
    assert.equal(harmlessAdopt(first), true);
    assert.equal(harmlessAdopt({ ...first, expectChange: [{ step: 'S2', before: 'a', after: 'b' }] }), false);
    assert.equal(harmlessAdopt({ ...first, firstRecording: false }), false);
    assert.deepEqual(notedOf({ id: 'recording.adopt', context: first }, 'adopt'), { known: ['Gespeichert'] });
    assert.deepEqual(notedOf({ id: 'recording.adopt', context: first }, 'discard'), {});
    assert.deepEqual(notedOf({ id: 'recording.adopt', context: { ...first, firstRecording: false } }, 'adopt'), {});

    // Fixing a step the app is blamed for is the person's; asking or closing never is.
    const failed = (side) => decisionOf('step.failed', [option('fix'), option('ask'), option('close')], { diagnosis: { side, strength: 'clear' } });
    assert.deepEqual(failed('app').options.map(({ gate }) => gate), [HUMAN, FREE, FREE]);
    assert.deepEqual(failed('test').options.map(({ gate }) => gate), [FREE, FREE, FREE]);
    // Whatever a table does not know is the person's.
    assert.equal(decisionOf('step.failed', [option('something-new')]).options[0].gate, HUMAN);
    assert.equal(decisionOf('no.such', [option('close')]).gate, HUMAN);
    for (const [id, gates] of [['effect.accept', 'forget-effect'], ['target.use', 'use-target'], ['look.adopt', 'adopt-look'], ['check.failed', 'ignore-errors'], ['fix.green', 'promote'], ['advice.item', 'apply'], ['advice.item', 'accept'], ['state.restore', 'restore-picked'], ['tokens', 'go']]) {
        assert.equal(decisionOf(id, [option(gates)]).options[0].gate, HUMAN, `${id} ${gates}`);
    }
    for (const [id, free] of [['red.proof', 'adopt'], ['red.proof', 'discard'], ['fix.guide', 'retest'], ['fix.guide', 'later'], ['reproduced.record', 'record-red'], ['plan.changed', 'rerecord'], ['advice.item', 'next'], ['advice.item', 'discard']]) {
        assert.equal(decisionOf(id, [option(free)]).options[0].gate, FREE, `${id} ${free}`);
    }
});

test('Every decision id the code waits on has its gates; every phase of the bug fix names its card', () => {
    const sources = ['flows.mjs', 'run.mjs', 'commands.mjs', 'token-gate.mjs'].map((name) => readFileSync(new URL(`../src/host/${name}`, import.meta.url), 'utf8')).join('\n');
    const used = new Set([
        ...[...sources.matchAll(/decide\(chat, '([a-z]+\.[a-z]+)'/g)].map(([, id]) => id),
        ...[...sources.matchAll(/\bid: '([a-z]+\.[a-z]+)'/g)].map(([, id]) => id),
        ...[...sources.matchAll(/\bid: 'tokens'/g)].map(() => 'tokens'),
        ...[...sources.matchAll(/return '([a-z]+\.[a-z]+)';/g)].map(([, id]) => id),
        ...[...sources.matchAll(/\? '([a-z]+\.[a-z]+)' : '([a-z]+\.[a-z]+)'/g)].flatMap(([, a, b]) => [a, b]),
    ]);
    for (const id of used) assert.ok(DECISIONS[id] !== undefined, id);
    for (const id of ['plan.approve', 'recording.adopt', 'red.proof', 'step.failed', 'fix.guide', 'fix.green', 'advice.item', 'record.start', 'app.dialog', 'tokens', 'look.adopt', 'effect.accept', 'target.use', 'state.restore']) assert.ok(used.has(id), id);
    for (const id of Object.values(PHASE_DECISIONS)) assert.ok(DECISIONS[id] !== undefined, id);
});

test('A run without a window takes only the harmless: the unchanged plan, a harmless adoption, the red proof, a card with only Close', () => {
    const same = { samePlan: true, expectChange: [], known: [], removed: [], fixed: [], stale: [], seen: [] };
    const adopt = (context, extra = []) => decisionOf('recording.adopt', [...extra, option('adopt'), option('discard')], context);
    assert.equal(autoOption(decisionOf('plan.approve', [option('approve'), option('revise')], { changed: false, writes: true })), 'approve');
    assert.equal(autoOption(decisionOf('plan.approve', [option('approve'), option('revise')], { changed: true })), undefined);
    assert.equal(autoOption(adopt(same)), 'adopt');
    assert.equal(autoOption(adopt({ ...same, known: ['Gespeichert'] })), undefined);
    assert.equal(autoOption(adopt(same, [option('rerecord-next')])), undefined);
    assert.equal(autoOption(decisionOf('red.proof', [option('adopt'), option('discard')])), 'adopt');
    assert.equal(autoOption(decisionOf('run.result', [option('close')])), 'close');
    assert.equal(autoOption(decisionOf('step.failed', [option('fix'), option('ask'), option('close')])), undefined);
    // What ends a decision without changing anything; the plan has nothing.
    assert.equal(endOption(decisionOf('step.failed', [option('fix'), option('ask'), option('close')])), 'close');
    assert.equal(endOption(adopt(same)), 'discard');
    assert.equal(endOption(decisionOf('fix.green', [option('promote'), option('later')])), 'later');
    assert.equal(endOption(decisionOf('plan.approve', [option('approve'), option('revise')], { changed: true })), undefined);
    assert.equal(EXIT.decision, 5);
    assert.equal(worstExit([EXIT.pass, EXIT.decision]), EXIT.decision);
    assert.equal(worstExit([EXIT.decision, EXIT.fail]), EXIT.fail);
});

test('Desk: the waiting decision in the run folder; the session answers a free option, a human one only with consent', async (t) => {
    const dir = tempDir(t);
    const settled = [];
    const desk = createDesk({ ...trust, dir, pollMs: 5, onSettled: (entry) => settled.push(entry) });
    const shown = [];
    const chat = createChat({ show: (who, text) => shown.push([who, text]), desk });
    const options = [{ id: 'fix', label: 'Schritt reparieren' }, { id: 'close', label: 'Schließen' }];
    const asked = decide(chat, { id: 'step.failed', context: { test: 'kauf', step: 'S2', diagnosis: { side: 'app', strength: 'clear' } }, card: { kind: 'result', tone: 'fail', title: 'S2 fehlgeschlagen' }, options });
    const waiting = readDecision(dir);
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.id, 'step.failed');
    assert.deepEqual(waiting.context, { test: 'kauf', step: 'S2', diagnosis: { side: 'app', strength: 'clear' } });
    assert.deepEqual(waiting.options, [{ id: 'fix', label: 'Schritt reparieren', gate: HUMAN }, { id: 'close', label: 'Schließen', gate: FREE }]);
    assert.equal(waiting.gate, HUMAN);

    // A human option from the session is not taken; a stale seq neither.
    assert.equal(answerRefusal(waiting, { option: 'fix', by: 'session' }), 'needs-human');
    assert.equal(answerRefusal(waiting, { option: 'fix', by: 'elicitation' }), undefined);
    assert.equal(answerRefusal(waiting, { option: 'gone', by: 'session' }), 'unknown-option');
    answerAs(dir, { seq: waiting.seq, id: waiting.id, option: 'fix', by: 'session' });
    await until(() => !readdirSync(dir).includes(ANSWER_FILE));
    answerAs(dir, { seq: waiting.seq + 1, id: waiting.id, option: 'close', by: 'session' });
    await until(() => !readdirSync(dir).includes(ANSWER_FILE));
    assert.equal(readDecision(dir).state, 'waiting');
    answerAs(dir, { seq: waiting.seq, id: waiting.id, option: 'close', by: 'session' });
    assert.equal(await asked, 'close');
    assert.deepEqual(shown.at(-1), ['notice', 'Schließen: von der Session beantwortet.']);
    assert.equal(readDecision(dir).state, 'answered');
    assert.deepEqual(settled.map(({ id, option: chosen, by }) => [id, chosen, by]), [['step.failed', 'close', 'session']]);

    // The window answers the next one: first answer wins, the desk says who.
    const next = decide(chat, { id: 'red.proof', context: { test: 'kauf', step: 'S2' }, card: { kind: 'result', tone: 'info', title: 'S2 rot' }, options: [{ id: 'adopt', label: 'Übernehmen' }, { id: 'discard', label: 'Verwerfen' }] });
    chat.human.choose('adopt');
    assert.equal(await next, 'adopt');
    assert.deepEqual(settled.at(-1).by, 'window');
    const late = readDecision(dir);
    answerAs(dir, { seq: late.seq, id: 'red.proof', option: 'discard', by: 'session' });
    await until(() => !readdirSync(dir).includes(ANSWER_FILE));
    assert.equal(settled.length, 2);
    desk.close();
});

test('Desk: the plan card approved through the session; a question in between a conversation comes back to it', async (t) => {
    const dir = tempDir(t);
    const desk = createDesk({ ...trust, dir, pollMs: 5 });
    const chat = createChat({ desk });
    const planned = decide(chat, { id: 'plan.approve', via: 'plan', context: { changed: false, writes: false }, card: { steps: [{ id: 'S1', name: 'a', expect: 'b' }] }, options: [{ id: 'approve', label: 'Plan freigeben' }, { id: 'revise', label: 'Änderung erbitten' }] });
    const waiting = readDecision(dir);
    assert.equal(waiting.id, 'plan.approve');
    answerAs(dir, { seq: waiting.seq, id: 'plan.approve', option: 'revise', message: 'S1 genauer', by: 'session' });
    assert.deepEqual(await planned, { approved: false, feedback: 'S1 genauer' });

    // A failure under discussion, the token notice in between: the desk shows the notice, then the failure again.
    const talk = decide(chat, { id: 'step.failed', via: 'discuss', question: 'S2?', context: { step: 'S2' }, options: [{ id: 'close', label: 'Schließen' }], card: { kind: 'result', title: 'S2' } });
    const failureSeq = readDecision(dir).seq;
    const tokens = decide(chat, { id: 'tokens', kind: 'choosing', question: 'Token?', options: [{ id: 'go', label: 'Los' }, { id: 'stop', label: 'Nein' }], card: { kind: 'tokens', text: 'x' } });
    assert.equal(readDecision(dir).id, 'tokens');
    chat.human.choose('stop');
    assert.equal(await tokens, 'stop');
    assert.equal(readDecision(dir).seq, failureSeq);
    answerAs(dir, { seq: failureSeq, id: 'step.failed', option: 'close', by: 'session' });
    assert.deepEqual(await talk, { choice: 'close' });
    desk.close();
});

test('Desk without a window: the harmless taken at once, what needs a person ends with its harmless answer, the plan ends the run', async (t) => {
    const dir = tempDir(t);
    const stopped = [];
    const stuck = [];
    const settled = [];
    const desk = createDesk({ ...trust, dir, auto: true, onSettled: (entry) => settled.push(entry), onStop: (entry) => stopped.push(entry.id), onStuck: (entry) => stuck.push(entry.id) });
    const chat = createChat({ desk });
    const same = { samePlan: true, expectChange: [], known: [], removed: [], fixed: [], stale: [], seen: [] };
    const adopt = [{ id: 'adopt', label: 'Übernehmen' }, { id: 'discard', label: 'Verwerfen' }];
    assert.equal(await decide(chat, { id: 'recording.adopt', context: same, question: 'Übernehmen?', options: adopt, card: { title: 'x' } }), 'adopt');
    assert.equal(await decide(chat, { id: 'recording.adopt', context: { ...same, known: ['Gespeichert'] }, question: 'Übernehmen?', options: adopt, card: { title: 'x' } }), 'discard');
    assert.deepEqual(stopped, ['recording.adopt']);
    // The first recording: adopted by caw, the log names the messages it took as known.
    assert.equal(await decide(chat, { id: 'recording.adopt', context: { ...same, firstRecording: true, known: ['Gespeichert'] }, question: 'Übernehmen?', options: adopt, card: { title: 'x' } }), 'adopt');
    assert.deepEqual(settled.map(({ option: chosen, by }) => [chosen, by]), [['adopt', 'auto'], ['discard', 'auto'], ['adopt', 'auto']]);
    assert.deepEqual(settled.at(-1).known, ['Gespeichert']);
    assert.equal(settled[0].known, undefined);
    const plan = decide(chat, { id: 'plan.approve', via: 'plan', context: { changed: true }, card: { steps: [] }, options: [{ id: 'approve', label: 'a' }, { id: 'revise', label: 'r' }] });
    await until(() => stuck.length > 0);
    assert.deepEqual(stuck, ['plan.approve']);
    assert.deepEqual(stopped, ['recording.adopt', 'plan.approve']);
    chat.human.closed();
    assert.deepEqual(await plan, { approved: false, feedback: null });
    desk.close();

    // An attached session may still bring the person's consent: the decision waits, then the person's answer is taken.
    const later = tempDir(t);
    const waitingDesk = createDesk({ ...trust, dir: later, auto: true, waitMs: 60_000, pollMs: 5, onStop: (entry) => stopped.push(entry.id) });
    const waitingChat = createChat({ desk: waitingDesk });
    const green = decide(waitingChat, { id: 'fix.green', context: { test: 'bug' }, card: { title: 'grün' }, options: [{ id: 'promote', label: 'Übernehmen' }, { id: 'later', label: 'Später' }] });
    await tick();
    const entry = readDecision(later);
    answerAs(later, { seq: entry.seq, id: 'fix.green', option: 'promote', by: 'elicitation' });
    assert.equal(await green, 'promote');
    assert.deepEqual(stopped, ['recording.adopt', 'plan.approve']);
    waitingDesk.close();
});

test('Answer proof: only an MCP server the run trusts can answer; a file the session writes itself is ignored and reported', async (t) => {
    const dir = tempDir(t);
    const ignored = [];
    const settled = [];
    const desk = createDesk({ ...trust, dir, pollMs: 5, onIgnored: (entry) => ignored.push(entry), onSettled: (entry) => settled.push(entry) });
    const chat = createChat({ desk });
    const asked = decide(chat, { id: 'step.failed', context: { test: 'kauf', step: 'S2', diagnosis: { side: 'app', strength: 'clear' } }, card: { kind: 'result', title: 'S2' }, options: [{ id: 'fix', label: 'Reparieren' }, { id: 'close', label: 'Schließen' }] });
    const waiting = readDecision(dir);
    // decision.json names the run's public key and whose answers it takes; no secret.
    assert.deepEqual(waiting.answers, { key: runKeys.publicKey, from: 'listeners' });
    const gone = () => until(() => !readdirSync(dir).includes(ANSWER_FILE));
    // Forged by the session's own file tools: no proof, a made-up one, a key the run does not trust, an answer changed after signing.
    writeAnswer(dir, { seq: waiting.seq, id: 'step.failed', option: 'fix', by: 'elicitation' });
    await gone();
    writeAnswer(dir, { seq: waiting.seq, id: 'step.failed', option: 'fix', by: 'elicitation', from: sessionKeys.publicKey, proof: '0'.repeat(64) });
    await gone();
    answerAs(dir, { seq: waiting.seq, id: 'step.failed', option: 'fix', by: 'elicitation' }, newKeyPair());
    await gone();
    writeAnswer(dir, { ...signAnswer(sessionKeys, runKeys.publicKey, { seq: waiting.seq, id: 'step.failed', option: 'close', by: 'session' }), option: 'fix', by: 'elicitation' });
    await gone();
    writeFileSync(join(dir, ANSWER_FILE), 'not json');
    await gone();
    assert.equal(readDecision(dir).state, 'waiting');
    assert.deepEqual(ignored.map(({ id, option: chosen, by }) => [id, chosen, by]), [['step.failed', 'fix', 'elicitation'], ['step.failed', 'fix', 'elicitation'], ['step.failed', 'fix', 'elicitation'], ['step.failed', 'fix', 'elicitation'], ['?', '?', '?']]);
    assert.equal(settled.length, 0);
    // With the trusted server's proof it is taken.
    answerAs(dir, { seq: waiting.seq, id: 'step.failed', option: 'fix', by: 'elicitation' });
    assert.equal(await asked, 'fix');
    assert.equal(settled[0].by, 'elicitation');
    desk.close();

    // Started by an MCP server: only that one may answer; started by one whose key never came: nobody.
    const started = tempDir(t);
    const other = newKeyPair();
    const onlyStarter = createDesk({ ...trust, dir: started, pollMs: 5, starter: other.publicKey, onIgnored: (entry) => ignored.push(entry) });
    const startedChat = createChat({ desk: onlyStarter });
    const closing = decide(startedChat, { id: 'run.result', card: { kind: 'result', title: 'x' }, options: [option('close')] });
    const first = readDecision(started);
    assert.deepEqual(first.answers, { key: runKeys.publicKey, from: 'starter', starter: fingerprint(other.publicKey) });
    answerAs(started, { seq: first.seq, id: 'run.result', option: 'close', by: 'session' });
    await until(() => !readdirSync(started).includes(ANSWER_FILE));
    assert.equal(ignored.length, 6);
    answerAs(started, { seq: first.seq, id: 'run.result', option: 'close', by: 'session' }, other);
    assert.equal(await closing, 'close');
    onlyStarter.close();
    const none = tempDir(t);
    const nobody = createDesk({ ...trust, dir: none, starter: null });
    decide(createChat({ desk: nobody }), { id: 'run.result', card: { kind: 'result', title: 'x' }, options: [option('close')] });
    assert.equal(readDecision(none).answers.from, 'none');
    nobody.close();

    // The proof itself: bound to the run's key and the whole answer.
    const signed = signAnswer(sessionKeys, runKeys.publicKey, { seq: 1, id: 'a', option: 'b', by: 'session' });
    assert.equal(verifyAnswer(runKeys, [sessionKeys.publicKey], signed), true);
    assert.equal(verifyAnswer(runKeys, [], signed), false);
    assert.equal(verifyAnswer(newKeyPair(), [sessionKeys.publicKey], signed), false);
    assert.equal(verifyAnswer(runKeys, [sessionKeys.publicKey], { ...signed, seq: 2 }), false);
    assert.equal(verifyAnswer(runKeys, [sessionKeys.publicKey], { ...signed, message: 'x' }), false);
});

test('Answer proof: a run started by the MCP server reads its key once from stdin, never from a file', async () => {
    const { PassThrough } = await import('node:stream');
    forgetSpawnerKey();
    assert.equal(await spawnerKey({ env: {} }), undefined);
    forgetSpawnerKey();
    const { env, line } = spawnerHandover(sessionKeys);
    const input = new PassThrough();
    const own = { ...env };
    const reading = spawnerKey({ env: own, input });
    input.write(line);
    assert.equal(await reading, sessionKeys.publicKey);
    assert.equal(own.CAW_ANSWER_KEY, undefined, 'nothing the run starts reads it again');
    assert.equal(await spawnerKey({ env: { ...env }, input: new PassThrough() }), sessionKeys.publicKey, 'read once');
    forgetSpawnerKey();
    const broken = new PassThrough();
    const nothing = spawnerKey({ env: { ...env }, input: broken });
    broken.end('not a key\n');
    assert.equal(await nothing, null);
    forgetSpawnerKey();
    assert.equal(await spawnerKey({ env: { ...env }, input: new PassThrough(), timeoutMs: 20 }), null);
    forgetSpawnerKey();
});

test('The bug fix phases and the window\'s cards follow one model: next.decision is the card the window shows then', async () => {
    assert.equal(fixPhase({ id: 'b', draft: { steps: [] } }).next.decision, 'reproduced.record');
    const seen = [];
    const chat = { choose: async (kind, text, options, card, decision) => { seen.push(decision.id); return options.at(-1).id; } };
    await offerRecordRed(chat, { file: 'caw/drafts/b.yaml', record: 'caw record b' });
    assert.deepEqual(seen, [PHASE_DECISIONS.reproduced]);

    const step = { id: 'S1', name: 'Summe', do: '', expect: 'Total: 5.' };
    const red = { id: 'b', draft: true, red: { step: 'S1', run: 'r1' }, steps: [{ ...step, recording: { hash: stepHash(step), recordedOn: 'dev', actions: [], check: 'c' } }], expectations: [{ id: 'S1' }] };
    assert.equal(fixPhase({ id: 'b', draft: red }).next.decision, 'fix.guide');
    assert.equal(fixPhase({ id: 'b', draft: red, runs: [{ runId: 'r2', status: 'pass', results: [{ id: 'S1', status: 'pass' }] }] }).next.decision, 'fix.green');
    const ids = [];
    const guided = { choose: async (kind, text, options, card, decision) => { ids.push(decision.id); return options.find(({ id }) => ['later', 'close'].includes(id))?.id ?? options.at(-1).id; }, notice: () => {}, progress: () => {} };
    const play = (outcome) => ({ execute: async ({ conclude }) => { await conclude({ ...outcome, chat: guided }); return outcome; } });
    const failing = { exitCode: EXIT.fail, runId: 'r3', verdict: { status: 'fail', results: [{ id: 'S1', status: 'fail' }] }, failed: { id: 'S1', reason: 'nein', evaluated: true } };
    await runFlow({ spec: red, canFix: true, ...play(failing), adopt: () => 'x', log: () => {}, guide: { cause: undefined, promote: async () => ({ ok: true }) } });
    const passing = { exitCode: EXIT.pass, runId: 'r4', verdict: { status: 'pass', results: [{ id: 'S1', status: 'pass' }] } };
    await runFlow({ spec: red, canFix: true, ...play(passing), adopt: () => 'x', log: () => {}, guide: { cause: undefined, promote: async () => ({ ok: true }) } });
    assert.deepEqual(ids, [PHASE_DECISIONS.red, PHASE_DECISIONS.green]);
});

test('caw_status: a waiting decision of a living run as data; an open one of a run without a window from its result', async (t) => {
    const root = tempDir(t);
    writeFileSync(join(root, 'caw.config.json'), readFileSync(new URL('../templates/caw.config.example.json', import.meta.url), 'utf8'));
    const runId = '2026-11-22T10-00-00-000Z-kauf';
    const runDir = join(root, '.caw', 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(root, '.caw', 'last-run.json'), JSON.stringify({ runId, runDir, pid: process.pid, command: 'record', test: 'kauf', target: 'dev', startedAt: new Date().toISOString() }));
    const decision = { seq: 3, id: 'recording.adopt', context: { test: 'kauf', samePlan: true }, options: [{ id: 'adopt', label: 'Übernehmen', gate: FREE }, { id: 'discard', label: 'Verwerfen', gate: FREE }], gate: FREE, since: '2026-11-22T10:00:01.000Z' };
    writeFileSync(join(runDir, DECISION_FILE), JSON.stringify({ state: 'waiting', ...decision }));
    const handler = sessionMcpHandler({ root });
    const call = async (args = {}) => (await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'caw_status', arguments: args } })).result;
    const status = await call();
    assert.equal(status.structuredContent.state, 'deciding');
    assert.deepEqual(status.structuredContent.waiting, { runId, decision });
    assert.match(status.content[0].text, /wartet auf eine Entscheidung: recording\.adopt\. Optionen: adopt \(free\), discard \(free\)/);
    // A decision of a run whose process is gone waits for nobody.
    writeFileSync(join(root, '.caw', 'last-run.json'), JSON.stringify({ runId, runDir, pid: 2 ** 22 + 4321, command: 'record', test: 'kauf' }));
    assert.equal((await call()).structuredContent.waiting, undefined);
    const open = { id: 'recording.adopt', context: { known: ['Gespeichert'] }, options: decision.options, gate: HUMAN };
    writeFileSync(join(runDir, 'result.json'), JSON.stringify({ status: 'pass', decisions: [{ seq: 1, id: 'plan.approve', option: 'approve', by: 'auto' }], openDecision: open }));
    const ended = (await call()).structuredContent;
    assert.deepEqual(ended.openDecision, open);
    assert.deepEqual(ended.result.decisions, [{ seq: 1, id: 'plan.approve', option: 'approve', by: 'auto' }]);
});

test('report.md lists the decisions and who took them, and the one left open', () => {
    const text = renderReport({ status: 'pass', testId: 'kauf', target: 'dev', testedCode: 'x', decisions: [{ id: 'plan.approve', option: 'approve', by: 'auto' }, { id: 'recording.adopt', option: 'discard', by: 'window' }], openDecision: { id: 'recording.adopt', options: [{ id: 'adopt', gate: HUMAN }, { id: 'discard', gate: FREE }] } });
    assert.match(text, /## Entscheidungen\n\n- plan\.approve: approve \(von caw, nichts ändert sich, was der Test prüft\)\n- recording\.adopt: discard \(im Fenster\)/);
    const first = renderReport({ status: 'pass', testId: 'kauf', target: 'dev', testedCode: 'x', decisions: [{ id: 'recording.adopt', option: 'adopt', by: 'auto', known: ['Gespeichert', 'a|b'] }] });
    const forged = renderReport({ status: 'pass', testId: 'kauf', target: 'dev', testedCode: 'x', ignoredAnswers: [{ id: 'step.failed', option: 'fix', by: 'elicitation' }] });
    assert.match(forged, /## Entscheidungen\n\n- ungültige Antwort ignoriert: step\.failed: fix, eine Antwortdatei ohne gültigen Nachweis/);
    assert.match(first, /- recording\.adopt: adopt \(von caw, nichts ändert sich, was der Test prüft\); als bekannt übernommen, die Basis der ersten Aufnahme: "Gespeichert"; "a\\\|b"/);
    assert.match(text, /## Offene Entscheidung\n\nDer Lauf hat bei recording\.adopt angehalten und nichts geschrieben: Das entscheidet ein Mensch\. Optionen: adopt \(human\), discard \(free\)\./);
});
