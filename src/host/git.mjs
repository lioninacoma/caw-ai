// Git for `caw audit` and `caw bisect` (the project's test data at another commit) and `caw run --promote` (what a fix
// changed). Shells out to the git on PATH (git.exe on Windows) like project-files.mjs; no library. Paths are relative to the
// project folder (the cwd), which need not be the repository's top.

import { execFileSync } from 'node:child_process';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, PROJECT_DIR, RECORDING_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';

// Recordings with learned effects get big; a whole project's test data stays far below this.
const MAX_BUFFER = 256 * 1024 * 1024;

/** Runs git in the project folder; stdout as Buffer. A missing git or a folder outside a repository is `git-missing`. */
const git = (root, args, { input } = {}) => {
    try {
        return execFileSync('git', args, { cwd: root, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER, windowsHide: true });
    } catch (error) {
        if (error.code === 'ENOENT') throw new CawError('git-missing', t('cli.audit.gitMissing'));
        const stderr = String(error.stderr ?? '');
        if (/not a git repository/i.test(stderr)) throw new CawError('git-missing', t('cli.audit.notRepository', { root }));
        throw error;
    }
};

/** Exit status only, for the questions git answers with 0 or 1. */
const succeeds = (root, args) => {
    try {
        git(root, args);
        return true;
    } catch (error) {
        if (error instanceof CawError) throw error;
        return false;
    }
};

/**
 * The commit where the branch of HEAD left <ref>: what a PR compares against. Rejects a ref git does not know and one without
 * a common history.
 * @returns the commit hash
 */
export const mergeBase = (root, ref) => {
    // A ref that starts with a dash would be read as an option.
    if (typeof ref !== 'string' || ref.trim() === '' || ref.startsWith('-')) throw new CawError('git-ref', t('cli.audit.badRef', { ref: String(ref ?? '') }));
    if (!succeeds(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) throw new CawError('git-ref', t('cli.audit.badRef', { ref }));
    try {
        return git(root, ['merge-base', ref, 'HEAD']).toString('utf8').trim();
    } catch (error) {
        if (error instanceof CawError) throw error;
        throw new CawError('git-ref', t('cli.audit.noBase', { ref }));
    }
};

/**
 * The commit a ref names, for `caw bisect --tests-from`. Rejects a ref git does not know, like mergeBase.
 * @returns the commit hash
 */
export const resolveCommit = (root, ref) => {
    if (typeof ref !== 'string' || ref.trim() === '' || ref.startsWith('-')) throw new CawError('git-ref', t('cli.audit.badRef', { ref: String(ref ?? '') }));
    try {
        return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).toString('utf8').trim();
    } catch (error) {
        if (error instanceof CawError) throw error;
        throw new CawError('git-ref', t('cli.audit.badRef', { ref }));
    }
};

/** When a commit was made (ISO 8601), e.g. the merge base: caw audit lists what was decided since. */
export const commitDate = (root, commit) => git(root, ['show', '-s', '--format=%cI', commit]).toString('utf8').trim();

/** The short hash of what is checked out (`git rev-parse --short HEAD`), for one line per bisect step. */
export const shortHead = (root) => git(root, ['rev-parse', '--short', 'HEAD']).toString('utf8').trim();

/**
 * What changed since a commit, for a promoted draft's fix report: committed and uncommitted changes of tracked files in the
 * whole repository (`git diff --name-only`: app code may sit beside the project folder) plus untracked files inside the project
 * folder only, never an untracked folder git lists as a whole (a nested repository, "lib/"); relative to the project folder,
 * without caw/ and .caw/ (the tests themselves and the runs). A path outside the project folder keeps its place in the
 * repository, marked with a leading ../ per level.
 * @param since a commit hash, as a draft's red.head records it
 * @returns the paths, sorted, with forward slashes
 */
export const changedFiles = (root, since) => {
    if (typeof since !== 'string' || !/^[0-9a-f]{4,40}$/.test(since)) throw new CawError('git-ref', t('cli.audit.badRef', { ref: String(since ?? '') }));
    const prefix = git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim();
    const names = (args) => git(root, args).toString('utf8').split('\0').filter((path) => path !== '' && !path.includes('\n'));
    // `:/` is the whole repository: app code may sit next to the project folder.
    const diff = names(['diff', '--name-only', '-z', since, '--', ':/']);
    // Untracked only inside the project folder: whatever else lies untracked in the repository is not the fix's.
    const untracked = names(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '.']).filter((path) => !path.endsWith('/'));
    const up = prefix === '' ? '' : prefix.split('/').filter(Boolean).map(() => '../').join('');
    const shown = (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : `${up}${path}`);
    return [...new Set([...diff, ...untracked].map(shown))]
        .filter((path) => ![PROJECT_DIR, RUN_DIR].some((dir) => path.startsWith(`${dir}/`)))
        .sort();
};

/** Is this file part of the test data audit compares? Test and recording files directly in their folders, and the config. */
export const isAuditFile = (path) => path === CONFIG_FILE
    || [TEST_DIR, RECORDING_DIR].some((dir) => path.startsWith(`${dir}/`) && path.endsWith('.yaml') && !path.slice(dir.length + 1).includes('/'));

/**
 * The test data at a commit: caw/tests, caw/recordings and caw.config.json, relative to the project folder.
 * @returns the paths, with forward slashes
 */
export const auditFiles = (root, commit) => {
    // Full names plus the folder's own prefix: robust whatever the folder is inside the repository.
    const prefix = git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim();
    const out = git(root, ['ls-tree', '-r', '-z', '--name-only', '--full-name', commit, '--', TEST_DIR, RECORDING_DIR, CONFIG_FILE]);
    return out.toString('utf8').split('\0')
        .filter((path) => path !== '' && path.startsWith(prefix) && !path.includes('\n'))
        .map((path) => path.slice(prefix.length))
        .filter(isAuditFile);
};

/**
 * Reads files at a commit in one `git cat-file --batch` call. The output is parsed as bytes: each object is
 * `<oid> <type> <size>\n<content>\n`, and the size counts bytes, not characters.
 * @returns Map path -> text (UTF-8); a path missing at the commit is left out
 */
export const readAtCommit = (root, commit, paths) => {
    const files = new Map();
    if (paths.length === 0) return files;
    const prefix = git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim();
    const input = paths.map((path) => `${commit}:${prefix}${path}\n`).join('');
    const out = git(root, ['cat-file', '--batch'], { input });
    let at = 0;
    for (const path of paths) {
        const end = out.indexOf(0x0a, at);
        if (end === -1) break;
        const header = out.subarray(at, end).toString('utf8');
        at = end + 1;
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        // "<name> missing" (or ambiguous): nothing follows the header.
        if (match === null) continue;
        const size = Number(match[2]);
        if (match[1] === 'blob') files.set(path, out.subarray(at, at + size).toString('utf8'));
        at += size + 1;
    }
    return files;
};

/**
 * The blob ids of files at a commit, in one `git cat-file --batch-check` call.
 * @returns Map path -> object id; a path missing at the commit (or no file there) is left out
 */
export const blobIdsAtCommit = (root, commit, paths) => {
    const ids = new Map();
    if (paths.length === 0) return ids;
    const prefix = git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim();
    const input = paths.map((path) => `${commit}:${prefix}${path}\n`).join('');
    const lines = git(root, ['cat-file', '--batch-check'], { input }).toString('utf8').split('\n');
    paths.forEach((path, index) => {
        const match = /^([0-9a-f]+) blob \d+$/.exec(lines[index] ?? '');
        if (match !== null) ids.set(path, match[1]);
    });
    return ids;
};

/**
 * The blob ids files in the working tree would get when added, with the filters git applies to them (core.autocrlf,
 * .gitattributes): comparable with blobIdsAtCommit, where hashing the raw bytes would differ in the line ends alone.
 * @param paths absolute, each an existing file in the repository (with --stdin-paths git does not resolve relative paths
 *   against a subfolder)
 * @returns Map path -> object id
 */
export const workingBlobIds = (root, paths) => {
    if (paths.length === 0) return new Map();
    const input = paths.map((path) => `${path}\n`).join('');
    const ids = git(root, ['hash-object', '--stdin-paths'], { input }).toString('utf8').trim().split('\n');
    return new Map(paths.map((path, index) => [path, ids[index]]));
};
