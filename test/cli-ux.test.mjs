// Bedienung im Terminal: list, Wahl des Ziels, Hilfe je Befehl, Meldungen mit Vorschlag, Exit-Codes, mehrere Tests, JUnit.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { changeTracker, chooseTarget, init, junitXml, list, run, runMode, stepsText } from '../src/host/commands.mjs';
import { parseRunArgs } from '../src/host/linux.mjs';
import { loadTest, stepHash, writeTest } from '../src/host/test-file.mjs';
import { EXIT, exitOf, worstExit } from '../src/shared/errors.mjs';
import { helpText, synopsisOf, unknownCommandText } from '../src/shared/help.mjs';
import { closest, editDistance } from '../src/shared/suggest.mjs';
import { createUi } from '../src/shared/ui.mjs';

const BIN = fileURLToPath(new URL('../bin/caw-ai.mjs', import.meta.url));
const step = (id, name) => ({ id, name, do: `${name} tun`, expect: `${name} sichtbar` });
const recorded = (plain) => ({ ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', recordedAt: '2026-11-06T09:00:00.000Z', actions: [], check: 'true' } });

/** Ein Projekt wie nach init (local mit Claude, staging ohne), mit drei Tests in verschiedenem Stand. */
const project = (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-ux-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    init(root);
    mkdirSync(join(root, 'caw', 'tests'), { recursive: true });
    const base = { app: 'web', role: 'tester', source: 'deployed', also: [], notes: '', knownMessages: undefined };
    writeTest(root, { ...base, id: 'anmelden', targets: ['local'], mutates: false, steps: [recorded(step('S1', 'Maske')), recorded(step('S2', 'Start'))] });
    writeTest(root, { ...base, id: 'bestellen', targets: ['local', 'staging'], mutates: true, steps: [recorded(step('S1', 'Liste')), { ...recorded(step('S2', 'Neu')), name: 'geaendert' }, step('S3', 'Ende')] });
    writeTest(root, { ...base, id: 'neu', targets: ['local'], mutates: true, steps: [step('S1', 'Eins')] });
    return root;
};

test('editDistance und closest: Tippfehler finden ihren Befehl, Gleichstand ergibt keinen Vorschlag', () => {
    assert.equal(editDistance('lsit', 'list'), 1);
    assert.equal(editDistance('create-tiket', 'create-ticket'), 1);
    assert.equal(closest('lsit', ['list', 'init', 'run']), 'list');
    assert.equal(closest('S7', ['S1', 'S2', 'S3']), undefined);
    assert.equal(closest('xyz', ['list', 'run']), undefined);
});

test('Exit-Codes: Aufnahme nötig ist 4, der schlimmste Lauf bestimmt den Stapel', () => {
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

test('parseRunArgs: Eine Option ohne Wert schluckt nicht die nächste', () => {
    assert.throws(() => parseRunArgs('run', ['t', '--target', '--headless']), /--target braucht einen Wert, etwa --target local/);
    assert.throws(() => parseRunArgs('run', ['t', '--until']), /--until braucht einen Wert, etwa --until S4/);
    assert.throws(() => parseRunArgs('run', ['t', '--target=']), /--target braucht einen Wert/);
    assert.throws(() => parseRunArgs('record', ['t', '--role', '--app', 'web']), /--role braucht einen Wert/);
    assert.throws(() => parseRunArgs('fix', ['t', 'S1', '--agent']), /--agent braucht einen Wert/);
    assert.throws(() => parseRunArgs('fix', ['t', 'S1', '--timeout', '--x']), /--timeout braucht einen Wert/);
});

test('parseRunArgs: mehrere Tests oder --all laufen ohne Chat, --until und --advise nur für einen Test', () => {
    const many = parseRunArgs('run', ['a', 'b', '--target', 'local']);
    assert.deepEqual([many.tests, many.batch, many.noChat], [['a', 'b'], true, true]);
    const all = parseRunArgs('run', ['--all', '--headless', '--report', 'junit=out/x.xml']);
    assert.deepEqual([all.all, all.batch, all.junit, all.test], [true, true, 'out/x.xml', undefined]);
    assert.throws(() => parseRunArgs('run', ['--all', 'a']), /--all/);
    assert.throws(() => parseRunArgs('run', ['a', 'b', '--until', 'S2']), /--until gilt nur für einen Test/);
    assert.throws(() => parseRunArgs('run', ['--all', '--advise']), /--advise gilt nur/);
    assert.throws(() => parseRunArgs('run', ['a', '--report', 'xml']), /junit=<datei>/);
    assert.equal(parseRunArgs('run', ['a', '--no-learn']).learn, false);
    assert.equal(parseRunArgs('run', ['a']).batch, undefined);
});

test('chooseTarget: das einzige Ziel, für record/fix das einzige mit Claude, sonst die Auswahl', () => {
    const config = { environments: { local: { url: 'http://localhost:1', claude: true }, dev: { url: 'https://dev.example', claude: true }, staging: { url: 'https://s.example' } } };
    const said = [];
    const log = (text) => said.push(text);
    assert.equal(chooseTarget(config, { id: 'x', targets: ['dev'] }, { command: 'run', log }), 'dev');
    assert.match(said.at(-1), /Ziel: dev \(einziges Ziel von x\)/);
    assert.equal(chooseTarget(config, { id: 'x', targets: ['dev'] }, { target: 'local', command: 'run', log }), 'local', 'Ein genanntes Ziel gilt');
    assert.throws(() => chooseTarget(config, { id: 'x', targets: ['local', 'staging'] }, { command: 'run', log }), /--target fehlt: local, staging/);
    assert.equal(chooseTarget(config, { id: 'x', targets: ['local', 'staging'] }, { command: 'fix', log }), 'local');
    assert.match(said.at(-1), /auf dem Claude arbeiten darf/);
    assert.throws(() => chooseTarget(config, null, { command: 'record', log }), /--target fehlt: local, dev/);
    const one = { environments: { local: config.environments.local, staging: config.environments.staging } };
    assert.equal(chooseTarget(one, null, { command: 'record', log }), 'local');
    assert.match(said.at(-1), /einzige Umgebung, auf der Claude arbeiten darf/);
});

test('list: je Test Ziele, Stand der Aufnahme und Schreiben; mit Test je Schritt eine Zeile', (t) => {
    const root = project(t);
    const lines = [];
    const out = (text) => lines.push(text);
    assert.equal(list(root, [], { out }), EXIT.pass);
    assert.match(lines[0], /^Test\s+Ziele\s+Aufnahme\s+Daten$/);
    assert.match(lines.find((line) => line.startsWith('anmelden')), /local\s+aufgenommen\s+liest nur/);
    assert.match(lines.find((line) => line.startsWith('bestellen')), /local, staging\s+veraltet \(S2, S3\)\s+schreibt/);
    assert.match(lines.find((line) => line.startsWith('neu')), /nicht aufgenommen/);
    lines.length = 0;
    list(root, ['bestellen'], { out });
    assert.match(lines[0], /bestellen: web, Rolle tester, Ziele local, staging, schreibt/);
    assert.match(lines[1], /^\s+S1\s+Liste\s+\(aufgenommen\)$/);
    assert.match(lines[2], /^\s+S2\s+geaendert\s+\(veraltet\)$/);
    assert.match(lines[3], /^\s+S3\s+Ende\s+\(nicht aufgenommen\)$/);
    assert.throws(() => list(root, ['bestelen'], { out }), (error) => error.code === 'test-missing' && /Meintest du bestellen\? Bekannte Tests: anmelden, bestellen, neu\./.test(error.message));
    assert.throws(() => list(root, ['a', 'b'], { out }), /Unerwartetes Argument: b/);
});

test('run: ohne --target das einzige Ziel, Tippfehler bekommen Vorschlag und Auswahl', async (t) => {
    const root = project(t);
    await assert.rejects(run(root, ['anmeldn']), (error) => error.code === 'test-missing' && /Meintest du anmelden\?/.test(error.message) && /caw-ai record anmeldn$/.test(error.message));
    await assert.rejects(run(root, ['bestellen']), (error) => error.code === 'usage' && /--target fehlt: local, staging/.test(error.message));
    await assert.rejects(run(root, ['anmelden', '--until', 'S9']), (error) => error.code === 'step-unknown' && /Schritte: S1, S2\./.test(error.message));
    // Fehlt die Aufzeichnung, ist das Exit 4 (Aufnahme nötig), nicht 3.
    await assert.rejects(run(root, ['neu']), (error) => error.code === 'replay-missing' && exitOf(error.code) === 4);
});

test('run mit mehreren Tests: jeder läuft, die Tabelle nennt den Ausgang, der Exit ist der schlimmste, JUnit auf Wunsch', async (t) => {
    const root = project(t);
    const said = [];
    t.mock.method(console, 'log', (text) => said.push(text));
    // neu ist nicht aufgenommen (4), gibtsnicht fehlt (3), bestellen ist veraltet (4): Es startet kein Browser.
    const code = await run(root, ['neu', 'gibtsnicht', 'bestellen', '--target', 'local', '--report', 'junit=out/junit.xml']);
    assert.equal(code, EXIT.needsRecording);
    const text = said.join('\n');
    assert.match(text, /Ergebnis: 3 Tests auf local/);
    assert.match(text, /AUFNAHME NÖTIG\s+neu/);
    assert.match(text, /ABGELEHNT\s+gibtsnicht/);
    assert.match(text, /JUnit-Bericht: out\/junit\.xml/);
    // --all nimmt nur Tests mit dem Ziel; ohne --target gilt das einzige Ziel aller Tests nicht, hier gibt es zwei.
    await assert.rejects(run(root, ['--all']), /--target fehlt: local, staging/);
    said.length = 0;
    // Nur bestellen nennt staging; dort darf er nicht schreiben: abgelehnt.
    assert.equal(await run(root, ['--all', '--target', 'staging']), EXIT.rejected);
    assert.match(said.join('\n'), /Ergebnis: 1 Test auf staging/);
});

test('junitXml: fail als failure, Aufnahme nötig und Fehler als error, Text sicher maskiert', () => {
    const xml = junitXml({ target: 'local', rows: [
        { test: 'a', exit: 0, seconds: 1 },
        { test: 'b', exit: 1, seconds: 2, note: 'bei S2 <x> & "y"' },
        { test: 'c', exit: 4, seconds: 0, note: 'keine Aufnahme' },
    ] });
    assert.match(xml, /<testsuite name="caw-ai local" tests="3" failures="1" errors="1"/);
    assert.match(xml, /<testcase classname="caw-ai.local" name="a" time="1.000"\/>/);
    assert.match(xml, /<failure type="fail" message="bei S2 &lt;x&gt; &amp; &quot;y&quot;"\/>/);
    assert.match(xml, /<error type="needs-recording" message="keine Aufnahme"\/>/);
});

test('runMode: --no-learn behält den Chat und sagt, dass die Datei bleibt; sonst nennt er die Datei', () => {
    const base = { withAgent: true, noChat: false, headless: false, inCi: false, withAdvice: false, environments: 'local' };
    assert.match(runMode({ ...base, file: 'caw/recordings/x.yaml' }), /lernt der Lauf in caw\/recordings\/x\.yaml \(abschalten mit --no-learn\)/);
    assert.match(runMode({ ...base, learn: false }), /mit Chat, ohne Lernen \(--no-learn\)/);
});

test('Hilfe: je Befehl nur sein Block, Agent-Befehle unter help agent, Kurzform für Aufruffehler', () => {
    const all = helpText(undefined, { here: 'local' });
    assert.match(all, /list \[<test>\]/);
    assert.match(all, /run <test> \[--target <umgebung>\]/);
    assert.match(all, /auf denen Claude\s+arbeiten\s+darf \(hier: local\)/);
    assert.match(all, /4 Aufnahme nötig/);
    assert.doesNotMatch(all, /fill <ziel> <text>/, 'Befehle für den Agenten stehen unter help agent');
    const fix = helpText('fix');
    assert.match(fix, /^ {2}fix <test> <S4>/);
    assert.doesNotMatch(fix, /record|Erste Schritte/);
    assert.doesNotMatch(fix, /\{here\}|\(hier:/);
    assert.match(helpText('run'), /--until <S4>\]\s+Nach S4 anhalten, das Fenster bleibt offen \(schließt --handover ein/);
    assert.match(helpText('agent'), /fill <ziel> <text>/);
    assert.match(helpText('click'), /snapshot/);
    assert.equal(synopsisOf('fix'), 'caw-ai fix <test> <S4> [--target <umgebung>]');
    assert.equal(synopsisOf('click'), undefined);
    assert.equal(unknownCommandText('lsit'), 'Unbekannter Befehl: lsit. Meintest du list? Siehe caw-ai --help.');
    assert.equal(unknownCommandText('qqqq'), 'Unbekannter Befehl: qqqq. Siehe caw-ai --help.');
});

const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

test('Abbruch im Terminal: zuerst die Meldung, dann die Kurzform, zuletzt blass Code und Exit', () => {
    const lines = [];
    const ui = createUi({ fancy: true, out: (text) => lines.push(text), err: (text) => lines.push(text) });
    ui.fatal('usage', 'Name des Tests fehlt.', { synopsis: 'caw-ai fix <test> <S4>', exit: 3 });
    assert.equal(lines.length, 3);
    assert.match(plain(lines[0]), /^ {2}\[FEHLER\] Name des Tests fehlt\.$/);
    // Unter dem Text der Meldung, nicht unter der Marke.
    assert.equal(lines[1], '           Aufruf: caw-ai fix <test> <S4>');
    assert.match(lines[2], /\(code: usage, exit 3\)/);
});

test('Bericht: im Terminal zusätzlich als file://-Adresse zum Anklicken', () => {
    const lines = [];
    const ui = createUi({ fancy: true, out: (text) => lines.push(text) });
    ui.verdict({ status: 'pass', testId: 'x', target: 'local' }, { report: '.caw/runs/r/report.md', reportUrl: 'file:///c:/p/.caw/runs/r/report.md', elapsed: 1 });
    assert.match(plain(lines.join('\n')), /Bericht:.*\.caw\/runs\/r\/report\.md\n.*file:\/\/\/c:\/p\/\.caw\/runs\/r\/report\.md/);
});

test('stepsText: lückenlos als Bereich, sonst aufgezählt', () => {
    assert.equal(stepsText({ steps: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }, { id: 'S4' }] }), 'S1–S4');
    assert.equal(stepsText({ steps: [{ id: 'S1' }, { id: 'S3' }, { id: 'S4' }] }), 'S1, S3, S4');
});

test('CLI: unbekannter Befehl mit Vorschlag, Hilfe überall mit -h, Exit-Codes', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-bin-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CAW_LANG: 'de', NO_COLOR: '1', INIT_CWD: root } });
    const typo = cli('lsit');
    assert.equal(typo.status, 3);
    assert.match(typo.stderr, /Unbekannter Befehl: lsit\. Meintest du list\? Siehe caw-ai --help\./);
    assert.doesNotMatch(typo.stderr + typo.stdout, /Erste Schritte/, 'keine ganze Hilfe nach einem Tippfehler');
    const help = cli('run', 'x', '-h');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^ {2}run <test>/);
    assert.doesNotMatch(help.stdout, /record <test>/);
    assert.match(cli('help', 'agent').stdout, /finish --file/);
    const usage = cli('fix', 'x');
    assert.equal(usage.status, 3);
    assert.match(usage.stderr, /fix erwartet einen Schritt wie S4\.\n\[caw-ai\] Aufruf: caw-ai fix <test> <S4> \[--target <umgebung>\]\n\[caw-ai\] \(code: usage, exit 3\)/);
    writeFileSync(join(root, 'caw.config.json'), '{}');
    assert.equal(cli('validate').status, 3);
});

test('run merkt sich Änderungen an den Dateien des Tests: Vergleichswerte je Schritt, sonst „unverändert“', (t) => {
    const root = project(t);
    const tracker = changeTracker(root);
    assert.equal(tracker.summary(), 'Testdatei unverändert.');
    const spec = loadTest(root, 'anmelden');
    // Unveraendert geschrieben zaehlt nicht.
    tracker.adopt(spec, new Set(['S1']), { learned: 'baselines' });
    assert.equal(tracker.summary(), 'Testdatei unverändert.');
    const learned = { ...spec, steps: spec.steps.map((item) => ({ ...item, recording: { ...item.recording, check: 'document.title !== ""' } })) };
    tracker.adopt(learned, new Set(['S1', 'S2']), { learned: 'baselines' });
    assert.equal(tracker.summary(), 'Geändert: caw/recordings/anmelden.yaml (Vergleichswerte S1, S2)');
});
