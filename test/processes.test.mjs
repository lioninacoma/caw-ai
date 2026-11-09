import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRunningWatch } from '../src/host/commands.mjs';
import { extjs } from '../src/host/framework/extjs.mjs';
import { commandLines, processRunning } from '../src/host/processes.mjs';

test('Prozesse: Befehlszeilen je Plattform, unbekannt statt Fehler', () => {
    const calls = [];
    const exec = (command, args) => { calls.push(command); return 'a\r\n  sencha app watch --packages x \n\n'; };
    assert.deepEqual(commandLines('win32', exec), ['a', 'sencha app watch --packages x']);
    assert.deepEqual(commandLines('linux', exec), ['a', 'sencha app watch --packages x']);
    assert.deepEqual(calls, ['powershell.exe', 'ps']);
    assert.equal(commandLines('linux', () => { throw new Error('kein ps'); }), null);
    assert.equal(processRunning(/x/, null), null);
    assert.equal(processRunning(/watch/, ['node vite']), false);
});

test('ExtJS: Der Sencha-Watch wird an der Befehlszeile erkannt, auch in Anführungszeichen', () => {
    for (const line of ['sencha app watch --packages a,b', 'java -jar sencha.jar "app" "watch"', 'cmd /c sencha App Watch']) assert.ok(extjs.watch.command.test(line), line);
    for (const line of ['sencha app build', 'node watchapp.js', 'vite --watch']) assert.ok(!extjs.watch.command.test(line), line);
});

test('Lokaler Code nur mit laufendem Watch, sonst der deployte Stand; ohne Watch-Angabe wie konfiguriert', () => {
    const local = { source: 'watch', url: 'https://p.example' };
    assert.equal(withRunningWatch({ framework: 'extjs' }, local, () => false).source, 'deployed');
    assert.equal(withRunningWatch({ framework: 'extjs' }, local, () => true).source, 'watch');
    assert.equal(withRunningWatch({ framework: 'extjs' }, local, () => null).source, 'watch', 'unbekannt: wie konfiguriert');
    assert.equal(withRunningWatch({ framework: 'react' }, local, () => false).source, 'watch', 'React: der Dev-Server ist der Watch');
    const deployed = { source: 'deployed' };
    assert.equal(withRunningWatch({ framework: 'extjs' }, deployed, () => { throw new Error('nicht gefragt'); }), deployed);
});
