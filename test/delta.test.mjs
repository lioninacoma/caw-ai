// A test for a delta: --delta against the checked-out code, --file as the description the plan comes from, --ref, and what
// caw_status gives the session back.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { aboutRun, checkDescription, descriptionItems, readDescription } from '../src/host/delta.mjs';
import { deltaOf } from '../src/host/git.mjs';
import { parseRunArgs } from '../src/host/linux.mjs';
import { DESCRIPTION_FILE, startArgs } from '../src/host/session-mcp.mjs';
import { parsePlan } from '../src/host/test-file.mjs';
import { heardOf, heardProblems, withNoteIds } from '../src/host/test-plan.mjs';
import { exitOf } from '../src/shared/errors.mjs';
import { renderReport } from '../src/shared/report.mjs';

const code = (expected) => (error) => error.code === expected;

/** A repository with its project in app/: main, then feature with one commit that changes, adds and deletes a file. */
const repository = (t) => {
    const top = mkdtempSync(join(tmpdir(), 'caw-delta-'));
    t.after(() => rmSync(top, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: top, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
    const root = join(top, 'app');
    const write = (path, text) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'delta@example.test');
    git('config', 'user.name', 'Delta');
    git('config', 'core.autocrlf', 'false');
    write('src/form.js', 'alt');
    write('src/weg.js', 'weg');
    write('package.json', '{}');
    git('add', '-A');
    git('commit', '-q', '-m', 'Start');
    git('checkout', '-q', '-b', 'feature');
    write('src/form.js', 'neu');
    write('src/feld.js', 'feld');
    write('caw/tests/x.yaml', 'id: x');
    unlinkSync(join(root, 'src/weg.js'));
    git('add', '-A');
    git('commit', '-q', '-m', 'Feature');
    return { root, git, write };
};
const local = { name: 'local', source: 'deployed', url: 'http://127.0.0.1:5173' };

test('Delta: Bereich und einzelner Commit nennen Basis, Kopf und Dateien; andere lokale Änderungen stehen dabei', (t) => {
    const { root, git, write } = repository(t);
    const { delta, ref } = aboutRun(root, { delta: 'main..feature', ref: 'TCK-1' }, local);
    assert.equal(ref, 'TCK-1');
    assert.deepEqual(delta, { range: 'main..feature', base: git('rev-parse', '--short', 'main'), head: git('rev-parse', '--short', 'feature'), files: ['src/feld.js', 'src/form.js', 'src/weg.js'], dirty: [] });
    assert.deepEqual(aboutRun(root, { delta: 'feature' }, local).delta.files, delta.files, 'ein Commit gegen seinen Vorgänger');
    assert.deepEqual(aboutRun(root, { delta: 'main...feature' }, local).delta.files, delta.files);
    write('package.json', '{"x":1}');
    assert.deepEqual(aboutRun(root, { delta: 'main..feature' }, local).delta.dirty, ['package.json']);
    assert.deepEqual(aboutRun(root, {}, { name: 'prod', production: true }), {}, 'ohne --delta wird nichts geprüft');
});

test('Delta: nicht ausgecheckt, abweichende oder wieder vorhandene Dateien und fremde Umgebungen werden abgelehnt', (t) => {
    const { root, git, write } = repository(t);
    assert.equal(exitOf('delta-mismatch'), 3);
    write('src/form.js', 'lokal anders');
    assert.throws(() => aboutRun(root, { delta: 'main..feature' }, local), (error) => code('delta-mismatch')(error) && /src\/form\.js/.test(error.message));
    write('src/form.js', 'neu');
    write('src/weg.js', 'wieder da');
    assert.throws(() => aboutRun(root, { delta: 'main..feature' }, local), /src\/weg\.js/);
    unlinkSync(join(root, 'src/weg.js'));
    assert.throws(() => aboutRun(root, { delta: 'main..feature' }, { name: 'dev', source: 'deployed', url: 'https://dev.example.test' }), code('delta-mismatch'));
    assert.equal(aboutRun(root, { delta: 'main..feature' }, { name: 'dev', source: 'overlay', url: 'https://dev.example.test' }).delta.range, 'main..feature');
    git('checkout', '-q', 'main');
    assert.throws(() => aboutRun(root, { delta: 'main..feature' }, local), (error) => code('delta-mismatch')(error) && /git checkout/.test(error.message));
    for (const bad of ['gibtsnicht', 'main..gibtsnicht', '--output=x', 'main']) assert.throws(() => deltaOf(root, bad), code('git-ref'), bad);
});

test('Beschreibung: je Listenpunkt und Absatz eine Notiz, Überschrift und Folgezeilen gehören dazu', () => {
    const items = descriptionItems('# Postfach\n\nDas Formular bekommt ein Feld.\nEs ist optional.\n\n- Feld ist da\n  mit Beschriftung\n- Leer wird abgelehnt\n\n1. Speichern');
    assert.deepEqual(items.map(({ text }) => text), ['# Postfach\nDas Formular bekommt ein Feld.\nEs ist optional.', '- Feld ist da\nmit Beschriftung', '- Leer wird abgelehnt', '1. Speichern']);
    assert.ok(items.every(({ action }) => action === 'note'));
    assert.deepEqual(descriptionItems('# Nur eine Überschrift').map(({ text }) => text), ['# Nur eine Überschrift']);
    for (const bad of ['', '  ', 'x'.repeat(8001), 'a\u0007b', undefined]) assert.throws(() => checkDescription(bad), code('usage'));
    assert.throws(() => readDescription(tmpdir(), 'gibt-es-nicht.md'), code('usage'));
});

test('Plan: heard nennt den belegenden Schritt oder „offen“; ein Schritt, den es nicht gibt, wird abgelehnt', () => {
    const PLAN = 'steps:\n  - {id: S1, name: A, do: B, expect: C}\nheard:\n  - {note: H1, as: step, step: S1}\n  - {note: H2, as: open}\n';
    const { plan, problems } = parsePlan(PLAN);
    assert.deepEqual(problems, []);
    const notes = withNoteIds(descriptionItems('- eins\n- zwei'));
    assert.deepEqual(heardProblems(plan, notes), []);
    assert.match(heardProblems({ ...plan, heard: [{ note: 'H1', as: 'step', step: 'S9' }, plan.heard[1]] }, notes).join(' '), /the plan has no S9/);
    assert.deepEqual(heardOf(plan.heard, notes), [{ id: 'H1', text: '- eins', as: 'step', step: 'S1' }, { id: 'H2', text: '- zwei', as: 'open', step: undefined }]);
    assert.ok(parsePlan(PLAN.replace('as: step, step: S1', 'as: step')).problems.length > 0, 'step ohne Schritt');
});

test('Befehlszeile: --file nur beim Aufnehmen im Fenster, --delta und --ref nur für einen Test', () => {
    const record = parseRunArgs('record', ['abnahme', '--file', 'a.md', '--delta=main..HEAD', '--ref', 'TCK-1']);
    assert.deepEqual([record.test, record.file, record.delta, record.ref], ['abnahme', 'a.md', 'main..HEAD', 'TCK-1']);
    assert.equal(parseRunArgs('run', ['abnahme', '--delta', 'HEAD']).delta, 'HEAD');
    for (const args of [['a', '--file', 'a.md', '--headless'], ['a@S2', '--file', 'a.md'], ['a', '--ref', 'TCK 1']]) assert.throws(() => parseRunArgs('record', args), code('usage'), args.join(' '));
    for (const args of [['--all', '--ref', 'T'], ['a', 'b', '--delta', 'HEAD'], ['a', '--promote', '--ref', 'T'], ['a', '--file', 'a.md']]) assert.throws(() => parseRunArgs('run', args), code('usage'), args.join(' '));
});

test('caw_start: description geht als Datei mit, delta und ref als Wert, der Test bleibt das erste Wort', () => {
    assert.deepEqual(startArgs({ command: 'record', test: 'abnahme', env: 'local', description: '- eins', delta: 'main..HEAD', ref: 'TCK-1' }), ['abnahme', '--file', DESCRIPTION_FILE, '--delta=main..HEAD', '--ref=TCK-1', '--env', 'local']);
    assert.deepEqual(startArgs({ command: 'run', test: 'abnahme', delta: 'HEAD' }), ['abnahme', '--delta=HEAD']);
    assert.throws(() => startArgs({ command: 'record', test: 'a', description: ' ' }), code('usage'));
    assert.throws(() => startArgs({ command: 'run', test: 'a', description: 'x' }));
    assert.throws(() => startArgs({ command: 'run', test: 'a', delta: '--x' }));
    assert.throws(() => startArgs({ command: 'run', test: 'a', ref: 'a b' }));
});

test('Bericht: Referenz, Delta, lokale Änderungen und die Beschreibung', () => {
    const report = renderReport({ status: 'pass', testId: 'abnahme', target: 'local', testedCode: 'x', ref: 'TCK-1', delta: { range: 'main..f', base: 'aaa', head: 'bbb', files: ['a', 'b'], dirty: ['package.json'] }, heard: [{ id: 'H1', text: 'eins', as: 'step', step: 'S1' }, { id: 'H2', text: 'zwei', as: 'open' }] });
    for (const part of [/Referenz: TCK-1/, /getesteter Commit bbb, 2 geänderte/, /`package\.json`/, /H1: eins → belegt durch S1/, /H2: zwei → durch diesen Test nicht belegt/]) assert.match(report, part);
    assert.doesNotMatch(renderReport({ status: 'pass', testId: 'a', target: 'local', testedCode: 'x' }), /Referenz|Delta|Beschreibung/);
});
