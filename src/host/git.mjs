// Git for `caw audit` and `caw bisect` (the project's test data at another commit) and `caw run --promote` (what a fix
// changed). Shells out to the git on PATH (git.exe on Windows) like project-files.mjs; no library. Paths are relative to the
// project folder (the cwd), which need not be the repository's top.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
 * A file the red proof found modified in the working tree (`dirty`) counts too once its content differs from then: a bug that
 * existed only in the working tree and was fixed back to the commit leaves no diff against it. Such a file whose content is
 * still the same as then is left out: the fix did not touch it, even though it differs from the commit at red.
 * @param since a commit hash, as a draft's red.head records it
 * @param dirty a draft's red.dirty: [{ file, hash }], see dirtyFiles
 * @returns the paths, sorted, with forward slashes
 */
export const changedFiles = (root, since, dirty = []) => {
    if (typeof since !== 'string' || !/^[0-9a-f]{4,40}$/.test(since)) throw new CawError('git-ref', t('cli.audit.badRef', { ref: String(since ?? '') }));
    const prefix = git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim();
    const names = (args) => git(root, args).toString('utf8').split('\0').filter((path) => path !== '' && !path.includes('\n'));
    // `:/` is the whole repository: app code may sit next to the project folder.
    const diff = names(['diff', '--name-only', '-z', since, '--', ':/']);
    // Untracked only inside the project folder: whatever else lies untracked in the repository is not the fix's.
    const untracked = names(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '.']).filter((path) => !path.endsWith('/'));
    const now = contentIds(root, dirty.map(({ file }) => file));
    const changedSinceRed = dirty.filter(({ file, hash }) => now.get(file) !== hash).map(({ file }) => file);
    // Dirty at red and the same content now: the fix did not touch it, though it differs from the commit at red.
    const sameAsRed = new Set(dirty.filter(({ file, hash }) => now.get(file) === hash).map(({ file }) => file));
    const up = prefix === '' ? '' : prefix.split('/').filter(Boolean).map(() => '../').join('');
    const shown = (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : `${up}${path}`);
    return [...new Set([...diff.filter((path) => !sameAsRed.has(path)), ...untracked, ...changedSinceRed].map(shown))]
        .filter((path) => ![PROJECT_DIR, RUN_DIR].some((dir) => path.startsWith(`${dir}/`)))
        .sort();
};

/**
 * How many lines changed in files of the project since a commit, against the working tree.
 * @param files paths relative to the project
 * @returns Map path -> { added, removed }; a file git does not count (untracked, binary) is left out
 */
export const changedLines = (root, since, files) => {
    const counts = new Map();
    if (files.length === 0) return counts;
    const out = git(root, ['diff', '--numstat', '-z', '--no-renames', '--relative', since, '--', ...files.map((file) => `:(literal)${file}`)]).toString('utf8');
    for (const line of out.split('\0')) {
        const match = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
        if (match !== null) counts.set(match[3], { added: Number(match[1]), removed: Number(match[2]) });
    }
    return counts;
};

/**
 * The content of files in the working tree as git blob ids (with git's filters, see workingBlobIds), null for a file that is not
 * there. @param files paths relative to the repository's top
 */
const contentIds = (root, files) => {
    if (files.length === 0) return new Map();
    const top = git(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    const present = files.filter((file) => existsSync(join(top, file)));
    const ids = workingBlobIds(root, present.map((file) => join(top, file)));
    return new Map(files.map((file) => [file, ids.get(join(top, file)) ?? null]));
};

/**
 * For a draft's red proof: the tracked files modified in the working tree (staged or not, against HEAD) in the whole repository,
 * without the project's caw/ and .caw/, each with its content as a git blob id, null when deleted. At promote changedFiles
 * lists those whose content changed since.
 * @returns [{ file, hash }], paths relative to the repository's top with forward slashes, sorted
 */
export const dirtyFiles = (root) => {
    const prefix = git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim();
    const files = git(root, ['diff', '--name-only', '-z', 'HEAD', '--', ':/']).toString('utf8').split('\0')
        .filter((path) => path !== '' && !path.includes('\n'))
        .filter((path) => ![PROJECT_DIR, RUN_DIR].some((dir) => path.startsWith(`${prefix}${dir}/`)))
        .sort();
    const ids = contentIds(root, files);
    return files.map((file) => ({ file, hash: ids.get(file) }));
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

/**
 * A delta under test: `<base>..<head>` (or `...`; what head changed since it left base, like a PR) or one commit (against its
 * parent; a branch name is its newest commit only). Paths relative to the project like changedFiles.
 * @returns { base, head (short hashes), files, contained: HEAD has head, differing: the delta's files that differ from head in
 *          the working tree, dirty: other tracked files with uncommitted changes, without caw/ and .caw/ }
 */
export const deltaOf = (root, value) => {
    const bad = () => new CawError('git-ref', t('cli.delta.form', { delta: String(value) }));
    const range = /^(.+?)\.{2,3}(.+)$/.exec(value);
    const head = resolveCommit(root, range === null ? value : range[2]);
    let base;
    if (range !== null) {
        const from = resolveCommit(root, range[1]);
        if (!succeeds(root, ['merge-base', from, head])) throw bad();
        base = git(root, ['merge-base', from, head]).toString('utf8').trim();
    } else {
        if (!succeeds(root, ['rev-parse', '--verify', '--quiet', `${head}^1`])) throw bad();
        base = resolveCommit(root, `${head}^1`);
    }
    const prefix = git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim();
    const up = '../'.repeat(prefix.split('/').filter(Boolean).length);
    const shown = (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : `${up}${path}`);
    const names = (args) => git(root, args).toString('utf8').split('\0').filter((path) => path !== '' && !path.includes('\n'));
    const touched = names(['diff', '--name-only', '--no-renames', '-z', base, head, '--', ':/']);
    const changed = new Set(names(['diff', '--name-only', '--no-renames', '-z', head, '--', ':/']));
    // A deleted file that is there again is untracked, which no diff against head shows: looked up itself.
    const gone = new Set(names(['diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', base, head, '--', ':/']));
    const top = git(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    const differing = touched.filter((path) => changed.has(path) || (gone.has(path) && existsSync(join(top, path))));
    const dirty = dirtyFiles(root).map(({ file }) => file).filter((path) => !touched.includes(path));
    const short = (commit) => git(root, ['rev-parse', '--short', commit]).toString('utf8').trim();
    return { base: short(base), head: short(head), files: touched.map(shown).sort(), contained: succeeds(root, ['merge-base', '--is-ancestor', head, 'HEAD']), differing: differing.map(shown).sort(), dirty: dirty.map(shown).sort() };
};
