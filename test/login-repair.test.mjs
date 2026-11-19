// Sign-in: fast detection of the outcome instead of the timeout, and Claude's signIn proposal only after a yes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { waitForLoginOutcome } from '../src/host/browser-session.mjs';
import { cleanAuth, offerAuthRepair, parseAnswer, repairPrompt, signInLevel } from '../src/host/login-repair.mjs';

const clock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms) => { time += ms; } };
};
const fakePage = ({ marker = false, form = false, url = 'https://p.example/x' }) => ({
    $: async () => (marker ? {} : null),
    isVisible: async () => form,
    url: () => url,
});

test('Sign-in: outcome after seconds instead of after the timeout', async () => {
    const time = clock();
    assert.equal(await waitForLoginOutcome(fakePage({ marker: true }), { marker: 'm', selectors: { password: '#p' }, ...time }), 'signed-in');
    const rejected = clock();
    assert.equal(await waitForLoginOutcome(fakePage({ form: true }), { marker: 'm', selectors: { password: '#p' }, ...rejected }), 'form');
    assert.ok(rejected.now() <= 4000, `rejected after ${rejected.now()} ms`);
    const wrongMarker = clock();
    assert.equal(await waitForLoginOutcome(fakePage({}), { marker: 'm', selectors: { password: '#p' }, ...wrongMarker }), 'no-marker');
    assert.ok(wrongMarker.now() <= 6000, `wrong marker after ${wrongMarker.now()} ms`);
    // While a request is open, the page does not count as quiet.
    const busy = clock();
    assert.equal(await waitForLoginOutcome(fakePage({ form: true }), { marker: 'm', selectors: { password: '#p' }, ...busy, requests: { open: () => 1 } }), 'timeout');
});

test('Repair: proposal only with known fields, written only after a yes', async (t) => {
    t.mock.method(console, 'log', () => {});
    assert.deepEqual(parseAnswer('Here:\n```json\n{"signIn":{"path":"/"},"why":"x"}\n```'), { signIn: { path: '/' }, why: 'x' });
    assert.equal(parseAnswer('nothing'), null);
    assert.deepEqual(cleanAuth({ type: 'form' }, { type: 'basic', path: '/login', evil: 'x', submitSelector: '' }), { type: 'form', path: '/login' });
    const steps = [{ fill: '#u', with: 'user' }];
    assert.deepEqual(cleanAuth({ type: 'form', steps }, { path: '/in', steps: [] }), { type: 'form', steps, path: '/in' }, 'steps stay as they are');
    const auth = { type: 'form', path: '/', userSelector: '#u', passwordSelector: '#p', submitSelector: '#s_kmvu', signedInSelector: '#menu' };
    assert.match(repairPrompt({ auth, message: 'm', evidence: { hits: {} } }), /signedInSelector must exist/);

    const root = mkdtempSync(join(tmpdir(), 'caw-repair-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const config = { framework: 'web', environments: { dev: { url: 'https://p.example', agent: true } }, signIn: auth, start: '/', roles: { a: {} } };
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(config, null, 4));
    const proposal = async () => JSON.stringify({ signIn: { ...auth, submitSelector: undefined, signedInSelector: 'body.signed-in' }, why: 'stable' });
    const error = { code: 'login-failed', message: 'x', evidence: { hits: {} } };
    assert.equal(await offerAuthRepair({ root, config, target: 'dev', error, claude: proposal, ask: async () => false }), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8')).signIn.signedInSelector, '#menu', 'no changes nothing');
    assert.equal(await offerAuthRepair({ root, config, target: 'dev', error, claude: proposal, ask: async () => true }), true);
    const written = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8')).signIn;
    assert.equal(written.signedInSelector, 'body.signed-in');
    assert.equal(written.submitSelector, undefined);
});

test('Repair: written where the environment\'s sign-in comes from (own, inherited, top level)', async (t) => {
    t.mock.method(console, 'log', () => {});
    const form = { type: 'form', path: '/', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#menu' };
    const config = {
        environments: {
            local: { url: 'http://localhost:5173', agent: true, signIn: { type: 'none' } },
            dev: { url: 'https://dev.p.example', agent: true, signIn: form },
            'dev-b': { extends: 'dev', url: 'https://dev-b.p.example' },
            test: { url: 'https://test.p.example' },
        },
        signIn: { ...form, signedInSelector: '#top' },
        roles: { a: {} },
    };
    assert.deepEqual(signInLevel(config, 'dev'), ['environments', 'dev', 'signIn']);
    assert.deepEqual(signInLevel(config, 'dev-b'), ['environments', 'dev', 'signIn'], 'inherited: fixed for every environment sharing it');
    assert.deepEqual(signInLevel(config, 'test'), ['signIn']);
    const root = mkdtempSync(join(tmpdir(), 'caw-repair-level-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(config, null, 4));
    const proposal = async () => JSON.stringify({ signIn: { ...form, signedInSelector: 'body.signed-in' }, why: 'stable' });
    const error = { code: 'login-failed', message: 'x', evidence: { hits: {} } };
    assert.equal(await offerAuthRepair({ root, config, target: 'dev-b', error, claude: proposal, ask: async () => true }), true);
    const written = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    assert.equal(written.environments.dev.signIn.signedInSelector, 'body.signed-in');
    assert.equal(written.signIn.signedInSelector, '#top', 'the top level stays');
    assert.equal(written.environments['dev-b'].signIn, undefined);
});
