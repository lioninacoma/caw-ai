// The environment lifecycle (§2.9): the team's own commands to start, stop and reset an environment, and the readiness probe.
// caw starts only with --start, stops only what it started, and never touches a production environment (validate refuses it).
// Commands run with the platform shell in the project root (Node's shell: cmd.exe /d /s /c on Windows, /bin/sh -c elsewhere), with
// CAW_ENV and CAW_ENV_URL set; their output goes to .caw/env/<env>-start.log, -stop.log and -reset.log.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

import { isLoopback } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { RUN_DIR } from '../shared/names.mjs';

export const LOG_DIR = `${RUN_DIR}/env`;
const PROBE_MS = 5000;
const POLL_MS = 1000;
export const STOP_LIMIT_MS = 120_000;
export const RESET_LIMIT_MS = 600_000;
const TAIL_LINES = 15;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The log file of one lifecycle command, relative to the project root. */
export const logPath = (env, what) => `${LOG_DIR}/${env}-${what}.log`;

/** The last lines of a log, for the error message; empty if there is none. */
export const logTail = (file, lines = TAIL_LINES) => {
    try {
        return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').slice(-lines).join('\n');
    } catch {
        return '';
    }
};

/**
 * One readiness probe: a GET to <url><path> with the environment's TLS setting. Ready is any answer below 500 within 5 s: a 404 or a
 * sign-in redirect means the server is up.
 */
export const probeReady = (env, { timeoutMs = PROBE_MS } = {}) => new Promise((ok) => {
    const url = new URL(env.ready.path, env.url);
    // localhost and *.localhost on 127.0.0.1, as for Chrome (see reachable in run.mjs).
    const loopback = isLoopback(url.hostname) ? { lookup: (_host, options, done) => (options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)) } : {};
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = request(url, { method: 'GET', rejectUnauthorized: !env.insecureTls, timeout: timeoutMs, ...loopback }, (res) => {
        res.resume();
        ok(res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); ok(false); });
    req.on('error', () => ok(false));
    req.end();
});

/** Ends a process with all its children (npm → vite, cmd.exe → node). */
export const killTree = (pid, platform = process.platform) => {
    if (pid === undefined) return;
    try {
        if (platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(-pid, 'SIGKILL');
    } catch {
        // already gone
    }
};

/**
 * Starts a lifecycle command in the background, output to its log.
 * @returns { child, done: Promise<{ code }>, exited(): boolean }
 */
export const spawnCommand = (root, env, what, command, { spawnImpl = spawn } = {}) => {
    const log = join(root, logPath(env.name, what));
    mkdirSync(join(log, '..'), { recursive: true });
    const out = openSync(log, 'w');
    let child;
    try {
        child = spawnImpl(command, {
            cwd: root,
            shell: true,
            stdio: ['ignore', out, out],
            windowsHide: true,
            // Its own process group outside Windows, so the whole tree can be ended at once.
            detached: process.platform !== 'win32',
            env: { ...process.env, CAW_ENV: env.name, CAW_ENV_URL: env.url },
        });
    } finally {
        closeSync(out);
    }
    let exited = false;
    const done = new Promise((resolve) => {
        child.on('exit', (code, signal) => { exited = true; resolve({ code: code ?? (signal === null ? 0 : 1) }); });
        child.on('error', () => { exited = true; resolve({ code: 127 }); });
    });
    return { child, log, done, exited: () => exited };
};

/** Runs a lifecycle command to its end, at most `limitMs`; past the limit its tree is ended. @returns { code, timedOut } */
export const runCommand = async (root, env, what, command, { limitMs, spawnImpl } = {}) => {
    const started = spawnCommand(root, env, what, command, { spawnImpl });
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(null), limitMs); });
    const ended = await Promise.race([started.done, limit]);
    clearTimeout(timer);
    if (ended !== null) return { ...ended, timedOut: false, log: started.log };
    killTree(started.child.pid);
    await Promise.race([started.done, sleep(2000)]);
    return { code: null, timedOut: true, log: started.log };
};

/**
 * Polls the readiness probe every second until it answers, the start command fails or the time is up.
 * @returns 'ready' | 'failed' (with code) | 'timeout' | 'aborted'
 */
const waitReady = async (env, started, { aborted = () => false, probe = probeReady, pollMs = POLL_MS } = {}) => {
    const until = Date.now() + env.ready.timeoutMs;
    let exitCode = null;
    started.done.then(({ code }) => { exitCode = code; });
    for (;;) {
        if (aborted()) return { state: 'aborted' };
        if (await probe(env)) return { state: 'ready' };
        // A detaching command (docker compose up -d --wait) exits 0 and leaves the environment running: keep polling.
        if (exitCode !== null && exitCode !== 0) return { state: 'failed', code: exitCode };
        if (Date.now() >= until) return { state: 'timeout' };
        await sleep(pollMs);
    }
};

/** The log tail as an indented block for messages, or nothing. */
const tailBlock = (file) => {
    const tail = logTail(file);
    return tail === '' ? '' : `\n${tail.split('\n').map((line) => `  ${line}`).join('\n')}`;
};

/**
 * Starts an environment for a command (--start) unless it already answers, and returns how to stop it again.
 * - Already up: "already running", nothing started, nothing stopped.
 * - Otherwise start runs without waiting for its end; ready is polled. A start that fails first is env-start-failed, one that is
 *   never ready env-not-ready; either way what caw started is cleaned up before the error.
 * @returns { started: boolean, stop: () => Promise<void> }
 */
export const startEnvironment = async (root, env, { info = () => {}, warn = () => {}, aborted, probe = probeReady, spawnImpl, pollMs } = {}) => {
    if (await probe(env)) {
        info(t('session.lifecycle.alreadyRunning', { env: env.name }));
        return { started: false, stop: async () => {} };
    }
    info(t('session.lifecycle.starting', { env: env.name, command: env.start, log: logPath(env.name, 'start') }));
    const started = spawnCommand(root, env, 'start', env.start, { spawnImpl });
    // If caw ends without cleanup (a second Ctrl+C, a crash), a long-running start does not outlive it.
    const onExit = () => killTree(started.child.pid);
    process.once('exit', onExit);
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        if (env.stop !== undefined) {
            info(t('session.lifecycle.stopping', { env: env.name, command: env.stop }));
            const result = await runCommand(root, env, 'stop', env.stop, { limitMs: STOP_LIMIT_MS, spawnImpl });
            if (result.timedOut) warn(t('session.lifecycle.stopTimeout', { env: env.name, seconds: STOP_LIMIT_MS / 1000, log: logPath(env.name, 'stop') }));
            else if (result.code !== 0) warn(t('session.lifecycle.stopFailed', { env: env.name, code: result.code, log: logPath(env.name, 'stop') }));
        }
        // A long-running start (npm run dev) still runs: end it with its children.
        if (!started.exited()) {
            killTree(started.child.pid);
            await Promise.race([started.done, sleep(5000)]);
        }
        process.removeListener('exit', onExit);
    };
    const waited = await waitReady(env, started, { aborted, probe, pollMs });
    if (waited.state === 'ready') {
        info(t('session.lifecycle.ready', { env: env.name }));
        return { started: true, stop };
    }
    await stop();
    if (waited.state === 'aborted') throw new CawError('aborted', t('session.lifecycle.aborted', { env: env.name }));
    if (waited.state === 'failed') {
        throw new CawError('env-start-failed', t('session.lifecycle.startFailed', { env: env.name, code: waited.code, log: logPath(env.name, 'start'), tail: tailBlock(started.log) }));
    }
    throw new CawError('env-not-ready', t('session.lifecycle.notReady', {
        env: env.name, url: new URL(env.ready.path, env.url).href, seconds: Math.round(env.ready.timeoutMs / 1000), log: logPath(env.name, 'start'), tail: tailBlock(started.log),
    }));
};

/** Runs the environment's reset to its end (at most 10 minutes); a failure is env-reset-failed and no test runs. */
export const resetEnvironment = async (root, env, { info = () => {}, spawnImpl, limitMs = RESET_LIMIT_MS } = {}) => {
    info(t('session.lifecycle.resetting', { env: env.name, command: env.reset }));
    const result = await runCommand(root, env, 'reset', env.reset, { limitMs, spawnImpl });
    if (result.timedOut) throw new CawError('env-reset-failed', t('session.lifecycle.resetTimeout', { env: env.name, seconds: Math.round(limitMs / 1000), log: logPath(env.name, 'reset'), tail: tailBlock(result.log) }));
    if (result.code !== 0) throw new CawError('env-reset-failed', t('session.lifecycle.resetFailed', { env: env.name, code: result.code, log: logPath(env.name, 'reset'), tail: tailBlock(result.log) }));
};

/**
 * The lifecycle of one command invocation on one environment.
 * @param start  --start: start the environment if it does not answer, stop it at the end if caw started it
 * @param reset  'auto' (run: once before the first writing test), 'force' (--reset: before the first test) or 'off' (--no-reset,
 *               record and open without --reset)
 * @returns { begin(), beforeTest(spec), end() }; end() is safe to call more than once
 */
export const environmentLifecycle = (root, env, { start = false, reset = 'off', info, warn, deps = {} } = {}) => {
    let handle = null;
    let resetDone = false;
    let aborted = false;
    return {
        begin: async () => {
            if (!start) return;
            // Ctrl+C while waiting for the environment: stop waiting, clean up. Once only: a second Ctrl+C ends caw as usual.
            const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
            const abort = () => { aborted = true; };
            for (const signal of signals) process.once(signal, abort);
            try {
                handle = await startEnvironment(root, env, { info, warn, aborted: () => aborted, ...deps });
            } finally {
                for (const signal of signals) process.removeListener(signal, abort);
            }
        },
        beforeTest: async (spec) => {
            if (resetDone || reset === 'off' || env.reset === undefined) return;
            if (reset === 'auto' && spec?.writes !== true) return;
            resetDone = true;
            await resetEnvironment(root, env, { info, ...deps });
        },
        end: async () => {
            const current = handle;
            handle = null;
            await current?.stop();
        },
    };
};
