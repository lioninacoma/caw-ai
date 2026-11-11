// overlay.statics: files the overlay serves under a fixed name. The path is relative to the app folder and may leave it with ..,
// e.g. to a neighbouring package of a monorepo, but its real location (symlinks and junctions resolved) has to stay inside the
// workspace, and secret files are never served.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isSecretPath } from './secrets.mjs';

const real = (path) => {
    try {
        return realpathSync(path);
    } catch {
        return null;
    }
};

/** Does this folder mark a workspace: pnpm-workspace.yaml, or package.json with "workspaces" (npm, yarn)? */
const marksWorkspace = (dir) => {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
    try {
        return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.workspaces !== undefined;
    } catch {
        return false;
    }
};

/**
 * The boundary for statics: the nearest folder from the project root (the folder with caw.config.json) upwards that marks a
 * workspace, but never above the repository (the first folder with .git); without a workspace the project root itself.
 * Real paths, so a symlinked project counts where it really is.
 */
export const workspaceRoot = (root) => {
    const start = real(root) ?? resolve(root);
    for (let dir = start; ; dir = dirname(dir)) {
        if (marksWorkspace(dir)) return dir;
        if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return start;
    }
};

/** Is `file` inside `dir` (not equal, not on another drive)? Windows compares case-insensitively in relative(). */
const inside = (dir, file) => {
    const rel = relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Where an overlay.statics path really leads.
 * @param root    the project root (folder with caw.config.json)
 * @param appDir  the app folder (absolute)
 * @returns { state: 'ok' | 'missing' | 'outside' | 'secret', file, boundary }: file is the real path when it exists
 */
export const staticFile = (root, appDir, path) => {
    const boundary = workspaceRoot(root);
    const lexical = resolve(real(appDir) ?? appDir, path);
    const found = real(lexical);
    const target = found ?? lexical;
    if (!inside(boundary, target)) return { state: 'outside', file: target, boundary };
    if (isSecretPath(relative(boundary, target).replaceAll('\\', '/'))) return { state: 'secret', file: target, boundary };
    if (found === null || !statSync(found).isFile()) return { state: 'missing', file: target, boundary };
    return { state: 'ok', file: found, boundary };
};
