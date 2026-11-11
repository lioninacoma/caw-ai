import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createChat } from '../src/host/chat.mjs';
import { createTokenGate } from '../src/host/token-gate.mjs';

const answering = (id) => {
    const asked = [];
    const chat = createChat({ show: (who, text) => asked.push([who, text]) });
    chat.available = () => true;
    const original = chat.choose;
    chat.choose = (kind, question, options) => {
        const pending = original(kind, question, options);
        setImmediate(() => chat.human.choose(id));
        return pending;
    };
    return { chat, asked };
};

test('Token notice: once per run, cancel blocks, "do not ask again" is remembered', async () => {
    const saved = [];
    const go = answering('go');
    const gate = createTokenGate({ chat: () => go.chat, prefs: () => ({}), save: (value) => saved.push(value) });
    assert.equal(await gate(), true);
    assert.equal(await gate(), true, 'second time without asking');
    assert.equal(go.asked.filter(([who]) => who === 'question').length, 1);
    assert.match(go.asked.find(([who]) => who === 'question')[1], /das kostet Token/);

    const stop = answering('stop');
    const declined = createTokenGate({ chat: () => stop.chat, prefs: () => ({}), save: (value) => saved.push(value) });
    assert.equal(await declined(), false);
    assert.equal(await declined(), false, 'asks again and keeps the answer');
    assert.deepEqual(saved, []);

    const always = answering('always');
    assert.equal(await createTokenGate({ chat: () => always.chat, prefs: () => ({}), save: (value) => saved.push(value) })(), true);
    assert.deepEqual(saved, ['off']);

    // Turned off or without a chat (CI): no question.
    const off = answering('stop');
    assert.equal(await createTokenGate({ chat: () => off.chat, prefs: () => ({ tokenNotice: 'off' }) })(), true);
    assert.equal(off.asked.length, 0);
    assert.equal(await createTokenGate({ chat: () => null, prefs: () => ({}) })(), true);
});

test('Token notice mid-conversation: its own buttons, then the conversation is open again', async () => {
    const states = [];
    const chat = createChat({ status: (state, options) => states.push([state, (options ?? []).map(({ id }) => id).join('|')]) });
    chat.available = () => true;
    const talk = chat.discuss('S2 failed.', [{ id: 'fix', label: 'Fix step' }]);
    chat.human.message('Why?');
    assert.deepEqual(await talk, { message: 'Why?' });
    const again = chat.discuss(undefined, [{ id: 'fix', label: 'Fix step' }]);
    const gate = createTokenGate({ chat: () => chat, prefs: () => ({}), save: () => {} });
    const asked = gate();
    assert.deepEqual(states.at(-1), ['choosing', 'go|always|stop'], 'only the notice buttons');
    chat.human.choose('stop');
    assert.equal(await asked, false);
    assert.deepEqual(states.at(-1), ['discussing', 'fix'], 'conversation open again');
    chat.human.choose('fix');
    assert.deepEqual(await again, { choice: 'fix' });
});

test('Token notice, then the flow reopens the conversation: the notice stays, the conversation follows', async () => {
    const states = [];
    const chat = createChat({ status: (state, options) => states.push([state, (options ?? []).map(({ id }) => id).join('|')]) });
    chat.available = () => true;
    const asked = createTokenGate({ chat: () => chat, prefs: () => ({}), save: () => {} })();
    const talk = chat.discuss(undefined, [{ id: 'fix', label: 'Fix step' }]);
    assert.deepEqual(states.at(-1), ['choosing', 'go|always|stop'], 'notice stays visible');
    chat.human.choose('go');
    assert.equal(await asked, true);
    assert.deepEqual(states.at(-1), ['discussing', 'fix'], 'then the conversation');
    chat.human.message('What now?');
    assert.deepEqual(await talk, { message: 'What now?' });
});
