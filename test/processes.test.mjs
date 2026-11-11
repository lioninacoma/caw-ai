import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extjs } from '../src/host/framework/extjs.mjs';
import { commandLines, processRunning } from '../src/host/processes.mjs';

test('processes: command lines per platform, unknown instead of an error', () => {
    const calls = [];
    const exec = (command) => { calls.push(command); return 'a\r\n  sencha app watch --packages x \n\n'; };
    assert.deepEqual(commandLines('win32', exec), ['a', 'sencha app watch --packages x']);
    assert.deepEqual(commandLines('linux', exec), ['a', 'sencha app watch --packages x']);
    assert.deepEqual(calls, ['powershell.exe', 'ps']);
    assert.equal(commandLines('linux', () => { throw new Error('no ps'); }), null);
    assert.equal(processRunning(/x/, null), null);
    assert.equal(processRunning(/watch/, ['node vite']), false);
});

test('ExtJS: the Sencha watch is detected from the command line, also with quotes', () => {
    for (const line of ['sencha app watch --packages a,b', 'java -jar sencha.jar "app" "watch"', 'cmd /c sencha App Watch']) assert.ok(extjs.watch.command.test(line), line);
    for (const line of ['sencha app build', 'node watchapp.js', 'vite --watch']) assert.ok(!extjs.watch.command.test(line), line);
});
