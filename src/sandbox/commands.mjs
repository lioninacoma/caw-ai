// The commands in the container: thin clients. Browser, login and verdict live on the host,
// reachable only through the file channel. There are no credentials and no network to the application here.

import { spawn, spawnSync } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { existsSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { sendCommand } from '../shared/channel.mjs';
import { findSessionAgent } from '../shared/session-agent.mjs';
import { resolveClaude } from '../shared/claude-bin.mjs';
import { painter } from '../shared/color.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { colorLine, formatClaudeLine, stampLine } from './claude-log.mjs';

const CHANNEL_DIR = '.channel';
const HUMAN_TIMEOUT_MS = 60 * 60 * 1000;

/** The agent folder: from the environment in the sandbox and for the local agent, from the waiting run's marker for the developer session. */
const agentDir = () => {
    const dir = process.env.CAW_AGENT_DIR;
    if (process.env.CAW_SANDBOX === '1' && dir) return dir;
    const waiting = findSessionAgent(process.env.INIT_CWD ?? process.cwd());
    if (waiting !== undefined) return waiting.agentDir;
    throw new CawError('not-in-sandbox', 'No run is waiting for an agent. In your session: start caw-ai record <test> --target <environment> --agent session (in the background), then use these commands.');
};

/** Passes a command to the browser on the host and prints the answer. */
export const browserCommand = async (command, options) => {
    const value = await sendCommand(join(agentDir(), CHANNEL_DIR), command, options);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return EXIT.pass;
};

export const waitReady = async (args) => {
    const result = await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'wait-ready', ...args });
    console.log(JSON.stringify(result, null, 2));
    return result.settled ? EXIT.pass : EXIT.fail;
};

/** Submits the verdict. The host rejects incomplete results, so the agent has to improve them. */
export const finish = async (file) => {
    let results;
    try {
        results = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new CawError('finish-rejected', `Results file not readable: ${error.message}`);
    }
    const { status } = await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'finish', results });
    // e2e/steps-e2e.mjs matches this line.
    console.log(`Verdict accepted: ${status}`);
    return EXIT.pass;
};

/** Shows the plan in the chat and waits for the human. The text travels in the command, so the human sees exactly what the agent submits. */
export const plan = async (file) => {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw new CawError('plan-invalid', `Plan file not readable: ${error.message}`);
    }
    console.log(JSON.stringify(await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'plan', text }, { timeoutMs: HUMAN_TIMEOUT_MS }), null, 2));
    return EXIT.pass;
};

/** Submits advice. The human decides per card; the answer lists the decisions. */
export const advise = async (file) => {
    let advice;
    try {
        advice = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new CawError('advice-invalid', `Advice file not readable: ${error.message}`);
    }
    console.log(JSON.stringify(await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'advise', advice }, { timeoutMs: HUMAN_TIMEOUT_MS }), null, 2));
    return EXIT.pass;
};

const canConnect = (host) => new Promise((resolveConnect) => {
    const req = httpsRequest({ host, method: 'HEAD', timeout: 6000, rejectUnauthorized: false }, (res) => { res.resume(); resolveConnect(true); });
    req.on('timeout', () => { req.destroy(); resolveConnect(false); });
    req.on('error', () => resolveConnect(false));
    req.end();
});

/** The agent only starts once the sandbox is proven to be sealed. */
export const firewallCheck = async ({ print = (value) => console.log(JSON.stringify(value, null, 2)) } = {}) => {
    const checks = {
        anthropicReachable: await canConnect('api.anthropic.com'),
        externalBlocked: !await canConnect('example.com'),
        // Straight to the resolver, bypassing /etc/hosts: any answer means data could leak out in DNS names.
        dnsBlocked: await new dns.Resolver({ timeout: 3000, tries: 1 }).resolve4('example.com').then(() => false, () => true),
        sudoBlocked: spawnSync('sudo', ['-n', 'iptables', '-L'], { stdio: 'ignore' }).status !== 0,
    };
    print(checks);
    if (!Object.values(checks).every(Boolean)) throw new CawError('sandbox-open', `The sandbox is not sealed: ${JSON.stringify(checks)}`);
    return EXIT.pass;
};

// One log per mode: the recording's log survives later advice or clarification.
const MODES = {
    run: { log: 'claude.log', prompt: (runId) => `/caw-ai Run ${runId} is open. Carry it out and submit the result with finish.` },
    advise: { log: 'claude-advice.log', prompt: (runId) => `/caw-ai Run ${runId} had errors or warnings. Read the assignment with task and submit your advice with advise.` },
    talk: { log: 'claude-talk.log', prompt: (runId) => `/caw-ai In run ${runId} a step failed, and the human is asking you in the chat. Read the assignment with task, answer with say and wait for them with chat.` },
    develop: { log: 'claude-talk.log', prompt: (runId) => `/caw-ai In run ${runId} the human is developing in the prepared state and asks you in the chat, e.g. about a bug. Read the assignment with task, answer with say and wait for them with chat.` },
};

/**
 * Environment for Claude in the container. `plan`, `ask-operator` and `chat` wait for the human, often longer than the
 * 2 minutes after which Claude Code would move a Bash call to the background. `claude -p` would then end the turn,
 * and with it the run, while the human is still reading. So Bash may run as long as the whole run, and background tasks are off.
 */
export const claudeEnv = (timeoutMin, env = process.env) => {
    const ms = String(timeoutMin * 60 * 1000);
    return { ...env, BASH_DEFAULT_TIMEOUT_MS: ms, BASH_MAX_TIMEOUT_MS: ms, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
};

/** Claude's invocation in the container: all permissions, but only there. Without tools that defer work to later. */
export const claudeArgs = (prompt) => ['-p', prompt, '--dangerously-skip-permissions', '--disallowedTools', 'Monitor,ScheduleWakeup', '--output-format', 'stream-json', '--verbose'];

const SKILL_FILE = fileURLToPath(new URL('../../templates/skill.md', import.meta.url));
const BIN = fileURLToPath(new URL('../../bin/caw-ai.mjs', import.meta.url));
// Reading yes; shell, writing and network never. The browser is reachable only through the caw tool.
export const LOCAL_TOOLS = ['Read', 'Grep', 'Glob'];
// Only in the project folder (Claude's working directory): without a path Read, Grep and Glob could read the whole machine, e.g. ~/.ssh.
export const LOCAL_ALLOWED = [...LOCAL_TOOLS.map((tool) => `${tool}(./**)`), 'mcp__caw__caw'];
// The same secrets as masked in the container (maskArgs), here as read denials.
export const LOCAL_DENY = ['.env', '.env.*', '**/.env', '**/.env.*', '.git/**', '**/.git/**', '.claude/**', '.worktrees/**', '.caw/**', 'caw/.auth/**',
    '**/.npmrc', '**/.netrc', '**/.pgpass', '**/.git-credentials', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_dsa*', '**/id_ed25519*', '**/id_ecdsa*',
    // Keep in line with the secret files in src/host/secrets.mjs (the image has no src/host, so the list is repeated here).
    '**/*.env', '**/.envrc', '**/.pypirc', '**/.yarnrc*', '**/credentials.json', '**/*.jks', '**/.aws/**', '**/.ssh/**', '**/.docker/config.json']
    .flatMap((pattern) => LOCAL_TOOLS.map((tool) => `${tool}(${pattern})`));
// Prepended to the skill: locally there is no shell, the commands go through a tool.
export const LOCAL_PREAMBLE = `You are running locally, not in the container. You have no shell and cannot write files. Every command
\`caw-ai <command> ...\` in the following guide is a call of the tool mcp__caw__caw with args, e.g. args ["snapshot"] or
["click", "e12"]. Where the guide writes a file and passes --file (plan, finish, advise), pass its content in file instead.
Read the source code with Read, Grep and Glob. Do not read files outside the project.

`;

/** Claude's invocation without a container: only the tools above; Claude Code denies everything else without asking. */
export const localClaudeArgs = (prompt, { mcpConfig, settings, systemPromptFile }) => [
    '-p', prompt,
    '--tools', LOCAL_TOOLS.join(','),
    '--allowedTools', LOCAL_ALLOWED.join(','),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    // No user or project settings: dontAsk would silently grant their allow rules (e.g. "Read" or "Read(//**)") and
    // additionalDirectories, and Claude could read ~/.ssh. What the call needs from them, writeLocalSetup carries over.
    '--setting-sources', '',
    '--settings', settings,
    '--append-system-prompt-file', systemPromptFile,
    '--output-format', 'stream-json', '--verbose',
];

// From the user's settings only what the connection to Claude needs (proxy, Bedrock, key helper, model), no permissions.
const CONNECTION_KEYS = ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'model'];
export const connectionSettings = (env = process.env) => {
    const file = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
    try {
        const parsed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
        return Object.fromEntries(CONNECTION_KEYS.filter((key) => parsed?.[key] !== undefined).map((key) => [key, parsed[key]]));
    } catch {
        return {};
    }
};

/** The files the local invocation needs: MCP server, read denials and the guide. All in this run's agent folder. */
export const writeLocalSetup = (dir, env = process.env) => {
    const mcpConfig = join(dir, 'mcp.json');
    const settings = join(dir, 'settings.json');
    const systemPromptFile = join(dir, 'instructions.md');
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { caw: { command: process.execPath, args: [BIN, 'mcp-agent'], env: { CAW_SANDBOX: '1', CAW_AGENT_DIR: dir, ...(env.CAW_COLOR ? { CAW_COLOR: env.CAW_COLOR } : {}) } } } }, null, 2));
    writeFileSync(settings, JSON.stringify({ ...connectionSettings(env), permissions: { deny: LOCAL_DENY }, disableAllHooks: true }, null, 2));
    writeFileSync(systemPromptFile, `${LOCAL_PREAMBLE}${readFileSync(SKILL_FILE, 'utf8').replace(/^---[\s\S]*?---\s*/, '')}`);
    return { mcpConfig, settings, systemPromptFile };
};

/**
 * Main process of the container: check, then let Claude work on the open run.
 * @param mode run (record, fix), advise (advice only), talk (clarify with the human) or develop (help while the human develops)
 */
export const sandboxRun = async ({ root, runId, timeoutMin, mode = 'run' }) => {
    const dir = agentDir();
    const local = process.env.CAW_AGENT_LOCAL === '1';
    const { log: logName, prompt: promptFor } = MODES[mode];
    let claude;
    let timer;
    if (local) {
        // Without a container there is no firewall to check; the tool set is the boundary. The guide provides the skill, not /caw-ai.
        const prompt = promptFor(runId).replace(/^\/caw-ai /, '');
        const env = { ...claudeEnv(timeoutMin), MCP_TOOL_TIMEOUT: String(timeoutMin * 60 * 1000) };
        const bin = resolveClaude() ?? { file: 'claude', args: [] };
        claude = spawn(bin.file, [...bin.args, ...localClaudeArgs(prompt, writeLocalSetup(dir))], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        timer = setTimeout(() => claude.kill(), timeoutMin * 60 * 1000);
    } else {
        await firewallCheck({ print: () => {} });
        claude = spawn('timeout', [String(timeoutMin * 60), 'claude', ...claudeArgs(promptFor(runId))], { cwd: root, env: claudeEnv(timeoutMin), stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const log = openSync(join(dir, logName), 'w');
    const startedAt = Date.now();
    const paint = painter(process.env.CAW_COLOR === '1');
    const write = (line) => {
        for (const text of formatClaudeLine(line)) {
            const stamped = stampLine(text, startedAt, Date.now());
            writeSync(log, stamped);
            process.stdout.write(colorLine(stamped, paint));
        }
    };
    const drained = [claude.stdout, claude.stderr].map((stream) => new Promise((resolveDrained) => {
        createInterface({ input: stream }).on('line', write).on('close', resolveDrained);
    }));
    const code = await new Promise((resolveCode) => {
        claude.on('error', (error) => {
            if (local && error.code === 'ENOENT') process.stdout.write('Claude Code (claude) is not on the PATH. Install it: https://claude.com/claude-code\n');
            resolveCode(1);
        });
        claude.on('close', (status) => resolveCode(status ?? 1));
    });
    clearTimeout(timer);
    await Promise.all(drained);
    return code;
};
