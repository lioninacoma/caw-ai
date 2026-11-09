// Die eigene Claude-Code-Session als Agent (--agent session): Der Lauf startet keinen Claude, sondern legt eine Marke ab und wartet.
// Die Session findet ueber die Marke den Kanal dieses Laufs und schickt dieselben Befehle wie ein Agent in der Sandbox.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUN_DIR } from './names.mjs';

const MARKER = 'agent.json';

export const markerPath = (root) => join(root, RUN_DIR, MARKER);

const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

/** Der Lauf, der gerade auf die Session wartet, oder undefined. Eine Marke eines beendeten Prozesses zaehlt nicht. */
export const findSessionAgent = (root) => {
    const file = markerPath(root);
    if (!existsSync(file)) return undefined;
    try {
        const marker = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof marker.agentDir !== 'string' || !Number.isInteger(marker.pid) || !alive(marker.pid)) return undefined;
        return marker;
    } catch {
        return undefined;
    }
};

/**
 * Meldet den Lauf fuer die Session an. `ended` endet nie von selbst: Der Lauf endet mit dem Urteil, dem Fenster oder einem Abbruch.
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
            // Nur die eigene Marke: Ein neuerer Lauf kann sie inzwischen ersetzt haben.
            try {
                if (JSON.parse(readFileSync(file, 'utf8')).runId === runId) rmSync(file, { force: true });
            } catch {
                // schon weg
            }
        },
    };
};
