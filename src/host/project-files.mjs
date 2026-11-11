// Project copies: files a build takes over unchanged from the project (Vite and CRA `public/`, Angular `src/assets`,
// CopyWebpackPlugin). A deployment often replaces them per environment, e.g. `env.js` or `config.js` with URLs and switches. Served
// from the local build they would carry development values, and the test would run against staging with local configuration.
// Detected without folder names: compiled code never equals a source file byte for byte, a copy does.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Source files by size, per project folder. Short-lived: a run asks per request, the project hardly changes within seconds.
const FRESH_MS = 10_000;
const indexes = new Map();

/** The project files according to Git: tracked or new, but not ignored (`dist`, `deploy`, `node_modules` do not count). */
const gitFiles = (dir) => {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return out.toString('utf8').split('\0').filter((path) => path !== '').map((path) => join(dir, path));
};

/** Without Git: the folder minus `node_modules`, dot folders and the build folders. */
const walkFiles = (dir, skip) => {
    const files = [];
    const queue = [dir];
    while (queue.length > 0) {
        const at = queue.shift();
        let entries = [];
        try {
            entries = readdirSync(at, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(at, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.') || skip.some((folder) => path === folder || path.startsWith(`${folder}${sep}`))) continue;
                queue.push(path);
            } else if (entry.isFile()) files.push(path);
        }
    }
    return files;
};

const indexOf = (projectDir, skip) => {
    const key = `${projectDir}\0${skip.join('\0')}`;
    const cached = indexes.get(key);
    if (cached !== undefined && Date.now() - cached.at < FRESH_MS) return cached.bySize;
    let files;
    try {
        files = gitFiles(projectDir);
    } catch {
        files = walkFiles(projectDir, skip);
    }
    // Anything in a build folder is never a source, even if Git does not ignore it.
    const inBuild = (file) => skip.some((folder) => !relative(folder, file).startsWith('..'));
    const bySize = new Map();
    for (const file of files) {
        if (inBuild(file)) continue;
        let size;
        try {
            size = statSync(file).size;
        } catch {
            continue;
        }
        const list = bySize.get(size) ?? [];
        list.push(file);
        bySize.set(size, list);
    }
    indexes.set(key, { at: Date.now(), bySize });
    return bySize;
};

/**
 * Is `bytes` an unchanged copy of a project source file?
 * @param projectDir the app folder
 * @param bytes      response body from the local code
 * @param skip       absolute paths that are never sources (the build folder itself)
 */
export const isProjectCopy = (projectDir, bytes, { skip = [] } = {}) => {
    if (typeof projectDir !== 'string' || projectDir === '' || bytes.length === 0) return false;
    const candidates = indexOf(projectDir, skip.map((folder) => join(folder))).get(bytes.length) ?? [];
    return candidates.some((file) => {
        try {
            return readFileSync(file).equals(bytes);
        } catch {
            return false;
        }
    });
};

/** Like isProjectCopy, for a file: it is only read when a source file has the same size. */
export const isProjectCopyFile = (projectDir, file, { skip = [] } = {}) => {
    if (typeof projectDir !== 'string' || projectDir === '') return false;
    let size;
    try {
        size = statSync(file).size;
    } catch {
        return false;
    }
    if (size === 0 || (indexOf(projectDir, skip.map((folder) => join(folder))).get(size) ?? []).length === 0) return false;
    try {
        return isProjectCopy(projectDir, readFileSync(file), { skip });
    } catch {
        return false;
    }
};
