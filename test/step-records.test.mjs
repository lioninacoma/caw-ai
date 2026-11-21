import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slowness } from '../src/host/diagnose.mjs';
import { stepDeviation } from '../src/host/effects.mjs';
import { stepRecords } from '../src/host/replay.mjs';

const effect = { controls: ['- button "Save"'], view: ['- heading "Todos"'], console: [] };

test('Step deviation: none without learned effects or when the effect is as learned', () => {
    assert.equal(stepDeviation(undefined, 1, effect), null);
    assert.equal(stepDeviation({ runs: 2, actions: [{ action: 1, ...effect }] }, 1, effect), null);
});

test('Step deviation: a missing control, learned only after two runs', () => {
    const now = { ...effect, controls: [] };
    const once = stepDeviation({ runs: 1, actions: [{ action: 1, ...effect }] }, 1, now);
    assert.equal(once.learned, false);
    const twice = stepDeviation({ runs: 2, actions: [{ action: 1, ...effect }] }, 1, now);
    assert.deepEqual({ number: twice.number, learned: twice.learned, lists: twice.lists, missing: twice.missing }, { number: 1, learned: true, lists: ['controls'], missing: ['- button "Save"'] });
});

test('Slowness: over 5 s and three times the baseline, or 10 s without one', () => {
    assert.equal(slowness(5000, { ms: 100 }), null);
    assert.equal(slowness(5001, { ms: 100 }), 'slow');
    assert.equal(slowness(6000, { ms: 2500 }), null);
    assert.equal(slowness(9999, undefined), null);
    assert.equal(slowness(10_000, undefined), 'verySlow');
});

const run = () => ({
    ids: ['S1', 'S2', 'S3'],
    results: new Map([['S1', { status: 'pass' }], ['S2', { status: 'fail' }]]),
    broken: { step: 'S2', kind: 'target' },
    requests: new Map([['S1', [{ name: 'GET /api/todos', outcome: 'ok', status: 200, ms: 40 }, { name: 'GET /api/todos', outcome: 'ok', status: 200, ms: 60 }]]]),
    effects: new Map([['S1', new Map([[1, effect]])]]),
    deviations: new Map([['S1', { step: 'S1', label: 'Click', number: 1, learned: true, lists: ['view'], missing: ['- heading "Todos"'], extra: [], instead: [], byList: { view: ['- heading "Todos"'] } }]]),
    durations: { S1: 1.23456, S2: 0.5 },
});

test('Step records: status, kind, seconds, requests and effects per step; unreached steps are skipped', () => {
    const [s1, s2, s3] = stepRecords(run());
    assert.deepEqual(s1, {
        id: 'S1',
        status: 'pass',
        seconds: 1.235,
        requests: [{ name: 'GET /api/todos', status: 200, ms: 60, count: 2 }],
        effects: [{ action: 1, ...effect }],
        deviation: { number: 1, learned: true, lists: ['view'], missing: ['- heading "Todos"'], extra: [], instead: [] },
    });
    assert.deepEqual(s2, { id: 'S2', status: 'fail', kind: 'target', seconds: 0.5 });
    assert.deepEqual(s3, { id: 'S3', status: 'skipped' });
});

test('Step records: the step a playback broke at fails though it has no result yet; the ones after it are skipped', () => {
    const given = run();
    given.results.delete('S2');
    const [, s2, s3] = stepRecords(given);
    assert.deepEqual(s2, { id: 'S2', status: 'fail', kind: 'target', seconds: 0.5 });
    assert.deepEqual(s3, { id: 'S3', status: 'skipped' });
});

test('Step records: a failed check, a failed effect; on production no effect lines', () => {
    const given = run();
    given.broken = null;
    given.deviations.set('S2', { lists: ['controls'], learned: true, fails: true, missing: ['- button "Save"'], extra: [], instead: [] });
    const records = stepRecords({ ...given, withEffects: false });
    assert.equal(records[1].kind, 'effect');
    assert.equal(records[0].effects, undefined);
    assert.deepEqual(records[0].deviation, { lists: ['view'], learned: true });
    assert.deepEqual(records[1].deviation, { lists: ['controls'], learned: true, fails: true });
    given.deviations.delete('S2');
    assert.equal(stepRecords(given)[1].kind, 'check');
});
