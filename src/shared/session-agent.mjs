// The person's own coding agent session as agent (--attach): the run starts no agent of its own, it writes a marker and waits.
// The session finds the run's channel through the marker and sends the same commands as an agent in the sandbox.
// One marker per run, so two windows of one project never overwrite each other; a marker names the listener it is bound to
// (attach.mjs), and only that session finds it.
// The marker lies in the project, where a checked-in or planted file could pretend to be a run (its hint shown as caw's text,
// its agentDir as the channel). So a marker counts only with the token caw keeps outside the project, in the user's caw folder.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { RUN_DIR } from './names.mjs';
import { prefsDir } from './prefs.mjs';

const MARKERS = 'agents';
// Process ids up to 4 belong to the system (init, System on Windows): always alive, never a caw run.
const SYSTEM_PIDS = 4;

const markersDir = (root) => join(root, RUN_DIR, MARKERS);
export const markerPath = (root, runId) => join(markersDir(root), `${runId}.json`);

/** Where caw keeps tokens for the project: in the user's caw folder, never in the project. */
export const projectSessionsDir = (root, env = process.env) => {
    let real = resolve(root);
    try {
        real = realpathSync.native(root);
    } catch {
        // a project that is gone has no run
    }
    const key = createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 32);
    return join(prefsDir(env), 'sessions', key);
};
const tokenPath = (root, runId, env) => join(projectSessionsDir(root, env), `run-${runId}.json`);

export const isAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= SYSTEM_PIDS) return false;
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

/** A marker that counts: its process lives, its agent folder is in the run folder, its token matches the one kept outside. */
const validMarker = (root, file, env) => {
    const marker = readJson(file);
    if (marker === null || typeof marker !== 'object' || typeof marker.runId !== 'string' || typeof marker.agentDir !== 'string' || typeof marker.token !== 'string') return undefined;
    if (!isAlive(marker.pid) || !inRunFolder(root, marker.agentDir)) return undefined;
    const kept = readJson(tokenPath(root, marker.runId, env));
    if (kept?.token !== marker.token || kept?.runId !== marker.runId) return undefined;
    return marker;
};

/** Every run waiting for a session, newest first. */
export const waitingRuns = (root, env = process.env) => {
    if (!existsSync(markersDir(root))) return [];
    return readdirSync(markersDir(root))
        .filter((name) => name.endsWith('.json'))
        .map((name) => validMarker(root, join(markersDir(root), name), env))
        .filter((marker) => marker !== undefined)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
};

/**
 * The run waiting for this session, or undefined: the newest one bound to its listener `key`. Without a key (a session that has
 * not attached, the agent CLI without one) only a run that is the only one waiting.
 */
export const findSessionAgent = (root, { key, env = process.env } = {}) => {
    const runs = waitingRuns(root, env);
    if (key !== undefined) return runs.find((marker) => marker.attach === key);
    const unbound = runs.filter((marker) => !marker.attach);
    return unbound.length === 1 ? unbound[0] : undefined;
};

/**
 * Announces the run to the session bound to `attach`. `ended` never settles on its own: the run ends with the verdict, the
 * window or a cancel.
 * @returns { ended, stop }
 */
export const announceSessionAgent = ({ root, runId, agentDir, mode, hint, guide = [], attach, pid = process.pid, env = process.env }) => {
    mkdirSync(markersDir(root), { recursive: true });
    const token = randomBytes(16).toString('hex');
    const kept = tokenPath(root, runId, env);
    mkdirSync(join(kept, '..'), { recursive: true });
    writeFileSync(`${kept}.${pid}.tmp`, JSON.stringify({ runId, token }), { mode: 0o600 });
    renameSync(`${kept}.${pid}.tmp`, kept);
    const file = markerPath(root, runId);
    const temporary = `${file}.${pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ runId, agentDir, mode, hint, guide, pid, token, attach, startedAt: new Date().toISOString() }, null, 2));
    renameSync(temporary, file);
    return {
        ended: new Promise(() => {}),
        /** The run is bound to another listener now (the session came back under a new key, or was handed over). */
        rebind: (key) => {
            const marker = readJson(file);
            if (marker === undefined) return;
            writeFileSync(temporary, JSON.stringify({ ...marker, attach: key }, null, 2));
            renameSync(temporary, file);
        },
        stop: async () => {
            rmSync(file, { force: true });
            rmSync(kept, { force: true });
        },
    };
};
