// Claude ohne Container: derselbe Ablauf wie in der Sandbox, nur als Prozess auf dem Host. Die Grenze ziehen hier die Werkzeuge
// (nur Lesen und das Tool caw, siehe localClaudeArgs), nicht Docker. Gewaehlt mit agent.sandbox, Standard "local".

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaude } from '../shared/claude-bin.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';

const BIN = fileURLToPath(new URL('../../bin/caw-ai.mjs', import.meta.url));

/** Der lokale Weg als Gegenstueck zu prepareSandbox: Er braucht weder Image noch Token, nur Claude Code im PATH. */
export const localBox = () => ({ kind: 'local', label: t('session.local.label') });

/** Ist Claude Code installiert? Die Anmeldung prueft Claude Code selbst beim Start, caw liest keine Zugangsdaten. */
export const claudeVersion = (run = spawnSync, bin = resolveClaude()) => {
    // Derselbe Start wie spaeter im Lauf, ohne Shell: Was doctor findet, startet auch.
    if (bin == null) return undefined;
    const result = run(bin.file, [...bin.args, '--version'], { encoding: 'utf8', windowsHide: true });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return String(result.stdout).trim().split(/\s+/)[0] || undefined;
};

export const requireClaude = (run = spawnSync, bin = resolveClaude()) => {
    const version = claudeVersion(run, bin);
    if (version === undefined) throw new CawError('claude-missing', t('session.local.claudeMissing'));
    return version;
};

/** Ein Befehl wie im Container: `caw-ai ...` wird zu diesem Paket, damit es nicht global installiert sein muss. */
export const localCommand = (command) => (command[0] === 'caw-ai' ? [process.execPath, BIN, ...command.slice(1)] : command);

/** Kleine Starter fuer `caw-ai` im PATH des Agenten, fuer feste Ablaeufe (E2E), die wie im Container `caw-ai` rufen. */
const writeShims = (dir) => {
    const bin = join(dir, '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'caw-ai'), `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "${BIN.replaceAll('\\', '/')}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'caw-ai.cmd'), `@"${process.execPath}" "${BIN}" %*\r\n`);
    return bin;
};

export const localAgentEnv = (agentDir, { color = false, env = process.env } = {}) => {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    return {
        ...env,
        [pathKey]: [writeShims(agentDir), env[pathKey]].filter(Boolean).join(delimiter),
        CAW_SANDBOX: '1',
        CAW_AGENT_LOCAL: '1',
        CAW_AGENT_DIR: agentDir,
        ...(color ? { CAW_COLOR: '1' } : {}),
    };
};

/** Beendet den Agenten samt Claude und Werkzeug-Server. */
const killTree = (child) => {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else {
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            child.kill('SIGTERM');
        }
    }
};

/**
 * Startet den Agenten eines Laufs auf dem Host.
 * @returns { ended: Promise<{ code }>, stop }
 */
export const startLocalAgent = ({ command, agentDir, root, color = false }) => {
    const [file, ...args] = localCommand(command);
    const child = spawn(file, args, { cwd: root, env: localAgentEnv(agentDir, { color }), stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' });
    const ended = new Promise((ok) => {
        child.on('error', () => ok({ code: 127 }));
        child.on('close', (code) => ok({ code: code ?? 1 }));
    });
    return {
        ended,
        stop: async () => {
            killTree(child);
            await ended;
        },
    };
};
