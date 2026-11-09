// Wie Claude Code gestartet wird, ohne Shell: Der Prompt geht als Argument mit und darf nie durch eine Shell laufen.
// Unter Windows liegt je nach Installation claude.exe (nativ) oder nur claude.cmd (npm) im PATH; .cmd laesst sich ohne Shell
// nicht starten, darum nimmt caw dann das Node-Skript dahinter.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NPM_CLI = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'];

/** Kandidaten aus `where claude` (Windows), in dieser Reihenfolge. */
const whereClaude = (run) => {
    const result = run('where', ['claude'], { encoding: 'utf8', windowsHide: true });
    if (result.error !== undefined || result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

/**
 * @returns { file, args } zum Start ohne Shell, oder undefined, wenn Claude Code nicht gefunden wird
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
