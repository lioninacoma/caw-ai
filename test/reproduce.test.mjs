// caw reproduce: the command line, the rules where it may run, Claude's verdict, the draft test plan and the report.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { reproduce } from '../src/host/commands.mjs';
import { coverageIn, draftHint, draftId, draftTestPlan, parseReproduceArgs, readReproduction } from '../src/host/reproduce.mjs';
import { BUG_FILE, startArgs } from '../src/host/session-mcp.mjs';
import { parseTest, stepHash, writeTest } from '../src/host/test-file.mjs';
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
            local: { url: 'http://localhost:5173', agent: true, writable: true },
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
    const good = { reproduced: 'yes', observed: 'Nothing.', expected: 'Results.', steps: [{ do: 'Search for "raven".', expect: 'One result.' }], writes: false, screenshots: ['after.png'] };
    assert.deepEqual(readReproduction(good, { fileExists: shot }).steps, [{ name: 'Search for "raven"', do: 'Search for "raven".', expect: 'One result.' }]);
    const reject = (results, pattern) => assert.throws(() => readReproduction(results, { fileExists: shot }), (error) => error.code === 'finish-rejected' && pattern.test(error.message));
    reject({ ...good, reproduced: 'maybe' }, /yes .*no .*unclear/);
    reject({ ...good, observed: '' }, /observed/);
    reject({ ...good, writes: undefined }, /writes is true when your steps create/);
    assert.equal(readReproduction({ ...good, writes: true }, { fileExists: shot }).writes, true);
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

test('draft for caw/drafts: an id free in tests and drafts, the trail of locators in the notes, red not yet', (t) => {
    const root = tempDir(t);
    mkdirSync(join(root, 'caw/drafts'), { recursive: true });
    writeFileSync(join(root, 'caw/drafts/bug-x.yaml'), '');
    assert.equal(draftId(root, 'X'), 'bug-x-2', 'a draft of that name exists already');
    const trail = ["fill getByRole('searchbox', { name: 'Search todos' })", "click getByRole('button', { name: 'Save' })", 'goto /todos'];
    const draft = draftTestPlan({ id: 'bug-search', role: 'tester', environment: 'local', writes: true, runId: 'r1', ref: 'TCK-7', steps: [{ name: 'Search', do: 'Search for "raven".', expect: 'One result.' }], trail });
    const spec = parseTest(draft.text, 'x', { draft: true });
    assert.match(spec.notes, /Referenz TCK-7/);
    assert.match(spec.notes, /der letzte Schritt muss scheitern, solange der Fehler da ist/);
    assert.match(spec.notes, /Was .* getan hat, als Orientierung für die Aufnahme:\n- fill getByRole\('searchbox', \{ name: 'Search todos' \}\)\n- click getByRole\('button', \{ name: 'Save' \}\)\n- goto \/todos$/);
    assert.equal(spec.red, undefined);
    assert.deepEqual(draftHint(draft), { file: 'caw/drafts/bug-search.yaml', record: 'caw record bug-search --env local' });
    // The suspected cause opens the notes, for the agent that records the draft.
    const caused = parseTest(draftTestPlan({ id: 'bug-c', environment: 'local', writes: false, runId: 'r1', cause: 'server.mjs:12 answers\n before saving.', steps: [{ name: 'a', do: 'a', expect: 'b' }] }).text, 'x', { draft: true });
    assert.match(caused.notes, /scheitern, solange der Fehler da ist\.\nVermutete Ursache: server\.mjs:12 answers before saving\.$/);
    const long = draftTestPlan({ id: 'b', environment: 'local', writes: false, runId: 'r1', steps: [{ name: 'a', do: 'a', expect: 'b' }], trail: Array.from({ length: 45 }, (_, index) => `click e${index}`) });
    assert.match(parseTest(long.text, 'x', { draft: true }).notes, /- click e39\n- … und 5 weitere$/);
});

test('report: verdict, bug report, steps, evidence and how to adopt the draft', () => {
    const text = renderReproduceReport({
        status: 'pass', target: 'local', testedCode: 'deployed', failures: [{ type: 'write-blocked', text: 'POST /api/save blocked' }],
        reproduce: { bug: 'Line one.\nLine two.', writable: false, reproduced: 'yes', observed: 'Nothing.', expected: 'One result.', cause: 'search.mjs:12', steps: [{ do: 'Search.', expect: 'One result.' }], actions: ['click e12'], screenshots: ['after.png'], draft: { file: 'caw/drafts/bug-x.yaml', record: 'caw record bug-x' } },
    });
    for (const expected of [/^# Fehler nachstellen auf local: nachgestellt$/m, /Nur lesend/, /^> Line one\.$/m, /^> Line two\.$/m, /Hinweis auf die Ursache: search\.mjs:12/, /^1\. Search\. → One result\.$/m, /click e12/, /agent\/after\.png/, /write-blocked/, /caw record bug-x/, /caw\/drafts\/bug-x\.yaml/]) {
        assert.match(text, expected);
    }
    const covered = { test: 'search', step: 'S2', why: 'S2 checks the hits.', lastRun: { status: 'pass', runId: '2026-11-19T08-00-00-000Z-search', date: '2026-11-19T08:00:00.000Z' }, checkMayMiss: true };
    const withRef = renderReproduceReport({ status: 'pass', target: 'local', testedCode: 'deployed', reproduce: { ref: 'TCK-1234', bug: 'x', writable: false, reproduced: 'yes', observed: 'o', expected: 'e', covered } });
    for (const expected of [/^Referenz: TCK-1234$/m, /^## Schon abgedeckt$/m, /nennt search@S2 als Test, der dieses Verhalten schon abdeckt: S2 checks the hits\./, /Sein neuester Lauf: pass \(Lauf 2026-11-19T08-00-00-000Z-search, 2026-11-19T08:00:00\.000Z\)/, /Prüfung übersieht diesen Fehler vielleicht/]) {
        assert.match(withRef, expected);
    }
    const noRun = renderReproduceReport({ status: 'fail', target: 'local', testedCode: 'deployed', reproduce: { bug: 'x', reproduced: 'no', observed: 'o', expected: 'e', covered: { test: 'search', why: 'w' } } });
    assert.match(noRun, /Kein Lauf davon mehr in \.caw\/runs/);
    assert.doesNotMatch(noRun, /Referenz|übersieht/);
});

test('MCP: caw_start reproduce takes bug, from, env, role and headless; the bug goes through a file', () => {
    assert.deepEqual(startArgs({ command: 'reproduce', bug: '--looks like a flag', from: 'checkout@S3', env: 'local', headless: true }), ['--file', BUG_FILE, '--from', 'checkout@S3', '--env', 'local', '--headless']);
    assert.throws(() => startArgs({ command: 'reproduce' }), /bug/);
    assert.throws(() => startArgs({ command: 'reproduce', bug: 'x', test: 't' }), /test/);
    assert.throws(() => startArgs({ command: 'reproduce', bug: ' ' }), /bug/);
    assert.throws(() => startArgs({ command: 'run', test: 't', bug: 'x' }), /bug/);
});

test('MCP: caw_start run takes promote as a typed switch, only for run', () => {
    assert.deepEqual(startArgs({ command: 'run', test: 'bug-x', promote: true, env: 'local' }), ['bug-x', '--env', 'local', '--promote']);
    assert.deepEqual(startArgs({ command: 'run', test: 'bug-x', promote: false }), ['bug-x']);
    assert.throws(() => startArgs({ command: 'record', test: 'bug-x', promote: true }), /promote gilt nicht für record/);
});

test('ref: an opaque id, checked on the command line and in caw_start, never resolved', () => {
    assert.equal(parseReproduceArgs(['Bug.', '--ref', 'TCK-1234']).ref, 'TCK-1234');
    assert.equal(parseReproduceArgs(['Bug.', '--ref=proj/TCK#12:a.b_c']).ref, 'proj/TCK#12:a.b_c');
    for (const bad of ['TCK 1234', 'x'.repeat(65), 'TCK;rm', 'Ä-1']) {
        assert.throws(() => parseReproduceArgs(['Bug.', `--ref=${bad}`]), (error) => error.code === 'usage' && /keine Referenz/.test(error.message), bad);
    }
    assert.throws(() => parseReproduceArgs(['Bug.', '--ref']), (error) => error.code === 'usage');
    assert.deepEqual(startArgs({ command: 'reproduce', bug: 'x', ref: 'TCK-1' }), ['--file', BUG_FILE, '--ref=TCK-1']);
    assert.throws(() => startArgs({ command: 'reproduce', bug: 'x', ref: 'a b' }), /keine Referenz/);
    assert.throws(() => startArgs({ command: 'run', test: 't', ref: 'TCK-1' }), /ref/);
    const { text } = draftTestPlan({ id: 'bug-x', role: 'tester', environment: 'local', writes: false, runId: 'r1', ref: 'TCK-1234', steps: [{ name: 'Search', do: 'Search.', expect: 'One result.' }] });
    assert.match(parseTest(text).notes, /Lauf r1, Referenz TCK-1234/);
});

test('covered: Claude names a recorded test that already covers the bug; caw adds its newest run', (t) => {
    const good = { reproduced: 'yes', observed: 'Nothing.', expected: 'Results.', steps: [{ do: 'Search.', expect: 'One result.' }], writes: false };
    const lastRun = { status: 'pass', runId: '2026-11-19T08-00-00-000Z-search', date: '2026-11-19T08:00:00.000Z' };
    const asked = [];
    const coverage = (covered) => { asked.push(covered); return lastRun; };
    const read = (covered, extra = {}) => readReproduction({ ...good, covered, ...extra }, { coverage });
    assert.deepEqual(read({ test: 'search', step: 'S2', why: ' S2 checks the hits. ' }).covered, { test: 'search', step: 'S2', why: 'S2 checks the hits.', lastRun, checkMayMiss: true });
    assert.deepEqual(asked, [{ test: 'search', step: 'S2' }]);
    assert.equal(read({ test: 'search', why: 'w' }, { reproduced: 'no' }).covered.checkMayMiss, undefined, 'not reproduced: a passing test fits');
    assert.equal(readReproduction(good, { coverage }).covered, undefined);
    const reject = (covered, pattern) => assert.throws(() => read(covered), (error) => error.code === 'finish-rejected' && pattern.test(error.message));
    reject('search', /covered is \{ test, step\?, why \}/);
    reject({ test: '../x', why: 'w' }, /covered\.test is the id/);
    reject({ test: 'search', step: '2', why: 'w' }, /covered\.step is a step id/);
    reject({ test: 'search' }, /covered\.why/);

    // On disk: the test must exist and be recorded, the step too; the newest run of that test comes along.
    const root = tempDir(t);
    const step = (id, recorded) => {
        const plain = { id, name: `Step ${id}`, do: `Do ${id}.`, expect: `Expect ${id}.` };
        return recorded ? { ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', recordedAt: '2026-11-06T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [], check: `check${id}()` } } : plain;
    };
    writeTest(root, { id: 'search', role: 'tester', writes: false, notes: '', steps: [step('S1', true), step('S2', true), step('S3', false)] });
    const onDisk = coverageIn(root);
    const fails = (covered, pattern) => assert.throws(() => onDisk(covered), (error) => error.code === 'finish-rejected' && pattern.test(error.message));
    fails({ test: 'missing' }, /no test missing in caw\/tests/);
    fails({ test: 'search', step: 'S9' }, /has no step S9; its steps are S1, S2, S3/);
    fails({ test: 'search', step: 'S3' }, /search@S3 is not recorded/);
    fails({ test: 'search' }, /not fully recorded \(S3\)/);
    assert.equal(onDisk({ test: 'search', step: 'S2' }), undefined, 'no run left');
    const runs = join(root, '.caw', 'runs');
    for (const [runId, status] of [['2026-11-18T08-00-00-000Z-search', 'fail'], ['2026-11-19T08-00-00-000Z-search', 'pass'], ['2026-11-20T08-00-00-000Z-search-other', 'fail']]) {
        mkdirSync(join(runs, runId), { recursive: true });
        writeFileSync(join(runs, runId, 'result.json'), JSON.stringify({ status, testId: runId.slice(25) }));
    }
    mkdirSync(join(runs, '2026-11-21T08-00-00-000Z-search'));
    assert.deepEqual(onDisk({ test: 'search', step: 'S2' }), lastRun, 'the newest run with a result, of this test only');
});
