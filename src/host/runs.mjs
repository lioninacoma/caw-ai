// The run folders in .caw/runs: every run and every open leaves one (report, trace, chat log). caw keeps the newest ones
// (keepRuns, default 30) and deletes older ones when a run starts; a run whose process still lives is never deleted.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUN_DIR } from '../shared/names.mjs';
import { isAlive } from '../shared/session-agent.mjs';

export const DEFAULT_KEEP_RUNS = 30;
const ALIVE_FILE = '.alive';

/** Marks a run folder as belonging to this process, so no other run deletes it while it is open. */
export const markRunAlive = (runDir, pid = process.pid) => writeFileSync(join(runDir, ALIVE_FILE), JSON.stringify({ pid }));

const openNow = (dir) => {
    try {
        return isAlive(JSON.parse(readFileSync(join(dir, ALIVE_FILE), 'utf8')).pid);
    } catch {
        return false;
    }
};

/**
 * Deletes the oldest run folders beyond `keep`. Run ids start with their time, so the name order is the age order.
 * @param keep   how many to keep; 0 keeps all
 * @param except the run that is starting now
 * @returns the names deleted
 */
export const pruneRuns = (root, keep = DEFAULT_KEEP_RUNS, { except } = {}) => {
    const runs = join(root, RUN_DIR, 'runs');
    if (keep === 0 || !existsSync(runs)) return [];
    const names = readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
    const deleted = [];
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
        if (name === except || openNow(join(runs, name))) continue;
        try {
            rmSync(join(runs, name), { recursive: true, force: true, maxRetries: 2 });
            deleted.push(name);
        } catch {
            // A file still in use (a report open in an editor): it goes with the next start.
        }
    }
    return deleted;
};
