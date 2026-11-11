import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUi } from '../src/shared/ui.mjs';
import { loadTheme } from '../src/shared/theme-package.mjs';

const capture = (fancy, theme) => {
    const lines = [];
    return { lines, ui: createUi({ fancy, theme, out: (text) => lines.push(text), err: (text) => lines.push(text) }) };
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
    assert.deepEqual(lines, ['[caw-ai] Hallo', '[+1.3s] 3/9 click', '[caw-ai] r1 auf a/dev: fail', '[caw-ai] Bericht: r.md', '[caw-ai] Falsch', '[caw-ai] (code: usage, exit ?)']);
});

test('in a terminal: the verdict lists each expectation with its mark, the failure reason and the progress', () => {
    const { lines, ui } = capture(true);
    ui.verdict(VERDICT, { report: 'r.md', elapsed: 2 });
    const text = plain(lines.join('\n'));
    assert.match(text, /── FAIL · r1 auf a\/dev · 2\.0s ─+/);
    assert.match(text, /\[ {2}OK {2}\] E1 Maske da/);
    assert.match(text, /\[FEHLER\] E2 Liste da/);
    assert.match(text, /└ ✖ Liste leer/);
    assert.match(text, /█+▓+ {2}1 bestanden · 1 Fehler/);
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
    assert.match(plain(lines.join('\n')), /── ERROR · r1[\s\S]*\[ WARN \] Portal weg/);
});

test('in a terminal: section as a rule, result in a box with marks, all box rows equally wide', () => {
    const { lines, ui } = capture(true);
    ui.section(1, 'Anmelden');
    ui.box('Ergebnis', [{ status: 'ok', text: 'Framework: extjs' }, { status: 'warn', text: 'Startseite fehlt' }, { status: 'info', text: 'auth.submitSelector' },
        { status: 'removed', text: '#alt' }, { status: 'added', text: '#neu' }]);
    const text = plain(lines.join('\n'));
    assert.match(text, /── 1 ANMELDEN ─+/);
    assert.match(text, /┌─┤ ERGEBNIS ├─+┐/);
    assert.match(text, /│ \[ {2}OK {2}\] Framework: extjs +│/);
    assert.match(text, /│ \[ WARN \] Startseite fehlt +│/);
    assert.match(text, /│ {3}- #alt +│/);
    assert.match(text, /│ {3}\+ #neu +│/);
    const boxed = text.split('\n').filter((row) => /[┌│└]/.test(row));
    assert.equal(new Set(boxed.map((row) => [...row].length)).size, 1, boxed.join('\n'));
});

test('in a terminal: marks and colours come from the theme', () => {
    const base = loadTheme('bernstein');
    const { lines, ui } = capture(true, { ...base, marks: { ...base.marks, ok: '[ PASS ]' } });
    ui.success('fertig');
    assert.match(plain(lines[0]), /\[ PASS \] fertig/);
    // Truecolor from the bernstein palette (ok #ffb547) or its 256-colour approximation.
    // eslint-disable-next-line no-control-regex -- matches the ANSI colour code
    assert.match(lines[0], /\u001b\[38;(2;255;181;71|5;\d+)m/);
});
