import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toWslPath, shellQuote, parseEnvFile, parseRunArgs, claudeFailureReason } from '../src/host/linux.mjs';

test('toWslPath rechnet Windows-Pfade um und lässt Linux-Pfade stehen', () => {
    assert.equal(toWslPath('C:\\Users\\Foo Bar\\App'), '/mnt/c/Users/Foo Bar/App');
    assert.equal(toWslPath('D:/x/y'), '/mnt/d/x/y');
    assert.equal(toWslPath('/home/u/x'), '/home/u/x');
    assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\x'), '/home/u/x');
    assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\home\\u\\x'), '/home/u/x');
});

test('shellQuote schützt Sonderzeichen', () => {
    assert.equal(shellQuote("a b'c"), "'a b'\\''c'");
    assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
});

test('parseEnvFile liest Werte mit und ohne Quotes und ignoriert Kommentare', () => {
    assert.deepEqual(parseEnvFile('# c\nA=1\nB="x y"\nC=\'z\'\r\n\nexport D=4\n'), { A: '1', B: 'x y', C: 'z', D: '4' });
});

test('claudeFailureReason benennt Token, Zeitlimit und Sonstiges', () => {
    assert.match(claudeFailureReason(1, 'Failed to authenticate. API Error: 401 Invalid bearer token'), /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(claudeFailureReason(124, ''), /--timeout/);
    assert.match(claudeFailureReason(7, 'irgendwas'), /Exit 7/);
});

test('parseRunArgs: --code local|deployed bei run, record und fix', () => {
    assert.equal(parseRunArgs('run', ['smoke', '--target', 'dev', '--code', 'deployed']).code, 'deployed');
    assert.equal(parseRunArgs('fix', ['smoke', 'S2', '--target', 'dev', '--code=local']).code, 'local');
    assert.equal(parseRunArgs('record', ['smoke', '--target', 'dev', '--code', 'deployed']).code, 'deployed');
    assert.equal(parseRunArgs('run', ['smoke', '--target', 'dev']).code, undefined);
    assert.throws(() => parseRunArgs('run', ['smoke', '--target', 'dev', '--code', 'watch']), (error) => error.code === 'usage' && /--code erwartet local, deployed/.test(error.message));
});

test('parseRunArgs: Jeder Befehl kennt nur seine Optionen', () => {
    const base = ['smoke', '--target', 'shop/dev'];
    assert.deepEqual(parseRunArgs('run', base), { test: 'smoke', tests: ['smoke'], target: 'shop/dev', handover: false, advise: false, headless: false, noChat: false, learn: true, all: false, stepTimeoutSec: 30 });
    assert.equal(parseRunArgs('run', [...base, '--advise']).advise, true);
    // Claude beim Klaeren und Beheben begrenzen, wie bei record und fix.
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
    // Ohne --target waehlt der Befehl selbst, siehe chooseTarget.
    assert.equal(parseRunArgs('run', ['smoke']).target, undefined);
    assert.throws(() => parseRunArgs('record', [...base, 'noch-einer']), /noch-einer/);
    assert.throws(() => parseRunArgs('run', [...base, '--step-timeout', '0']), /--step-timeout/);
    assert.throws(() => parseRunArgs('run', [...base, '--until', 'E4']), /--until/);
    assert.throws(() => parseRunArgs('record', [...base, '--max-steps=0']), /--max-steps/);
    assert.throws(() => parseRunArgs('record', [...base, '--timeout', 'x']), /--timeout/);
});

test('parseRunArgs: Testläufe nutzen nie Claude, und die alten Wege gibt es nicht mehr', () => {
    const base = ['smoke', '--target', 'shop/dev'];
    for (const old of ['--record', '--heal', '--show', '--chat', '--accept', '--foo']) {
        for (const command of ['run', 'record']) assert.throws(() => parseRunArgs(command, [...base, old]), /kennt die Option/);
    }
    for (const claudeOnly of ['--role', '--app', '--also']) assert.throws(() => parseRunArgs('run', [...base, claudeOnly, '1']), /kennt die Option/);
    assert.throws(() => parseRunArgs('record', [...base, '--until', 'S1']), /kennt die Option/);
    assert.throws(() => parseRunArgs('record', [...base, '--handover']), /kennt die Option/);
    assert.throws(() => parseRunArgs('fix', ['smoke', 'S1', '--target', 'a/dev', '--role', 'r']), /kennt die Option/);
});
