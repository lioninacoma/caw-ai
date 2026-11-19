import assert from 'node:assert/strict';
import { test } from 'node:test';

import { t } from '../src/shared/i18n.mjs';
import { createUi } from '../src/shared/ui.mjs';

const capture = (fancy, full) => {
    const lines = [];
    return { lines, ui: createUi({ fancy, full, out: (text) => lines.push(text), err: (text) => lines.push(text) }) };
};
// eslint-disable-next-line no-control-regex -- strips ANSI colour codes
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');
test('a reproduction reports what it found, not passed', () => {
    for (const fancy of [true, false]) {
        const { lines, ui } = capture(fancy);
        ui.verdict({ status: 'pass', testId: 'reproduce', target: 'a/local', reproduce: { reproduced: 'yes' } }, { report: 'r.md', elapsed: 2 });
        const text = plain(lines.join('\n'));
        assert.match(text, /Nachgestellt\./);
        if (fancy) assert.doesNotMatch(text, /Bestanden\./);
    }
});

const VERDICT = {
    status: 'fail',
    testId: 'r1',
    target: 'a/dev',
    expectations: [{ id: 'E1', text: 'Maske da' }, { id: 'E2', text: 'Liste da' }],
    results: [{ id: 'E1', status: 'pass' }, { id: 'E2', status: 'fail', note: 'Liste leer' }],
    failures: [],
};

test('without a terminal: plain lines without control characters and symbols', () => {
    const { lines, ui } = capture(false);
    ui.info('Hallo');
    ui.step({ number: 3, total: 9, label: 'click', elapsed: 1.25 });
    ui.verdict(VERDICT, { report: 'r.md', elapsed: 2 });
    ui.fatal('usage', 'Falsch');
    assert.deepEqual(lines, ['[caw] Hallo', '[+1.3s] 3/9 click', '[caw] r1 auf a/dev: fail', '[caw] E2: Liste leer', '[caw] Bericht: r.md', '[caw] Falsch', '[caw] (code: usage, exit ?)']);
});

test('without a terminal (headless, CI): the reason of the failed step, never of a step not reached', () => {
    const { lines, ui } = capture(false);
    const long = `Schritt 4/19 (click button "Add todo"): ${'x'.repeat(400)}`;
    ui.verdict({
        ...VERDICT,
        expectations: [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }],
        results: [{ id: 'S1', status: 'fail', note: long }, { id: 'S2', status: 'fail', note: t('session.replay.notReachedBecause', { owner: 'S1' }) }],
    }, { report: 'r.md', elapsed: 1 });
    const reason = lines.find((line) => line.startsWith('[caw] S1: '));
    assert.ok(reason !== undefined && reason.length < 260 && reason.endsWith('…'), reason);
    assert.ok(!lines.some((line) => line.includes('S2:')));
    // Without a failed step: the first hard error.
    const hard = capture(false);
    hard.ui.verdict({ ...VERDICT, results: [{ id: 'E1', status: 'pass' }, { id: 'E2', status: 'pass' }], failures: [{ type: 'http', text: 'POST /api 500' }] }, { report: 'r.md', elapsed: 1 });
    assert.ok(hard.lines.includes('[caw] http: POST /api 500'), hard.lines.join('\n'));
});

test('an error names its code, also in the verdict line', () => {
    for (const fancy of [false, true]) {
        const { lines, ui } = capture(fancy);
        ui.verdict({ status: 'error', code: 'env-unreachable', reason: 'http://localhost:4199 ist nicht erreichbar.', testId: 'r1', target: 'local' }, { report: 'r.md', elapsed: 1 });
        assert.match(plain(lines.join('\n')), /ist nicht erreichbar\.\)? \(code: env-unreachable, exit 2\)/);
    }
    const { lines, ui } = capture(false);
    ui.verdict({ status: 'error', code: 'config-invalid', reason: 'auth.path steht noch auf TODO', testId: 'r1', target: 'local' }, { report: 'r.md', elapsed: 1 });
    assert.match(lines[0], /\(code: config-invalid, exit 3\)$/);
});

test('in a terminal: steps not reached count as open, not as failed', () => {
    const { lines, ui } = capture(true);
    ui.verdict({
        ...VERDICT,
        expectations: [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }],
        results: [{ id: 'S1', status: 'fail', note: 'kaputt' }, { id: 'S2', status: 'fail', note: t('session.replay.notReachedBecause', { owner: 'S1' }) }],
    }, { report: 'r.md', elapsed: 1 });
    const text = plain(lines.join('\n'));
    assert.match(text, /✕ S1 {2}a/);
    assert.match(text, /○ S2 {2}b {2}nicht erreicht/);
    assert.match(text, /Fehlgeschlagen\. 0 von 2 Schritten bestanden\./);
    assert.doesNotMatch(text, /Nicht erreicht, weil/, 'the note of a step not reached is not shown as a failure');
});

test('in a terminal: the verdict lists each step with its mark, the failure reason under its name and the summary', () => {
    const { lines, ui } = capture(true);
    ui.verdict(VERDICT, { report: 'r.md', elapsed: 2 });
    const text = plain(lines.join('\n'));
    assert.match(text, /^Lauf ─+$/m);
    assert.match(text, /^ {2}✓ E1 {2}Maske da$/m);
    assert.match(text, /^ {2}✕ E2 {2}Liste da$/m);
    // The reason starts where the step's name starts.
    const name = lines.map(plain).find((line) => line.includes('Liste da')).indexOf('Liste da');
    const reason = lines.map(plain).find((line) => line.includes('Liste leer'));
    assert.equal(reason.indexOf('Liste leer'), name, reason);
    assert.match(reason, /└ Liste leer$/);
    assert.match(text, /^Fehlgeschlagen\. 1 von 2 Schritten bestanden\. · 2\.0s$/m);
    assert.match(text, /^Bericht {2}r\.md$/m);
});

// The run's result in a terminal, exactly (B22): names, durations in a right-aligned column, the open step, the summary.
test('in a terminal: the format of a run, passed and failed', () => {
    const steps = [{ id: 'S1', text: 'Eine Bestätigung zeigt die Nummer.' }, { id: 'S2', text: 'Genau eine Aufgabe.' }, { id: 'S3', text: 'Sie ist durchgestrichen.' }, { id: 'S4', text: 'Morgen.' }];
    const names = { S1: 'Aufgabe anlegen', S2: 'Finden', S3: 'Abhaken', S4: 'Planen' };
    const failed = capture(true, true);
    failed.ui.verdict({ status: 'fail', testId: 'erste', target: 'local', expectations: steps,
        results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'pass' }, { id: 'S3', status: 'fail', note: 'der Ring zeigt 0/1' }, { id: 'S4', status: 'fail', note: t('session.replay.notReachedBecause', { owner: 'S3' }) }],
        warnings: [{ type: 'console', text: 'x' }] }, { report: '.caw/runs/r/report.md', reportUrl: 'file:///p/report.md', elapsed: 8.7, names, durations: { S1: 4.2, S2: 1.3, S3: 31.5 } });
    assert.deepEqual(failed.lines.map(plain), [
        '',
        'Lauf ───────────────────────────────────────────────',
        '  ✓ S1  Aufgabe anlegen    4.2s',
        '  ✓ S2  Finden             1.3s',
        '  ✕ S3  Abhaken           31.5s',
        '      └ der Ring zeigt 0/1',
        '  ○ S4  Planen           nicht erreicht',
        '',
        'Fehlgeschlagen. 2 von 4 Schritten bestanden. 1 Warnung · 8.7s',
        'Bericht  .caw/runs/r/report.md',
        '         file:///p/report.md',
    ]);
    // Colours: the duration and the open step dim, the reason in fail, the status word bold in its colour.
    assert.ok(failed.lines[2].endsWith('\u001b[38;2;103;113;116m  4.2s\u001b[39m'), JSON.stringify(failed.lines[2]));
    assert.ok(failed.lines[5].includes('\u001b[38;2;255;107;112mder Ring zeigt 0/1\u001b[39m'), JSON.stringify(failed.lines[5]));
    assert.ok(failed.lines[8].startsWith('\u001b[38;2;255;107;112m\u001b[1mFehlgeschlagen.\u001b[22m\u001b[39m'), JSON.stringify(failed.lines[8]));
    const passed = capture(true, true);
    passed.ui.verdict({ status: 'pass', testId: 'erste', target: 'local', expectations: steps.slice(0, 2), results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'pass' }] },
        { report: 'r.md', elapsed: 5, names });
    assert.deepEqual(passed.lines.map(plain).slice(2), ['  ✓ S1  Aufgabe anlegen', '  ✓ S2  Finden', '', 'Bestanden. 2 von 2 Schritten bestanden. · 5.0s', 'Bericht  r.md']);
});

test('in a terminal: the run header, the head once with the version, the next commands in the accent colour', () => {
    const { lines, ui } = capture(true, true);
    ui.header({ mode: 'Wiedergabe ohne Claude', test: 'erste', target: 'local', role: 'user', code: 'Dev-Server localhost:4174', language: 'de' });
    ui.head();
    const text = lines.map(plain);
    assert.match(text[0], /^● caw · Context-Aware Web Testing · \d+\.\d+\.\d+/);
    assert.equal(text.filter((line) => line.startsWith('●')).length, 1, 'the head only once');
    assert.equal(text[1], 'Wiedergabe ohne Claude · erste auf local als user · Teamsprache de');
    assert.ok(lines[1].startsWith('\u001b[1mWiedergabe ohne Claude\u001b[22m'), 'the mode in bold');
    assert.equal(text[2], 'Code: Dev-Server localhost:4174');
    lines.length = 0;
    ui.next([{ text: 'S3 ist gescheitert. Ursache klären: caw run erste --env local im Terminal', commands: ['caw run erste --env local'] }, { text: 'Bis zum Einstieg: caw open erste@S3 --env local', commands: ['caw open erste@S3 --env local'] }]);
    assert.deepEqual(lines.map(plain), ['Weiter   S3 ist gescheitert. Ursache klären: caw run erste --env local im Terminal', '         Bis zum Einstieg: caw open erste@S3 --env local']);
    assert.ok(lines[0].includes('\u001b[38;2;94;224;242mcaw run erste --env local\u001b[39m'), 'the command in accent');
    const piped = capture(false);
    piped.ui.head();
    piped.ui.next([{ text: 'a: caw run x', commands: ['caw run x'] }]);
    assert.deepEqual(piped.lines, ['[caw] a: caw run x'], 'in pipes no head, the hint as before');
});

test('in a terminal: too many failures are truncated, the report has them all', () => {
    const { lines, ui } = capture(true);
    const failures = Array.from({ length: 7 }, (_, index) => ({ type: 'http', text: `F${index}` }));
    ui.verdict({ ...VERDICT, failures }, { report: 'r.md', elapsed: 1 });
    assert.equal(lines.filter((text) => /http: F/.test(text)).length, 5);
    assert.match(lines.join('\n'), /und 2 weitere/);
});

test('texts from the portal cannot control the terminal', () => {
    for (const fancy of [true, false]) {
        const { lines, ui } = capture(fancy);
        ui.info('a\u001b[2Jb');
        ui.heading('x\u001b]0;Titel');
        ui.verdict({ ...VERDICT, reason: 'c\u001b[2Jd' }, { report: 'r.md', elapsed: 1 });
        assert.ok(lines.every((text) => !text.includes('\u001b[2J') && !text.includes('\u001b]0')), JSON.stringify(lines));
    }
});

test('status without expectations: error with a reason', () => {
    const { lines, ui } = capture(true);
    ui.verdict({ status: 'error', reason: 'Portal weg', testId: 'r1', target: 'a/dev' }, { report: 'r.md', elapsed: 1 });
    assert.match(plain(lines.join('\n')), /Lauf ─+\n {2}! Portal weg\n\nFehler\. · 1\.0s/);
});

test('in a terminal: section as a rule, result in a box with marks, all box rows equally wide', () => {
    const { lines, ui } = capture(true);
    ui.section(1, 'Anmelden');
    ui.box('Ergebnis', [{ status: 'ok', text: 'Framework: extjs' }, { status: 'warn', text: 'Startseite fehlt' }, { status: 'info', text: 'auth.submitSelector' },
        { status: 'removed', text: '#alt' }, { status: 'added', text: '#neu' }]);
    const text = plain(lines.join('\n'));
    assert.match(text, /── 1 ANMELDEN ─+/);
    assert.match(text, /┌─┤ ERGEBNIS ├─+┐/);
    assert.match(text, /│ ✓ Framework: extjs +│/);
    assert.match(text, /│ ! Startseite fehlt +│/);
    assert.match(text, /│ {3}- #alt +│/);
    assert.match(text, /│ {3}\+ #neu +│/);
    const boxed = text.split('\n').filter((row) => /[┌│└]/.test(row));
    assert.equal(new Set(boxed.map((row) => [...row].length)).size, 1, boxed.join('\n'));
});

test('in a terminal: Graphite colours, truecolor or the nearest of the 256 colours', () => {
    const full = capture(true, true);
    full.ui.success('fertig');
    assert.equal(plain(full.lines[0]), '  ✓ fertig');
    // ok is #3DD68C; the text keeps the terminal's own colour.
    assert.equal(full.lines[0], '  \u001b[38;2;61;214;140m✓\u001b[39m fertig');
    const reduced = capture(true, false);
    reduced.ui.success('fertig');
    // eslint-disable-next-line no-control-regex -- matches the ANSI colour code
    assert.match(reduced.lines[0], /^ {2}\u001b\[38;5;\d+m✓\u001b\[39m fertig$/);
});

test('command header: one line with dot, title and long form; in pipes only the title', () => {
    const fancy = capture(true, true);
    fancy.ui.banner({ title: 'caw init --explore-only' });
    assert.deepEqual(fancy.lines.map(plain), ['● caw init --explore-only · Context-Aware Web Testing', '']);
    // The dot and the name in the accent colour, the name bold, the rest dim.
    assert.ok(fancy.lines[0].startsWith('\u001b[38;2;94;224;242m●\u001b[39m \u001b[38;2;94;224;242m\u001b[1mcaw init --explore-only\u001b[22m\u001b[39m \u001b[38;2;103;113;116m· '), JSON.stringify(fancy.lines[0]));
    const piped = capture(false);
    piped.ui.banner({ title: 'caw init --explore-only' });
    assert.deepEqual(piped.lines, ['[caw] caw init --explore-only']);
});

test('an error verdict never shows the code line of describeCode as error code', () => {
    const { lines, ui } = capture(false);
    ui.verdict({ status: 'error', code: 'Dev-Server localhost:4174, dein aktueller Stand', reason: 'weg', testId: 'r1', target: 'local' }, { report: 'r.md', elapsed: 1 });
    assert.doesNotMatch(lines[0], /code:/);
});
