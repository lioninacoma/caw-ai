// Files for upload: only from the project's caw/fixtures folder. A recording names them relative to the caw folder
// (files: [fixtures/brief.pdf]), so the test runs on any machine; nothing from elsewhere on disk ever lands in the project.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const FIXTURES_DIR = 'fixtures';
// The page hashes a chosen file to compare it; larger files are compared by name and size only.
export const HASH_LIMIT_BYTES = 50 * 1024 * 1024;

const inside = (dir, path) => {
    const rel = relative(dir, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** All regular files in caw/fixtures, relative to the caw folder with forward slashes (fixtures/a/b.pdf). Links are skipped. */
export const fixtureFiles = (cawDir) => {
    const root = join(cawDir, FIXTURES_DIR);
    if (!existsSync(root)) return [];
    return readdirSync(root, { recursive: true })
        .map((name) => join(root, String(name)))
        .filter((path) => {
            const stat = lstatSync(path);
            return stat.isFile() && !stat.isSymbolicLink();
        })
        .map((path) => relative(cawDir, path).split(sep).join('/'))
        .sort();
};

/**
 * A file named for upload, relative to the caw folder: it must lie in caw/fixtures (also after resolving links) and exist.
 * @returns the normalized relative path (fixtures/brief.pdf) or null
 */
export const fixturePath = (cawDir, file) => {
    if (typeof file !== 'string' || file === '' || isAbsolute(file)) return null;
    const root = join(cawDir, FIXTURES_DIR);
    const path = resolve(cawDir, file);
    if (!inside(root, path) || !existsSync(path)) return null;
    try {
        if (!inside(realpathSync(root), realpathSync(path)) || !lstatSync(path).isFile()) return null;
    } catch {
        return null;
    }
    return relative(cawDir, path).split(sep).join('/');
};

/**
 * The fixture a file chosen in the browser is: same name, same size and, if the page could hash it, the same SHA-256.
 * @param chosen { name, size, sha256? } as the page reports it
 * @returns its path relative to the caw folder, or null if it does not come from caw/fixtures
 */
export const matchFixture = (cawDir, chosen) => {
    if (typeof chosen?.name !== 'string' || !Number.isFinite(chosen?.size)) return null;
    for (const file of fixtureFiles(cawDir)) {
        if (basename(file) !== chosen.name) continue;
        const data = readFileSync(join(cawDir, file));
        if (data.length !== chosen.size) continue;
        if (typeof chosen.sha256 === 'string' && createHash('sha256').update(data).digest('hex') !== chosen.sha256) continue;
        return file;
    }
    return null;
};
