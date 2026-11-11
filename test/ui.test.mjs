import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUi } from '../src/shared/ui.mjs';
import { loadTheme } from '../src/shared/theme-package.mjs';

const capture = (fancy, theme) => {
    const lines = [];
    return { lines, ui: createUi({ fancy, theme, out: (text) => lines.push(text), err: (text) => lines.push(text) }) };
};
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');
const VERDICT = {
    status: 'fail',
    testId: 'r1',
    target: 'a/dev',
    expectations: [{ id: 'E1', text: 'Maske da' }, { id: 'E2', text: 'Liste da' }],
    results: [{ id: 'E1', status: 'pass' }, { id: 'E2', status: 'fail', note: 'Liste leer' }],
    failures: [],
};

test('Ohne Terminal: schlichte Zeilen ohne Steuerzeichen und Symbole', () => {
    const { lines, ui } = capture(false);
    ui.info('Hallo');
    ui.step({ number: 3, total: 9, label: 'click', elapsed: 1.25 });
    ui.verdict(VERDICT, { report: 'r.md', elapsed: 2 });
    ui.fatal('usage', 'Falsch');
    assert.deepEqual(lines, ['[caw-ai] Hallo', '[+1.3s] 3/9 click', '[caw-ai] r1 auf a/dev: fail', '[caw-ai] Bericht: r.md', '[caw-ai] Falsch', '[caw-ai] (code: usage, exit ?)']);
});

test('Im Terminal: Ergebnis nennt jeden Punkt mit Marke, den Grund eines Fehlschlags und den Fortschritt', () => {
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

test('Im Terminal: Zu viele Fehler werden gekürzt, der Bericht hat alle', () => {
    const { lines, ui } = capture(true);
    const failures = Array.from({ length: 7 }, (_, index) => ({ type: 'http', text: `F${index}` }));
    ui.verdict({ ...VERDICT, failures }, { report: 'r.md', elapsed: 1 });
    assert.equal(lines.filter((text) => /http: F/.test(text)).length, 5);
    assert.match(lines.join('\n'), /und 2 weitere/);
});

test('Texte aus dem Portal können das Terminal nicht steuern', () => {
    for (const fancy of [true, false]) {
        const { lines, ui } = capture(fancy);
        ui.info('a\u001b[2Jb');
        ui.heading('x\u001b]0;Titel');
        ui.verdict({ ...VERDICT, reason: 'c\u001b[2Jd' }, { report: 'r.md', elapsed: 1 });
        assert.ok(lines.every((text) => !text.includes('\u001b[2J') && !text.includes('\u001b]0')), JSON.stringify(lines));
    }
});

test('Status ohne Einzelpunkte: error mit Grund', () => {
    const { lines, ui } = capture(true);
    ui.verdict({ status: 'error', reason: 'Portal weg', testId: 'r1', target: 'a/dev' }, { report: 'r.md', elapsed: 1 });
    assert.match(plain(lines.join('\n')), /── ERROR · r1[\s\S]*\[ WARN \] Portal weg/);
});

test('Im Terminal: Abschnitt als Linie, Ergebnis im Kasten mit Marken, alle Kastenzeilen gleich breit', () => {
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

test('Im Terminal: Marken und Farben kommen aus dem Theme', () => {
    const base = loadTheme('bernstein');
    const { lines, ui } = capture(true, { ...base, marks: { ...base.marks, ok: '[ PASS ]' } });
    ui.success('fertig');
    assert.match(plain(lines[0]), /\[ PASS \] fertig/);
    // Truecolor aus der Bernstein-Palette (ok #ffb547) oder deren 256er-Naeherung.
    assert.match(lines[0], /\u001b\[38;(2;255;181;71|5;\d+)m/);
});
