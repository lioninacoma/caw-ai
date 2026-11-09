import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertPlayable, buildReplay, cutReplay, groupSteps, missingRemembered, replayBefore, replayOf, replayUpToStale, trailingNumbers } from '../src/host/replay.mjs';
import { brokenChain, loadTest, parsePlan, parseRecordings, parseTest, recordingHints, recordingPath, renderPlan, renderTest, staleSteps, stepHash, testPath, writeTest } from '../src/host/test-file.mjs';
import { composeTest, planView, readPlan, replaceStep } from '../src/host/test-plan.mjs';

const WEITER = { xtype: 'app_actionButton', text: 'Weiter', part: 'button.x-button-el' };
const plain = (id, extra = {}) => ({ id, name: `Schritt ${id}`, do: `Tu ${id}`, expect: `${id} ist da`, ...extra });
const recorded = (id, actions = [], { after, check = `check${id}()` } = {}) => {
    const step = plain(id);
    return { ...step, recording: { hash: stepHash(step), ...(after === undefined ? {} : { after }), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', actions, check } };
};
const meta = { id: 't', app: 'a', role: 'r', targets: ['a/dev'], source: 'watch', mutates: true, also: [], notes: '' };
const spec = (...steps) => composeTest(meta, { notes: '', steps });

const YAML = `id: t
app: a
role: r
targets: [a/dev, a/test]
mutates: false
# Kommentar des Menschen
steps:
  - id: S1
    name: Erster
    do: |
      Tu was.
      Und noch was.
    expect: Da.
  - id: S2
    name: Zweiter
    do: ""
    expect: Auch da.
    note: Nur Prüfung.
`;

test('Testdatei: Eine gültige Datei wird gelesen, Punkte sind die Schritte', () => {
    const parsed = parseTest(YAML);
    assert.equal(parsed.source, 'watch');
    assert.equal(parsed.mutates, false);
    assert.deepEqual(parsed.expectations, [{ id: 'S1', text: 'Da.' }, { id: 'S2', text: 'Auch da.' }]);
    assert.equal(parsed.steps[0].do, 'Tu was.\nUnd noch was.');
    assert.equal(parsed.steps[1].do, '');
    assert.equal(parseTest(YAML.replaceAll('\n', '\r\n')).steps.length, 2);
});

test('retry: Wird gelesen, geschrieben und zählt nicht zum Hash', () => {
    const withRetry = YAML.replace('    note: Nur Prüfung.\n', '    note: Nur Prüfung.\n    retry: {times: 2, waitMs: 5000, from: S1}\n');
    const parsed = parseTest(withRetry);
    assert.deepEqual(parsed.steps[1].retry, { times: 2, waitMs: 5000, from: 'S1' });
    assert.equal(stepHash(parsed.steps[1]), stepHash({ ...parsed.steps[1], retry: undefined }));
    assert.match(renderTest(parsed), /retry: \{times: 2, waitMs: 5000, from: S1\}/);
    assert.deepEqual(parseTest(renderTest(parsed)).steps[1].retry, parsed.steps[1].retry);
    assert.deepEqual(parsePlan(renderPlan(parsed)).plan.steps[1].retry, parsed.steps[1].retry);
    assert.deepEqual(replayOf(spec({ ...recorded('S1'), retry: { times: 1 } }, recorded('S2'))).retries, { S1: { times: 1 } });
});

test('retry: Falsche Angaben werden abgewiesen', () => {
    for (const [value, pattern] of [
        ['{waitMs: 5}', /times/],
        ['{times: 0}', /times/],
        ['{times: 11}', /times/],
        ['{times: 1, waitMs: -1}', /waitMs/],
        ['{times: 1, von: S1}', /Unbekanntes Feld von/],
        ['{times: 1, from: S9}', /retry\.from S9/],
        ['3', /retry muss/],
    ]) {
        assert.throws(() => parseTest(YAML.replace('    note: Nur Prüfung.\n', `    note: Nur Prüfung.\n    retry: ${value}\n`)), pattern, value);
    }
    const later = YAML.replace('    expect: Da.\n', '    expect: Da.\n    retry: {times: 1, from: S2}\n');
    assert.throws(() => parseTest(later), /retry\.from S2/);
});

test('Testdatei: Jede Formverletzung wird mit Zeile abgewiesen', () => {
    const cases = [
        [YAML.replace('mutates: false', 'mutates: vielleicht'), /Zeile 5: mutates/],
        [YAML.replace('app: a', 'app: a\nextra: 1'), /Zeile 3: Unbekanntes Feld extra/],
        [YAML.replace('- id: S2', '- id: S1'), /S1 ist doppelt/],
        [YAML.replace('- id: S2', '- id: 2'), /ID muss wie S1/],
        [YAML.replace('- id: S2', '- id: S2\n    foo: bar'), /Unbekanntes Feld foo im Schritt/],
        [YAML.replace('    expect: Auch da.\n', ''), /expect fehlt/],
        [YAML.replace('    do: ""\n', ''), /do fehlt/],
        [YAML.replace('source', 'x').replace('targets: [a/dev, a/test]', 'targets: []'), /targets/],
        [YAML.replace('mutates: false', 'source: irgendwas\nmutates: false'), /source "irgendwas"/],
        ['kein: [yaml', /Zeile/],
        ['- nur\n- liste\n', /Objekt/],
        [YAML.replace('role: r', 'role: r\nrole: x'), /Zeile/],
        [YAML.replace('app: a', 'app: !!js/function x'), /Zeile/],
        [`${YAML}---\nid: zweites\n`, /Zeile/],
        [YAML.replace('expect: Da.', 'expect: &m Da.').replace('expect: Auch da.', 'expect: *m'), /Aliase/],
    ];
    for (const [text, reason] of cases) assert.throws(() => parseTest(text, 'x.yaml'), (error) => error.code === 'test-invalid' && reason.test(error.message), String(reason));
});

test('Testdatei: Aufzeichnung wird streng gelesen', () => {
    const withActions = (actions) => renderTest(spec(recorded('S1', actions)));
    const round = parseTest(withActions([
        { action: 'wait-ready' },
        { action: 'click', target: WEITER, path: '/a' },
        { action: 'fill', target: { ...WEITER, inside: { xtype: 'p' } }, value: '' },
        { action: 'press', key: 'Tab' },
        { action: 'goto', url: 'https://x/', denied: true },
        { action: 'reload' },
        { action: 'remember', name: 'nr', code: 'x()' },
        { action: 'screenshot', name: 'a.png' },
    ]));
    assert.deepEqual(round.steps[0].recording.actions[1], { action: 'click', target: WEITER, path: '/a' });
    assert.equal(round.steps[0].recording.actions[2].value, '');
    assert.equal(round.steps[0].recording.actions[3].key, 'Tab');
    assert.equal(round.steps[0].recording.actions[4].denied, true);
    assert.equal(round.steps[0].recording.actions[6].name, 'nr');

    const bad = renderTest(spec(recorded('S1', [{ action: 'reload' }])));
    assert.throws(() => parseTest(bad.replace('reload: {}', 'cdp: {}')), /genau eine/);
    assert.throws(() => parseTest(bad.replace('check: checkS1()', '')), /recording.check/);
    assert.throws(() => parseTest(bad.replace('reload: {}', 'click: nur-text')), /Ziel/);
    assert.throws(() => parseTest(bad.replace('recordedOn:', 'fremd: 1\n      recordedOn:')), /Unbekanntes Feld fremd/);
});

test('Plan: Claude kann keine Aufzeichnung und keine Metadaten setzen', () => {
    const { plan, problems } = parsePlan(`id: anders\nrole: admin\nnotes: Hinweis\nsteps:\n  - id: S1\n    name: A\n    do: b\n    expect: c\n    recording: { hash: x, actions: [], check: "true" }\n`);
    assert.deepEqual(problems, []);
    assert.equal(plan.notes, 'Hinweis');
    assert.deepEqual(plan.steps, [{ id: 'S1', name: 'A', do: 'b', expect: 'c' }]);
    const composed = composeTest(meta, plan);
    assert.equal(composed.role, 'r');
    assert.equal(composed.steps[0].recording, undefined);
    assert.match(readPlan('steps:\n  - id: S1\n    name: A\n    do: b\n    expect: arzt@example.org\n').problems.join(' '), /E-Mail/);
    assert.match(readPlan('steps: []\n').problems.join(' '), /nichtleere/);
    assert.match(readPlan('steps:\n  - id: S1\n    name: A\n    expect: c\n').problems.join(' '), /Zeile 2: do fehlt/);
    assert.equal(parseTest(renderTest(composed)).steps[0].name, 'A');
    assert.deepEqual(parsePlan(renderPlan(composed)).plan.steps, composed.steps);
});

test('Plankarte: Nur Plan-Felder, ein geändertes Ergebnis ist markiert', () => {
    const before = recorded('S1');
    const view = planView({ notes: 'n', steps: [{ ...plain('S1'), expect: 'Anders' }] }, { repairing: true, previous: before });
    assert.deepEqual(view.steps[0], { id: 'S1', name: 'Schritt S1', do: 'Tu S1', expect: 'Anders', previousExpect: 'S1 ist da' });
    assert.equal(view.notes, '');
    assert.equal(planView({ notes: 'n', steps: [plain('S1')] }, { repairing: true, previous: before }).steps[0].previousExpect, undefined);
    assert.equal(planView({ notes: 'n', steps: [plain('S1')] }).notes, 'n');
});

test('Hash: Je Schritt, Metadaten und Aufzeichnung zählen nicht', () => {
    const step = plain('S1');
    assert.equal(stepHash(step), stepHash({ ...step, expect: `${step.expect}\n` }), 'Block oder einzeilig ist egal');
    for (const field of ['name', 'do', 'expect', 'note']) assert.notEqual(stepHash(step), stepHash({ ...step, [field]: 'anders' }), field);
    const changed = spec(recorded('S1'), { ...recorded('S2'), do: 'von Hand geändert' }, recorded('S3'));
    assert.deepEqual(staleSteps(changed).map(({ id }) => id), ['S2']);
    assert.deepEqual(staleSteps(spec(plain('S1'))).map(({ why }) => why), ['hat keine Aufzeichnung']);
});

test('Veraltet: --until davor läuft, der ganze Lauf nennt fix', () => {
    const changed = spec(recorded('S1'), recorded('S2', [], { after: 'S1' }), { ...recorded('S3', [], { after: 'S2' }), do: 'neu' });
    assertPlayable(changed, 'a/dev', 'S2');
    assert.throws(() => assertPlayable(changed, 'a/dev'), (error) => error.code === 'replay-stale' && /fix t S3 --target a\/dev/.test(error.message));
    assert.throws(() => assertPlayable(spec(plain('S1')), 'a/dev'), (error) => error.code === 'replay-missing' && /record t/.test(error.message));
});

test('Gelöschte oder verschobene Schritte verlangen eine Neuaufnahme, eingefügte nicht', () => {
    const [s1, s2, s3] = [recorded('S1'), recorded('S2', [], { after: 'S1' }), recorded('S3', [], { after: 'S2' })];
    assert.equal(brokenChain(spec(s1, s2, s3)), null);
    assert.match(brokenChain(spec(s1, s3)), /S3 baut auf S2/);
    assert.match(brokenChain(spec(s1, s3, s2)), /S3 baut auf S2/);
    assert.equal(brokenChain(spec(s1, plain('S4'), s2, s3)), null);
    assert.throws(() => assertPlayable(spec(s1, s3), 'a/dev'), (error) => error.code === 'replay-stale' && /record t/.test(error.message));
});

test('Abspielform: Aktionen und Prüfung in Reihe, Schnitt je Schritt', () => {
    const click = { action: 'click', target: WEITER };
    const whole = spec(recorded('S1', [click]), recorded('S2', [{ action: 'reload' }], { after: 'S1' }), recorded('S3', [], { after: 'S2' }));
    assert.deepEqual(replayOf(whole).steps.map(({ action, id }) => id ?? action), ['click', 'S1', 'reload', 'S2', 'S3']);
    const cut = cutReplay(whole, 'S2');
    assert.equal(cut.until, 'S2');
    assert.deepEqual(cut.steps.map(({ action, id }) => id ?? action), ['click', 'S1', 'reload', 'S2']);
    assert.throws(() => cutReplay(whole, 'S9'), { code: 'step-unknown' });
    assert.deepEqual(replayBefore(whole, 'S2').steps.map(({ action, id }) => id ?? action), ['click', 'S1']);
    assert.deepEqual(replayBefore(whole, 'S1').steps, []);
    const partly = spec(recorded('S1', [click]), { ...recorded('S2', [], { after: 'S1' }), do: 'neu' });
    assert.equal(replayUpToStale(partly).until, 'S1');
    assert.equal(replayUpToStale(whole).until, undefined);
});

test('Gruppierung: Aktionen gehören zur nächsten Prüfung, nachgeprüfte Schritte bleiben einer', () => {
    const click = { action: 'click', target: WEITER };
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
    assert.deepEqual(trailingNumbers([click, { action: 'reload' }]), [1, 2], 'Ohne Prüfung gehört alles zu keinem Schritt');
});

test('buildReplay: Aufnahme ergibt je Schritt eine Aufzeichnung', () => {
    const recorder = { problems: [], messages: new Set(['Ja Nein']), steps: [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'a' }, { action: 'check', id: 'S2', code: 'b' }] };
    const plan = spec(plain('S1'), plain('S2'));
    const { candidate } = buildReplay({ recorder, outcome: { status: 'pass' }, spec: plan, target: 'a/dev', now: new Date(0) });
    assert.deepEqual(candidate.steps[0].recording, { hash: stepHash(plan.steps[0]), recordedOn: 'a/dev', recordedAt: '1970-01-01T00:00:00.000Z', actions: [{ action: 'reload' }], check: 'a' });
    assert.equal(candidate.steps[1].recording.after, 'S1');
    assert.deepEqual(candidate.knownMessages, ['Ja Nein']);
    assert.match(buildReplay({ recorder, outcome: { status: 'fail' }, spec: plan, target: 'x' }).problems[0], /fail/);
    assert.match(buildReplay({ recorder: { ...recorder, steps: recorder.steps.slice(0, 2) }, outcome: { status: 'pass' }, spec: plan, target: 'x' }).problems[0], /S2/);
    assert.match(buildReplay({ recorder: { ...recorder, steps: [...recorder.steps, { action: 'reload' }] }, outcome: { status: 'pass' }, spec: plan, target: 'x' }).problems[0], /Nach der letzten Prüfung/);
    assert.match(buildReplay({ recorder: { ...recorder, problems: ['kaputt'] }, outcome: { status: 'pass' }, spec: plan, target: 'x' }).problems[0], /kaputt/);
});

test('buildReplay beim Beheben: Nur dieser Schritt ändert sich, neue Meldungen werden genannt', () => {
    const draft = { ...spec(recorded('S1'), recorded('S2', [], { after: 'S1' }), recorded('S3', [], { after: 'S2' })), knownMessages: ['Alt'] };
    const changed = { ...plain('S2'), do: 'anders' };
    const recorder = { problems: [], messages: new Set(['Neu']), steps: [{ action: 'reload' }, { action: 'check', id: 'S2', code: 'neu' }] };
    const { candidate, fresh } = buildReplay({ recorder, outcome: { status: 'pass' }, spec: spec(changed), draft, target: 'a/dev' });
    assert.equal(candidate.steps[0], draft.steps[0]);
    assert.equal(candidate.steps[2], draft.steps[2]);
    assert.equal(candidate.steps[1].do, 'anders');
    assert.equal(candidate.steps[1].recording.after, 'S1');
    assert.equal(candidate.steps[1].recording.hash, stepHash(changed));
    assert.deepEqual(fresh, ['Neu']);
    assert.deepEqual(candidate.knownMessages, ['Alt', 'Neu']);
    assert.deepEqual(staleSteps(candidate), []);
});

test('remember: Ein später gebrauchter Wert darf beim Beheben nicht wegfallen', () => {
    const merkt = recorded('S1', [{ action: 'remember', name: 'nr', code: 'x()' }]);
    const nutzt = recorded('S2', [{ action: 'fill', target: WEITER, value: '{{nr}}' }], { after: 'S1', check: "x === '{{nr}} {{runTag}}'" });
    const draft = spec(merkt, nutzt);
    assert.deepEqual(missingRemembered(draft), []);
    assert.match(missingRemembered(spec(recorded('S1'), nutzt))[0], /S2 braucht \{\{nr\}\}/);
    const recorder = { problems: [], steps: [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'a' }] };
    const built = buildReplay({ recorder, outcome: { status: 'pass' }, spec: spec(plain('S1')), draft, target: 'a/dev' });
    assert.equal(built.candidate, undefined);
    assert.match(built.problems[0], /S2 braucht \{\{nr\}\}/);
});

const testRoot = (t, text) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-file-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    if (text !== undefined) writeFileSync(testPath(root, 't'), text);
    return root;
};

test('Schreiben: Nur der behobene Schritt ändert sich, Kommentare und andere Schritte bleiben', (t) => {
    const original = `# Kopf vom Menschen
id: t
app: a
role: r
targets: [a/dev]
mutates: true
notes: |
  Bleibt.

steps:
  # Über dem ersten
  - id: S1
    name:   Erster   # krumm eingerückt
    do: ""
    expect: Da.
  # Über dem zweiten
  - id: S2
    name: Zweiter
    do: alt
    expect: Auch da.
`;
    const root = testRoot(t, original);
    const loaded = loadTest(root, 't');
    const fixed = { ...loaded.steps[1], do: 'neu', recording: { hash: 'h', after: 'S1', recordedOn: 'a/dev', recordedAt: 'z', actions: [{ action: 'click', target: WEITER, path: '/a' }, { action: 'fill', target: WEITER, value: '' }], check: 'x()' } };
    const relative = writeTest(root, { ...replaceStep(loaded, fixed), knownMessages: ['Ja Nein'] }, new Set(['S2']));
    assert.equal(relative, 'caw/tests/t.yaml, caw/recordings/t.yaml');
    const text = readFileSync(testPath(root, 't'), 'utf8');
    assert.ok(text.startsWith('# Kopf vom Menschen\n'));
    assert.match(text, /# Über dem ersten/);
    assert.match(text, /# krumm eingerückt/);
    assert.match(text, /# Über dem zweiten\n {2}- id: S2/);
    assert.match(text, /Bleibt\./);
    assert.doesNotMatch(text, /recording|knownMessages/, 'Die Beschreibung bleibt ohne Aufzeichnung');
    assert.match(readFileSync(recordingPath(root, 't'), 'utf8'), /click: \{/, 'Ziele stehen in einer Zeile');
    const read = loadTest(root, 't');
    assert.equal(read.steps[0].recording, undefined);
    assert.equal(read.steps[1].do, 'neu');
    assert.equal(read.steps[1].recording.actions[1].value, '');
    assert.deepEqual(read.knownMessages, ['Ja Nein']);
});

test('Zwei Dateien: Lernt das Tool dazu, ändert sich nur die Aufzeichnung', (t) => {
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

test('Zwei Dateien: Eine alte Einzeldatei wird gelesen und beim Schreiben aufgeteilt', (t) => {
    const legacy = renderTest({ ...spec(recorded('S1'), recorded('S2', [], { after: 'S1' })), knownMessages: ['Alt'] });
    const root = testRoot(t, legacy);
    const loaded = loadTest(root, 't');
    assert.equal(loaded.steps[1].recording.after, 'S1');
    const changed = { ...loaded, steps: [{ ...loaded.steps[0], recording: { ...loaded.steps[0].recording, check: 'neu()' } }, loaded.steps[1]] };
    writeTest(root, changed, new Set(['S1']));
    assert.doesNotMatch(readFileSync(testPath(root, 't'), 'utf8'), /recording|knownMessages/);
    const back = loadTest(root, 't');
    assert.deepEqual([back.steps[0].recording.check, back.steps[1].recording.after, back.knownMessages], ['neu()', 'S1', ['Alt']]);
});

test('Zwei Dateien: Form der Aufzeichnung wird geprüft, verwaiste Aufzeichnungen sind ein Hinweis', (t) => {
    const root = testRoot(t);
    writeTest(root, spec(recorded('S1'), recorded('S2', [], { after: 'S1' })));
    const text = readFileSync(recordingPath(root, 't'), 'utf8');
    assert.throws(() => parseRecordings(text.replace('test: t', 'fremd: 1')), /test und steps/);
    assert.throws(() => parseRecordings(text.replace('check:', 'fremd: 1\n    check:')), /Unbekanntes Feld fremd/);
    writeFileSync(recordingPath(root, 't'), text.replace('test: t', 'test: anders'));
    assert.throws(() => loadTest(root, 't'), /gehört zu "anders"/);
    writeFileSync(recordingPath(root, 't'), text);
    writeFileSync(testPath(root, 't'), readFileSync(testPath(root, 't'), 'utf8').replace(/ {2}- id: S2[\s\S]*$/, ''));
    writeFileSync(recordingPath(root, 'weg'), text.replace('test: t', 'test: weg'));
    assert.deepEqual(recordingHints(root), ['caw/recordings/t.yaml: S2 steht nicht mehr in der Beschreibung.', 'caw/recordings/weg.yaml: Es gibt keine Beschreibung caw/tests/weg.yaml.']);
});

test('Schreiben: Neuaufnahme löst alle Schritte ab, Kopf und Metadaten bleiben, Zeilenenden auch', (t) => {
    const root = testRoot(t, `# Kopf\nid: t\napp: a\nrole: r\ntargets: [a/dev]\nmutates: true\nnotes: alt\nsteps:\n  - id: S1\n    name: Alt\n    do: ""\n    expect: Alt.\n  - id: S2\n    name: Weg\n    do: ""\n    expect: Weg.\n`.replaceAll('\n', '\r\n'));
    const loaded = loadTest(root, 't');
    writeTest(root, { ...loaded, notes: 'neu', steps: [recorded('S1')], expectations: [] });
    const raw = readFileSync(testPath(root, 't'), 'utf8');
    assert.ok(raw.includes('\r\n'));
    assert.ok(raw.startsWith('# Kopf'));
    const read = parseTest(raw);
    assert.equal(read.notes, 'neu');
    assert.deepEqual(read.steps.map(({ id }) => id), ['S1']);
});

test('Schreiben: Neue Datei ist lesbar, ein eingefügter Schritt landet an seiner Stelle', (t) => {
    const root = testRoot(t);
    const whole = { ...spec(recorded('S1'), recorded('S2', [], { after: 'S1' })), knownMessages: [] };
    writeTest(root, whole);
    assert.deepEqual(loadTest(root, 't').steps.map(({ id }) => id), ['S1', 'S2']);
    const added = { ...whole, steps: [whole.steps[0], recorded('S3', [], { after: 'S1' }), whole.steps[1]] };
    writeTest(root, added, new Set(['S3']));
    assert.deepEqual(loadTest(root, 't').steps.map(({ id }) => id), ['S1', 'S3', 'S2']);
});

test('loadTest: Fehlende Datei und fremde id', (t) => {
    const root = testRoot(t, YAML.replace('id: t', 'id: anders'));
    assert.throws(() => loadTest(root, 'gibtsnicht'), { code: 'test-missing' });
    assert.throws(() => loadTest(root, 't'), (error) => error.code === 'test-invalid' && /anders/.test(error.message));
});
