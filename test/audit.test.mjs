// caw audit: which changes to the test data weaken a test (auditChanges, pure), how both sides are read, and the Markdown.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditChanges, readProjectData, renderAudit } from '../src/host/audit.mjs';
import { LEARN_RUNS } from '../src/host/effects.mjs';
import { renderDescription, renderRecordings, stepHash } from '../src/host/test-file.mjs';

const SAVE = "getByRole('button', { name: 'Speichern', exact: true })";
const NAME = "getByRole('textbox', { name: 'Name', exact: true })";
const learned = (actions) => ({ runs: LEARN_RUNS, actions });
const step = (id, expect, { check = `check${id}()`, actions = [{ action: 'click', target: SAVE }], recording = {}, ...extra } = {}) => {
    const plain = { id, name: `Schritt ${id}`, do: `Tu ${id}`, expect, ...extra };
    return { ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', recordedAt: '2026-11-06T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions, check, ...recording } };
};
const spec = (steps, extra = {}) => ({ id: 'bestellung', role: 'kunde', writes: true, notes: '', steps, ...extra });
const CONFIG = { environments: { local: { url: 'http://localhost:5173', writable: true, agent: true }, dev: { url: 'https://dev.example.test', writable: true } } };
const side = (tests, config = CONFIG) => ({ config, tests: new Map(tests.map((entry) => [entry.id, entry])), unreadable: [] });
const BASE = [step('S1', 'Die Liste ist leer.'), step('S2', 'Eine Bestellung steht in der Liste.', { check: 'rows() === 1' })];
const audit = (after, { before = spec(BASE), configBefore = CONFIG, configAfter = configBefore } = {}) => auditChanges(side([before], configBefore), side(after === null ? [] : [after], configAfter));
const kinds = (findings) => findings.map(({ kind, severity }) => `${severity}:${kind}`);

test('auditChanges: unchanged test data, nothing to report', () => {
    assert.deepEqual(audit(spec(BASE)), []);
});

test('auditChanges: a check changed while the expected result stayed is a weakening', () => {
    const findings = audit(spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() >= 0' })]));
    assert.deepEqual(kinds(findings), ['weakening:check-changed']);
    assert.equal(findings[0].step, 'S2');
    assert.equal(findings[0].before, 'rows() === 1');
    assert.equal(findings[0].after, 'rows() >= 0');
    assert.match(findings[0].text, /Prüfung von S2 hat sich geändert, obwohl das erwartete Ergebnis „Eine Bestellung steht in der Liste\.“ gleich blieb/);
});

test('auditChanges: a moved step with the same expected result and the same check is fine', () => {
    const moved = spec([step('S1', BASE[1].expect, { check: 'rows() === 1' }), step('S2', BASE[0].expect, { check: 'checkS1()' })]);
    assert.deepEqual(audit(moved), []);
});

test('auditChanges: a changed expected result is listed, with its check, not a weakening', () => {
    const findings = audit(spec([BASE[0], step('S2', 'Zwei Bestellungen stehen in der Liste.', { check: 'rows() === 2' })]));
    assert.deepEqual(kinds(findings), ['listed:expect-changed-check']);
    assert.deepEqual(findings[0].before, { expect: BASE[1].expect, check: 'rows() === 1' });
    assert.match(findings[0].text, /von „Eine Bestellung steht in der Liste\.“ zu „Zwei Bestellungen stehen in der Liste\.“, und mit ihm die Prüfung/);
    assert.deepEqual(kinds(audit(spec([BASE[0], step('S2', 'Zwei Bestellungen stehen in der Liste.', { check: 'rows() === 1' })]))), ['listed:expect-changed']);
});

test('auditChanges: removed tests and steps are weakenings, added ones are listed', () => {
    assert.deepEqual(kinds(audit(null)), ['weakening:test-removed']);
    assert.deepEqual(kinds(audit(spec([BASE[0]]))), ['weakening:step-removed']);
    assert.deepEqual(kinds(audit(spec([...BASE, step('S3', 'Die Bestellung ist gespeichert.')]))), ['listed:step-added']);
    const both = auditChanges(side([spec(BASE)]), side([spec(BASE), spec(BASE, { id: 'storno' })]));
    assert.deepEqual(kinds(both), ['listed:test-added']);
    assert.equal(both[0].test, 'storno');
});

test('auditChanges: environments narrowed, also from the config default to an own list', () => {
    assert.deepEqual(kinds(audit(spec(BASE, { environments: ['local'] }))), ['weakening:environments-narrowed']);
    const findings = audit(spec(BASE, { environments: ['local'] }), { before: spec(BASE, { environments: ['local', 'dev'] }) });
    assert.deepEqual(findings[0].before, ['local', 'dev']);
    assert.match(findings[0].text, /läuft nicht mehr auf dev/);
    assert.deepEqual(audit(spec(BASE, { environments: ['local', 'dev'] }), { before: spec(BASE, { environments: ['local'] }) }), [], 'widened is fine');
});

test('auditChanges: retry added or raised, timeouts raised, an action made optional', () => {
    assert.deepEqual(kinds(audit(spec([BASE[0], { ...BASE[1], retry: { times: 2 } }]))), ['weakening:retry-added']);
    assert.deepEqual(kinds(audit(spec([BASE[0], { ...BASE[1], retry: { times: 3 } }]), { before: spec([BASE[0], { ...BASE[1], retry: { times: 2 } }]) })), ['weakening:retry-raised']);
    assert.deepEqual(audit(spec([BASE[0], { ...BASE[1], retry: { times: 1 } }]), { before: spec([BASE[0], { ...BASE[1], retry: { times: 2 } }]) }), [], 'fewer retries are fine');
    const slow = audit(spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', recording: { timeoutMs: 60_000 } })]));
    assert.deepEqual(kinds(slow), ['weakening:timeout-raised']);
    assert.match(slow[0].text, /wartet bis zu 60 s statt 30 s/);
    assert.deepEqual(audit(spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', recording: { timeoutMs: 10_000 } })])), [], 'shorter is fine');
    const actionSlow = audit(spec([step('S1', BASE[0].expect, { actions: [{ action: 'click', target: SAVE, timeoutMs: 90_000 }] }), BASE[1]]));
    assert.deepEqual(kinds(actionSlow), ['weakening:action-timeout-raised']);
    const optional = audit(spec([step('S1', BASE[0].expect, { actions: [{ action: 'click', target: SAVE, optional: true }] }), BASE[1]]));
    assert.deepEqual(kinds(optional), ['weakening:action-optional']);
    assert.match(optional[0].text, /Aktion 1 von S1 \(click getByRole/);
    const banner = audit(spec([step('S1', BASE[0].expect, { actions: [{ action: 'click', target: NAME, optional: true }, { action: 'click', target: SAVE }] }), BASE[1]]));
    assert.deepEqual(banner, [], 'a new optional action (a cookie banner) is part of a recording, not a weakening');
});

test('auditChanges: known messages added', () => {
    const findings = audit(spec(BASE, { knownMessages: ['Gespeichert.', 'Server nicht erreichbar.'] }), { before: spec(BASE, { knownMessages: ['Gespeichert.'] }) });
    assert.deepEqual(kinds(findings), ['weakening:known-messages-added']);
    assert.match(findings[0].text, /Server nicht erreichbar\./);
    assert.deepEqual(audit(spec(BASE), { before: spec(BASE, { knownMessages: ['Gespeichert.'] }) }), []);
});

test('auditChanges: learned effect lines removed (any list), console errors accepted, forgotten', () => {
    const effects = learned([{ action: 1, controls: ['+ button "Stornieren"'], requests: ['GET /api/neu 200'], console: ['TypeError: x'] }]);
    const was = spec([step('S1', BASE[0].expect, { recording: { effects } }), BASE[1]]);
    const now = (changed) => spec([step('S1', BASE[0].expect, { recording: changed === undefined ? {} : { effects: changed } }), BASE[1]]);
    assert.deepEqual(audit(now(effects), { before: was }), []);
    assert.deepEqual(kinds(audit(now(learned([{ action: 1, requests: ['GET /api/neu 200'], console: ['TypeError: x'] }])), { before: was })), ['weakening:effects-removed']);
    const accepted = audit(now(learned([{ action: 1, controls: ['+ button "Stornieren"'], requests: ['GET /api/neu 200'], console: ['TypeError: x', 'ReferenceError: y'] }])), { before: was });
    assert.deepEqual(kinds(accepted), ['weakening:effects-accepted']);
    assert.match(accepted[0].text, /ReferenceError: y/);
    assert.deepEqual(kinds(audit(now(undefined), { before: was })), ['weakening:effects-forgotten']);
    assert.deepEqual(kinds(audit(now({ runs: 1, actions: [] }), { before: was })), ['weakening:effects-forgotten']);
    // Learned effects are frozen, caw never removes a line: one that only warns removed by hand weakens the step too.
    const warnLine = audit(now(learned([{ action: 1, controls: ['+ button "Stornieren"'], console: ['TypeError: x'] }])), { before: was });
    assert.deepEqual(kinds(warnLine), ['weakening:effects-removed']);
    assert.deepEqual(warnLine[0].before, ['1 requests: GET /api/neu 200']);
    assert.match(warnLine[0].text, /von Hand entfernt.*GET \/api\/neu 200/);
    // Lines gone and others new in the same list: learned anew, as after "Accept new effect" (forgotten, five runs). Listed with both.
    const relearned = audit(now(learned([{ action: 1, controls: ['+ button "Abbrechen"'], requests: ['GET /api/neu 200'], console: ['TypeError: x'] }])), { before: was });
    assert.deepEqual(kinds(relearned), ['listed:effects-replaced']);
    assert.deepEqual(relearned[0].before, ['1 controls: + button "Stornieren"']);
    assert.deepEqual(relearned[0].after, ['1 controls: + button "Abbrechen"']);
    // A new line elsewhere does not cover a removal: requests lost one, only controls gained one.
    assert.deepEqual(kinds(audit(now(learned([{ action: 1, controls: ['+ button "Stornieren"', '+ button "Neu"'], console: ['TypeError: x'] }])), { before: was })), ['weakening:effects-removed']);
    // A changed expected result is the deliberate way: listed, the removed lines are not a weakening then.
    const reworded = spec([step('S1', 'Die Liste ist jetzt leer.', { recording: { effects: learned([{ action: 1, console: ['TypeError: x'] }]) } }), BASE[1]]);
    assert.deepEqual(kinds(audit(reworded, { before: was })), ['listed:expect-changed']);
    // Still learning, or recorded anew with other actions: effects learn anew, nothing to compare.
    assert.deepEqual(audit(now(undefined), { before: spec([step('S1', BASE[0].expect, { recording: { effects: { runs: 1, actions: effects.actions } } }), BASE[1]]) }), []);
    assert.deepEqual(audit(spec([step('S1', BASE[0].expect, { actions: [{ action: 'click', target: NAME }] }), BASE[1]]), { before: was }), []);
});

test('auditChanges: changed request baselines are info', () => {
    const network = (ms) => [{ name: 'POST /api/orders', status: 201, ms }];
    const findings = audit(spec([step('S1', BASE[0].expect, { recording: { network: network(80) } }), BASE[1]]), { before: spec([step('S1', BASE[0].expect, { recording: { network: network(40) } }), BASE[1]]) });
    assert.deepEqual(kinds(findings), ['info:baselines-changed']);
});

test('auditChanges: config changes that weaken every test', () => {
    const findings = audit(spec(BASE), {
        configBefore: { ...CONFIG, consoleIgnore: ['^Warnung'], messageSelectors: ['[role=alert]', '.toast-error'] },
        configAfter: {
            ...CONFIG, consoleIgnore: ['^Warnung', 'TypeError'], foreignCode: ['/vendor/'], reads: ['POST /api/search'], messageSelectors: ['[role=alert]'],
            effects: { fail: ['console'] },
        },
    });
    assert.deepEqual(kinds(findings), ['weakening:config-console-ignore', 'weakening:config-foreign-code', 'weakening:config-reads', 'weakening:config-message-selectors', 'weakening:config-effects-fail']);
    assert.ok(findings.every(({ test: name }) => name === null));
    assert.match(findings[3].text, /\.toast-error/);
    assert.match(findings[4].text, /controls/);
    const guarded = audit(spec(BASE), { configAfter: { ...CONFIG, environments: { ...CONFIG.environments, dev: { ...CONFIG.environments.dev, agent: true } } } });
    assert.deepEqual(kinds(guarded), ['weakening:config-guarded']);
    assert.match(guarded[0].text, /environments\.dev\.agent/);
});

test('readProjectData: description and recording merged; an unreadable file is a weakening (nothing to compare), not a removed test', () => {
    const order = spec(BASE, { knownMessages: ['Gespeichert.'] });
    const files = new Map([
        ['caw.config.json', JSON.stringify(CONFIG)],
        ['caw/tests/bestellung.yaml', renderDescription(order)],
        ['caw/recordings/bestellung.yaml', renderRecordings(order)],
    ]);
    const read = readProjectData(files);
    assert.deepEqual(read.unreadable, []);
    assert.equal(read.tests.get('bestellung').steps[1].recording.check, 'rows() === 1');
    assert.deepEqual(read.tests.get('bestellung').knownMessages, ['Gespeichert.']);
    assert.deepEqual(auditChanges(read, readProjectData(files)), []);
    const broken = readProjectData(new Map([...files, ['caw/tests/bestellung.yaml', 'steps: [']]));
    assert.deepEqual(broken.unreadable, ['caw/tests/bestellung.yaml']);
    assert.deepEqual(kinds(auditChanges(read, broken)), ['weakening:unreadable']);
});

test('renderAudit: Markdown for the PR, weakenings first, checks as code', () => {
    const findings = audit(spec([step('S1', BASE[0].expect, { check: 'a`b' }), step('S2', 'Neu.', { check: 'rows() === 1' })]));
    const markdown = renderAudit({ ref: 'origin/main', base: '0123456789abcdef', findings });
    assert.match(markdown, /^## caw audit: Tests im Vergleich mit origin\/main \(Merge-Base 0123456789\)/);
    assert.match(markdown, /1 Änderung lässt einen Test bestehen/);
    assert.ok(markdown.indexOf('### Abgeschwächt (1)') < markdown.indexOf('### Geändert (1)'));
    assert.match(markdown, /- `bestellung`: Die Prüfung von S1/);
    assert.match(markdown, / {2}- jetzt: ``a`b``/);
    assert.match(renderAudit({ ref: 'main', base: 'abc', findings: [] }), /Kein Test, keine Aufnahme und keine Config geändert\./);
});

test('auditChanges: an adopted look is listed with its day; a look learned over runs is not', () => {
    const look = (extra) => ({ runs: 2, styles: ['button "Speichern": color #ffffff'], images: { linux: 2 }, ...extra });
    const before = spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', recording: { visual: look() } })]);
    const adopted = spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', recording: { visual: look({ styles: ['button "Speichern": color #000000'], adopted: '2026-11-21' }) } })]);
    const findings = audit(adopted, { before });
    assert.deepEqual(kinds(findings), ['listed:look-adopted']);
    assert.equal(findings[0].text, 'Für S2 wurde am 2026-11-21 ein neuer Look übernommen: seine Stile gelten ab jetzt, sein Bild lernen die nächsten Läufe headless neu.');
    assert.deepEqual(findings[0].after, ['button "Speichern": color #000000']);
    const learnedLook = spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', recording: { visual: look({ images: { linux: 2, win32: 1 } }) } })]);
    assert.deepEqual(audit(learnedLook, { before }), []);
    assert.deepEqual(audit(adopted, { before: adopted }), [], 'the same adoption is not listed again');
});

test('auditChanges: look: true taken off a step with a learned look weakens it; put on, it is listed', () => {
    const learnedLook = { runs: 2, styles: ['button ×1: color #ffffff'], images: { linux: 2 } };
    const withLook = (look, visual = learnedLook) => spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', ...(look ? { look: true } : {}), recording: { visual } })]);
    const off = audit(withLook(false), { before: withLook(true) });
    assert.deepEqual(kinds(off), ['weakening:look-off']);
    assert.match(off[0].text, /^S2 vergleicht sein gelerntes Aussehen nicht mehr/);
    assert.deepEqual(audit(withLook(false, { ...learnedLook, runs: 1 }), { before: withLook(true, { ...learnedLook, runs: 1 }) }), [], 'still learning: nothing was compared yet');
    assert.deepEqual(kinds(audit(withLook(true), { before: withLook(false) })), ['listed:look-on']);
    assert.deepEqual(audit(withLook(true), { before: withLook(true) }), []);
});

test('auditChanges: an adopted proposal (only a target swapped) is listed with both locators, not a weakening', () => {
    const SICHERN = "getByRole('button', { name: 'Sichern', exact: true })";
    const effects = learned([{ action: 2, controls: ['+ button "Rückgängig"'] }]);
    const before = spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', actions: [{ action: 'fill', target: NAME, value: 'x' }, { action: 'click', target: SAVE }], recording: { effects } })]);
    const after = spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', actions: [{ action: 'fill', target: NAME, value: 'x' }, { action: 'click', target: SICHERN }], recording: { effects } })]);
    const findings = audit(after, { before });
    assert.deepEqual(kinds(findings), ['listed:locator-changed']);
    assert.equal(findings[0].step, 'S2');
    assert.equal(findings[0].before, SAVE);
    assert.equal(findings[0].after, SICHERN);
    assert.equal(findings[0].text, `Aktion 2 von S2 nutzt ein anderes Element, ihre Prüfung blieb: ${SAVE} → ${SICHERN}.`);
    // Another action besides the target: a new recording, not a swapped locator.
    const rerecorded = spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', actions: [{ action: 'fill', target: NAME, value: 'y' }, { action: 'click', target: SICHERN }] })]);
    assert.equal(kinds(audit(rerecorded, { before })).includes('listed:locator-changed'), false);
});

test('auditChanges: a target design taken off a step, swapped for another or its file changed weakens the step', () => {
    const FORM = 'design/form.html';
    const designed = (design) => spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', ...(design === undefined ? {} : { design }) })]);
    const withDesigns = (tests, designs) => ({ ...side(tests), designs: new Map(Object.entries(designs)) });
    const off = audit(designed(undefined), { before: designed(FORM) });
    assert.deepEqual(kinds(off), ['weakening:design-removed']);
    assert.equal(off[0].step, 'S2');
    assert.match(off[0].text, /design\/form\.html/);
    assert.deepEqual(kinds(audit(designed('design/other.html'), { before: designed(FORM) })), ['weakening:design-changed']);
    assert.deepEqual(audit(designed(FORM), { before: designed(undefined) }), [], 'a new target design only adds a judgement');
    // The linked file itself replaced or gone: the step is judged against something else (or nothing) from now on.
    const changed = auditChanges(withDesigns([designed(FORM)], { [FORM]: 'aaa' }), withDesigns([designed(FORM)], { [FORM]: 'bbb' }));
    assert.deepEqual(kinds(changed), ['weakening:design-file-changed']);
    assert.match(changed[0].text, /design\/form\.html/);
    assert.deepEqual(kinds(auditChanges(withDesigns([designed(FORM)], { [FORM]: 'aaa' }), withDesigns([designed(FORM)], {}))), ['weakening:design-file-changed']);
    assert.deepEqual(auditChanges(withDesigns([designed(FORM)], { [FORM]: 'aaa' }), withDesigns([designed(FORM)], { [FORM]: 'aaa' })), []);
    assert.deepEqual(auditChanges(withDesigns([designed(FORM)], {}), withDesigns([designed(FORM)], { [FORM]: 'bbb' })), [], 'a file that was missing before judged nothing');
});

test('auditChanges: design.fail narrowed, visualIgnore and readyIgnore added weaken every test', () => {
    const findings = audit(spec(BASE), { configAfter: { ...CONFIG, design: { fail: ['target'] }, visualIgnore: ['.chart'], readyIgnore: ['.spinner'] } });
    assert.deepEqual(kinds(findings), ['weakening:config-visual-ignore', 'weakening:config-ready-ignore', 'weakening:config-design-fail']);
    assert.match(findings[0].text, /\.chart/);
    assert.match(findings[1].text, /\.spinner/);
    assert.match(findings[2].text, /visual/);
    assert.deepEqual(audit(spec(BASE), { configAfter: { ...CONFIG, design: { fail: ['target', 'visual'] } } }), [], 'failing on more is fine');
});

test('auditChanges: a learned look removed from the recording while look: true stays weakens the step', () => {
    const look = { runs: 2, styles: ['button ×1: color #ffffff'], images: { linux: 2 } };
    const withLook = (visual) => spec([BASE[0], step('S2', BASE[1].expect, { check: 'rows() === 1', look: true, recording: visual === undefined ? {} : { visual } })]);
    const findings = audit(withLook(undefined), { before: withLook(look) });
    assert.deepEqual(kinds(findings), ['weakening:look-forgotten']);
    assert.equal(findings[0].step, 'S2');
    assert.deepEqual(kinds(audit(withLook({ ...look, runs: 1 }), { before: withLook(look) })), ['weakening:look-forgotten']);
    assert.deepEqual(audit(withLook(undefined), { before: withLook({ ...look, runs: 1 }) }), [], 'still learning: nothing was compared yet');
});

const TWO = [{ action: 'fill', target: NAME, value: 'x' }, { action: 'click', target: SAVE }];

test('auditChanges: an action removed from a step weakens it', () => {
    const two = TWO;
    const removed = audit(spec([step('S1', BASE[0].expect, { actions: [two[1]] }), BASE[1]]), { before: spec([step('S1', BASE[0].expect, { actions: two }), BASE[1]]) });
    assert.deepEqual(kinds(removed), ['weakening:action-removed']);
    assert.match(removed[0].text, /fill getByRole\('textbox'/);
    // A wait taken out is no weaker check; another action in place of one is a new recording.
    assert.deepEqual(audit(spec([step('S1', BASE[0].expect, { actions: two }), BASE[1]]), { before: spec([step('S1', BASE[0].expect, { actions: [two[0], { action: 'wait-ready' }, two[1]] }), BASE[1]]) }), []);
    assert.deepEqual(audit(spec([step('S1', BASE[0].expect, { actions: [{ action: 'click', target: NAME }] }), BASE[1]]), { before: spec([step('S1', BASE[0].expect, { actions: two }), BASE[1]]) }), []);
});

test('auditChanges: learned effects removed behind an added wait-ready weaken the step', () => {
    const two = TWO;
    const effects = learned([{ action: 1, controls: ['+ button "Stornieren"'] }, { action: 2, requests: ['POST /api/orders 201'] }]);
    const was = spec([step('S1', BASE[0].expect, { actions: two, recording: { effects } }), BASE[1]]);
    const waiting = [two[0], { action: 'wait-ready' }, two[1]];
    // The same effects renumbered behind the wait: nothing weakened.
    const renumbered = learned([{ action: 1, controls: ['+ button "Stornieren"'] }, { action: 3, requests: ['POST /api/orders 201'] }]);
    assert.deepEqual(audit(spec([step('S1', BASE[0].expect, { actions: waiting, recording: { effects: renumbered } }), BASE[1]]), { before: was }), []);
    const dropped = audit(spec([step('S1', BASE[0].expect, { actions: waiting, recording: { effects: learned([{ action: 1, controls: ['+ button "Stornieren"'] }]) } }), BASE[1]]), { before: was });
    assert.deepEqual(kinds(dropped), ['weakening:effects-removed']);
    assert.match(dropped[0].text, /POST \/api\/orders 201/);
    assert.deepEqual(kinds(audit(spec([step('S1', BASE[0].expect, { actions: waiting }), BASE[1]]), { before: was })), ['weakening:effects-forgotten']);
});
