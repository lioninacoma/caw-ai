// The human's personal notes for Claude across all projects: caw.md in the personal settings folder, next to prefs.json.
// Like a user-level CLAUDE.md: habits and preferences (how to report, what to look at first). Claude reads it before the
// project's caw/caw.md, which wins on a conflict. It never goes into a test, a recording or the project.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { prefsDir } from './prefs.mjs';

export const PERSONAL_CONTEXT_FILE = 'caw.md';
// More than this is not a note any more; Claude gets the beginning.
const MAX_BYTES = 64 * 1024;

export const personalContextPath = (env = process.env) => join(prefsDir(env), PERSONAL_CONTEXT_FILE);

/** The path as shown to the human: the home folder as ~, so a report does not carry the user name in full. */
export const shownPath = (path) => {
    const home = homedir();
    return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};

/**
 * The personal notes, or undefined without a file or with an empty one.
 * @returns {{ path: string, shown: string, text: string, lines: number, truncated: boolean } | undefined}
 */
export const readPersonalContext = (env = process.env) => {
    const path = personalContextPath(env);
    if (!existsSync(path)) return undefined;
    try {
        if (!statSync(path).isFile()) return undefined;
        const raw = readFileSync(path);
        const truncated = raw.length > MAX_BYTES;
        const text = raw.subarray(0, MAX_BYTES).toString('utf8').replaceAll('\r\n', '\n').trim();
        if (text === '') return undefined;
        return { path, shown: shownPath(path), text, lines: text.split('\n').length, truncated };
    } catch {
        return undefined;
    }
};
