// The developer's own Claude Code session as agent (--agent session): the run starts no Claude, it writes a marker and waits.
// The session finds the run's channel through the marker and sends the same commands as an agent in the sandbox.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUN_DIR } from './names.mjs';

const MARKER = 'agent.json';

export const markerPath = (root) => join(root, RUN_DIR, MARKER);

const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

/** The run currently waiting for the session, or undefined. A marker of an ended process does not count. */
export const findSessionAgent = (root) => {
    const file = markerPath(root);
    if (!existsSync(file)) return undefined;
    try {
        const marker = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof marker.agentDir !== 'string' || !Number.isInteger(marker.pid) || !isAlive(marker.pid)) return undefined;
        return marker;
    } catch {
        return undefined;
    }
};

/**
 * Announces the run to the session. `ended` never settles on its own: the run ends with the verdict, the window or a cancel.
 * @returns { ended, stop }
 */
export const announceSessionAgent = ({ root, runId, agentDir, mode, hint, pid = process.pid }) => {
    mkdirSync(join(root, RUN_DIR), { recursive: true });
    const file = markerPath(root);
    const temporary = `${file}.${pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ runId, agentDir, mode, hint, pid, startedAt: new Date().toISOString() }, null, 2));
    renameSync(temporary, file);
    return {
        ended: new Promise(() => {}),
        stop: async () => {
            // Only our own marker: a newer run may have replaced it meanwhile.
            try {
                if (JSON.parse(readFileSync(file, 'utf8')).runId === runId) rmSync(file, { force: true });
            } catch {
                // already gone
            }
        },
    };
};
