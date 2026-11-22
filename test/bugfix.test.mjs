// The guided bug fix's phases: where a draft from caw reproduce stands and what comes next, as the session reads it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixPhase, fixState, redOf, reproductionOf } from '../src/host/bugfix.mjs';
import { stepHash, writeTest } from '../src/host/test-file.mjs';

const stepOf = (id, expect) => {
    const step = { id, name: `Schritt ${id}`, do: 'Tu es.', expect };
    return { ...step, recording: { hash: stepHash(step), recordedOn: 'test', recordedAt: '2026-11-20T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [], check: `check${id}()` } };
};
const draft = { id: 'bug-x', draft: true, writes: false, notes: '', steps: [stepOf('S1', 'Da.'), stepOf('S2', 'Total: 5.')], expectations: [{ id: 'S1', text: 'Da.' }, { id: 'S2', text: 'Total: 5.' }] };
const red = { ...draft, red: { step: 'S2', run: '2026-11-20T09-00-00-000Z-bug-x', head: 'abc1234' } };

test('fixPhase: reproduced until the red proof, red until a later run passes, green then, promoted once the draft moved', () => {
    assert.deepEqual(fixPhase({ id: 'bug-x', draft }), { phase: 'reproduced', next: { tool: 'caw_start', command: 'record', test: 'bug-x', decision: 'reproduced.record' } });
    const fix = { do: 'fix-app', red: { step: 'S2', name: 'Schritt S2', expect: 'Total: 5.', check: 'checkS2()', cause: 'server.mjs:12' }, then: { tool: 'caw_start', command: 'run', test: 'bug-x' }, decision: 'fix.guide' };
    assert.deepEqual(fixPhase({ id: 'bug-x', draft: red, cause: 'server.mjs:12' }), { phase: 'red', next: fix });
    // The red run itself and older runs do not count; a later red run keeps it red.
    const runs = [{ runId: '2026-11-20T09-00-00-000Z-bug-x', status: 'fail' }, { runId: '2026-11-19T09-00-00-000Z-bug-x', status: 'pass' }];
    assert.equal(fixPhase({ id: 'bug-x', draft: red, runs }).phase, 'red');
    assert.equal(fixPhase({ id: 'bug-x', draft: red, runs: [{ runId: '2026-11-21T09-00-00-000Z-bug-x', status: 'fail' }, ...runs] }).phase, 'red');
    // A later pass that never judged the red step (an open at its entry) keeps it red too.
    assert.equal(fixPhase({ id: 'bug-x', draft: red, runs: [{ runId: '2026-11-21T09-00-00-000Z-bug-x', status: 'pass', results: [{ id: 'S1', status: 'pass' }] }, ...runs] }).phase, 'red');
    const fixed = [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'pass' }];
    assert.deepEqual(fixPhase({ id: 'bug-x', draft: red, runs: [{ runId: '2026-11-21T09-00-00-000Z-bug-x', status: 'pass', results: fixed }, ...runs] }), { phase: 'green', next: { tool: 'caw_start', command: 'run', test: 'bug-x', promote: true, decision: 'fix.green' } });
    // Without the draft: promoted when caw/tests has it from this draft, with the fix report if it is still there.
    assert.deepEqual(fixPhase({ id: 'bug-x', promoted: true, fixReport: '.caw/runs/r/fix-report.md' }), { phase: 'promoted', next: { done: true, fixReport: '.caw/runs/r/fix-report.md' } });
    assert.deepEqual(fixPhase({ id: 'bug-x', promoted: true }), { phase: 'promoted', next: { done: true } });
    assert.equal(fixPhase({ id: 'bug-x' }), undefined, 'discarded: no phase');
});

test('redOf: the red step with expectation, check and cause; nothing before the red proof', () => {
    assert.equal(redOf(draft), undefined);
    assert.deepEqual(redOf(red), { step: 'S2', name: 'Schritt S2', expect: 'Total: 5.', check: 'checkS2()' });
    assert.deepEqual(redOf({ ...red, steps: [red.steps[0], { id: 'S2', name: 'n', do: 'd', expect: 'e' }] }, 'c'), { step: 'S2', name: 'n', expect: 'e', cause: 'c' });
});

test('fixState: reads the draft, its runs, the reproduction\'s cause and the fix report from disk', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-bugfix-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const run = (runId, result, files = {}) => {
        const dir = join(root, '.caw', 'runs', runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
        for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    };
    assert.equal(fixState(root, 'bug-x'), undefined, 'nothing there');
    run('2026-11-19T09-00-00-000Z-reproduce', { status: 'pass', reproduce: { reproduced: 'yes', cause: 'server.mjs:12 rechnet ohne Preise.', draft: { file: 'caw/drafts/bug-x.yaml', record: 'caw record bug-x' } } });
    assert.equal(reproductionOf(root, 'bug-x').cause, 'server.mjs:12 rechnet ohne Preise.');
    writeTest(root, draft);
    assert.equal(fixState(root, 'bug-x').phase, 'reproduced');
    writeTest(root, red);
    run('2026-11-20T09-00-00-000Z-bug-x', { status: 'fail' });
    const redState = fixState(root, 'bug-x');
    assert.equal(redState.phase, 'red');
    assert.equal(redState.next.red.cause, 'server.mjs:12 rechnet ohne Preise.');
    assert.equal(redState.next.red.check, 'checkS2()');
    run('2026-11-21T09-00-00-000Z-bug-x', { status: 'pass', results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'pass' }] }, { 'fix-report.md': '# Fix' });
    assert.equal(fixState(root, 'bug-x').phase, 'green');
    // Promoted: the draft moved to caw/tests.
    rmSync(join(root, 'caw', 'drafts', 'bug-x.yaml'));
    writeTest(root, { ...draft, draft: undefined });
    assert.deepEqual(fixState(root, 'bug-x'), { phase: 'promoted', next: { done: true, fixReport: '.caw/runs/2026-11-21T09-00-00-000Z-bug-x/fix-report.md' } });
    // A test that never was a draft has no phase; one a reproduction wrote is promoted also when its fix report is gone.
    rmSync(join(root, '.caw', 'runs', '2026-11-21T09-00-00-000Z-bug-x'), { recursive: true });
    assert.equal(fixState(root, 'bug-x'), undefined);
    assert.deepEqual(fixState(root, 'bug-x', { fromDraft: true }), { phase: 'promoted', next: { done: true } });
    // A draft that does not load has no phase either.
    mkdirSync(join(root, 'caw', 'drafts'), { recursive: true });
    writeFileSync(join(root, 'caw', 'drafts', 'bug-y.yaml'), 'steps: [');
    assert.equal(fixState(root, 'bug-y'), undefined);
});

test('fixState: an open at the entry of the red step passes without judging it and keeps the phase red', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-phase-open-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const run = (runId, result) => {
        const dir = join(root, '.caw', 'runs', runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
    };
    writeTest(root, red);
    run('2026-11-20T09-00-00-000Z-bug-x', { status: 'fail', results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'fail' }] });
    // What `caw open bug-x@S2` leaves: the steps before S2 passed, S2 itself was never judged. The bug is still there.
    run('2026-11-21T09-00-00-000Z-bug-x', { status: 'pass', results: [{ id: 'S1', status: 'pass' }] });
    assert.equal(fixState(root, 'bug-x').phase, 'red');
    // A run that judged the red step and passed it is the fix.
    run('2026-11-22T09-00-00-000Z-bug-x', { status: 'pass', results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'pass' }] });
    assert.equal(fixState(root, 'bug-x').phase, 'green');
});
