// The recording file on the native model: one Playwright locator per target, hand-written actions (upload, download, a secret
// remember), regular expressions in locators and knownMessages.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRecordings, renderRecordings } from '../src/host/test-file.mjs';
import { textMatcher } from '../src/host/patterns.mjs';

const recording = (actions, extra = '') => `test: t
steps:
  - id: S1
    hash: abc
    recordedOn: local
    recordedAt: 2026-11-09T08:00:00.000Z
    locale: de-DE
    timezone: Europe/Berlin
    actions:
${actions.split('\n').map((line) => `      ${line}`).join('\n')}
    check: "true"
${extra}`;
const actionsOf = (text, options) => parseRecordings(text, undefined, options).byId.get('S1').actions;
const SAVE = "getByRole('button', { name: 'Speichern', exact: true })";
const yamlText = (code) => JSON.stringify(code);

test('target: one locator as code, frames, rows and regular expressions included; it is stored as it was written', () => {
    for (const code of [
        SAVE,
        "getByRole('listitem').filter({ hasText: 'Feed the raven {{runTag}}' }).getByRole('button', { name: 'Complete', exact: true })",
        "locator('iframe[title=\"Zahlung\"]').contentFrame().locator('iframe[title=\"Karte\"]').contentFrame().getByRole('button', { name: 'Bezahlen', exact: true })",
        "getByRole('button', { name: /^Prüfen( \\d+)?$/ })",
        "getByTestId('save')",
        "locator('extjs=button[text=\"Abbrechen\"]')",
    ]) {
        const [click] = actionsOf(recording(`- click: ${yamlText(code)}`));
        assert.deepEqual(click, { action: 'click', target: code }, code);
    }
});

test('target: anything that is not one parseable, stable locator is an error with the reason', () => {
    const cases = [
        ['{role: button, name: Speichern}', /Ziel muss ein Playwright-Locator/],
        [yamlText("page.getByRole('button')"), /click: Locator/],
        [yamlText("getByRole('button', { name: 'Speichern' }).click()"), /click: Locator/],
        [yamlText("getByRole('button', { name: /([/ })"), /click: Locator/],
        [yamlText("locator('aria-ref=e12')"), /Schnappschuss|aria-ref/],
        [yamlText("locator('ul > li:nth-child(2) button')"), /nth-child|Position/],
        [yamlText("getByRole('button').describe('Speichern')"), /describe/],
    ];
    for (const [target, reason] of cases) assert.throws(() => actionsOf(recording(`- click: ${target}`)), reason, target);
});

test('target: generated ids are rejected for ExtJS only; elsewhere an id is the app\'s own', () => {
    const code = yamlText("locator('#button-1023')");
    assert.throws(() => actionsOf(recording(`- click: ${code}`), { framework: 'extjs' }), /button-1023/);
    assert.equal(actionsOf(recording(`- click: ${code}`), { framework: 'web' })[0].target, "locator('#button-1023')");
});

test('upload: target and files relative to the caw folder, nothing outside', () => {
    const target = "getByRole('button', { name: 'Dateien wählen', exact: true })";
    const [upload] = actionsOf(recording(`- upload: ${yamlText(target)}\n  files: [fixtures/brief.pdf, fixtures/scan.png]`));
    assert.deepEqual(upload, { action: 'upload', target, files: ['fixtures/brief.pdf', 'fixtures/scan.png'] });
    for (const files of ['[]', '[../geheim.txt]', '[/etc/passwd]', '["C:/x.pdf"]', '[fixtures/../../x]', '"fixtures/a.pdf"']) {
        assert.throws(() => actionsOf(recording(`- upload: ${yamlText(SAVE)}\n  files: ${files}`)), /upload: files/, files);
    }
    assert.throws(() => actionsOf(recording(`- upload: ${yamlText(SAVE)}`)), /upload: files/);
});

test('download: target and file name pattern; the pattern must be valid', () => {
    const target = "getByRole('button', { name: 'Exportieren', exact: true })";
    const [download] = actionsOf(recording(`- download: ${yamlText(target)}\n  file: "^akte-.*\\\\.zip$"`));
    assert.deepEqual(download, { action: 'download', target, file: '^akte-.*\\.zip$' });
    assert.throws(() => actionsOf(recording(`- download: ${yamlText(target)}`)), /download: file/);
    assert.throws(() => actionsOf(recording(`- download: ${yamlText(target)}\n  file: "(["`)), /download: file/);
    assert.throws(() => actionsOf(recording(`- click: ${yamlText(target)}\n  file: x`)), /unbekanntes Feld file/);
});

test('component and source: optional texts beside a target, a hint for diagnosis only', () => {
    const [click] = actionsOf(recording(`- click: ${yamlText(SAVE)}\n  component: App › TodoForm\n  source: src/TodoForm.vue`));
    assert.deepEqual(click, { action: 'click', target: SAVE, component: 'App › TodoForm', source: 'src/TodoForm.vue' });
    assert.throws(() => actionsOf(recording(`- click: ${yamlText(SAVE)}\n  component: 3`)), /component muss ein Text sein/);
    assert.throws(() => actionsOf(recording('- goto: /a\n  component: X')), /unbekanntes Feld component/);
});

test('dblclick: a target like click, written and read back unchanged; optional exists for click only', () => {
    const row = "getByRole('row').filter({ hasText: '1000001' })";
    const [dblclick] = actionsOf(recording(`- dblclick: ${yamlText(row)}`));
    assert.deepEqual(dblclick, { action: 'dblclick', target: row });
    const spec = { id: 't', steps: [{ id: 'S1', recording: parseRecordings(recording(`- dblclick: ${yamlText(row)}`)).byId.get('S1') }] };
    assert.deepEqual(actionsOf(renderRecordings(spec)), [dblclick]);
    assert.throws(() => actionsOf(recording(`- dblclick: ${yamlText(row)}\n  optional: true`)), /unbekanntes Feld optional/);
});

test('remember: secret: true marks the value as secret, nothing else does', () => {
    const [remember] = actionsOf(recording('- remember: {name: davPassword, code: "1234abcd", secret: true}'));
    assert.deepEqual(remember, { action: 'remember', name: 'davPassword', code: '1234abcd', secret: true });
    assert.equal(actionsOf(recording('- remember: {name: nr, code: "1234"}'))[0].secret, undefined);
    assert.throws(() => actionsOf(recording('- remember: {name: nr, code: "1234", secret: ja}')), /remember/);
});

test('writing: every action on one line, the locator unchanged; knownMessages with patterns survive', () => {
    const parsed = parseRecordings(recording('- wait-ready: {}', 'knownMessages:\n  - Gespeichert\n  - {pattern: "^Prüfsumme \\\\S+ kopiert$"}\n'));
    assert.deepEqual(parsed.knownMessages, ['Gespeichert', { pattern: '^Prüfsumme \\S+ kopiert$' }]);
    assert.throws(() => parseRecordings(recording('- wait-ready: {}', 'knownMessages:\n  - {pattern: "(["}\n')), /knownMessages/);
    assert.throws(() => parseRecordings(recording('- wait-ready: {}', 'knownMessages:\n  - {pattern: x, mehr: y}\n')), /knownMessages/);
    const frame = "locator('iframe[title=\"Zahlung\"]').contentFrame().getByRole('button', { name: 'O\\'Brien zahlt', exact: true })";
    const actions = [
        `- upload: ${yamlText(SAVE)}\n  files: [fixtures/a.pdf]`,
        `- download: ${yamlText(SAVE)}\n  file: "\\\\.csv$"`,
        `- click: ${yamlText(frame)}\n  optional: true`,
        '- remember: {name: pw, code: x, secret: true}',
    ].join('\n');
    const spec = { id: 't', steps: [{ id: 'S1', recording: parseRecordings(recording(actions)).byId.get('S1') }], knownMessages: parsed.knownMessages };
    const text = renderRecordings(spec);
    assert.match(text, /^ {6}- \{upload: .*, files: \[fixtures\/a\.pdf\]\}$/m);
    const again = parseRecordings(text);
    assert.deepEqual(again.knownMessages, parsed.knownMessages);
    const [upload, download, click, remember] = again.byId.get('S1').actions;
    assert.deepEqual(upload, { action: 'upload', target: SAVE, files: ['fixtures/a.pdf'] });
    assert.equal(download.file, '\\.csv$');
    assert.deepEqual(click, { action: 'click', target: frame, optional: true });
    assert.equal(remember.secret, true);
});

test('textMatcher: fixed text only as a whole, patterns via RegExp', () => {
    const known = textMatcher(['Gespeichert', { pattern: '^Prüfsumme \\S+ kopiert$' }]);
    assert.equal(known('Gespeichert'), true);
    assert.equal(known('Gespeichert.'), false);
    assert.equal(known('Prüfsumme a#f#c kopiert'), true);
    assert.equal(known('Prüfsumme fehlt'), false);
});
