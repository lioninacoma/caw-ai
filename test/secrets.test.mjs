import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAgentHandler, hiddenAnswer, hiddenError, withoutCallLog } from '../src/host/agent-commands.mjs';
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

test('Secrets: errors, URLs and every other answer are masked too; Claude gets errors without the call log', async () => {
    const page = {
        locator: () => ({
            evaluate: async () => false,
            isEnabled: async () => true,
            fill: async (value) => { throw new Error(`locator.fill: Timeout 15000ms exceeded.\nCall log:\n  - fill("${value}")`); },
        }),
        evaluate: async (code) => {
            if (typeof code === 'function') return [];
            if (code === 'throw') throw new Error('page.evaluate: Error: rolePassword1');
            return { name: 'x', value: 'rolePassword1' };
        },
        url: () => 'https://app.example/?leak=rolePassword1',
        goto: async () => {},
        reload: async () => {},
    };
    const session = { page: () => page, secrets: () => ['rolePassword1', 'secretIban42'], failures: () => [] };
    const handle = createAgentHandler({ session, run: { expectations: [] }, hosts: ['app.example'], agentDir: '.', onVerdict: () => {}, expand: (value) => value.replace('{{iban}}', 'secretIban42') });
    assert.equal(await handle({ action: 'url' }), `https://app.example/?leak=${MASK}`);
    assert.equal(await handle({ action: 'goto', url: 'https://app.example/' }), `https://app.example/?leak=${MASK}`);
    assert.equal(await handle({ action: 'reload' }), `https://app.example/?leak=${MASK}`);
    // A thrown page value and a Playwright error quoting the filled value: masked in place, the call log stays for replay.
    await assert.rejects(handle({ action: 'eval', code: 'throw' }), (error) => !error.message.includes('rolePassword1') && error.message.includes(MASK));
    let failed;
    await handle({ action: 'fill', target: '#iban', value: '{{iban}}' }).catch((error) => { failed = error; });
    assert.doesNotMatch(failed.message, /secretIban42/);
    assert.match(failed.message, /Call log:/, 'replay still reads the call log (element is not enabled)');
    // What the channel sends Claude: no call log, masked, the code kept.
    const forClaude = await hiddenError(session, Object.assign(new Error('fill: Timeout\nCall log:\n  - fill("rolePassword1")'), { code: 'x' }));
    assert.deepEqual([forClaude.code, forClaude.message], ['x', 'fill: Timeout']);
    assert.equal(withoutCallLog('a\r\nCall log:\r\n  - b'), 'a');
    assert.deepEqual(await hiddenAnswer(session, { dialog: { message: 'Your password rolePassword1 expires' } }), { dialog: { message: `Your password ${MASK} expires` } });
    // remember names the kind of a wrong value, never the value.
    await assert.rejects(handle({ action: 'remember', name: 'pw', code: 'x' }), (error) => error.code === 'usage' && !error.message.includes('rolePassword1') && /object/.test(error.message));
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
