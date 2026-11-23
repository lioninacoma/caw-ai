import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertPlayable, buildReplay, cutReplay, groupSteps, missingRemembered, replayBefore, replayOf, replayToEntry, replayUpToStale, trailingNumbers } from '../src/host/replay.mjs';
import { brokenChain, checkRedStep, draftIds, draftPath, humanFields, isDesignDraft, loadDraft, loadTest, parsePlan, parseRecordings, parseTest, pendingSteps, recordingHints, recordingPath, redStep, renderPlan, renderTest, setStepDesign, setStepLooks, staleSteps, stepHash, testExists, testPath, writeTest } from '../src/host/test-file.mjs';
import { composeTest, planView, readPlan, replaceStep } from '../src/host/test-plan.mjs';
import { learningPath, withLearning } from '../src/host/learning.mjs';

const NEXT = "getByRole('button', { name: 'Next', exact: true })";
const plain = (id, extra = {}) => ({ id, name: `Step ${id}`, do: `Do ${id}`, expect: `${id} is there`, ...extra });
const recorded = (id, actions = [], { after, check = `check${id}()` } = {}) => {
    const step = plain(id);
    return { ...step, recording: { hash: stepHash(step), ...(after === undefined ? {} : { after }), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions, check } };
};
const meta = { id: 't', role: 'r', environments: ['a/dev'], writes: true, notes: '' };
const spec = (...steps) => composeTest(meta, { notes: '', steps });

const YAML = `id: t
role: r
environments: [a/dev, a/test]
writes: false
# Human comment
steps:
  - id: S1
    name: First
    do: |
      Do something.
      And something else.
    expect: There.
  - id: S2
    name: Second
    do: ""
    expect: Also there.
    note: Check only.
`;

test('test file: a valid file is read, the expectations are the steps', () => {
    const parsed = parseTest(YAML);
    assert.equal(parsed.code, undefined, 'without code the default applies');
    assert.equal(parsed.writes, false);
    assert.deepEqual(parsed.expectations, [{ id: 'S1', text: 'There.' }, { id: 'S2', text: 'Also there.' }]);
    assert.equal(parsed.steps[0].do, 'Do something.\nAnd something else.');
    assert.equal(parsed.steps[1].do, '');
    assert.equal(parseTest(YAML.replaceAll('\n', '\r\n')).steps.length, 2);
});

test('retry: read, written, and not part of the hash', () => {
    const withRetry = YAML.replace('    note: Check only.\n', '    note: Check only.\n    retry: {times: 2, waitMs: 5000, from: S1}\n');
    const parsed = parseTest(withRetry);
    assert.deepEqual(parsed.steps[1].retry, { times: 2, waitMs: 5000, from: 'S1' });
    assert.equal(stepHash(parsed.steps[1]), stepHash({ ...parsed.steps[1], retry: undefined }));
    assert.match(renderTest(parsed), /retry: \{times: 2, waitMs: 5000, from: S1\}/);
    assert.deepEqual(parseTest(renderTest(parsed)).steps[1].retry, parsed.steps[1].retry);
    assert.deepEqual(parsePlan(renderPlan(parsed)).plan.steps[1].retry, parsed.steps[1].retry);
    assert.deepEqual(replayOf(spec({ ...recorded('S1'), retry: { times: 1 } }, recorded('S2'))).retries, { S1: { times: 1 } });
});

test('retry: invalid values are rejected', () => {
    for (const [value, pattern] of [
        ['{waitMs: 5}', /times/],
        ['{times: 0}', /times/],
        ['{times: 11}', /times/],
        ['{times: 1, waitMs: -1}', /waitMs/],
        ['{times: 1, von: S1}', /Unbekanntes Feld von/],
        ['{times: 1, from: S9}', /retry\.from S9/],
        ['3', /retry muss/],
    ]) {
        assert.throws(() => parseTest(YAML.replace('    note: Check only.\n', `    note: Check only.\n    retry: ${value}\n`)), pattern, value);
    }
    const later = YAML.replace('    expect: There.\n', '    expect: There.\n    retry: {times: 1, from: S2}\n');
    assert.throws(() => parseTest(later), /retry\.from S2/);
});

test('test file: every shape violation is rejected with its line', () => {
    const cases = [
        [YAML.replace('writes: false', 'writes: maybe'), /Zeile 4: writes/],
        [YAML.replace('role: r', 'role: r\nextra: 1'), /Zeile 3: Unbekanntes Feld extra/],
        // Fields from before 1.0 are unknown like any other.
        [YAML.replace('role: r', 'role: r\napp: web'), /Zeile 3: Unbekanntes Feld app/],
        [YAML.replace('role: r', 'role: r\nalso: [admin]'), /Zeile 3: Unbekanntes Feld also/],
        [YAML.replace('role: r', 'role: r\nstart: orders'), /Zeile 3: start muss ein Pfad sein, der mit \/ beginnt/],
        [YAML.replace('role: r', 'role: r\nstart: //cdn.example/x'), /start muss ein Pfad sein/],
        [YAML.replace('- id: S2', '- id: S1'), /S1 ist doppelt/],
        [YAML.replace('- id: S2', '- id: 2'), /ID muss wie S1/],
        [YAML.replace('- id: S2', '- id: S2\n    foo: bar'), /Unbekanntes Feld foo im Schritt/],
        [YAML.replace('    expect: Also there.\n', ''), /expect fehlt/],
        [YAML.replace('    do: ""\n', ''), /do fehlt/],
        [YAML.replace('environments: [a/dev, a/test]', 'environments: []'), /environments muss eine nicht leere Liste/],
        [YAML.replace('environments: [a/dev, a/test]', 'environment: [a/dev]'), /Unbekanntes Feld environment\. Meintest du environments\?/],
        // Names from before 1.0, unknown like any other.
        [YAML.replace('environments: [a/dev, a/test]', 'targets: [a/dev]'), /Unbekanntes Feld targets/],
        [YAML.replace('writes: false', 'mutates: false'), /Unbekanntes Feld mutates/],
        [YAML.replace('    expect: There.', '    expected: There.'), /Unbekanntes Feld expected im Schritt\. Meintest du expect\?/],
        [YAML.replace('writes: false', 'source: watch\nwrites: false'), /Unbekanntes Feld source/],
        [YAML.replace('writes: false', 'code: deployed\nwrites: false'), /Unbekanntes Feld code/],
        [YAML.replace('writes: false\n', ''), /writes fehlt: true, wenn der Test Daten anlegt oder ändert \(läuft nur auf Umgebungen mit writable: true\), false, wenn er nur liest\./],
        ['not: [yaml', /Zeile/],
        ['- just\n- a list\n', /Objekt/],
        [YAML.replace('role: r', 'role: r\nrole: x'), /Zeile/],
        [YAML.replace('role: r', 'role: !!js/function x'), /Zeile/],
        [`${YAML}---\nid: second\n`, /Zeile/],
        [YAML.replace('expect: There.', 'expect: &m There.').replace('expect: Also there.', 'expect: *m'), /Aliase/],
    ];
    for (const [text, reason] of cases) assert.throws(() => parseTest(text, 'x.yaml'), (error) => error.code === 'test-invalid' && reason.test(error.message), String(reason));
});

test('test file: recordings are read strictly', () => {
    const withActions = (actions) => renderTest(spec(recorded('S1', actions)));
    const round = parseTest(withActions([
        { action: 'wait-ready' },
        { action: 'click', target: NEXT, path: '/a' },
        { action: 'fill', target: "getByRole('dialog', { name: 'New todo' }).getByRole('textbox', { name: 'Title' })", value: '' },
        { action: 'press', key: 'Tab' },
        { action: 'goto', url: 'https://x/', denied: true },
        { action: 'reload' },
        { action: 'remember', name: 'nr', code: 'x()' },
        { action: 'screenshot', name: 'a.png' },
    ]));
    assert.deepEqual(round.steps[0].recording.actions[1], { action: 'click', target: NEXT, path: '/a' });
    assert.equal(round.steps[0].recording.actions[2].value, '');
    assert.equal(round.steps[0].recording.actions[3].key, 'Tab');
    assert.equal(round.steps[0].recording.actions[4].denied, true);
    assert.equal(round.steps[0].recording.actions[6].name, 'nr');

    const bad = renderTest(spec(recorded('S1', [{ action: 'reload' }])));
    assert.throws(() => parseTest(bad.replace('reload: {}', 'cdp: {}')), /genau eine/);
    assert.throws(() => parseTest(bad.replace('check: checkS1()', '')), /recording.check/);
    assert.throws(() => parseTest(bad.replace('reload: {}', 'click: {role: button}')), /Playwright-Locator/);
    assert.throws(() => parseTest(bad.replace('reload: {}', 'click: "getByRole(\'button\'"')), /click: Locator/);
    assert.throws(() => parseTest(bad.replace('reload: {}', 'click: aria-ref=e5')), /click: Locator/);
    assert.throws(() => parseTest(bad.replace('recordedOn:', 'foreign: 1\n      recordedOn:')), /Unbekanntes Feld foreign/);
    // A line break in a goto URL would end the comment the export writes for a refused one and start code.
    for (const url of ['https://x/\nprocess.exit(1)//', 'https://x/\rx', `https://x/${String.fromCharCode(0x2028)}x`]) {
        assert.throws(() => parseTest(withActions([{ action: 'goto', url, denied: true }])), /keinen Zeilenumbruch/, JSON.stringify(url));
    }
});

test('plan: Claude cannot set recordings or metadata', () => {
    const { plan, problems } = parsePlan(`id: other\nrole: admin\nnotes: Note\nsteps:\n  - id: S1\n    name: A\n    do: b\n    expect: c\n    recording: { hash: x, actions: [], check: "true" }\n`);
    assert.deepEqual(problems, []);
    assert.equal(plan.notes, 'Note');
    assert.deepEqual(plan.steps, [{ id: 'S1', name: 'A', do: 'b', expect: 'c' }]);
    const composed = composeTest(meta, plan);
    assert.equal(composed.role, 'r');
    assert.equal(composed.steps[0].recording, undefined);
    assert.match(readPlan('steps:\n  - id: S1\n    name: A\n    do: b\n    expect: doctor@example.org\n').problems.join(' '), /E-Mail/);
    assert.match(readPlan('steps: []\n').problems.join(' '), /nichtleere/);
    assert.match(readPlan('steps:\n  - id: S1\n    name: A\n    expect: c\n').problems.join(' '), /Zeile 2: do fehlt/);
    assert.equal(parseTest(renderTest(composed)).steps[0].name, 'A');
    assert.deepEqual(parsePlan(renderPlan(composed)).plan.steps, composed.steps);
});

test('plan card: plan fields only, a changed expectation is marked', () => {
    const before = recorded('S1');
    const previous = new Map([['S1', before], ['S2', recorded('S2')]]);
    const view = planView({ notes: 'n', steps: [{ ...plain('S1'), expect: 'Different' }] }, { repairing: true, previous });
    assert.deepEqual(view.steps[0], { id: 'S1', name: 'Step S1', do: 'Do S1', expect: 'Different', previousExpect: 'S1 is there' });
    assert.equal(view.notes, '');
    assert.equal(planView({ notes: 'n', steps: [plain('S1')] }, { repairing: true, previous }).steps[0].previousExpect, undefined);
    // Re-recorded from a step on: each step against its own old expectation, a new step has none.
    const range = planView({ steps: [{ ...plain('S2'), expect: 'Other' }, plain('S1'), plain('S5')] }, { repairing: true, rerecord: true, from: 'S2', previous });
    assert.equal(range.title, 'Ab S2 neu aufnehmen');
    assert.deepEqual(range.steps.map(({ previousExpect }) => previousExpect), ['S2 is there', undefined, undefined]);
    assert.equal(planView({ notes: 'n', steps: [plain('S1')] }).notes, 'n');
});

test('hash: per step, metadata and recording do not count', () => {
    const step = plain('S1');
    assert.equal(stepHash(step), stepHash({ ...step, expect: `${step.expect}\n` }), 'block or single line makes no difference');
    for (const field of ['name', 'do', 'expect', 'note']) assert.notEqual(stepHash(step), stepHash({ ...step, [field]: 'different' }), field);
    const changed = spec(recorded('S1'), { ...recorded('S2'), do: 'changed by hand' }, recorded('S3'));
    assert.deepEqual(staleSteps(changed).map(({ id }) => id), ['S2']);
    assert.deepEqual(staleSteps(spec(plain('S1'))).map(({ why }) => why), ['hat keine Aufzeichnung']);
});

test('stale: the steps before it still play, the full run suggests re-recording from the stale step', () => {
    const changed = spec(recorded('S1'), recorded('S2', [], { after: 'S1' }), { ...recorded('S3', [], { after: 'S2' }), do: 'new' });
    assertPlayable(changed, 'a/dev', 'S2');
    assert.throws(() => assertPlayable(changed, 'a/dev'), (error) => error.code === 'replay-stale' && /S3 .*Neu aufnehmen ab dort: caw record t@S3 --env a\/dev$/.test(error.message));
    assert.throws(() => assertPlayable(spec(plain('S1')), 'a/dev'), (error) => error.code === 'replay-missing' && /record t/.test(error.message));
});

test('pending: only the unrecorded tail after a recorded step; gaps, stale steps and nothing recorded stay as they were', () => {
    const click = { action: 'click', target: NEXT };
    const building = spec(recorded('S1', [click]), recorded('S2', [], { after: 'S1' }), plain('S3'), plain('S4'));
    assert.deepEqual(pendingSteps(building), ['S3', 'S4']);
    assert.deepEqual(pendingSteps(spec(plain('S1'), plain('S2'))), [], 'nothing recorded: nothing pending, record the test');
    assert.deepEqual(pendingSteps(spec(recorded('S1'), plain('S2'), recorded('S3'))), [], 'a gap is no tail');
    assert.deepEqual(pendingSteps(spec(recorded('S1'), recorded('S2'))), []);
    // run: plays up to S2 and passes; --strict (no pending allowed) names the tail and the command that records it.
    assertPlayable(building, 'a/dev', undefined, { pending: true });
    assert.throws(() => assertPlayable(building, 'a/dev'), (error) => error.code === 'replay-pending' && /^S3, S4 von t offen, noch nicht aufgenommen; mit --strict .*caw record t@S3 --env a\/dev$/.test(error.message));
    // The rest keeps exit 4: a gap, a step changed after recording before the tail, nothing recorded.
    assert.throws(() => assertPlayable(spec(recorded('S1'), plain('S2'), recorded('S3')), 'a/dev', undefined, { pending: true }), (error) => error.code === 'replay-stale' && /^S2 hat keine Aufzeichnung/.test(error.message));
    assert.throws(() => assertPlayable(spec({ ...recorded('S1'), do: 'edited' }, plain('S2')), 'a/dev', undefined, { pending: true }), (error) => error.code === 'replay-stale' && /^S1 wurde nach der Aufzeichnung geändert/.test(error.message));
    assert.throws(() => assertPlayable(spec(plain('S1'), plain('S2')), 'a/dev', undefined, { pending: true }), (error) => error.code === 'replay-missing');
    // open @S4 behind the pending S3: S3 gets recorded first.
    assert.throws(() => assertPlayable(building, 'a/dev', 'S3'), (error) => error.code === 'replay-stale' && /^S3 ist offen, noch nicht aufgenommen\. Nimm ihn zuerst auf: caw record t@S3 --env a\/dev$/.test(error.message));
    // The replay stops after the last recorded step: `until` limits the verdict to S1 and S2, `pending` names the rest.
    const replay = replayOf(building);
    assert.equal(replay.until, 'S2');
    assert.deepEqual(replay.pending, ['S3', 'S4']);
    assert.deepEqual(replay.steps.map(({ action, id }) => id ?? action), ['click', 'S1', 'S2']);
    assert.equal(replayOf(spec(recorded('S1'), recorded('S2'))).pending, undefined, 'fully recorded: as before');
    // open @S3 with S3 the first pending step: everything up to S2 runs, nothing of S3.
    const entry = replayToEntry(building, 'S3');
    assert.equal(entry.until, 'S2');
    assert.equal(entry.entry.skipped, 'recording');
    assert.deepEqual(entry.steps.map(({ action, id }) => id ?? action), ['click', 'S1', 'S2']);
});

test('deleted or moved steps require re-recording, inserted ones do not', () => {
    const [s1, s2, s3] = [recorded('S1'), recorded('S2', [], { after: 'S1' }), recorded('S3', [], { after: 'S2' })];
    assert.equal(brokenChain(spec(s1, s2, s3)), null);
    assert.match(brokenChain(spec(s1, s3)), /S3 baut auf S2/);
    assert.match(brokenChain(spec(s1, s3, s2)), /S3 baut auf S2/);
    assert.equal(brokenChain(spec(s1, plain('S4'), s2, s3)), null);
    assert.throws(() => assertPlayable(spec(s1, s3), 'a/dev'), (error) => error.code === 'replay-stale' && /S3 baut auf S2.*caw record t@S3 --env a\/dev$/.test(error.message));
});

test('replay form: actions and check in sequence, cut per step', () => {
    const click = { action: 'click', target: NEXT };
    const whole = spec(recorded('S1', [click]), recorded('S2', [{ action: 'reload' }], { after: 'S1' }), recorded('S3', [], { after: 'S2' }));
    assert.deepEqual(replayOf(whole).steps.map(({ action, id }) => id ?? action), ['click', 'S1', 'reload', 'S2', 'S3']);
    const cut = cutReplay(whole, 'S2');
    assert.equal(cut.until, 'S2');
    assert.deepEqual(cut.steps.map(({ action, id }) => id ?? action), ['click', 'S1', 'reload', 'S2']);
    assert.throws(() => cutReplay(whole, 'S9'), { code: 'step-unknown' });
    assert.deepEqual(replayBefore(whole, 'S2').steps.map(({ action, id }) => id ?? action), ['click', 'S1']);
    assert.deepEqual(replayBefore(whole, 'S1').steps, []);
    const partly = spec(recorded('S1', [click]), { ...recorded('S2', [], { after: 'S1' }), do: 'new' });
    assert.equal(replayUpToStale(partly).until, 'S1');
    assert.equal(replayUpToStale(whole).until, undefined);
});

test('grouping: actions belong to the next check, re-checked steps stay one step', () => {
    const click = { action: 'click', target: NEXT };
    const { groups, trailing } = groupSteps([
        click,
        { action: 'check', id: 'S1', code: 'a' },
        { action: 'reload' },
        { action: 'check', id: 'S2', code: 'b' },
        { action: 'press', key: 'Tab' },
        { action: 'check', id: 'S2', code: 'c' },
        { action: 'wait-ready' },
    ]);
    assert.deepEqual(groups.get('S1'), { actions: [click], check: 'a' });
    assert.deepEqual(groups.get('S2'), { actions: [{ action: 'reload' }, { action: 'press', key: 'Tab' }], check: 'c' });
    assert.deepEqual(trailing, [{ action: 'wait-ready' }]);
    assert.deepEqual(trailingNumbers([click, { action: 'check', id: 'S1', code: 'a' }, { action: 'reload' }]), [3]);
    assert.deepEqual(trailingNumbers([click, { action: 'reload' }]), [1, 2], 'without a check nothing belongs to a step');
});

test('buildReplay: recording yields one recording per step', () => {
    const recorder = { problems: [], messages: new Set(['Yes No']), steps: [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'a' }, { action: 'check', id: 'S2', code: 'b' }] };
    const plan = spec(plain('S1'), plain('S2'));
    const { candidate } = buildReplay({ recorder, outcome: { status: 'pass' }, spec: plan, target: 'a/dev', now: new Date(0) });
    assert.deepEqual(candidate.steps[0].recording, { hash: stepHash(plan.steps[0]), recordedOn: 'a/dev', recordedAt: '1970-01-01T00:00:00.000Z', actions: [{ action: 'reload' }], check: 'a' });
    assert.equal(candidate.steps[1].recording.after, 'S1');
    assert.deepEqual(candidate.knownMessages, ['Yes No']);
    assert.match(buildReplay({ recorder, outcome: { status: 'fail' }, spec: plan, target: 'x' }).problems[0], /fail/);
    assert.match(buildReplay({ recorder: { ...recorder, steps: recorder.steps.slice(0, 2) }, outcome: { status: 'pass' }, spec: plan, target: 'x' }).problems[0], /S2/);
    assert.match(buildReplay({ recorder: { ...recorder, steps: [...recorder.steps, { action: 'reload' }] }, outcome: { status: 'pass' }, spec: plan, target: 'x' }).problems[0], /Nach der letzten Prüfung/);
    assert.match(buildReplay({ recorder: { ...recorder, problems: ['broken'] }, outcome: { status: 'pass' }, spec: plan, target: 'x' }).problems[0], /broken/);
});

test('buildReplay when fixing: only this step changes, new messages are reported', () => {
    const draft = { ...spec(recorded('S1'), recorded('S2', [], { after: 'S1' }), recorded('S3', [], { after: 'S2' })), knownMessages: ['Known'] };
    const changed = { ...plain('S2'), do: 'different' };
    const recorder = { problems: [], messages: new Set(['New']), steps: [{ action: 'reload' }, { action: 'check', id: 'S2', code: 'new' }] };
    const { candidate, fresh } = buildReplay({ recorder, outcome: { status: 'pass' }, spec: spec(changed), draft, target: 'a/dev' });
    assert.equal(candidate.steps[0], draft.steps[0]);
    assert.equal(candidate.steps[2], draft.steps[2]);
    assert.equal(candidate.steps[1].do, 'different');
    assert.equal(candidate.steps[1].recording.after, 'S1');
    assert.equal(candidate.steps[1].recording.hash, stepHash(changed));
    assert.deepEqual(fresh, ['New']);
    assert.deepEqual(candidate.knownMessages, ['Known', 'New']);
    assert.deepEqual(staleSteps(candidate), []);
});

test('buildReplay from a step on: the steps before stay, the range replaces the rest, hand-set values survive per step', () => {
    const network = [{ name: 'GET /a', status: 200, ms: 1, count: 1 }];
    const effects = { runs: 2, actions: [] };
    const first = { ...recorded('S1', [{ action: 'remember', name: 'nr', code: 'x()', secret: true }]), retry: { times: 1 } };
    first.recording = { ...first.recording, network, effects };
    const second = recorded('S2', [], { after: 'S1' });
    second.recording = { ...second.recording, timeoutMs: 9000, network, effects };
    const draft = { ...spec(first, second, recorded('S3', [], { after: 'S2' }), recorded('S4', [], { after: 'S3' })), knownMessages: ['Known'] };
    // Claude re-records from S2: S2 unchanged, S3 removed, S5 new; S4 now comes before S5.
    const range = spec(plain('S2'), { ...plain('S4'), expect: 'changed' }, plain('S5'));
    const recorder = { problems: [], messages: new Set(), steps: [
        { action: 'remember', name: 'nr', code: 'y()' }, { action: 'check', id: 'S2', code: 'b' },
        { action: 'check', id: 'S4', code: 'd' },
        { action: 'check', id: 'S5', code: 'e' },
    ] };
    const { candidate, problems } = buildReplay({ recorder, outcome: { status: 'pass' }, spec: range, draft, from: 'S2', target: 'a/dev' });
    assert.deepEqual(problems, []);
    assert.deepEqual(candidate.steps.map(({ id }) => id), ['S1', 'S2', 'S4', 'S5']);
    assert.equal(candidate.steps[0], draft.steps[0], 'the step before stays as it is, baselines and effects included');
    assert.deepEqual(candidate.steps.slice(1).map(({ recording }) => recording.after), ['S1', 'S2', 'S4'], 'the first new step builds on the last kept one');
    assert.deepEqual(candidate.steps.slice(1).map(({ recording }) => [recording.network, recording.effects]), [[undefined, undefined], [undefined, undefined], [undefined, undefined]], 'learned anew on the next healthy run');
    assert.equal(candidate.steps[1].recording.timeoutMs, 9000, 'same expectation: the hand-set check timeout stays');
    assert.equal(candidate.steps[1].recording.actions[0].secret, true, 'a value marked secret stays secret');
    assert.deepEqual(candidate.expectations.map(({ id }) => id), ['S1', 'S2', 'S4', 'S5']);
    assert.deepEqual(candidate.knownMessages, ['Known']);
    assert.deepEqual(staleSteps(candidate), []);
});

test('remember: a value needed later must not be lost when fixing', () => {
    const remembers = recorded('S1', [{ action: 'remember', name: 'nr', code: 'x()' }]);
    const uses = recorded('S2', [{ action: 'fill', target: NEXT, value: '{{nr}}' }], { after: 'S1', check: "x === '{{nr}} {{runTag}}'" });
    const draft = spec(remembers, uses);
    assert.deepEqual(missingRemembered(draft), []);
    assert.match(missingRemembered(spec(recorded('S1'), uses))[0], /S2 needs \{\{nr\}\}/);
    const recorder = { problems: [], steps: [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'a' }] };
    const built = buildReplay({ recorder, outcome: { status: 'pass' }, spec: spec(plain('S1')), draft, target: 'a/dev' });
    assert.equal(built.candidate, undefined);
    assert.match(built.problems[0], /S2 needs \{\{nr\}\}/);
});

const testRoot = (t, text) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-file-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    if (text !== undefined) writeFileSync(testPath(root, 't'), text);
    return root;
};

test('writing: only the fixed step changes, comments and other steps stay', (t) => {
    const original = `# Header by the human
id: t
role: r
environments: [a/dev]
writes: true
notes: |
  Stays.

steps:
  # Above the first
  - id: S1
    name:   First   # oddly indented
    do: ""
    expect: There.
  # Above the second
  - id: S2
    name: Second
    do: old
    expect: Also there.
`;
    const root = testRoot(t, original);
    const loaded = loadTest(root, 't');
    const fixed = { ...loaded.steps[1], do: 'new', recording: { hash: 'h', after: 'S1', recordedOn: 'a/dev', recordedAt: 'z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [{ action: 'click', target: NEXT, path: '/a' }, { action: 'fill', target: NEXT, value: '' }], check: 'x()' } };
    const relative = writeTest(root, { ...replaceStep(loaded, fixed), knownMessages: ['Yes No'] }, new Set(['S2']));
    assert.equal(relative, 'caw/tests/t.yaml, caw/recordings/t.yaml');
    const text = readFileSync(testPath(root, 't'), 'utf8');
    assert.ok(text.startsWith('# Header by the human\n'));
    assert.match(text, /# Above the first/);
    assert.match(text, /# oddly indented/);
    assert.match(text, /# Above the second\n {2}- id: S2/);
    assert.match(text, /Stays\./);
    assert.doesNotMatch(text, /recording|knownMessages/, 'the description stays without recordings');
    assert.match(readFileSync(recordingPath(root, 't'), 'utf8'), /- \{click: "getByRole\('button', \{ name: 'Next', exact: true \}\)", path: \/a\}/, 'one action per line');
    const read = loadTest(root, 't');
    assert.equal(read.steps[0].recording, undefined);
    assert.equal(read.steps[1].do, 'new');
    assert.equal(read.steps[1].recording.actions[1].value, '');
    assert.deepEqual(read.knownMessages, ['Yes No']);
});

test('known messages per step: a step\'s recording keeps the messages it made known (known), knownMessages only the rest; read back the test knows both', (t) => {
    const root = testRoot(t);
    const first = recorded('S1');
    const second = recorded('S2', [], { after: 'S1' });
    const given = { ...spec({ ...first, recording: { ...first.recording, known: ['Willkommen'] } }, { ...second, recording: { ...second.recording, known: ['Archived', 'Willkommen'] } }),
        knownMessages: ['Archived', 'Von Hand', 'Willkommen', { pattern: '^Prüfsumme \\S+$' }] };
    writeTest(root, given);
    const file = readFileSync(recordingPath(root, 't'), 'utf8');
    assert.match(file, / {4}check: checkS1\(\)\n {4}known:\n {6}- Willkommen\n {2}- id: S2\n/);
    assert.match(file, / {4}check: checkS2\(\)\n {4}known:\n {6}- Archived\n {6}- Willkommen\nknownMessages:\n {2}- Von Hand\n {2}- pattern: \^Prüfsumme \\S\+\$\n$/, 'each message once: the steps\' in the steps');
    const read = loadTest(root, 't');
    assert.deepEqual(read.knownMessages, ['Archived', 'Von Hand', 'Willkommen', { pattern: '^Prüfsumme \\S+$' }]);
    assert.deepEqual(read.steps.map(({ recording }) => recording.known), [['Willkommen'], ['Archived', 'Willkommen']]);
    assert.equal(writeTest(root, read), 'keine Änderung', 'stable when written again');
    // Only from the steps: no knownMessages in the file, the test still knows them.
    writeTest(root, { ...given, knownMessages: ['Archived', 'Willkommen'] });
    assert.doesNotMatch(readFileSync(recordingPath(root, 't'), 'utf8'), /knownMessages/);
    assert.deepEqual(loadTest(root, 't').knownMessages, ['Archived', 'Willkommen']);
    assert.throws(() => parseRecordings('test: t\nsteps:\n  - id: S1\n    hash: h\n    recordedOn: a\n    recordedAt: z\n    locale: de-DE\n    timezone: Europe/Berlin\n    actions: []\n    check: x()\n    known: [{pattern: x}]\n'), /known/);
});

test('two files: effects still learning stay in .caw/learning; frozen, only the recording changes', (t) => {
    const root = testRoot(t);
    const whole = spec(recorded('S1'), recorded('S2', [], { after: 'S1' }));
    writeTest(root, whole);
    const description = readFileSync(testPath(root, 't'), 'utf8');
    const withRuns = (runs) => ({ ...whole, steps: [whole.steps[0], { ...whole.steps[1], recording: { ...whole.steps[1].recording, effects: { runs, actions: [{ action: 1, controls: ['+ x'] }] } } }] });
    assert.equal(writeTest(root, withRuns(1), new Set(['S2'])), 'keine Änderung');
    assert.equal(loadTest(root, 't').steps[1].recording.effects, undefined, 'the recording does not get a learning state');
    assert.equal(withLearning(root, loadTest(root, 't')).steps[1].recording.effects.runs, 1);
    assert.equal(writeTest(root, withRuns(5), new Set(['S2'])), 'caw/recordings/t.yaml');
    assert.equal(readFileSync(testPath(root, 't'), 'utf8'), description);
    assert.equal(loadTest(root, 't').steps[1].recording.effects.runs, 5);
    assert.equal(existsSync(learningPath(root, 't')), false, 'frozen, nothing is left to learn');
    assert.equal(writeTest(root, withRuns(5), new Set(['S2'])), 'keine Änderung');
});

test('two files: a look still learning stays in .caw/learning; frozen or adopted it goes into the recording, once', (t) => {
    const root = testRoot(t);
    const whole = spec(recorded('S1'), recorded('S2', [], { after: 'S1' }));
    writeTest(root, whole);
    const description = readFileSync(testPath(root, 't'), 'utf8');
    const visual = { runs: 1, styles: ['button ×1: color #ffffff'] };
    const learned = { ...whole, steps: [whole.steps[0], { ...whole.steps[1], recording: { ...whole.steps[1].recording, visual } }] };
    assert.equal(writeTest(root, learned, new Set(['S2'])), 'keine Änderung');
    assert.equal(readFileSync(testPath(root, 't'), 'utf8'), description, 'the description stays');
    assert.equal(loadTest(root, 't').steps[1].recording.visual, undefined);
    assert.deepEqual(withLearning(root, loadTest(root, 't')).steps[1].recording.visual, visual);
    const adopted = { ...learned, steps: [learned.steps[0], { ...learned.steps[1], recording: { ...learned.steps[1].recording, visual: { runs: 2, styles: visual.styles, adopted: '2026-11-21' } } }] };
    assert.equal(writeTest(root, adopted, new Set(['S2'])), 'caw/recordings/t.yaml');
    assert.deepEqual(loadTest(root, 't').steps[1].recording.visual, { runs: 2, styles: visual.styles, adopted: '2026-11-21' });
});

test('recordings: a visual field that is not as caw learns it is an error', () => {
    const recording = (visual) => `test: t\nsteps:\n  - id: S1\n    hash: h\n    recordedOn: a/dev\n    recordedAt: x\n    locale: de-DE\n    timezone: Europe/Berlin\n    actions: []\n    check: "true"\n    visual: ${visual}\n`;
    assert.doesNotThrow(() => parseRecordings(recording('{runs: 2, styles: [], adopted: "2026-11-21"}')));
    assert.doesNotThrow(() => parseRecordings(recording('{runs: 1, basis: "r1", styles: ["button ×1: color #ffffff"]}')));
    for (const bad of ['{runs: 2}', '{runs: 0, styles: []}', '{runs: 1, styles: [], adopted: yesterday}', '{runs: 1, styles: [], images: {win32: 1}}', '{runs: 1, styles: [], png: x}']) {
        assert.throws(() => parseRecordings(recording(bad)), /recording\.visual/, bad);
    }
});

test('writeTest: a hand-written read-only plan that wrote while recording is saved as writes: true; never back to false', (t) => {
    const root = testRoot(t);
    const plan = { ...spec(recorded('S1')), writes: false };
    writeTest(root, plan);
    assert.equal(loadTest(root, 't').writes, false);
    writeTest(root, { ...plan, writes: true });
    assert.equal(loadTest(root, 't').writes, true);
    writeTest(root, { ...plan, writes: false });
    assert.equal(loadTest(root, 't').writes, true, 'a later save without the flag does not make it read-only again');
});

test('two files: recordings and knownMessages in the description are an error; a run draft carries both', (t) => {
    const single = renderTest({ ...spec(recorded('S1'), recorded('S2', [], { after: 'S1' })), knownMessages: ['Old'] });
    assert.equal(parseTest(single).steps[1].recording.after, 'S1', 'draft: one file with recordings');
    const root = testRoot(t, single);
    assert.throws(() => loadTest(root, 't'), (error) => error.code === 'test-invalid' && /knownMessages schreibt das Tool in caw\/recordings/.test(error.message) && /recording schreibt das Tool/.test(error.message));
});

test('two files: the recording shape is checked, orphaned recordings are a hint', (t) => {
    const root = testRoot(t);
    writeTest(root, spec(recorded('S1'), recorded('S2', [], { after: 'S1' })));
    const text = readFileSync(recordingPath(root, 't'), 'utf8');
    assert.throws(() => parseRecordings(text.replace('test: t', 'foreign: 1')), /test und steps/);
    assert.throws(() => parseRecordings(text.replace('check:', 'foreign: 1\n    check:')), /Unbekanntes Feld foreign/);
    writeFileSync(recordingPath(root, 't'), text.replace('test: t', 'test: other'));
    assert.throws(() => loadTest(root, 't'), /gehört zu "other"/);
    writeFileSync(recordingPath(root, 't'), text);
    writeFileSync(testPath(root, 't'), readFileSync(testPath(root, 't'), 'utf8').replace(/ {2}- id: S2[\s\S]*$/, ''));
    writeFileSync(recordingPath(root, 'unused'), text.replace('test: t', 'test: unused'));
    assert.deepEqual(recordingHints(root), [
        'caw/recordings/t.yaml: S2 steht nicht mehr in der Beschreibung.',
        'caw/recordings/t.yaml: ohne Viewport aufgenommen; eine Wiedergabe ohne Fenster nimmt die Standardgröße, bis neu aufgenommen wird.',
        'caw/recordings/unused.yaml: Es gibt keine Beschreibung caw/tests/unused.yaml.',
    ]);
});

test('writing: re-recording replaces all steps, header and metadata stay, line endings too', (t) => {
    const root = testRoot(t, `# Header\nid: t\nrole: r\nenvironments: [a/dev]\nwrites: true\nnotes: old\nsteps:\n  - id: S1\n    name: Old\n    do: ""\n    expect: Old.\n  - id: S2\n    name: Gone\n    do: ""\n    expect: Gone.\n`.replaceAll('\n', '\r\n'));
    const loaded = loadTest(root, 't');
    writeTest(root, { ...loaded, notes: 'new', steps: [recorded('S1')], expectations: [] });
    const raw = readFileSync(testPath(root, 't'), 'utf8');
    assert.ok(raw.includes('\r\n'));
    assert.ok(raw.startsWith('# Header'));
    const read = parseTest(raw);
    assert.equal(read.notes, 'new');
    assert.deepEqual(read.steps.map(({ id }) => id), ['S1']);
});

test('writing: a new file is readable, an inserted step lands at its position', (t) => {
    const root = testRoot(t);
    const whole = { ...spec(recorded('S1'), recorded('S2', [], { after: 'S1' })), knownMessages: [] };
    writeTest(root, whole);
    assert.deepEqual(loadTest(root, 't').steps.map(({ id }) => id), ['S1', 'S2']);
    const added = { ...whole, steps: [whole.steps[0], recorded('S3', [], { after: 'S1' }), whole.steps[1]] };
    writeTest(root, added, new Set(['S3']));
    assert.deepEqual(loadTest(root, 't').steps.map(({ id }) => id), ['S1', 'S3', 'S2']);
});

test('writing with prune: the steps before stay byte for byte, removed steps go, comments of kept steps stay', (t) => {
    const original = `id: t
role: r
environments: [a/dev]
writes: true
steps:
  # Above the first, by the human
  - id: S1
    name:   First   # oddly indented
    do: ""
    expect: S1 is there
  # Above the second
  - id: S2
    name: Step S2
    do: Do S2
    expect: S2 is there
  - id: S3
    name: Step S3
    do: Do S3
    expect: S3 is there
`;
    const root = testRoot(t, original);
    const loaded = loadTest(root, 't');
    writeTest(root, { ...loaded, steps: loaded.steps.map((step) => recorded(step.id)) });
    const before = readFileSync(testPath(root, 't'), 'utf8');
    const head = before.slice(0, before.indexOf('  # Above the second'));
    // Re-recorded from S2: S2 with a new expectation, S3 removed, S4 new.
    const kept = loadTest(root, 't').steps[0];
    const next = { ...loaded, steps: [kept, { ...recorded('S2', [], { after: 'S1' }), expect: 'New' }, recorded('S4', [], { after: 'S2' })] };
    writeTest(root, next, new Set(['S2', 'S4']), { prune: true });
    const text = readFileSync(testPath(root, 't'), 'utf8');
    assert.ok(text.startsWith(head), 'everything up to S2 is unchanged');
    assert.match(text, /# Above the second\n {2}- id: S2\n/);
    assert.doesNotMatch(text, /S3/);
    const read = loadTest(root, 't');
    assert.deepEqual(read.steps.map(({ id }) => id), ['S1', 'S2', 'S4']);
    assert.equal(read.steps[1].expect, 'New');
    assert.equal(read.steps[0].recording.check, 'checkS1()', 'the recording of the step before stays');
    assert.doesNotMatch(readFileSync(recordingPath(root, 't'), 'utf8'), /id: S3/);
    // Without prune a removed step would linger in the description.
    const lingering = testRoot(t, original);
    writeTest(lingering, { ...loaded, steps: [loaded.steps[0], loaded.steps[1]] }, new Set(['S2']));
    assert.deepEqual(loadTest(lingering, 't').steps.map(({ id }) => id), ['S1', 'S2', 'S3']);
});

test('loadTest: missing file and mismatched id', (t) => {
    const root = testRoot(t, YAML.replace('id: t', 'id: other'));
    assert.throws(() => loadTest(root, 'missing'), { code: 'test-missing' });
    assert.throws(() => loadTest(root, 't'), (error) => error.code === 'test-invalid' && /other/.test(error.message));
});

test('which code runs is never stored in the test file: the invocation decides (--overlay)', () => {
    assert.doesNotMatch(renderTest(composeTest(meta, { notes: '', steps: [plain('S1')] })), /code:|source:/);
    assert.doesNotMatch(renderTest(composeTest({ ...meta, code: 'deployed' }, { notes: '', steps: [plain('S1')] })), /code:/);
});

test('loadTest: id, role and environments may be missing, a given id must match', (t) => {
    const root = testRoot(t, YAML.replace('id: t\n', '').replace('role: r\n', '').replace('environments: [a/dev, a/test]\n', ''));
    const loaded = loadTest(root, 't');
    assert.equal(loaded.id, 't');
    assert.equal(loaded.app, undefined);
    assert.equal(loaded.environments, undefined);
});

test('two files: locale and timezone of the recording browser round-trip and are required', (t) => {
    const root = testRoot(t);
    writeTest(root, spec(recorded('S1'), recorded('S2', [], { after: 'S1' })));
    const text = readFileSync(recordingPath(root, 't'), 'utf8');
    assert.match(text, /recordedAt: .*\n {4}locale: de-DE\n {4}timezone: Europe\/Berlin\n/);
    const loaded = loadTest(root, 't');
    assert.equal(loaded.steps[0].recording.locale, 'de-DE');
    assert.equal(loaded.steps[1].recording.timezone, 'Europe/Berlin');
    assert.throws(() => parseRecordings(text.replace('locale: de-DE', 'locale: 7')), /recording.locale fehlt/);
    assert.throws(() => parseRecordings(text.replace(/ {4}timezone: Europe\/Berlin\n/, '')), /recording.timezone fehlt/);
});

test('recording viewport: stored, read back and checked; wait-ready waits with for (store is unknown)', (t) => {
    const root = testRoot(t);
    const step = recorded('S1', [{ action: 'wait-ready', for: '#orders li', minCount: 2 }]);
    step.recording.viewport = { width: 1280, height: 800 };
    writeTest(root, spec(step));
    const text = readFileSync(recordingPath(root, 't'), 'utf8');
    assert.match(text, /viewport:\s*\{?\s*width: 1280/);
    assert.match(text, /wait-ready: \{\s*for: "?#orders li"?, minCount: 2\s*\}/);
    const loaded = loadTest(root, 't');
    assert.deepEqual(loaded.steps[0].recording.viewport, { width: 1280, height: 800 });
    assert.deepEqual(loaded.steps[0].recording.actions[0], { action: 'wait-ready', for: '#orders li', minCount: 2 });
    assert.deepEqual(recordingHints(root), [], 'a pinned viewport: no hint');
    assert.throws(() => parseRecordings(text.replace('width: 1280', 'width: 12')), /recording\.viewport muss \{ width, height \}/);
    assert.throws(() => parseRecordings(text.replace(/for: "?#orders li"?/, 'store: liste')), /wait-ready kennt nur for und minCount/);
});

const HUMAN = '    note: Check only.\n    design: design/order.html\n    needs: [\'getByRole("button", { name: "Save" })\']\n    look: true\n';

test('design, needs and look: read from the test file, written back, outside the hash', () => {
    const parsed = parseTest(YAML.replace('    note: Check only.\n', HUMAN), undefined, { description: true });
    assert.equal(parsed.steps[1].design, 'design/order.html');
    assert.deepEqual(parsed.steps[1].needs, ['getByRole("button", { name: "Save" })']);
    // Pinned: changing them never makes a step stale.
    assert.equal(parsed.steps[1].look, true);
    assert.equal(stepHash(parsed.steps[1]), stepHash({ ...parsed.steps[1], design: 'design/other.png', needs: ['getByText("x")'], look: undefined }));
    assert.equal(stepHash(parsed.steps[1]), stepHash(parseTest(YAML).steps[1]));
    assert.deepEqual(humanFields(parseTest(renderTest(parsed)).steps[1]), { design: 'design/order.html', needs: ['getByRole("button", { name: "Save" })'], look: true });
    assert.doesNotMatch(renderPlan(parsed), /design|needs|look/, 'the plan for Claude has no human-only fields');
});

test('design, needs and look: wrong values are rejected, and Claude\'s plan may not carry them', () => {
    for (const [field, pattern] of [
        ['design: order.html', /design nennt eine Datei unter design\//],
        ['design: design/../tests/t.yaml', /design nennt/],
        ['design: design/x.svg', /design nennt/],
        ['needs: getByText("x")', /needs ist eine Liste/],
        ['needs: []', /needs ist eine Liste/],
        ['needs: [\'page.evaluate("1")\']', /needs: .*page/],
        ['look: false', /look ist true oder fehlt/],
        ['look: yes', /look ist true oder fehlt/],
    ]) {
        assert.throws(() => parseTest(YAML.replace('    note: Check only.\n', `    note: Check only.\n    ${field}\n`)), pattern, field);
    }
    const plan = 'steps:\n  - id: S1\n    name: A\n    do: ""\n    expect: B\n    design: design/order.html\n    needs: [\'getByText("x")\']\n    look: true\n';
    const { problems } = parsePlan(plan);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /design schreibt nur ein Mensch/);
    assert.match(problems[1], /needs schreibt nur ein Mensch/);
    assert.match(problems[2], /look schreibt nur ein Mensch/);
});

test('design, needs and look: kept when caw rewrites a step from Claude\'s plan, whole or from a step', (t) => {
    const root = testRoot(t, YAML.replace('    note: Check only.\n', HUMAN));
    // Fixing S2: the plan's step has new text but no human fields; the file keeps them.
    const fixed = spec(plain('S1'), plain('S2', { expect: 'Something else' }));
    writeTest(root, fixed, new Set(['S2']));
    assert.deepEqual(humanFields(loadTest(root, 't').steps[1]), { design: 'design/order.html', needs: ['getByRole("button", { name: "Save" })'], look: true });
    // A whole new plan (re-record): the same.
    writeTest(root, spec(plain('S1'), plain('S2', { expect: 'Third text' })));
    assert.equal(loadTest(root, 't').steps[1].design, 'design/order.html');
    // Re-recording from S2 with pruning.
    writeTest(root, spec(plain('S1'), plain('S2', { expect: 'Fourth text' }), plain('S3')), new Set(['S2', 'S3']), { prune: true });
    assert.equal(loadTest(root, 't').steps[1].design, 'design/order.html');
    assert.equal(loadTest(root, 't').steps[2].design, undefined);
});

test('setStepDesign: one node edit, line endings and comments stay, a missing test or step is refused', (t) => {
    const root = testRoot(t, YAML.replaceAll('\n', '\r\n'));
    assert.deepEqual(setStepDesign(root, 't', 'S1', 'design/start.html'), { file: 'caw/tests/t.yaml', changed: true });
    const text = readFileSync(testPath(root, 't'), 'utf8');
    assert.match(text, /# Human comment\r\n/);
    assert.match(text, / {4}expect: There\.\r\n {4}design: design\/start\.html\r\n/);
    assert.equal(loadTest(root, 't').steps[0].design, 'design/start.html');
    assert.equal(setStepDesign(root, 't', 'S1', 'design/start.html').changed, false);
    setStepDesign(root, 't', 'S1', null);
    assert.equal(readFileSync(testPath(root, 't'), 'utf8'), YAML.replaceAll('\n', '\r\n'));
    assert.throws(() => setStepDesign(root, 't', 'S9', 'design/a.html'), (error) => error.code === 'step-unknown');
    assert.throws(() => setStepDesign(root, '../t', 'S1', 'design/a.html'), (error) => error.code === 'test-missing');
    assert.throws(() => setStepDesign(root, 't', 'S1', 'elsewhere/a.html'), /design nennt/);
});

test('setStepLooks: look: true as a node edit on the ticked steps, comments and line endings stay; a draft in caw/drafts; an unknown step is refused', (t) => {
    const root = testRoot(t, YAML.replaceAll('\n', '\r\n'));
    assert.equal(setStepLooks(root, { id: 't' }, ['S2']), 'caw/tests/t.yaml');
    const text = readFileSync(testPath(root, 't'), 'utf8');
    assert.match(text, /# Human comment\r\n/);
    assert.match(text, / {4}note: Check only\.\r\n {4}look: true\r\n$/);
    assert.deepEqual(loadTest(root, 't').steps.map(({ look }) => look), [undefined, true], 'only S2');
    assert.equal(setStepLooks(root, { id: 't' }, ['S2']), 'keine Änderung');
    assert.throws(() => setStepLooks(root, { id: 't' }, ['S9']), (error) => error.code === 'step-unknown');
    assert.throws(() => setStepLooks(root, { id: 'other' }, ['S1']), (error) => error.code === 'test-missing');
    mkdirSync(join(root, 'caw/drafts'), { recursive: true });
    writeFileSync(draftPath(root, 'bug'), YAML.replace('id: t', 'id: bug'));
    assert.equal(setStepLooks(root, { id: 'bug', draft: true }, ['S1']), 'caw/drafts/bug.yaml');
    assert.equal(loadDraft(root, 'bug').steps[0].look, true);
});

test('drafts: red only in caw/drafts, with a known step, the run and an optional short hash', () => {
    const draftText = `${YAML}red: { step: S2, run: 2026-11-20T09-00-00-000Z-bug, head: "2314150" }\n`;
    assert.throws(() => parseTest(draftText), /red gehört nur in einen Entwurf in caw\/drafts/);
    assert.throws(() => parseTest(draftText, 'x', { description: true }), /red gehört nur/);
    assert.deepEqual(parseTest(draftText, 'x', { draft: true }).red, { step: 'S2', run: '2026-11-20T09-00-00-000Z-bug', head: '2314150' });
    for (const red of ['{ step: S9, run: r }', '{ step: S2 }', '{ step: S2, run: r, head: "HEAD~1" }', '{ step: S2, run: r, why: x }', 'S2']) {
        assert.throws(() => parseTest(`${YAML}red: ${red}\n`, 'x', { draft: true }), /red ist \{ step, run, head\? \}/, red);
    }
});

test('drafts: loaded from caw/drafts when caw/tests has none, written back there as one file with red; tests win', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-draft-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(testExists(root, 'bug-x'), false);
    const draft = { ...spec(recorded('S1'), recorded('S2')), id: 'bug-x', draft: true };
    assert.equal(writeTest(root, draft), 'caw/drafts/bug-x.yaml');
    assert.equal(existsSync(testPath(root, 'bug-x')), false, 'nothing in caw/tests');
    assert.equal(existsSync(recordingPath(root, 'bug-x')), false, 'nothing in caw/recordings');
    assert.deepEqual(draftIds(root), ['bug-x']);
    assert.equal(testExists(root, 'bug-x'), true);
    const loaded = loadTest(root, 'bug-x');
    assert.equal(loaded.draft, true);
    assert.equal(loaded.steps[1].recording.check, 'checkS2()');
    assert.equal(redStep(loaded), 'S2', 'before a red run: the last step');
    // CRLF stays when the red proof is added.
    writeFileSync(draftPath(root, 'bug-x'), readFileSync(draftPath(root, 'bug-x'), 'utf8').replaceAll('\n', '\r\n'));
    assert.equal(writeTest(root, { ...loaded, red: { step: 'S2', run: 'r1', head: 'abc1234' } }), 'caw/drafts/bug-x.yaml');
    const text = readFileSync(draftPath(root, 'bug-x'), 'utf8');
    assert.match(text, /^red: \{step: S2, run: r1, head: abc1234\}\r$/m);
    assert.ok(!/[^\r]\n/.test(text), 'line endings kept');
    assert.deepEqual(loadDraft(root, 'bug-x').red, { step: 'S2', run: 'r1', head: 'abc1234' });
    assert.equal(writeTest(root, loadDraft(root, 'bug-x')), 'keine Änderung');
    assert.equal(redStep({ ...loaded, draft: false }), undefined, 'a test has no red step');
    // A test of the same name wins over the draft.
    writeTest(root, { ...spec(recorded('S1')), id: 'bug-x' });
    assert.equal(loadTest(root, 'bug-x').draft, undefined);
});

test('a design draft: origin design only in a draft, written and read back; its red step is the last step with a design, its checks are recorded like a test', (t) => {
    assert.equal(parseTest(`${YAML}origin: design\n`, 'x', { draft: true }).origin, 'design');
    assert.throws(() => parseTest(`${YAML}origin: design\n`, 'x', { description: true }), /origin gehört nur in einen Entwurf in caw\/drafts/);
    assert.throws(() => parseTest(`${YAML}origin: ticket\n`, 'x', { draft: true }), /origin ist design/);
    const root = mkdtempSync(join(tmpdir(), 'caw-design-draft-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const draft = { ...spec(recorded('S1'), recorded('S2'), plain('S3')), id: 'note', draft: true, origin: 'design' };
    assert.equal(writeTest(root, draft), 'caw/drafts/note.yaml');
    assert.match(readFileSync(draftPath(root, 'note'), 'utf8'), /^origin: design$/m);
    const loaded = loadDraft(root, 'note');
    assert.equal(loaded.origin, 'design');
    assert.equal(isDesignDraft(loaded), true);
    assert.equal(redStep(loaded), undefined, 'no step with a design yet: nothing to be red at');
    assert.equal(checkRedStep(loaded), undefined);
    // The person links the design to S3 (caw_design link): it is the red step now, and still none whose check must fail.
    assert.deepEqual(setStepDesign(root, 'note', 'S3', 'design/note.html'), { file: 'caw/drafts/note.yaml', changed: true });
    const linked = loadDraft(root, 'note');
    assert.equal(linked.steps[2].design, 'design/note.html');
    assert.equal(linked.red, undefined);
    assert.equal(redStep(linked), 'S3');
    assert.equal(checkRedStep(linked), undefined, 'recorded like a test');
    assert.equal(checkRedStep({ ...linked, origin: undefined }), 'S3', 'a draft from caw reproduce keeps its failing check');
    assert.equal(redStep({ ...linked, red: { step: 'S2', run: 'r1' } }), 'S2', 'the red proof names it');
    assert.equal(isDesignDraft({ ...linked, draft: undefined }), false);
});

test('composeTest: a new plan keeps the origin; a design draft keeps its red proof while its red step keeps design and expected result', () => {
    const designed = { ...plain('S2'), design: 'design/note.html' };
    const draft = { ...meta, draft: true, origin: 'design', red: { step: 'S2', run: 'r1', head: 'abc1234' }, steps: [plain('S1'), designed] };
    const again = composeTest(draft, { notes: '', steps: [plain('S1'), designed] });
    assert.equal(again.origin, 'design');
    assert.deepEqual(again.red, { step: 'S2', run: 'r1', head: 'abc1234' });
    assert.equal(composeTest(draft, { notes: '', steps: [plain('S1'), { ...designed, expect: 'Anders.' }] }).red, undefined, 'another expected result');
    assert.equal(composeTest(draft, { notes: '', steps: [plain('S1'), { ...designed, design: 'design/other.html' }] }).red, undefined, 'another design');
    assert.equal(composeTest(draft, { notes: '', steps: [plain('S1')] }).red, undefined, 'the step is gone');
    // A draft from caw reproduce loses its red proof with a new plan, as before.
    const bug = { ...meta, draft: true, red: { step: 'S2', run: 'r1' }, steps: [plain('S1'), plain('S2')] };
    const plan = composeTest(bug, { notes: '', steps: [plain('S1'), plain('S2')] });
    assert.equal(plan.red, undefined);
    assert.equal(plan.origin, undefined);
});
