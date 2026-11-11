import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAgentHandler } from '../src/host/agent-commands.mjs';
import { MASK, SECRET_GLOBS, isSecretPath, redact } from '../src/host/secrets.mjs';

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

test('Secret files: one list for masks, read denials and advice, case-insensitive, at any depth', () => {
    const secret = ['.env', '.ENV.local', 'app/prod.env', '.envrc', '.npmrc', 'a/.yarnrc.yml', '.pypirc', '.netrc', 'credentials.json', 'k/server.PEM',
        'k/server.key', 'k/s.p12', 'k/s.pfx', 'k/s.jks', 'id_rsa', 'id_ed25519.pub', '.aws/credentials', 'home/.ssh/known_hosts', '.docker/config.json'];
    for (const path of secret) assert.equal(isSecretPath(path), true, path);
    for (const path of ['.env.example', 'src/env.js', 'config.json', 'docker/config.json', 'src/keys.js', 'aws/x.js']) assert.equal(isSecretPath(path), false, path);
    for (const glob of ['**/.envrc', '**/*.env', '**/credentials.json', '**/.aws/**', '**/.ssh/**', '**/*.jks', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/.netrc', '**/.pypirc', '**/.yarnrc*', '**/.docker/config.json']) {
        assert.ok(SECRET_GLOBS.includes(glob), glob);
    }
});
