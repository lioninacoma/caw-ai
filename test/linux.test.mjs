import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toWslPath, shellQuote, parseEnvFile, parseRunArgs, claudeFailureReason, splitStep } from '../src/host/linux.mjs';

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

test('parseRunArgs: --overlay with and without source for run, record and open; no option means no overlay', () => {
    assert.equal(parseRunArgs('run', ['smoke', '--target', 'dev']).overlay, undefined);
    assert.equal(parseRunArgs('run', ['smoke', '--overlay']).overlay, true);
    assert.equal(parseRunArgs('run', ['--overlay', 'smoke']).test, 'smoke', 'a test name is not a source');
    assert.equal(parseRunArgs('run', ['--overlay', 'smoke']).overlay, true);
    assert.equal(parseRunArgs('run', ['smoke', '--overlay', 'build']).overlay, 'build');
    assert.equal(parseRunArgs('record', ['smoke@S2', '--overlay=dev']).overlay, 'dev');
    assert.equal(parseRunArgs('open', ['smoke@S2', '--overlay']).overlay, true);
    assert.equal(parseRunArgs('record', ['smoke', '--overlay', 'dev', '--target', 'dev']).overlay, 'dev');
    assert.deepEqual(parseRunArgs('run', ['--overlay=build', 'build']).tests, ['build'], 'a test named build with --overlay=…');
    assert.equal(parseRunArgs('run', ['smoke', '--overlay', 'http://localhost:5174']).overlay, 'http://localhost:5174', 'the address of a dev server');
    assert.equal(parseRunArgs('run', ['--overlay=https://box.local:8443/', 'smoke']).overlay, 'https://box.local:8443/');
    assert.throws(() => parseRunArgs('run', ['smoke', '--overlay=local']), (error) => error.code === 'usage' && /--overlay erwartet nichts, build, dev oder die Adresse eines Dev-Servers/.test(error.message));
    assert.throws(() => parseRunArgs('run', ['smoke', '--overlay=localhost:5173']), (error) => error.code === 'usage', 'no address without http://');
    assert.throws(() => parseRunArgs('run', ['smoke', '--code', 'local']), (error) => error.code === 'usage', '--code no longer exists');
});

test('parseRunArgs: --start lets caw run overlay.start, only together with --overlay, for run, record and open', () => {
    assert.equal(parseRunArgs('run', ['smoke', '--overlay']).start, undefined, 'without --start caw starts nothing');
    const run = parseRunArgs('run', ['smoke', '--overlay', '--start']);
    assert.deepEqual([run.tests, run.overlay, run.start], [['smoke'], true, true], '--start is no overlay source');
    assert.equal(parseRunArgs('run', ['--start', '--overlay', 'dev', 'smoke']).overlay, 'dev');
    assert.equal(parseRunArgs('record', ['smoke', '--overlay', '--start', '--target', 'dev']).start, true);
    assert.equal(parseRunArgs('record', ['smoke@S2', '--overlay=build', '--start']).start, true);
    assert.equal(parseRunArgs('open', ['--overlay', '--start']).start, true);
    assert.throws(() => parseRunArgs('run', ['smoke', '--start']), (error) => error.code === 'usage' && /--start geht nur mit --overlay/.test(error.message));
    assert.throws(() => parseRunArgs('open', ['--start']), (error) => error.code === 'usage');
});

test('parseRunArgs: each command only knows its own options', () => {
    const base = ['smoke', '--target', 'shop/dev'];
    assert.deepEqual(parseRunArgs('run', base), { test: 'smoke', tests: ['smoke'], target: 'shop/dev', advise: false, headless: false, noChat: false, learn: true, all: false, stepTimeoutSec: 30 });
    assert.equal(parseRunArgs('run', [...base, '--advise']).advise, true);
    // Limit Claude when clarifying and fixing, as for record and fix.
    assert.deepEqual((({ timeoutMin, maxSteps }) => [timeoutMin, maxSteps])(parseRunArgs('run', [...base, '--timeout', '5', '--max-steps=20'])), [5, 20]);
    assert.throws(() => parseRunArgs('run', [...base, '--max-steps', '0']), /--max-steps muss/);
    assert.equal(parseRunArgs('record', [...base, '--read-only']).readOnly, true);
    assert.throws(() => parseRunArgs('run', [...base, '--read-only']), /kennt die Option --read-only nicht/);
    assert.deepEqual([parseRunArgs('run', [...base, '--headless']).noChat, parseRunArgs('run', [...base, '--no-chat']).headless], [true, false]);
    assert.throws(() => parseRunArgs('run', [...base, '--headless', '--advise']), /--headless geht nicht zusammen mit --advise/);
    assert.throws(() => parseRunArgs('run', [...base, '--no-chat', '--advise']), /--no-chat geht nicht zusammen mit --advise/);
    assert.throws(() => parseRunArgs('record', [...base, '--advise']), /kennt die Option --advise nicht/);
    assert.throws(() => parseRunArgs('record', ['smoke@S4', '--target', 'shop/dev', '--advise']), /kennt die Option --advise nicht/);
    assert.deepEqual(parseRunArgs('record', base), { test: 'smoke', target: 'shop/dev', stepTimeoutSec: 30, timeoutMin: 60, also: [] });
    assert.deepEqual(parseRunArgs('record', ['smoke@S4', '--target', 'shop/dev']), { test: 'smoke', step: 'S4', target: 'shop/dev', stepTimeoutSec: 30, timeoutMin: 60, also: [] });
    assert.deepEqual(parseRunArgs('open', ['smoke@S4', '--target', 'shop/dev', '--step-timeout', '45']), { test: 'smoke', step: 'S4', target: 'shop/dev', stepTimeoutSec: 45, timeoutMin: 60 });
    assert.throws(() => parseRunArgs('record', ['smoke@E4', '--target', 'shop/dev']), /etwa bestellung@S3/);
    assert.throws(() => parseRunArgs('record', ['smoke@S4', 'S5', '--target', 'shop/dev']), /S5/);
    assert.equal(parseRunArgs('run', ['smoke', '--target=shop/dev', '--step-timeout', '60']).stepTimeoutSec, 60);
    const created = parseRunArgs('record', [...base, '--role', 'r', '--app', 'a', '--also', 'b', '--also=c', '--timeout', '5', '--max-steps=30']);
    assert.deepEqual([created.role, created.app, created.also, created.timeoutMin, created.maxSteps], ['r', 'a', ['b', 'c'], 5, 30]);
    assert.throws(() => parseRunArgs('run', ['--target', 'x']), /Name des Tests/);
    // Without --target the command chooses, see chooseTarget.
    assert.equal(parseRunArgs('run', ['smoke']).target, undefined);
    assert.throws(() => parseRunArgs('record', [...base, 'one-more']), /one-more/);
    assert.throws(() => parseRunArgs('run', [...base, '--step-timeout', '0']), /--step-timeout/);
    assert.throws(() => parseRunArgs('record', [...base, '--max-steps=0']), /--max-steps/);
    assert.throws(() => parseRunArgs('record', [...base, '--timeout', 'x']), /--timeout/);
});

test('parseRunArgs: test runs never use Claude, unknown options are refused', () => {
    const base = ['smoke', '--target', 'shop/dev'];
    for (const command of ['run', 'record', 'open']) assert.throws(() => parseRunArgs(command, [...base, '--foo']), /kennt die Option/);
    for (const claudeOnly of ['--role', '--app', '--also']) assert.throws(() => parseRunArgs('run', [...base, claudeOnly, '1']), /kennt die Option/);
});

test('splitStep and <test>@S<n>: the step goes with the test for record and open', () => {
    assert.deepEqual(splitStep('x'), { test: 'x' });
    assert.deepEqual(splitStep('x@S3'), { test: 'x', step: 'S3' });
    assert.deepEqual(splitStep('kündigung@S12'), { test: 'kündigung', step: 'S12' });
    for (const wrong of ['x@', 'x@s3', 'x@S0', '@S3', 'x@S3@S4', 'x@S03']) {
        assert.throws(() => splitStep(wrong), (error) => error.code === 'usage' && error.message.startsWith(`${wrong}: Ein Schritt steht als <test>@S<n>`), wrong);
    }
    for (const command of ['record', 'open']) {
        assert.deepEqual((({ test: id, step }) => [id, step])(parseRunArgs(command, ['x@S3'])), ['x', 'S3']);
        assert.equal(parseRunArgs(command, ['x']).step, undefined);
        assert.throws(() => parseRunArgs(command, ['x@S0']), (error) => error.code === 'usage');
    }
    // A test brings role and app; re-recording from a step keeps the test's metadata.
    assert.throws(() => parseRunArgs('open', ['x', '--role', 'r']), (error) => error.code === 'usage' && /--role gilt nur für open ohne Test/.test(error.message));
    assert.throws(() => parseRunArgs('open', ['x@S2', '--app', 'web']), (error) => error.code === 'usage' && /--app gilt nur für open ohne Test/.test(error.message));
    for (const [flag, ...value] of [['--role', 'r'], ['--app', 'a'], ['--also', 'b'], ['--read-only']]) {
        assert.throws(() => parseRunArgs('record', ['x@S2', flag, ...value]), (error) => error.code === 'usage' && error.message.startsWith(`${flag} gilt nur beim ersten Aufnehmen`), flag);
        assert.doesNotThrow(() => parseRunArgs('record', ['x', flag, ...value]), flag);
    }
});

test('parseRunArgs: open with or without a test, with target, role, app and overlay', () => {
    assert.deepEqual((({ target, role, app, overlay }) => ({ target, role, app, overlay }))(parseRunArgs('open', ['--target', 'dev', '--role', 'customer', '--app', 'shop', '--overlay', 'build'])), { target: 'dev', role: 'customer', app: 'shop', overlay: 'build' });
    assert.equal(parseRunArgs('open', []).overlay, undefined);
    assert.deepEqual((({ test: id, step }) => [id, step])(parseRunArgs('open', ['smoke'])), ['smoke', undefined], 'open takes a test');
    assert.throws(() => parseRunArgs('open', ['smoke', 'other']), (error) => error.code === 'usage' && /other/.test(error.message), 'one test');
});
