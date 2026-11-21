// Fixed data ("feste Daten") for a learned look: a screen that shows server data only looks the same in every run when the data
// is the same. A person freezes the JSON answers of the app's reads once (a chat button after a passed run with a window); later
// headless runs serve them to the app from the browser in a look pass of their own, after the normal run, and compare the look of
// the steps with `look: true` on them. The normal run, its checks, effects and requests always see the real backend.
// Backend changes still count: while a frozen answer is served, the real request goes out too, and its answer's shape (fields,
// types, status) is compared with the frozen one's. Other values are the point; another shape means the data is outdated.
// Privacy: the person chooses how the data is stored (anonymized, obfuscated, readable after a confirmation) and reviews it first.
// Nothing here talks to an AI session: the raw answers stay in caw's process and, when configured, the person's own command.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { RECORDING_DIR } from '../shared/names.mjs';

export const FIXED_VERSION = 1;
/** How frozen data is stored: anonymized (a command or caw's own replacement), obfuscated (not protection), plain (confirmed). */
export const FIXED_MODES = ['anonymized', 'obfuscated', 'plain'];
/** Where a test's frozen data lives, relative to the project: beside the look images. */
export const fixedDataFile = (test) => `${RECORDING_DIR}/${test}/fixed-data.json`;

// Bounds for what a run keeps in memory to be frozen: a portal answers a lot, a run must not grow without end.
export const MAX_ANSWERS = 500;
export const MAX_ANSWER_CHARS = 2_000_000;
export const MAX_TOTAL_CHARS = 20_000_000;
// The anonymizing command gets this long.
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * Answers that can be frozen: JSON by content type (application/json and the +json types, e.g. a GraphQL or JSON:API answer).
 * Server-rendered HTML, text, streams and WebSocket messages stay live.
 */
export const isJsonType = (contentType) => /^\s*application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i.test(String(contentType ?? ''));

const sha = (text) => createHash('sha256').update(text).digest('hex');
/** The file's content hash: part of a fixed look's basis, so new or hand-edited data learns the look anew. */
export const fixedHash = (text) => sha(text).slice(0, 12);

/**
 * A request's exact key: method, path, query and body, hashed. Stored instead of the address, which can carry data (a name in
 * the path, an e-mail in the query).
 */
export const requestKey = ({ method, url, postData = null }) => {
    let where = String(url);
    try {
        const parsed = new URL(url);
        where = `${parsed.pathname}${parsed.search}`;
    } catch {
        // An unreadable address counts as it is.
    }
    return sha(`${String(method).toUpperCase()} ${where}\n${postData ?? ''}`).slice(0, 16);
};

/**
 * The answers a run collects for freezing, in the order they arrived; the body follows the headers (fill). In memory only.
 * @returns { add(entry) -> entry|null, mark(), since(mark), all() }
 */
export const createAnswerLog = ({ maxAnswers = MAX_ANSWERS, maxChars = MAX_TOTAL_CHARS, maxAnswer = MAX_ANSWER_CHARS } = {}) => {
    const entries = [];
    let chars = 0;
    return {
        /** entry { name, key, status, type }: its place is fixed now, `fill(text)` adds the body. */
        add: (entry) => {
            if (entries.length >= maxAnswers) return null;
            const kept = { ...entry, at: entries.length, text: null };
            entries.push(kept);
            return {
                fill: (text) => {
                    if (typeof text !== 'string' || text.length > maxAnswer || chars + text.length > maxChars) return;
                    chars += text.length;
                    kept.text = text;
                },
            };
        },
        mark: () => entries.length,
        /** The answers from `mark` on whose body arrived and is JSON. */
        since: (mark = 0) => entries.slice(mark).flatMap((entry) => {
            if (entry.text === null) return [];
            try {
                return [{ name: entry.name, key: entry.key, status: entry.status, type: entry.type, at: entry.at, body: JSON.parse(entry.text) }];
            } catch {
                return [];
            }
        }),
    };
};

/**
 * Which step each answer belongs to: the step that ran when it arrived (the run notes `{ owner, at }` whenever the step changes).
 * What the start page loaded before the first action belongs to the first step: its screen shows it too.
 * @param marks [{ owner, at }] in run order, `at` the answer log's mark
 * @returns the answers with `step`
 */
export const answersBySteps = (answers, marks) => answers.flatMap((answer) => {
    const owner = (marks.filter(({ at }) => at <= answer.at).at(-1) ?? marks[0])?.owner;
    return owner === undefined ? [] : [{ ...answer, step: owner }];
});

/**
 * The answers to freeze for these look steps: everything up to the last one, since the screen of a later step also shows what
 * an earlier step loaded.
 * @param order the test's step ids in order
 */
export const answersUpTo = (answers, order, steps) => {
    const last = Math.max(...steps.map((id) => order.indexOf(id)));
    return answers.filter(({ step }) => order.indexOf(step) !== -1 && order.indexOf(step) <= last);
};

/**
 * Serves frozen answers by request: the same request (exact key) in the order they came, else the same request name. A request
 * asked more often than frozen gets the last answer again.
 * @returns { take({ key, name }) -> answer|null }
 */
export const answerBook = (answers) => {
    const group = (field) => {
        const lists = new Map();
        for (const answer of answers) {
            if (!lists.has(answer[field])) lists.set(answer[field], []);
            lists.get(answer[field]).push(answer);
        }
        return lists;
    };
    const byKey = group('key');
    const byName = group('name');
    const used = new Map();
    const next = (list) => {
        const count = used.get(list) ?? 0;
        used.set(list, count + 1);
        return list[Math.min(count, list.length - 1)];
    };
    return {
        take: ({ key, name }) => {
            const exact = byKey.get(key);
            if (exact !== undefined) return next(exact);
            const named = byName.get(name);
            return named === undefined ? null : next(named);
        },
    };
};

// ------------------------------------------------------------------------------------------------------------------- shape

const MAX_DEPTH = 8;
const MAX_ITEMS = 50;
const kindOf = (value) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value === 'object' ? 'object' : typeof value;
};

/** Merges two shapes, e.g. of two list items: a key only one of them has is optional, null fits any kind. */
const mergeShape = (a, b) => {
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    if (a.kind === 'null') return { ...b, ...(a.optional || b.optional ? { optional: true } : {}) };
    if (b.kind === 'null') return { ...a, ...(a.optional || b.optional ? { optional: true } : {}) };
    const optional = a.optional || b.optional ? { optional: true } : {};
    if (a.kind !== b.kind) return { kind: 'mixed', ...optional };
    if (a.kind === 'array') return { kind: 'array', item: mergeShape(a.item, b.item), ...optional };
    if (a.kind !== 'object') return { kind: a.kind, ...optional };
    const keys = {};
    for (const key of new Set([...Object.keys(a.keys), ...Object.keys(b.keys)])) {
        const merged = mergeShape(a.keys[key], b.keys[key]);
        keys[key] = key in a.keys && key in b.keys ? merged : { ...merged, optional: true };
    }
    return { kind: 'object', keys, ...optional };
};

/**
 * The shape of a JSON value without its values: kinds, keys, list items merged (a key some items lack is optional). Deeper than
 * MAX_DEPTH and beyond MAX_ITEMS items nothing is compared.
 */
export const shapeOf = (value, depth = 0) => {
    const kind = kindOf(value);
    if (depth >= MAX_DEPTH) return { kind: 'mixed' };
    if (kind === 'array') return { kind, item: value.slice(0, MAX_ITEMS).map((item) => shapeOf(item, depth + 1)).reduce((merged, item) => mergeShape(merged, item), null) };
    if (kind === 'object') return { kind, keys: Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shapeOf(inner, depth + 1)])) };
    return { kind };
};

/**
 * Where two shapes differ: a field gone or new, another kind. Null fits anything, an empty list fits any list, an optional field
 * may be missing.
 * @returns [{ change: 'missing'|'added'|'kind', path, was?, now? }]
 */
export const shapeChanges = (frozen, real, path = '', out = []) => {
    if (frozen === null || real === null || frozen === undefined || real === undefined) return out;
    if ([frozen.kind, real.kind].some((kind) => kind === 'null' || kind === 'mixed')) return out;
    if (frozen.kind !== real.kind) {
        out.push({ change: 'kind', path: path || '/', was: frozen.kind, now: real.kind });
        return out;
    }
    if (frozen.kind === 'array') return shapeChanges(frozen.item, real.item, `${path}[]`, out);
    if (frozen.kind !== 'object') return out;
    for (const [key, inner] of Object.entries(frozen.keys)) {
        if (!(key in real.keys)) {
            if (inner.optional !== true) out.push({ change: 'missing', path: `${path}.${key}` });
        } else shapeChanges(inner, real.keys[key], `${path}.${key}`, out);
    }
    for (const [key, inner] of Object.entries(real.keys)) if (!(key in frozen.keys) && inner.optional !== true) out.push({ change: 'added', path: `${path}.${key}` });
    return out;
};

/**
 * Does the real answer still fit the frozen one? Same status class and the same shape; other values are fine.
 * @param frozen { status, body }
 * @param real   { status, json } with json undefined when the answer was no JSON
 */
export const answerChanges = (frozen, real) => {
    if (real.status === 0) return [{ change: 'unreachable' }];
    const changes = [];
    if (Math.floor(real.status / 100) !== Math.floor(frozen.status / 100)) changes.push({ change: 'status', was: frozen.status, now: real.status });
    if (real.status >= 400) return changes;
    if (real.json === undefined) return [...changes, { change: 'notJson' }];
    return [...changes, ...shapeChanges(shapeOf(frozen.body), shapeOf(real.json))];
};

/** One change in plain words. */
export const changeText = ({ change, path, was, now }) => t(`session.fixed.change.${change}`, {
    path,
    was: was === undefined ? '' : typeof was === 'number' ? String(was) : t(`session.fixed.kind.${was}`),
    now: now === undefined ? '' : typeof now === 'number' ? String(now) : t(`session.fixed.kind.${now}`),
});

// -------------------------------------------------------------------------------------------------------------- anonymizing

// Invented replacements, never real data: names, streets and places picked per value.
const FIRST = ['Alex', 'Kim', 'Robin', 'Sam', 'Jo', 'Mika', 'Toni', 'Luca', 'Noa', 'Eli', 'Janne', 'Romy'];
const LAST = ['Beispiel', 'Muster', 'Probe', 'Testmann', 'Platzhalter', 'Vorlage', 'Ersatz', 'Fiktiv'];
const STREETS = ['Musterweg', 'Beispielstraße', 'Probeallee', 'Testgasse', 'Platzhalterring'];
const PLACES = ['Musterstadt', 'Beispielhausen', 'Probedorf', 'Testheim', 'Fiktivburg'];
const FILLER = 'loremipsumdolorsitametconsecteturadipiscingelitseddoeiusmodtemporincididunt';

// Kinds by key name. Keys keep their names; ids keep their values (a list links to its records by them).
const ID_KEY = /^(?:id|uuid|guid)$|(?:Id|ID|Ids|IDs|_id|-id|_ids|Uuid|_uuid|Guid|_guid)$/;
const KEY_KINDS = [
    ['email', /e-?mail/i],
    ['phone', /phone|telefon|^tel$|^tel[A-Z_]|mobil|handy|^fax|fax$/i],
    ['date', /birth|geburt|^dob$/i],
    ['iban', /iban|^bic$|konto|account/i],
    ['postal', /zip|^plz$|postal|post_?code/i],
    ['street', /street|stra(?:ss|ß)e|address|adresse|anschrift/i],
    ['place', /city|^ort$|wohnort|stadt|town/i],
    ['name', /name$|^(?:vor|nach)name|^name/i],
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN = /^[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(.*)$/;
const DOT_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const PHONE = /^\+?[\d\s()/.-]{7,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * caw's own anonymizer, "replace when in doubt": every string is replaced, the same value the same way within one freeze.
 * By pattern: e-mail, IBAN, phone, dates (shifted by a fixed number of days, so their order stays); by key name: names,
 * streets, places, postal codes, birth dates; ids and UUIDs stay, as do numbers, booleans, null and every key. Unknown text
 * becomes neutral text of the same length (letters, case, spaces and punctuation in place). Only values in `keep` stay.
 * @param salt  makes the replacement deterministic within one freeze; random per freeze, never stored
 * @param shift days dates move back
 */
export const createAnonymizer = ({ keep = [], salt = randomBytes(16).toString('hex'), shift = 30 + randomBytes(2).readUInt16BE(0) % 365 } = {}) => {
    const kept = new Set(keep.filter((value) => typeof value === 'string'));
    const bytesOf = (kind, value) => createHash('sha256').update(`${salt}\u0000${kind}\u0000${value}`).digest();
    const pickOf = (list, bytes, at = 0) => list[bytes.readUInt16BE(at) % list.length];
    const digits = (value, bytes) => {
        let index = 0;
        return value.replace(/\d/g, (digit) => {
            const position = index;
            index += 1;
            // A leading zero stays (a dialing prefix, a postal code's region): the format remains recognizable.
            if (position === 0 && digit === '0') return digit;
            const replaced = (Number(digit) + bytes[position % bytes.length]) % 10;
            return String(position === 0 && replaced === 0 ? 1 : replaced);
        });
    };
    const characters = (value, bytes) => {
        let index = bytes[0] % FILLER.length;
        let digit = 0;
        return [...value].map((char) => {
            if (/\d/.test(char)) {
                digit += 1;
                return String(bytes[digit % bytes.length] % 10);
            }
            if (!/\p{L}/u.test(char)) return char;
            const letter = FILLER[index % FILLER.length];
            index += 1;
            return char !== char.toLowerCase() ? letter.toUpperCase() : letter;
        }).join('');
    };
    const shifted = (year, month, day) => {
        const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        if (Number.isNaN(date.getTime())) return null;
        date.setUTCDate(date.getUTCDate() - shift);
        return date;
    };
    const twoDigits = (number) => String(number).padStart(2, '0');
    const date = (value) => {
        const iso = ISO_DATE.exec(value);
        if (iso !== null) {
            const moved = shifted(iso[1], iso[2], iso[3]);
            return moved === null ? null : `${moved.getUTCFullYear()}-${twoDigits(moved.getUTCMonth() + 1)}-${twoDigits(moved.getUTCDate())}${iso[4]}`;
        }
        const dotted = DOT_DATE.exec(value);
        if (dotted !== null) {
            const moved = shifted(dotted[3], dotted[2], dotted[1]);
            return moved === null ? null : `${twoDigits(moved.getUTCDate())}.${twoDigits(moved.getUTCMonth() + 1)}.${moved.getUTCFullYear()}`;
        }
        return null;
    };
    const name = (key, value, bytes) => {
        const words = value.trim().split(/\s+/).length;
        if (words > 1) return `${pickOf(FIRST, bytes)} ${pickOf(LAST, bytes, 2)}`;
        return /first|vor|given/i.test(key) ? pickOf(FIRST, bytes) : /last|nach|sur|family/i.test(key) ? pickOf(LAST, bytes, 2) : pickOf([...FIRST, ...LAST], bytes);
    };
    const datePattern = (value) => ISO_DATE.test(value) || DOT_DATE.test(value);
    const string = (key, value) => {
        if (kept.has(value) || value === '') return value;
        if ((ID_KEY.test(key) && !/\s/.test(value)) || UUID.test(value)) return value;
        const byKey = KEY_KINDS.find(([, pattern]) => pattern.test(key))?.[0];
        const kind = (EMAIL.test(value) && 'email') || (IBAN.test(value.replace(/\s/g, '')) && 'iban') || (datePattern(value) && 'date')
            || byKey || (PHONE.test(value) && (value.match(/\d/g) ?? []).length >= 7 && 'phone') || (/^\d+$/.test(value) && 'number') || 'text';
        const bytes = bytesOf(kind, value);
        switch (kind) {
            case 'email': return `${pickOf(FIRST, bytes).toLowerCase()}.${bytes.toString('hex').slice(0, 6)}@example.org`;
            case 'date': return date(value) ?? characters(value, bytes);
            case 'name': return name(key, value, bytes);
            case 'street': return `${pickOf(STREETS, bytes)} ${1 + bytes[4] % 99}`;
            case 'place': return pickOf(PLACES, bytes);
            case 'iban': return value.replace(/^([A-Z]{2})(.*)$/, (_all, country, rest) => `${country}${characters(rest, bytes).toUpperCase()}`);
            case 'phone':
            case 'postal':
            case 'number': return digits(value, bytes);
            default: return characters(value, bytes);
        }
    };
    const walk = (value, key) => {
        if (typeof value === 'string') return string(key, value);
        if (Array.isArray(value)) return value.map((item) => walk(item, key));
        if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([inner, item]) => [inner, walk(item, inner)]));
        return value;
    };
    return (body) => walk(body, '');
};

/**
 * Runs the configured anonymizing command: JSON on stdin `{ version, keep, answers: [{ name, body }] }`, JSON on stdout
 * `{ answers: [{ body }] }` in the same order. No shell; the command runs in the project folder.
 * @returns the bodies; throws a CawError the chat shows
 */
export const runAnonymizer = ({ command, root, keep = [], answers, timeoutMs = COMMAND_TIMEOUT_MS, spawnFn = spawn }) => new Promise((resolve, reject) => {
    const fail = (reason) => reject(new CawError('anonymize-failed', t('run.fixed.commandFailed', { command: command.join(' '), reason })));
    let child;
    try {
        child = spawnFn(command[0], command.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
        fail(String(error?.message ?? error));
        return;
    }
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
        child.kill();
        fail(t('run.fixed.commandTimeout', { seconds: Math.round(timeoutMs / 1000) }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
        clearTimeout(timer);
        fail(String(error?.message ?? error));
    });
    child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
            fail(t('run.fixed.commandExit', { code, stderr: Buffer.concat(err).toString('utf8').trim().split('\n')[0] ?? '' }));
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(Buffer.concat(out).toString('utf8'));
        } catch {
            fail(t('run.fixed.commandNoJson'));
            return;
        }
        if (!Array.isArray(parsed?.answers) || parsed.answers.length !== answers.length || !parsed.answers.every((entry) => entry !== null && typeof entry === 'object' && 'body' in entry)) {
            fail(t('run.fixed.commandAnswers', { count: answers.length }));
            return;
        }
        resolve(parsed.answers.map(({ body }) => body));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ version: FIXED_VERSION, keep, answers: answers.map(({ name, body }) => ({ name, body })) }));
});

/**
 * The answers as they would be stored and served: anonymized (the config's command, else caw's own), or as they are
 * (obfuscated and plain store them unchanged, only the file differs). An anonymizer that changes an answer's shape is refused:
 * the look would then be compared on data the backend never sends, and every run would call it outdated.
 * @param anonymize the config's `anonymize` ({ command?, keep? })
 * @returns { answers, by: 'command'|'built-in'|undefined }
 */
export const prepareAnswers = async ({ mode, answers, anonymize = {}, root, run = runAnonymizer, anonymizer = createAnonymizer }) => {
    if (mode !== 'anonymized') return { answers };
    const keep = anonymize.keep ?? [];
    const command = anonymize.command;
    const bodies = command === undefined ? answers.map(({ body }) => body).map(anonymizer({ keep })) : await run({ command, root, keep, answers });
    const changed = answers.findIndex(({ body }, index) => shapeChanges(shapeOf(body), shapeOf(bodies[index])).length > 0 || shapeChanges(shapeOf(bodies[index]), shapeOf(body)).length > 0);
    if (changed !== -1) throw new CawError('anonymize-shape', t('run.fixed.shapeChanged', { name: answers[changed].name }));
    return { answers: answers.map((answer, index) => ({ ...answer, body: bodies[index] })), by: command === undefined ? 'built-in' : 'command' };
};

// -------------------------------------------------------------------------------------------------------------- obfuscation

const OBFUSCATED = 'caw-obfuscated-1:';
// A fixed key: obfuscation only keeps the data from being read by accident (a diff, a search). It is no protection.
const KEY = createHash('sha512').update('caw fixed data, not protection').digest();
const xor = (bytes) => {
    const out = Buffer.allocUnsafe(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) out[index] = bytes[index] ^ KEY[index % KEY.length];
    return out;
};
/** A JSON value as text a person does not read by accident; deobfuscate turns it back. */
export const obfuscate = (value) => `${OBFUSCATED}${xor(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64')}`;
export const deobfuscate = (text) => {
    if (typeof text !== 'string' || !text.startsWith(OBFUSCATED)) throw new Error('not obfuscated');
    return JSON.parse(xor(Buffer.from(text.slice(OBFUSCATED.length), 'base64')).toString('utf8'));
};

// ----------------------------------------------------------------------------------------------------------------- storage

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The file's text: one answer per entry, the body as JSON (anonymized, plain) or as obfuscated text. */
export const fixedDataText = ({ test, mode, by, frozen, steps, answers }) => `${JSON.stringify({
    version: FIXED_VERSION,
    test,
    mode,
    ...(by === undefined ? {} : { by }),
    frozen,
    steps,
    answers: answers.map(({ step, name, key, status, type, body }) => ({ step, name, key, status, type, ...(mode === 'obfuscated' ? { data: obfuscate(body) } : { body }) })),
}, null, 2)}\n`;

/**
 * Reads the file's text.
 * @returns { mode, by?, frozen, steps, answers: [{ step, name, key, status, type, body }] }; throws on anything else
 */
export const parseFixedData = (text) => {
    const raw = JSON.parse(text);
    const ok = isObject(raw) && raw.version === FIXED_VERSION && FIXED_MODES.includes(raw.mode) && Array.isArray(raw.steps) && raw.steps.every((id) => typeof id === 'string')
        && Array.isArray(raw.answers) && raw.answers.every((entry) => isObject(entry) && typeof entry.name === 'string' && typeof entry.key === 'string'
            && typeof entry.step === 'string' && Number.isInteger(entry.status) && (raw.mode === 'obfuscated' ? typeof entry.data === 'string' : 'body' in entry));
    if (!ok) throw new Error('invalid');
    return {
        mode: raw.mode,
        ...(typeof raw.by === 'string' ? { by: raw.by } : {}),
        frozen: raw.frozen,
        steps: raw.steps,
        answers: raw.answers.map(({ step, name, key, status, type, body, data }) => ({ step, name, key, status, type: typeof type === 'string' ? type : 'application/json', body: raw.mode === 'obfuscated' ? deobfuscate(data) : body })),
    };
};

/**
 * A test's frozen data.
 * @returns null without a file, { data, hash } when readable, { broken: file } when not
 */
export const readFixedData = (root, test) => {
    const file = fixedDataFile(test);
    const path = join(root, file);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    try {
        return { data: parseFixedData(text), hash: fixedHash(text) };
    } catch {
        return { broken: file };
    }
};

/** Writes a test's frozen data. @returns the file relative to the project */
export const writeFixedData = (root, data) => {
    const file = fixedDataFile(data.test);
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), fixedDataText(data));
    return file;
};

/** Removes a test's frozen data, e.g. when a person discards it by hand. @returns whether there was any */
export const removeFixedData = (root, test) => {
    const path = join(root, fixedDataFile(test));
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
};

/**
 * The test with its frozen look steps marked in their recordings (`fixed: { mode, frozen }`); a step frozen before but not now
 * loses its mark. Audit lists both.
 */
export const withFixedData = (spec, steps, { mode, frozen }) => ({
    ...spec,
    steps: spec.steps.map((step) => {
        if (step.recording === undefined) return step;
        if (steps.includes(step.id)) return { ...step, recording: { ...step.recording, fixed: { mode, frozen } } };
        if (step.recording.fixed === undefined) return step;
        const recording = { ...step.recording };
        delete recording.fixed;
        return { ...step, recording };
    }),
});

/** The look steps of a test that are compared on frozen data: `look: true` and marked in the recording. */
export const fixedSteps = (spec) => spec.steps.filter((step) => step.look === true && step.recording?.fixed !== undefined).map(({ id }) => id);

/**
 * The request of a paused Fetch event as far as isRead reads it, with Playwright's Request methods: header names in lower case
 * (as Playwright gives them), the body also when Chrome only hands it over as entries.
 */
const pausedRequest = ({ request, resourceType }) => {
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const entries = request.postDataEntries ?? [];
    const postData = request.postData ?? (entries.length === 0 ? null : Buffer.concat(entries.map(({ bytes = '' }) => Buffer.from(bytes, 'base64'))).toString('utf8'));
    return {
        method: () => request.method,
        url: () => request.url,
        resourceType: () => String(resourceType ?? '').toLowerCase(),
        headers: () => headers,
        postData: () => postData,
    };
};

/**
 * Serves frozen answers in a browser context: a read that has one gets it, everything else passes untouched. The real request
 * still goes out, through Chrome: each page's xhr and fetch requests are paused at the response stage (CDP Fetch, beside
 * Playwright's own routes, which act at the request stage: the host lock and the write block abort first), the real answer is
 * read there and goes to onAnswer for the shape comparison, then the frozen answer replaces it. Not route.fetch: that request
 * runs in Node and bypasses Chrome's resolver rules (the host lock pins *.localhost and blocks production hosts there), its proxy
 * setting and the sandbox's view, so it could reach another server than the app or none at all.
 * Covers the context's pages and popups (a new page's xhr and fetch wait until its session is attached); not requests of
 * out-of-process iframes or workers, which have their own targets. Used by the headless look pass, never with the workbench.
 * @param isRead   (request) => { name, key } for a read that may be served, else null; request has Playwright's method(), url(),
 *                 resourceType(), headers(), postData()
 * @param onAnswer ({ answer, real: { status, json } }) after a frozen answer was served
 * @returns stop(): the frozen answers end
 */
export const serveAnswers = async (context, { book, isRead, onAnswer = () => {} }) => {
    const sessions = new Set();
    let stopped = false;
    const patterns = ['XHR', 'Fetch'].flatMap((resourceType) => ['http://*', 'https://*'].map((urlPattern) => ({ urlPattern, resourceType, requestStage: 'Response' })));
    const serve = async (cdp, event) => {
        const { requestId, responseStatusCode: status = 0, responseHeaders = [] } = event;
        const pass = () => cdp.send('Fetch.continueResponse', { requestId }).catch(() => cdp.send('Fetch.continueRequest', { requestId })).catch(() => {});
        // A redirect is followed by the browser; its target pauses again and is served there.
        const redirect = status >= 300 && status < 400 && responseHeaders.some(({ name }) => name.toLowerCase() === 'location');
        const read = stopped || redirect ? null : isRead(pausedRequest(event));
        const answer = read === null ? null : book.take(read);
        if (answer === null) {
            await pass();
            return;
        }
        let real = { status: 0, json: undefined };
        if (event.responseErrorReason === undefined) {
            const type = responseHeaders.find(({ name }) => name.toLowerCase() === 'content-type')?.value;
            let json;
            if (isJsonType(type)) {
                try {
                    const { body, base64Encoded } = await cdp.send('Fetch.getResponseBody', { requestId });
                    json = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
                } catch {
                    json = undefined;
                }
            }
            real = { status, json };
        }
        onAnswer({ answer, real });
        await cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: answer.status,
            responseHeaders: [{ name: 'Content-Type', value: answer.type }, { name: 'Cache-Control', value: 'no-store' }],
            body: Buffer.from(JSON.stringify(answer.body)).toString('base64'),
        }).catch(pass);
    };
    const attached = new WeakMap();
    const attach = (page) => {
        if (!attached.has(page)) {
            attached.set(page, (async () => {
                const cdp = await context.newCDPSession(page).catch(() => null);
                if (cdp === null) return;
                sessions.add(cdp);
                cdp.on('Fetch.requestPaused', (event) => { serve(cdp, event).catch(() => {}); });
                await cdp.send('Fetch.enable', { patterns }).catch(() => sessions.delete(cdp));
            })());
        }
        return attached.get(page);
    };
    // A new page (a popup) may ask before its session is attached: its xhr and fetch wait at the request stage until then.
    const matches = (url) => /^https?:$/.test(url.protocol);
    const pageOf = (request) => {
        try {
            return request.frame().page();
        } catch {
            return null;
        }
    };
    const gate = async (route) => {
        const request = route.request();
        const page = !stopped && ['xhr', 'fetch'].includes(request.resourceType()) ? pageOf(request) : null;
        if (page !== null) await attach(page);
        await route.fallback().catch(() => {});
    };
    await Promise.all(context.pages().map(attach));
    context.on('page', attach);
    await context.route(matches, gate);
    return async () => {
        stopped = true;
        context.off('page', attach);
        await context.unroute(matches, gate).catch(() => {});
        await Promise.all([...sessions].map((cdp) => cdp.send('Fetch.disable').catch(() => {}).then(() => cdp.detach()).catch(() => {})));
        sessions.clear();
    };
};

const MAX_PREVIEW = 12;
const PREVIEW_CHARS = 240;
/** The answers as the chat shows them for review: step, request name and the start of the body. */
export const previewLines = (answers, { max = MAX_PREVIEW, width = PREVIEW_CHARS } = {}) => {
    const lines = answers.slice(0, max).map(({ step, name, body }) => {
        const text = JSON.stringify(body);
        return `${step} · ${name}: ${text.length > width ? `${text.slice(0, width)}…` : text}`;
    });
    return answers.length > max ? [...lines, t('run.fixed.previewMore', { count: answers.length - max })] : lines;
};
