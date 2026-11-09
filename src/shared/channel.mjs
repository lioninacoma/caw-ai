// Einzige Verbindung zwischen Container und Browser: Befehle als Dateien in einem geteilten Ordner.
// Der Container bekommt so weder Netz zum Host noch CDP. Alles aus dem Ordner ist nicht vertrauenswuerdig.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { CawError } from './errors.mjs';

const COMMAND_FILE = /^cmd-([A-Za-z0-9_-]{1,64})\.json$/;
const MAX_COMMAND_BYTES = 1024 * 1024;
const RENAME_RETRIES = 10;
const CLIENT_POLL_MS = 30;

const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms); });

/** Windows-Virenscanner halten frische Dateien kurz fest, darum einige Versuche. */
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

/** Neu anlegen statt ueberschreiben: Eine vorbereitete Verknuepfung im Ordner darf nie Schreibziel werden. */
const writeAtomic = async (dir, name, content) => {
    const temporary = join(dir, `tmp-${randomBytes(6).toString('hex')}`);
    writeFileSync(temporary, content, { flag: 'wx' });
    await renameWithRetry(temporary, join(dir, name));
};

/** Containerseite: schickt einen Befehl und wartet auf die Antwort. */
export const sendCommand = async (dir, command, { timeoutMs = 360_000 } = {}) => {
    const id = randomBytes(8).toString('hex');
    await writeAtomic(dir, `cmd-${id}.json`, JSON.stringify(command));
    const responseFile = join(dir, `res-${id}.json`);
    const started = Date.now();
    while (!existsSync(responseFile)) {
        if (Date.now() - started > timeoutMs) throw new CawError('no-session', 'Der Browser antwortet nicht.');
        await sleep(CLIENT_POLL_MS);
    }
    const answer = JSON.parse(readFileSync(responseFile, 'utf8'));
    rmSync(responseFile, { force: true });
    if (!answer.ok) throw new CawError(answer.code, answer.message);
    return answer.value;
};

const readCommand = (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_COMMAND_BYTES) throw new CawError('command-invalid', 'Kein gültiger Befehl.');
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        // Bewusst ohne Details: Die Meldung von JSON.parse zitiert den Dateiinhalt.
        throw new CawError('command-invalid', 'Kein gültiger Befehl.');
    }
};

/**
 * Hostseite: arbeitet alle wartenden Befehle der Reihe nach ab. Was der Container im Ordner anlegt, darf
 * den Host nie aus dem Tritt bringen: Einen in WSL angelegten Link darf Windows z. B. nicht einmal
 * ansehen oder loeschen. Solche Eintraege merkt sich `ignored`, sie werden nur einmal beantwortet.
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
