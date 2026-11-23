// The guided bug fix's phases: where a draft from caw reproduce stands and what comes next, as the session reads it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { designMet, designOf, designRed, designRedOf, deviationsOf, fixPhase, fixState, redOf, reproductionOf } from '../src/host/bugfix.mjs';
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

// A design draft: S1 and S2 lead to the screen, S3 is the step its design is for.
const designed = { id: 'S3', name: 'Notiz', do: 'Öffne die Notiz.', expect: 'Die Notiz ist zu sehen.', design: 'design/note.html' };
const designDraft = { id: 'note', draft: true, origin: 'design', writes: false, notes: '', steps: [stepOf('S1', 'Da.'), stepOf('S2', 'Liste.'), designed], expectations: [] };
const notMet = { file: 'design/note.html', verdict: 'not-met', missing: ['button "Save note"'], textDiffs: ['text: heading "Note" → "Notes"'], styleDiffs: [], layoutDiffs: ['gap button "Save" → block "Note": 19px → 43px'], extra: ['link "Hilfe"'] };
const met = { file: 'design/note.html', verdict: 'met', missing: [], textDiffs: [], styleDiffs: [], layoutDiffs: [], extra: [] };
const before = [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'pass' }];
// S3 pending: judged at its entry. Recorded: judged after its check, failing with kind design while not met.
const atEntry = (runId, judged, status = 'pass') => ({ runId, status, results: before, steps: [...before, { id: 'S3', status: 'pending' }], pendingDesign: { step: 'S3', ...judged } });
const afterCheck = (runId, judged) => ({ runId, status: judged.verdict === 'met' ? 'pass' : 'fail', results: [...before, { id: 'S3', status: judged.verdict === 'met' ? 'pass' : 'fail' }], steps: [...before, { id: 'S3', status: judged.verdict === 'met' ? 'pass' : 'fail', ...(judged.verdict === 'met' ? {} : { kind: 'design' }), design: judged }] });

test('designRed, designMet: the red step\'s design judged at its entry or after its check, everything before it passed', () => {
    assert.deepEqual(designOf(atEntry('r', notMet), 'S3'), { step: 'S3', ...notMet });
    assert.deepEqual(designOf(afterCheck('r', notMet), 'S3'), notMet);
    assert.equal(designOf({ results: before }, 'S3'), undefined, 'not judged');
    assert.deepEqual(deviationsOf(notMet), [
        { kind: 'missing', text: 'button "Save note"' },
        { kind: 'text', text: 'text: heading "Note" → "Notes"' },
        { kind: 'layout', text: 'gap button "Save" → block "Note": 19px → 43px' },
    ], 'controls only in the app fail nothing');
    assert.equal(designRed(designDraft, atEntry('r', notMet)), true);
    assert.equal(designRed(designDraft, afterCheck('r', notMet)), true);
    assert.equal(designMet(designDraft, atEntry('r', met)), true);
    assert.equal(designMet(designDraft, afterCheck('r', met)), true);
    // A step before it failed: proves nothing. The red step failed its check: neither red nor green by its design.
    assert.equal(designRed(designDraft, { ...atEntry('r', notMet), results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'fail' }] }), false);
    const checkFailed = afterCheck('r', notMet);
    checkFailed.steps[2] = { ...checkFailed.steps[2], kind: 'check' };
    assert.equal(designRed(designDraft, checkFailed), false);
    assert.equal(designRed({ ...designDraft, origin: undefined }, atEntry('r', notMet)), false, 'a draft from caw reproduce');
    assert.deepEqual(designRedOf(designDraft, atEntry('r', notMet)), {
        step: 'S3', name: 'Notiz', expect: 'Die Notiz ist zu sehen.', design: 'design/note.html',
        deviations: ['missing: button "Save note"', 'text: text: heading "Note" → "Notes"', 'layout: gap button "Save" → block "Note": 19px → 43px'],
    });
});

test('fixPhase of a design draft: draft until a run judged its design not met, red until a later run judged it met, green, adopted', () => {
    const record = { tool: 'caw_start', command: 'record', test: 'note', headless: true };
    const run = { tool: 'caw_start', command: 'run', test: 'note', headless: true };
    // Written, nothing recorded: record the steps up to the screen first.
    const unrecorded = { ...designDraft, steps: [{ ...designDraft.steps[0], recording: undefined }, designDraft.steps[1], designed] };
    assert.deepEqual(fixPhase({ id: 'note', draft: unrecorded }), { origin: 'design', phase: 'draft', next: record });
    // Recorded up to the screen, no step with a design yet: the person links it.
    assert.deepEqual(fixPhase({ id: 'note', draft: { ...designDraft, steps: designDraft.steps.slice(0, 2) } }), { origin: 'design', phase: 'draft', next: { do: 'link-design', test: 'note' } });
    // The design's step pending: a run judges it at its entry and proves it red.
    assert.deepEqual(fixPhase({ id: 'note', draft: designDraft }), { origin: 'design', phase: 'draft', next: run });
    const proven = { ...designDraft, red: { step: 'S3', run: '2026-11-23T09-00-00-000Z-note', head: 'abc1234' } };
    const redRun = atEntry('2026-11-23T09-00-00-000Z-note', notMet);
    const build = { do: 'build-design', red: designRedOf(proven, redRun), then: run, decision: 'fix.guide' };
    assert.deepEqual(fixPhase({ id: 'note', draft: proven, runs: [redRun] }), { origin: 'design', phase: 'red', next: build });
    // A later run that did not judge the design (an open) keeps the red run's deviations; one still not met shows its own.
    const opened = { runId: '2026-11-23T10-00-00-000Z-note', status: 'pass', results: before };
    assert.deepEqual(fixPhase({ id: 'note', draft: proven, runs: [opened, redRun] }).next.red.deviations.length, 3);
    const closer = atEntry('2026-11-23T11-00-00-000Z-note', { ...notMet, missing: [], textDiffs: [] });
    assert.deepEqual(fixPhase({ id: 'note', draft: proven, runs: [closer, opened, redRun] }).next.red.deviations, ['layout: gap button "Save" → block "Note": 19px → 43px']);
    // Met at its entry: green, and S3 is recorded next.
    const metRun = atEntry('2026-11-23T12-00-00-000Z-note', met);
    assert.deepEqual(fixPhase({ id: 'note', draft: proven, runs: [metRun, closer, redRun] }), { origin: 'design', phase: 'green', next: record });
    // Recorded and met after its check: green, adopt next.
    const recordedRed = { ...proven, steps: [proven.steps[0], proven.steps[1], { ...stepOf('S3', 'Die Notiz ist zu sehen.'), design: 'design/note.html' }] };
    assert.deepEqual(fixPhase({ id: 'note', draft: recordedRed, runs: [afterCheck('2026-11-23T13-00-00-000Z-note', met), metRun, redRun] }), { origin: 'design', phase: 'green', next: { tool: 'caw_start', command: 'run', test: 'note', promote: true, decision: 'fix.green' } });
    assert.equal(fixPhase({ id: 'note', draft: recordedRed, runs: [afterCheck('2026-11-23T14-00-00-000Z-note', notMet), metRun] }).phase, 'red', 'not met again after its check');
    // Adopted: the design report names it.
    assert.deepEqual(fixPhase({ id: 'note', promoted: true, designReport: '.caw/runs/r/design-report.md' }), { origin: 'design', phase: 'adopted', next: { done: true, designReport: '.caw/runs/r/design-report.md' } });
});

test('fixState of a design draft: runs from disk with their judged designs; adopted once caw/tests has it and its run the design report', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-design-phase-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const run = (runId, result, files = {}) => {
        const dir = join(root, '.caw', 'runs', runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
        for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    };
    writeTest(root, designDraft);
    assert.equal(fixState(root, 'note').phase, 'draft');
    writeTest(root, { ...designDraft, red: { step: 'S3', run: '2026-11-23T09-00-00-000Z-note' } });
    // result.json has no runId: the folder names the run.
    const withoutId = ({ runId: _id, ...rest }) => rest;
    const result = (runId, judged) => withoutId(atEntry(runId, judged));
    run('2026-11-23T09-00-00-000Z-note', result('2026-11-23T09-00-00-000Z-note', notMet));
    const redState = fixState(root, 'note');
    assert.equal(redState.phase, 'red');
    assert.equal(redState.next.red.deviations.length, 3);
    run('2026-11-23T10-00-00-000Z-note', result('2026-11-23T10-00-00-000Z-note', met), { 'design-report.md': '# Zielbild-Bericht' });
    assert.equal(fixState(root, 'note').phase, 'green');
    rmSync(join(root, 'caw', 'drafts', 'note.yaml'));
    writeTest(root, { ...designDraft, draft: undefined, origin: undefined });
    assert.deepEqual(fixState(root, 'note'), { origin: 'design', phase: 'adopted', next: { done: true, designReport: '.caw/runs/2026-11-23T10-00-00-000Z-note/design-report.md' } });
});
