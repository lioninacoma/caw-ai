// Von Hand geschriebene Aktionen der Aufzeichnung: upload, download, ein geheimes remember, Muster in Zielnamen und knownMessages.
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
    actions:
${actions.split('\n').map((line) => `      ${line}`).join('\n')}
    check: "true"
${extra}`;
const actionsOf = (text) => parseRecordings(text).byId.get('S1').actions;

test('upload: Ziel und Dateien relativ zum caw-Ordner, nichts ausserhalb', () => {
    const [upload] = actionsOf(recording('- upload: {role: button, name: Dateien wählen}\n  files: [fixtures/brief.pdf, fixtures/scan.png]'));
    assert.deepEqual(upload, { action: 'upload', target: { role: 'button', name: 'Dateien wählen' }, files: ['fixtures/brief.pdf', 'fixtures/scan.png'] });
    for (const files of ['[]', '[../geheim.txt]', '[/etc/passwd]', '["C:/x.pdf"]', '[fixtures/../../x]', '"fixtures/a.pdf"']) {
        assert.throws(() => actionsOf(recording(`- upload: {role: button, name: Hochladen}\n  files: ${files}`)), /upload: files/, files);
    }
    assert.throws(() => actionsOf(recording('- upload: {role: button, name: Hochladen}')), /upload: files/);
});

test('download: Ziel und Muster des Dateinamens, das Muster muss gültig sein', () => {
    const [download] = actionsOf(recording('- download: {role: button, name: Exportieren}\n  file: "^akte-.*\\\\.zip$"'));
    assert.deepEqual(download, { action: 'download', target: { role: 'button', name: 'Exportieren' }, file: '^akte-.*\\.zip$' });
    assert.throws(() => actionsOf(recording('- download: {role: button, name: Exportieren}')), /download: file/);
    assert.throws(() => actionsOf(recording('- download: {role: button, name: Exportieren}\n  file: "(["')), /download: file/);
    assert.throws(() => actionsOf(recording('- click: {role: button, name: Exportieren}\n  file: x')), /unbekanntes Feld file/);
});

test('remember: secret: true markiert den Wert als geheim, anderes nicht', () => {
    const [remember] = actionsOf(recording('- remember: {name: davPassword, code: "1234abcd", secret: true}'));
    assert.deepEqual(remember, { action: 'remember', name: 'davPassword', code: '1234abcd', secret: true });
    assert.equal(actionsOf(recording('- remember: {name: nr, code: "1234"}'))[0].secret, undefined);
    assert.throws(() => actionsOf(recording('- remember: {name: nr, code: "1234", secret: ja}')), /remember/);
});

test('Ziele: Name als Muster, auch im Bereich; ein ungültiges Muster und ein Name über 80 Zeichen sind Fehler mit Grund', () => {
    const [click] = actionsOf(recording('- click: {role: button, name: {pattern: "^Prüfen( \\\\d+)?$"}, inside: {role: toolbar, name: {pattern: "^Dokumente"}}}'));
    assert.deepEqual(click.target, { role: 'button', name: { pattern: '^Prüfen( \\d+)?$' }, inside: { role: 'toolbar', name: { pattern: '^Dokumente' } } });
    assert.throws(() => actionsOf(recording('- click: {role: button, name: {pattern: "(["}}')), /Ziel/);
    assert.throws(() => actionsOf(recording('- click: {role: button, name: {muster: x}}')), /Ziel/);
    const long = 'x'.repeat(81);
    assert.throws(() => actionsOf(recording(`- click: {role: button, name: ${long}}`)), /80 Zeichen.*pattern/);
});

test('knownMessages: feste Texte und Muster, ungültige Muster werden abgelehnt, das Schreiben behält sie', () => {
    const parsed = parseRecordings(recording('- wait-ready: {}', 'knownMessages:\n  - Gespeichert\n  - {pattern: "^Prüfsumme \\\\S+ kopiert$"}\n'));
    assert.deepEqual(parsed.knownMessages, ['Gespeichert', { pattern: '^Prüfsumme \\S+ kopiert$' }]);
    assert.throws(() => parseRecordings(recording('- wait-ready: {}', 'knownMessages:\n  - {pattern: "(["}\n')), /knownMessages/);
    assert.throws(() => parseRecordings(recording('- wait-ready: {}', 'knownMessages:\n  - {pattern: x, mehr: y}\n')), /knownMessages/);
    const spec = { id: 't', steps: [{ id: 'S1', recording: parseRecordings(recording('- upload: {role: button, name: Hochladen}\n  files: [fixtures/a.pdf]\n- download: {role: button, name: Export}\n  file: "\\\\.csv$"\n- remember: {name: pw, code: x, secret: true}')).byId.get('S1') }], knownMessages: parsed.knownMessages };
    const again = parseRecordings(renderRecordings(spec));
    assert.deepEqual(again.knownMessages, parsed.knownMessages);
    assert.deepEqual(again.byId.get('S1').actions.map(({ action }) => action), ['upload', 'download', 'remember']);
    assert.deepEqual(again.byId.get('S1').actions[0].files, ['fixtures/a.pdf']);
    assert.equal(again.byId.get('S1').actions[1].file, '\\.csv$');
    assert.equal(again.byId.get('S1').actions[2].secret, true);
});

test('textMatcher: fester Text nur ganz, Muster per RegExp', () => {
    const known = textMatcher(['Gespeichert', { pattern: '^Prüfsumme \\S+ kopiert$' }]);
    assert.equal(known('Gespeichert'), true);
    assert.equal(known('Gespeichert.'), false);
    assert.equal(known('Prüfsumme a#f#c kopiert'), true);
    assert.equal(known('Prüfsumme fehlt'), false);
});

test('Ziele in iframes: frame ist selbst ein Ziel, verschachtelt erlaubt, und überlebt das Schreiben', () => {
    const [click] = actionsOf(recording('- click: {role: button, name: Bezahlen, frame: {tag: iframe, name: Karte, frame: {tag: iframe, name: Zahlung}}}'));
    assert.deepEqual(click.target, { role: 'button', name: 'Bezahlen', frame: { tag: 'iframe', name: 'Karte', frame: { tag: 'iframe', name: 'Zahlung' } } });
    assert.throws(() => actionsOf(recording('- click: {role: button, name: Bezahlen, frame: Zahlung}')), /Ziel/);
    assert.throws(() => actionsOf(recording(`- click: {role: button, frame: {tag: iframe, name: ${'x'.repeat(81)}}}`)), /80 Zeichen/);
    const spec = { id: 't', steps: [{ id: 'S1', recording: parseRecordings(recording('- click: {role: button, name: Bezahlen, frame: {tag: iframe, name: Zahlung}}')).byId.get('S1') }] };
    assert.deepEqual(parseRecordings(renderRecordings(spec)).byId.get('S1').actions[0].target.frame, { tag: 'iframe', name: 'Zahlung' });
});
