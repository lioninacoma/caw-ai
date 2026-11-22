// Attach: the person's own coding agent session (today Claude Code) answers a caw window. Its MCP server registers as a listener
// under a short key (caw_attach). A run started with --attach binds to one listener: it hands that session its tasks, sends it
// what the person writes in the chat as event lines (a Monitor in the session prints them, `caw attach --watch <key>`), and
// shows in the workbench whether the session is there.
// Like the run marker (session-agent.mjs), a listener file lies in the project, where a planted one could pretend to be a
// session; it counts only with the token caw keeps outside the project, and only while its process lives.

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUN_DIR } from './names.mjs';
import { isAlive, projectSessionsDir } from './session-agent.mjs';

const DIR = 'attach';
/** A listener's key: four characters, at least one digit, so a short test name (shop) is never read as one. */
export const KEY_PATTERN = /^(?=[a-z0-9]*\d)[a-z0-9]{4}$/;
/** The start of a session id given with --attach: hex, at least four characters. */
const ID_PREFIX = /^[0-9a-f-]{4,}$/i;

const listenersDir = (root) => join(root, RUN_DIR, DIR);
const listenerFile = (root, key) => join(listenersDir(root), `${key}.json`);
/** The event lines for one listener: appended by runs, read by `caw attach --watch`. */
export const eventsFile = (root, key) => join(listenersDir(root), `${key}.events`);
const tokenFile = (root, key, env) => join(projectSessionsDir(root, env), `listener-${key}.json`);

const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
};

/** A new key that no listener of the project uses. */
export const newKey = (root, random = () => randomBytes(4)) => {
    for (;;) {
        const bytes = random();
        const key = `${'abcdefghjkmnpqrstuvwxyz'[bytes[0] % 23]}${bytes[1] % 10}${'abcdefghjkmnpqrstuvwxyz0123456789'[bytes[2] % 33]}${bytes[3] % 10}`;
        if (!existsSync(listenerFile(root, key))) return key;
    }
};

/**
 * Registers a listener: the session behind the process `pid` (its MCP server) answers runs bound to `key`.
 * @param sessionId  the coding agent's session id, if known (CLAUDE_CODE_SESSION_ID); --attach may name its start
 * @param publicKey  the MCP server's public key: a run takes its answers to decisions only with a proof made with the
 *                   private half, which never leaves that process (host/decision-proof.mjs)
 */
export const registerListener = (root, { key, sessionId, agent, publicKey, pid = process.pid, env = process.env }) => {
    mkdirSync(listenersDir(root), { recursive: true });
    const token = randomBytes(16).toString('hex');
    const kept = tokenFile(root, key, env);
    mkdirSync(join(kept, '..'), { recursive: true });
    writeFileSync(`${kept}.${pid}.tmp`, JSON.stringify({ key, token }), { mode: 0o600 });
    renameSync(`${kept}.${pid}.tmp`, kept);
    const file = listenerFile(root, key);
    writeFileSync(`${file}.${pid}.tmp`, JSON.stringify({ key, pid, token, ...(sessionId ? { sessionId } : {}), ...(agent ? { agent } : {}), ...(publicKey ? { publicKey } : {}), startedAt: new Date().toISOString() }, null, 2));
    renameSync(`${file}.${pid}.tmp`, file);
    if (!existsSync(eventsFile(root, key))) writeFileSync(eventsFile(root, key), '');
    return { key };
};

/** Removes the listener's files; the events file stays for a watch still reading it. */
export const unregisterListener = (root, key, env = process.env) => {
    rmSync(listenerFile(root, key), { force: true });
    rmSync(tokenFile(root, key, env), { force: true });
};

/** The listener behind `key` if it counts: its process lives and its token matches the one kept outside the project. */
export const listenerOf = (root, key, env = process.env) => {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return undefined;
    const entry = readJson(listenerFile(root, key));
    if (entry === undefined || entry.key !== key || !Number.isInteger(entry.pid) || !isAlive(entry.pid)) return undefined;
    return readJson(tokenFile(root, key, env))?.token === entry.token ? entry : undefined;
};

/** Every listener of the project that counts, oldest first. */
export const liveListeners = (root, env = process.env) => {
    if (!existsSync(listenersDir(root))) return [];
    return readdirSync(listenersDir(root))
        .filter((name) => name.endsWith('.json'))
        .map((name) => listenerOf(root, name.slice(0, -'.json'.length), env))
        .filter((entry) => entry !== undefined)
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
};

/** The listeners `value` names: its key, or the start of its session id. */
export const matchListeners = (listeners, value) => {
    if (typeof value !== 'string' || value === '') return listeners;
    if (KEY_PATTERN.test(value)) return listeners.filter(({ key }) => key === value);
    if (ID_PREFIX.test(value)) return listeners.filter(({ sessionId }) => typeof sessionId === 'string' && sessionId.toLowerCase().startsWith(value.toLowerCase()));
    return [];
};

/** Whether a word after --attach is its value (a key or a session id start), not a test name. */
export const isAttachValue = (word) => typeof word === 'string' && (KEY_PATTERN.test(word) || (ID_PREFIX.test(word) && /\d/.test(word) && word.length >= 8));

/** One line for the listener's session: plain text, no line breaks, short. */
export const sendEvent = (root, key, text) => {
    if (!KEY_PATTERN.test(String(key))) return;
    mkdirSync(listenersDir(root), { recursive: true });
    appendFileSync(eventsFile(root, key), `${String(text).replace(/[\r\n]+/g, ' ').slice(0, 2000)}\n`);
};
