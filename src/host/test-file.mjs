// Two files per test: the human maintains the description (caw/tests/<id>.yaml), the tool the recording
// (caw/recordings/<id>.yaml). They are linked by step ID and a hash of the step text; if the hash no longer matches, that
// step's recording is stale. In memory a test is one unit; as a single file it only exists in a run's draft. Host only: the
// sandbox has no yaml package and reads its plan as text.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Document, LineCounter, isMap, parseDocument } from 'yaml';

import { OVERLAY_KINDS, isLoopback, isServerUrl, isStartPath, isViewport, loadConfig, overlayEnvironments, overlayParts } from '../shared/config.mjs';
import { effectiveEnvironment, testEnvironments } from '../shared/environments.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, RECORDING_DIR, TEST_DIR } from '../shared/names.mjs';
import { didYouMean } from '../shared/suggest.mjs';
import { renamedDates } from './dates.mjs';
import { EFFECT_LISTS } from './effects.mjs';
import { frameworkOf } from './framework/index.mjs';
import { checkLocator } from './locator.mjs';
import { dialogProblem } from './dialogs.mjs';
import { isPattern } from './patterns.mjs';

export { RECORDING_DIR, TEST_DIR } from '../shared/names.mjs';
const RECORDING_TOP_FIELDS = ['test', 'steps', 'knownMessages'];
const STEP_ID = /^S[1-9]\d*$/;
const TOP_FIELDS = ['id', 'role', 'writes', 'environments', 'start', 'notes', 'steps', 'knownMessages'];
/** Fields from before 1.0: rejected with what replaced them (now) or why they went (why). */
const TEST_REMOVED = { app: { why: 'config.removed.testApp' }, also: { why: 'config.removed.also' }, targets: { now: 'environments' }, mutates: { now: 'writes' } };
const PLAN_STEP_FIELDS = ['id', 'name', 'do', 'expect', 'note', 'retry'];
const RETRY_FIELDS = ['times', 'waitMs', 'from'];
const MAX_RETRY_TIMES = 10;
const MAX_RETRY_WAIT_MS = 300_000;
const STEP_FIELDS = [...PLAN_STEP_FIELDS, 'recording'];
// `locale`, `timezone` and `viewport`: the recording browser's, pinned on replay (the viewport headless, or browser.viewport).
const RECORDING_FIELDS = ['hash', 'after', 'recordedOn', 'recordedAt', 'locale', 'timezone', 'viewport', 'actions', 'check', 'timeoutMs', 'network', 'effects'];
const EFFECT_FIELDS = new Set(['action', ...EFFECT_LISTS]);

/** The learned effects: how many runs they were learned from, and per action number lists of lines without values. */
const checkEffects = (raw, at, report) => {
    const ok = isObject(raw) && Object.keys(raw).every((key) => key === 'runs' || key === 'actions' || key === 'basis')
        && (raw.basis === undefined || isText(raw.basis)) && Number.isInteger(raw.runs) && raw.runs > 0 && Array.isArray(raw.actions)
        && raw.actions.every((entry) => isObject(entry) && Object.keys(entry).every((key) => EFFECT_FIELDS.has(key))
            && Number.isInteger(entry.action) && entry.action > 0
            && EFFECT_LISTS.every((list) => entry[list] === undefined || (Array.isArray(entry[list]) && entry[list].every(isText))));
    if (!ok) report(at, t('config.test.effects'));
};
const NETWORK_FIELDS = new Set(['name', 'status', 'ms', 'count', 'params']);

/** A step's requests at recording time, the baseline for diagnosing a later failure. */
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
const TARGETED = ['click', 'dblclick', 'fill', 'type', 'upload', 'download', 'hover', 'dragTo'];
const TEXT_ACTIONS = { press: 'key', goto: 'url', screenshot: 'name' };
const ACTION_NAMES = [...TARGETED, ...Object.keys(TEXT_ACTIONS), 'reload', 'wait-ready', 'remember'];
// Fields besides the target: what to enter, upload, or expect as a download's file name.
// optional: a click that only counts when its target is present (e.g. a cookie banner shown on the first visit only).
// component, source: React/Vue/Angular dev builds name the component the element belongs to; a hint for diagnosis only.
const HINTS = ['component', 'source'];
// dialog: the decision for a native dialog the action opens (Q11); only on actions that can open one.
// to: where dragTo drops its target, a locator like the target.
const ACTION_EXTRAS = {
    click: ['optional', 'dialog', ...HINTS], dblclick: ['dialog', ...HINTS], fill: ['value', 'dialog', ...HINTS], type: ['value', 'dialog', ...HINTS],
    upload: ['files', 'dialog', ...HINTS], download: ['file', 'dialog', ...HINTS], hover: [...HINTS], dragTo: ['to', ...HINTS],
    press: ['dialog'], goto: ['denied', 'dialog'], reload: ['dialog'],
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A suggestion for an unknown field as a suffix (e.g. " Did you mean targets?"), otherwise empty. */
const hintFor = (key, allowed) => {
    const name = didYouMean(key, allowed);
    return name === undefined ? '' : t('config.test.didYouMean', { name });
};
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const clean = (text) => (text ?? '').replaceAll('\r\n', '\n').trim();

/** Disables everything YAML can do beyond plain data: parts of the content run in the signed-in page. */
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
    /** The line of a field; if it is missing, the line of its nearest existing parent. */
    const lineOf = (path) => {
        for (let depth = path.length; depth > 0; depth -= 1) {
            const node = doc.getIn(path.slice(0, depth), true);
            if (node?.range !== undefined && node.range !== null) return lineCounter.linePos(node.range[0]).line;
        }
        return 1;
    };
    return { value, problems, lineOf };
};

/** Files for upload: relative to the caw folder and in caw/fixtures, never absolute and never outside it. */
const isFileList = (value) => Array.isArray(value) && value.length > 0 && value.every((file) => isText(file)
    && /^fixtures[\\/][^\\/]/.test(file) && !file.split(/[\\/]/).includes('..'));
// A line terminator has no place in a URL; in the export it could end a comment and start code.
const LINE_BREAK = /[\r\n\u2028\u2029]/;

const isRegExp = (value) => isText(value) && isPattern({ pattern: value });

/**
 * The target is one Playwright locator as code, e.g. getByRole('button', { name: 'Save', exact: true }), frames included. It is
 * parsed, never evaluated (locator.mjs), and must not depend on one page state (snapshot references, ExtJS's generated ids).
 */
const checkTarget = (payload, name, framework, report) => {
    if (typeof payload !== 'string') {
        report(t('config.test.action.target', { name }));
        return;
    }
    try {
        checkLocator(payload, { framework });
    } catch (error) {
        report(t('config.test.action.locator', { name, problem: error.message }));
    }
};

const readAction = (raw, report, { framework }) => {
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
    const extras = {
        ...(raw.path === undefined ? {} : { path: raw.path }),
        ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
        ...(raw.dialog === undefined ? {} : { dialog: raw.dialog }),
    };
    const allowed = new Set([name, 'path', 'timeoutMs', ...(ACTION_EXTRAS[name] ?? [])]);
    const foreign = Object.keys(raw).find((key) => !allowed.has(key));
    if (foreign !== undefined) report(t('config.test.action.unknownField', { name, field: foreign, hint: hintFor(foreign, [...allowed]) }));
    if (raw.path !== undefined && typeof raw.path !== 'string') report(t('config.test.action.path', { name }));
    if (raw.timeoutMs !== undefined && !(Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0)) report(t('config.test.action.timeout', { name }));
    if (raw.dialog !== undefined && allowed.has('dialog')) {
        const problem = dialogProblem(raw.dialog);
        if (problem !== null) report(t(`config.test.action.dialog.${problem}`, { name }));
    }

    if (TARGETED.includes(name)) {
        checkTarget(payload, name, framework, report);
        for (const key of HINTS) if (raw[key] !== undefined && !isText(raw[key])) report(t('config.test.action.hint', { name, key }));
        if (['fill', 'type'].includes(name) && typeof raw.value !== 'string') report(t('config.test.action.value', { name }));
        if (name === 'upload' && !isFileList(raw.files)) report(t('config.test.action.files'));
        if (name === 'download' && !isRegExp(raw.file)) report(t('config.test.action.file'));
        if (raw.optional !== undefined && raw.optional !== true) report(t('config.test.action.optional'));
        if (name === 'dragTo') checkTarget(raw.to, 'dragTo to', framework, report);
        return {
            action: name,
            target: payload,
            ...extras,
            ...(raw.value === undefined ? {} : { value: raw.value }),
            ...(raw.files === undefined ? {} : { files: raw.files }),
            ...(raw.file === undefined ? {} : { file: raw.file }),
            ...(raw.optional === true ? { optional: true } : {}),
            ...(name === 'dragTo' && typeof raw.to === 'string' ? { to: raw.to } : {}),
            ...Object.fromEntries(HINTS.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]])),
        };
    }
    if (TEXT_ACTIONS[name] !== undefined) {
        if (!isText(payload)) report(t('config.test.action.text', { name }));
        else if (name === 'goto' && LINE_BREAK.test(payload)) report(t('config.test.action.urlLine'));
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
        if (isObject(options) && options.store !== undefined) report(t('config.test.action.waitReadyStore'));
        else if (!isObject(options) || Object.keys(options).some((key) => !['for', 'minCount'].includes(key))) report(t('config.test.action.waitReady'));
        return { action: name, ...options, ...extras };
    }
    if (payload !== null && !(isObject(payload) && Object.keys(payload).length === 0)) report(t('config.test.action.reload'));
    return { action: name, ...extras };
};

const writeAction = ({ action, target, to, key, url, name, code, secret, for: waitFor, minCount, value, files, file, denied, path, timeoutMs, optional, dialog, component, source }) => {
    let payload = {};
    if (TARGETED.includes(action)) payload = target;
    else if (action === 'press') payload = key;
    else if (action === 'goto') payload = url;
    else if (action === 'screenshot') payload = name;
    else if (action === 'remember') payload = { name, code, ...(secret === true ? { secret } : {}) };
    else if (action === 'wait-ready') payload = { ...(waitFor === undefined ? {} : { for: waitFor }), ...(minCount === undefined ? {} : { minCount }) };
    return {
        [action]: payload,
        ...(value === undefined ? {} : { value }),
        ...(files === undefined ? {} : { files }),
        ...(file === undefined ? {} : { file }),
        ...(denied === undefined ? {} : { denied }),
        ...(optional === true ? { optional } : {}),
        ...(to === undefined ? {} : { to }),
        ...(dialog === undefined ? {} : { dialog }),
        ...(component === undefined ? {} : { component }),
        ...(source === undefined ? {} : { source }),
        ...(path === undefined ? {} : { path }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
};

const readRecording = (raw, at, problems, lineOf, { framework }) => {
    const report = (path, message) => problems.push(t('config.test.line', { line: lineOf(path), message }));
    if (!isObject(raw)) {
        report(at, t('config.test.recording.object'));
        return undefined;
    }
    for (const key of Object.keys(raw)) if (!RECORDING_FIELDS.includes(key)) report([...at, key], t('config.test.recording.unknown', { key, hint: hintFor(key, RECORDING_FIELDS) }));
    // Date placeholders before 1.0: {{today}} is now {{date}} in the browser's locale, {{todayIso}} is {{isoDate}}.
    for (const { old, now } of renamedDates(JSON.stringify([raw.actions, raw.check]))) report(at, t('config.removed.renamed', { key: old, now }));
    for (const key of ['hash', 'recordedOn', 'recordedAt', 'locale', 'timezone', 'check']) if (!isText(raw[key])) report([...at, key], t('config.test.recording.missing', { key }));
    if (raw.after !== undefined && !STEP_ID.test(String(raw.after))) report([...at, 'after'], t('config.test.recording.after'));
    if (raw.timeoutMs !== undefined && !(Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0)) report([...at, 'timeoutMs'], t('config.test.recording.timeout'));
    if (raw.viewport !== undefined && !isViewport(raw.viewport)) report([...at, 'viewport'], t('config.test.recording.viewport'));
    if (raw.network !== undefined) checkNetwork(raw.network, [...at, 'network'], report);
    if (raw.effects !== undefined) checkEffects(raw.effects, [...at, 'effects'], report);
    if (!Array.isArray(raw.actions)) {
        report([...at, 'actions'], t('config.test.recording.actions'));
        return undefined;
    }
    const actions = raw.actions.map((action, index) => readAction(action, (message) => report([...at, 'actions', index], message), { framework }));
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
 * A retry starts at this step or an earlier one. When fixing, the plan holds only one step, so this is not part of the plan's
 * shape check.
 * @returns the problems as text
 */
export const retryProblems = (steps) => steps.flatMap(({ id, retry }, position) => {
    if (retry?.from === undefined || steps.slice(0, position + 1).some((step) => step.id === retry.from)) return [];
    return [t('config.test.retry.order', { id: String(id), from: retry.from })];
});

/** Checks the steps. Shared by plan and test file; only the test file may carry recordings. */
const readSteps = (raw, problems, lineOf, { allowRecording, description = false, framework = 'web' }) => {
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
        // A recording in the plan is ignored: only the tool writes recordings.
        if (!allowRecording || step.recording === undefined) return plain;
        const recording = readRecording(step.recording, [...at, 'recording'], problems, lineOf, { framework });
        return recording === undefined ? plain : { ...plain, recording };
    });
};

const invalid = (label, problems) => new CawError('test-invalid', problems.map((problem) => `${label}: ${problem}`).join('\n'));

/** The points verdict and report are measured against: exactly one per step. */
export const withExpectations = (spec) => ({ ...spec, expectations: spec.steps.map(({ id, expect }) => ({ id, text: expect })) });

/**
 * Step texts that YAML silently cuts: in an unquoted value " #" starts a comment, so `expect: Toast "Added #12" shows` would
 * become `Toast "Added`. Claude and people write such texts; the step would then check something else than intended.
 */
// "#12", "#home", "#<id>" are text; a real comment starts with "# " (space), and caw keeps those when it writes the file.
const COMMENT_CUT = /^\s*(?:-\s+)?(name|do|expect|note):[ \t]+(?!['"|>])[^#\r\n]*?[ \t]#(?=\S)/;
const commentCuts = (text) => String(text).split(/\r?\n/).flatMap((line, index) => {
    const match = COMMENT_CUT.exec(line);
    return match === null ? [] : [t('config.test.line', { line: index + 1, message: t('config.test.commentCut', { key: match[1] }) })];
});

/**
 * Reads a test file and checks its shape, with line numbers; everything that depends on the target is done by `checkTest`.
 * @param description the description in caw/tests: without recordings and knownMessages, which live in caw/recordings.
 *                    Otherwise a run's draft, a single file with both.
 * @param framework   the app's framework from the config: which generated ids a target must not contain
 */
export const parseTest = (text, label = t('config.test.label'), { description = false, framework = 'web' } = {}) => {
    const { value, problems, lineOf } = readYaml(text);
    if (problems.length > 0) throw invalid(label, problems);
    const report = (path, message) => problems.push(t('config.test.line', { line: lineOf(path), message }));
    if (!isObject(value)) throw invalid(label, [t('config.test.file.object')]);
    for (const key of Object.keys(value).filter((candidate) => !TOP_FIELDS.includes(candidate))) {
        const removed = TEST_REMOVED[key];
        if (removed === undefined) report([key], t('config.test.unknown', { key, hint: hintFor(key, TOP_FIELDS) }));
        else report([key], removed.now === undefined ? t('config.removed.gone', { key, why: t(removed.why) }) : t('config.removed.renamed', { key, now: removed.now }));
    }
    // id, role and environments may be missing: defaults come from the file name and the config (withDefaults).
    for (const key of ['id', 'role']) if (value[key] !== undefined && !isText(value[key])) report([key], t('config.test.text', { key }));
    if (value.start !== undefined && !isStartPath(value.start)) report(['start'], t('config.test.start'));
    if (value.environments !== undefined && (!Array.isArray(value.environments) || value.environments.length === 0 || !value.environments.every(isText))) report(['environments'], t('config.test.environments'));
    // A renamed mutates is reported as renamed, not also as a missing writes.
    if (typeof value.writes !== 'boolean' && value.mutates === undefined) report(['writes'], t('config.test.writes'));
    if (value.notes !== undefined && value.notes !== null && typeof value.notes !== 'string') report(['notes'], t('config.test.text', { key: 'notes' }));
    if (description && value.knownMessages !== undefined) report(['knownMessages'], t('config.test.recordingOnly', { key: 'knownMessages' }));
    else if (!knownMessagesOk(value.knownMessages)) report(['knownMessages'], t('config.test.knownMessages'));
    const steps = readSteps(value.steps, problems, lineOf, { allowRecording: !description, description, framework });
    problems.push(...commentCuts(text));
    if (problems.length === 0) problems.push(...retryProblems(steps));
    if (problems.length > 0) throw invalid(label, problems);
    return withExpectations({
        ...(value.id === undefined ? {} : { id: value.id }),
        ...(value.role === undefined ? {} : { role: value.role }),
        ...(value.environments === undefined ? {} : { environments: value.environments }),
        writes: value.writes,
        ...(value.start === undefined ? {} : { start: value.start }),
        notes: clean(value.notes),
        steps,
        ...(value.knownMessages === undefined ? {} : { knownMessages: value.knownMessages }),
    });
};

/**
 * Reads the agent's plan: only `notes` and `steps`. Metadata and recordings it sends anyway are dropped, because role, environments
 * and write access stay with the human.
 */
/** What became of a human note: a step's `note`, a step's `retry`, the test's `notes`, or only this recording. */
export const HEARD_AS = ['note', 'retry', 'notes', 'run'];
const HEARD_ID = /^H\d+$/;

/** The plan's `heard` list: one entry per human note, `{ note: H<n>, as, step? }`. */
const readHeard = (raw, problems, lineOf) => {
    if (raw === undefined || raw === null) return [];
    const wrong = () => problems.push(t('config.test.line', { line: lineOf(['heard']), message: t('config.test.plan.heard', { kinds: HEARD_AS.join(', ') }) }));
    if (!Array.isArray(raw)) {
        wrong();
        return [];
    }
    const ok = raw.every((entry) => isObject(entry) && HEARD_ID.test(String(entry.note)) && HEARD_AS.includes(entry.as)
        && (['note', 'retry'].includes(entry.as) ? STEP_ID.test(String(entry.step)) : entry.step === undefined));
    if (!ok) wrong();
    return ok ? raw.map(({ note, as, step }) => ({ note, as, ...(step === undefined ? {} : { step }) })) : [];
};

export const parsePlan = (text) => {
    const { value, problems, lineOf } = readYaml(text);
    if (problems.length === 0 && !isObject(value)) problems.push(t('config.test.plan.object'));
    if (problems.length > 0) return { problems };
    if (value.notes !== undefined && value.notes !== null && typeof value.notes !== 'string') problems.push(t('config.test.line', { line: lineOf(['notes']), message: t('config.test.text', { key: 'notes' }) }));
    const steps = readSteps(value.steps, problems, lineOf, { allowRecording: false });
    const heard = readHeard(value.heard, problems, lineOf);
    return problems.length > 0 ? { problems } : { problems, plan: { notes: clean(value.notes), steps, ...(heard.length === 0 ? {} : { heard }) } };
};

export const testPath = (root, id) => join(root, TEST_DIR, `${id}.yaml`);
export const recordingPath = (root, id) => join(root, RECORDING_DIR, `${id}.yaml`);

// A known message is a fixed text or a pattern `{pattern}`, e.g. for a dialog showing a checksum or the time.
const knownMessagesOk = (value) => value === undefined || (Array.isArray(value) && value.every((message) => typeof message === 'string' || isPattern(message)));

/**
 * Reads a recording file: `test`, per step `id` plus the recording fields, and `knownMessages`.
 * @param framework the app's framework from the config, see parseTest
 * @returns { test, byId: Map step -> recording, knownMessages? }
 */
export const parseRecordings = (text, label = t('config.test.recordings.label'), { framework = 'web' } = {}) => {
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
        const recording = readRecording(raw, at, problems, lineOf, { framework });
        if (recording !== undefined) byId.set(id, recording);
    });
    if (problems.length > 0) throw invalid(label, problems);
    return { test: value.test, byId, ...(value.knownMessages === undefined ? {} : { knownMessages: value.knownMessages }) };
};

/** Merges recordings into the description. The recording file wins over an old recording inside the description. */
export const mergeRecordings = (spec, { byId, knownMessages }) => ({
    ...spec,
    steps: spec.steps.map((step) => (byId.has(step.id) ? { ...step, recording: byId.get(step.id) } : step)),
    ...(knownMessages === undefined ? {} : { knownMessages }),
});

/** The app's framework as the config names it; 'web' if there is no readable config (it is reported elsewhere). */
const frameworkIn = (root) => {
    try {
        return loadConfig(root).framework ?? 'web';
    } catch {
        return 'web';
    }
};

const readRecordingFile = (root, id, framework = frameworkIn(root)) => {
    const path = recordingPath(root, id);
    if (!existsSync(path)) return null;
    const label = `${RECORDING_DIR}/${id}.yaml`;
    const recordings = parseRecordings(readFileSync(path, 'utf8'), label, { framework });
    if (recordings.test !== id) throw new CawError('test-invalid', t('config.test.recordings.otherTest', { label, test: String(recordings.test), id: String(id) }));
    return recordings;
};

/** @param framework the app's framework; read from the config when not given */
export const loadTest = (root, id, { framework = frameworkIn(root) } = {}) => {
    const path = testPath(root, id);
    if (!existsSync(path)) throw new CawError('test-missing', t('config.test.notFound', { path: `${TEST_DIR}/${id}.yaml` }));
    const parsed = parseTest(readFileSync(path, 'utf8'), `${TEST_DIR}/${id}.yaml`, { description: true });
    // Without an id the file name applies; a given id must match it.
    if (parsed.id !== undefined && parsed.id !== id) throw new CawError('test-invalid', t('config.test.idMismatch', { path: `${TEST_DIR}/${id}.yaml`, id: String(parsed.id) }));
    const spec = { ...parsed, id };
    const recordings = readRecordingFile(root, id, framework);
    return recordings === null ? spec : mergeRecordings(spec, recordings);
};

/** The only name in a config map, otherwise undefined. */
const onlyKey = (map) => {
    const keys = Object.keys(map ?? {});
    return keys.length === 1 ? keys[0] : undefined;
};

/**
 * Whatever the test omits comes from the config: the role when there is exactly one (only with sign-in). `runsOn` is where the
 * test runs: its `environments` as written, otherwise testEnvironments (non-production, writable ones for a writing test).
 * `environments` itself stays as written, so a test written back never pins the default. The start path stays as written too:
 * startPath falls back to the config's. Anything still missing is reported by checkTest.
 */
export const withDefaults = (spec, config) => {
    const role = spec.role ?? (config.roles === undefined ? undefined : onlyKey(config.roles));
    const runsOn = spec.environments ?? testEnvironments(config, { writes: spec.writes === true });
    return { ...spec, ...(role === undefined ? {} : { role }), runsOn };
};

/**
 * What is wrong with the environments a test lists itself: names that do not exist, and for a writing test environments it may
 * not write on (production or not writable). A read-only test may list production (a prod smoke test).
 */
export const environmentProblems = (spec, config) => {
    if (spec.environments === undefined) return [];
    const known = Object.keys(config.environments ?? {});
    return spec.environments.flatMap((name) => {
        if (!known.includes(name)) return [t('config.test.envUnknown', { name: String(name), names: known.join(', ') || '–' })];
        if (spec.writes !== true) return [];
        let env;
        try {
            env = effectiveEnvironment(config, name);
        } catch {
            return []; // reported with the config
        }
        if (env.production) return [t('config.test.envProduction', { name })];
        return env.writable ? [] : [t('config.test.envReadOnly', { name })];
    });
};

/** The names in a config map for messages, e.g. "admin, tester". */
const namesIn = (map) => Object.keys(map ?? {}).join(', ') || '–';

/**
 * Recording hints that are not errors: recordings without a step (deleted or renamed) and recording files without a description.
 * Such recordings are dropped on the next write.
 */
export const recordingHints = (root) => {
    const dir = join(root, RECORDING_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith('.yaml')).flatMap((name) => {
        const id = name.slice(0, -'.yaml'.length);
        if (!existsSync(testPath(root, id))) return [t('config.test.hint.noDescription', { file: `${RECORDING_DIR}/${name}`, test: `${TEST_DIR}/${name}` })];
        const recordings = readRecordingFile(root, id);
        const steps = new Set(loadTest(root, id).steps.map((step) => step.id));
        const orphans = [...recordings.byId.keys()].filter((step) => !steps.has(step)).map((step) => t('config.test.hint.orphan', { file: `${RECORDING_DIR}/${name}`, step }));
        // Recorded before the viewport was stored: replay keeps the default size until the test is recorded again.
        const unpinned = [...recordings.byId.values()].some((recording) => recording?.viewport === undefined);
        return [...orphans, ...(unpinned ? [t('config.test.hint.noViewport', { file: `${RECORDING_DIR}/${name}` })] : [])];
    });
};

/**
 * May this test run on this environment? Write protection lives here, deterministic and before any browser starts. Also decides
 * which code runs: without --overlay always the deployed code.
 * @param overlay from --overlay: true, 'build', 'dev', a dev server URL, a list of parts (orders,admin:dev), or undefined
 * @param start   from --start: caw may run a part's start command when its source is not ready
 */
export const checkTest = (given, target, config, { overlay, start = false } = {}) => {
    const resolved = effectiveEnvironment(config, target);
    const spec = withDefaults(given, config);
    const bad = (message) => new CawError('test-invalid', message);
    const file = `${TEST_DIR}/${spec.id}.yaml`;
    const listed = environmentProblems(spec, config);
    if (listed.length > 0) throw bad(`${file}: ${listed[0]}`);
    if (spec.writes && !resolved.writable) {
        throw new CawError('write-protected', t('config.test.check.writeProtected', { id: String(spec.id), target: String(target), environment: resolved.name }));
    }
    if (!spec.runsOn.includes(target)) throw bad(t('config.test.check.target', { target: String(target), id: String(spec.id), targets: spec.runsOn.join(', ') || '–', file }));
    if (spec.role === undefined && config.roles !== undefined) throw bad(t('config.test.check.role', { id: String(spec.id), roles: namesIn(config.roles), config: CONFIG_FILE }));
    if (spec.role !== undefined && config.roles?.[spec.role] === undefined) throw bad(t('config.test.check.unknownRole', { role: String(spec.role), roles: namesIn(config.roles), config: CONFIG_FILE }));
    return { ...resolved, writes: spec.writes, ...codeFor(resolved, config, overlay, start) };
};

/**
 * Which code runs, decided in exactly one place: the deployed code unless --overlay is given. Never switched silently, not by
 * open, a test file, or a running watch. If the overlay is not possible, that is a usage error stating why.
 * A dev server on the local machine (http on localhost) already serves the local code, so there is nothing to overlay.
 * @returns { source: 'deployed' } | { source: 'overlay', parts: { <part>: source }, skipped: [<part>] }, see overlayChoice for source
 */
const codeFor = (resolved, config, overlay, start) => {
    if (overlay === undefined) return { source: 'deployed' };
    const { host, hostname, protocol } = new URL(resolved.url);
    if (protocol === 'http:' && isLoopback(hostname)) throw new CawError('usage', t('config.overlay.devServer', { environment: resolved.name, host }));
    if (config.overlay === undefined) throw new CawError('usage', t('config.overlay.none'));
    const allowed = overlayEnvironments(config);
    if (!allowed.includes(resolved.name)) throw new CawError('usage', t('config.overlay.environment', { environment: resolved.name, environments: allowed.join(', ') }));
    return { source: 'overlay', ...overlaySelection(config, overlay, start) };
};

const PART_ITEM = /^([a-z][a-z0-9-]{0,31})(?::(build|dev))?$/;

/**
 * The parts --overlay brings in and their sources:
 * - nothing, build or dev: every part with that source; a part without one stays deployed and is listed in `skipped`, but at
 *   least one part must have it;
 * - an address: the dev server of the only part;
 * - a comma list of <part>, <part>:build, <part>:dev: exactly those parts, each must have the source; the others stay deployed.
 * @returns { parts: { <part>: source }, skipped: [<part>] }
 */
export const overlaySelection = (config, flag, start = false) => {
    const names = Object.keys(overlayParts(config));
    if (isServerUrl(flag)) {
        if (names.length !== 1) throw new CawError('usage', t('config.overlay.urlParts', { parts: names.join(', ') }));
        return { parts: { [names[0]]: overlayChoice(config, names[0], flag, { start }) }, skipped: [] };
    }
    if (flag === true || OVERLAY_KINDS.includes(flag)) {
        const parts = {};
        const skipped = [];
        for (const name of names) {
            const choice = overlayChoice(config, name, flag, { required: false, start });
            if (choice === null) skipped.push(name);
            else parts[name] = choice;
        }
        if (Object.keys(parts).length > 0) return { parts, skipped };
        // The one part's own message says what it lacks; with several, what none of them has.
        if (names.length === 1) overlayChoice(config, names[0], flag, { start });
        if (flag === true) throw new CawError('usage', t('config.overlay.noSourceAny'));
        throw new CawError('usage', t('config.overlay.missingAll', { kind: flag, key: flag === 'build' ? 'build' : 'url' }));
    }
    // The whole list is read before any part is resolved: a wrong item is named as such, not as a part's problem.
    const items = String(flag).split(',').map((entry) => entry.trim()).map((item) => {
        if (OVERLAY_KINDS.includes(item) || isServerUrl(item)) throw new CawError('usage', t('config.overlay.alone', { item }));
        const match = PART_ITEM.exec(item);
        if (match === null) throw new CawError('usage', t('config.overlay.item', { item }));
        return { item, name: match[1], kind: match[2] };
    });
    const parts = {};
    for (const { item, name, kind } of items) {
        if (!names.includes(name)) {
            const near = didYouMean(name, names);
            throw new CawError('usage', t('config.overlay.unknownPart', { part: name, hint: near === undefined ? '' : t('config.didYouMean', { name: near }), parts: names.join(', ') || '–' }));
        }
        parts[name] = overlayChoice(config, name, kind ?? true, { start, item });
    }
    return { parts, skipped: [] };
};

/**
 * A part's source for --overlay:
 * - { kind: 'build', dir }: build folder relative to the project
 * - { kind: 'dev', url }: dev server
 * - { kind: 'watch', url }: the Sencha watch's web server (ExtJS), sources per its bootstrap.json
 * - { kind: 'files' }: statics only
 * Each with `statics`, and with `start` (the project's command) if the config names one. `command` is set only with --start: then
 * caw runs it when the source is not ready; otherwise caw starts nothing and names `start`.
 * Without the asked-for source: null when not required, otherwise a usage error.
 * @param flag true (its only source), 'build', 'dev' or a dev server URL
 * @param item the --overlay item as typed, for the message
 */
export const overlayChoice = (config, name, flag, { required = true, start = false, item = flag } = {}) => {
    const overlay = overlayParts(config)[name] ?? {};
    const statics = overlay.statics ?? [];
    const command = (value) => (value === undefined ? {} : { start: value, ...(start ? { command: value } : {}) });
    const url = isServerUrl(flag) ? flag : undefined;
    const adapter = frameworkOf(config);
    if (adapter.overlay?.defaultUrl !== undefined) {
        if (flag === 'build') throw new CawError('usage', t('config.overlay.extjsKind', { kind: flag }));
        return { kind: 'watch', url: url ?? overlay.url ?? adapter.overlay.defaultUrl, ...command(overlay.start), statics };
    }
    if (url !== undefined) return { kind: 'dev', url, ...command(overlay.start), statics };
    const build = overlay.build === undefined ? null : { kind: 'build', dir: overlay.build, ...command(overlay.start), statics };
    const dev = overlay.url === undefined ? null : { kind: 'dev', url: overlay.url, ...command(overlay.start), statics };
    if (flag === 'build' || flag === 'dev') {
        const chosen = flag === 'build' ? build : dev;
        if (chosen !== null) return chosen;
        if (!required) return null;
        const [key, other, otherKey] = flag === 'build' ? ['build', 'dev', 'url'] : ['url', 'build', 'build'];
        throw new CawError('usage', t('config.overlay.missing', { item, key, part: name, other: overlay[otherKey] === undefined ? '' : t('config.overlay.missingOther', { other, key: otherKey, part: name }) }));
    }
    if (build !== null && dev !== null) throw new CawError('usage', t('config.overlay.choose', { part: name, build: overlay.build, dev: overlay.url }));
    const only = build ?? dev ?? (statics.length > 0 ? { kind: 'files', statics } : null);
    if (only === null && required) throw new CawError('usage', t('config.overlay.noSource', { part: name }));
    return only;
};

/** Only what defines the step's content. A manual change makes exactly this step stale. `retry` does not change the path. */
export const stepHash = ({ name, do: action, expect, note }) => createHash('sha256')
    .update(JSON.stringify([clean(name), clean(action), clean(expect), clean(note)]))
    .digest('hex')
    .slice(0, 16);

/** Steps whose recording is missing or no longer matches their text. */
export const staleSteps = (spec) => spec.steps.flatMap((step) => {
    if (step.recording === undefined) return [{ id: step.id, why: t('config.test.stale.none') }];
    return step.recording.hash === stepHash(step) ? [] : [{ id: step.id, why: t('config.test.stale.changed') }];
});

/**
 * Does a recording build on a step that no longer precedes it? An inserted step is fine, a deleted or moved one is not, because
 * what follows relies on its state.
 * @returns the first step at such a place, or null
 */
export const brokenChainAt = (spec) => {
    const before = new Set();
    for (const step of spec.steps) {
        const after = step.recording?.after;
        if (after !== undefined && !before.has(after)) return step;
        before.add(step.id);
    }
    return null;
};

/** The first broken place in the chain as a sentence, or null. */
export const brokenChain = (spec) => {
    const step = brokenChainAt(spec);
    return step === null ? null : t('config.test.chain', { id: String(step.id), after: String(step.recording.after) });
};

const planFields = ({ id, name, do: action, expect, note, retry }) => ({ id, name, do: action, expect, ...(note === undefined || note === '' ? {} : { note }), ...(retry === undefined ? {} : { retry }) });

const recordingFields = (recording) => ({
    hash: recording.hash,
    ...(recording.after === undefined ? {} : { after: recording.after }),
    recordedOn: recording.recordedOn,
    recordedAt: recording.recordedAt,
    ...(recording.locale === undefined ? {} : { locale: recording.locale }),
    ...(recording.timezone === undefined ? {} : { timezone: recording.timezone }),
    ...(recording.viewport === undefined ? {} : { viewport: recording.viewport }),
    actions: recording.actions.map(writeAction),
    check: recording.check,
    ...(recording.timeoutMs === undefined ? {} : { timeoutMs: recording.timeoutMs }),
    ...(recording.network === undefined ? {} : { network: recording.network }),
    ...(recording.effects === undefined ? {} : { effects: recording.effects }),
});

/** Actions and baselines on one line each: the recording gets much shorter and reads like a list. */
const compactRecording = (node) => {
    for (const entry of node?.get('network', true)?.items ?? []) entry.flow = true;
    for (const action of node?.get('actions', true)?.items ?? []) if (isMap(action)) action.flow = true;
};

/**
 * A step node; with `withRecording` including its recording, as in a run's draft. Aliases are off: yaml would otherwise write
 * reused targets as aliases, which parseTest rejects.
 */
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

/**
 * @param only  the steps to rewrite; if omitted, all of them
 * @param prune with `only`: the list follows the plan, steps no longer in it are deleted, the others stay untouched nodes
 */
const setSteps = (doc, spec, only, { prune = false, ...options } = {}) => {
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
        // Comments above the step belong to the human.
        node.commentBefore = known.get(step.id)?.commentBefore;
        return node;
    };
    if (only === undefined) {
        list.items = spec.steps.map(renew);
        return;
    }
    if (prune) {
        list.items = spec.steps.map((step) => (only.has(step.id) || !known.has(step.id) ? renew(step) : known.get(step.id)));
        return;
    }
    list.items = list.items.map((item) => {
        const step = spec.steps.find(({ id }) => id === item.get('id'));
        return step !== undefined && only.has(step.id) ? renew(step) : item;
    });
    // A step that was not in the file yet is inserted at its position in the plan.
    spec.steps.forEach((step, position) => {
        if (only.has(step.id) && !known.has(step.id)) list.items.splice(position, 0, renew(step));
    });
};

/** The test file as text, as it would look when written from scratch. */
export const renderTest = (spec) => {
    const doc = new Document({
        id: spec.id,
        role: spec.role,
        writes: spec.writes,
        ...(spec.environments === undefined ? {} : { environments: spec.environments }),
        ...(spec.start === undefined ? {} : { start: spec.start }),
        ...(spec.notes === '' || spec.notes === undefined ? {} : { notes: spec.notes }),
    });
    const environments = doc.get('environments', true);
    if (environments !== undefined) environments.flow = true;
    setSteps(doc, spec);
    if (spec.knownMessages !== undefined) doc.set('knownMessages', spec.knownMessages);
    return doc.toString(STRINGIFY);
};

/** The plan as YAML, as the agent would write it. */
export const renderPlan = (spec) => new Document({
    ...(spec.notes === '' || spec.notes === undefined ? {} : { notes: spec.notes }),
    steps: spec.steps.map(planFields),
}).toString(STRINGIFY);

/** The description as text, without recordings. */
export const renderDescription = (spec) => renderTest({ ...spec, steps: spec.steps.map(({ recording: _recording, ...step }) => step), knownMessages: undefined });

/** The recording file as text: it belongs to the tool, so it is always rewritten in full. */
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

/** Writes only when something changes and keeps the file's line endings. @returns whether it wrote */
const writeIfChanged = (path, text, raw) => {
    const final = raw?.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text;
    if (raw === final) return false;
    writeFileSync(path, final);
    return true;
};

/**
 * Writes description and recording. Comments and untouched steps in the description stay as they are; a step from `only` is
 * only rewritten when its text changed. So when the tool learns baselines or effects, only the recording changes.
 * @param only the steps that change; if omitted, the whole plan is replaced
 * @param withNotes also write `notes` when only some steps change
 * @param prune     with `only`: steps no longer in the plan are deleted and the order follows it (re-recording from a step on);
 *                  all other steps stay as they are in the file, byte for byte
 * @returns the changed files relative to the project, comma-separated
 */
export const writeTest = (root, spec, only, { withNotes = false, prune = false } = {}) => {
    const path = testPath(root, spec.id);
    mkdirSync(join(root, TEST_DIR), { recursive: true });
    const changed = [];
    // The previous state: recordings of unchanged steps are taken from it.
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
        setSteps(doc, spec, textChanged, { withRecording: false, prune: prune && only !== undefined });
        // A test that wrote while recording counts as writing; the file must say so, or it would run on read-only environments.
        if (spec.writes === true && doc.get('writes') !== true) doc.set('writes', true);
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
