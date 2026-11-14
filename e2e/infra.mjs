// What the e2e needs outside Chrome: Docker compose stacks (reached like the sandbox: directly or through WSL), pinned images,
// the reserved port range, an http origin on a non-loopback name, the packed package and an MCP client over stdio.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { selectDocker } from '../src/host/docker.mjs';
import { shellJoin } from '../src/host/linux.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Runs a command; resolves { code, stdout, stderr }, never rejects. */
export const exec = (command, args, { cwd, env = process.env, input, shell = false } = {}) => new Promise((resolve) => {
    // .cmd files (npm.cmd) only start through a shell on Windows; the arguments here are paths without spaces or quotes.
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
});

// ---- Docker

let route = null;
/** The same choice as the sandbox (CAW_DOCKER=windows|wsl); the suite is tried on Docker in WSL. */
const dockerRoute = async () => (route ??= await selectDocker());

/** docker <args> on the chosen route; throws with the tail of stderr when it fails. */
export const docker = async (args, { allowFail = false } = {}) => {
    const { kind } = await dockerRoute();
    const result = kind === 'wsl'
        ? await exec('wsl.exe', ['-e', 'bash', '-lc', `docker ${shellJoin(args)}`])
        : await exec('docker', args);
    if (result.code !== 0 && !allowFail) throw new Error(`docker ${args.slice(0, 3).join(' ')} … exited ${result.code}: ${result.stderr.trim().split('\n').slice(-5).join(' | ')}`);
    return result;
};
const hostPath = async (path) => (await dockerRoute()).hostPath(path);

const LOCK_FILE = join(here, 'images.lock.json');
/** Image → registry digest the suite was tried with. Added together with the fixture that needs the image. */
export const imageLock = () => JSON.parse(readFileSync(LOCK_FILE, 'utf8'));

/** The local image's registry digest, or null when it is not pulled. */
const localDigest = async (image) => {
    const { code, stdout } = await docker(['image', 'inspect', '--format', '{{join .RepoDigests " "}}', image], { allowFail: true });
    if (code !== 0) return null;
    return stdout.trim().split(' ').map((entry) => entry.split('@')[1]).find(Boolean) ?? null;
};

/** Pulls every locked image by digest and tags it with its name; a pulled image with another digest is an error. */
export const pullImages = async (images = Object.keys(imageLock())) => {
    const lock = imageLock();
    for (const image of images) {
        const digest = lock[image];
        if (digest === undefined) throw new Error(`${image} is not in e2e/images.lock.json`);
        if (await localDigest(image) === digest) continue;
        const [name] = image.split(':');
        await docker(['pull', `${name}@${digest}`]);
        await docker(['tag', `${name}@${digest}`, image]);
    }
};

/** Throws when a stack would run an image that is missing or differs from the lock (pull with `node e2e/pull.mjs`). */
export const checkImages = async (images) => {
    const lock = imageLock();
    const wrong = [];
    for (const image of images) {
        const found = await localDigest(image);
        if (found !== lock[image]) wrong.push(`${image} (${found === null ? 'not pulled' : `digest ${found}`})`);
    }
    if (wrong.length > 0) throw new Error(`images differ from e2e/images.lock.json: ${wrong.join(', ')}; run node e2e/pull.mjs`);
};

/** Images a compose file names (`image:` lines). */
export const imagesOf = (file) => [...readFileSync(file, 'utf8').matchAll(/^\s*image:\s*["']?([^"'\s#]+)/gm)].map((match) => match[1]);

/**
 * WSL stops its VM, and with it Docker and every container, once no wsl.exe process is left (measured: Keycloak exited 255
 * seconds after the last docker command). While a stack is up one idle wsl.exe keeps it running; it ends with the last stack.
 * A plain process, no setting changes.
 */
let keeper = null;
let stacksUp = 0;
const holdWsl = async () => {
    stacksUp += 1;
    if (keeper !== null || (await dockerRoute()).kind !== 'wsl') return;
    keeper = spawn('wsl.exe', ['-e', 'sleep', 'infinity'], { stdio: 'ignore', windowsHide: true });
    keeper.on('exit', () => { keeper = null; });
    process.once('exit', () => keeper?.kill());
};
const releaseWsl = () => {
    stacksUp = Math.max(0, stacksUp - 1);
    if (stacksUp === 0) keeper?.kill();
};

/**
 * A compose stack under its own project name (caw-e2e-<name>), so groups never share containers. `down` removes volumes:
 * every group starts from the seeded state. CAW_E2E_KEEP=1 leaves the stack running for debugging.
 */
export const composeStack = (name, file) => {
    const project = `caw-e2e-${name}`;
    // Settings for the services go into the compose file or an env_file next to it: variables of this process do not reach WSL.
    const run = async (args) => docker(['compose', '-p', project, '-f', await hostPath(file), ...args]);
    return {
        project,
        up: async () => {
            await checkImages(imagesOf(file));
            await holdWsl();
            await run(['up', '-d', '--wait', '--wait-timeout', '240']);
        },
        down: async () => {
            if (process.env.CAW_E2E_KEEP === '1') return;
            await run(['down', '-v', '--remove-orphans']);
            releaseWsl();
        },
        exec: (service, command) => run(['exec', '-T', service, ...command]),
    };
};

// ---- Ports

/** The suite's services live on 18000–18999 (and the dev servers it starts); nothing else may listen there. */
export const PORTS = { min: 18000, max: 18999 };

/** Whether something already listens on 127.0.0.1:port. */
export const portTaken = (port) => new Promise((resolve) => {
    const socket = createServer();
    socket.once('error', () => resolve(true));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(false)));
});

/** Waits until nothing listens on the port: after `compose down` the WSL port relay lets go of it a few seconds later (measured). */
export const waitPortFree = async (port, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (await portTaken(port)) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
    return true;
};

/** Throws naming every taken port: a leftover would answer instead and the checks would read the wrong state. */
export const preflightPorts = async (ports) => {
    const outside = ports.filter((port) => port < PORTS.min || port > PORTS.max);
    if (outside.length > 0) throw new Error(`ports outside ${PORTS.min}-${PORTS.max}: ${outside.join(', ')}`);
    const taken = [];
    for (const port of ports) if (await portTaken(port)) taken.push(port);
    if (taken.length > 0) throw new Error(`ports already in use: ${taken.join(', ')}; stop what listens there (or a stack left by CAW_E2E_KEEP=1)`);
};

// ---- An http origin on a name caw does not treat as this machine

/** An address without IPv4 mapping and IPv6 zone ("fe80::1%24" → "fe80::1"), so peers compare with interface addresses. */
const plainAddress = (address) => String(address).replace(/^::ffff:/, '').replace(/%.*$/, '');
/** The machine's own addresses: the only peers the alias accepts. */
const ownAddresses = () => new Set(['127.0.0.1', '::1', ...Object.values(networkInterfaces()).flat().map(({ address }) => address)].map(plainAddress));

/**
 * Forwards <host name>:port to 127.0.0.1:target. caw counts localhost, 127.0.0.1 and *.localhost as this machine; the host name
 * is none of them, so the origin is "http on another host" in caw's sense. 127.0.0.2 would be simpler but does not answer on
 * Windows (measured). The listener is on every interface: the only part of the suite that opens a port beyond loopback. So it
 * runs only with CAW_E2E_LAN=1 (scenarios using it declare `optIn: 'CAW_E2E_LAN'`), lives for one scenario, and closes
 * connections from other machines at once. It changes no setting: nothing to revert after close().
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export const httpAlias = (port, target) => new Promise((resolve, reject) => {
    if (process.env.CAW_E2E_LAN !== '1') {
        reject(new Error('httpAlias listens on the network interface: only with CAW_E2E_LAN=1 (declare optIn on the scenario)'));
        return;
    }
    const allowed = ownAddresses();
    const server = createServer((socket) => {
        if (!allowed.has(plainAddress(socket.remoteAddress))) {
            socket.destroy();
            return;
        }
        const upstream = connect(target, '127.0.0.1');
        socket.pipe(upstream).pipe(socket);
        const end = () => { socket.destroy(); upstream.destroy(); };
        socket.on('error', end);
        upstream.on('error', end);
    });
    server.once('error', reject);
    server.listen(port, () => resolve({
        url: `http://${hostname().toLowerCase()}:${port}`,
        close: () => new Promise((done) => { server.close(() => done()); }),
    }));
});

// ---- The packed package

const PACK_DIR = join(here, '.pack');
let packed = null;

/** `npm pack` of the working tree, once per process; the tarball is what users install. */
export const packTarball = async () => {
    if (packed !== null) return packed;
    rmSync(PACK_DIR, { recursive: true, force: true });
    mkdirSync(PACK_DIR, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const { code, stdout, stderr } = await exec(npm, ['pack', '--pack-destination', PACK_DIR, '--silent'], { cwd: root, env: process.env, shell: true });
    if (code !== 0) throw new Error(`npm pack failed: ${stderr.trim()}`);
    const name = stdout.trim().split('\n').pop().trim();
    packed = join(PACK_DIR, name);
    if (!existsSync(packed)) throw new Error(`npm pack wrote no ${name}`);
    return packed;
};

/** The tarball's file list (paths inside `package/`). */
export const tarballFiles = async (tarball) => {
    const { code, stdout, stderr } = await exec('tar', ['-tzf', tarball]);
    if (code !== 0) throw new Error(`tar failed: ${stderr.trim()}`);
    return stdout.split('\n').map((line) => line.trim().replace(/^package\//, '')).filter(Boolean);
};

/** A fresh project folder with the packed package installed as a dev dependency, as `npm i -D caw-ai` would do it. */
export const installPacked = async (dir) => {
    const tarball = await packTarball();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `caw-e2e-${createHash('sha1').update(dir).digest('hex').slice(0, 8)}`, private: true }, null, 2));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const { code, stderr } = await exec(npm, ['install', '--save-dev', '--no-audit', '--no-fund', tarball], { cwd: dir, shell: true });
    if (code !== 0) throw new Error(`npm install of the tarball failed: ${stderr.trim().split('\n').slice(-5).join(' | ')}`);
    return { dir, tarball, bins: readdirSync(join(dir, 'node_modules', '.bin')) };
};

// ---- MCP over stdio (newline-delimited JSON-RPC, as Claude Code speaks it)

/**
 * Starts an MCP server and talks to it like Claude Code. Server-sent notifications are collected in `notifications`.
 * @returns {{ request: (method: string, params?: object) => Promise<object>, notify: (method: string, params?: object) => void, initialize: () => Promise<object>, callTool: (name: string, args?: object) => Promise<object>, notifications: object[], stderr: () => string, close: () => Promise<void> }}
 */
export const mcpClient = (command, args, { cwd, env = process.env, timeoutMs = 60000 } = {}) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' && /\.cmd$|^npx$/.test(command) });
    const pending = new Map();
    const notifications = [];
    let errors = '';
    let next = 1;
    child.stderr.on('data', (chunk) => { errors += chunk; });
    createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.trim() === '') return;
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
            const { resolve, reject, timer } = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(timer);
            if (message.error) reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
            else resolve(message.result);
        } else if (message.method !== undefined) {
            notifications.push(message);
        }
    });
    const exited = new Promise((resolve) => { child.on('close', resolve); });
    child.on('close', () => {
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(new Error(`MCP server exited: ${errors.trim().split('\n').slice(-3).join(' | ')}`));
        }
        pending.clear();
    });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const request = (method, params = {}) => new Promise((resolve, reject) => {
        const id = next;
        next += 1;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP ${method} got no answer within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
    });
    const notify = (method, params = {}) => send({ method, params });
    return {
        request,
        notify,
        notifications,
        initialize: async () => {
            const result = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'caw-e2e', version: '1' } });
            notify('notifications/initialized');
            return result;
        },
        callTool: (name, input = {}) => request('tools/call', { name, arguments: input }),
        stderr: () => errors,
        close: async () => {
            child.stdin.end();
            const timer = setTimeout(() => child.kill(), 5000);
            await exited;
            clearTimeout(timer);
        },
    };
};
