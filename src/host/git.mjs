// Git for `caw audit`: the project's test data at an older commit. Shells out to the git on PATH (git.exe on Windows) like
// project-files.mjs; no library. Paths are relative to the project folder (the cwd), which need not be the repository's top.

import { execFileSync } from 'node:child_process';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, RECORDING_DIR, TEST_DIR } from '../shared/names.mjs';

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
