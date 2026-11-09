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

test('Token-Hinweis: einmal je Lauf, Abbrechen sperrt, „Nicht mehr fragen“ merkt es sich', async () => {
    const saved = [];
    const go = answering('go');
    const gate = createTokenGate({ chat: () => go.chat, prefs: () => ({}), save: (value) => saved.push(value) });
    assert.equal(await gate(), true);
    assert.equal(await gate(), true, 'zweites Mal ohne Frage');
    assert.equal(go.asked.filter(([who]) => who === 'question').length, 1);
    assert.match(go.asked.find(([who]) => who === 'question')[1], /das kostet Token/);

    const stop = answering('stop');
    const declined = createTokenGate({ chat: () => stop.chat, prefs: () => ({}), save: (value) => saved.push(value) });
    assert.equal(await declined(), false);
    assert.equal(await declined(), false, 'fragt erneut und bleibt bei der Antwort');
    assert.deepEqual(saved, []);

    const always = answering('always');
    assert.equal(await createTokenGate({ chat: () => always.chat, prefs: () => ({}), save: (value) => saved.push(value) })(), true);
    assert.deepEqual(saved, ['off']);

    // Abgestellt oder ohne Chat (CI): keine Frage.
    const off = answering('stop');
    assert.equal(await createTokenGate({ chat: () => off.chat, prefs: () => ({ tokenNotice: 'off' }) })(), true);
    assert.equal(off.asked.length, 0);
    assert.equal(await createTokenGate({ chat: () => null, prefs: () => ({}) })(), true);
});

test('Token-Hinweis mitten im Gespräch: eigene Knöpfe, danach steht das Gespräch wieder offen', async () => {
    const states = [];
    const chat = createChat({ status: (state, options) => states.push([state, (options ?? []).map(({ id }) => id).join('|')]) });
    chat.available = () => true;
    const talk = chat.discuss('S2 ist gescheitert.', [{ id: 'fix', label: 'Schritt beheben' }]);
    chat.human.message('Warum?');
    assert.deepEqual(await talk, { message: 'Warum?' });
    const again = chat.discuss(undefined, [{ id: 'fix', label: 'Schritt beheben' }]);
    const gate = createTokenGate({ chat: () => chat, prefs: () => ({}), save: () => {} });
    const asked = gate();
    assert.deepEqual(states.at(-1), ['choosing', 'go|always|stop'], 'nur die Knöpfe des Hinweises');
    chat.human.choose('stop');
    assert.equal(await asked, false);
    assert.deepEqual(states.at(-1), ['discussing', 'fix'], 'Gespräch wieder offen');
    chat.human.choose('fix');
    assert.deepEqual(await again, { choice: 'fix' });
});

test('Token-Hinweis, danach öffnet der Ablauf das Gespräch neu: der Hinweis bleibt, das Gespräch folgt', async () => {
    const states = [];
    const chat = createChat({ status: (state, options) => states.push([state, (options ?? []).map(({ id }) => id).join('|')]) });
    chat.available = () => true;
    const asked = createTokenGate({ chat: () => chat, prefs: () => ({}), save: () => {} })();
    const talk = chat.discuss(undefined, [{ id: 'fix', label: 'Schritt beheben' }]);
    assert.deepEqual(states.at(-1), ['choosing', 'go|always|stop'], 'Hinweis bleibt sichtbar');
    chat.human.choose('go');
    assert.equal(await asked, true);
    assert.deepEqual(states.at(-1), ['discussing', 'fix'], 'danach das Gespräch');
    chat.human.message('Und jetzt?');
    assert.deepEqual(await talk, { message: 'Und jetzt?' });
});
