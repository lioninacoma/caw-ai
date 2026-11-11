// Claude without a container: the same flow as in the sandbox, just as a process on the host. The boundary here is the tool set
// (read-only plus the caw tool, see localClaudeArgs), not Docker. Chosen with agent.sandbox, default "local".

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaude } from '../shared/claude-bin.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';

const BIN = fileURLToPath(new URL('../../bin/caw-ai.mjs', import.meta.url));

/** The local counterpart to prepareSandbox: needs neither image nor token, only Claude Code on the PATH. */
export const localBox = () => ({ kind: 'local', label: t('session.local.label') });

/** Is Claude Code installed? Claude Code checks its login itself on start; caw reads no credentials. */
export const claudeVersion = (run = spawnSync, bin = resolveClaude()) => {
    // Same launch as later in the run, without a shell: what doctor finds also starts.
    if (bin === null || bin === undefined) return undefined;
    const result = run(bin.file, [...bin.args, '--version'], { encoding: 'utf8', windowsHide: true });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return String(result.stdout).trim().split(/\s+/)[0] || undefined;
};

export const requireClaude = (run = spawnSync, bin = resolveClaude()) => {
    const version = claudeVersion(run, bin);
    if (version === undefined) throw new CawError('claude-missing', t('session.local.claudeMissing'));
    return version;
};

/** A command as in the container: `caw-ai ...` maps to this package so it need not be installed globally. */
export const localCommand = (command) => (command[0] === 'caw-ai' ? [process.execPath, BIN, ...command.slice(1)] : command);

/** Small `caw-ai` launchers on the agent's PATH, for fixed flows (E2E) that call `caw-ai` as in the container. */
const writeShims = (dir) => {
    const bin = join(dir, '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'caw-ai'), `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "${BIN.replaceAll('\\', '/')}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'caw-ai.cmd'), `@"${process.execPath}" "${BIN}" %*\r\n`);
    return bin;
};

export const localAgentEnv = (agentDir, { color = false, env = process.env, limits = {} } = {}) => {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    return {
        ...env,
        [pathKey]: [writeShims(agentDir), env[pathKey]].filter(Boolean).join(delimiter),
        CAW_SANDBOX: '1',
        CAW_AGENT_LOCAL: '1',
        CAW_AGENT_DIR: agentDir,
        ...(color ? { CAW_COLOR: '1' } : {}),
        // Model and budget for Claude Code (claudeLimits), read by sandbox-run.
        ...limits,
    };
};

/** Ends the agent along with Claude and the tool server. */
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
 * Starts a run's agent on the host.
 * @returns { ended: Promise<{ code }>, stop }
 */
export const startLocalAgent = ({ command, agentDir, root, color = false, limits = {} }) => {
    const [file, ...args] = localCommand(command);
    const child = spawn(file, args, { cwd: root, env: localAgentEnv(agentDir, { color, limits }), stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' });
    const ended = new Promise((resolveEnded) => {
        child.on('error', () => resolveEnded({ code: 127 }));
        child.on('close', (code) => resolveEnded({ code: code ?? 1 }));
    });
    return {
        ended,
        stop: async () => {
            killTree(child);
            await ended;
        },
    };
};
