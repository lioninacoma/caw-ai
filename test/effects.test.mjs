import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagnose } from '../src/host/diagnose.mjs';
import { EFFECT_LISTS, LEARN_RUNS, deviationText, effectChange, failsStep, jsonShape, learnEffects, lineDelta, responseLine, withoutLate } from '../src/host/effects.mjs';
import { learnedEffects, replayOf, withEffects } from '../src/host/replay.mjs';
import { parseTest, renderTest, stepHash } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

test('Effects: lineDelta as +/- lines', () => {
    assert.deepEqual(lineDelta(['a', 'b'], ['b', 'c']), ['+ c', '- a']);
});

test('Effects: responses as shape without values, with business error markers', () => {
    assert.deepEqual([...jsonShape({ Result: { Person: [{ Name: 'x' }] } })], ['.Result', '.Result.Person', '.Result.Person[]', '.Result.Person[].Name']);
    const ok = responseLine('GET /a', { success: true, Daten: { Wert: 1 } });
    assert.match(ok, /^GET \/a form [0-9a-f]{10} success=true$/);
    assert.equal(responseLine('GET /a', { success: true, Daten: { Wert: 2 } }), ok);
    assert.notEqual(responseLine('GET /a', { success: true, Daten: { Andere: 1 } }), ok);
    assert.match(responseLine('GET /a', { success: false, fehler: 'x' }), /success=false fehler=filled/);
});

test('Effects: learning keeps what was equal in all five healthy runs and is frozen afterwards', () => {
    assert.equal(LEARN_RUNS, 5);
    assert.deepEqual(EFFECT_LISTS, ['controls', 'requests', 'responses', 'console'], 'no view lines');
    const first = learnEffects(undefined, new Map([[1, { controls: ['+ input "A" filled', '+ button "Rauschen"'], console: ['log: a'] }], [2, { requests: ['GET /x 200'] }]]));
    assert.deepEqual(first, { runs: 1, actions: [{ action: 1, controls: ['+ input "A" filled', '+ button "Rauschen"'], console: ['log: a'] }, { action: 2, requests: ['GET /x 200'] }] });
    const second = learnEffects(first, new Map([[1, { controls: ['+ input "A" filled'], console: ['log: b'] }], [2, { requests: ['GET /y 200'] }]]));
    assert.deepEqual(second, { runs: 2, actions: [{ action: 1, controls: ['+ input "A" filled'], console: ['log: a', 'log: b'] }] });
    let learned = second;
    for (let run = 3; run <= LEARN_RUNS; run += 1) learned = learnEffects(learned, new Map([[1, { controls: ['+ input "A" filled'] }]]));
    assert.deepEqual(learned, { runs: LEARN_RUNS, actions: [{ action: 1, controls: ['+ input "A" filled'], console: ['log: a', 'log: b'] }] });
    assert.equal(learnEffects(learned, new Map()), null);
});

test('Effects: a deviation shows what is missing, what happened instead, and what is new in the console', () => {
    const learned = { action: 3, controls: ['+ input "Kategorie*" empty', '- input "Kategorie*" disabled,empty'], console: ['log: ok'] };
    assert.equal(effectChange(learned, { controls: [...learned.controls, '+ button "Neu"'], console: ['log: ok'] }), null);
    const change = effectChange(learned, { controls: ['+ input "Bereich*" filled'], console: ['log: ok', 'error: Laden fehlgeschlagen'] });
    assert.deepEqual(change.missing, learned.controls);
    assert.deepEqual(change.extra, ['error: Laden fehlgeschlagen']);
    assert.deepEqual(change.instead, ['+ input "Bereich*" filled']);
    // A request that came within the step after the measurement is not missing.
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
    // Failing: only learned, and only in the lists from `fail`; the default is controls and console.
    assert.deepEqual(change.lists, ['controls', 'console']);
    assert.equal(failsStep({ ...change, learned: false }), false);
    assert.equal(failsStep({ ...change, learned: true }), true);
    assert.equal(failsStep({ ...change, learned: true, lists: ['responses', 'requests'] }), false);
    assert.equal(failsStep({ ...change, learned: true, lists: ['requests'] }, ['requests']), true);
    const strict = diagnose({ failed: { id: 'S2', reason: 'x' }, deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, fails: true } });
    assert.deepEqual([strict.side, strict.strength], ['app', 'clear']);
    // Response shape: only a different shape of the same request counts, a missing response does not.
    const shaped = { action: 1, responses: ['GET /a form aaaaaaaaaa success=true'] };
    assert.equal(effectChange(shaped, {}), null);
    assert.deepEqual(effectChange(shaped, { responses: ['GET /a form bbbbbbbbbb success=false'] }).missing, shaped.responses);
    // Target missing and the UI rearranged before: more likely a changed page. The deviation stays as evidence.
    const result = diagnose({ failed: { id: 'S2', reason: 'x' }, broken: { kind: 'target', step: 'S2' }, baseline: [], deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, learned: true } });
    assert.deepEqual([result.side, result.strength], ['test', 'likely']);
    assert.ok(result.findings.some((line) => /wirkt anders/.test(line)));
    // Learned and no rearrangement, e.g. only something new in the console: the app reacts differently.
    const consoleOnly = diagnose({ failed: { id: 'S2', reason: 'x' }, broken: { kind: 'target', step: 'S2' }, baseline: [], deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, instead: [], learned: true } });
    assert.deepEqual([consoleOnly.side, consoleOnly.strength], ['app', 'likely']);
    // Not learned yet: only evidence, no finding against the app.
    const early = diagnose({ failed: { id: 'S2', reason: 'x' }, broken: null, baseline: [], deviation: { step: 'S2', number: 3, label: 'press Enter', ...change, instead: [], learned: false } });
    assert.equal(early.side, 'unclear');
    assert.ok(early.findings.some((line) => /wirkt anders/.test(line)));
});

test('Effects: learned only from passed steps without a learned deviation, on the recording target', () => {
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

test('Effects: a deviation outside `fail` in a fully healthy run leaves the learned effects as they are', () => {
    const recorded = { runs: LEARN_RUNS, actions: [{ action: 1, controls: ['+ x'], requests: ['GET /docs 200', 'GET /a 200'] }] };
    const noise = effectChange(recorded.actions[0], { controls: ['+ x'], requests: ['GET /a 200'] });
    assert.deepEqual(noise.lists, ['requests']);
    const spec = { steps: [{ id: 'S1', name: 'S1', do: '', expect: 'x', recording: { hash: 'h', recordedOn: 'a/dev', actions: [], check: 'c', effects: recorded } }] };
    const observed = new Map([['S1', new Map([[1, { controls: ['+ x'], requests: ['GET /a 200'] }]])]]);
    const found = learnedEffects({ spec, results: new Map([['S1', { status: 'pass' }]]), effects: observed, deviations: new Map([['S1', { ...noise, number: 1, learned: true }]]), target: 'a/dev' });
    assert.equal(found.size, 0, 'no pruning: the missing request stays a warning in every later run');
});

test('Test file: recording.effects is read and written, the hash stays', () => {
    const step = { id: 'S1', name: 'Laden', do: 'Lade', expect: 'Da' };
    const effects = { runs: 2, actions: [{ action: 1, controls: ['+ input "Bereich*" filled', '- input "Bereich*" empty'], requests: ['GET /a 200'] }] };
    const recording = { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [], check: 'true', effects };
    const spec = composeTest({ id: 't', role: 'r', environments: ['a/dev'], source: 'overlay', writes: false }, { steps: [{ ...step, recording }] });
    const text = renderTest(spec);
    const back = parseTest(text);
    assert.deepEqual(back.steps[0].recording.effects, effects);
    assert.equal(stepHash(back.steps[0]), stepHash(step));
    assert.throws(() => parseTest(text.replace('runs: 2', 'runs: null')), /recording\.effects/);
    // View lines are no effect list: a recording that has them is invalid.
    assert.throws(() => parseTest(text.replace('requests:', 'view:')), /recording\.effects/);
});

test('Effects only apply to the state before: after fixing the previous step they are learned anew', () => {
    const step = (id, recordedAt, effects) => ({ id, recording: { recordedOn: 'a/dev', recordedAt, actions: [], check: 'true', ...(effects === undefined ? {} : { effects }) } });
    const learned = { runs: LEARN_RUNS, basis: 'S1-alt', actions: [{ action: 1, controls: ['alt'] }] };
    const observed = new Map([['S2', new Map([[1, { controls: ['neu'] }]])]]);
    const results = new Map([['S1', { status: 'pass' }], ['S2', { status: 'pass' }]]);
    const fixed = { id: 't', steps: [step('S1', 'S1-neu'), step('S2', 'S2-x', learned)] };
    assert.deepEqual(learnedEffects({ spec: fixed, results, effects: observed, target: 'a/dev' }).get('S2'), { runs: 1, basis: 'S1-neu', actions: [{ action: 1, controls: ['neu'] }] });
    assert.deepEqual(replayOf(fixed).effects, {}, 'stale effects are not compared');
    const unchanged = { id: 't', steps: [step('S1', 'S1-alt'), step('S2', 'S2-x', learned)] };
    assert.equal(learnedEffects({ spec: unchanged, results, effects: observed, target: 'a/dev' }).has('S2'), false, 'fully learned');
    assert.deepEqual(replayOf(unchanged).effects, { S2: learned });
});

test('learning: a line seen in earlier runs and missing now is dropped by the intersection and named, not lost silently', async () => {
    const effects = await import('../src/host/effects.mjs');
    const before = { runs: 2, actions: [{ action: 1, controls: ['+ button "Stornieren"'], requests: ['POST /api/orders 201', 'GET /api/orders 200'], console: ['warn: a'] }] };
    const after = learnEffects(before, new Map([[1, { controls: ['+ button "Stornieren"'], requests: ['GET /api/orders 200'] }]]));
    assert.deepEqual(after.actions[0].requests, ['GET /api/orders 200'], 'the intersection drops the line');
    assert.equal(typeof effects.droppedEffects, 'function', 'something names what a learning run dropped');
    assert.deepEqual(effects.droppedEffects(before, after), ['1 requests: POST /api/orders 201']);
    // A whole action gone, the first run (nothing seen before) and a console line (collected, never dropped).
    assert.deepEqual(effects.droppedEffects(before, learnEffects(before, new Map())), ['1 controls: + button "Stornieren"', '1 requests: POST /api/orders 201', '1 requests: GET /api/orders 200']);
    assert.deepEqual(effects.droppedEffects(undefined, learnEffects(undefined, new Map([[1, { requests: ['GET /x 200'] }]]))), []);
    assert.deepEqual(effects.droppedEffects(before, learnEffects(before, new Map([[1, { controls: ['+ button "Stornieren"'], requests: ['POST /api/orders 201', 'GET /api/orders 200'] }]]))), []);
    // Per step of a run, from the effects the run learned.
    const { droppedWhileLearning } = await import('../src/host/replay.mjs');
    const plain = { id: 'S1', name: 'S1', do: 'd', expect: 'e' };
    const spec = { id: 't', steps: [{ ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', actions: [{ action: 'click', target: 'x' }], check: 'true', effects: before } }] };
    assert.deepEqual(droppedWhileLearning(spec, new Map([['S1', after]])), [{ step: 'S1', lines: ['1 requests: POST /api/orders 201'] }]);
    assert.deepEqual(droppedWhileLearning(spec, new Map()), []);
});

test('learning: a dropped response names the JSON fields that came and went, not the hash of its form', async () => {
    const { droppedEffects } = await import('../src/host/effects.mjs');
    const { droppedWhileLearning } = await import('../src/host/replay.mjs');
    // The form every earlier run saw and the one this run got: the same request, a field renamed, one more.
    const forms = new Map();
    const then = responseLine('PATCH /api/todos/#', { id: 1, title: 'a', legacy: 'x' }, forms);
    const now = responseLine('PATCH /api/todos/#', { id: 1, title: 'a', note: 'b', tags: ['c'] }, forms);
    assert.match(then, / form [0-9a-f]{10}$/, 'the recording keeps its line as before');
    const before = { runs: 2, actions: [{ action: 1, responses: [then, 'GET /api/todos form 0123456789'] }] };
    const observed = new Map([[1, { responses: [now] }]]);
    const learned = learnEffects(before, observed);
    const lines = droppedEffects(before, learned, { observed, forms });
    assert.deepEqual(lines, [
        '1 responses: PATCH /api/todos/# antwortet mit anderen JSON-Feldern: neu .note, .tags, .tags[]; weg .legacy',
        '1 responses: GET /api/todos kam diesmal ohne JSON-Antwort',
    ]);
    assert.ok(lines.every((line) => !/form [0-9a-f]{10}/.test(line)), lines.join('\n'));
    // Fields the same, only a marker changed; an earlier form this machine never saw.
    const failed = responseLine('POST /api/x', { success: false }, forms);
    const ok = responseLine('POST /api/x', { success: true }, new Map());
    assert.deepEqual(droppedEffects({ runs: 1, actions: [{ action: 2, responses: [ok] }] }, { runs: 2, actions: [] }, { observed: new Map([[2, { responses: [failed] }]]), forms }),
        ['2 responses: POST /api/x antwortet mit success=false statt success=true']);
    const unknown = responseLine('POST /api/y', { a: 1 }, new Map());
    const other = responseLine('POST /api/y', { b: 1 }, forms);
    assert.deepEqual(droppedEffects({ runs: 1, actions: [{ action: 1, responses: [unknown] }] }, { runs: 2, actions: [] }, { observed: new Map([[1, { responses: [other] }]]), forms }),
        ['1 responses: POST /api/y antwortet mit anderen JSON-Feldern (die früheren kennt dieser Rechner nicht): jetzt .b']);
    // Per step of a run: this run's effects and the forms go along.
    const plain = { id: 'S1', name: 'S1', do: 'd', expect: 'e' };
    const spec = { id: 't', steps: [{ ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', actions: [{ action: 'click', target: 'x' }], check: 'true', effects: before } }] };
    assert.deepEqual(droppedWhileLearning(spec, new Map([['S1', learned]]), { observed: new Map([['S1', observed]]), forms }), [{ step: 'S1', lines }]);
});

test('learning: the fields of a learned response form are kept on this machine for the run that drops it', async () => {
    const { keptForms } = await import('../src/host/effects.mjs');
    const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'caw-forms-'));
    // The first run learns the form; a form it only saw (not learned) is not kept.
    const first = new Map();
    const learnedLine = responseLine('GET /a', { id: 1, legacy: 'x' }, first);
    responseLine('GET /b', { only: 'seen' }, first);
    keptForms(root, first, new Map([['S1', { runs: 1, actions: [{ action: 1, responses: [learnedLine] }] }]]));
    const file = join(root, '.caw', 'response-forms.json');
    assert.ok(existsSync(file));
    assert.deepEqual(Object.values(JSON.parse(readFileSync(file, 'utf8'))), [['.id', '.legacy']], 'field paths only, no values');
    // A later run (another process) gets a new form and drops the old line: it knows the earlier fields.
    const later = new Map();
    const now = responseLine('GET /a', { id: 1, note: 'y' }, later);
    const forms = keptForms(root, later, new Map());
    const { droppedEffects } = await import('../src/host/effects.mjs');
    assert.deepEqual(droppedEffects({ runs: 1, actions: [{ action: 1, responses: [learnedLine] }] }, { runs: 2, actions: [] }, { observed: new Map([[1, { responses: [now] }]]), forms }),
        ['1 responses: GET /a antwortet mit anderen JSON-Feldern: neu .note; weg .legacy']);
});
