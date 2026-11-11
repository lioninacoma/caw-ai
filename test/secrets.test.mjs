import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAgentHandler } from '../src/host/agent-commands.mjs';
import { MASK, redact } from '../src/host/secrets.mjs';

test('Secrets: redacted, longest first, too short ones stay', () => {
    assert.equal(redact('textbox "Password": secret123 and secret1234', ['secret123', 'secret1234', 'ab']), `textbox "Password": ${MASK} and ${MASK}`);
    assert.equal(redact('ab cd', ['ab']), 'ab cd');
    assert.equal(redact(42, ['secret']), 42);
});

test('Secrets: no answer to Claude contains the role password or the value of a password field', async () => {
    const page = {
        ariaSnapshot: async () => '- textbox "Password" [ref=e2]:\n  - text: rolePassword1',
        evaluate: async (code) => (typeof code === 'function' ? ['typedNew99'] : { field: 'typedNew99', list: ['rolePassword1'], number: 3 }),
        url: () => 'https://app.example/',
    };
    const session = { page: () => page, secrets: () => ['rolePassword1'], failures: () => [] };
    const handle = createAgentHandler({ session, run: { expectations: [] }, hosts: [], agentDir: '.', onVerdict: () => {} });
    assert.doesNotMatch(await handle({ action: 'snapshot' }), /rolePassword1/);
    assert.deepEqual(await handle({ action: 'eval', code: 'x' }), { field: MASK, list: [MASK], number: 3 });
});
