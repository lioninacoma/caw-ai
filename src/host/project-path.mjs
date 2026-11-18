// Paths a caller names (a session through MCP, a flag) that caw reads or writes: they stay inside the project, also after links.

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const present = (path) => {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
};

const within = (dir, path) => {
    const rel = relative(dir, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * A path inside the project: relative to root or absolute, never outside it. The nearest part that exists (the file, else its
 * folder, else that folder's folder …) must also lie inside the project after resolving links, so a link cannot lead out.
 * @returns the absolute path, or null when it leaves the project
 */
export const projectPath = (root, given) => {
    if (typeof given !== 'string' || given === '' || given.includes('\0')) return null;
    const path = resolve(root, given);
    if (!within(root, path)) return null;
    let real;
    try {
        real = realpathSync.native(root);
    } catch {
        return null;
    }
    // lstat, not exists: a dangling link counts as there, and realpath then refuses it.
    let existing = path;
    while (!present(existing)) existing = dirname(existing);
    try {
        const resolved = realpathSync.native(existing);
        return resolved === real || within(real, resolved) ? path : null;
    } catch {
        return null;
    }
};
