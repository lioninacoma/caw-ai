// Old run folders go when a run starts: the newest keepRuns stay, an open run always stays.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { markRunAlive, pruneRuns } from '../src/host/runs.mjs';
import { validateConfig } from '../src/shared/config.mjs';

test('runs: the oldest beyond keepRuns go, an open one and the starting one stay, 0 keeps all', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-runs-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runs = join(root, '.caw', 'runs');
    const names = Array.from({ length: 6 }, (_, i) => `2026-11-1${i}T10-00-00-000Z-open`);
    for (const name of names) mkdirSync(join(runs, name), { recursive: true });
    markRunAlive(join(runs, names[0]));
    markRunAlive(join(runs, names[1]), 2 ** 22 + 4321);
    assert.deepEqual(pruneRuns(root, 0), [], '0 keeps every run');
    assert.deepEqual(pruneRuns(root, 2, { except: names[2] }), [names[1], names[3]], 'the open one (this process) and the starting one stay, a dead process does not count');
    assert.deepEqual(readdirSync(runs).sort(), [names[0], names[2], names[4], names[5]]);
    assert.deepEqual(pruneRuns(join(root, 'nothing'), 2), [], 'no runs folder yet');
});

test('runs: a reproduction whose draft is still in caw/drafts stays, it holds the cause; once the draft is gone it may go', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-runs-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runs = join(root, '.caw', 'runs');
    const reproduction = '2026-11-10T10-00-00-000Z-reproduce';
    const names = [reproduction, '2026-11-11T10-00-00-000Z-reproduce', '2026-11-12T10-00-00-000Z-open', '2026-11-13T10-00-00-000Z-open'];
    for (const name of names) mkdirSync(join(runs, name), { recursive: true });
    writeFileSync(join(runs, reproduction, 'result.json'), JSON.stringify({ status: 'pass', reproduce: { reproduced: 'yes', draft: { file: 'caw/drafts/bug-x.yaml' } } }));
    mkdirSync(join(root, 'caw', 'drafts'), { recursive: true });
    writeFileSync(join(root, 'caw', 'drafts', 'bug-x.yaml'), 'steps: []\n');
    assert.deepEqual(pruneRuns(root, 1), [names[1], names[2]]);
    rmSync(join(root, 'caw', 'drafts', 'bug-x.yaml'));
    assert.deepEqual(pruneRuns(root, 1), [reproduction]);
});

test('runs: the red run a draft names (red.run) stays while the draft is there: the design report counts its deviations from it', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-runs-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runs = join(root, '.caw', 'runs');
    const red = '2026-11-10T10-00-00-000Z-note';
    const names = [red, '2026-11-11T10-00-00-000Z-note', '2026-11-12T10-00-00-000Z-open'];
    for (const name of names) mkdirSync(join(runs, name), { recursive: true });
    mkdirSync(join(root, 'caw', 'drafts'), { recursive: true });
    writeFileSync(join(root, 'caw', 'drafts', 'note.yaml'), `# a comment\nid: note\nred: {step: S2, run: ${red}, head: abc1234}\nsteps: []\n`);
    writeFileSync(join(root, 'caw', 'drafts', 'broken.yaml'), 'red: [unclosed\n');
    assert.deepEqual(pruneRuns(root, 1), [names[1]]);
    rmSync(join(root, 'caw', 'drafts', 'note.yaml'));
    assert.deepEqual(pruneRuns(root, 1), [red]);
});

test('runs: a run with a fix or design report stays, and so does the reproduction its test came from, until the person deletes them', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-runs-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runs = join(root, '.caw', 'runs');
    const reproduction = '2026-11-10T10-00-00-000Z-reproduce';
    const other = '2026-11-10T11-00-00-000Z-reproduce';
    const fixed = '2026-11-11T10-00-00-000Z-bug-x';
    const designed = '2026-11-12T10-00-00-000Z-note';
    const plain = '2026-11-13T10-00-00-000Z-bug-x';
    const names = [reproduction, other, fixed, designed, plain, '2026-11-14T10-00-00-000Z-open'];
    for (const name of names) mkdirSync(join(runs, name), { recursive: true });
    writeFileSync(join(runs, reproduction, 'result.json'), JSON.stringify({ status: 'pass', reproduce: { reproduced: 'yes', draft: { file: 'caw/drafts/bug-x.yaml' } } }));
    writeFileSync(join(runs, other, 'result.json'), JSON.stringify({ status: 'pass', reproduce: { reproduced: 'yes', draft: { file: 'caw/drafts/bug-y.yaml' } } }));
    writeFileSync(join(runs, fixed, 'fix-report.md'), '# Fix report: bug-x\n');
    writeFileSync(join(runs, designed, 'design-report.md'), '# Design report: note\n');
    assert.deepEqual(pruneRuns(root, 1), [other, plain]);
    assert.deepEqual(readdirSync(runs).sort(), [reproduction, fixed, designed, names[5]]);
});

test('runs: keepRuns is a whole number from 0', () => {
    const base = { environments: { local: { url: 'http://localhost:5173' } } };
    for (const keepRuns of [0, 30]) assert.ok(!validateConfig({ ...base, keepRuns }).issues.some((issue) => /keepRuns/.test(issue)), String(keepRuns));
    for (const keepRuns of [-1, 2.5, '30']) assert.ok(validateConfig({ ...base, keepRuns }).issues.some((issue) => /keepRuns muss/.test(issue)), String(keepRuns));
});
