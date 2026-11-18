// caw reproduce: the command line, the rules where it may run, Claude's verdict, the draft test plan and the report.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { reproduce } from '../src/host/commands.mjs';
import { draftId, draftTestPlan, parseReproduceArgs, readReproduction } from '../src/host/reproduce.mjs';
import { BUG_FILE, startArgs } from '../src/host/session-mcp.mjs';
import { parseTest } from '../src/host/test-file.mjs';
import { renderReproduceReport } from '../src/shared/report.mjs';

const tempDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-reproduce-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const project = (t, roles = { tester: {} }) => {
    const root = tempDir(t);
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify({
        environments: {
            local: { url: 'http://localhost:5173', claude: true, writable: true },
            staging: { url: 'https://staging.example.com' },
            live: { url: 'https://example.com', production: true },
        },
        signIn: { type: 'form', path: '/login', userSelector: '#u', passwordSelector: '#p', signedInSelector: '#me' },
        start: '/',
        roles,
    }));
    return root;
};
const code = async (promise) => {
    try {
        await promise;
    } catch (error) {
        return [error.code, error.message];
    }
    return ['none', ''];
};

test('arguments: the bug as argument, from a file or stdin, once; options checked', (t) => {
    const root = tempDir(t);
    assert.deepEqual(parseReproduceArgs(['Search finds nothing.', '--env', 'local', '--headless']), { headless: true, target: 'local', bug: 'Search finds nothing.' });
    assert.deepEqual(parseReproduceArgs(['--from', 'checkout@S3', 'x']).from, { test: 'checkout', step: 'S3' });
    assert.equal(parseReproduceArgs(['-'], { readStdin: () => 'From stdin\r\n' }).bug, 'From stdin');
    writeFileSync(join(root, 'bug.md'), 'From a file.\n');
    assert.equal(parseReproduceArgs(['--file', 'bug.md'], { root }).bug, 'From a file.');
    assert.throws(() => parseReproduceArgs([]), /Welchen Fehler/);
    assert.throws(() => parseReproduceArgs(['a', 'b']), (error) => error.code === 'usage');
    assert.throws(() => parseReproduceArgs(['a', '--file', 'bug.md'], { root }), /nicht mehrfach/);
    assert.throws(() => parseReproduceArgs(['--file', 'missing.md'], { root }), /gibt es nicht/);
    assert.throws(() => parseReproduceArgs(['a', '--plan']), (error) => error.code === 'usage');
    assert.throws(() => parseReproduceArgs(['a', '--from', 'x', '--role', 'r']), (error) => error.code === 'usage', 'the test brings its role');
    assert.throws(() => parseReproduceArgs(['x'.repeat(9000)]), /länger als 8000/);
    assert.throws(() => parseReproduceArgs(['a\u0007b']), /Steuerzeichen/);
});

test('rules: never on production, only where Claude may work, the role is clear', async (t) => {
    const root = project(t);
    const [live, liveText] = await code(reproduce(root, ['Bug.', '--env', 'live']));
    assert.equal(live, 'reproduce-not-allowed');
    assert.match(liveText, /nie auf Produktion.*Erlaubt: local/);
    assert.equal((await code(reproduce(root, ['Bug.', '--env', 'staging'])))[0], 'reproduce-not-allowed', 'no claude');
    const several = project(t, { tester: {}, clerk: {} });
    const [roles, rolesText] = await code(reproduce(several, ['Bug.', '--env', 'local']));
    assert.equal(roles, 'usage');
    assert.match(rolesText, /tester, clerk/);
    // The role is clear and allowed: the next stop is the missing test user, before Chrome or Claude.
    assert.equal((await code(reproduce(several, ['Bug.', '--env', 'local', '--role', 'clerk'])))[0], 'credentials-missing');
});

test("verdict: Claude's finish is checked before anything is written", () => {
    const shot = (name) => name === 'after.png';
    const good = { reproduced: 'yes', observed: 'Nothing.', expected: 'Results.', steps: [{ do: 'Search for "raven".', expect: 'One result.' }], screenshots: ['after.png'] };
    assert.deepEqual(readReproduction(good, { fileExists: shot }).steps, [{ name: 'Search for "raven"', do: 'Search for "raven".', expect: 'One result.' }]);
    const reject = (results, pattern) => assert.throws(() => readReproduction(results, { fileExists: shot }), (error) => error.code === 'finish-rejected' && pattern.test(error.message));
    reject({ ...good, reproduced: 'maybe' }, /yes .*no .*unclear/);
    reject({ ...good, observed: '' }, /observed/);
    reject({ ...good, steps: [] }, /1 to 20/);
    reject({ ...good, steps: [{ do: 'Sign in as a@example.org.', expect: 'Signed in.' }] }, /email/);
    reject({ ...good, screenshots: ['../x.png'] }, /up to 10/);
    reject({ ...good, screenshots: ['other.png'] }, /No such screenshot/);
});

test('draft: a valid test plan with an id from the bug, never in caw/tests by itself', (t) => {
    const root = tempDir(t);
    assert.equal(draftId(root, 'Die Suche findet nach dem Speichern nichts mehr!\nDetails …'), 'bug-die-suche-findet-nach-dem-speichern');
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw/tests/bug-x.yaml'), '');
    assert.equal(draftId(root, 'X'), 'bug-x-2');
    assert.equal(draftId(root, '!!!'), 'bug-report');
    const { text } = draftTestPlan({ id: 'bug-search', role: 'tester', environment: 'local', writes: false, runId: 'r1', steps: [{ name: 'Search', do: 'Search for "raven".', expect: 'One result.' }] });
    const spec = parseTest(text);
    assert.deepEqual([spec.id, spec.role, spec.writes, spec.environments, spec.steps[0].id, spec.steps[0].expect], ['bug-search', 'tester', false, ['local'], 'S1', 'One result.']);
});

test('report: verdict, bug report, steps, evidence and how to adopt the draft', () => {
    const text = renderReproduceReport({
        status: 'pass', target: 'local', testedCode: 'deployed', failures: [{ type: 'write-blocked', text: 'POST /api/save blocked' }],
        reproduce: { bug: 'Line one.\nLine two.', writable: false, reproduced: 'yes', observed: 'Nothing.', expected: 'One result.', cause: 'search.mjs:12', steps: [{ do: 'Search.', expect: 'One result.' }], actions: ['click e12'], screenshots: ['after.png'], draft: { from: '.caw/runs/r1/draft-test.yaml', to: 'caw/tests/bug-x.yaml', record: 'caw record bug-x' } },
    });
    for (const expected of [/^# Fehler nachstellen auf local: nachgestellt$/m, /Nur lesend/, /^> Line one\.$/m, /^> Line two\.$/m, /Hinweis auf die Ursache: search\.mjs:12/, /^1\. Search\. → One result\.$/m, /click e12/, /agent\/after\.png/, /write-blocked/, /caw record bug-x/]) {
        assert.match(text, expected);
    }
});

test('MCP: caw_start reproduce takes bug, from, env, role and headless; the bug goes through a file', () => {
    assert.deepEqual(startArgs({ command: 'reproduce', bug: '--looks like a flag', from: 'checkout@S3', env: 'local', headless: true }), ['--file', BUG_FILE, '--from', 'checkout@S3', '--env', 'local', '--headless']);
    assert.throws(() => startArgs({ command: 'reproduce' }), /bug/);
    assert.throws(() => startArgs({ command: 'reproduce', bug: 'x', test: 't' }), /test/);
    assert.throws(() => startArgs({ command: 'reproduce', bug: ' ' }), /bug/);
    assert.throws(() => startArgs({ command: 'run', test: 't', bug: 'x' }), /bug/);
});
