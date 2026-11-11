// How Claude Code is launched, without a shell: the prompt is passed as an argument and must never go through a shell.
// On Windows the PATH holds claude.exe (native) or only claude.cmd (npm), depending on the install; a .cmd cannot start
// without a shell, so caw then uses the Node script behind it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NPM_CLI = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'];

/** Candidates from `where claude` (Windows), in that order. */
const whereClaude = (run) => {
    const result = run('where', ['claude'], { encoding: 'utf8', windowsHide: true });
    if (result.error !== undefined || result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

/**
 * @returns { file, args } to launch without a shell, or undefined if Claude Code is not found
 */
export const resolveClaude = ({ platform = process.platform, run = spawnSync, exists = existsSync, node = process.execPath } = {}) => {
    if (platform !== 'win32') return { file: 'claude', args: [] };
    const found = whereClaude(run);
    const exe = found.find((path) => /\.exe$/i.test(path));
    if (exe !== undefined) return { file: exe, args: [] };
    for (const cmd of found.filter((path) => /\.cmd$/i.test(path))) {
        const cli = join(dirname(cmd), ...NPM_CLI);
        if (exists(cli)) return { file: node, args: [cli] };
    }
    return undefined;
};
