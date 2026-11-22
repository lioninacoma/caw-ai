// caw_decide: the session answers the decision a run waits for. Free options it may answer itself; options that change the
// standard only with the person's consent, asked through the client (MCP elicitation) when it declared that capability.
// The run here is a chat with its desk in this process, as a run has it; the client is a fake that answers forms or not.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createChat } from '../src/host/chat.mjs';
import { decide } from '../src/host/decisions.mjs';
import { ANSWER_FILE, createDesk, readDecision, writeAnswer } from '../src/host/decision-desk.mjs';
import { isPublicKey, newKeyPair } from '../src/host/decision-proof.mjs';
import { liveListeners } from '../src/shared/attach.mjs';
import { sessionMcpHandler } from '../src/host/session-mcp.mjs';
import { createMcpHandler, unknownFields } from '../src/sandbox/mcp.mjs';

const RUN_ID = '2026-11-22T11-00-00-000Z-kauf';

/** A project whose last run is alive (this process) and waits through its desk. */
const project = (t, { window = true, starter } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-decide-'));
    // The desk's polling does not hold a process open; the test does.
    const alive = setInterval(() => {}, 1000);
    writeFileSync(join(root, 'caw.config.json'), readFileSync(new URL('../templates/caw.config.example.json', import.meta.url), 'utf8'));
    const runDir = join(root, '.caw', 'runs', RUN_ID);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(root, '.caw', 'last-run.json'), JSON.stringify({ runId: RUN_ID, runDir, pid: process.pid, command: 'record', test: 'kauf', target: 'dev', startedAt: new Date().toISOString() }));
    const settled = [];
    const ignored = [];
    // As run.mjs: answers count from a session listening in the project, or only from the one that started the run.
    const desk = createDesk({ dir: runDir, pollMs: 5, auto: !window, onSettled: (entry) => settled.push(entry), waitMs: window ? 0 : 60_000, starter, trusted: () => liveListeners(root).map(({ publicKey }) => publicKey).filter(isPublicKey), onIgnored: (entry) => ignored.push(entry) });
    const shown = [];
    const chat = createChat({ show: (who, text) => shown.push([who, text]), desk });
    t.after(() => {
        desk.close();
        clearInterval(alive);
        rmSync(root, { recursive: true, force: true });
    });
    return { root, runDir, chat, settled, shown, ignored };
};

/** The MCP client: initialize (with or without elicitation), tool calls, and the forms the server sends it. */
const client = async (root, { elicitation = false, form } = {}) => {
    const handler = sessionMcpHandler({ root, windowWait: { decideMs: 3000, pollMs: 10 } });
    const forms = [];
    let next = 1;
    const notify = (message) => {
        if (message.method !== 'elicitation/create') return;
        forms.push(message.params);
        // The person answers the form, after a moment, as the client sends it back.
        setTimeout(() => handler({ jsonrpc: '2.0', id: message.id, result: form(message.params) }, notify), 20);
    };
    await handler({ jsonrpc: '2.0', id: next++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: elicitation ? { elicitation: {} } : {}, clientInfo: { name: 'fake', version: '1' } } }, notify);
    const call = async (name, args) => (await handler({ jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } }, notify)).result;
    return { call, forms };
};

const failure = (chat, context = { test: 'kauf', step: 'S2', diagnosis: { side: 'app', strength: 'clear' } }) => decide(chat, {
    id: 'step.failed',
    via: 'discuss',
    question: 'S2 fehlgeschlagen',
    context,
    options: [{ id: 'fix', label: 'Schritt reparieren' }, { id: 'ask', label: 'Ursache suchen' }, { id: 'close', label: 'Schließen' }],
    card: { kind: 'result', title: 'S2 fehlgeschlagen' },
});

test('caw_decide: a free option from the session; the window shows who answered, result and file say it', async (t) => {
    const p = project(t);
    const { call } = await client(p.root);
    const asked = failure(p.chat);
    const status = (await call('caw_status', {})).structuredContent;
    assert.equal(status.waiting.decision.id, 'step.failed');
    const answered = await call('caw_decide', { decision: 'step.failed', option: 'close' });
    assert.equal(answered.isError, false);
    assert.deepEqual(answered.structuredContent, { state: 'answered', runId: RUN_ID, decision: 'step.failed', option: 'close', gate: 'free', by: 'session' });
    assert.deepEqual(await asked, { choice: 'close' });
    assert.deepEqual(p.shown.at(-1), ['notice', 'Schließen: von der Session beantwortet.']);
    assert.deepEqual(p.settled.map(({ id, option, by, gate }) => [id, option, by, gate]), [['step.failed', 'close', 'session', 'free']]);
    // Nothing waits any more: a second answer is refused and names the first one.
    const late = await call('caw_decide', { decision: 'step.failed', option: 'ask' });
    assert.equal(late.isError, true);
    assert.deepEqual(late.structuredContent.answered, { id: 'step.failed', option: 'close', by: 'session' });
});

test('caw_decide: a human option without elicitation is refused with the way by hand; the decision still waits', async (t) => {
    const p = project(t);
    const { call, forms } = await client(p.root);
    const asked = failure(p.chat);
    const refused = await call('caw_decide', { decision: 'step.failed', option: 'fix' });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.state, 'refused');
    assert.equal(refused.structuredContent.reason, 'needs-human');
    assert.match(refused.content[0].text, /fix ändert den Maßstab des Tests: Das entscheidet der Mensch.*antwortet der Mensch im caw-Fenster/);
    assert.equal(forms.length, 0);
    assert.equal(readDecision(p.runDir).state, 'waiting');
    // Wrong decision, unknown option, a field the tool does not take: refused before anything is written.
    assert.match((await call('caw_decide', { decision: 'recording.adopt', option: 'adopt' })).content[0].text, /wartet auf step\.failed, nicht auf recording\.adopt/);
    assert.match((await call('caw_decide', { decision: 'step.failed', option: 'adopt' })).content[0].text, /Ihre Optionen: fix, ask, close/);
    const extra = await call('caw_decide', { decision: 'step.failed', option: 'close', by: 'elicitation' });
    assert.equal(extra.isError, true);
    assert.match(extra.content[0].text, /caw_decide does not take by\. Its fields: decision, option, run, message/);
    assert.equal(readDecision(p.runDir).state, 'waiting');
    // The window answers: the first answer wins.
    p.chat.human.choose('close');
    assert.deepEqual(await asked, { choice: 'close' });
    assert.equal(p.settled.at(-1).by, 'window');
});

test('caw_decide: a human option with elicitation asks the person; confirmed it is taken as theirs, declined it waits', async (t) => {
    const p = project(t);
    let confirm = false;
    const { call, forms } = await client(p.root, { elicitation: true, form: () => (confirm ? { action: 'accept', content: { confirm: true } } : { action: 'decline' }) });
    const asked = failure(p.chat);
    const declined = await call('caw_decide', { decision: 'step.failed', option: 'fix' });
    assert.equal(declined.structuredContent.state, 'declined');
    assert.equal(declined.structuredContent.action, 'decline');
    assert.equal(readDecision(p.runDir).state, 'waiting');
    assert.equal(forms.length, 1);
    assert.match(forms[0].message, /caw-Lauf 2026-11-22T11-00-00-000Z-kauf wartet auf step\.failed\. Antwort: Schritt reparieren \(fix\)\. Das ändert, was der Test prüft\. test: kauf, step: S2/);
    assert.deepEqual(forms[0].requestedSchema, { type: 'object', properties: { confirm: { type: 'boolean', title: 'Ja: Schritt reparieren', description: 'Das entscheidest nur du; der Agent kann dieses Formular nicht beantworten.' } }, required: ['confirm'] });
    confirm = true;
    const taken = await call('caw_decide', { decision: 'step.failed', option: 'fix' });
    assert.equal(taken.structuredContent.state, 'answered');
    assert.equal(taken.structuredContent.by, 'elicitation');
    assert.deepEqual(await asked, { choice: 'fix' });
    assert.deepEqual(p.shown.at(-1), ['notice', 'Schritt reparieren: von dir in der Session bestätigt.']);
    assert.deepEqual(p.settled.map(({ option, by }) => [option, by]), [['fix', 'elicitation']]);
    // A free option needs no form.
    const next = failure(p.chat, { test: 'kauf', step: 'S3' });
    await call('caw_decide', { decision: 'step.failed', option: 'close' });
    assert.deepEqual(await next, { choice: 'close' });
    assert.equal(forms.length, 2);
});

test('caw_decide on a run without a window: a human decision waits for the person\'s consent; without it the way is a run with a window', async (t) => {
    const p = project(t, { window: false });
    const { call } = await client(p.root);
    const green = decide(p.chat, { id: 'fix.green', context: { test: 'kauf', step: 'S2' }, card: { title: 'grün' }, options: [{ id: 'promote', label: 'Übernehmen' }, { id: 'later', label: 'Später' }] });
    const refused = await call('caw_decide', { decision: 'fix.green', option: 'promote' });
    assert.match(refused.content[0].text, /der Lauf hat kein Fenster: Der Mensch nimmt mit Fenster auf \(caw record kauf\)/);
    const person = await client(p.root, { elicitation: true, form: () => ({ action: 'accept', content: { confirm: true } }) });
    assert.equal((await person.call('caw_decide', { decision: 'fix.green', option: 'promote' })).structuredContent.by, 'elicitation');
    assert.equal(await green, 'promote');
});

test('caw_decide: the session\'s answer carries the MCP server\'s proof; one it writes with its own file tools is ignored', async (t) => {
    const p = project(t);
    const { call } = await client(p.root);
    const asked = failure(p.chat);
    const waiting = readDecision(p.runDir);
    // What a session could write itself: the human option, claimed as the person's consent.
    writeAnswer(p.runDir, { seq: waiting.seq, id: 'step.failed', option: 'fix', by: 'elicitation' });
    for (let i = 0; i < 200 && p.ignored.length === 0; i += 1) await new Promise((done) => { setTimeout(done, 10); });
    assert.deepEqual(p.ignored.map(({ id, option, by }) => [id, option, by]), [['step.failed', 'fix', 'elicitation']]);
    assert.equal(readDecision(p.runDir).state, 'waiting');
    // caw_status shows the decision, not the run's key.
    assert.equal((await call('caw_status', {})).structuredContent.waiting.decision.answers, undefined);
    const answered = await call('caw_decide', { decision: 'step.failed', option: 'close' });
    assert.equal(answered.structuredContent.state, 'answered');
    assert.deepEqual(await asked, { choice: 'close' });
    assert.equal(p.ignored.length, 1);
    assert.equal(readDecision(p.runDir).state, 'answered');
    assert.equal(ANSWER_FILE, 'decision-answer.json');
});

test('caw_decide: a run another session started takes only that session\'s answers', async (t) => {
    const p = project(t, { starter: newKeyPair().publicKey });
    const { call } = await client(p.root);
    const asked = failure(p.chat);
    const refused = await call('caw_decide', { decision: 'step.failed', option: 'close' });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.reason, 'not-trusted');
    assert.match(refused.content[0].text, /hat eine andere Session gestartet, und er nimmt nur ihre Antworten\. Stattdessen antwortet der Mensch im caw-Fenster\./);
    p.chat.human.choose('close');
    assert.deepEqual(await asked, { choice: 'close' });
});

test('MCP: unknown fields are refused for every tool with a closed schema; the client\'s answer to a form settles it', async (t) => {
    // The form's time limit does not hold a process open; the test does.
    const alive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(alive));
    assert.deepEqual(unknownFields({ type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 }), ['b']);
    assert.deepEqual(unknownFields({ type: 'object', properties: { a: {} } }, { b: 2 }), []);
    const tool = { name: 'probe', description: '', inputSchema: { type: 'object', properties: { what: { type: 'string' } }, additionalProperties: false }, call: async (input, { elicit }) => ({ text: JSON.stringify(elicit === undefined ? 'none' : await elicit({ message: input.what })) }) };
    const sent = [];
    const handler = createMcpHandler({ tools: [tool], elicitTimeoutMs: 50 });
    await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { elicitation: {} } } });
    const pending = handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'probe', arguments: { what: 'ok?' } } }, (message) => sent.push(message));
    await new Promise((done) => { setImmediate(done); });
    assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 'caw-elicit-1', method: 'elicitation/create', params: { message: 'ok?' } }]);
    assert.equal(await handler({ jsonrpc: '2.0', id: 'caw-elicit-1', result: { action: 'accept', content: { confirm: true } } }), undefined);
    assert.equal((await pending).result.content[0].text, '{"action":"accept","content":{"confirm":true}}');
    // No answer in time: cancelled.
    const silent = await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe', arguments: { what: 'still?' } } }, () => {});
    assert.equal(silent.result.content[0].text, '{"action":"cancel"}');
    const extra = await handler({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'probe', arguments: { what: 'x', target: 'dev' } } });
    assert.equal(extra.result.isError, true);
    assert.equal(extra.result.content[0].text, 'probe does not take target. Its fields: what.');
    // Without the capability the tool gets no elicit.
    const plain = createMcpHandler({ tools: [tool] });
    await plain({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    assert.equal((await plain({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'probe', arguments: {} } })).result.content[0].text, '"none"');
});
