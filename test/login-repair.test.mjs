// Anmeldung: schnelles Erkennen des Ergebnisses statt Zeitgrenze, und Claudes Vorschlag fuer auth nur nach Ja.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { waitForLoginOutcome } from '../src/host/browser-session.mjs';
import { cleanAuth, offerAuthRepair, parseAnswer, repairPrompt } from '../src/host/login-repair.mjs';

const clock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms) => { time += ms; } };
};
const fakePage = ({ marker = false, form = false, url = 'https://p.example/x' }) => ({
    $: async () => (marker ? {} : null),
    isVisible: async () => form,
    url: () => url,
});

test('Anmeldung: Ergebnis nach Sekunden statt nach der Zeitgrenze', async () => {
    const time = clock();
    assert.equal(await waitForLoginOutcome(fakePage({ marker: true }), { marker: 'm', selectors: { password: '#p' }, ...time }), 'signed-in');
    const rejected = clock();
    assert.equal(await waitForLoginOutcome(fakePage({ form: true }), { marker: 'm', selectors: { password: '#p' }, ...rejected }), 'form');
    assert.ok(rejected.now() <= 4000, `abgelehnt nach ${rejected.now()} ms`);
    const wrongMarker = clock();
    assert.equal(await waitForLoginOutcome(fakePage({}), { marker: 'm', selectors: { password: '#p' }, ...wrongMarker }), 'no-marker');
    assert.ok(wrongMarker.now() <= 6000, `Marke falsch nach ${wrongMarker.now()} ms`);
    // Solange ein Request offen ist, gilt die Seite nicht als ruhig.
    const busy = clock();
    assert.equal(await waitForLoginOutcome(fakePage({ form: true }), { marker: 'm', selectors: { password: '#p' }, ...busy, requests: { open: () => 1 } }), 'timeout');
});

test('Reparatur: Vorschlag nur mit bekannten Feldern, geschrieben erst nach Ja', async (t) => {
    t.mock.method(console, 'log', () => {});
    assert.deepEqual(parseAnswer('Hier:\n```json\n{"auth":{"path":"/"},"why":"x"}\n```'), { auth: { path: '/' }, why: 'x' });
    assert.equal(parseAnswer('nichts'), null);
    assert.deepEqual(cleanAuth({ type: 'form' }, { type: 'basic', path: '/login', evil: 'x', submitSelector: '' }), { type: 'form', path: '/login' });
    const auth = { type: 'form', path: '/', userSelector: '#u', passwordSelector: '#p', submitSelector: '#s_kmvu', signedInSelector: '#menu' };
    assert.match(repairPrompt({ auth, message: 'm', evidence: { hits: {} } }), /signedInSelector must exist/);

    const root = mkdtempSync(join(tmpdir(), 'caw-repair-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const config = { framework: 'web', environments: { dev: { url: 'https://p.example', claude: true } }, auth, apps: { web: { dir: '.', startUrl: '/' } }, roles: { a: { loginEnv: 'L', passwordEnv: 'P' } } };
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(config, null, 4));
    const proposal = async () => JSON.stringify({ auth: { ...auth, submitSelector: undefined, signedInSelector: 'body.signed-in' }, why: 'stabil' });
    const error = { code: 'login-failed', message: 'x', evidence: { hits: {} } };
    assert.equal(await offerAuthRepair({ root, config, error, claude: proposal, ask: async () => false }), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8')).auth.signedInSelector, '#menu', 'Nein ändert nichts');
    assert.equal(await offerAuthRepair({ root, config, error, claude: proposal, ask: async () => true }), true);
    const written = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8')).auth;
    assert.equal(written.signedInSelector, 'body.signed-in');
    assert.equal(written.submitSelector, undefined);
});
