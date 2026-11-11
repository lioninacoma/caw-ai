// Claude's advice on a run's failures and warnings. Each item names its evidence. Test-side advice changes nothing until the
// human clicks. App-side advice carries a prompt and optionally concrete code edits; the host writes those only on click,
// because the sandbox has read-only access to the project.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE, PROJECT_DIR, RUN_DIR } from '../shared/names.mjs';
import { parseTest, renderTest, stepHash } from './test-file.mjs';
import { stepLabel } from './replay.mjs';
import { CONTROL, EMAIL, replaceStep } from './test-plan.mjs';

export { CONTEXT_FILE } from '../shared/names.mjs';
const MAX_ITEMS = 10;
const LIMITS = { title: 200, reason: 2000, prompt: 8000, text: 2000, notes: 4000 };
const STEP_FIELDS = ['name', 'do', 'expect', 'note', 'retry'];
const CONFIG_KEYS = ['consoleIgnore', 'foreignCode'];
// Where the page shows messages: the advice replaces the whole list, e.g. the toast container with the single toast.
const SELECTOR_KEY = 'messageSelectors';
// action: make a recorded click optional (or required again) without re-recording, e.g. a cookie banner.
const KINDS = ['step', 'action', 'test', 'context', 'config'];
const SIDES = ['test', 'app'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;
const keepEol = (raw, text) => (raw.includes('\r\n') ? text.replaceAll(/\r?\n/g, '\r\n') : text);
/** All texts of an advice item, nested ones too: JSON.stringify would escape control characters. */
const textsOf = (value) => {
    if (typeof value === 'string') return [value];
    if (typeof value !== 'object' || value === null) return [];
    return Object.values(value).flatMap(textsOf);
};

/** The step after the change. `null` removes `note` or `retry`. */
const changedStep = (step, fields) => {
    const next = { ...step };
    for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete next[key];
        else next[key] = typeof value === 'string' ? value.trim() : value;
    }
    return next;
};

const readChange = (change, spec, config, report) => {
    if (!isObject(change) || !KINDS.includes(change.kind)) return report(`change.kind must be one of ${KINDS.join(', ')}.`);
    if (change.kind === 'step') {
        const step = spec.steps.find(({ id }) => id === change.id);
        if (step === undefined) return report(`Step ${change.id} does not exist. New steps are added by the human.`);
        if (!isObject(change.fields) || Object.keys(change.fields).length === 0) return report('change.fields is missing.');
        const foreign = Object.keys(change.fields).find((key) => !STEP_FIELDS.includes(key));
        if (foreign !== undefined) return report(`Field ${foreign} cannot be changed (allowed: ${STEP_FIELDS.join(', ')}).`);
        for (const key of ['name', 'do', 'expect']) if (change.fields[key] === null) return report(`${key} cannot be removed.`);
        // The same check as for the file: whatever passes here, parseTest will read later too.
        try {
            parseTest(renderTest(replaceStep(spec, changedStep(step, change.fields))));
        } catch (error) {
            return report(error.message.split('\n').map((line) => line.replace(/^(Testdatei: Zeile|Test file: Line) \d+: /, '')).join(' '));
        }
        return undefined;
    }
    if (change.kind === 'action') {
        const step = spec.steps.find(({ id }) => id === change.id);
        if (step === undefined) return report(`Step ${change.id} does not exist.`);
        const actions = step.recording?.actions ?? [];
        if (actions.length === 0) return report(`${change.id} is not recorded.`);
        if (!Number.isInteger(change.index) || change.index < 1 || change.index > actions.length) return report(`change.index is the action number in ${change.id}, 1 to ${actions.length}.`);
        if (actions[change.index - 1].action !== 'click') return report(`Action ${change.index} of ${change.id} is not a click; optional exists for clicks only.`);
        if (typeof change.optional !== 'boolean') return report('change.optional must be true or false.');
        return undefined;
    }
    if (change.kind === 'test') return isText(change.notes, LIMITS.notes) ? undefined : report('change.notes must be text.');
    if (change.kind === 'context') {
        if (!isText(change.section, 80) || change.section.includes('\n')) return report('change.section must be a single-line heading.');
        return isText(change.text, LIMITS.text) ? undefined : report('change.text is missing.');
    }
    if (change.key === SELECTOR_KEY) {
        const { selectors } = change;
        if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > MAX_ITEMS || !selectors.every((selector) => isText(selector, 200) && !/[\r\n]/.test(selector))) {
            return report(`change.selectors must be a list of 1 to ${MAX_ITEMS} CSS selectors.`);
        }
        if (JSON.stringify(selectors) === JSON.stringify(config[SELECTOR_KEY] ?? [])) return report(`${SELECTOR_KEY} is already set like this in the config.`);
        return undefined;
    }
    if (!CONFIG_KEYS.includes(change.key)) return report(`change.key must be one of ${[...CONFIG_KEYS, SELECTOR_KEY].join(', ')}.`);
    if (!isText(change.pattern, 300)) return report('change.pattern is missing.');
    try {
        new RegExp(change.pattern);
    } catch {
        return report(`${change.pattern} is not a valid regular expression.`);
    }
    if ((config[change.key] ?? []).includes(change.pattern)) return report(`${change.pattern} is already in ${change.key}.`);
    return undefined;
};

const MAX_EDITS = 10;
const EDIT_LIMIT = 4000;
// App-side advice never changes test files, run folders or dependencies.
const NOT_APP = new RegExp(`^(${PROJECT_DIR}|\\${RUN_DIR}|node_modules|\\.git|\\.claude)(/|$)`, 'i');
// A path as it appears in the project: normalized, without dot or empty segments and without what Windows silently reinterprets
// (trailing dot or space, data streams with ':', short names like GIT~1). Otherwise ././.git or .git. would still lead to .git.
const plainPath = (file) => posix.normalize(file) === file
    && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/[:*?"<>|]/.test(part) && !/~\d/.test(part));
/** Where the file really lives relative to the project (links resolved), or null if outside. */
const realInRoot = (root, path) => {
    try {
        const inside = relative(realpathSync.native(root), realpathSync.native(path)).replaceAll('\\', '/');
        return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? null : inside;
    } catch {
        return null;
    }
};
/** May advice change this file? Checked on the text and the real location, so a link cannot lead into .git or caw/ either. */
const appFile = (root, file) => {
    if (NOT_APP.test(file)) return false;
    const real = realInRoot(root, join(root, file));
    return real !== null && !NOT_APP.test(real);
};
const lf = (text) => text.replaceAll('\r\n', '\n');
const occurrences = (text, part) => text.split(part).length - 1;

/**
 * Concrete edits to the application code, checked against the actual files: file exists, the passage occurs exactly once. This
 * keeps the suggestion anchored, and the human sees the line.
 * @returns the edits with their line, or undefined if there are problems
 */
const readEdits = (edits, root, report) => {
    if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) return report(`edits must be a list of 1 to ${MAX_EDITS} edits.`);
    const contents = new Map();
    const checked = [];
    edits.forEach((edit, index) => {
        const at = (message) => report(`edits[${index}]: ${message}`);
        if (!isObject(edit)) return at('An edit needs file, find and replace.');
        const file = typeof edit.file === 'string' ? edit.file.replaceAll('\\', '/').replace(/^\.\//, '') : '';
        if (file === '' || /^([/]|[A-Za-z]:)/.test(file) || !plainPath(file)) return at('file must be a path relative to the project.');
        if (NOT_APP.test(file)) return at(`${file} is not part of the application.`);
        if (!isText(edit.find, EDIT_LIMIT) || typeof edit.replace !== 'string' || edit.replace.length > EDIT_LIMIT) return at(`find and replace are text up to ${EDIT_LIMIT} characters, find not empty.`);
        if (edit.find === edit.replace) return at('find and replace are identical.');
        if (edit.why !== undefined && !isText(edit.why, 500)) return at('why must be short text.');
        if (root === undefined) return checked.push({ file, find: edit.find, replace: edit.replace, ...(edit.why === undefined ? {} : { why: edit.why }) });
        const path = join(root, file);
        if (!contents.has(file)) {
            if (!existsSync(path)) return at(`${file} does not exist.`);
            if (!appFile(root, file)) return at(`${file} is not part of the application.`);
            contents.set(file, lf(readFileSync(path, 'utf8')));
        }
        const text = contents.get(file);
        const find = lf(edit.find);
        const count = occurrences(text, find);
        if (count !== 1) return at(`find occurs ${count === 0 ? 'not at all' : `${count} times`} in ${file}; it must occur exactly once.`);
        const line = text.slice(0, text.indexOf(find)).split('\n').length;
        // Later edits to the same file see the state after the earlier ones.
        contents.set(file, text.replace(find, () => lf(edit.replace)));
        return checked.push({ file, line, find: edit.find, replace: edit.replace, ...(edit.why === undefined ? {} : { why: edit.why }) });
    });
    return checked.length === edits.length ? checked : undefined;
};

/** Writes the edits into the application code, only after the human clicks. @returns the changed files */
export const applyEdits = (root, edits) => {
    const files = [];
    for (const { file, find, replace } of edits) {
        // A link may have appeared between check and click: check again right before writing.
        if (!plainPath(file) || !appFile(root, file)) throw new CawError('advice-invalid', t('run.advice.fileChanged', { file }));
        const path = join(root, file);
        const raw = readFileSync(path, 'utf8');
        const text = lf(raw);
        if (occurrences(text, lf(find)) !== 1) throw new CawError('advice-invalid', t('run.advice.fileChanged', { file }));
        writeFileSync(path, keepEol(raw, text.replace(lf(find), () => lf(replace))));
        if (!files.includes(file)) files.push(file);
    }
    return files;
};

/**
 * Checks what Claude submits before the human sees it.
 * @param root      project folder: code edits are checked against the actual files
 * @param diagnosis the tool's diagnosis: test-side advice against a clear app-failure diagnosis is flagged
 * @returns the advice items
 * @throws advice-invalid listing all problems
 */
export const readAdvice = (raw, spec, config, { root, diagnosis } = {}) => {
    const problems = [];
    if (!isObject(raw) || !Array.isArray(raw.items)) throw new CawError('advice-invalid', 'Expected: { "items": [ ... ] }.');
    if (raw.items.length > MAX_ITEMS) problems.push(`At most ${MAX_ITEMS} advice items.`);
    const items = [];
    raw.items.forEach((item, index) => {
        const report = (message) => { problems.push(`items[${index}]: ${message}`); };
        if (!isObject(item)) return report('An advice item must be an object.');
        if (!isText(item.evidence, 300)) report('evidence is missing: name the evidence briefly, e.g. "request GET /x", the text of a hard failure, "console" or "src/a.js:12".');
        const texts = textsOf(item);
        if (texts.some((text) => CONTROL.test(text))) report('Contains control characters.');
        if (texts.some((text) => EMAIL.test(text))) report('Contains an email address.');
        if (!SIDES.includes(item.side)) report('side must be test or app.');
        if (!isText(item.title, LIMITS.title)) report(`title is missing or longer than ${LIMITS.title} characters.`);
        if (!isText(item.reason, LIMITS.reason)) report('reason is missing.');
        if (item.about !== undefined && !isText(item.about, 100)) report('about must be short text.');
        let edits;
        if (item.side === 'app') {
            if (!isText(item.prompt, LIMITS.prompt)) report('App-side advice needs a prompt.');
            if (item.change !== undefined) report('App-side advice does not change the test; omit change.');
            if (item.edits !== undefined) edits = readEdits(item.edits, root, report);
        }
        if (item.side === 'test') {
            readChange(item.change, spec, config, report);
            if (item.edits !== undefined) report('edits are only allowed for app-side advice.');
        }
        const contradicts = item.side === 'test' && diagnosis?.side === 'app' && diagnosis.strength === 'clear';
        items.push({ ...item, ...(edits === undefined ? {} : { edits }), ...(contradicts ? { contradicts: true } : {}) });
        return undefined;
    });
    if (problems.length > 0) throw new CawError('advice-invalid', problems.join(' '));
    return items;
};

/** Labels on the card: the human knows the fields from the plan, not their keys in the file. */
const LABELED = ['name', 'do', 'expect', 'note', 'retry', 'notes', 'consoleIgnore', 'foreignCode', 'messageSelectors'];
const labelOf = (key) => (LABELED.includes(key) ? t(`run.advice.label.${key}`) : key);

/** "failure 2" refers to the run's second hard failure: the card shows its text. */
const evidenceText = (evidence, failures) => evidence.replace(/\bfailure (\d+)\b/g, (whole, number) => {
    const failure = failures[Number(number) - 1];
    return failure === undefined ? whole : t('run.advice.hardFailure', { number, type: failure.type, text: String(failure.text).slice(0, 160) });
});

/**
 * What the card in the chat shows: before and after for each change.
 * @param failures the run's hard failures, so evidence like "failure 1" becomes readable
 */
export const adviceView = (item, spec, failures = [], config = {}) => {
    const base = {
        side: item.side,
        title: item.title,
        reason: item.reason,
        ...(item.about === undefined ? {} : { about: item.about }),
        ...(item.evidence === undefined ? {} : { evidence: evidenceText(item.evidence, failures) }),
        ...(item.contradicts ? { contradicts: true } : {}),
    };
    if (item.side === 'app') return { ...base, prompt: item.prompt, ...(item.edits === undefined ? {} : { edits: item.edits }) };
    const { change } = item;
    if (change.kind === 'step') {
        const step = spec.steps.find(({ id }) => id === change.id);
        const show = (key, value) => {
            if (value === undefined || value === null) return '';
            if (key === 'retry') return t('run.advice.retry', { times: value.times, seconds: (value.waitMs ?? 10_000) / 1000, from: value.from ?? step.id });
            return typeof value === 'string' ? value : JSON.stringify(value);
        };
        return { ...base, target: `${step.id} ${step.name}`, changes: Object.entries(change.fields).map(([key, value]) => ({ label: labelOf(key), before: show(key, step[key]), after: show(key, value) })) };
    }
    if (change.kind === 'action') {
        const step = spec.steps.find(({ id }) => id === change.id);
        const action = step.recording.actions[change.index - 1];
        const word = (on) => t(on ? 'run.advice.optional' : 'run.advice.required');
        return { ...base, target: `${step.id} ${step.name}`, changes: [{ label: t('run.advice.action', { number: change.index, label: stepLabel(action) }), before: word(action.optional === true), after: word(change.optional) }] };
    }
    if (change.kind === 'test') return { ...base, target: t('run.advice.testCase'), changes: [{ label: labelOf('notes'), before: spec.notes ?? '', after: change.notes }] };
    if (change.kind === 'context') return { ...base, target: CONTEXT_FILE, changes: [{ label: t('run.advice.section', { section: change.section }), before: '', after: change.text }] };
    if (change.key === SELECTOR_KEY) return { ...base, target: CONFIG_FILE, changes: [{ label: labelOf(SELECTOR_KEY), before: (config[SELECTOR_KEY] ?? []).join('  ·  '), after: change.selectors.join('  ·  ') }] };
    return { ...base, target: CONFIG_FILE, changes: [{ label: labelOf(change.key), before: '', after: change.pattern }] };
};

/**
 * Applies a change to the test, in memory only. Whether it goes into the file is up to the caller.
 * @returns { spec, id, stale, notes }: `stale` tells whether the step's recording no longer matches
 */
export const applyToSpec = (spec, change) => {
    if (change.kind === 'test') return { spec: { ...spec, notes: change.notes.trim() }, notes: true };
    // Only the recording changes; the step stays as it is: not stale, no re-recording.
    if (change.kind === 'action') {
        const step = spec.steps.find(({ id }) => id === change.id);
        const actions = step.recording.actions.map((action, index) => {
            if (index !== change.index - 1) return action;
            const rest = { ...action };
            delete rest.optional;
            return change.optional ? { ...rest, optional: true } : rest;
        });
        return { spec: replaceStep(spec, { ...step, recording: { ...step.recording, actions } }), id: step.id, stale: false };
    }
    const step = spec.steps.find(({ id }) => id === change.id);
    const next = changedStep(step, change.fields);
    const stale = step.recording !== undefined && stepHash(next) !== step.recording.hash;
    return { spec: replaceStep(spec, next), id: step.id, stale };
};

const appendContext = (root, { section, text }) => {
    const path = join(root, CONTEXT_FILE);
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '# caw-ai\n\nProjektkontext für die Tests: Eigenheiten der Anwendungen und was jeder Lauf wissen muss.\n';
    const lines = raw.replaceAll('\r\n', '\n').replace(/\n+$/, '').split('\n');
    const entry = `- ${text.trim().replaceAll(/\s*\n\s*/g, ' ')}`;
    const heading = lines.findIndex((line) => line.trim() === `## ${section.trim()}`);
    if (heading === -1) {
        lines.push('', `## ${section.trim()}`, entry);
    } else {
        const next = lines.findIndex((line, index) => index > heading && line.startsWith('## '));
        let end = next === -1 ? lines.length : next;
        while (end > heading + 1 && lines[end - 1].trim() === '') end -= 1;
        lines.splice(end, 0, entry);
    }
    writeFileSync(path, keepEol(raw, `${lines.join('\n')}\n`));
    return CONTEXT_FILE;
};

/** A config key's value after the change: one more pattern, or the new list of selectors. */
export const configValue = (config, change) => (change.key === SELECTOR_KEY ? [...change.selectors] : [...(config[change.key] ?? []), change.pattern]);

const addPattern = (root, change) => {
    const path = join(root, CONFIG_FILE);
    const raw = readFileSync(path, 'utf8');
    const config = JSON.parse(raw);
    config[change.key] = configValue(config, change);
    writeFileSync(path, keepEol(raw, `${JSON.stringify(config, null, 4)}\n`));
    return CONFIG_FILE;
};

/** Project context and config are separate files: they change immediately, independent of the test plan. @returns the path */
export const applyToFiles = (root, change) => (change.kind === 'context' ? appendContext(root, change) : addPattern(root, change));

export const changesFiles = (item) => item.side === 'test' && ['context', 'config'].includes(item.change.kind);
