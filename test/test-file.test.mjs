import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertPlayable, buildReplay, cutReplay, groupSteps, missingRemembered, replayBefore, replayOf, replayUpToStale, trailingNumbers } from '../src/host/replay.mjs';
import { brokenChain, loadTest, parsePlan, parseRecordings, parseTest, recordingHints, recordingPath, renderPlan, renderTest, staleSteps, stepHash, testPath, writeTest } from '../src/host/test-file.mjs';
import { composeTest, planView, readPlan, replaceStep } from '../src/host/test-plan.mjs';

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
        // Fields from before 1.0: one application per project, overlay parts in the config.
        [YAML.replace('role: r', 'role: r\napp: web'), /Zeile 3: app gibt es nicht mehr: eine Anwendung je Projekt; ein Test, der auf einer anderen Seite beginnt, setzt "start"/],
        [YAML.replace('role: r', 'role: r\nalso: [admin]'), /Zeile 3: also gibt es nicht mehr: --overlay bringt jeden Teil/],
        [YAML.replace('role: r', 'role: r\nstart: orders'), /Zeile 3: start muss ein Pfad sein, der mit \/ beginnt/],
        [YAML.replace('role: r', 'role: r\nstart: //cdn.example/x'), /start muss ein Pfad sein/],
        [YAML.replace('- id: S2', '- id: S1'), /S1 ist doppelt/],
        [YAML.replace('- id: S2', '- id: 2'), /ID muss wie S1/],
        [YAML.replace('- id: S2', '- id: S2\n    foo: bar'), /Unbekanntes Feld foo im Schritt/],
        [YAML.replace('    expect: Also there.\n', ''), /expect fehlt/],
        [YAML.replace('    do: ""\n', ''), /do fehlt/],
        [YAML.replace('environments: [a/dev, a/test]', 'environments: []'), /environments muss eine nicht leere Liste/],
        [YAML.replace('environments: [a/dev, a/test]', 'environment: [a/dev]'), /Unbekanntes Feld environment\. Meintest du environments\?/],
        // Renamed before 1.0.
        [YAML.replace('environments: [a/dev, a/test]', 'targets: [a/dev]'), /targets heißt jetzt environments/],
        [YAML.replace('writes: false', 'mutates: false'), /mutates heißt jetzt writes/],
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

test('recording viewport: stored, read back and checked; wait-ready waits with for (store renamed)', (t) => {
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
    assert.throws(() => parseRecordings(text.replace(/for: "?#orders li"?/, 'store: liste')), /store heißt jetzt for/);
});
