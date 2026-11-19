// caw attach --watch <key>: what a session's Monitor runs. Every line a run sends to the listener (a task, a chat message, the
// end of a run) is printed as it arrives; the session reads each printed line as an event. Ends when the listener is gone.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

import { KEY_PATTERN, eventsFile, listenerOf } from '../shared/attach.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** The bytes appended to `file` since `offset`. */
const readFrom = (file, offset, size) => {
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(file, 'r');
    try {
        readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
        closeSync(fd);
    }
    return buffer.toString('utf8');
};

/**
 * @param out     one printed line
 * @param alive   whether the listener still counts (tests replace it)
 * @returns the exit code once the listener is gone
 */
export const attachCommand = async (root, args, { out = (line) => process.stdout.write(`${line}\n`), pollMs = 400, alive = (key) => listenerOf(root, key) !== undefined } = {}) => {
    const [flag, key] = args;
    if (flag !== '--watch' || !KEY_PATTERN.test(key ?? '')) throw new CawError('usage', t('cli.attachUsage'));
    const file = eventsFile(root, key);
    let offset = existsSync(file) ? statSync(file).size : 0;
    let rest = '';
    out(t('cli.attachListening', { key }));
    let checked = 0;
    for (;;) {
        const size = existsSync(file) ? statSync(file).size : 0;
        if (size < offset) offset = 0;
        if (size > offset) {
            const lines = (rest + readFrom(file, offset, size)).split('\n');
            offset = size;
            rest = lines.pop();
            for (const line of lines) if (line.trim() !== '') out(line.trim());
        }
        // The listener is checked less often than the file: a process lookup per second is plenty.
        if (Date.now() - checked > 1000) {
            checked = Date.now();
            if (!alive(key)) {
                out(t('cli.attachGone', { key }));
                return 0;
            }
        }
        await sleep(pollMs);
    }
};
