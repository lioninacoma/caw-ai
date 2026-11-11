// The tool reaches Docker in two ways: directly (docker.exe on Windows, docker on Linux) or through
// WSL. The rest of the tool only knows this small object.

import { spawn } from 'node:child_process';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { shellJoin, toWslPath } from './linux.mjs';

/** Claude in the container only with an API key from the Claude Console; subscription logins stay in the user's own Claude Code. */
const KEY = 'ANTHROPIC_API_KEY';
const COMMAND_NOT_FOUND = 127;

/** WSL only takes over Windows variables listed in WSLENV. This way the key may be set on either side. */
export const wslEnv = (env) => ({
    ...env,
    WSLENV: [env.WSLENV, KEY].filter(Boolean).join(':'),
});

const exec = (command, args, { capture = false, env = process.env } = {}) => new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'], env });
    let stdout = '';
    if (capture) {
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', () => {});
    }
    child.on('error', () => resolvePromise({ code: COMMAND_NOT_FOUND, stdout }));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout }));
});

export const nativeDocker = {
    kind: 'native',
    label: 'Docker',
    get startHint() { return t('session.docker.nativeStartHint'); },
    run: (args, options) => exec('docker', args, options),
    hostPath: (path) => path,
    hasToken: async () => Boolean(process.env[KEY]),
    get tokenHint() { return t('session.docker.nativeTokenHint', { key: KEY }); },
};

export const wslDocker = {
    kind: 'wsl',
    label: 'Docker in WSL',
    get startHint() { return t('session.docker.wslStartHint'); },
    run: (args, options) => exec('wsl.exe', ['-e', 'bash', '-lc', `docker ${shellJoin(args)}`], { ...options, env: wslEnv(process.env) }),
    hostPath: toWslPath,
    // wsl.exe exists on almost every Windows, even without a distribution. Then Docker is missing, not just stopped.
    reachable: async () => (await exec('wsl.exe', ['-e', 'bash', '-lc', 'true'], { capture: true })).code === 0,
    hasToken: async () => (await exec('wsl.exe', ['-e', 'bash', '-lc', `[ -n "\${${KEY}:-}" ]`], { capture: true, env: wslEnv(process.env) })).code === 0,
    get tokenHint() { return t('session.docker.wslTokenHint', { key: KEY }); },
};

/** What to try, in this order. `CAW_DOCKER` picks the way when both exist. */
export const dockerCandidates = ({ platform = process.platform, env = process.env } = {}) => {
    if (platform !== 'win32') return [nativeDocker];
    const choice = env.CAW_DOCKER;
    if (choice === 'windows') return [nativeDocker];
    if (choice === 'wsl') return [wslDocker];
    if (choice) throw new CawError('usage', t('session.docker.unknownChoice', { choice }));
    return [nativeDocker, wslDocker];
};

/** Asks the daemon itself: the command existing says nothing about whether it runs. */
const probe = async (docker) => {
    const { code, stdout } = await docker.run(['version', '--format', '{{.Server.Os}}'], { capture: true });
    if (code === COMMAND_NOT_FOUND) return 'missing';
    if (code !== 0) return docker.reachable !== undefined && !await docker.reachable() ? 'missing' : 'stopped';
    return stdout.replaceAll('\0', '').trim() === 'linux' ? 'ready' : 'wrong-os';
};

/** Takes the first way whose daemon runs, otherwise says exactly what is missing. */
export const selectDocker = async (candidates = dockerCandidates()) => {
    const states = [];
    for (const docker of candidates) {
        const state = await probe(docker);
        if (state === 'ready') return docker;
        states.push({ docker, state });
    }
    const wrong = states.find(({ state }) => state === 'wrong-os');
    if (wrong !== undefined) {
        throw new CawError('docker-wrong-mode', t('session.docker.wrongMode', { label: wrong.docker.label }));
    }
    const stopped = states.filter(({ state }) => state === 'stopped');
    if (stopped.length > 0) {
        throw new CawError('docker-not-running', t('session.docker.notRunning', { hints: stopped.map(({ docker }) => docker.startHint).join(t('session.docker.or')) }));
    }
    throw new CawError('docker-missing', t('session.docker.missing'));
};
