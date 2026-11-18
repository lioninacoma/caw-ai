// How Claude Code is launched, without a shell: the prompt is passed as an argument and must never go through a shell.
// On Windows the PATH holds claude.exe (native) or only claude.cmd (npm), depending on the install; a .cmd cannot start
// without a shell, so caw then uses the Node script behind it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

const NPM_CLI = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'];

/**
 * Candidates from the PATH (Windows), in that order. `where claude` would look in the current folder first, where a project
 * can bring its own claude.exe; `$PATH:claude` searches the PATH only.
 */
const whereClaude = (run) => {
    const result = run('where', ['$PATH:claude'], { encoding: 'utf8', windowsHide: true });
    if (result.error !== undefined || result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

/** Is the path inside one of the folders (or one of them)? Case-insensitive, as on Windows. */
const insideAny = (path, folders) => folders.filter((folder) => typeof folder === 'string').some((folder) => {
    const rel = win32.relative(win32.resolve(folder).toLowerCase(), win32.resolve(path).toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel));
});

/**
 * @param exclude folders a candidate must not lie in: the current folder and the project, whose files are not the user's tools
 * @returns { file, args } to launch without a shell, or undefined if Claude Code is not found
 */
export const resolveClaude = ({ platform = process.platform, run = spawnSync, exists = existsSync, node = process.execPath, exclude = [process.cwd()] } = {}) => {
    if (platform !== 'win32') return { file: 'claude', args: [] };
    const found = whereClaude(run).filter((path) => win32.isAbsolute(path) && !insideAny(path, exclude));
    const exe = found.find((path) => /\.exe$/i.test(path));
    if (exe !== undefined) return { file: exe, args: [] };
    for (const cmd of found.filter((path) => /\.cmd$/i.test(path))) {
        const cli = win32.join(win32.dirname(cmd), ...NPM_CLI);
        if (exists(cli)) return { file: node, args: [cli] };
    }
    return undefined;
};
