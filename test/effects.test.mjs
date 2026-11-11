import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagnose } from '../src/host/diagnose.mjs';
import { deviationText, effectChange, failsStep, jsonShape, learnEffects, lineDelta, pruneEffects, responseLine, viewLines, withoutLate } from '../src/host/effects.mjs';
import { learnedEffects, replayOf, withEffects } from '../src/host/replay.mjs';
import { parseTest, renderTest, stepHash } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

test('Effects: ARIA lines without links, field contents, long texts and numbers', () => {
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

test('Effects: responses as shape without values, with business error markers', () => {
    assert.deepEqual([...jsonShape({ Result: { Person: [{ Name: 'x' }] } })], ['.Result', '.Result.Person', '.Result.Person[]', '.Result.Person[].Name']);
    const ok = responseLine('GET /a', { success: true, Daten: { Wert: 1 } });
    assert.match(ok, /^GET \/a form [0-9a-f]{10} success=true$/);
    assert.equal(responseLine('GET /a', { success: true, Daten: { Wert: 2 } }), ok);
    assert.notEqual(responseLine('GET /a', { success: true, Daten: { Andere: 1 } }), ok);
    assert.match(responseLine('GET /a', { success: false, fehler: 'x' }), /success=false fehler=filled/);
});

test('Effects: learning keeps what was equal in all healthy runs and is fixed afterwards', () => {
    const first = learnEffects(undefined, new Map([[1, { controls: ['+ input "A" filled', '+ button "Rauschen"'], console: ['log: a'] }], [2, { view: ['+ - dialog "X"'] }]]));
    assert.deepEqual(first, { runs: 1, actions: [{ action: 1, controls: ['+ input "A" filled', '+ button "Rauschen"'], console: ['log: a'] }, { action: 2, view: ['+ - dialog "X"'] }] });
    const second = learnEffects(first, new Map([[1, { controls: ['+ input "A" filled'], console: ['log: b'] }], [2, { view: ['+ - dialog "Y"'] }]]));
    assert.deepEqual(second, { runs: 2, actions: [{ action: 1, controls: ['+ input "A" filled'], console: ['log: a', 'log: b'] }] });
    assert.equal(learnEffects(second, new Map()), null);
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
    // Snapshot lines bring their own leading dash and, for links, a trailing colon.
    const snapshot = deviationText({ step: 'S1', number: 1, label: 'click', missing: ['+ - option "Alle"', '- - button "Weiter"'], instead: ['+ - link "Akte 1":'], extra: [] });
    assert.match(snapshot, /Bleibt jetzt aus: option "Alle" erscheint; button "Weiter" verschwindet\. Stattdessen: link "Akte 1" erscheint\./);
    // Failing: only learned, and only in the lists from `fail`; the default is controls and console.
    assert.deepEqual(change.lists, ['controls', 'console']);
    assert.equal(failsStep({ ...change, learned: false }), false);
    assert.equal(failsStep({ ...change, learned: true }), true);
    assert.equal(failsStep({ ...change, learned: true, lists: ['view', 'requests'] }), false);
    assert.equal(failsStep({ ...change, learned: true, lists: ['view'] }, ['view']), true);
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

test('Effects: noise outside `fail` drops out of the learned effects after a fully healthy run', () => {
    const recorded = { runs: 2, actions: [{ action: 1, controls: ['+ x'], requests: ['GET /docs 200', 'GET /a 200'] }, { action: 2, view: ['+ - dialog "X"'] }] };
    const noise = effectChange(recorded.actions[0], { controls: ['+ x'], requests: ['GET /a 200'] });
    assert.deepEqual(pruneEffects(recorded, { ...noise, number: 1 }), { runs: 2, actions: [{ action: 1, controls: ['+ x'], requests: ['GET /a 200'] }, recorded.actions[1]] });
    // If a list becomes empty, the action disappears.
    const gone = effectChange(recorded.actions[1], {});
    assert.deepEqual(pruneEffects(recorded, { ...gone, number: 2 }).actions, [recorded.actions[0]]);
    // Controls and console are findings, not noise.
    const real = effectChange(recorded.actions[0], { requests: ['GET /a 200'] });
    assert.equal(pruneEffects(recorded, { ...real, number: 1 }), null);
    assert.equal(pruneEffects(recorded, { ...noise, number: 1 }, ['requests']), null);
    // In a run: only with `prune`, i.e. fully healthy and without retries.
    const spec = { steps: [{ id: 'S1', name: 'S1', do: '', expect: 'x', recording: { hash: 'h', recordedOn: 'a/dev', actions: [], check: 'c', effects: recorded } }] };
    const args = { spec, results: new Map([['S1', { status: 'pass' }]]), effects: new Map(), deviations: new Map([['S1', { ...noise, number: 1, learned: true }]]), target: 'a/dev' };
    assert.equal(learnedEffects(args).size, 0);
    assert.deepEqual(learnedEffects({ ...args, prune: true }).get('S1').actions[0].requests, ['GET /a 200']);
});

test('Test file: recording.effects is read and written, the hash stays', () => {
    const step = { id: 'S1', name: 'Laden', do: 'Lade', expect: 'Da' };
    const effects = { runs: 2, actions: [{ action: 1, controls: ['+ input "Bereich*" filled', '- input "Bereich*" empty'], requests: ['GET /a 200'] }] };
    const recording = { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', actions: [], check: 'true', effects };
    const spec = composeTest({ id: 't', app: 'a', role: 'r', targets: ['a/dev'], source: 'overlay', mutates: false, also: [] }, { steps: [{ ...step, recording }] });
    const text = renderTest(spec);
    const back = parseTest(text);
    assert.deepEqual(back.steps[0].recording.effects, effects);
    assert.equal(stepHash(back.steps[0]), stepHash(step));
    assert.throws(() => parseTest(text.replace('runs: 2', 'runs: null')), /recording\.effects/);
});

test('Effects only apply to the state before: after fixing the previous step they are learned anew', () => {
    const step = (id, recordedAt, effects) => ({ id, recording: { recordedOn: 'a/dev', recordedAt, actions: [], check: 'true', ...(effects === undefined ? {} : { effects }) } });
    const learned = { runs: 2, basis: 'S1-alt', actions: [{ action: 1, controls: ['alt'] }] };
    const observed = new Map([['S2', new Map([[1, { controls: ['neu'] }]])]]);
    const results = new Map([['S1', { status: 'pass' }], ['S2', { status: 'pass' }]]);
    const fixed = { id: 't', steps: [step('S1', 'S1-neu'), step('S2', 'S2-x', learned)] };
    assert.deepEqual(learnedEffects({ spec: fixed, results, effects: observed, target: 'a/dev' }).get('S2'), { runs: 1, basis: 'S1-neu', actions: [{ action: 1, controls: ['neu'] }] });
    assert.deepEqual(replayOf(fixed).effects, {}, 'stale effects are not compared');
    const unchanged = { id: 't', steps: [step('S1', 'S1-alt'), step('S2', 'S2-x', learned)] };
    assert.equal(learnedEffects({ spec: unchanged, results, effects: observed, target: 'a/dev' }).has('S2'), false, 'fully learned');
    assert.deepEqual(replayOf(unchanged).effects, { S2: learned });
});
