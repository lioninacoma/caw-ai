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
    assert.match(text, /1 Fehler · 1 offen/);
    assert.doesNotMatch(text, /Nicht erreicht/);
});

test('in a terminal: the verdict lists each expectation with its mark, the failure reason and the progress', () => {
    const { lines, ui } = capture(true);
    ui.verdict(VERDICT, { report: 'r.md', elapsed: 2 });
    const text = plain(lines.join('\n'));
    assert.match(text, /── FAIL · r1 auf a\/dev · 2\.0s ─+/);
    assert.match(text, /✓ E1 Maske da/);
    assert.match(text, /✕ E2 Liste da/);
    assert.match(text, /└ ✕ Liste leer/);
    assert.match(text, /━+ {2}1 bestanden · 1 Fehler/);
    assert.match(text, /Bericht: r\.md/);
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
    assert.match(plain(lines.join('\n')), /── ERROR · r1[\s\S]*! Portal weg/);
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
    assert.ok(fancy.lines[0].startsWith('\u001b[38;2;94;224;242m●\u001b[39m \u001b[1mcaw init --explore-only\u001b[22m '), JSON.stringify(fancy.lines[0]));
    const piped = capture(false);
    piped.ui.banner({ title: 'caw init --explore-only' });
    assert.deepEqual(piped.lines, ['[caw] caw init --explore-only']);
});

test('an error verdict never shows the code line of describeCode as error code', () => {
    const { lines, ui } = capture(false);
    ui.verdict({ status: 'error', code: 'Dev-Server localhost:4174, dein aktueller Stand', reason: 'weg', testId: 'r1', target: 'local' }, { report: 'r.md', elapsed: 1 });
    assert.doesNotMatch(lines[0], /code:/);
});
