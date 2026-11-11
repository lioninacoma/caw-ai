import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertPlayable, buildReplay, cutReplay, groupSteps, missingRemembered, replayBefore, replayOf, replayUpToStale, trailingNumbers } from '../src/host/replay.mjs';
import { brokenChain, loadTest, parsePlan, parseRecordings, parseTest, recordingHints, recordingPath, renderPlan, renderTest, staleSteps, stepHash, testPath, writeTest } from '../src/host/test-file.mjs';
import { composeTest, planView, readPlan, replaceStep } from '../src/host/test-plan.mjs';

const NEXT = { xtype: 'app_actionButton', text: 'Next', part: 'button.x-button-el' };
const plain = (id, extra = {}) => ({ id, name: `Step ${id}`, do: `Do ${id}`, expect: `${id} is there`, ...extra });
const recorded = (id, actions = [], { after, check = `check${id}()` } = {}) => {
    const step = plain(id);
    return { ...step, recording: { hash: stepHash(step), ...(after === undefined ? {} : { after }), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', actions, check } };
};
const meta = { id: 't', app: 'a', role: 'r', targets: ['a/dev'], mutates: true, also: [], notes: '' };
const spec = (...steps) => composeTest(meta, { notes: '', steps });

const YAML = `id: t
app: a
role: r
targets: [a/dev, a/test]
mutates: false
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
    assert.equal(parsed.mutates, false);
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
        [YAML.replace('mutates: false', 'mutates: maybe'), /Zeile 5: mutates/],
        [YAML.replace('app: a', 'app: a\nextra: 1'), /Zeile 3: Unbekanntes Feld extra/],
        [YAML.replace('- id: S2', '- id: S1'), /S1 ist doppelt/],
        [YAML.replace('- id: S2', '- id: 2'), /ID muss wie S1/],
        [YAML.replace('- id: S2', '- id: S2\n    foo: bar'), /Unbekanntes Feld foo im Schritt/],
        [YAML.replace('    expect: Also there.\n', ''), /expect fehlt/],
        [YAML.replace('    do: ""\n', ''), /do fehlt/],
        [YAML.replace('targets: [a/dev, a/test]', 'targets: []'), /targets/],
        [YAML.replace('targets: [a/dev, a/test]', 'target: [a/dev]'), /Unbekanntes Feld target\. Meintest du targets\?/],
        [YAML.replace('    expect: There.', '    expected: There.'), /Unbekanntes Feld expected im Schritt\. Meintest du expect\?/],
        [YAML.replace('mutates: false', 'source: watch\nmutates: false'), /Unbekanntes Feld source/],
        [YAML.replace('mutates: false', 'code: deployed\nmutates: false'), /Unbekanntes Feld code/],
        [YAML.replace('mutates: false\n', ''), /mutates fehlt: true, wenn der Test Daten anlegt oder ändert \(läuft nur auf Umgebungen mit writable: true\), false, wenn er nur liest\./],
        ['not: [yaml', /Zeile/],
        ['- just\n- a list\n', /Objekt/],
        [YAML.replace('role: r', 'role: r\nrole: x'), /Zeile/],
        [YAML.replace('app: a', 'app: !!js/function x'), /Zeile/],
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
        { action: 'fill', target: { ...NEXT, inside: { xtype: 'p' } }, value: '' },
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
    assert.throws(() => parseTest(bad.replace('reload: {}', 'click: text-only')), /Ziel/);
    assert.throws(() => parseTest(bad.replace('recordedOn:', 'foreign: 1\n      recordedOn:')), /Unbekanntes Feld foreign/);
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
    const view = planView({ notes: 'n', steps: [{ ...plain('S1'), expect: 'Different' }] }, { repairing: true, previous: before });
    assert.deepEqual(view.steps[0], { id: 'S1', name: 'Step S1', do: 'Do S1', expect: 'Different', previousExpect: 'S1 is there' });
    assert.equal(view.notes, '');
    assert.equal(planView({ notes: 'n', steps: [plain('S1')] }, { repairing: true, previous: before }).steps[0].previousExpect, undefined);
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

test('stale: --until before it runs, the full run suggests fix', () => {
    const changed = spec(recorded('S1'), recorded('S2', [], { after: 'S1' }), { ...recorded('S3', [], { after: 'S2' }), do: 'new' });
    assertPlayable(changed, 'a/dev', 'S2');
    assert.throws(() => assertPlayable(changed, 'a/dev'), (error) => error.code === 'replay-stale' && /fix t S3 --target a\/dev/.test(error.message));
    assert.throws(() => assertPlayable(spec(plain('S1')), 'a/dev'), (error) => error.code === 'replay-missing' && /record t/.test(error.message));
});

test('deleted or moved steps require re-recording, inserted ones do not', () => {
    const [s1, s2, s3] = [recorded('S1'), recorded('S2', [], { after: 'S1' }), recorded('S3', [], { after: 'S2' })];
    assert.equal(brokenChain(spec(s1, s2, s3)), null);
    assert.match(brokenChain(spec(s1, s3)), /S3 baut auf S2/);
    assert.match(brokenChain(spec(s1, s3, s2)), /S3 baut auf S2/);
    assert.equal(brokenChain(spec(s1, plain('S4'), s2, s3)), null);
    assert.throws(() => assertPlayable(spec(s1, s3), 'a/dev'), (error) => error.code === 'replay-stale' && /record t/.test(error.message));
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
app: a
role: r
targets: [a/dev]
mutates: true
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
    const fixed = { ...loaded.steps[1], do: 'new', recording: { hash: 'h', after: 'S1', recordedOn: 'a/dev', recordedAt: 'z', actions: [{ action: 'click', target: NEXT, path: '/a' }, { action: 'fill', target: NEXT, value: '' }], check: 'x()' } };
    const relative = writeTest(root, { ...replaceStep(loaded, fixed), knownMessages: ['Yes No'] }, new Set(['S2']));
    assert.equal(relative, 'caw/tests/t.yaml, caw/recordings/t.yaml');
    const text = readFileSync(testPath(root, 't'), 'utf8');
    assert.ok(text.startsWith('# Header by the human\n'));
    assert.match(text, /# Above the first/);
    assert.match(text, /# oddly indented/);
    assert.match(text, /# Above the second\n {2}- id: S2/);
    assert.match(text, /Stays\./);
    assert.doesNotMatch(text, /recording|knownMessages/, 'the description stays without recordings');
    assert.match(readFileSync(recordingPath(root, 't'), 'utf8'), /click: \{/, 'targets are on one line');
    const read = loadTest(root, 't');
    assert.equal(read.steps[0].recording, undefined);
    assert.equal(read.steps[1].do, 'new');
    assert.equal(read.steps[1].recording.actions[1].value, '');
    assert.deepEqual(read.knownMessages, ['Yes No']);
});

test('two files: when the tool learns, only the recording changes', (t) => {
    const root = testRoot(t);
    const whole = spec(recorded('S1'), recorded('S2', [], { after: 'S1' }));
    writeTest(root, whole);
    const description = readFileSync(testPath(root, 't'), 'utf8');
    const learned = { ...whole, steps: [whole.steps[0], { ...whole.steps[1], recording: { ...whole.steps[1].recording, effects: { runs: 1, actions: [{ action: 1, controls: ['+ x'] }] } } }] };
    assert.equal(writeTest(root, learned, new Set(['S2'])), 'caw/recordings/t.yaml');
    assert.equal(readFileSync(testPath(root, 't'), 'utf8'), description);
    assert.deepEqual(loadTest(root, 't').steps[1].recording.effects.runs, 1);
    assert.equal(writeTest(root, learned, new Set(['S2'])), 'keine Änderung');
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
    assert.deepEqual(recordingHints(root), ['caw/recordings/t.yaml: S2 steht nicht mehr in der Beschreibung.', 'caw/recordings/unused.yaml: Es gibt keine Beschreibung caw/tests/unused.yaml.']);
});

test('writing: re-recording replaces all steps, header and metadata stay, line endings too', (t) => {
    const root = testRoot(t, `# Header\nid: t\napp: a\nrole: r\ntargets: [a/dev]\nmutates: true\nnotes: old\nsteps:\n  - id: S1\n    name: Old\n    do: ""\n    expect: Old.\n  - id: S2\n    name: Gone\n    do: ""\n    expect: Gone.\n`.replaceAll('\n', '\r\n'));
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

test('loadTest: missing file and mismatched id', (t) => {
    const root = testRoot(t, YAML.replace('id: t', 'id: other'));
    assert.throws(() => loadTest(root, 'missing'), { code: 'test-missing' });
    assert.throws(() => loadTest(root, 't'), (error) => error.code === 'test-invalid' && /other/.test(error.message));
});

test('which code runs is never stored in the test file: the invocation decides (--overlay)', () => {
    assert.doesNotMatch(renderTest(composeTest(meta, { notes: '', steps: [plain('S1')] })), /code:|source:/);
    assert.doesNotMatch(renderTest(composeTest({ ...meta, code: 'deployed' }, { notes: '', steps: [plain('S1')] })), /code:/);
});

test('loadTest: id, app, role and targets may be missing, a given id must match', (t) => {
    const root = testRoot(t, YAML.replace('id: t\n', '').replace('app: a\n', '').replace('role: r\n', '').replace('targets: [a/dev, a/test]\n', ''));
    const loaded = loadTest(root, 't');
    assert.equal(loaded.id, 't');
    assert.equal(loaded.app, undefined);
    assert.equal(loaded.targets, undefined);
});

test('two files: locale and timezone of the recording browser round-trip; older recordings without them stay valid', (t) => {
    const root = testRoot(t);
    const withRegion = recorded('S1');
    withRegion.recording = { ...withRegion.recording, locale: 'de-DE', timezone: 'Europe/Berlin' };
    writeTest(root, spec(withRegion, recorded('S2', [], { after: 'S1' })));
    const text = readFileSync(recordingPath(root, 't'), 'utf8');
    assert.match(text, /recordedAt: .*\n {4}locale: de-DE\n {4}timezone: Europe\/Berlin\n/);
    const loaded = loadTest(root, 't');
    assert.equal(loaded.steps[0].recording.locale, 'de-DE');
    assert.equal(loaded.steps[0].recording.timezone, 'Europe/Berlin');
    assert.equal(loaded.steps[1].recording.locale, undefined, 'a step without the fields stays without them');
    assert.throws(() => parseRecordings(text.replace('locale: de-DE', 'locale: 7')), /recording.locale muss ein Text sein/);
});
