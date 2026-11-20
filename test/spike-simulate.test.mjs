// The spike's simulation (e2e/spike/simulate.mjs) on a synthetic capture: deterministic for a seed, metrics that follow from
// the data, and a report with the decision rule. Small sequence counts keep it cheap in `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { changedLines, decide, loadRows, renderReport, simulate } from '../e2e/spike/simulate.mjs';
import { plan } from '../e2e/spike/capture.mjs';
import { syntheticRows } from './spike-fixtures.mjs';

const OPTIONS = { sequences: 30, length: 20, seed: 3, creepLength: 40, methods: ['M0', 'M2', 'M5', 'M0V'] };
// One simulation shared by the tests that only read it: it is the expensive part.
let shared = null;
const simulated = () => (shared ??= simulate(syntheticRows({ seed: 2 }), OPTIONS));

test('the JSONL round trip skips a torn last line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spike-'));
    const file = join(dir, 'capture.jsonl');
    const rows = syntheticRows({ healthy: 3, regressions: 1 });
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{"v":1,"env":`);
    assert.equal(loadRows(file).length, rows.length);
});

test('the same seed gives the same report', () => {
    assert.equal(renderReport(simulate(syntheticRows({ seed: 2 }), OPTIONS)), renderReport(simulated()));
});

test('metrics follow the data: controls regressions are caught, M0 absorbs a view change, CI never writes', () => {
    const result = simulated();
    for (const mode of ['dev', 'ci']) {
        const removed = result.methods.M0[mode].tally.kinds['control-removed'];
        assert.equal(removed.fail, removed.n, `${mode}: a removed control fails every time`);
    }
    const view = result.methods.M0.dev.tally.kinds['view-text'];
    assert.ok(view.absorbedOf > 0 && view.absorbed === view.absorbedOf, 'pruning swallows the view change');
    assert.equal(result.methods.M0.ci.tally.writes, 0);
    assert.ok(result.methods.M5.dev.tally.steadyWrites > result.methods.M0.dev.tally.steadyWrites, 'rolling relearning writes more');
    // Synthetic flicker (30%) is learned when both of M0's learning runs show it (about 9% of sequences): false failures.
    assert.ok(result.methods.M0.dev.tally.effectFails > 0);
    // Option (a) never compares on b: no false failure by construction.
    assert.equal(result.methods.M0.cross.a.effectFails, 0);
});

test('the report has the rule, a verdict per method and every metric section', () => {
    const result = simulated();
    const report = renderReport(result);
    for (const heading of ['## Decision rule (pre-registered)', '## False failures', '## Detection within one run', '## Regressions absorbed', '## Creep', '## Churn', '## Cross-environment', '## Diagnosis']) {
        assert.ok(report.includes(heading), heading);
    }
    const verdicts = decide(result);
    assert.deepEqual(Object.keys(verdicts), OPTIONS.methods);
    assert.equal(verdicts.M0.checks.falseFailures, verdicts.M0.ff <= 1);
});

test('changedLines counts lines only in one of two texts', () => {
    assert.equal(changedLines('a\nb\nc', 'a\nc\nd'), 2);
    assert.equal(changedLines('a', 'a'), 0);
});

test('the capture plan interleaves kinds per environment and is seeded', () => {
    const options = { envs: ['a', 'b'], regressionEnvs: ['a'], healthy: 5, regressions: 2, kinds: ['view-text', 'app500'], seed: 1 };
    const runs = plan(options);
    assert.equal(runs.length, 5 + 4 + 5);
    assert.deepEqual(runs, plan(options));
    assert.ok(runs.filter(({ env }) => env === 'b').every(({ kind }) => kind === 'healthy'));
});
