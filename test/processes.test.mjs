import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireRunningWatch } from '../src/host/commands.mjs';
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

test('Overlay nur mit laufendem Watch: sonst Abbruch mit dem Startbefehl, nie still der ausgelieferte Stand', () => {
    const overlay = { source: 'overlay', url: 'https://p.example' };
    assert.throws(() => requireRunningWatch({ framework: 'extjs' }, overlay, () => false), (error) => error.code === 'watch-missing' && /sencha app watch/.test(error.message));
    assert.equal(requireRunningWatch({ framework: 'extjs' }, overlay, () => true), overlay);
    assert.equal(requireRunningWatch({ framework: 'extjs' }, overlay, () => null), overlay, 'unbekannt: zählt als laufend');
    assert.equal(requireRunningWatch({ framework: 'react' }, overlay, () => false), overlay, 'React: kein Watch im Adapter');
    const deployed = { source: 'deployed' };
    assert.equal(requireRunningWatch({ framework: 'extjs' }, deployed, () => { throw new Error('nicht gefragt'); }), deployed);
});
