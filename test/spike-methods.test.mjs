// The spike's methods (e2e/spike/methods.mjs) on synthetic captured runs: M0 behaves like the product, the variants differ
// where they should. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LEARN_RUNS, learnEffects } from '../src/host/effects.mjs';
import { seeded } from '../e2e/spike/app.mjs';
import { METHODS, diagnoseRun, initState, judgeRun, learnFrequency, learnIntersect, learnRun, observedOf, rawRequests, rowlessView, viewLinesWithoutRows } from '../e2e/spike/methods.mjs';
import { syntheticRow } from './spike-fixtures.mjs';

/** Learns from the given runs in order, as dev runs do. */
const learnAll = (method, rows) => rows.reduce((state, row) => learnRun(method, state, row, judgeRun(method, state, row)), initState());
const healthyRuns = (random, count, options = {}) => Array.from({ length: count }, () => syntheticRow(random, { flickerP: 0, ...options }));

test('learnIntersect with LEARN_RUNS is the product learnEffects', () => {
    const random = seeded(4);
    for (let round = 0; round < 20; round += 1) {
        let mine;
        let product;
        for (let run = 0; run < 3; run += 1) {
            const observed = observedOf(syntheticRow(random).steps[1]);
            mine = learnIntersect(mine, observed, LEARN_RUNS) ?? mine;
            product = learnEffects(product, observed) ?? product;
        }
        assert.deepEqual(mine, product);
    }
});

test('M0: a control missing after two healthy runs fails the step on its effects', () => {
    const random = seeded(5);
    const state = learnAll(METHODS.M0, healthyRuns(random, 2));
    const judgment = judgeRun(METHODS.M0, state, syntheticRow(random, { kind: 'control-removed', flickerP: 0 }));
    assert.equal(judgment.failed, 'S1');
    assert.equal(judgment.failedBy, 'effect');
    assert.ok(judgment.steps[0].deviation.lists.includes('controls'));
    assert.equal(judgment.steps[1].status, 'skipped');
});

test('M0: a learned view line that changes warns, and the next healthy run prunes it (absorbed)', () => {
    const random = seeded(6);
    let state = learnAll(METHODS.M0, healthyRuns(random, 2));
    const changed = syntheticRow(random, { kind: 'view-text', flickerP: 0 });
    const first = judgeRun(METHODS.M0, state, changed);
    assert.equal(first.failed, null);
    assert.equal(first.steps[3].warn, true);
    state = learnRun(METHODS.M0, state, changed, first);
    const again = judgeRun(METHODS.M0, state, syntheticRow(random, { kind: 'view-text', flickerP: 0 }));
    assert.equal(again.steps[3].warn, false);
});

test('M0 learns on the second run and is frozen after that; M1 needs five', () => {
    const random = seeded(7);
    const runs = healthyRuns(random, 5);
    assert.equal(learnAll(METHODS.M0, runs).steps.S1.effects.runs, LEARN_RUNS);
    assert.equal(learnAll(METHODS.M1, runs.slice(0, 2)).steps.S1.effects.runs, 2);
    const early = judgeRun(METHODS.M1, learnAll(METHODS.M1, runs.slice(0, 2)), syntheticRow(random, { kind: 'control-removed', flickerP: 0 }));
    assert.equal(early.failed, null, 'not learned yet: only a note');
    const late = judgeRun(METHODS.M1, learnAll(METHODS.M1, runs), syntheticRow(random, { kind: 'control-removed', flickerP: 0 }));
    assert.equal(late.failedBy, 'effect');
});

test('M2 keeps a line seen in 4 of 5 runs and drops one seen in 3', () => {
    const run = (lines) => new Map([[1, { controls: lines }]]);
    const learned = learnFrequency([run(['a', 'b']), run(['a', 'b']), run(['a', 'b']), run(['a']), run(['a'])], 4);
    assert.deepEqual(learned.actions[0].controls, ['a']);
    const four = learnFrequency([run(['a', 'b']), run(['a', 'b']), run(['a', 'b']), run(['a', 'b']), run(['a'])], 4);
    assert.deepEqual(four.actions[0].controls, ['a', 'b']);
});

test('a flicker learned by M0 by chance becomes a false failure; M2 does not learn it', () => {
    const random = seeded(8);
    const flickering = (row) => ({ ...row, steps: row.steps.map((step) => (step.id === 'S2' ? { ...step, effects: [{ ...step.effects[0], controls: ['+ button "Dismiss"'] }] } : step)) });
    const plain = healthyRuns(random, 5);
    // Both of M0's learning runs happen to show the sync notice.
    const m0 = learnAll(METHODS.M0, [flickering(plain[0]), flickering(plain[1])]);
    assert.equal(judgeRun(METHODS.M0, m0, plain[2]).failedBy, 'effect');
    const m2 = learnAll(METHODS.M2, [flickering(plain[0]), flickering(plain[1]), plain[2], plain[3], plain[4]]);
    assert.equal(judgeRun(METHODS.M2, m2, plain[2]).failed, null);
});

test('M5 relearns: a warning-only change is absorbed after the window', () => {
    const random = seeded(9);
    let state = learnAll(METHODS.M5, healthyRuns(random, 5));
    const flags = [];
    for (let run = 0; run < 6; run += 1) {
        const row = syntheticRow(random, { kind: 'view-text', flickerP: 0 });
        const judgment = judgeRun(METHODS.M5, state, row);
        flags.push(judgment.steps[3].warn);
        state = learnRun(METHODS.M5, state, row, judgment);
    }
    assert.equal(flags[0], true);
    assert.equal(flags.at(-1), false);
});

test('V drops the rows: from captured lines by the app rows, and from an ARIA tree by its list items', () => {
    assert.deepEqual(rowlessView(['- - button "Complete Buy oat milk" [pressed=false]', '+ - dialog "New todo":'], ['Buy oat milk']), ['+ - dialog "New todo":']);
    const aria = ['- heading "Errand" [level=1]', '- list "Todos":', '  - listitem:', '    - button "Complete Buy oat milk"', '    - link "Buy oat milk":', '      - /url: /todos/1', '- button "New todo"'].join('\n');
    assert.deepEqual(viewLinesWithoutRows(aria), ['- heading "Errand" [level=#]', '- list "Todos":', '- button "New todo"']);
});

test('slow: one healthy run is the baseline today, the median of five with M3', () => {
    const fixed = (ms) => ({ steps: [{ id: 'S1', status: 'pass', requests: [{ name: 'GET /api/x', status: 200, ms, params: [] }] }] });
    // A first run that happened to be slow sets today's baseline high; the median ignores it.
    const runs = [fixed(3000), fixed(150), fixed(150), fixed(150), fixed(150)];
    const later = fixed(8000);
    const m0 = learnAll(METHODS.M0, runs);
    const m3 = learnAll(METHODS.M3, runs);
    assert.equal(judgeRun(METHODS.M0, m0, later).slowFlags, 0, '8 s is under 3 x 3 s');
    assert.equal(judgeRun(METHODS.M3, m3, later).slowFlags, 1);
    // Before five runs M4 flags nothing at all.
    assert.equal(judgeRun(METHODS.M4, learnAll(METHODS.M4, runs.slice(0, 3)), fixed(60000)).slowFlags, 0);
});

test('compare: false and fail: [] are the cross-environment options (a) and (c)', () => {
    const random = seeded(10);
    const state = learnAll(METHODS.M0, healthyRuns(random, 2));
    const removed = syntheticRow(random, { kind: 'control-removed', flickerP: 0 });
    assert.equal(judgeRun(METHODS.M0, state, removed, { compare: false }).failed, null);
    const warnOnly = judgeRun(METHODS.M0, state, removed, { fail: [] });
    assert.equal(warnOnly.failed, null);
    assert.equal(warnOnly.warnings, 1);
});

test('diagnosis with the method baseline: a 500 is the app, a 503 and a reset connection the environment', () => {
    const random = seeded(11);
    const state = learnAll(METHODS.M0, healthyRuns(random, 2));
    const sideOf = (kind) => {
        const row = syntheticRow(random, { kind, flickerP: 0 });
        return diagnoseRun(METHODS.M0, state, row, judgeRun(METHODS.M0, state, row))?.side;
    };
    assert.equal(sideOf('app500'), 'app');
    assert.equal(sideOf('gateway503'), 'environment');
    assert.equal(sideOf('reset'), 'environment');
    assert.equal(diagnoseRun(METHODS.M0, state, syntheticRow(random), { failed: null }), null);
});

test('rawRequests turns summarized requests back into outcomes', () => {
    assert.deepEqual(rawRequests([{ name: 'GET /a', status: 200, ms: 5 }, { name: 'GET /b', status: 503, ms: 5 }, { name: 'GET /c', status: 'failed (x)', ms: 5 }]).map(({ outcome }) => outcome), ['ok', 'http', 'failed']);
});
