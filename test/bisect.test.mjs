// caw bisect: exit codes for git bisect run, the cases that stop the bisect (128), every error caught, and the test read from
// the ref while the working tree holds another commit.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BISECT_EXIT, bisectCommand, bisectExit } from '../src/host/bisect.mjs';
import { CawError, EXIT } from '../src/shared/errors.mjs';
import { renderDescription, renderRecordings, stepHash } from '../src/host/test-file.mjs';

const step = (id, expect, { recorded = true } = {}) => {
    const plain = { id, name: `Schritt ${id}`, do: `Tu ${id}`, expect };
    if (!recorded) return plain;
    return { ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', recordedAt: '2026-11-06T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [], check: `check${id}()` } };
};
const order = (steps) => ({ id: 'bestellung', writes: true, notes: '', steps });
const RECORDED = order([step('S1', 'Die Liste ist leer.'), step('S2', 'Eine Bestellung steht in der Liste.')]);
const ENVIRONMENT = { url: 'http://localhost:5173', writable: true, start: 'npm start' };
const config = (local = ENVIRONMENT, extra = {}) => JSON.stringify({ language: 'de', environments: { local }, effects: { fail: ['controls', 'console'] }, ...extra });

/** The test data at the ref, as git.readAtCommit returns it. */
const filesOf = ({ spec = RECORDED, configText = config(), recordings = true } = {}) => new Map([
    ...(configText === null ? [] : [['caw.config.json', configText]]),
    ...(spec === null ? [] : [['caw/tests/bestellung.yaml', renderDescription(spec)]]),
    ...(spec === null || !recordings ? [] : [['caw/recordings/bestellung.yaml', renderRecordings(spec)]]),
]);

/** bisectCommand with everything injected; returns the exit, the printed lines, the errors shown and what ran. */
const bisect = async (args, { files = filesOf(), resolve = () => 'abc123', probe = false, runOne, lifecycle = {} } = {}) => {
    const printed = [];
    const fatal = [];
    const calls = { begin: 0, end: 0, runs: [], lifecycle: [] };
    const deps = {
        print: (line) => printed.push(line),
        ui: { info: () => {}, warn: () => {}, fatal: (code, text, { exit }) => fatal.push({ code, text, exit }) },
        git: { resolveCommit: (_root, ref) => resolve(ref), readAtCommit: () => files, shortHead: () => 'a1b2c3d' },
        probe: async () => probe,
        lifecycle: (_root, env, options) => {
            calls.lifecycle.push({ env, options });
            return {
                begin: async () => { calls.begin += 1; await lifecycle.begin?.(); },
                beforeTest: async () => {},
                end: async () => { calls.end += 1; await lifecycle.end?.(); },
            };
        },
        runOne: async (root, options, runDeps, loaded) => {
            calls.runs.push({ options, runDeps, loaded });
            return runOne === undefined ? { code: EXIT.pass } : runOne();
        },
    };
    const exit = await bisectCommand('/projekt', args, deps);
    return { exit, printed, fatal, calls };
};
const failedOn = (side) => () => ({ code: EXIT.fail, failed: { id: 'S2', reason: 'x', diagnosis: { side, strength: 'likely' } } });

test('bisectExit: pass is good, a step failed on the app is bad, everything else skips', () => {
    assert.equal(bisectExit({ code: EXIT.pass }), BISECT_EXIT.good);
    assert.equal(bisectExit(failedOn('app')()), BISECT_EXIT.bad);
    for (const side of ['environment', 'test', 'unclear']) assert.equal(bisectExit(failedOn(side)()), BISECT_EXIT.skip, side);
    assert.equal(bisectExit({ code: EXIT.fail, failed: { id: 'S1' } }), BISECT_EXIT.skip);
    assert.equal(bisectExit({ code: EXIT.fail }), BISECT_EXIT.skip);
    assert.equal(bisectExit({ code: EXIT.error, verdict: { code: 'env-unreachable' } }), BISECT_EXIT.skip);
    assert.deepEqual(BISECT_EXIT, { good: 0, bad: 1, skip: 125, abort: 128 });
});

test('bisect: a passing commit is good, one line with commit, result and exit', async () => {
    const { exit, printed, calls } = await bisect(['bestellung', '--env', 'local']);
    assert.equal(exit, 0);
    assert.deepEqual(printed, ['caw bisect a1b2c3d: bestanden, Einschätzung –, Exit 0 (gut)']);
    assert.equal(calls.begin, 1);
    assert.equal(calls.end, 1);
});

test('bisect: runs headless without chat and learning, the environment always started, no effect fails a step', async () => {
    const { calls } = await bisect(['bestellung', '--env', 'local', '--step-timeout', '10s']);
    assert.equal(calls.lifecycle[0].options.start, true);
    assert.equal(calls.lifecycle[0].env.start, 'npm start');
    const [{ options, runDeps, loaded }] = calls.runs;
    assert.equal(options.headless, true);
    assert.equal(options.noChat, true);
    assert.equal(options.learn, false);
    assert.equal(options.stepTimeoutSec, 10);
    // As in CI: a run that learns nothing.
    assert.equal(runDeps.interactive, false);
    assert.deepEqual(loaded.config.effects.fail, []);
    assert.equal(loaded.spec.id, 'bestellung');
    assert.equal(loaded.target, 'local');
});

test('bisect: a step failed on the app is bad, any other assessment skips', async () => {
    const bad = await bisect(['bestellung', '--env', 'local'], { runOne: failedOn('app') });
    assert.equal(bad.exit, 1);
    assert.deepEqual(bad.printed, ['caw bisect a1b2c3d: gescheitert bei S2, Einschätzung Fehler der Anwendung, Exit 1 (schlecht)']);
    for (const side of ['environment', 'test', 'unclear']) {
        const skipped = await bisect(['bestellung', '--env', 'local'], { runOne: failedOn(side) });
        assert.equal(skipped.exit, 125, side);
        assert.match(skipped.printed[0], /Exit 125 \(übersprungen\)$/);
    }
    const error = await bisect(['bestellung', '--env', 'local'], { runOne: () => ({ code: EXIT.error, verdict: { code: 'login-failed' } }) });
    assert.equal(error.exit, 125);
    assert.match(error.printed[0], /kein Urteil \(login-failed\)/);
});

test('bisect: a pending tail plays like run, the recorded steps decide', async () => {
    const { exit, calls } = await bisect(['bestellung', '--env', 'local'], { files: filesOf({ spec: order([...RECORDED.steps, step('S3', 'Gespeichert.', { recorded: false })]) }) });
    assert.equal(exit, 0);
    assert.equal(calls.runs.length, 1);
});

test('bisect: errors during the run are caught and skip the commit, the environment is stopped', async () => {
    const thrown = await bisect(['bestellung', '--env', 'local'], { runOne: () => { throw new Error('Playwright ist abgestürzt'); } });
    assert.equal(thrown.exit, 125);
    assert.equal(thrown.calls.end, 1);
    assert.equal(thrown.fatal[0].exit, 125);
    const start = await bisect(['bestellung', '--env', 'local'], { lifecycle: { begin: () => { throw new CawError('env-start-failed', 'Build kaputt'); } } });
    assert.equal(start.exit, 125);
    assert.equal(start.calls.runs.length, 0);
    assert.equal(start.calls.end, 1);
    assert.match(start.printed[0], /kein Urteil \(env-start-failed\).*Exit 125/);
    const stop = await bisect(['bestellung', '--env', 'local'], { lifecycle: { end: () => { throw new Error('stop hängt'); } } });
    assert.equal(stop.exit, 0);
    const git = await bisect(['bestellung', '--env', 'local'], { resolve: () => { throw new Error('git ist abgestürzt'); } });
    assert.equal(git.exit, 125);
});

test('bisect: stops the bisect (128) when no commit could give a verdict', async () => {
    const aborts = async (args, options, pattern) => {
        const { exit, fatal, printed, calls } = await bisect(args, options);
        assert.equal(exit, 128, String(pattern));
        assert.match(fatal[0].text, pattern);
        assert.match(printed[0], /^caw bisect a1b2c3d: nicht gelaufen \([a-z-]+\), Einschätzung –, Exit 128 \(git bisect bricht ab\)$/);
        assert.equal(calls.begin, 0, 'nothing started');
    };
    await aborts(['bestellung', '--env', 'local'], { probe: true }, /local antwortet unter http:\/\/localhost:5173, bevor caw sie gestartet hat/);
    await aborts(['bestellung', '--env', 'local'], { files: filesOf({ configText: config({ url: 'http://localhost:5173', writable: true }) }) }, /local hat keinen Startbefehl/);
    await aborts(['bestellung', '--env', 'local'], { files: filesOf({ spec: null }) }, /caw\/tests\/bestellung\.yaml fehlt im Commit von --tests-from/);
    await aborts(['bestellung', '--env', 'local'], { files: filesOf({ recordings: false }) }, /bestellung/);
    const changed = order([RECORDED.steps[0], { ...RECORDED.steps[1], expect: 'Zwei Bestellungen stehen in der Liste.' }]);
    await aborts(['bestellung', '--env', 'local'], { files: filesOf({ spec: changed }) }, /S2/);
    await aborts(['bestellung', '--env', 'local'], { files: filesOf({ configText: '{ kaputt' }) }, /caw\.config\.json/);
    await aborts(['bestellung', '--env', 'local'], { files: filesOf({ configText: config(ENVIRONMENT, { unbekannt: 1 }) }) }, /unbekannt/);
    await aborts(['bestellung', '--env', 'test'], {}, /test/);
    await aborts(['bestellung'], {}, /Nenn die Umgebung/);
    await aborts(['bestellung@S2', '--env', 'local'], {}, /bestellung@S2/);
    await aborts(['bestellung', '--env', 'local', '--headless'], {}, /--headless/);
    await aborts(['bestellung', '--env', 'local'], { resolve: (ref) => { throw new CawError('git-ref', `kenne ${ref} nicht`); } }, /refs\/bisect\/bad gibt es nicht: Ruf caw bisect aus git bisect run auf/);
    await aborts(['bestellung', '--env', 'local', '--tests-from', 'v9'], { resolve: (ref) => { throw new CawError('git-ref', `kenne ${ref} nicht`); } }, /kenne v9 nicht/);
});

test('bisect: test and config come from the ref, not from the checked-out commit', async (t) => {
    const top = mkdtempSync(join(tmpdir(), 'caw-bisect-'));
    t.after(() => rmSync(top, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: top, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'bisect@example.test');
    git('config', 'user.name', 'Bisect');
    git('config', 'core.autocrlf', 'false');
    const root = join(top, 'app');
    const write = (path, text) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
    };
    // The old commit: another start command and no test at all.
    write('caw.config.json', config({ ...ENVIRONMENT, start: 'npm run alt' }));
    write('src/app.js', 'export const version = 1;');
    git('add', '-A');
    git('commit', '-q', '-m', 'alt');
    const old = git('rev-parse', 'HEAD');
    for (const [path, text] of filesOf()) write(path, text);
    write('src/app.js', 'export const version = 2;');
    git('add', '-A');
    git('commit', '-q', '-m', 'neu');
    git('update-ref', 'refs/bisect/bad', 'HEAD');
    git('checkout', '-q', old);
    const printed = [];
    const runs = [];
    let started;
    const exit = await bisectCommand(root, ['bestellung', '--env', 'local'], {
        print: (line) => printed.push(line),
        ui: { info: () => {}, warn: () => {}, fatal: (code, text) => assert.fail(`${code}: ${text}`) },
        probe: async () => false,
        lifecycle: (_root, env) => {
            started = env.start;
            return { begin: async () => {}, beforeTest: async () => {}, end: async () => {} };
        },
        runOne: async (_root, _options, _deps, loaded) => {
            runs.push(loaded);
            return { code: EXIT.pass };
        },
    });
    assert.equal(exit, 0);
    assert.equal(started, 'npm start');
    assert.deepEqual(runs[0].spec.steps.map(({ id, recording }) => [id, recording?.check]), [['S1', 'checkS1()'], ['S2', 'checkS2()']]);
    assert.equal(printed[0], `caw bisect ${git('rev-parse', '--short', 'HEAD')}: bestanden, Einschätzung –, Exit 0 (gut)`);
});
