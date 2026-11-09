import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAgentHandler } from '../src/host/agent-commands.mjs';
import { MASK, redact } from '../src/host/secrets.mjs';

test('Geheimnisse: geschwärzt, längste zuerst, zu kurze bleiben', () => {
    assert.equal(redact('textbox "Passwort": geheim123 und geheim1234', ['geheim123', 'geheim1234', 'ab']), `textbox "Passwort": ${MASK} und ${MASK}`);
    assert.equal(redact('ab cd', ['ab']), 'ab cd');
    assert.equal(redact(42, ['geheim']), 42);
});

test('Geheimnisse: Keine Antwort an Claude enthält das Passwort der Rolle oder eines Passwortfelds', async () => {
    const page = {
        ariaSnapshot: async () => '- textbox "Passwort" [ref=e2]:\n  - text: rollenPasswort1',
        evaluate: async (code) => (typeof code === 'function' ? ['tippteNeu99'] : { feld: 'tippteNeu99', liste: ['rollenPasswort1'], zahl: 3 }),
        url: () => 'https://app.example/',
    };
    const session = { page: () => page, secrets: () => ['rollenPasswort1'], failures: () => [] };
    const handle = createAgentHandler({ session, run: { expectations: [] }, hosts: [], agentDir: '.', onVerdict: () => {} });
    assert.doesNotMatch(await handle({ action: 'snapshot' }), /rollenPasswort1/);
    assert.deepEqual(await handle({ action: 'eval', code: 'x' }), { feld: MASK, liste: [MASK], zahl: 3 });
});
