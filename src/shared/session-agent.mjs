// The developer's own Claude Code session as agent (--agent session): the run starts no Claude, it writes a marker and waits.
// The session finds the run's channel through the marker and sends the same commands as an agent in the sandbox.
// The marker lies in the project, where a checked-in or planted file could pretend to be a run (its hint shown as caw's text,
// its agentDir as the channel). So a marker counts only with the token caw keeps outside the project, in the user's caw folder.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { RUN_DIR } from './names.mjs';
import { prefsDir } from './prefs.mjs';

const MARKER = 'agent.json';
// Process ids up to 4 belong to the system (init, System on Windows): always alive, never a caw run.
const SYSTEM_PIDS = 4;

export const markerPath = (root) => join(root, RUN_DIR, MARKER);

/** Where caw keeps the run's token: per project, in the user's caw folder, never in the project. */
export const tokenPath = (root, env = process.env) => {
    let real = resolve(root);
    try {
        real = realpathSync.native(root);
    } catch {
        // a project that is gone has no run
    }
    const key = createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 32);
    return join(prefsDir(env), 'sessions', `${key}.json`);
};

const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
};

/** The agent folder of a run lies in the project's run folder, never elsewhere. */
const inRunFolder = (root, agentDir) => {
    const rel = relative(join(resolve(root), RUN_DIR, 'runs'), resolve(agentDir));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * The run currently waiting for the session, or undefined. Counts only a marker whose process lives (not a system process),
 * whose agent folder is in the project's run folder and whose token matches the one caw keeps outside the project.
 */
export const findSessionAgent = (root, env = process.env) => {
    const file = markerPath(root);
    if (!existsSync(file)) return undefined;
    const marker = readJson(file);
    if (marker === null || typeof marker !== 'object' || typeof marker.agentDir !== 'string' || typeof marker.token !== 'string') return undefined;
    if (!Number.isInteger(marker.pid) || marker.pid <= SYSTEM_PIDS || !isAlive(marker.pid)) return undefined;
    if (!inRunFolder(root, marker.agentDir)) return undefined;
    const kept = readJson(tokenPath(root, env));
    if (kept?.token !== marker.token || kept?.runId !== marker.runId) return undefined;
    return marker;
};

/**
 * Announces the run to the session. `ended` never settles on its own: the run ends with the verdict, the window or a cancel.
 * @returns { ended, stop }
 */
export const announceSessionAgent = ({ root, runId, agentDir, mode, hint, guide = [], pid = process.pid, env = process.env }) => {
    mkdirSync(join(root, RUN_DIR), { recursive: true });
    const token = randomBytes(16).toString('hex');
    const kept = tokenPath(root, env);
    mkdirSync(join(kept, '..'), { recursive: true });
    writeFileSync(`${kept}.${pid}.tmp`, JSON.stringify({ runId, token }), { mode: 0o600 });
    renameSync(`${kept}.${pid}.tmp`, kept);
    const file = markerPath(root);
    const temporary = `${file}.${pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ runId, agentDir, mode, hint, guide, pid, token, startedAt: new Date().toISOString() }, null, 2));
    renameSync(temporary, file);
    return {
        ended: new Promise(() => {}),
        stop: async () => {
            // Only our own marker and token: a newer run may have replaced them meanwhile.
            if (readJson(file)?.runId === runId) rmSync(file, { force: true });
            if (readJson(kept)?.runId === runId) rmSync(kept, { force: true });
        },
    };
};
