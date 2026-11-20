// Terminal usage: list, target choice, help per command, messages with suggestions, exit codes, several tests, JUnit.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { changeTracker, chooseEnv, init, junitXml, list, open, record, reportJson, run, runMode, stepsText, summaryMarkdown, validate } from '../src/host/commands.mjs';
import { parseRunArgs } from '../src/host/linux.mjs';
import { loadTest, stepHash, writeTest } from '../src/host/test-file.mjs';
import { EXIT, exitOf, worstExit } from '../src/shared/errors.mjs';
import { helpText, synopsisOf, unknownCommandText } from '../src/shared/help.mjs';
import { closest, editDistance } from '../src/shared/suggest.mjs';
import { createUi } from '../src/shared/ui.mjs';

const BIN = fileURLToPath(new URL('../bin/caw.mjs', import.meta.url));
const step = (id, name) => ({ id, name, do: `${name} tun`, expect: `${name} sichtbar` });
const recorded = (plain) => ({ ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', recordedAt: '2026-11-06T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [], check: 'true' } });

/** A project as after init (local with Claude, staging without), with three tests in different states. */
const project = (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-ux-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    init(root);
    // init writes only local; staging is a second, writable environment without Claude.
    const configFile = join(root, 'caw.config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.environments.staging = { url: 'https://staging.shop.intern', writable: true };
    writeFileSync(configFile, JSON.stringify(config, null, 4));
    mkdirSync(join(root, 'caw', 'tests'), { recursive: true });
    const base = { role: 'tester', source: 'deployed', notes: '', knownMessages: undefined };
    writeTest(root, { ...base, id: 'anmelden', environments: ['local'], writes: false, steps: [recorded(step('S1', 'Maske')), recorded(step('S2', 'Start'))] });
    writeTest(root, { ...base, id: 'bestellen', environments: ['local', 'staging'], writes: true, steps: [recorded(step('S1', 'Liste')), { ...recorded(step('S2', 'Neu')), name: 'geaendert' }, step('S3', 'Ende')] });
    writeTest(root, { ...base, id: 'neu', environments: ['local'], writes: true, steps: [step('S1', 'Eins')] });
    return root;
};

test('editDistance and closest: typos find their command, a tie gives no suggestion', () => {
    assert.equal(editDistance('lsit', 'list'), 1);
    assert.equal(editDistance('create-tiket', 'create-ticket'), 1);
    assert.equal(closest('lsit', ['list', 'init', 'run']), 'list');
    assert.equal(closest('S7', ['S1', 'S2', 'S3']), undefined);
    assert.equal(closest('xyz', ['list', 'run']), undefined);
});

test('exit codes: needs recording is 4, the worst run decides the batch', () => {
    assert.equal(exitOf('replay-missing'), EXIT.needsRecording);
    assert.equal(exitOf('replay-stale'), 4);
    assert.equal(exitOf('usage'), EXIT.rejected);
    assert.equal(exitOf('chrome-weg'), EXIT.error);
    assert.equal(worstExit([]), 0);
    assert.equal(worstExit([0, 3, 4]), 4);
    assert.equal(worstExit([4, 1, 3]), 1);
    assert.equal(worstExit([1, 2, 0]), 2);
    assert.equal(worstExit([0, 3]), 3);
});

test('parseRunArgs: an option without a value does not swallow the next one', () => {
    assert.throws(() => parseRunArgs('run', ['t', '--env', '--headless']), /--env braucht einen Wert, etwa --env local/);
    assert.throws(() => parseRunArgs('open', ['t', '--step-timeout']), /--step-timeout braucht einen Wert, etwa --step-timeout 30s/);
    assert.throws(() => parseRunArgs('run', ['t', '--env=']), /--env braucht einen Wert/);
    assert.throws(() => parseRunArgs('record', ['t', '--role', '--app', 'web']), /--role braucht einen Wert/);
    assert.throws(() => parseRunArgs('record', ['t@S2', '--agent']), /--agent braucht einen Wert/);
    assert.throws(() => parseRunArgs('open', ['t@S1', '--agent-timeout', '--x']), /--agent-timeout braucht einen Wert, etwa --agent-timeout 60m/);
});

test('parseRunArgs: several tests or --all run without chat, --explain only for one test', () => {
    const many = parseRunArgs('run', ['a', 'b', '--env', 'local']);
    assert.deepEqual([many.tests, many.batch, many.noChat], [['a', 'b'], true, true]);
    const all = parseRunArgs('run', ['--all', '--headless', '--report', 'junit=out/x.xml']);
    assert.deepEqual([all.all, all.batch, all.reports, all.test], [true, true, { junit: 'out/x.xml' }, undefined]);
    assert.throws(() => parseRunArgs('run', ['--all', 'a']), /--all/);
    assert.throws(() => parseRunArgs('run', ['a', 'b', '--zzz', 'S2']), /run kennt die Option --zzz nicht/);
    assert.throws(() => parseRunArgs('run', ['--all', '--explain']), /--explain gilt nur/);
    assert.throws(() => parseRunArgs('run', ['a', '--report', 'xml']), /<art>=<datei> mit junit, summary oder json/);
    assert.equal(parseRunArgs('run', ['a']).learn, false, 'a run learns nothing unless asked (Q7)');
    assert.equal(parseRunArgs('run', ['a', '--learn']).learn, true);
    assert.equal(parseRunArgs('run', ['a', 'b', '--learn', '--headless']).learn, true, '--learn in every mode (SC-21)');
    assert.throws(() => parseRunArgs('run', ['a', '--no-learn']), (error) => error.code === 'usage' && /--no-learn gibt es nicht mehr: jeder Lauf außerhalb von CI lernt fehlende Vergleichswerte und Effekte; in CI tut das --learn/.test(error.message));
    assert.equal(parseRunArgs('run', ['a']).batch, undefined);
});

test('chooseEnv: the only candidate, for run outside CI the only one with Claude, otherwise the choices; logged', () => {
    const config = { environments: { local: { url: 'http://localhost:1', agent: true, writable: true }, dev: { url: 'https://dev.example', agent: true, writable: true }, staging: { url: 'https://s.example' } } };
    const said = [];
    const log = (text) => said.push(text);
    assert.equal(chooseEnv(config, [{ id: 'x', environments: ['dev'] }], { command: 'run', log }), 'dev');
    assert.match(said.at(-1), /Umgebung: dev \(einzige Umgebung von x\)/);
    assert.equal(chooseEnv(config, [{ id: 'x', environments: ['dev'] }], { env: 'local', command: 'run', log }), 'local', 'a given environment wins');
    // Two candidates, one of them with Claude: the developer's own outside CI; in CI nobody guesses.
    assert.equal(chooseEnv(config, [{ id: 'x', environments: ['local', 'staging'] }], { command: 'run', ci: false, log }), 'local');
    assert.match(said.at(-1), /die einzige, auf der Claude Code arbeiten darf/);
    assert.throws(() => chooseEnv(config, [{ id: 'x', environments: ['local', 'staging'] }], { command: 'run', ci: true, log }), /--env fehlt: local, staging/);
    assert.equal(chooseEnv(config, [{ id: 'x', environments: ['local', 'staging'] }], { command: 'record', log }), 'local', 'record: only where Claude Code may work');
    assert.throws(() => chooseEnv(config, [], { command: 'record', log }), /--env fehlt: local, dev/);
    const one = { environments: { local: config.environments.local, staging: config.environments.staging } };
    assert.equal(chooseEnv(one, [], { command: 'record', log }), 'local');
    assert.match(said.at(-1), /einzige Umgebung, auf der Claude Code arbeiten darf/);
    // Several tests: the union of their environments.
    assert.equal(chooseEnv(config, [{ id: 'a', environments: ['dev'] }, { id: 'b', environments: ['dev'] }], { command: 'run', ci: true, log }), 'dev');
    assert.match(said.at(-1), /einzige Umgebung der Tests/);
});

test('list: per test environments, recording state and writes; with a test one line per step', (t) => {
    const root = project(t);
    const lines = [];
    const out = (text) => lines.push(text);
    assert.equal(list(root, [], { out }), EXIT.pass);
    assert.match(lines[0], /^Test\s+Umgebungen\s+Aufnahme\s+Daten$/);
    assert.match(lines.find((line) => line.startsWith('anmelden')), /local\s+aufgenommen\s+liest nur/);
    assert.match(lines.find((line) => line.startsWith('bestellen')), /local, staging\s+veraltet \(S2, S3\)\s+schreibt/);
    assert.match(lines.find((line) => line.startsWith('neu')), /nicht aufgenommen/);
    lines.length = 0;
    list(root, ['bestellen'], { out });
    assert.match(lines[0], /bestellen: Start \/, Rolle tester, Umgebungen local, staging, schreibt/);
    assert.match(lines[1], /^\s+S1\s+Liste\s+\(aufgenommen\)$/);
    assert.match(lines[2], /^\s+S2\s+geaendert\s+\(veraltet\)$/);
    assert.match(lines[3], /^\s+S3\s+Ende\s+\(nicht aufgenommen\)$/);
    // A typo gets the closest name; recording under the typo is only offered as a new test.
    assert.throws(() => list(root, ['bestelen'], { out }), (error) => error.code === 'test-missing'
        && /Meintest du bestellen\? Bekannte Tests: anmelden, bestellen, neu\. Einen neuen Test unter diesem Namen nimmt auf: caw record bestelen/.test(error.message));
    assert.throws(() => list(root, ['zzzzzz'], { out }), (error) => /Neu aufnehmen: caw record zzzzzz/.test(error.message) && !/Meintest/.test(error.message));
    assert.throws(() => list(root, ['a', 'b'], { out }), /Unerwartetes Argument: b/);
});

test('list without caw.config.json reports the missing config like every other command', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-ux-empty-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.throws(() => list(root, [], { out: () => {} }), (error) => error.code === 'config-missing' && exitOf(error.code) === 3);
});

test('validate: all problems of a test at once, YAML positions only once', (t) => {
    const root = project(t);
    writeFileSync(join(root, 'caw', 'tests', 'kaputt.yaml'), 'role: geist\nenvironments: [qa]\nwrites: false\nsteps:\n  - id: S1\n    name: Eins\n    do: a\n    expect: b\n');
    t.mock.method(process.stdout, 'write', () => true);
    assert.throws(() => validate(root), (error) => {
        assert.equal(error.code, 'test-invalid');
        assert.match(error.message, /kaputt\.yaml: Unbekannte Rolle: geist/);
        assert.match(error.message, /kaputt\.yaml: environments: Umgebung "qa" gibt es nicht\. Bekannt: local, staging/);
        return true;
    });
    writeFileSync(join(root, 'caw', 'tests', 'kaputt.yaml'), 'writes: false\nsteps:\n  - id: S1\n    do: a: b\n');
    assert.throws(() => validate(root), (error) => {
        assert.match(error.message, /Zeile 4: Nested mappings are not allowed in compact mappings(\n|$)/);
        assert.doesNotMatch(error.message, /at line|:\n|:$/);
        return true;
    });
});

/** Runs fn with CI set: there nobody picks the developer's own environment. */
const inCi = async (fn) => {
    const before = process.env.CI;
    process.env.CI = '1';
    try {
        return await fn();
    } finally {
        if (before === undefined) delete process.env.CI;
        else process.env.CI = before;
    }
};

test('run: without --env the only environment, typos get a suggestion and the choices', async (t) => {
    const root = project(t);
    await assert.rejects(run(root, ['anmeldn']), (error) => error.code === 'test-missing' && /Meintest du anmelden\?/.test(error.message) && /caw record anmeldn$/.test(error.message));
    await inCi(() => assert.rejects(run(root, ['bestellen']), (error) => error.code === 'usage' && /--env fehlt: local, staging/.test(error.message)));
    await assert.rejects(open(root, ['anmelden@S9'], { interactive: true }), (error) => error.code === 'step-unknown' && /Schritte: S1, S2\./.test(error.message));
    // A missing recording is exit 4 (needs recording), not 3.
    await assert.rejects(run(root, ['neu']), (error) => error.code === 'replay-missing' && exitOf(error.code) === 4);
});

test('open and record with a step: a stale step before it names record <test>@<step>, CI has nobody for the window', async (t) => {
    // A person at the machine: record refuses in CI before anything else, so CI is unset here (GitHub Actions sets it).
    const ci = process.env.CI;
    delete process.env.CI;
    t.after(() => {
        if (ci !== undefined) process.env.CI = ci;
    });
    const root = project(t);
    // bestellen: S2 changed by hand since recording. Up to the entry of S3, S2 must replay: re-record from S2.
    await assert.rejects(open(root, ['bestellen@S3', '--env', 'local'], { interactive: true }), (error) => error.code === 'replay-stale' && /S2 .*Neu aufnehmen ab dort: caw record bestellen@S2 --env local/.test(error.message));
    await assert.rejects(record(root, ['bestellen@S3', '--env', 'local'], { interactive: true }), (error) => error.code === 'replay-stale' && /caw record bestellen@S2 --env local/.test(error.message));
    await assert.rejects(record(root, ['bestellen@S7', '--env', 'local'], { interactive: true }), (error) => error.code === 'step-unknown' && /bestellen hat keinen Schritt S7\..*caw\/tests\/bestellen\.yaml/.test(error.message));
    await assert.rejects(record(root, ['gibtsnicht@S2']), (error) => error.code === 'test-missing' && !/\{\w+\}/.test(error.message));
    // Nobody in CI takes the window or steers the recording.
    await assert.rejects(open(root, ['anmelden'], { interactive: false }), (error) => error.code === 'usage' && /caw open braucht einen Menschen/.test(error.message));
    await assert.rejects(record(root, ['bestellen@S2', '--env', 'local'], { interactive: false }), (error) => error.code === 'usage' && /caw record braucht einen Menschen/.test(error.message));
    // The entry of the first step needs no step before it, a full open the whole test.
    await assert.rejects(open(root, ['bestellen', '--env', 'local'], { interactive: true }), (error) => error.code === 'replay-stale' && /record bestellen@S2/.test(error.message));
});

test('run with several tests: each runs, the table shows the outcome, the exit is the worst, JUnit on request', async (t) => {
    const root = project(t);
    const said = [];
    t.mock.method(console, 'log', (text) => said.push(text));
    // neu is not recorded (4), gibtsnicht is missing (3), bestellen is stale (4): no browser starts.
    const code = await run(root, ['neu', 'gibtsnicht', 'bestellen', '--env', 'local', '--report', 'junit=out/junit.xml']);
    assert.equal(code, EXIT.needsRecording);
    const text = said.join('\n');
    assert.match(text, /Ergebnis: 3 Tests auf local/);
    assert.match(text, /AUFNAHME NÖTIG\s+neu/);
    assert.match(text, /ABGELEHNT\s+gibtsnicht/);
    assert.match(text, /JUnit-Bericht: out\/junit\.xml/);
    assert.match(readFileSync(join(root, 'out', 'junit.xml'), 'utf8'), /<testsuite/);
    // The report stays in the project (a session passes --report through caw_start): refused before any test runs.
    said.length = 0;
    for (const file of ['../junit.xml', join(tmpdir(), 'caw-junit-outside.xml')]) {
        await assert.rejects(run(root, ['neu', '--env', 'local', '--report', `junit=${file}`]), (error) => error.code === 'usage' && /muss eine Datei im Projekt nennen/.test(error.message), file);
    }
    assert.doesNotMatch(said.join('\n'), /Ergebnis/, 'no test ran');
    assert.equal(existsSync(join(root, '..', 'junit.xml')), false);
    // --all only takes tests with the environment; in CI without --env the tests' only environment is needed, but there are two here.
    await inCi(() => assert.rejects(run(root, ['--all']), /--env fehlt: local, staging/));
    said.length = 0;
    // Only bestellen runs on staging; its recording is stale there as anywhere.
    assert.equal(await run(root, ['--all', '--env', 'staging']), EXIT.needsRecording);
    assert.match(said.join('\n'), /Ergebnis: 1 Test auf staging/);
});

test('junitXml: a failure typed by its assessment with the findings, errors typed by their code, text safely escaped', () => {
    const xml = junitXml({ target: 'local', rows: [
        { test: 'a', exit: 0, seconds: 1 },
        { test: 'b', exit: 1, seconds: 2, note: 'bei S2', step: 'S2', reason: 'Liste <x> & "y" fehlt\nzweite Zeile', side: 'app', strength: 'clear', assessment: 'Einschätzung: Anwendungsfehler (eindeutig).', findings: ['POST /api/orders antwortete 500'], report: '.caw/runs/r1/report.md' },
        { test: 'c', exit: 4, seconds: 0, note: 'no recording', code: 'replay-missing' },
        { test: 'd', exit: 1, seconds: 0, note: 'bei S1' },
        { test: 'e', exit: 2, seconds: 0, note: 'kaputt' },
    ] });
    assert.match(xml, /<testsuite name="caw local" tests="5" failures="2" errors="2"/);
    assert.match(xml, /<testcase classname="caw\.local" name="a" time="1.000"\/>/);
    assert.match(xml, /<failure type="app" message="S2: Liste &lt;x&gt; &amp; &quot;y&quot; fehlt">Einschätzung: Anwendungsfehler \(eindeutig\)\.\nPOST \/api\/orders antwortete 500\n\.caw\/runs\/r1\/report\.md<\/failure>/);
    assert.match(xml, /<error type="replay-missing" message="no recording"\/>/);
    assert.match(xml, /<failure type="unclear" message="bei S1"\/>/, 'no assessment: unclear');
    assert.match(xml, /<error type="error" message="kaputt"\/>/, 'no code: named by the exit');
});

/** Rows as runBatch builds them: a pass on the second attempt after an environment error, and an app failure. */
const batchRows = () => [
    { test: 'a', exit: 0, seconds: 3, note: 'bestanden im 2. Versuch (Umgebung)', retried: 'bestanden im 2. Versuch (Umgebung)', steps: [{ id: 'S1', status: 'pass', seconds: 1.2 }], report: '.caw/runs/r2/report.md',
        attempts: [{ exit: 2, seconds: 1, code: 'browser-closed', note: 'weg', report: '.caw/runs/r1/report.md' }, { exit: 0, seconds: 2, note: '', report: '.caw/runs/r2/report.md' }] },
    { test: 'b|c', exit: 1, seconds: 2, note: 'bei S3', step: 'S3', reason: 'Dialog | fehlt\nmehr', side: 'environment', strength: 'likely', assessment: 'x', findings: ['GET /api 503', 'zweiter'], steps: [{ id: 'S3', status: 'fail' }], report: '.caw/runs/r3/report.md',
        attempts: [{ exit: 1, seconds: 2, step: 'S3', side: 'environment', strength: 'likely' }] },
];

test('junitXml: a retried test lists every attempt in system-out', () => {
    const xml = junitXml({ target: 'dev', rows: batchRows() });
    assert.match(xml, /name="a" time="3.000">\n {6}<system-out>bestanden im 2\. Versuch \(Umgebung\)\nVersuch 1: ERROR, browser-closed, \.caw\/runs\/r1\/report\.md\nVersuch 2: PASS, \.caw\/runs\/r2\/report\.md<\/system-out>\n {4}<\/testcase>/);
    assert.match(xml, /<failure type="environment" message="S3: Dialog \| fehlt">/);
});

test('summaryMarkdown: one line per test with result, failed step, assessment, first finding and report', () => {
    const text = summaryMarkdown({ target: 'dev', exit: 1, rows: batchRows() });
    const lines = text.split('\n');
    assert.equal(lines[0], '### caw: 2 Test(s) auf dev, Exit 1');
    assert.equal(lines[2], '| Ergebnis | Test | Gescheiterter Schritt | Einschätzung | Befund | Bericht |');
    assert.equal(lines[4], '| PASS · bestanden im 2. Versuch (Umgebung) | a |  |  |  | `.caw/runs/r2/report.md` |');
    assert.equal(lines[5], '| FAIL | b\\|c | S3: Dialog \\| fehlt | Problem der Umgebung (wahrscheinlich) | GET /api 503 | `.caw/runs/r3/report.md` |');
});

test('reportJson: target, start, exit and per test outcome, assessment, steps, report and attempts', () => {
    const json = JSON.parse(reportJson({ target: 'dev', startedAt: '2026-11-20T10:00:00.000Z', exit: 1, rows: batchRows() }));
    assert.deepEqual([json.target, json.startedAt, json.exit], ['dev', '2026-11-20T10:00:00.000Z', 1]);
    assert.deepEqual(json.tests[0], {
        id: 'a', status: 'pass', exit: 0, seconds: 3, steps: [{ id: 'S1', status: 'pass', seconds: 1.2 }], report: '.caw/runs/r2/report.md',
        attempts: [{ status: 'error', exit: 2, code: 'browser-closed', seconds: 1, report: '.caw/runs/r1/report.md' }, { status: 'pass', exit: 0, seconds: 2, report: '.caw/runs/r2/report.md' }],
    });
    assert.deepEqual([json.tests[1].failedStep, json.tests[1].reason, json.tests[1].side, json.tests[1].strength, json.tests[1].findings], ['S3', 'Dialog | fehlt\nmehr', 'environment', 'likely', ['GET /api 503', 'zweiter']]);
});

test('run --retry-env: only environment failures run again, at most n times, the last attempt counts; all reports written', async (t) => {
    const root = project(t);
    const said = [];
    t.mock.method(console, 'log', (text) => said.push(text));
    // Per test the outcomes of its attempts in order.
    const script = {
        anmelden: [{ code: 2, verdict: { status: 'error', code: 'browser-closed', reason: 'Fenster zu' }, report: '.caw/runs/r1/report.md' }, { code: 0, verdict: { status: 'pass', steps: [{ id: 'S1', status: 'pass', seconds: 1 }] }, report: '.caw/runs/r2/report.md' }],
        bestellen: [{ code: 1, failed: { id: 'S2', reason: 'Knopf fehlt', diagnosis: { side: 'app', strength: 'clear', text: 'Einschätzung: Anwendungsfehler (eindeutig).', findings: ['POST /api 500'] } }, verdict: { status: 'fail', steps: [] }, report: '.caw/runs/r3/report.md' }],
        neu: Array.from({ length: 3 }, () => ({ code: 1, failed: { id: 'S1', reason: 'langsam', diagnosis: { side: 'environment', strength: 'likely', text: 'x', findings: ['GET /api 503'] } }, verdict: { status: 'fail', steps: [] } })),
    };
    const calls = [];
    const runOne = async (_root, { test: id }) => {
        calls.push(id);
        return script[id].shift();
    };
    const reports = ['--report', 'junit=out/junit.xml', '--report', 'summary=out/summary.md', '--report', 'json=out/caw.json'];
    const code = await run(root, ['anmelden', 'bestellen', 'neu', '--env', 'local', '--retry-env', '2', ...reports], { runOne });
    assert.equal(code, EXIT.fail);
    // anmelden: error then pass; bestellen: an app failure is not retried; neu: the environment failure three times (1 + 2).
    assert.deepEqual(calls, ['anmelden', 'anmelden', 'bestellen', 'neu', 'neu', 'neu']);
    const text = said.join('\n');
    assert.match(text, /anmelden: Versuch 1 scheiterte an der Umgebung, er läuft noch einmal\./);
    assert.match(text, /PASS\s+anmelden.*bestanden im 2\. Versuch \(Umgebung\)/);
    assert.match(text, /FAIL\s+neu.*im 3\. Versuch, davor an der Umgebung gescheitert/);
    assert.match(text, /Zusammenfassung: out\/summary\.md/);
    const xml = readFileSync(join(root, 'out', 'junit.xml'), 'utf8');
    assert.match(xml, /<failure type="app" message="S2: Knopf fehlt">/);
    assert.match(xml, /<failure type="environment" message="S1: langsam">/);
    assert.match(readFileSync(join(root, 'out', 'summary.md'), 'utf8'), /\| PASS · bestanden im 2\. Versuch \(Umgebung\) \| anmelden \|/);
    const json = JSON.parse(readFileSync(join(root, 'out', 'caw.json'), 'utf8'));
    assert.deepEqual(json.tests.map(({ id, status, attempts }) => [id, status, attempts.length]), [['anmelden', 'pass', 2], ['bestellen', 'fail', 1], ['neu', 'fail', 3]]);
    assert.equal(json.tests[0].attempts[0].code, 'browser-closed');
    // Without --retry-env nothing runs twice.
    calls.length = 0;
    script.neu = [{ code: 2, verdict: { status: 'error', code: 'browser-closed', reason: 'zu' } }];
    assert.equal(await run(root, ['neu', '--env', 'local', '--report', 'json=out/one.json'], { runOne }), EXIT.error);
    assert.deepEqual(calls, ['neu']);
});

test('parseRunArgs: --report per kind once, --retry-env a whole number from 1 to 5', () => {
    const options = parseRunArgs('run', ['a', '--report', 'junit=j.xml', '--report=summary=s.md', '--report', 'json=r.json', '--retry-env', '2']);
    assert.deepEqual([options.reports, options.retryEnv], [{ junit: 'j.xml', summary: 's.md', json: 'r.json' }, 2]);
    assert.throws(() => parseRunArgs('run', ['a', '--report', 'junit=a.xml', '--report', 'junit=b.xml']), /--report junit= steht zweimal/);
    for (const value of ['0', '6', '1.5', 'x']) assert.throws(() => parseRunArgs('run', ['a', '--retry-env', value]), /--retry-env erwartet eine ganze Zahl von 1 bis 5/, value);
});

test('runMode: environment, team language and whether the run learns; open never', () => {
    const base = { withAgent: true, noChat: false, headless: false, inCi: false, withAdvice: false, environments: 'local', env: 'local', language: 'en' };
    assert.equal(runMode(base), 'Modus auf local (Teamsprache en): mit Chat; lernt: nein.');
    assert.equal(runMode({ ...base, inCi: true, learn: true, file: 'caw/recordings/x.yaml' }), 'Modus auf local (Teamsprache en): ohne Chat, weil die Variable CI gesetzt ist; lernt: ja, fehlende Vergleichswerte und Effekte in caw/recordings/x.yaml.');
    assert.match(runMode({ ...base, learn: true, opened: true, withAdvice: true }), /mit Chat; lernt: nein\.$/, 'open learns and advises nothing');
    // A PR preview's address from CAW_URL__<ENV> is named in the line (loadConfig has checked it).
    process.env.CAW_URL__PREVIEW = 'https://pr-3.preview.example.test';
    try {
        assert.match(runMode({ ...base, env: 'preview' }), /lernt: nein\. Adresse aus CAW_URL__PREVIEW: https:\/\/pr-3\.preview\.example\.test\.$/);
    } finally {
        delete process.env.CAW_URL__PREVIEW;
    }
});

test('help: the overlay extension (command, --overlay, the --start remark) only with an overlay block', () => {
    const core = helpText(undefined, { here: 'local' });
    assert.doesNotMatch(core, /overlay/);
    assert.match(core, /lokale Code|stoppen\n/, 'the --start line ends without the overlay remark');
    assert.doesNotMatch(helpText('run'), /--overlay|overlay\.parts/);
    assert.match(helpText('run'), /\[--reset\] \| \[--no-reset\]/, 'the line after the dropped option stays');
    const extended = helpText(undefined, { overlay: true });
    assert.match(extended, /^ {2}overlay status \[--env <name>\]/m);
    assert.match(extended, /mit --overlay auch die lokalen Code-Server der Teile/);
    assert.match(helpText('open', { overlay: true }), /\[--overlay\[=<teile>\]\]/);
});

test('help: per command only its block, agent commands under caw agent --help, synopsis for usage errors', () => {
    const all = helpText(undefined, { here: 'local' });
    assert.match(all, /^caw - Context-Aware Web Testing\n/, 'without colour the intro keeps its first line');
    assert.doesNotMatch(all, /theme/i);
    assert.match(all, /list \[<test>\]/);
    assert.match(all, /run <test> \[--env <name>\]/);
    assert.match(all, /auf denen Claude Code arbeiten darf \(hier: local\)/);
    assert.match(all, /4 Aufnahme nötig/);
    assert.match(all, /Dauern mit Einheit: --step-timeout 30s/);
    assert.doesNotMatch(all, /fill <ziel> <text>/, 'agent commands are under caw agent --help');
    // Hidden from people: the session MCP server, Claude's namespace and the commands that moved.
    assert.doesNotMatch(all, /^ {2}(mcp|agent|explore|auth)\b/m);
    assert.match(all, /^ {2}role login <rolle> --env <name>/m);
    const opened = helpText('open');
    assert.match(opened, /^ {2}open \[<test>\[@<S4>\]\] \[--env <name>\]/);
    assert.match(opened, /Mit @<S4>: bis\s+zum Einstieg in S4/);
    assert.doesNotMatch(opened, /record|Einrichten/);
    assert.doesNotMatch(opened, /\{here\}|\(hier:/);
    assert.match(helpText('record'), /^ {2}record <test>@<S4>\s+Ab S4 bis zum Ende neu aufnehmen/m);
    assert.match(helpText('agent'), /^caw agent <befehl>/);
    assert.match(helpText('agent'), /fill <ziel> <text>/);
    assert.match(helpText('agent'), /wait-ready \[--for <selektor>\] \[--min-count <n>\] \[--timeout <dauer>\]/);
    assert.equal(synopsisOf('qqqq'), undefined);
    assert.equal(synopsisOf('open'), 'caw open [--env <name>] [--role <rolle>]  oder  caw open <test>[@<S4>] [--env <name>] [--agent local|docker | --attach [<key>]]');
    assert.equal(synopsisOf('click'), undefined);
    assert.equal(unknownCommandText('lsit'), 'Unbekannter Befehl: lsit. Meintest du list? Siehe caw --help.');
    assert.equal(unknownCommandText('qqqq'), 'Unbekannter Befehl: qqqq. Siehe caw --help.');
    assert.match(unknownCommandText('theme'), /^Unbekannter Befehl: theme\./);
    // Moved commands name where they are now, instead of a suggestion.
    assert.equal(unknownCommandText('explore'), 'caw explore heißt jetzt caw init --explore-only.');
    assert.equal(unknownCommandText('auth'), 'caw auth heißt jetzt caw role login.');
    assert.equal(unknownCommandText('click'), 'caw click heißt jetzt caw agent click.');
    assert.equal(unknownCommandText('mcp-agent'), 'caw mcp-agent heißt jetzt caw agent mcp.');
    assert.equal(unknownCommandText('clik', { agent: true }), 'Unbekannter Befehl: caw agent clik. Meintest du click? Siehe caw agent --help.');
});

// Strips ANSI colour codes.
// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

test('fatal error in the terminal: first the message, then the synopsis, last code and exit dimmed', () => {
    const lines = [];
    const ui = createUi({ fancy: true, out: (text) => lines.push(text), err: (text) => lines.push(text) });
    ui.fatal('usage', 'Name des Tests fehlt.', { synopsis: 'caw open <test>@<S4>', exit: 3 });
    assert.equal(lines.length, 3);
    assert.match(plain(lines[0]), /^ {2}✕ Name des Tests fehlt\.$/);
    // Aligned with the message text, not the mark.
    assert.equal(lines[1], '    Aufruf: caw open <test>@<S4>');
    assert.match(lines[2], /\(code: usage, exit 3\)/);
});

test('report: in the terminal also as a clickable file:// address', () => {
    const lines = [];
    const ui = createUi({ fancy: true, out: (text) => lines.push(text) });
    ui.verdict({ status: 'pass', testId: 'x', target: 'local' }, { report: '.caw/runs/r/report.md', reportUrl: 'file:///c:/p/.caw/runs/r/report.md', elapsed: 1 });
    assert.match(plain(lines.join('\n')), /^Bericht {2}\.caw\/runs\/r\/report\.md\n {9}file:\/\/\/c:\/p\/\.caw\/runs\/r\/report\.md$/m);
});

test('stepsText: contiguous as a range, otherwise listed', () => {
    assert.equal(stepsText({ steps: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }, { id: 'S4' }] }), 'S1–S4');
    assert.equal(stepsText({ steps: [{ id: 'S1' }, { id: 'S3' }, { id: 'S4' }] }), 'S1, S3, S4');
});

test('CLI: unknown command with suggestion, help everywhere with -h, exit codes', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-bin-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CAW_LANG: 'de', NO_COLOR: '1', INIT_CWD: root } });
    const typo = cli('lsit');
    assert.equal(typo.status, 3);
    assert.match(typo.stderr, /Unbekannter Befehl: lsit\. Meintest du list\? Siehe caw --help\./);
    assert.doesNotMatch(typo.stderr + typo.stdout, /Einrichten/, 'no full help after a typo');
    const help = cli('run', 'x', '-h');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^ {2}run <test>/);
    assert.doesNotMatch(help.stdout, /record <test>/);
    assert.match(cli('agent', '--help').stdout, /finish --file/);
    assert.match(cli('agent', 'click', '--help').stdout, /finish --file/);
    // The old places name the new ones, with exit 3; nothing runs.
    for (const [args, now] of [[['help', 'agent'], 'caw agent --help'], [['explore', '--url', 'http://localhost:1'], 'caw init --explore-only'], [['auth', 'kunde'], 'caw role login'], [['snapshot'], 'caw agent snapshot']]) {
        const moved = cli(...args);
        assert.equal(moved.status, 3, args.join(' '));
        assert.match(moved.stderr, new RegExp(`heißt jetzt ${now}\\.`), args.join(' '));
    }
    const renamed = cli('run', 'x', '--target', 'local');
    assert.equal(renamed.status, 3);
    assert.match(renamed.stderr, /--target heißt jetzt --env\./);
    const usage = cli('record', 'x@s3');
    assert.equal(usage.status, 3);
    assert.match(usage.stderr, /x@s3: Ein Schritt steht als <test>@S<n> hinter dem Test, etwa bestellung@S3\.\n\[caw\] Aufruf: caw record <test> \[--env <name>\] \[--role <rolle>\] {2}oder {2}caw record <test>@<S4> \[--env <name>\] \[--agent local\|docker \| --attach \[<key>\]\]\n\[caw\] \(code: usage, exit 3\)/);
    const unknown = cli('qqqq', 'x', 'S2');
    assert.equal(unknown.status, 3);
    assert.match(unknown.stderr, /Unbekannter Befehl: qqqq\./);
    writeFileSync(join(root, 'caw.config.json'), '{}');
    assert.equal(cli('validate').status, 3);
});

test('run tracks changes to the test files: baselines per step, otherwise "unchanged"', (t) => {
    const root = project(t);
    const tracker = changeTracker(root);
    assert.equal(tracker.summary(), 'Testdatei unverändert.');
    const spec = loadTest(root, 'anmelden');
    // Writing unchanged content does not count.
    tracker.adopt(spec, new Set(['S1']), { learned: 'baselines' });
    assert.equal(tracker.summary(), 'Testdatei unverändert.');
    const learned = { ...spec, steps: spec.steps.map((item) => ({ ...item, recording: { ...item.recording, check: 'document.title !== ""' } })) };
    tracker.adopt(learned, new Set(['S1', 'S2']), { learned: 'baselines' });
    assert.equal(tracker.summary(), 'Geändert: caw/recordings/anmelden.yaml (Vergleichswerte S1, S2)');
});

test('help texts: English examples in English, record replaces the recording', async () => {
    const { default: en } = await import('../src/shared/locales/en/cli.mjs');
    assert.match(en['cli.help.footer'], /production only when named/);
    assert.match(en['cli.help.record'], /Record a test plan or replace its recording/);
    assert.match(en['cli.doctorTodoNext'], /signedInSelector from the page after signing in/);
});

test('doctor never probes placeholder hosts', async () => {
    const { isPlaceholderHost } = await import('../src/host/doctor.mjs');
    for (const url of ['https://staging.example.com', 'https://example.org', 'https://app.example', 'https://x.invalid', 'https://shop.test']) assert.ok(isPlaceholderHost(url), url);
    for (const url of ['http://localhost:5173', 'https://staging.firma.de', 'https://example.company.com', 'https://testing.io']) assert.ok(!isPlaceholderHost(url), url);
});
