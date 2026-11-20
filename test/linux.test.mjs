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
    assert.match(claudeFailureReason(124, ''), /--agent-timeout 120m/);
    assert.match(claudeFailureReason(7, 'whatever'), /Exit 7/);
});

test('parseRunArgs: --overlay with and without source for run, record and open; no option means no overlay', () => {
    assert.equal(parseRunArgs('run', ['smoke', '--env', 'dev']).overlay, undefined);
    assert.equal(parseRunArgs('run', ['smoke', '--overlay']).overlay, true);
    assert.equal(parseRunArgs('run', ['--overlay', 'smoke']).test, 'smoke', 'a test name is not a source');
    assert.equal(parseRunArgs('run', ['--overlay', 'smoke']).overlay, true);
    assert.equal(parseRunArgs('run', ['smoke', '--overlay', 'build']).overlay, 'build');
    assert.equal(parseRunArgs('record', ['smoke@S2', '--overlay=dev']).overlay, 'dev');
    assert.equal(parseRunArgs('open', ['smoke@S2', '--overlay']).overlay, true);
    assert.equal(parseRunArgs('record', ['smoke', '--overlay', 'dev', '--env', 'dev']).overlay, 'dev');
    assert.deepEqual(parseRunArgs('run', ['--overlay=build', 'build']).tests, ['build'], 'a test named build with --overlay=…');
    assert.equal(parseRunArgs('run', ['smoke', '--overlay', 'http://localhost:5174']).overlay, 'http://localhost:5174', 'the address of a dev server');
    assert.equal(parseRunArgs('run', ['--overlay=https://box.local:8443/', 'smoke']).overlay, 'https://box.local:8443/');
    // Parts only with =: after a space a word is the test. checkTest validates the items against overlay.parts.
    assert.equal(parseRunArgs('run', ['smoke', '--overlay=orders,admin:dev']).overlay, 'orders,admin:dev');
    assert.deepEqual(parseRunArgs('run', ['--overlay', 'orders']).tests, ['orders'], 'a part after a space is the test');
    assert.throws(() => parseRunArgs('run', ['smoke', '--overlay=']), (error) => error.code === 'usage' && /Teile mit =, etwa --overlay=orders,admin:dev/.test(error.message));
    assert.throws(() => parseRunArgs('run', ['smoke', '--code', 'local']), (error) => error.code === 'usage', '--code no longer exists');
});

test('parseRunArgs: --start and --reset for run, record and open; --no-reset for run; whether the environment has the command is checked later', () => {
    assert.equal(parseRunArgs('run', ['smoke', '--overlay']).start, undefined, 'without --start caw starts nothing');
    const run = parseRunArgs('run', ['smoke', '--overlay', '--start']);
    assert.deepEqual([run.tests, run.overlay, run.start], [['smoke'], true, true], '--start is no overlay source');
    assert.equal(parseRunArgs('run', ['--start', '--overlay', 'dev', 'smoke']).overlay, 'dev');
    assert.equal(parseRunArgs('record', ['smoke', '--overlay', '--start', '--env', 'dev']).start, true);
    assert.equal(parseRunArgs('record', ['smoke@S2', '--overlay=build', '--start']).start, true);
    assert.equal(parseRunArgs('open', ['--overlay', '--start']).start, true);
    assert.equal(parseRunArgs('run', ['smoke', '--start']).start, true, 'the environment lifecycle, no --overlay needed');
    assert.equal(parseRunArgs('open', ['--start']).start, true);
    assert.equal(parseRunArgs('run', ['smoke', '--reset']).reset, 'force');
    assert.equal(parseRunArgs('run', ['smoke', '--no-reset']).reset, 'off');
    assert.equal(parseRunArgs('run', ['smoke']).reset, undefined, 'run resets before the first writing test by default');
    assert.equal(parseRunArgs('record', ['smoke', '--reset']).reset, 'force');
    assert.equal(parseRunArgs('open', ['smoke@S2', '--reset']).reset, 'force');
    assert.throws(() => parseRunArgs('run', ['smoke', '--reset', '--no-reset']), (error) => error.code === 'usage' && /--reset geht nicht zusammen mit --no-reset/.test(error.message));
    assert.throws(() => parseRunArgs('record', ['smoke', '--no-reset']), /record kennt die Option --no-reset nicht/);
});

test('parseRunArgs: each command only knows its own options', () => {
    const base = ['smoke', '--env', 'shop/dev'];
    assert.deepEqual(parseRunArgs('run', base), { test: 'smoke', tests: ['smoke'], target: 'shop/dev', advise: false, headless: false, noChat: false, learn: false, strict: false, all: false, stepTimeoutSec: 30 });
    assert.equal(parseRunArgs('run', [...base, '--explain']).advise, true);
    // Limit Claude when clarifying and fixing, as for record and fix.
    assert.deepEqual((({ timeoutMin, maxActions }) => [timeoutMin, maxActions])(parseRunArgs('run', [...base, '--agent-timeout', '5m', '--max-actions=20'])), [5, 20]);
    assert.throws(() => parseRunArgs('run', [...base, '--max-actions', '0']), /--max-actions muss/);
    assert.equal(parseRunArgs('record', [...base, '--read-only']).readOnly, true);
    assert.throws(() => parseRunArgs('run', [...base, '--read-only']), /kennt die Option --read-only nicht/);
    assert.deepEqual([parseRunArgs('run', [...base, '--headless']).noChat, parseRunArgs('run', [...base, '--no-chat']).headless], [true, false]);
    assert.throws(() => parseRunArgs('run', [...base, '--headless', '--explain']), /--headless geht nicht zusammen mit --explain/);
    assert.throws(() => parseRunArgs('run', [...base, '--no-chat', '--explain']), /--no-chat geht nicht zusammen mit --explain/);
    assert.throws(() => parseRunArgs('record', [...base, '--explain']), /kennt die Option --explain nicht/);
    assert.throws(() => parseRunArgs('record', ['smoke@S4', '--env', 'shop/dev', '--explain']), /kennt die Option --explain nicht/);
    assert.deepEqual(parseRunArgs('record', base), { test: 'smoke', target: 'shop/dev', stepTimeoutSec: 30, timeoutMin: 60 });
    assert.deepEqual(parseRunArgs('record', ['smoke@S4', '--env', 'shop/dev']), { test: 'smoke', step: 'S4', target: 'shop/dev', stepTimeoutSec: 30, timeoutMin: 60 });
    assert.deepEqual(parseRunArgs('open', ['smoke@S4', '--env', 'shop/dev', '--step-timeout', '45s']), { test: 'smoke', step: 'S4', target: 'shop/dev', stepTimeoutSec: 45, timeoutMin: 60 });
    assert.throws(() => parseRunArgs('record', ['smoke@E4', '--env', 'shop/dev']), /etwa bestellung@S3/);
    assert.throws(() => parseRunArgs('record', ['smoke@S4', 'S5', '--env', 'shop/dev']), /S5/);
    assert.equal(parseRunArgs('run', ['smoke', '--env=shop/dev', '--step-timeout', '1m']).stepTimeoutSec, 60);
    const created = parseRunArgs('record', [...base, '--role', 'r', '--agent-timeout=2h', '--max-actions=30']);
    assert.deepEqual([created.role, created.timeoutMin, created.maxActions], ['r', 120, 30]);
    // One application per project: --app and --also are gone, the message says why.
    for (const command of ['record', 'open', 'run']) {
        assert.throws(() => parseRunArgs(command, [...base, '--app', 'a']), (error) => error.code === 'usage' && /--app gibt es nicht mehr: eine Anwendung je Projekt/.test(error.message), command);
    }
    assert.throws(() => parseRunArgs('record', [...base, '--also=b']), /--also gibt es nicht mehr: --overlay bringt jeden Teil/);
    assert.throws(() => parseRunArgs('run', ['--env', 'x']), /Name des Tests/);
    // Without --env the command chooses, see chooseEnv.
    assert.equal(parseRunArgs('run', ['smoke']).target, undefined);
    assert.throws(() => parseRunArgs('record', [...base, 'one-more']), /one-more/);
    assert.throws(() => parseRunArgs('run', [...base, '--step-timeout', '0s']), /--step-timeout muss zwischen 1s und 10m liegen/);
    assert.throws(() => parseRunArgs('record', [...base, '--max-actions=0']), /--max-actions/);
    assert.throws(() => parseRunArgs('record', [...base, '--agent-timeout', 'x']), /--agent-timeout x ist keine Dauer/);
});

test('parseRunArgs: durations need a unit and stay in range; renamed flags name their new name', () => {
    const base = ['smoke', '--env', 'shop/dev'];
    assert.equal(parseRunArgs('run', [...base, '--step-timeout', '1500ms']).stepTimeoutSec, 1.5);
    assert.equal(parseRunArgs('run', [...base, '--step-timeout', '1.5s']).stepTimeoutSec, 1.5);
    assert.equal(parseRunArgs('record', [...base, '--agent-timeout', '1.5h']).timeoutMin, 90);
    // A bare number: seconds or minutes? Never guessed.
    assert.throws(() => parseRunArgs('run', [...base, '--step-timeout', '30']), (error) => error.code === 'usage' && /--step-timeout 30: Gib eine Einheit an, etwa --step-timeout 30s/.test(error.message));
    assert.throws(() => parseRunArgs('record', [...base, '--agent-timeout', '60']), /etwa --agent-timeout 60m/);
    assert.throws(() => parseRunArgs('run', [...base, '--step-timeout', '11m']), /zwischen 1s und 10m/);
    assert.throws(() => parseRunArgs('record', [...base, '--agent-timeout', '30s']), /zwischen 1m und 24h/);
    assert.throws(() => parseRunArgs('run', [...base, '--step-timeout', '30 s']), /keine Dauer/);
    for (const [old, now] of [['--target', '--env'], ['--timeout', '--agent-timeout'], ['--max-steps', '--max-actions'], ['--advise', '--explain']]) {
        assert.throws(() => parseRunArgs('run', ['smoke', old, '1']), (error) => error.code === 'usage' && error.message === `${old} heißt jetzt ${now}.`, old);
    }
});

test('parseRunArgs: test runs never use Claude, unknown options are refused', () => {
    const base = ['smoke', '--env', 'shop/dev'];
    for (const command of ['run', 'record', 'open']) assert.throws(() => parseRunArgs(command, [...base, '--foo']), /kennt die Option/);
    assert.throws(() => parseRunArgs('run', [...base, '--role', '1']), /kennt die Option/);
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
    // A test brings its role; re-recording from a step keeps the test's metadata.
    assert.throws(() => parseRunArgs('open', ['x', '--role', 'r']), (error) => error.code === 'usage' && /--role gilt nur für open ohne Test/.test(error.message));
    for (const [flag, ...value] of [['--role', 'r'], ['--read-only']]) {
        assert.throws(() => parseRunArgs('record', ['x@S2', flag, ...value]), (error) => error.code === 'usage' && error.message.startsWith(`${flag} gilt nur beim ersten Aufnehmen`), flag);
        assert.doesNotThrow(() => parseRunArgs('record', ['x', flag, ...value]), flag);
    }
});

test('parseRunArgs: open with or without a test, with target, role and overlay', () => {
    assert.deepEqual((({ target, role, overlay }) => ({ target, role, overlay }))(parseRunArgs('open', ['--env', 'dev', '--role', 'customer', '--overlay', 'build'])), { target: 'dev', role: 'customer', overlay: 'build' });
    assert.equal(parseRunArgs('open', []).overlay, undefined);
    assert.deepEqual((({ test: id, step }) => [id, step])(parseRunArgs('open', ['smoke'])), ['smoke', undefined], 'open takes a test');
    assert.throws(() => parseRunArgs('open', ['smoke', 'other']), (error) => error.code === 'usage' && /other/.test(error.message), 'one test');
});
