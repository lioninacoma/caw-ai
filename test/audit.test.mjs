// caw audit: which changes to the test data weaken a test (auditChanges, pure), how both sides are read, and the Markdown.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditChanges, readProjectData, renderAudit } from '../src/host/audit.mjs';
import { renderDescription, renderRecordings, stepHash } from '../src/host/test-file.mjs';

const SAVE = "getByRole('button', { name: 'Speichern', exact: true })";
const NAME = "getByRole('textbox', { name: 'Name', exact: true })";
const learned = (actions) => ({ runs: 2, actions });
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

test('auditChanges: learned effects dropped from a fail list, console errors accepted, forgotten; pruned warn lines are info', () => {
    const effects = learned([{ action: 1, controls: ['+ button "Stornieren"'], view: ['- heading "Neu"'], console: ['TypeError: x'] }]);
    const was = spec([step('S1', BASE[0].expect, { recording: { effects } }), BASE[1]]);
    const now = (changed) => spec([step('S1', BASE[0].expect, { recording: changed === undefined ? {} : { effects: changed } }), BASE[1]]);
    assert.deepEqual(audit(now(effects), { before: was }), []);
    assert.deepEqual(kinds(audit(now(learned([{ action: 1, view: ['- heading "Neu"'], console: ['TypeError: x'] }])), { before: was })), ['weakening:effects-dropped']);
    const accepted = audit(now(learned([{ action: 1, controls: ['+ button "Stornieren"'], view: ['- heading "Neu"'], console: ['TypeError: x', 'ReferenceError: y'] }])), { before: was });
    assert.deepEqual(kinds(accepted), ['weakening:effects-accepted']);
    assert.match(accepted[0].text, /ReferenceError: y/);
    assert.deepEqual(kinds(audit(now(undefined), { before: was })), ['weakening:effects-forgotten']);
    assert.deepEqual(kinds(audit(now({ runs: 1, actions: [] }), { before: was })), ['weakening:effects-forgotten']);
    assert.deepEqual(kinds(audit(now(learned([{ action: 1, controls: ['+ button "Stornieren"'], console: ['TypeError: x'] }])), { before: was })), ['info:effects-pruned']);
    // With view in the config's fail list, the same line counts.
    const strict = { ...CONFIG, effects: { fail: ['controls', 'console', 'view'] } };
    assert.deepEqual(kinds(audit(now(learned([{ action: 1, controls: ['+ button "Stornieren"'], console: ['TypeError: x'] }])), { before: was, configBefore: strict })), ['weakening:effects-dropped']);
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

test('auditChanges: an adopted proposal (only a target swapped) is listed with both locators, not a weakening', () => {
    const SICHERN = "getByRole('button', { name: 'Sichern', exact: true })";
    const effects = learned([{ action: 2, view: ['+ - status: Gespeichert'] }]);
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
