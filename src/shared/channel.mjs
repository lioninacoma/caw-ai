// The only link between container and browser: commands as files in a shared folder.
// That way the container gets neither network access to the host nor CDP. Everything in the folder is untrusted.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { CawError } from './errors.mjs';

const COMMAND_FILE = /^cmd-([A-Za-z0-9_-]{1,64})\.json$/;
const MAX_COMMAND_BYTES = 1024 * 1024;
const RENAME_RETRIES = 10;
const CLIENT_POLL_MS = 30;

const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

/** Windows virus scanners briefly lock fresh files, hence a few retries. */
const renameWithRetry = async (from, to) => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            renameSync(from, to);
            return;
        } catch (error) {
            if (attempt >= RENAME_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
            await sleep(20);
        }
    }
};

/** Create instead of overwrite: a planted link in the folder must never become a write target. */
const writeAtomic = async (dir, name, content) => {
    const temporary = join(dir, `tmp-${randomBytes(6).toString('hex')}`);
    writeFileSync(temporary, content, { flag: 'wx' });
    await renameWithRetry(temporary, join(dir, name));
};

/** Container side: sends a command and waits for the answer. */
export const sendCommand = async (dir, command, { timeoutMs = 360_000 } = {}) => {
    const id = randomBytes(8).toString('hex');
    await writeAtomic(dir, `cmd-${id}.json`, JSON.stringify(command));
    const responseFile = join(dir, `res-${id}.json`);
    const started = Date.now();
    while (!existsSync(responseFile)) {
        if (Date.now() - started > timeoutMs) throw new CawError('no-session', 'The browser does not respond.');
        await sleep(CLIENT_POLL_MS);
    }
    const answer = JSON.parse(readFileSync(responseFile, 'utf8'));
    rmSync(responseFile, { force: true });
    if (!answer.ok) throw new CawError(answer.code, answer.message);
    return answer.value;
};

const readCommand = (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_COMMAND_BYTES) throw new CawError('command-invalid', 'Invalid command.');
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        // Deliberately without details: the JSON.parse message quotes the file content.
        throw new CawError('command-invalid', 'Invalid command.');
    }
};

/**
 * Host side: processes all pending commands in order. Whatever the container creates in the folder must
 * never trip up the host: Windows may not even stat or delete a link created in WSL, for example.
 * Such entries are remembered in `ignored` and answered only once.
 */
export const pollChannel = async (dir, handler, ignored = new Set()) => {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
        const match = COMMAND_FILE.exec(name);
        if (match !== null && !ignored.has(name)) {
            const file = join(dir, name);
            let answer;
            try {
                answer = { ok: true, value: await handler(readCommand(file)) };
            } catch (error) {
                answer = { ok: false, code: error.code ?? 'failed', message: error.message };
            }
            try {
                rmSync(file, { force: true });
                await writeAtomic(dir, `res-${match[1]}.json`, JSON.stringify(answer));
            } catch {
                ignored.add(name);
            }
        }
    }
};
