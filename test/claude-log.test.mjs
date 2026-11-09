import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeFailureReason } from '../src/host/linux.mjs';
import { colorEnabled, painter } from '../src/shared/color.mjs';
import { colorLine, formatClaudeLine, stampLine } from '../src/sandbox/claude-log.mjs';

const event = (value) => JSON.stringify(value);
const assistant = (...content) => event({ type: 'assistant', message: { content } });

test('formatClaudeLine zeigt Text und Befehle, aber keine Toolergebnisse und Interna', () => {
    assert.deepEqual(formatClaudeLine(assistant({ type: 'text', text: ' Ich prüfe E1. ' })), ['Ich prüfe E1.']);
    assert.deepEqual(formatClaudeLine(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'caw-ai\n  snapshot' } })), ['> Bash: caw-ai ⏎ snapshot']);
    assert.deepEqual(formatClaudeLine(assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/a' } })), ['> Read: {"file_path":"/a"}']);
    assert.deepEqual(formatClaudeLine(assistant({ type: 'thinking', thinking: 'geheim' })), []);
    assert.deepEqual(formatClaudeLine(event({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Seite' }] } })), []);
    assert.deepEqual(formatClaudeLine(event({ type: 'system', subtype: 'init', tools: [] })), []);
});

test('formatClaudeLine kürzt lange Eingaben', () => {
    const [line] = formatClaudeLine(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(2000) } }));
    assert.ok(line.length < 600);
    assert.ok(line.endsWith(' ...'));
});

test('formatClaudeLine lässt Nicht-JSON und leere Zeilen richtig durch', () => {
    assert.deepEqual(formatClaudeLine('Startfehler: kein Modul'), ['Startfehler: kein Modul']);
    assert.deepEqual(formatClaudeLine('   '), []);
    assert.deepEqual(formatClaudeLine(event({ type: 'neu' })), []);
});

test('formatClaudeLine meldet Abschluss, Fehler und Wiederholungen', () => {
    assert.deepEqual(formatClaudeLine(event({ duration_ms: 12400, is_error: false, result: 'Zusammenfassung', type: 'result' })), ['Claude beendet nach 12 s.']);
    assert.match(formatClaudeLine(event({ duration_ms: 1000, is_error: true, result: 'Failed to authenticate', type: 'result' }))[0], /mit Fehler: Failed to authenticate/);
    assert.match(formatClaudeLine(event({ type: 'system', subtype: 'api_retry', attempt: 2, error_status: 401, error: 'authentication_failed' }))[0], /401.*Versuch 2/);
});

test('Ein Anmeldefehler im Log wird auf dem Host weiter als Token-Problem erkannt', () => {
    const lines = formatClaudeLine(event({ type: 'result', is_error: true, duration_ms: 1, result: 'Failed to authenticate. API Error: 401 Invalid bearer token' }));
    assert.match(claudeFailureReason(1, lines.join('\n')), /CLAUDE_CODE_OAUTH_TOKEN/);
});

test('stampLine setzt die Sekunden seit dem Start davor', () => {
    assert.equal(stampLine('x', 1000, 13400), '[+12.4s] x\n');
});

test('stampLine entfernt Steuerzeichen, damit Portal-Text das Terminal nicht steuert', () => {
    assert.equal(stampLine('a\u001b[2Jb\u0007\r\nc\td', 0, 0), '[+0.0s] a[2Jb\nc\td\n');
});

test('colorLine färbt je nach Art der Zeile und lässt Claudes Text unverändert', () => {
    const paint = painter(true);
    assert.equal(colorLine('[+1.0s] > Bash: x\n', paint), `${paint.dim('[+1.0s]')} ${paint.cyan('> Bash: x')}\n`);
    assert.equal(colorLine('[+1.0s] API-Fehler 401\n', paint), `${paint.dim('[+1.0s]')} ${paint.yellow('API-Fehler 401')}\n`);
    assert.equal(colorLine('[+1.0s] Claude beendet nach 1 s mit Fehler: x\n', paint), `${paint.dim('[+1.0s]')} ${paint.red('Claude beendet nach 1 s mit Fehler: x')}\n`);
    assert.equal(colorLine('[+1.0s] Ich prüfe\nE1\n', paint), `${paint.dim('[+1.0s]')} Ich prüfe\nE1\n`);
});

test('Ohne Farbe entspricht die Terminalzeile genau der Log-Zeile', () => {
    const paint = painter(false);
    for (const line of ['[+1.0s] > Bash: x\n', '[+1.0s] Text\nmehr\n', '[+1.0s] Claude beendet nach 1 s.\n']) assert.equal(colorLine(line, paint), line);
});

test('colorEnabled: NO_COLOR gewinnt, FORCE_COLOR erzwingt, sonst das Terminal', () => {
    assert.equal(colorEnabled({ env: {}, isTTY: true }), true);
    assert.equal(colorEnabled({ env: {}, isTTY: false }), false);
    assert.equal(colorEnabled({ env: {}, isTTY: undefined }), false);
    assert.equal(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false }), true);
    assert.equal(colorEnabled({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true }), false);
});
