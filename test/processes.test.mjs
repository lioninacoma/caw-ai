import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extjs } from '../src/host/framework/extjs.mjs';
import { listeningPorts, matchingPids, parseListening, processList } from '../src/host/processes.mjs';

test('processes: id and command line per platform, unknown instead of an error', () => {
    const calls = [];
    const exec = (command) => { calls.push(command); return ' 12 a\r\n  345   sencha app watch --packages x \n\n7\n'; };
    const expected = [{ pid: 12, command: 'a' }, { pid: 345, command: 'sencha app watch --packages x' }];
    assert.deepEqual(processList('win32', exec), expected);
    assert.deepEqual(processList('linux', exec), expected);
    assert.deepEqual(calls, ['powershell.exe', 'ps']);
    assert.equal(processList('linux', () => { throw new Error('no ps'); }), null);
    assert.deepEqual(matchingPids(/x/, null), []);
    assert.deepEqual(matchingPids(/watch/, [{ pid: 1, command: 'node vite' }]), []);
    assert.deepEqual(matchingPids(extjs.watch.command, expected), [345]);
});

test('listening ports: parsed from Get-NetTCPConnection, ss and lsof output', () => {
    assert.deepEqual(parseListening('\r\n4321 1841\r\n4321 52775\r\n  88 445 \r\nnoise\r\n', 'windows'), [
        { pid: 4321, port: 1841 }, { pid: 4321, port: 52775 }, { pid: 88, port: 445 },
    ]);
    const ss = [
        'LISTEN 0      50                 *:1841             *:*    users:(("java",pid=4321,fd=45))',
        'LISTEN 0      4096       127.0.0.1:631        0.0.0.0:*',
        'LISTEN 0      511             [::]:5173          [::]:*    users:(("node",pid=77,fd=20),("node",pid=78,fd=20))',
    ].join('\n');
    assert.deepEqual(parseListening(ss, 'ss'), [{ pid: 4321, port: 1841 }, { pid: 77, port: 5173 }, { pid: 78, port: 5173 }]);
    const lsof = ['p4321', 'f45', 'n*:1841', 'f46', 'n127.0.0.1:52775', 'p77', 'f20', 'n[::1]:5173', ''].join('\n');
    assert.deepEqual(parseListening(lsof, 'lsof'), [{ pid: 4321, port: 1841 }, { pid: 4321, port: 52775 }, { pid: 77, port: 5173 }]);
    assert.deepEqual(parseListening('whatever', 'unknown'), []);
});

test('listening ports: only of the given processes, sorted and once; ss falls back to lsof; unknown is empty', () => {
    const calls = [];
    const windows = (command, args) => { calls.push([command, args.at(-1)]); return '9 52775\n9 1841\n9 1841\n10 80\n'; };
    assert.deepEqual(listeningPorts([9], { platform: 'win32', exec: windows }), [1841, 52775]);
    assert.match(calls[0][1], /Get-NetTCPConnection -State Listen/);
    assert.deepEqual(listeningPorts([], { platform: 'win32', exec: windows }), []);
    assert.equal(calls.length, 1, 'no process, no query');
    const tools = [];
    const linux = (command) => {
        tools.push(command);
        if (command === 'ss') throw new Error('no ss');
        return 'p9\nn*:1841\n';
    };
    assert.deepEqual(listeningPorts([9], { platform: 'linux', exec: linux }), [1841]);
    assert.deepEqual(tools, ['ss', 'lsof']);
    assert.deepEqual(listeningPorts([9], { platform: 'linux', exec: () => { throw new Error('nothing'); } }), []);
});

test('ExtJS: the Sencha watch is detected from the command line, also with quotes', () => {
    for (const line of ['sencha app watch --packages a,b', 'java -jar sencha.jar "app" "watch"', 'cmd /c sencha App Watch']) assert.ok(extjs.watch.command.test(line), line);
    for (const line of ['sencha app build', 'node watchapp.js', 'vite --watch']) assert.ok(!extjs.watch.command.test(line), line);
});
