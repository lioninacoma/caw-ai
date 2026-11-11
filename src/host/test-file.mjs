// Zwei Dateien je Test: Die Beschreibung (caw/tests/<id>.yaml) pflegt der Mensch, die Aufzeichnung (caw/recordings/<id>.yaml)
// das Tool. Verbunden sind sie ueber die Schritt-ID und den Hash aus dem Text des Schritts; passt er nicht, ist die Aufzeichnung
// des Schritts veraltet. Im Speicher ist der Test eine Einheit; als eine Datei steht er nur im Entwurf eines Laufs. Nur auf dem
// Host: Die Sandbox hat das Paket yaml nicht und liest ihren Plan als Text.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Document, LineCounter, isMap, parseDocument } from 'yaml';

import { allTargets, authOf, isLoopback, isServerUrl, resolveTarget } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, RECORDING_DIR, TEST_DIR } from '../shared/names.mjs';
import { didYouMean } from '../shared/suggest.mjs';
import { EFFECT_LISTS } from './effects.mjs';
import { TARGET_TEXT_MAX } from './framework/web.mjs';
import { isPattern } from './patterns.mjs';

export { RECORDING_DIR, TEST_DIR } from '../shared/names.mjs';
const RECORDING_TOP_FIELDS = ['test', 'steps', 'knownMessages'];
const STEP_ID = /^S[1-9]\d*$/;
const TOP_FIELDS = ['id', 'app', 'role', 'targets', 'mutates', 'also', 'notes', 'steps', 'knownMessages'];
const PLAN_STEP_FIELDS = ['id', 'name', 'do', 'expect', 'note', 'retry'];
const RETRY_FIELDS = ['times', 'waitMs', 'from'];
const MAX_RETRY_TIMES = 10;
const MAX_RETRY_WAIT_MS = 300_000;
const STEP_FIELDS = [...PLAN_STEP_FIELDS, 'recording'];
const RECORDING_FIELDS = ['hash', 'after', 'recordedOn', 'recordedAt', 'actions', 'check', 'timeoutMs', 'network', 'effects'];
const EFFECT_FIELDS = new Set(['action', ...EFFECT_LISTS]);

/** Die gelernte Wirkung je Aktion: wie oft gelernt, und je Aktionsnummer Listen von Zeilen ohne Werte. */
const checkEffects = (raw, at, report) => {
    const ok = isObject(raw) && Object.keys(raw).every((key) => key === 'runs' || key === 'actions' || key === 'basis')
        && (raw.basis === undefined || isText(raw.basis)) && Number.isInteger(raw.runs) && raw.runs > 0 && Array.isArray(raw.actions)
        && raw.actions.every((entry) => isObject(entry) && Object.keys(entry).every((key) => EFFECT_FIELDS.has(key))
            && Number.isInteger(entry.action) && entry.action > 0
            && EFFECT_LISTS.every((list) => entry[list] === undefined || (Array.isArray(entry[list]) && entry[list].every(isText))));
    if (!ok) report(at, t('config.test.effects'));
};
const NETWORK_FIELDS = new Set(['name', 'status', 'ms', 'count', 'params']);

/** Die Requests eines Schritts bei der Aufnahme, der Vergleich fuer einen spaeteren Fehler. */
const checkNetwork = (raw, at, report) => {
    if (!Array.isArray(raw)) {
        report(at, t('config.test.network.list'));
        return;
    }
    raw.forEach((entry, index) => {
        const ok = isObject(entry) && Object.keys(entry).every((key) => NETWORK_FIELDS.has(key)) && isText(entry.name)
            && (Number.isInteger(entry.status) || isText(entry.status)) && Number.isFinite(entry.ms) && entry.ms >= 0
            && (entry.count === undefined || (Number.isInteger(entry.count) && entry.count > 0))
            && (entry.params === undefined || (Array.isArray(entry.params) && entry.params.every(isText)));
        if (!ok) report([...at, index], t('config.test.network.entry'));
    });
};
const TARGET_KEY = /^[A-Za-z]+$/;
const TARGETED = ['click', 'fill', 'type', 'upload', 'download'];
const TEXT_ACTIONS = { press: 'key', goto: 'url', screenshot: 'name' };
const ACTION_NAMES = [...TARGETED, ...Object.keys(TEXT_ACTIONS), 'reload', 'wait-ready', 'remember'];
// Felder neben dem Ziel: was einzugeben, hochzuladen oder als Dateiname eines Downloads zu erwarten ist.
// optional: ein Klick, der nur zaehlt, wenn sein Ziel da ist (etwa ein Cookie-Banner, der nur beim ersten Besuch kommt).
const ACTION_EXTRAS = { click: ['optional'], fill: ['value'], type: ['value'], upload: ['files'], download: ['file'], goto: ['denied'] };
// Namen, die das Tool am Element liest; laengere liest es als leer, ein solches Ziel trifft nie.
const TEXT_LIMITED = ['name', 'own'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Der Vorschlag zu einem unbekannten Feld als Zusatz, etwa " Meintest du targets?", sonst leer. */
const hintFor = (key, allowed) => {
    const name = didYouMean(key, allowed);
    return name === undefined ? '' : t('config.test.didYouMean', { name });
};
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const clean = (text) => (text ?? '').replaceAll('\r\n', '\n').trim();

/** Schaltet alles ab, was YAML ausser Daten kann: Der Inhalt laeuft teils in der angemeldeten Seite. */
const readYaml = (rawText) => {
    const text = rawText.replaceAll('\r\n', '\n');
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, schema: 'core', merge: false, uniqueKeys: true, prettyErrors: true, version: '1.2' });
    const problems = [...doc.errors, ...doc.warnings].map((item) => t('config.test.line', { line: item.linePos?.[0]?.line ?? '?', message: item.message.split('\n')[0] }));
    let value = null;
    if (problems.length === 0) {
        try {
            value = doc.toJS({ maxAliasCount: 0 });
        } catch {
            problems.push(t('config.test.aliases'));
        }
    }
    /** Die Zeile eines Felds. Fehlt es, zaehlt die des naechsten vorhandenen Elternteils. */
    const lineOf = (path) => {
        for (let depth = path.length; depth > 0; depth -= 1) {
            const node = doc.getIn(path.slice(0, depth), true);
            if (node?.range !== undefined && node.range !== null) return lineCounter.linePos(node.range[0]).line;
        }
        return 1;
    };
    return { value, problems, lineOf };
};

/**
 * Ein Ziel: einfache Werte oder ein Muster `{pattern}`, dazu hoechstens das umgebende Bauteil unter `inside` und, in einem iframe,
 * das iframe-Element unter `frame` (selbst ein Ziel, bei verschachtelten Frames wieder mit `frame`).
 */
const isTarget = (value) => isObject(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => TARGET_KEY.test(key)
    && (key === 'frame' ? isTarget(item) : ['string', 'number', 'boolean'].includes(typeof item) || isPattern(item) || (key === 'inside' && isTarget(item))));

/** Ein Name ueber der Grenze, auch im Bereich darum: Er ist auf der Seite leer, das Ziel traefe nie. */
const namesOf = (target) => (isObject(target) ? [...TEXT_LIMITED.map((key) => target[key]), ...namesOf(target.inside), ...namesOf(target.frame)] : []);
const tooLong = (target) => namesOf(target).find((text) => typeof text === 'string' && text.replace(/\s+/g, ' ').trim().length > TARGET_TEXT_MAX);

/** Dateien fuer upload: relativ zum caw-Ordner, nie absolut und nie darueber hinaus. */
const isFileList = (value) => Array.isArray(value) && value.length > 0 && value.every((file) => isText(file)
    && !/^([A-Za-z]:)?[\\/]/.test(file) && !file.split(/[\\/]/).includes('..'));

const isRegExp = (value) => isText(value) && isPattern({ pattern: value });

const readAction = (raw, report) => {
    if (!isObject(raw)) {
        report(t('config.test.action.object'));
        return null;
    }
    const names = Object.keys(raw).filter((key) => ACTION_NAMES.includes(key));
    if (names.length !== 1) {
        report(t('config.test.action.one', { names: ACTION_NAMES.join(', ') }));
        return null;
    }
    const [name] = names;
    const payload = raw[name];
    const extras = { ...(raw.path === undefined ? {} : { path: raw.path }), ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }) };
    const allowed = new Set([name, 'path', 'timeoutMs', ...(ACTION_EXTRAS[name] ?? [])]);
    const foreign = Object.keys(raw).find((key) => !allowed.has(key));
    if (foreign !== undefined) report(t('config.test.action.unknownField', { name, field: foreign, hint: hintFor(foreign, [...allowed]) }));
    if (raw.path !== undefined && typeof raw.path !== 'string') report(t('config.test.action.path', { name }));
    if (raw.timeoutMs !== undefined && !(Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0)) report(t('config.test.action.timeout', { name }));

    if (TARGETED.includes(name)) {
        if (!isTarget(payload)) report(t('config.test.action.target', { name }));
        const long = tooLong(payload);
        if (long !== undefined) report(t('config.test.action.nameTooLong', { name, max: TARGET_TEXT_MAX, start: long.slice(0, 30) }));
        if (['fill', 'type'].includes(name) && typeof raw.value !== 'string') report(t('config.test.action.value', { name }));
        if (name === 'upload' && !isFileList(raw.files)) report(t('config.test.action.files'));
        if (name === 'download' && !isRegExp(raw.file)) report(t('config.test.action.file'));
        if (raw.optional !== undefined && raw.optional !== true) report(t('config.test.action.optional'));
        return {
            action: name,
            target: payload,
            ...extras,
            ...(raw.value === undefined ? {} : { value: raw.value }),
            ...(raw.files === undefined ? {} : { files: raw.files }),
            ...(raw.file === undefined ? {} : { file: raw.file }),
            ...(raw.optional === true ? { optional: true } : {}),
        };
    }
    if (TEXT_ACTIONS[name] !== undefined) {
        if (!isText(payload)) report(t('config.test.action.text', { name }));
        if (raw.denied !== undefined && raw.denied !== true) report(t('config.test.action.denied'));
        return { action: name, [TEXT_ACTIONS[name]]: payload, ...extras, ...(raw.denied === undefined ? {} : { denied: true }) };
    }
    if (name === 'remember') {
        const fields = isObject(payload) && Object.keys(payload).every((key) => ['name', 'code', 'secret'].includes(key));
        if (!fields || !isText(payload.name) || !isText(payload.code) || (payload.secret !== undefined && payload.secret !== true)) report(t('config.test.action.remember'));
        return { action: name, name: payload?.name, code: payload?.code, ...(payload?.secret === true ? { secret: true } : {}), ...extras };
    }
    if (name === 'wait-ready') {
        const options = payload ?? {};
        if (!isObject(options) || Object.keys(options).some((key) => !['store', 'minCount'].includes(key))) report(t('config.test.action.waitReady'));
        return { action: name, ...options, ...extras };
    }
    if (payload !== null && !(isObject(payload) && Object.keys(payload).length === 0)) report(t('config.test.action.reload'));
    return { action: name, ...extras };
};

const writeAction = ({ action, target, key, url, name, code, secret, store, minCount, value, files, file, denied, path, timeoutMs, optional }) => {
    let payload = {};
    if (TARGETED.includes(action)) payload = target;
    else if (action === 'press') payload = key;
    else if (action === 'goto') payload = url;
    else if (action === 'screenshot') payload = name;
    else if (action === 'remember') payload = { name, code, ...(secret === true ? { secret } : {}) };
    else if (action === 'wait-ready') payload = { ...(store === undefined ? {} : { store }), ...(minCount === undefined ? {} : { minCount }) };
    return {
        [action]: payload,
        ...(value === undefined ? {} : { value }),
        ...(files === undefined ? {} : { files }),
        ...(file === undefined ? {} : { file }),
        ...(denied === undefined ? {} : { denied }),
        ...(optional === true ? { optional } : {}),
        ...(path === undefined ? {} : { path }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
};

const readRecording = (raw, at, problems, lineOf) => {
    const report = (path, message) => problems.push(t('config.test.line', { line: lineOf(path), message }));
    if (!isObject(raw)) {
        report(at, t('config.test.recording.object'));
        return undefined;
    }
    for (const key of Object.keys(raw)) if (!RECORDING_FIELDS.includes(key)) report([...at, key], t('config.test.recording.unknown', { key, hint: hintFor(key, RECORDING_FIELDS) }));
    for (const key of ['hash', 'recordedOn', 'recordedAt', 'check']) if (!isText(raw[key])) report([...at, key], t('config.test.recording.missing', { key }));
    if (raw.after !== undefined && !STEP_ID.test(String(raw.after))) report([...at, 'after'], t('config.test.recording.after'));
    if (raw.timeoutMs !== undefined && !(Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0)) report([...at, 'timeoutMs'], t('config.test.recording.timeout'));
    if (raw.network !== undefined) checkNetwork(raw.network, [...at, 'network'], report);
    if (raw.effects !== undefined) checkEffects(raw.effects, [...at, 'effects'], report);
    if (!Array.isArray(raw.actions)) {
        report([...at, 'actions'], t('config.test.recording.actions'));
        return undefined;
    }
    const actions = raw.actions.map((action, index) => readAction(action, (message) => report([...at, 'actions', index], message)));
    return { ...raw, actions };
};

const checkRetry = (raw, at, report) => {
    if (!isObject(raw)) {
        report(at, t('config.test.retry.object'));
        return;
    }
    for (const key of Object.keys(raw)) if (!RETRY_FIELDS.includes(key)) report([...at, key], t('config.test.retry.unknown', { key, hint: hintFor(key, RETRY_FIELDS) }));
    if (!Number.isInteger(raw.times) || raw.times < 1 || raw.times > MAX_RETRY_TIMES) report([...at, 'times'], t('config.test.retry.times', { max: MAX_RETRY_TIMES }));
    if (raw.waitMs !== undefined && !(Number.isFinite(raw.waitMs) && raw.waitMs >= 0 && raw.waitMs <= MAX_RETRY_WAIT_MS)) report([...at, 'waitMs'], t('config.test.retry.wait', { max: MAX_RETRY_WAIT_MS }));
    if (raw.from !== undefined && !(typeof raw.from === 'string' && STEP_ID.test(raw.from))) report([...at, 'from'], t('config.test.retry.from'));
};

/**
 * Ein neuer Versuch beginnt bei diesem oder einem frueheren Schritt. Beim Beheben kennt der Plan nur einen Schritt, deshalb steht das
 * nicht in der Formpruefung des Plans.
 * @returns die Probleme als Text
 */
export const retryProblems = (steps) => steps.flatMap(({ id, retry }, position) => {
    if (retry?.from === undefined || steps.slice(0, position + 1).some((step) => step.id === retry.from)) return [];
    return [t('config.test.retry.order', { id: String(id), from: retry.from })];
});

/** Prueft die Schritte. Plan und Testdatei teilen das, nur die Aufzeichnung bleibt der Testdatei vorbehalten. */
const readSteps = (raw, problems, lineOf, { allowRecording, description = false }) => {
    const report = (path, message) => problems.push(t('config.test.line', { line: lineOf(path), message }));
    if (!Array.isArray(raw) || raw.length === 0) {
        report(['steps'], t('config.test.steps.list'));
        return [];
    }
    const seen = new Set();
    return raw.map((step, index) => {
        const at = ['steps', index];
        if (!isObject(step)) {
            report(at, t('config.test.step.object'));
            return {};
        }
        for (const key of Object.keys(step)) {
            if (!STEP_FIELDS.includes(key)) report([...at, key], t('config.test.step.unknown', { key, hint: hintFor(key, STEP_FIELDS) }));
        }
        if (typeof step.id !== 'string' || !STEP_ID.test(step.id)) report([...at, 'id'], t('config.test.step.id'));
        else if (seen.has(step.id)) report([...at, 'id'], t('config.test.duplicate', { id: step.id }));
        else seen.add(step.id);
        if (!isText(step.name)) report([...at, 'name'], t('config.test.missing', { key: 'name' }));
        else if (step.name.includes('\n')) report([...at, 'name'], t('config.test.step.nameLine'));
        if (step.do !== undefined && step.do !== null && typeof step.do !== 'string') report([...at, 'do'], t('config.test.text', { key: 'do' }));
        if (!Object.hasOwn(step, 'do')) report(at, t('config.test.step.do'));
        if (!isText(step.expect)) report([...at, 'expect'], t('config.test.missing', { key: 'expect' }));
        if (step.note !== undefined && typeof step.note !== 'string') report([...at, 'note'], t('config.test.text', { key: 'note' }));
        if (step.retry !== undefined) checkRetry(step.retry, [...at, 'retry'], report);
        if (description && step.recording !== undefined) report([...at, 'recording'], t('config.test.recordingOnly', { key: 'recording' }));
        const plain = {
            id: step.id,
            name: clean(step.name),
            do: clean(step.do),
            expect: clean(step.expect),
            ...(step.note === undefined ? {} : { note: clean(step.note) }),
            ...(step.retry === undefined ? {} : { retry: step.retry }),
        };
        // Im Plan zaehlt eine Aufzeichnung nicht: Nur das Tool schreibt sie.
        if (!allowRecording || step.recording === undefined) return plain;
        const recording = readRecording(step.recording, [...at, 'recording'], problems, lineOf);
        return recording === undefined ? plain : { ...plain, recording };
    });
};

const invalid = (label, problems) => new CawError('test-invalid', problems.map((problem) => `${label}: ${problem}`).join('\n'));

/** Die Punkte, an denen Urteil und Bericht gemessen werden: je Schritt genau einer. */
export const withExpectations = (spec) => ({ ...spec, expectations: spec.steps.map(({ id, expect }) => ({ id, text: expect })) });

/**
 * Liest eine Testdatei und prueft ihre Form samt Zeilenangabe; alles vom Ziel Abhaengige macht `checkTest`.
 * @param description die Beschreibung in caw/tests: ohne Aufzeichnung und knownMessages, die stehen in caw/recordings. Sonst der
 *                    Entwurf eines Laufs, eine Datei mit beidem.
 */
export const parseTest = (text, label = t('config.test.label'), { description = false } = {}) => {
    const { value, problems, lineOf } = readYaml(text);
    if (problems.length > 0) throw invalid(label, problems);
    const report = (path, message) => problems.push(t('config.test.line', { line: lineOf(path), message }));
    if (!isObject(value)) throw invalid(label, [t('config.test.file.object')]);
    for (const key of Object.keys(value)) if (!TOP_FIELDS.includes(key)) report([key], t('config.test.unknown', { key, hint: hintFor(key, TOP_FIELDS) }));
    // id, app, role und targets duerfen fehlen: Die Vorgaben kommen aus Dateiname und Config (withDefaults).
    for (const key of ['id', 'app', 'role']) if (value[key] !== undefined && !isText(value[key])) report([key], t('config.test.text', { key }));
    if (value.targets !== undefined && (!Array.isArray(value.targets) || value.targets.length === 0 || !value.targets.every(isText))) report(['targets'], t('config.test.targets'));
    if (typeof value.mutates !== 'boolean') report(['mutates'], t('config.test.mutates'));
    if (value.also !== undefined && (!Array.isArray(value.also) || !value.also.every(isText))) report(['also'], t('config.test.also'));
    if (value.notes !== undefined && value.notes !== null && typeof value.notes !== 'string') report(['notes'], t('config.test.text', { key: 'notes' }));
    if (description && value.knownMessages !== undefined) report(['knownMessages'], t('config.test.recordingOnly', { key: 'knownMessages' }));
    else if (!knownMessagesOk(value.knownMessages)) report(['knownMessages'], t('config.test.knownMessages'));
    const steps = readSteps(value.steps, problems, lineOf, { allowRecording: !description, description });
    if (problems.length === 0) problems.push(...retryProblems(steps));
    if (problems.length > 0) throw invalid(label, problems);
    return withExpectations({
        ...(value.id === undefined ? {} : { id: value.id }),
        ...(value.app === undefined ? {} : { app: value.app }),
        ...(value.role === undefined ? {} : { role: value.role }),
        ...(value.targets === undefined ? {} : { targets: value.targets }),
        mutates: value.mutates,
        also: value.also ?? [],
        notes: clean(value.notes),
        steps,
        ...(value.knownMessages === undefined ? {} : { knownMessages: value.knownMessages }),
    });
};

/**
 * Liest den Plan des Agenten: nur `notes` und `steps`. Metadaten und Aufzeichnungen, die er trotzdem mitschickt, fallen weg,
 * denn Rolle, Ziele und Schreibrecht bleiben beim Menschen.
 */
export const parsePlan = (text) => {
    const { value, problems, lineOf } = readYaml(text);
    if (problems.length === 0 && !isObject(value)) problems.push(t('config.test.plan.object'));
    if (problems.length > 0) return { problems };
    if (value.notes !== undefined && value.notes !== null && typeof value.notes !== 'string') problems.push(t('config.test.line', { line: lineOf(['notes']), message: t('config.test.text', { key: 'notes' }) }));
    const steps = readSteps(value.steps, problems, lineOf, { allowRecording: false });
    return problems.length > 0 ? { problems } : { problems, plan: { notes: clean(value.notes), steps } };
};

export const testPath = (root, id) => join(root, TEST_DIR, `${id}.yaml`);
export const recordingPath = (root, id) => join(root, RECORDING_DIR, `${id}.yaml`);

// Eine bekannte Meldung ist ein fester Text oder ein Muster `{pattern}`, etwa fuer einen Dialog mit Pruefsumme oder Uhrzeit.
const knownMessagesOk = (value) => value === undefined || (Array.isArray(value) && value.every((message) => typeof message === 'string' || isPattern(message)));

/**
 * Liest eine Aufzeichnungsdatei: `test`, je Schritt `id` plus die Felder der Aufzeichnung, dazu `knownMessages`.
 * @returns { test, byId: Map Schritt -> recording, knownMessages? }
 */
export const parseRecordings = (text, label = t('config.test.recordings.label')) => {
    const { value, problems, lineOf } = readYaml(text);
    if (problems.length > 0) throw invalid(label, problems);
    if (!isObject(value) || !isText(value.test) || !Array.isArray(value.steps)) throw invalid(label, [t('config.test.recordings.object')]);
    const report = (path, message) => problems.push(t('config.test.line', { line: lineOf(path), message }));
    for (const key of Object.keys(value)) if (!RECORDING_TOP_FIELDS.includes(key)) report([key], t('config.test.unknown', { key }));
    if (!knownMessagesOk(value.knownMessages)) report(['knownMessages'], t('config.test.knownMessages'));
    const byId = new Map();
    value.steps.forEach((entry, index) => {
        const at = ['steps', index];
        if (!isObject(entry) || !STEP_ID.test(String(entry.id))) {
            report(at, t('config.test.recordings.stepId'));
            return;
        }
        if (byId.has(entry.id)) report([...at, 'id'], t('config.test.duplicate', { id: entry.id }));
        const { id, ...raw } = entry;
        const recording = readRecording(raw, at, problems, lineOf);
        if (recording !== undefined) byId.set(id, recording);
    });
    if (problems.length > 0) throw invalid(label, problems);
    return { test: value.test, byId, ...(value.knownMessages === undefined ? {} : { knownMessages: value.knownMessages }) };
};

/** Setzt die Aufzeichnung in die Beschreibung ein. Die Datei der Aufzeichnung gewinnt vor einer alten Aufzeichnung in der Beschreibung. */
export const mergeRecordings = (spec, { byId, knownMessages }) => ({
    ...spec,
    steps: spec.steps.map((step) => (byId.has(step.id) ? { ...step, recording: byId.get(step.id) } : step)),
    ...(knownMessages === undefined ? {} : { knownMessages }),
});

const readRecordingFile = (root, id) => {
    const path = recordingPath(root, id);
    if (!existsSync(path)) return null;
    const label = `${RECORDING_DIR}/${id}.yaml`;
    const recordings = parseRecordings(readFileSync(path, 'utf8'), label);
    if (recordings.test !== id) throw new CawError('test-invalid', t('config.test.recordings.otherTest', { label, test: String(recordings.test), id: String(id) }));
    return recordings;
};

export const loadTest = (root, id) => {
    const path = testPath(root, id);
    if (!existsSync(path)) throw new CawError('test-missing', t('config.test.notFound', { path: `${TEST_DIR}/${id}.yaml` }));
    const parsed = parseTest(readFileSync(path, 'utf8'), `${TEST_DIR}/${id}.yaml`, { description: true });
    // Ohne id gilt der Dateiname; eine angegebene muss zu ihm passen.
    if (parsed.id !== undefined && parsed.id !== id) throw new CawError('test-invalid', t('config.test.idMismatch', { path: `${TEST_DIR}/${id}.yaml`, id: String(parsed.id) }));
    const spec = { ...parsed, id };
    const recordings = readRecordingFile(root, id);
    return recordings === null ? spec : mergeRecordings(spec, recordings);
};

/** Der einzige Name in einer Liste der Config, sonst undefined. */
const onlyKey = (map) => {
    const keys = Object.keys(map ?? {});
    return keys.length === 1 ? keys[0] : undefined;
};

/**
 * Was der Test nicht nennt, gibt die Config vor: app und role, wenn es genau eine gibt (role nur mit Anmeldung), targets alle
 * Ziele ausser Produktion. Was dann noch fehlt, meldet checkTest.
 */
export const withDefaults = (spec, config) => {
    const app = spec.app ?? onlyKey(config.apps);
    const role = spec.role ?? (authOf(config).type === 'none' ? undefined : onlyKey(config.roles));
    const targets = spec.targets ?? allTargets(config).filter((target) => !resolveTarget(config, target).production);
    return { ...spec, ...(app === undefined ? {} : { app }), ...(role === undefined ? {} : { role }), targets };
};

/** Die Namen einer Liste der Config fuer Meldungen, etwa "admin, tester". */
const namesIn = (map) => Object.keys(map ?? {}).join(', ') || '–';

/**
 * Hinweise zur Aufzeichnung, die kein Fehler sind: Aufzeichnungen ohne Schritt (geloescht oder umbenannt) und Aufzeichnungsdateien
 * ohne Beschreibung. Beim naechsten Schreiben fallen solche Aufzeichnungen weg.
 */
export const recordingHints = (root) => {
    const dir = join(root, RECORDING_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith('.yaml')).flatMap((name) => {
        const id = name.slice(0, -'.yaml'.length);
        if (!existsSync(testPath(root, id))) return [t('config.test.hint.noDescription', { file: `${RECORDING_DIR}/${name}`, test: `${TEST_DIR}/${name}` })];
        const recordings = readRecordingFile(root, id);
        const steps = new Set(loadTest(root, id).steps.map((step) => step.id));
        return [...recordings.byId.keys()].filter((step) => !steps.has(step)).map((step) => t('config.test.hint.orphan', { file: `${RECORDING_DIR}/${name}`, step }));
    });
};

/**
 * Darf dieser Test auf diesem Ziel laufen? Hier sitzt der Schreibschutz, deterministisch und vor jedem Browser. Dazu, welcher Code
 * laeuft: ohne --overlay immer der ausgelieferte.
 * @param overlay aus --overlay: true, 'build', 'dev', die Adresse eines Dev-Servers oder undefined
 */
export const checkTest = (given, target, config, { overlay } = {}) => {
    const resolved = resolveTarget(config, target);
    const spec = withDefaults(given, config);
    const bad = (message) => new CawError('test-invalid', message);
    const file = `${TEST_DIR}/${spec.id}.yaml`;
    if (!spec.targets.includes(target)) throw bad(t('config.test.check.target', { target: String(target), id: String(spec.id), targets: spec.targets.join(', ') || '–', file }));
    if (spec.app === undefined) throw bad(t('config.test.check.appMissing', { id: String(spec.id), apps: namesIn(config.apps), config: CONFIG_FILE }));
    if (config.apps[spec.app] === undefined) throw bad(t('config.test.check.app', { app: String(spec.app), apps: namesIn(config.apps), config: CONFIG_FILE }));
    if (config.apps[spec.app].startUrl === undefined) throw bad(t('config.test.check.startUrl', { app: String(spec.app) }));
    for (const name of spec.also ?? []) {
        if (config.apps[name] === undefined) throw bad(t('config.test.check.also', { app: String(name), apps: namesIn(config.apps), config: CONFIG_FILE }));
    }
    if (spec.role === undefined && authOf(config).type !== 'none') throw bad(t('config.test.check.role', { id: String(spec.id), type: authOf(config).type, roles: namesIn(config.roles), config: CONFIG_FILE }));
    if (spec.role !== undefined && config.roles?.[spec.role] === undefined) throw bad(t('config.test.check.unknownRole', { role: String(spec.role), roles: namesIn(config.roles), config: CONFIG_FILE }));
    if (spec.mutates && !resolved.writable) {
        throw new CawError('write-protected', t('config.test.check.writeProtected', { id: String(spec.id), target: String(target), environment: resolved.environment }));
    }
    return { ...resolved, mutates: spec.mutates, ...codeFor(spec, resolved, config, overlay) };
};

/**
 * Welcher Code laeuft, an genau einer Stelle: der ausgelieferte, ausser jemand sagt --overlay. Nie still umgeschaltet, auch nicht
 * mit --until, in einer Testdatei oder weil ein Watch laeuft. Geht das Overlay nicht, ist das ein Aufruffehler mit dem Grund.
 * Ein Dev-Server auf dem eigenen Rechner (http auf localhost) liefert den lokalen Code selbst: Dort gibt es nichts zu ueberlagern.
 * @returns { source: 'deployed' } | { source: 'overlay', apps: { <app>: Quelle } }, Quelle siehe overlayChoice
 */
const codeFor = (spec, resolved, config, overlay) => {
    if (overlay === undefined) return { source: 'deployed' };
    const { host, hostname, protocol } = new URL(resolved.url);
    if (protocol === 'http:' && isLoopback(hostname)) throw new CawError('usage', t('config.overlay.devServer', { environment: resolved.environment, host }));
    if (!resolved.overlay) throw new CawError('usage', t('config.overlay.environment', { environment: resolved.environment }));
    const names = [spec.app, ...(spec.also ?? [])];
    const url = isServerUrl(overlay) ? overlay : undefined;
    if (url !== undefined && names.length > 1) throw new CawError('usage', t('config.overlay.urlApps', { apps: names.join(', ') }));
    const apps = {};
    for (const name of names) {
        const choice = overlayChoice(config, name, url ?? overlay, { required: name === spec.app });
        if (choice !== null) apps[name] = choice;
    }
    return { source: 'overlay', apps };
};

/**
 * Die Quelle einer App fuer --overlay:
 * - { kind: 'build', dir, command? }: Build-Ordner relativ zum Projekt
 * - { kind: 'dev', url, command? }: Dev-Server
 * - { kind: 'watch', command? }: Sencha-Watch (ExtJS), Quellen laut bootstrap.json im App-Ordner
 * - { kind: 'files' }: nur overlay.statics
 * Jede mit `statics`. Eine weitere App (also) ohne Quelle bleibt ausgeliefert (null); die App des Tests braucht eine.
 */
export const overlayChoice = (config, name, flag, { required = true } = {}) => {
    const overlay = config.apps[name].overlay ?? {};
    const statics = overlay.statics ?? [];
    const command = (key) => (overlay[key] === undefined ? {} : { command: overlay[key] });
    const url = isServerUrl(flag) ? flag : undefined;
    if (config.framework === 'extjs') {
        if (flag === 'build' || url !== undefined) throw new CawError('usage', t('config.overlay.extjsKind', { kind: url ?? flag }));
        return { kind: 'watch', ...command('devCommand'), statics };
    }
    if (url !== undefined) return { kind: 'dev', url, ...command('devCommand'), statics };
    const build = overlay.build === undefined ? null : { kind: 'build', dir: overlay.build, ...command('buildCommand'), statics };
    const dev = overlay.dev === undefined ? null : { kind: 'dev', url: overlay.dev, ...command('devCommand'), statics };
    if (flag === 'build' || flag === 'dev') {
        const chosen = flag === 'build' ? build : dev;
        if (chosen !== null) return chosen;
        if (!required) return null;
        const other = flag === 'build' ? 'dev' : 'build';
        throw new CawError('usage', t('config.overlay.missing', { kind: flag, app: name, other: overlay[other] === undefined ? '' : t('config.overlay.missingOther', { other }) }));
    }
    if (build !== null && dev !== null) throw new CawError('usage', t('config.overlay.choose', { app: name, build: overlay.build, dev: overlay.dev }));
    const only = build ?? dev ?? (statics.length > 0 ? { kind: 'files', statics } : null);
    if (only === null && required) throw new CawError('usage', t('config.overlay.app', { app: name }));
    return only;
};

/** Nur was den Schritt fachlich ausmacht. Aendert sich das von Hand, ist genau dieser Schritt veraltet. `retry` aendert den Weg nicht. */
export const stepHash = ({ name, do: action, expect, note }) => createHash('sha256')
    .update(JSON.stringify([clean(name), clean(action), clean(expect), clean(note)]))
    .digest('hex')
    .slice(0, 16);

/** Schritte, deren Aufzeichnung fehlt oder nicht mehr zum Text passt. */
export const staleSteps = (spec) => spec.steps.flatMap((step) => {
    if (step.recording === undefined) return [{ id: step.id, why: t('config.test.stale.none') }];
    return step.recording.hash === stepHash(step) ? [] : [{ id: step.id, why: t('config.test.stale.changed') }];
});

/**
 * Baut die Aufzeichnung auf einem Schritt auf, der nicht mehr davorsteht? Ein eingefuegter Schritt stoert nicht, ein geloeschter
 * oder verschobener schon, denn was danach kommt, setzt seinen Zustand voraus.
 * @returns die erste solche Stelle oder null
 */
export const brokenChain = (spec) => {
    const before = new Set();
    for (const step of spec.steps) {
        const after = step.recording?.after;
        if (after !== undefined && !before.has(after)) return t('config.test.chain', { id: String(step.id), after: String(after) });
        before.add(step.id);
    }
    return null;
};

const planFields = ({ id, name, do: action, expect, note, retry }) => ({ id, name, do: action, expect, ...(note === undefined || note === '' ? {} : { note }), ...(retry === undefined ? {} : { retry }) });

const recordingFields = (recording) => ({
    hash: recording.hash,
    ...(recording.after === undefined ? {} : { after: recording.after }),
    recordedOn: recording.recordedOn,
    recordedAt: recording.recordedAt,
    actions: recording.actions.map(writeAction),
    check: recording.check,
    ...(recording.timeoutMs === undefined ? {} : { timeoutMs: recording.timeoutMs }),
    ...(recording.network === undefined ? {} : { network: recording.network }),
    ...(recording.effects === undefined ? {} : { effects: recording.effects }),
});

/** Ziele und Vergleichswerte in einer Zeile: Die Aufzeichnung ist so deutlich kuerzer und liest sich wie eine Liste. */
const compactRecording = (node) => {
    for (const entry of node?.get('network', true)?.items ?? []) entry.flow = true;
    for (const action of node?.get('actions', true)?.items ?? []) {
        for (const pair of action.items) if (isMap(pair.value)) pair.value.flow = true;
    }
};

// Mehrfach genutzte Ziele schreibt yaml sonst als Alias, und den weist parseTest ab.
/** Ein Schritt; mit `withRecording` samt Aufzeichnung wie im Entwurf eines Laufs. */
const stepNode = (doc, step, { withRecording = true } = {}) => {
    const { recording } = step;
    const node = doc.createNode({
        ...planFields(step),
        ...(recording === undefined || !withRecording ? {} : { recording: recordingFields(recording) }),
    }, { aliasDuplicateObjects: false });
    const retry = node.get('retry', true);
    if (retry !== undefined) retry.flow = true;
    compactRecording(node.get('recording', true));
    return node;
};

const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false };

const setSteps = (doc, spec, only, options = {}) => {
    const list = doc.get('steps', true);
    if (list === undefined) {
        const created = doc.createNode([]);
        created.items = spec.steps.map((step) => stepNode(doc, step, options));
        doc.set('steps', created);
        return;
    }
    const known = new Map(list.items.map((item) => [item.get('id'), item]));
    const renew = (step) => {
        const node = stepNode(doc, step, options);
        // Kommentare ueber dem Schritt gehoeren dem Menschen.
        node.commentBefore = known.get(step.id)?.commentBefore;
        return node;
    };
    if (only === undefined) {
        list.items = spec.steps.map(renew);
        return;
    }
    list.items = list.items.map((item) => {
        const step = spec.steps.find(({ id }) => id === item.get('id'));
        return step !== undefined && only.has(step.id) ? renew(step) : item;
    });
    // Ein Schritt, den es in der Datei noch nicht gab, landet an seiner Stelle im Plan.
    spec.steps.forEach((step, position) => {
        if (only.has(step.id) && !known.has(step.id)) list.items.splice(position, 0, renew(step));
    });
};

/** Die Testdatei als Text, wie sie ohne Vorlage aussaehe. */
export const renderTest = (spec) => {
    const doc = new Document({
        id: spec.id,
        app: spec.app,
        role: spec.role,
        targets: spec.targets,
        // Nur wenn ausdruecklich anders als der Standard: Sonst klebte ein Stand am Test, den die Config laengst anders sieht.
        mutates: spec.mutates,
        ...(spec.also?.length > 0 ? { also: spec.also } : {}),
        ...(spec.notes === '' || spec.notes === undefined ? {} : { notes: spec.notes }),
    });
    const targets = doc.get('targets', true);
    if (targets !== undefined) targets.flow = true;
    if (spec.also?.length > 0) doc.get('also', true).flow = true;
    setSteps(doc, spec);
    if (spec.knownMessages !== undefined) doc.set('knownMessages', spec.knownMessages);
    return doc.toString(STRINGIFY);
};

/** Der Plan als YAML, so wie der Agent ihn schreiben wuerde. */
export const renderPlan = (spec) => new Document({
    ...(spec.notes === '' || spec.notes === undefined ? {} : { notes: spec.notes }),
    steps: spec.steps.map(planFields),
}).toString(STRINGIFY);

/** Die Beschreibung als Text, ohne Aufzeichnung. */
export const renderDescription = (spec) => renderTest({ ...spec, steps: spec.steps.map(({ recording, ...step }) => step), knownMessages: undefined });

/** Die Aufzeichnungsdatei als Text: Sie gehoert dem Tool, darum wird sie jedes Mal ganz geschrieben. */
export const renderRecordings = (spec) => {
    const doc = new Document({ test: spec.id });
    doc.commentBefore = ` ${t('config.test.recordingHeader', { file: `${TEST_DIR}/${spec.id}.yaml` })}`;
    const list = doc.createNode([]);
    list.items = spec.steps.filter(({ recording }) => recording !== undefined).map(({ id, recording }) => {
        const node = doc.createNode({ id, ...recordingFields(recording) }, { aliasDuplicateObjects: false });
        compactRecording(node);
        return node;
    });
    doc.set('steps', list);
    if (spec.knownMessages !== undefined) doc.set('knownMessages', spec.knownMessages);
    return doc.toString(STRINGIFY);
};

const sameText = (doc, node, step) => {
    const raw = node.toJS(doc);
    const normalized = { id: raw.id, name: clean(raw.name), do: clean(raw.do), expect: clean(raw.expect), ...(raw.note === undefined ? {} : { note: clean(raw.note) }), ...(raw.retry === undefined ? {} : { retry: raw.retry }) };
    return JSON.stringify(planFields(normalized)) === JSON.stringify(planFields(step));
};

/** Schreibt nur, wenn sich etwas aendert, und behaelt die Zeilenenden der Datei. @returns ob geschrieben wurde */
const writeIfChanged = (path, text, raw) => {
    const final = raw?.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text;
    if (raw === final) return false;
    writeFileSync(path, final);
    return true;
};

/**
 * Schreibt Beschreibung und Aufzeichnung. In der Beschreibung bleiben Kommentare und unberuehrte Schritte, wie sie sind; ein
 * Schritt aus `only` wird nur neu geschrieben, wenn sich sein Text geaendert hat. Lernt das Tool also Vergleichswerte oder
 * Wirkung, aendert sich nur die Aufzeichnung.
 * @param only die Schritte, die sich aendern; ohne Angabe wird der ganze Plan abgeloest
 * @param withNotes auch `notes` schreiben, wenn nur einzelne Schritte sich aendern
 * @returns die geaenderten Dateien relativ zum Projekt, durch Komma getrennt
 */
export const writeTest = (root, spec, only, { withNotes = false } = {}) => {
    const path = testPath(root, spec.id);
    mkdirSync(join(root, TEST_DIR), { recursive: true });
    const changed = [];
    // Was bisher galt: Daraus kommen die Aufzeichnungen der Schritte, die sich nicht aendern.
    const before = existsSync(path) ? loadTest(root, spec.id) : null;
    if (before === null) {
        writeFileSync(path, renderDescription(spec));
        changed.push(`${TEST_DIR}/${spec.id}.yaml`);
    } else {
        const raw = readFileSync(path, 'utf8');
        const doc = parseDocument(raw.replaceAll('\r\n', '\n'), { schema: 'core', merge: false, version: '1.2' });
        const list = doc.get('steps', true);
        const textChanged = only === undefined ? undefined : new Set([...only].filter((id) => {
            const node = list?.items.find((item) => item.get('id') === id);
            const step = spec.steps.find((entry) => entry.id === id);
            return step !== undefined && (node === undefined || !sameText(doc, node, step));
        }));
        setSteps(doc, spec, textChanged, { withRecording: false });
        if (only === undefined || withNotes) {
            if (spec.notes === '' || spec.notes === undefined) doc.delete('notes');
            else doc.set('notes', spec.notes);
        }
        if (writeIfChanged(path, doc.toString(STRINGIFY), raw)) changed.push(`${TEST_DIR}/${spec.id}.yaml`);
    }
    const kept = new Map((before?.steps ?? []).filter(({ recording }) => recording !== undefined).map((step) => [step.id, step.recording]));
    const recorded = {
        id: spec.id,
        steps: spec.steps.map((step) => {
            const recording = only === undefined || only.has(step.id) ? step.recording : kept.get(step.id);
            return recording === undefined ? { id: step.id } : { id: step.id, recording };
        }),
        knownMessages: spec.knownMessages ?? before?.knownMessages,
    };
    const recordingFile = recordingPath(root, spec.id);
    const oldRecordings = existsSync(recordingFile) ? readFileSync(recordingFile, 'utf8') : undefined;
    const empty = recorded.steps.every(({ recording }) => recording === undefined) && recorded.knownMessages === undefined;
    if (empty && oldRecordings === undefined) return changed.length === 0 ? t('config.test.unchanged') : changed.join(', ');
    mkdirSync(join(root, RECORDING_DIR), { recursive: true });
    if (writeIfChanged(recordingFile, renderRecordings(recorded), oldRecordings)) changed.push(`${RECORDING_DIR}/${spec.id}.yaml`);
    return changed.length === 0 ? t('config.test.unchanged') : changed.join(', ');
};
