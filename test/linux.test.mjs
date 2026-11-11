import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toWslPath, shellQuote, parseEnvFile, parseRunArgs, claudeFailureReason } from '../src/host/linux.mjs';

test('toWslPath converts Windows paths and leaves Linux paths alone', () => {
    assert.equal(toWslPath('C:\\Users\\Foo Bar\\App'), '/mnt/c/Users/Foo Bar/App');
    assert.equal(toWslPath('D:/x/y'), '/mnt/d/x/y');
    assert.equal(toWslPath('/home/u/x'), '/home/u/x');
    assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\x'), '/home/u/x');
    assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\home\\u\\x'), '/home/u/x');
});

test('shellQuote protects special characters', () => {
    assert.equal(shellQuote("a b'c"), "'a b'\\''c'");
    assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
});

test('parseEnvFile reads values with and without quotes and ignores comments', () => {
    assert.deepEqual(parseEnvFile('# c\nA=1\nB="x y"\nC=\'z\'\r\n\nexport D=4\n'), { A: '1', B: 'x y', C: 'z', D: '4' });
});

test('claudeFailureReason names token, time limit and other causes', () => {
    assert.match(claudeFailureReason(1, 'Failed to authenticate. API Error: 401 Invalid bearer token'), /ANTHROPIC_API_KEY/);
    assert.match(claudeFailureReason(124, ''), /--timeout/);
    assert.match(claudeFailureReason(7, 'whatever'), /Exit 7/);
});

test('parseRunArgs: --overlay with and without source for run, record and fix; no option means no overlay', () => {
    assert.equal(parseRunArgs('run', ['smoke', '--target', 'dev']).overlay, undefined);
    assert.equal(parseRunArgs('run', ['smoke', '--overlay']).overlay, true);
    assert.equal(parseRunArgs('run', ['--overlay', 'smoke']).test, 'smoke', 'a test name is not a source');
    assert.equal(parseRunArgs('run', ['--overlay', 'smoke']).overlay, true);
    assert.equal(parseRunArgs('run', ['smoke', '--overlay', 'build']).overlay, 'build');
    assert.equal(parseRunArgs('fix', ['smoke', 'S2', '--overlay=dev']).overlay, 'dev');
    assert.equal(parseRunArgs('record', ['smoke', '--overlay', 'dev', '--target', 'dev']).overlay, 'dev');
    assert.deepEqual(parseRunArgs('run', ['--overlay=build', 'build']).tests, ['build'], 'a test named build with --overlay=…');
    assert.equal(parseRunArgs('run', ['smoke', '--overlay', 'http://localhost:5174']).overlay, 'http://localhost:5174', 'the address of a dev server');
    assert.equal(parseRunArgs('run', ['--overlay=https://box.local:8443/', 'smoke']).overlay, 'https://box.local:8443/');
    assert.throws(() => parseRunArgs('run', ['smoke', '--overlay=local']), (error) => error.code === 'usage' && /--overlay erwartet nichts, build, dev oder die Adresse eines Dev-Servers/.test(error.message));
    assert.throws(() => parseRunArgs('run', ['smoke', '--overlay=localhost:5173']), (error) => error.code === 'usage', 'no address without http://');
    assert.throws(() => parseRunArgs('run', ['smoke', '--code', 'local']), (error) => error.code === 'usage', '--code no longer exists');
});

test('parseRunArgs: --start lets caw run overlay.start, only together with --overlay, for run, record, fix and open', () => {
    assert.equal(parseRunArgs('run', ['smoke', '--overlay']).start, undefined, 'without --start caw starts nothing');
    const run = parseRunArgs('run', ['smoke', '--overlay', '--start']);
    assert.deepEqual([run.tests, run.overlay, run.start], [['smoke'], true, true], '--start is no overlay source');
    assert.equal(parseRunArgs('run', ['--start', '--overlay', 'dev', 'smoke']).overlay, 'dev');
    assert.equal(parseRunArgs('record', ['smoke', '--overlay', '--start', '--target', 'dev']).start, true);
    assert.equal(parseRunArgs('fix', ['smoke', 'S2', '--overlay=build', '--start']).start, true);
    assert.equal(parseRunArgs('open', ['--overlay', '--start']).start, true);
    assert.throws(() => parseRunArgs('run', ['smoke', '--start']), (error) => error.code === 'usage' && /--start geht nur mit --overlay/.test(error.message));
    assert.throws(() => parseRunArgs('open', ['--start']), (error) => error.code === 'usage');
});

test('parseRunArgs: each command only knows its own options', () => {
    const base = ['smoke', '--target', 'shop/dev'];
    assert.deepEqual(parseRunArgs('run', base), { test: 'smoke', tests: ['smoke'], target: 'shop/dev', handover: false, advise: false, headless: false, noChat: false, learn: true, all: false, stepTimeoutSec: 30 });
    assert.equal(parseRunArgs('run', [...base, '--advise']).advise, true);
    // Limit Claude when clarifying and fixing, as for record and fix.
    assert.deepEqual((({ timeoutMin, maxSteps }) => [timeoutMin, maxSteps])(parseRunArgs('run', [...base, '--timeout', '5', '--max-steps=20'])), [5, 20]);
    assert.throws(() => parseRunArgs('run', [...base, '--max-steps', '0']), /--max-steps muss/);
    assert.equal(parseRunArgs('record', [...base, '--read-only']).readOnly, true);
    assert.throws(() => parseRunArgs('run', [...base, '--read-only']), /kennt die Option --read-only nicht/);
    assert.deepEqual([parseRunArgs('run', [...base, '--headless']).noChat, parseRunArgs('run', [...base, '--no-chat']).headless], [true, false]);
    assert.throws(() => parseRunArgs('run', [...base, '--headless', '--until', 'S2']), /--headless geht nicht zusammen mit --until/);
    assert.throws(() => parseRunArgs('run', [...base, '--no-chat', '--advise']), /--no-chat geht nicht zusammen mit --advise/);
    assert.throws(() => parseRunArgs('run', [...base, '--no-chat', '--handover']), /--handover/);
    assert.throws(() => parseRunArgs('record', [...base, '--advise']), /kennt die Option --advise nicht/);
    assert.throws(() => parseRunArgs('fix', ['smoke', 'S4', '--target', 'shop/dev', '--advise']), /kennt die Option --advise nicht/);
    assert.deepEqual(parseRunArgs('record', base), { test: 'smoke', target: 'shop/dev', stepTimeoutSec: 30, timeoutMin: 60, also: [] });
    assert.deepEqual(parseRunArgs('fix', ['smoke', 'S4', '--target', 'shop/dev']), { test: 'smoke', step: 'S4', target: 'shop/dev', stepTimeoutSec: 30, timeoutMin: 60 });
    assert.throws(() => parseRunArgs('fix', base), /Schritt wie S4/);
    assert.throws(() => parseRunArgs('fix', ['smoke', 'E4', '--target', 'shop/dev']), /Schritt wie S4/);
    assert.throws(() => parseRunArgs('fix', ['smoke', 'S4', 'S5', '--target', 'shop/dev']), /S5/);
    assert.equal(parseRunArgs('run', [...base, '--handover']).handover, true);
    assert.equal(parseRunArgs('run', [...base, '--until', 'S4']).until, 'S4');
    assert.equal(parseRunArgs('run', ['smoke', '--target=shop/dev', '--step-timeout', '60']).stepTimeoutSec, 60);
    const created = parseRunArgs('record', [...base, '--role', 'r', '--app', 'a', '--also', 'b', '--also=c', '--timeout', '5', '--max-steps=30']);
    assert.deepEqual([created.role, created.app, created.also, created.timeoutMin, created.maxSteps], ['r', 'a', ['b', 'c'], 5, 30]);
    assert.throws(() => parseRunArgs('run', ['--target', 'x']), /Name des Tests/);
    // Without --target the command chooses, see chooseTarget.
    assert.equal(parseRunArgs('run', ['smoke']).target, undefined);
    assert.throws(() => parseRunArgs('record', [...base, 'one-more']), /one-more/);
    assert.throws(() => parseRunArgs('run', [...base, '--step-timeout', '0']), /--step-timeout/);
    assert.throws(() => parseRunArgs('run', [...base, '--until', 'E4']), /--until/);
    assert.throws(() => parseRunArgs('record', [...base, '--max-steps=0']), /--max-steps/);
    assert.throws(() => parseRunArgs('record', [...base, '--timeout', 'x']), /--timeout/);
});

test('parseRunArgs: test runs never use Claude, and the old options are gone', () => {
    const base = ['smoke', '--target', 'shop/dev'];
    for (const old of ['--record', '--heal', '--show', '--chat', '--accept', '--foo']) {
        for (const command of ['run', 'record']) assert.throws(() => parseRunArgs(command, [...base, old]), /kennt die Option/);
    }
    for (const claudeOnly of ['--role', '--app', '--also']) assert.throws(() => parseRunArgs('run', [...base, claudeOnly, '1']), /kennt die Option/);
    assert.throws(() => parseRunArgs('record', [...base, '--until', 'S1']), /kennt die Option/);
    assert.throws(() => parseRunArgs('record', [...base, '--handover']), /kennt die Option/);
    assert.throws(() => parseRunArgs('fix', ['smoke', 'S1', '--target', 'a/dev', '--role', 'r']), /kennt die Option/);
});

test('parseRunArgs: open without a test, with target, role, app and overlay', () => {
    assert.deepEqual((({ target, role, app, overlay }) => ({ target, role, app, overlay }))(parseRunArgs('open', ['--target', 'dev', '--role', 'customer', '--app', 'shop', '--overlay', 'build'])), { target: 'dev', role: 'customer', app: 'shop', overlay: 'build' });
    assert.equal(parseRunArgs('open', []).overlay, undefined);
    assert.throws(() => parseRunArgs('open', ['smoke']), (error) => error.code === 'usage' && /smoke/.test(error.message), 'open takes no test');
    assert.throws(() => parseRunArgs('open', ['--until', 'S2']), (error) => error.code === 'usage', 'open has no --until');
});
