import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUi } from '../src/shared/ui.mjs';

const capture = (fancy) => {
    const lines = [];
    return { lines, ui: createUi({ fancy, out: (text) => lines.push(text), err: (text) => lines.push(text) }) };
};
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
    assert.deepEqual(lines, ['[caw-ai] Hallo', '[+1.3s] 3/9 click', '[caw-ai] r1 auf a/dev: fail', '[caw-ai] Bericht: r.md', '[caw-ai] usage: Falsch']);
});

test('Im Terminal: Ergebnisblock nennt jeden Punkt und den Grund eines Fehlschlags', () => {
    const { lines, ui } = capture(true);
    ui.verdict(VERDICT, { report: 'r.md', elapsed: 2 });
    const text = lines.join('\n');
    assert.match(text, /✗ FAIL/);
    assert.match(text, /✓.*E1.*Maske da/);
    assert.match(text, /✗.*E2.*Liste da/);
    assert.match(text, /Liste leer/);
    assert.match(text, /Bericht:.*r\.md/);
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
    assert.match(lines.join('\n'), /! ERROR[\s\S]*Portal weg/);
});
