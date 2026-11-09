import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagnose } from '../src/host/diagnose.mjs';
import { deviationText, effectChange, failsStep, jsonShape, learnEffects, lineDelta, pruneEffects, responseLine, viewLines, withoutLate } from '../src/host/effects.mjs';
import { learnedEffects, replayOf, withEffects } from '../src/host/replay.mjs';
import { parseTest, renderTest, stepHash } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

test('Wirkung: ARIA-Zeilen ohne Links, Feldinhalte, lange Texte und Zahlen', () => {
    const aria = [
        '- textbox "Bereich*": Kammerbeitrag',
        '- textbox "Kategorie*" [disabled]',
        '  - /url: https://portal/x?p_auth=abc',
        '- button',
        `- text: ${'x'.repeat(200)}`,
        '- heading "Vorgang 4711" [level=2] [ref=e12]',
    ].join('\n');
    assert.deepEqual(viewLines(aria), ['- textbox "Bereich*"', '- textbox "Kategorie*" [disabled]', '- heading "Vorgang #" [level=#]']);
    assert.deepEqual(lineDelta(['a', 'b'], ['b', 'c']), ['+ c', '- a']);
});

test('Wirkung: Antworten als Form ohne Werte, mit fachlichen Fehlerzeichen', () => {
    assert.deepEqual([...jsonShape({ Result: { Person: [{ Name: 'x' }] } })], ['.Result', '.Result.Person', '.Result.Person[]', '.Result.Person[].Name']);
    const ok = responseLine('GET /a', { success: true, Daten: { Wert: 1 } });
    assert.match(ok, /^GET \/a form [0-9a-f]{10} success=true$/);
    assert.equal(responseLine('GET /a', { success: true, Daten: { Wert: 2 } }), ok);
    assert.notEqual(responseLine('GET /a', { success: true, Daten: { Andere: 1 } }), ok);
    assert.match(responseLine('GET /a', { success: false, fehler: 'x' }), /success=false fehler=filled/);
});

test('Wirkung: Lernen behält, was in allen gesunden Läufen gleich war, und steht danach fest', () => {
    const first = learnEffects(undefined, new Map([[1, { controls: ['+ input "A" filled', '+ button "Rauschen"'], console: ['log: a'] }], [2, { view: ['+ - dialog "X"'] }]]));
    assert.deepEqual(first, { runs: 1, actions: [{ action: 1, controls: ['+ input "A" filled', '+ button "Rauschen"'], console: ['log: a'] }, { action: 2, view: ['+ - dialog "X"'] }] });
    const second = learnEffects(first, new Map([[1, { controls: ['+ input "A" filled'], console: ['log: b'] }], [2, { view: ['+ - dialog "Y"'] }]]));
    assert.deepEqual(second, { runs: 2, actions: [{ action: 1, controls: ['+ input "A" filled'], console: ['log: a', 'log: b'] }] });
    assert.equal(learnEffects(second, new Map()), null);
});

test('Wirkung: Abweichung zeigt Fehlendes, was stattdessen geschah, und Neues in der Konsole', () => {
    const learned = { action: 3, controls: ['+ input "Kategorie*" empty', '- input "Kategorie*" disabled,empty'], console: ['log: ok'] };
    assert.equal(effectChange(learned, { controls: [...learned.controls, '+ button "Neu"'], console: ['log: ok'] }), null);
    const change = effectChange(learned, { controls: ['+ input "Bereich*" filled'], console: ['log: ok', 'error: Laden fehlgeschlagen'] });
    assert.deepEqual(change.missing, learned.controls);
    assert.deepEqual(change.extra, ['error: Laden fehlgeschlagen']);
    assert.deepEqual(change.instead, ['+ input "Bereich*" filled']);
    // Ein Request, der nach der Messung noch im Schritt kam, fehlt nicht.
    const slow = effectChange({ action: 1, requests: ['GET /docs 200'] }, {});
    assert.deepEqual(slow.lists, ['requests']);
    assert.equal(withoutLate(slow, ['GET /docs 200']), null);
    assert.deepEqual(withoutLate(slow, ['GET /andere 200']).missing, ['GET /docs 200']);
    assert.deepEqual(withoutLate({ ...change }, ['GET /docs 200']).lists, ['controls', 'console']);
    const text = deviationText({ step: 'S2', number: 3, label: 'press Enter', ...change });
    assert.match(text, /^S2, Aktion 3 \(press Enter\) wirkt anders/);
    assert.match(text, /Bleibt jetzt aus: input "Kategorie\*" empty erscheint/);
    assert.match(text, /Stattdessen: input "Bereich\*" filled erscheint/);
    assert.match(text, /Neu in der Konsole: error: Laden fehlgeschlagen/);
    // Snapshot-Zeilen bringen ihren eigenen Spiegelstrich und bei Links einen Doppelpunkt mit.
    const snapshot = deviationText({ step: 'S1', number: 1, label: 'click', missing: ['+ - option "Alle"', '- - button "Weiter"'], instead: ['+ - link "Akte 1":'], extra: [] });
    assert.match(snapshot, /Bleibt jetzt aus: option "Alle" erscheint; button "Weiter" verschwindet\. Stattdessen: link "Akte 1" erscheint\./);
    // Scheitern: nur gelernt und nur in den Listen aus `fail`; Standard sind Bedienelemente und Konsole.
    assert.deepEqual(change.lists, ['controls', 'console']);
    assert.equal(failsStep({ ...change, learned: false }), false);
    assert.equal(failsStep({ ...change, learned: true }), true);
    assert.equal(failsStep({ ...change, learned: true, lists: ['view', 'requests'] }), false);
    assert.equal(failsStep({ ...change, learned: true, lists: ['view'] }, ['view']), true);
    const strict = diagnose({ failed: { id: 'S2', reason: 'x' }, deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, fails: true } });
    assert.deepEqual([strict.side, strict.strength], ['app', 'clear']);
    // Antwortform: Nur eine andere Form desselben Requests zaehlt, eine fehlende Antwort nicht.
    const shaped = { action: 1, responses: ['GET /a form aaaaaaaaaa success=true'] };
    assert.equal(effectChange(shaped, {}), null);
    assert.deepEqual(effectChange(shaped, { responses: ['GET /a form bbbbbbbbbb success=false'] }).missing, shaped.responses);
    // Ziel fehlt und die Oberflaeche hat sich davor umgestellt: eher eine geaenderte Seite. Die Abweichung bleibt als Beleg.
    const result = diagnose({ failed: { id: 'S2', reason: 'x' }, broken: { kind: 'target', step: 'S2' }, baseline: [], deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, learned: true } });
    assert.deepEqual([result.side, result.strength], ['test', 'likely']);
    assert.ok(result.findings.some((line) => /wirkt anders/.test(line)));
    // Gelernt und ohne Umbau, etwa nur Neues in der Konsole: die Anwendung reagiert anders.
    const console = diagnose({ failed: { id: 'S2', reason: 'x' }, broken: { kind: 'target', step: 'S2' }, baseline: [], deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, instead: [], learned: true } });
    assert.deepEqual([console.side, console.strength], ['app', 'likely']);
    // Noch nicht gelernt: nur ein Beleg, kein Befund gegen die Anwendung.
    const early = diagnose({ failed: { id: 'S2', reason: 'x' }, broken: null, baseline: [], deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, instead: [], learned: false } });
    assert.equal(early.side, 'unclear');
    assert.ok(early.findings.some((line) => /wirkt anders/.test(line)));
});

test('Wirkung: gelernt nur aus bestandenen Schritten ohne gelernte Abweichung, auf dem Ziel der Aufnahme', () => {
    const stepWith = (id, recording) => ({ id, name: id, do: '', expect: 'x', recording: { hash: 'h', recordedOn: 'a/dev', actions: [], check: 'c', ...recording } });
    const spec = { steps: [stepWith('S1', {}), stepWith('S2', {}), stepWith('S3', { recordedOn: 'a/test' }), stepWith('S4', { effects: { runs: 1, actions: [] } })] };
    const results = new Map([['S1', { status: 'pass' }], ['S2', { status: 'fail' }], ['S3', { status: 'pass' }], ['S4', { status: 'pass' }]]);
    const effects = new Map(['S1', 'S2', 'S3', 'S4'].map((id) => [id, new Map([[1, { controls: ['+ x'] }]])]));
    const found = learnedEffects({ spec, results, effects, deviations: new Map([['S4', { learned: true }]]), target: 'a/dev' });
    assert.deepEqual([...found.keys()], ['S1']);
    const filled = withEffects(spec, found);
    assert.deepEqual(filled.steps[0].recording.effects, { runs: 1, actions: [{ action: 1, controls: ['+ x'] }] });
    assert.equal(filled.steps[1], spec.steps[1]);
});

test('Wirkung: Rauschen außerhalb von `fail` fällt nach einem ganz gesunden Lauf aus dem Gelernten', () => {
    const recorded = { runs: 2, actions: [{ action: 1, controls: ['+ x'], requests: ['GET /docs 200', 'GET /a 200'] }, { action: 2, view: ['+ - dialog "X"'] }] };
    const noise = effectChange(recorded.actions[0], { controls: ['+ x'], requests: ['GET /a 200'] });
    assert.deepEqual(pruneEffects(recorded, { ...noise, number: 1 }), { runs: 2, actions: [{ action: 1, controls: ['+ x'], requests: ['GET /a 200'] }, recorded.actions[1]] });
    // Faellt eine Liste leer, verschwindet die Aktion.
    const gone = effectChange(recorded.actions[1], {});
    assert.deepEqual(pruneEffects(recorded, { ...gone, number: 2 }).actions, [recorded.actions[0]]);
    // Bedienelemente und Konsole sind Befunde, kein Rauschen.
    const real = effectChange(recorded.actions[0], { requests: ['GET /a 200'] });
    assert.equal(pruneEffects(recorded, { ...real, number: 1 }), null);
    assert.equal(pruneEffects(recorded, { ...noise, number: 1 }, ['requests']), null);
    // Im Lauf: nur mit `prune`, also ganz gesund und ohne Wiederholung.
    const spec = { steps: [{ id: 'S1', name: 'S1', do: '', expect: 'x', recording: { hash: 'h', recordedOn: 'a/dev', actions: [], check: 'c', effects: recorded } }] };
    const args = { spec, results: new Map([['S1', { status: 'pass' }]]), effects: new Map(), deviations: new Map([['S1', { ...noise, number: 1, learned: true }]]), target: 'a/dev' };
    assert.equal(learnedEffects(args).size, 0);
    assert.deepEqual(learnedEffects({ ...args, prune: true }).get('S1').actions[0].requests, ['GET /a 200']);
});

test('Testdatei: recording.effects wird gelesen und geschrieben, der Hash bleibt', () => {
    const step = { id: 'S1', name: 'Laden', do: 'Lade', expect: 'Da' };
    const effects = { runs: 2, actions: [{ action: 1, controls: ['+ input "Bereich*" filled', '- input "Bereich*" empty'], requests: ['GET /a 200'] }] };
    const recording = { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', actions: [], check: 'true', effects };
    const spec = composeTest({ id: 't', app: 'a', role: 'r', targets: ['a/dev'], source: 'watch', mutates: false, also: [] }, { steps: [{ ...step, recording }] });
    const text = renderTest(spec);
    const back = parseTest(text);
    assert.deepEqual(back.steps[0].recording.effects, effects);
    assert.equal(stepHash(back.steps[0]), stepHash(step));
    assert.throws(() => parseTest(text.replace('runs: 2', 'runs: null')), /recording\.effects/);
});

test('Wirkung gilt nur für den Zustand davor: Nach einem Beheben des Schritts davor wird sie neu gelernt', () => {
    const step = (id, recordedAt, effects) => ({ id, recording: { recordedOn: 'a/dev', recordedAt, actions: [], check: 'true', ...(effects === undefined ? {} : { effects }) } });
    const learned = { runs: 2, basis: 'S1-alt', actions: [{ action: 1, controls: ['alt'] }] };
    const observed = new Map([['S2', new Map([[1, { controls: ['neu'] }]])]]);
    const results = new Map([['S1', { status: 'pass' }], ['S2', { status: 'pass' }]]);
    const behoben = { id: 't', steps: [step('S1', 'S1-neu'), step('S2', 'S2-x', learned)] };
    assert.deepEqual(learnedEffects({ spec: behoben, results, effects: observed, target: 'a/dev' }).get('S2'), { runs: 1, basis: 'S1-neu', actions: [{ action: 1, controls: ['neu'] }] });
    assert.deepEqual(replayOf(behoben).effects, {}, 'veraltete Wirkung wird nicht verglichen');
    const gleich = { id: 't', steps: [step('S1', 'S1-alt'), step('S2', 'S2-x', learned)] };
    assert.equal(learnedEffects({ spec: gleich, results, effects: observed, target: 'a/dev' }).has('S2'), false, 'fertig gelernt');
    assert.deepEqual(replayOf(gleich).effects, { S2: learned });
});
