// The agent's actions as sentences for people, folded by kind; the raw call stays as a tooltip.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { actionOf, actionText, foldAction } from '../src/host/activity.mjs';
import { parseClaudeLog } from '../src/host/chat.mjs';

test('activity: tool calls and caw commands become short sentences, a cut-off log line still names its file', () => {
    const text = (line) => { const { group, item } = actionOf(line); return actionText(group, [item]); };
    assert.equal(text('task'), 'Auftrag gelesen');
    assert.equal(text('snapshot'), 'Seite angesehen');
    assert.equal(text('click button "Speichern"'), 'button "Speichern" geklickt');
    assert.equal(text('Bash: caw agent click button "Speichern"'), 'button "Speichern" geklickt', 'the same from the container');
    assert.equal(text('fill textbox "Titel" "Milch"'), 'textbox "Titel" ausgefüllt', 'never the value');
    assert.equal(text('Grep: {"pattern":"disabled","output_mode":"content","glob":"!**/node_'), 'Nach „disabled“ gesucht', 'cut off in the log');
    assert.equal(text(String.raw`Read: {"file_path":"C:\\Users\\x\\caw-abnahme-g\\server.mjs"}`), 'caw-abnahme-g/server.mjs gelesen', 'the last two parts of the path');
    assert.equal(text(String.raw`Read: {"file_path":"C:\\Users\\x\\READ`), 'x/READ gelesen');
    assert.equal(text('Bash: ls -la'), '1 Shell-Befehl ausgeführt');
    assert.equal(text('Edit: {"file_path":"/app/src/a.js","old_string":"x"}'), 'src/a.js geändert');
    assert.equal(text('TodoWrite: {"todos":[]}'), 'Aufgabenliste aktualisiert');
    assert.equal(text('Strange: {}'), 'Strange benutzt');
});

test('activity: actions of one kind in a row fold into one with a count, another kind starts a new one', () => {
    let fold = null;
    const add = (line) => { fold = foldAction(fold, actionOf(line)); return fold; };
    assert.equal(add(String.raw`Read: {"file_path":"/p/server.mjs"}`).merged, false);
    const two = add(String.raw`Read: {"file_path":"/p/README.md"}`);
    assert.deepEqual([two.merged, two.text, two.items], [true, '2 Dateien gelesen', ['p/server.mjs', 'p/README.md']]);
    assert.equal(two.raws.length, 2);
    const other = add('snapshot');
    assert.deepEqual([other.merged, other.text], [false, 'Seite angesehen']);
    assert.equal(add('Bash: ls').text, '1 Shell-Befehl ausgeführt');
    assert.equal(add('Bash: pwd').text, '2 Shell-Befehle ausgeführt');
});

test('activity: a log line carries the sentence, the group and the raw call; say, chat and plan stay out', () => {
    const entry = parseClaudeLog('[+2.1s] > mcp__caw__caw: {"args":["click","button \\"Senden\\""]}');
    assert.deepEqual(entry, { kind: 'activity', text: 'button "Senden" geklickt', group: 'click', item: 'button "Senden"', raw: 'click button "Senden"' });
    assert.equal(parseClaudeLog('[+2.1s] > mcp__caw__caw: {"args":["say","Hallo"]}'), null);
    assert.equal(parseClaudeLog('[+3s] > Grep: {"pattern":"x"}').raw, 'Grep: {"pattern":"x"}');
});
