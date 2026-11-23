// Let Claude run a test once, then repeat it quickly without a model. Recording happens on the host only. Playback goes
// through the same handler as the agent, so the same limits apply.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isViewport } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { isCaughtScriptError } from '../shared/report.mjs';
import { CLICK_DELAY_MS, codeText, fillField, leaveForDisabled, locatorFor, setFiles } from './agent-commands.mjs';
import { fixturePath } from './fixtures.mjs';
import { textMatcher } from './patterns.mjs';
import { redactDeep } from './secrets.mjs';
import { classifyRequest, compileReads } from '../shared/requests.mjs';
import { selfAbort } from './diagnose.mjs';
import { DATE_NAMES, fillDates, markDates, zonedNow } from './dates.mjs';
import { dialogFindings, recordedDialog } from './dialogs.mjs';
import { DEFAULT_DESIGN_FAIL, designText } from './design.mjs';
import { DEFAULT_EFFECT_FAIL, LEARN_RUNS, createEffects, deviationText, droppedEffects, effectCause, effectChange, failsStep, isEffectCause, learnEffects, stepDeviation, withoutLate } from './effects.mjs';
import { summarizeRequests } from './network-log.mjs';
import { ambiguityText, elementHint, explainLocator, explainText, frameworkOf, readPageState, waitForLocator } from './framework/index.mjs';
import { escapeRegex, isPositional, locatorLabel, locatorText, mapStrings, parseLocator, printLocator, renamedLocator } from './locator.mjs';
import { recordLocator } from './record-locator.mjs';
import { brokenChain, brokenChainAt, pendingSteps, staleSteps, stepHash, withExpectations } from './test-file.mjs';

const HINT_TIMEOUT_MS = 5000;
const CHECK_POLL_MS = 250;
const DEFAULT_RETRY_WAIT_MS = 10_000;
const TARGETED = new Set(['click', 'dblclick', 'fill', 'type', 'upload', 'download', 'hover', 'dragTo']);
/** Actions that can open a native dialog; the decision is recorded on them (Q11). */
const OPENS_DIALOG = new Set(['click', 'dblclick', 'fill', 'type', 'upload', 'download', 'press', 'goto', 'reload']);
// How long a repeated click may wait for its target before a dialog on top makes it skip.
const REPEAT_CLICK_MS = 1500;
// How long an optional click (e.g. a cookie banner) waits for its target; if it does not appear, the click is dropped.
const OPTIONAL_CLICK_MS = 3000;
const CHANGES_PAGE = new Set(['click', 'dblclick', 'press', 'goto', 'reload']);
const EFFECT_ACTIONS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'upload', 'download']);
// Actions whose renamed target caw proposes (proposeTarget in playReplay): what they do shows in their learned effect.
const REPAIRABLE = new Set(['click', 'dblclick', 'fill', 'type']);
// How much of a message goes into reasons and reports. Comparisons always use the full text.
const MESSAGE_SHOWN = 300;
const EFFECT_SETTLE_MS = 5000;
// How long controls are re-measured before a deviation counts: a slow backend finishes building the form later.
const EFFECT_REMEASURE_MS = 10_000;
const EFFECT_REMEASURE_POLL_MS = 500;
export const RUN_TAG_PLACEHOLDER = '{{runTag}}';
// Many apps derive a lowercase address or key from a name ("Akte CAW-1" becomes /akten/akte-caw-1). This form of the tag
// gets its own placeholder, otherwise it would be hard-coded in the recording.
export const RUN_TAG_LOWER_PLACEHOLDER = '{{runTagLower}}';
const RUN_TAG_NAMES = new Set(['runTag', 'runTagLower']);

const LOCKED = /element is not enabled|element is disabled|element is not editable/;
const sleepMs = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
/** A URL as the parser writes it (percent-encoded, no line breaks), or null if it is none. */
const parsedUrl = (url) => {
    try {
        return new URL(url).href;
    } catch {
        return null;
    }
};
const shownMessage = (text) => (text.length <= MESSAGE_SHOWN ? text : `${text.slice(0, MESSAGE_SHOWN)}…`);
/**
 * An error that a new attempt within the action will not fix, e.g. a download with the wrong name: a second click would
 * download again. `kind` classifies it for the abort; without it the usual look at the page applies.
 */
const finalError = (message, kind) => Object.assign(new Error(message), { final: true, ...(kind === undefined ? {} : { kind }) });

/**
 * Makes every run distinguishable: Claude writes the tag into free text, so each run finds its own record again. Only digits
 * next to the fixed part, because numbers in messages are treated as equal. Milliseconds plus two random digits: two runs
 * started in the same second (CI matrix, parallel jobs) still get different tags.
 */
export const newRunTag = (now = new Date(), random = Math.random) => `CAW-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 17)}${String(Math.floor(random() * 100) % 100).padStart(2, '0')}`;
const jsonText = (text) => JSON.stringify(String(text)).slice(1, -1);
/** Fields holding JavaScript: a value put in there is escaped with codeText, so "O'Brien" stays one string literal. */
const CODE_FIELDS = new Set(['code']);
const hasCode = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some((key) => CODE_FIELDS.has(key) && typeof value[key] === 'string');
/** Replaces text in a value of any shape; in a step's `code` the replacement is escaped for a string literal. */
export const swapText = (value, from, to) => {
    const swap = (item) => JSON.parse(JSON.stringify(item).replaceAll(jsonText(from), () => jsonText(to)));
    if (!hasCode(value)) return swap(value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, CODE_FIELDS.has(key) && typeof item === 'string' ? item.replaceAll(String(from), () => codeText(to)) : swap(item)]));
};
/** Replaces the run tag in both spellings with its placeholders. */
export const tagRun = (value, runTag) => swapText(swapText(value, runTag, RUN_TAG_PLACEHOLDER), runTag.toLowerCase(), RUN_TAG_LOWER_PLACEHOLDER);
/** Inserts the run tag into both placeholders. */
export const fillRun = (value, runTag) => swapText(swapText(value, RUN_TAG_PLACEHOLDER, runTag), RUN_TAG_LOWER_PLACEHOLDER, runTag.toLowerCase());

// `path`: the page an action ran on. With a remembered id in it (/todos/1045) the next run is on another page (/todos/1046).
const TOKEN_FIELDS = ['value', 'code', 'url', 'path'];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The locator code with fn applied to each of its string arguments (see mapStrings), printed again. Placeholders in a target are
 * always filled this way, never by replacing text in the code: a value with a quote (O'Brien) stays one string, a value in a
 * regular expression is escaped.
 */
export const mapTarget = (code, fn) => printLocator(mapStrings(parseLocator(code), fn));

/** The value as a whole token: a number 2026 matches neither the date 07.11.2026 nor VG-2026 nor #v2026. */
const tokenPattern = (value) => new RegExp(`(?<![\\p{L}\\p{N}._\\\\-])${escapeRegExp(value)}(?![\\p{L}\\p{N}_-]|\\\\?\\.[\\p{L}\\p{N}])`, 'gu');

/**
 * Replaces a remembered value with its placeholder, only as a whole token and only in inputs, checks, URLs and the target's
 * texts, selectors and regular expressions (an iframe with an order number in its title needs the new one on the next run; a
 * grid cell found by its exact text /^4711$/ too). In a regular expression the value is matched as written there, escaped;
 * replay fills it in escaped again (fillTarget).
 */
export const swapToken = (step, value, placeholder) => {
    const plain = tokenPattern(value);
    const escaped = tokenPattern(escapeRegex(value));
    const swap = (text, pattern = plain) => (typeof text === 'string' ? text.replace(pattern, () => placeholder) : text);
    // A short value (an id like 7) also stands for unrelated numbers: in code only inside string literals, in a target only an
    // argument that is the value itself (OPEN-7).
    const short = value.length < SHORT_VALUE;
    const next = { ...step };
    for (const key of TOKEN_FIELDS) {
        if (key in next) next[key] = short && key === 'code' ? swapInLiterals(next[key], plain, placeholder) : swap(next[key]);
    }
    if (typeof next.dialog?.value === 'string') next.dialog = { ...next.dialog, value: swap(next.dialog.value) };
    if (typeof next.target === 'string') next.target = mapTarget(next.target, (text, kind) => (short ? swapWhole(text, value, placeholder, kind) : swap(text, kind === 'regex' ? escaped : plain)));
    return next;
};


/** Values shorter than this are replaced only where they cannot be unrelated text (swapToken). */
const SHORT_VALUE = 4;
/** The pattern applied only inside the string literals of code: 'x', "x", `x`. */
const swapInLiterals = (code, pattern, placeholder) => (typeof code === 'string'
    ? code.replace(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g, (_literal, quote, body) => `${quote}${body.replace(pattern, () => placeholder)}${quote}`)
    : code);
/** A target argument that is the value itself (a cell named "7"), or a regular expression of only it (/^7$/). */
const swapWhole = (text, value, placeholder, kind) => {
    if (kind !== 'regex') return text === value ? placeholder : text;
    const match = /^(\^?)(.*?)(\$?)$/.exec(text);
    return match !== null && match[2] === escapeRegex(value) ? `${match[1]}${placeholder}${match[3]}` : text;
};

const ANY_PLACEHOLDER = /\{\{[A-Za-z][A-Za-z0-9]*(?:[+-]\d{1,3})?\}\}/g;

/**
 * Fills the placeholders of a target: `lookup(placeholder)` returns the value, or undefined to leave it as it is. In a regular
 * expression the value is escaped.
 */
export const fillTarget = (code, lookup) => mapTarget(code, (text, _kind, escape) => text.replace(ANY_PLACEHOLDER, (found) => {
    const value = lookup(found);
    return value === undefined ? found : escape(value);
}));

/**
 * Is the page the recorded one? A placeholder segment ({{orderId}}, {{runTagLower}}, {{today}}) stands for any value: the
 * filled path is compared first, this only keeps a value of another run from counting as the wrong page.
 */
export const samePath = (actual, recorded) => {
    if (typeof actual !== 'string' || typeof recorded !== 'string') return false;
    if (actual === recorded) return true;
    if (!recorded.includes('{{')) return false;
    const pattern = recorded.split(/\{\{[A-Za-z][A-Za-z0-9]*(?:[+-]\d{1,3})?\}\}/).map(escapeRegExp).join('[^/]+');
    return new RegExp(`^${pattern}$`).test(actual);
};

const relativeUrl = (url, base) => {
    const parsed = new URL(url);
    return parsed.origin === new URL(base).origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : url;
};

/**
 * Records what actually moved the run forward: successful steps, no failed attempts and nothing read-only. The target is
 * resolved before the action, because afterwards the element is often gone.
 * @param recordTarget (locator, framework) => the locator code to record, or null; recordLocator on the application's main frame
 * @param red          () => a draft's step that must fail while the bug is there, or undefined: for it the recorder keeps exactly
 *                     one failing check, the last one that evaluated (a check that threw proves nothing)
 */
export const createRecorder = ({ handler, session, base, authMarker, runTag, remembered = new Map(), now = () => new Date(), red = () => undefined, recordTarget = (locator, framework) => recordLocator(session.page().mainFrame(), locator, { framework: framework.name }) }) => {
    const steps = [];
    const problems = [];
    // Messages belong to the action after which they were visible and are dropped with it. Otherwise e.g. a validation dialog
    // from a misclick would count as known forever. What is visible before the first action stays.
    const initial = new Set();
    const seenAfter = [];
    // Remembered values, longest first in case one contains another. Pre-remembered ones come from earlier steps.
    const placeholders = new Map([...remembered].map(([placeholder, value]) => [value, placeholder]));
    const keep = (step) => {
        // Two consecutive wait-ready become one: the more specific wait and the longer timeout win.
        const previous = steps.at(-1);
        if (step.action === 'wait-ready' && previous?.action === 'wait-ready') {
            const timeoutMs = Math.max(previous.timeoutMs ?? 0, step.timeoutMs ?? 0);
            steps[steps.length - 1] = { ...previous, ...step, ...(timeoutMs === 0 ? {} : { timeoutMs }) };
            return;
        }
        steps.push(step);
        seenAfter.push(new Set());
    };
    // Remembered values first and only as whole tokens: if one contains the run tag, e.g. "Bestellung CAW-1", it would be lost
    // otherwise. Then the run tag, unique and everywhere. Then dates close to today: they become relative, otherwise the test
    // would fail the next day.
    // The decision for a dialog the current command opened: it belongs on the action that is recorded for it.
    let openedDialog;
    const add = (given) => {
        const step = openedDialog === undefined ? given : { ...given, dialog: openedDialog };
        openedDialog = undefined;
        const named = [...placeholders].sort(([a], [b]) => b.length - a.length).reduce((current, [value, placeholder]) => swapToken(current, value, placeholder), step);
        const { target, ...rest } = named;
        const today = now();
        const marked = markDates(runTag === undefined ? rest : tagRun(rest, runTag), today, session.browser?.locale);
        if (target === undefined) {
            keep(marked);
            return;
        }
        // The target only through its string arguments: the run tag in names, texts and selectors, dates near today too.
        // In a regular expression the run tag as written there, escaped; dates there stay as they are.
        const markedTarget = mapTarget(target, (text, kind) => {
            if (kind === 'regex') return runTag === undefined ? text : swapText(swapText(text, escapeRegex(runTag), RUN_TAG_PLACEHOLDER), escapeRegex(runTag.toLowerCase()), RUN_TAG_LOWER_PLACEHOLDER);
            return markDates(runTag === undefined ? text : tagRun(text, runTag), today, session.browser?.locale);
        });
        keep({ action: marked.action, target: markedTarget, ...marked });
    };
    const currentPath = () => {
        try {
            return { path: new URL(session.page().url()).pathname };
        } catch {
            return {};
        }
    };
    // Baselines (requests, effects) are not created here: under Claude's control there are misclicks and detours that get
    // dropped from the recording. The first healthy `run` of the cleaned recording fills them in.
    return {
        steps,
        problems,
        get messages() {
            return new Set([...initial, ...seenAfter.flatMap((seen) => [...seen])]);
        },
        /**
         * The same messages per step: what was visible after an action belongs to the step of the next check (groupSteps), after
         * a check to that check's step, before the first action to the first step. Actions after the last check belong to none.
         */
        get messagesByStep() {
            const by = new Map();
            let owner;
            for (let index = steps.length - 1; index >= 0; index -= 1) {
                if (steps[index].action === 'check') owner = steps[index].id;
                if (owner === undefined) continue;
                const seen = by.get(owner) ?? new Set();
                for (const message of [...seenAfter[index], ...(index === 0 ? initial : [])]) seen.add(message);
                by.set(owner, seen);
            }
            return by;
        },
        /** Steps the human demonstrated in the live browser. */
        addSteps: (shown) => shown.forEach(add),
        /** The numbered list from which the agent names its detours. */
        list: () => steps.map((step, index) => `${index + 1} ${stepLabel(step)}`),
        /**
         * Forgets the checks of these steps; their actions then belong to the next check.
         * @returns what restoreChecks needs to put them back, in their order: [{ step, anchor (the step before it or null), seen }]
         */
        forgetChecks: (ids) => {
            const taken = [];
            for (let index = steps.length - 1; index >= 0; index -= 1) {
                if (steps[index].action !== 'check' || !ids.has(steps[index].id)) continue;
                const [step] = steps.splice(index, 1);
                const [seen] = seenAfter.splice(index, 1);
                for (const message of seen) (index === 0 ? initial : seenAfter[index - 1]).add(message);
                taken.unshift({ step, anchor: index === 0 ? null : steps[index - 1], seen: [...seen] });
            }
            return taken;
        },
        /**
         * Puts forgotten checks back behind the step they followed, in order, as long as that step is still there (an omit may
         * have dropped it). @returns the ids put back
         */
        restoreChecks: (entries) => {
            const restored = [];
            for (const { step, anchor, seen } of entries) {
                const at = anchor === null ? 0 : steps.indexOf(anchor) + 1;
                if (anchor !== null && at === 0) break;
                steps.splice(at, 0, step);
                seenAfter.splice(at, 0, new Set(seen));
                restored.push(step.id);
            }
            return restored;
        },
        /** Drops steps. Afterwards two wait-ready may follow each other; one is enough. */
        drop: (numbers) => {
            const kept = steps.map((step, index) => [step, seenAfter[index]]).filter((_pair, index) => !numbers.includes(index + 1));
            steps.length = 0;
            seenAfter.length = 0;
            for (const [step, seen] of kept) {
                keep(step);
                for (const message of seen) seenAfter.at(-1).add(message);
            }
        },
        handler: async (command) => {
            // What is visible before the command belongs to the flow: between two commands the page had time to react.
            const state = await readPageState(session.framework ?? frameworkOf(), session.page(), authMarker, session.messageSelectors).catch(() => null);
            // Status notes too: a banner that is always there should not warn as new on every run.
            for (const message of [...(state?.messages ?? []), ...(state?.notes ?? [])]) (steps.length === 0 ? initial : seenAfter.at(-1)).add(message);
            const framework = session.framework ?? frameworkOf();
            let target;
            let hint = null;
            if (TARGETED.has(command?.action) && typeof command.target === 'string') {
                let locator = null;
                try {
                    locator = locatorFor(session.page(), command.target);
                } catch {
                    locator = null;
                }
                // Before the action: afterwards the element is often gone.
                target = locator === null ? null : await recordTarget(locator, framework);
                if (target !== null && framework.hint !== undefined) {
                    const element = await locator.elementHandle({ timeout: HINT_TIMEOUT_MS }).catch(() => null);
                    if (element !== null) hint = await elementHint(framework, element);
                    await element?.dispose().catch(() => {});
                }
            }
            if (command?.action === 'dragTo' && typeof command.to === 'string') {
                let to = null;
                try {
                    to = locatorFor(session.page(), command.to);
                } catch {
                    to = null;
                }
                hint = { ...(hint ?? {}), to: to === null ? null : await recordTarget(to, framework) };
            }
            const path = currentPath();
            const acting = OPENS_DIALOG.has(command?.action);
            if (acting) session.dialogs?.begin();
            let value;
            let dialogs = [];
            try {
                value = await handler(command);
            } catch (error) {
                // As the URL parser writes it (no line break survives), or not at all: it lands in the recording and in the export.
                const denied = command?.action === 'goto' && error.code === 'host-blocked' ? parsedUrl(command.url) : null;
                if (denied !== null) add({ action: 'goto', url: denied, denied: true });
                throw error;
            } finally {
                if (acting) dialogs = session.dialogs?.end() ?? [];
            }
            openedDialog = recordedDialog(dialogs);
            switch (command.action) {
                case 'hover':
                    if (target === null) problems.push(t('session.replay.unstableTarget', { action: command.action, target: command.target }));
                    else add({ action: 'hover', target, ...(hint ?? {}), ...path });
                    break;
                case 'dragTo':
                    if (target === null || hint?.to === null) problems.push(t('session.replay.unstableTarget', { action: command.action, target: target === null ? command.target : command.to }));
                    else add({ action: 'dragTo', target, ...hint, ...path });
                    break;
                case 'click':
                case 'dblclick':
                case 'fill':
                case 'type':
                    // An optional click without a target did nothing: nothing to record.
                    if (value === 'absent') break;
                    if (target === null) problems.push(t('session.replay.unstableTarget', { action: command.action, target: command.target }));
                    else add({ action: command.action, target, ...(hint ?? {}), ...path, ...(command.value === undefined ? {} : { value: command.value }), ...(command.action === 'click' && command.optional === true ? { optional: true } : {}) });
                    break;
                case 'upload':
                    if (target === null) problems.push(t('session.replay.unstableTarget', { action: command.action, target: command.target }));
                    else add({ action: 'upload', target, ...(hint ?? {}), ...path, files: value.files });
                    break;
                case 'press': add({ action: 'press', key: command.key }); break;
                case 'goto': add({ action: 'goto', url: relativeUrl(command.url, base) }); break;
                case 'reload': add({ action: 'reload' }); break;
                case 'screenshot': add({ action: 'screenshot', name: command.name }); break;
                case 'wait-ready':
                    // A custom timeout also applies on playback: if the page needed longer while recording, it will again.
                    if (value?.settled) add({ action: 'wait-ready', ...(command.for === undefined ? {} : { for: command.for }), ...(command.minCount === undefined ? {} : { minCount: command.minCount }), ...(Number.isFinite(command.timeout) ? { timeoutMs: command.timeout } : {}) });
                    break;
                case 'check':
                    if (value?.pass) add({ action: 'check', id: command.id, code: command.code });
                    // The red step's check fails while the bug is there; it counts once it evaluated. Checked again, the last
                    // one counts (groupSteps), so the recording keeps exactly one.
                    else if (value?.pass === false && command.id !== undefined && command.id === red()) add({ action: 'check', id: command.id, code: command.code });
                    break;
                case 'remember':
                    add({ action: 'remember', name: value.name, code: command.code });
                    placeholders.set(value.value, `{{${value.name}}}`);
                    break;
                default:
            }
            openedDialog = undefined;
            // Claude learns what happened to a dialog its action opened: answered as armed, or dismissed because nothing was armed.
            if (dialogs.length === 0) return value;
            const [first] = dialogs;
            return { result: value, dialog: { type: first.type, message: first.message, decision: first.decided === 'dismissed' ? 'dismissed' : first.accept ? 'accepted' : 'dismissed' } };
        },
    };
};

/**
 * Reads `omit` from the verdict: [12, "14-16"]. Checks are the yardstick and can never be dropped. Numbers and lengths
 * are bounded too, since the input comes from the agent.
 * @returns the numbers, ascending
 */
export const dropNumbers = (steps, wanted) => {
    if (wanted === undefined) return [];
    const reject = (message) => new CawError('finish-rejected', `omit: ${message}`);
    if (!Array.isArray(wanted)) throw reject('Expected a list like [12, "14-16"].');
    const numbers = new Set();
    for (const entry of wanted) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(String(entry));
        if (match === null) throw reject(`"${String(entry).slice(0, 40)}" is not a number.`);
        const from = Number(match[1]);
        const to = Number(match[2] ?? match[1]);
        if (from < 1 || to > steps.length || from > to) throw reject(`${String(entry).slice(0, 40)} is outside 1 to ${steps.length}.`);
        for (let number = from; number <= to; number += 1) numbers.add(number);
    }
    for (const number of numbers) {
        if (steps[number - 1].action === 'check') throw reject(`Step ${number} is a check (${steps[number - 1].id}) and stays.`);
        if (steps[number - 1].action === 'remember') throw reject(`Step ${number} remembers ${steps[number - 1].name} and stays.`);
    }
    return [...numbers].sort((a, b) => a - b);
};

/**
 * What the tool cleans up itself, in addition to Claude's `omit`: screenshots only document the run, and of a field filled
 * twice only the last value counts. A wait-ready in between changes nothing.
 * @returns the numbers, ascending
 */
export const tidyNumbers = (steps, omitted = []) => {
    const remaining = steps.map((step, index) => ({ step, number: index + 1 })).filter(({ number }) => !omitted.includes(number));
    const numbers = [];
    remaining.forEach(({ step, number }, position) => {
        if (step.action === 'screenshot') numbers.push(number);
        if (step.action !== 'fill') return;
        const next = remaining.slice(position + 1).find((later) => later.step.action !== 'wait-ready' && later.step.action !== 'screenshot');
        if (next?.step.action === 'fill' && JSON.stringify(next.step.target) === JSON.stringify(step.target)) numbers.push(number);
    });
    return numbers;
};

/**
 * Whatever remains after the last check belongs to no step.
 * @returns the numbers, ascending
 */
export const trailingNumbers = (steps, omitted = []) => {
    const remaining = steps.map((step, index) => ({ step, number: index + 1 })).filter(({ number }) => !omitted.includes(number));
    const last = remaining.findLastIndex(({ step }) => step.action === 'check');
    return remaining.slice(last + 1).map(({ number }) => number);
};

/** All actions since the last check belong to that check's step. If Claude checks again, the last one counts. */
export const groupSteps = (steps) => {
    const groups = new Map();
    let pending = [];
    for (const step of steps) {
        if (step.action !== 'check') {
            pending.push(step);
            continue;
        }
        const group = groups.get(step.id) ?? { actions: [] };
        group.actions.push(...pending);
        group.check = step.code;
        groups.set(step.id, group);
        pending = [];
    }
    return { groups, trailing: pending };
};

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
const usedNames = (value) => [...JSON.stringify(value).matchAll(PLACEHOLDER)].map(([, name]) => name).filter((name) => !RUN_TAG_NAMES.has(name) && !DATE_NAMES.has(name));

/** Every step must know its placeholders from an earlier step or itself, otherwise it only fails on playback. */
export const missingRemembered = (spec) => {
    const known = new Set();
    const problems = [];
    for (const { id, recording } of spec.steps) {
        for (const action of recording?.actions ?? []) {
            if (action.action === 'remember') known.add(action.name);
            else for (const name of usedNames(action)) if (!known.has(name)) problems.push(`${id} needs {{${name}}}, which no earlier step remembers.`);
        }
        for (const name of usedNames(recording?.check ?? '')) if (!known.has(name)) problems.push(`${id} needs {{${name}}}, which no earlier step remembers.`);
    }
    return [...new Set(problems)];
};

/**
 * Only a passed run that proves every step itself becomes repeatable.
 * @param spec   the approved plan
 * @param draft  when fixing, the whole test in which exactly this one step is replaced
 * @param from   with `draft`: re-recorded from this step on. The steps before it stay as they are, `spec` replaces all steps
 *               from it to the end (added, removed, reordered)
 * @param browser { locale, timezone, viewport } of the recording browser, stored with every step
 * @param red     a draft's step that must fail while the bug is there: a verdict where only it failed, with its check
 *                recorded, is a recording too
 * @returns { problems, candidate, fresh, baseline }; `fresh` lists messages the recording did not know so far, `baseline` those
 *          of them seen only in steps without a recording before
 */
export const buildReplay = ({ recorder, outcome, spec, target, draft, from, previous, red, browser = {}, now = new Date() }) => {
    const problems = [...recorder.problems];
    // All steps proven, only a hard failure on the way, e.g. in a dropped failed attempt: the check run without Claude settles that.
    const onlyHardFailures = outcome?.status === 'fail' && outcome.failures?.length > 0 && outcome.results.every(({ status }) => status === 'pass');
    // The draft's red step failed as it should: the check run without Claude shows whether it fails there again.
    const onlyRed = red !== undefined && outcome?.status === 'fail' && (outcome.results ?? []).some(({ id, status }) => id === red && status === 'fail')
        && outcome.results.every(({ id, status }) => status === 'pass' || id === red);
    if (outcome?.status !== 'pass' && !onlyHardFailures && !onlyRed) problems.push(t('session.replay.endedWith', { status: outcome?.status ?? t('session.replay.noVerdict') }));
    const { groups, trailing } = groupSteps(recorder.steps);
    const missing = spec.steps.map(({ id }) => id).filter((id) => !groups.has(id));
    if (missing.length > 0) problems.push(t('session.replay.withoutCheck', { ids: missing.join(', ') }));
    if (trailing.length > 0) problems.push(t('session.replay.trailing', { actions: trailing.map(stepLabel).join(', ') }));
    const strays = [...groups.keys()].filter((id) => !spec.steps.some((step) => step.id === id));
    if (strays.length > 0) problems.push(t('session.replay.strays', { ids: strays.join(', ') }));
    if (problems.length > 0) return { problems };

    // Re-recorded from a step on: the steps before it are kept, recordings, baselines and effects included.
    const kept = draft !== undefined && from !== undefined ? draft.steps.slice(0, Math.max(0, draft.steps.findIndex(({ id }) => id === from))) : undefined;
    const order = (kept === undefined ? (draft ?? spec).steps : [...kept, ...spec.steps]).map(({ id }) => id);
    // Manual settings survive fixing (draft) as well as re-recording an existing test (previous): Claude does not know them.
    const prior = draft ?? previous;
    // A value manually marked secret stays secret, even if Claude re-records the step.
    const secret = new Set((prior?.steps ?? []).flatMap(({ recording }) => recording?.actions ?? []).filter(({ action, secret: hidden }) => action === 'remember' && hidden === true).map(({ name }) => name));
    const recorded = spec.steps.map((step) => {
        const before = order[order.indexOf(step.id) - 1];
        const { check } = groups.get(step.id);
        const actions = groups.get(step.id).actions.map((action) => (action.action === 'remember' && secret.has(action.name) ? { ...action, secret: true } : action));
        // A manually set check timeout, as long as the step expects the same result.
        const old = prior?.steps.find(({ id }) => id === step.id);
        const timeoutMs = old !== undefined && (old.expect ?? '') === (step.expect ?? '') ? old.recording?.timeoutMs : undefined;
        return {
            ...step,
            recording: {
                hash: stepHash(step),
                ...(before === undefined ? {} : { after: before }),
                recordedOn: target,
                recordedAt: now.toISOString(),
                // The browser's language and time zone: replay pins them, wherever it runs.
                ...(typeof browser.locale === 'string' ? { locale: browser.locale } : {}),
                ...(typeof browser.timezone === 'string' ? { timezone: browser.timezone } : {}),
                ...(isViewport(browser.viewport) ? { viewport: { width: browser.viewport.width, height: browser.viewport.height } } : {}),
                actions,
                check,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            },
        };
    });
    const messages = recorder.messages ?? new Set();
    // Manual patterns stay, after the fixed texts; what a pattern already covers is not added as fixed text.
    // On re-recording only the patterns: the new recording brings the old fixed texts itself, as far as they still appear.
    const given = draft?.knownMessages ?? (previous?.knownMessages ?? []).filter((entry) => typeof entry !== 'string');
    const known = textMatcher(given);
    const seen = [...messages].filter((message) => !known(message)).sort();
    // Newly known is what the previous recording did not know yet: its fixed texts showing again change nothing it checks.
    const before = draft === undefined ? textMatcher((previous?.knownMessages ?? []).filter((entry) => typeof entry === 'string')) : () => false;
    const fresh = seen.filter((message) => !before(message));
    // A whole recording: newly known messages seen only in steps that had no recording before (all of them in a first
    // recording, a pending tail recorded now) are those steps' baseline, not a change (decisions.mjs harmlessAdopt).
    const recordedBefore = new Set((previous?.steps ?? []).filter(({ recording }) => recording !== undefined).map(({ id }) => id));
    const byStep = [...(recorder.messagesByStep ?? new Map())];
    const baseline = draft !== undefined ? [] : fresh.filter((message) => {
        const at = byStep.filter(([, inStep]) => inStep.has(message)).map(([id]) => id);
        return at.length > 0 && at.every((id) => !recordedBefore.has(id));
    });
    const texts = given.filter((entry) => typeof entry === 'string');
    // Each recorded step keeps the messages it made known, those it showed that no pattern covers (caw audit tells a step's
    // first recording, its baseline, from a step that knows more than before).
    const covered = textMatcher(given.filter((entry) => typeof entry !== 'string'));
    const shown = new Map(byStep);
    const withKnown = recorded.map((step) => {
        const made = [...(shown.get(step.id) ?? [])].filter((message) => !covered(message)).sort();
        return made.length === 0 ? step : { ...step, recording: { ...step.recording, known: made } };
    });
    const candidate = withExpectations({
        ...(draft ?? spec),
        steps: kept !== undefined ? [...kept, ...withKnown] : draft === undefined ? withKnown : draft.steps.map((step) => withKnown.find(({ id }) => id === step.id) ?? step),
        knownMessages: [...[...new Set([...texts, ...seen])].sort(), ...given.filter((entry) => typeof entry !== 'string')],
    });
    const lost = missingRemembered(candidate);
    return lost.length > 0 ? { problems: lost } : { problems, candidate, fresh, baseline };
};

/**
 * A target chosen by position (nth, first, last, or a bare tag name): with one more match or a different order it hits another
 * element, and a generic check still passes.
 */
const positional = (target) => {
    try {
        return typeof target === 'string' && isPositional(target);
    } catch {
        return false;
    }
};

/** Actions of the given steps whose target is chosen by position, e.g. ['S2 click button [2]']. */
export const positionalActions = (spec, ids) => spec.steps.filter(({ id }) => ids === undefined || ids.has(id)).flatMap(({ id, recording }) => (recording?.actions ?? [])
    .filter(({ target }) => positional(target)).map((action) => `${id} ${stepLabel(action)}`));

/**
 * Checks before a browser opens: anything stale names the command that fixes it. Without `until` the whole test must be
 * playable; with `pending` a pending tail (pendingSteps) may stay open, then the check ends at the last recorded step.
 */
export const assertPlayable = (spec, target, until, { pending = false } = {}) => {
    if (spec.steps.every(({ recording }) => recording === undefined)) {
        throw new CawError('replay-missing', t('session.replay.missing', { id: spec.id, target }));
    }
    const open = pendingSteps(spec);
    let last = until;
    if (last === undefined && open.length > 0) {
        if (!pending) throw new CawError('replay-pending', t('session.replay.pendingStrict', { ids: open.join(', '), count: open.length, id: spec.id, step: open[0], target }));
        last = spec.steps[spec.steps.length - open.length - 1].id;
    }
    const end = last === undefined ? spec.steps.length : spec.steps.findIndex(({ id }) => id === last) + 1;
    const reached = { ...spec, steps: spec.steps.slice(0, end) };
    const chain = brokenChain(reached);
    if (chain !== null) throw new CawError('replay-stale', t('session.replay.chainStale', { chain, id: spec.id, step: brokenChainAt(reached).id, target }));
    const [stale] = staleSteps(reached);
    // A pending step on the way (open @S5 behind a pending S4) is not stale: it was never recorded, so it gets recorded first.
    if (stale !== undefined && open.includes(stale.id)) throw new CawError('replay-stale', t('session.replay.stepPending', { step: stale.id, id: spec.id, target }));
    if (stale !== undefined) throw new CawError('replay-stale', t('session.replay.stepStale', { step: stale.id, why: stale.why, id: spec.id, target }));
};

/**
 * Learned effects only apply to the state in which they were learned: `basis` is the recording time of the previous step. If
 * an earlier step is fixed, the next one may start in a different state, and its effects are learned anew.
 */
const basisOf = (spec, step) => spec.steps[spec.steps.findIndex(({ id }) => id === step.id) - 1]?.recording?.recordedAt;
const currentEffects = (spec, step) => {
    const effects = step.recording?.effects;
    return effects === undefined || effects.basis === undefined || effects.basis === basisOf(spec, step) ? effects : undefined;
};
const withBasis = (spec, step, effects) => {
    const basis = basisOf(spec, step);
    const rest = { ...effects };
    delete rest.basis;
    return basis === undefined ? rest : { ...rest, basis };
};

/**
 * Language, time zone and viewport the steps were recorded in, from the newest recorded step that has them; {} while nothing is
 * recorded. The browser of a replay gets them, so dates, numbers and layout look as they did while recording.
 */
export const recordedBrowser = (steps) => {
    const recordings = steps.map((step) => step.recording).filter((entry) => entry !== undefined);
    const recording = recordings.filter((entry) => entry.locale !== undefined || entry.timezone !== undefined).at(-1);
    const viewport = recordings.map((entry) => entry.viewport).filter((entry) => entry !== undefined).at(-1);
    return {
        ...(recording?.locale === undefined ? {} : { locale: recording.locale }),
        ...(recording?.timezone === undefined ? {} : { timezone: recording.timezone }),
        ...(viewport === undefined ? {} : { viewport }),
    };
};

const flatten = (spec, steps, until) => ({
    test: spec.id,
    recordedOn: steps.at(-1)?.recording?.recordedOn,
    browser: recordedBrowser(steps),
    ...(spec.knownMessages === undefined ? {} : { knownMessages: spec.knownMessages }),
    ...(until === undefined ? {} : { until }),
    retries: Object.fromEntries(steps.filter(({ retry }) => retry !== undefined).map(({ id, retry }) => [id, retry])),
    // Baseline from the recording: it shows whether a new attempt can change anything at all.
    baselines: Object.fromEntries(steps.filter(({ recording }) => recording?.network !== undefined).map(({ id, recording }) => [id, recording.network])),
    // Effects per action from healthy runs: they show the first action after which the app behaves differently.
    effects: Object.fromEntries(steps.filter((step) => currentEffects(spec, step) !== undefined).map((step) => [step.id, currentEffects(spec, step)])),
    // Target designs per step, judged once its check passed, at the viewport the step was recorded in.
    designs: Object.fromEntries(steps.filter(({ design }) => design !== undefined).map(({ id, design, recording }) => [id, { file: design, ...(recording?.viewport === undefined ? {} : { viewport: recording.viewport }) }])),
    steps: steps.flatMap(({ id, expect, recording }) => [
        ...recording.actions,
        // The expectation goes along: a check that is not met names it, the code stays in the report's evidence.
        { action: 'check', id, code: recording.check, ...(expect === undefined ? {} : { expect }), ...(recording.timeoutMs === undefined ? {} : { timeoutMs: recording.timeoutMs }) },
    ]),
});

/**
 * The actions of all recorded steps in one row, as they are played back. A pending tail (pendingSteps) does not play: `until`
 * marks the last recorded step, so only the steps up to it count for the run, and `pending` names the rest.
 */
export const replayOf = (spec) => {
    const pending = pendingSteps(spec);
    if (pending.length === 0) return flatten(spec, spec.steps);
    const recorded = spec.steps.slice(0, spec.steps.length - pending.length);
    // What the first pending step needs on the page before it can be recorded: checked when the run ends there.
    const { needs, design } = spec.steps[recorded.length];
    // Its target design, judged at its entry when the run ends there: a preview while it is built (playReplay).
    const viewport = recordedBrowser(recorded).viewport;
    return {
        ...flatten(spec, recorded, recorded.at(-1).id),
        pending,
        ...(needs === undefined ? {} : { needs: { step: pending[0], locators: needs } }),
        ...(design === undefined ? {} : { pendingDesign: { step: pending[0], file: design, ...(viewport === undefined ? {} : { viewport }) } }),
    };
};

/**
 * The part of the recording up to a state. Nothing happens after it, not even a write.
 * `until` marks the result: later steps do not count for the run.
 */
export const cutReplay = (spec, until) => {
    const end = spec.steps.findIndex(({ id }) => id === until);
    if (end === -1) throw new CawError('step-unknown', t('session.replay.stepUnknown', { id: spec.id, until }));
    return flatten(spec, spec.steps.slice(0, end + 1), until);
};

/** What has to run before a step in order to fix it. */
export const replayBefore = (spec, id) => {
    const end = spec.steps.findIndex((step) => step.id === id);
    return flatten(spec, spec.steps.slice(0, end));
};

// The actions that only lead into a step; the first other action (an input, a key, a download, remember, a check) starts its work.
const ENTRY_ACTIONS = new Set(['goto', 'click', 'dblclick', 'wait-ready']);
const INPUT_ACTIONS = new Set(['fill', 'type', 'upload']);
/** Did the action send a write request in healthy runs? Learned effects name requests as `<request name> <status>`. */
const writesIn = (effect, reads) => (effect?.requests ?? []).some((line) => classifyRequest(String(line), reads) === 'write');

/**
 * At the entry of a step: all steps before it completely, with their checks, then the step's leading navigation (goto, click,
 * wait-ready) up to its first other action. Its inputs, its check and everything after it stay open. The entry actions are
 * marked with `entry` (the step's id): playback attributes them to that step but neither compares nor learns their effects.
 * Guards, in `entry.skipped`: `inputs` (the step has no input at all, e.g. only a submit click: nothing of it runs), `write` (stops
 * before an entry click whose learned effects write) and `recording` (the step is not recorded or stale: nothing of it runs).
 * `until` is the last step played completely, if any.
 * @param reads the config's `reads` patterns: what they name does not stop the entry
 */
export const replayToEntry = (spec, id, { reads = [] } = {}) => {
    const readMatchers = compileReads(reads);
    const end = spec.steps.findIndex((step) => step.id === id);
    if (end === -1) throw new CawError('step-unknown', t('session.replay.stepUnknown', { id: spec.id, until: id }));
    const step = spec.steps[end];
    const before = flatten(spec, spec.steps.slice(0, end), spec.steps[end - 1]?.id);
    const entry = { id, name: String(step.name ?? '') };
    const actions = [];
    let usable = step.recording !== undefined;
    try {
        if (usable) assertPlayable(spec, spec.steps[0]?.recording?.recordedOn, id);
    } catch {
        usable = false;
    }
    if (!usable) entry.skipped = 'recording';
    else if (!step.recording.actions.some(({ action }) => INPUT_ACTIONS.has(action))) entry.skipped = 'inputs';
    else {
        const effects = currentEffects(spec, step);
        for (const [index, action] of step.recording.actions.entries()) {
            if (!ENTRY_ACTIONS.has(action.action)) break;
            if ((action.action === 'click' || action.action === 'dblclick') && writesIn(effects?.actions?.find((effect) => effect.action === index + 1), readMatchers)) {
                entry.skipped = 'write';
                break;
            }
            actions.push({ ...action, entry: id });
        }
    }
    return {
        ...before,
        recordedOn: before.recordedOn ?? step.recording?.recordedOn,
        browser: recordedBrowser(spec.steps.slice(0, actions.length > 0 ? end + 1 : end)),
        entry,
        steps: [...before.steps, ...actions],
    };
};

/** The check run: up to the first step that is still stale. That one gets fixed next anyway. */
export const replayUpToStale = (spec) => {
    const [stale] = staleSteps(spec);
    const end = stale === undefined ? spec.steps.length : spec.steps.findIndex(({ id }) => id === stale.id);
    if (end === spec.steps.length) return flatten(spec, spec.steps);
    return flatten(spec, spec.steps.slice(0, end), spec.steps[end - 1]?.id);
};

export const stepLabel = (step) => {
    switch (step.action) {
        case 'click': return `click ${locatorLabel(step.target)}${step.optional === true ? ' (optional)' : ''}`;
        case 'dblclick':
        case 'fill':
        case 'type': return `${step.action} ${locatorLabel(step.target)}`;
        case 'upload': return `upload ${locatorLabel(step.target)} ${step.files.join(', ')}`;
        case 'download': return `download ${locatorLabel(step.target)} /${step.file}/`;
        case 'hover': return `hover ${locatorLabel(step.target)}`;
        case 'dragTo': return `drag ${locatorLabel(step.target)} to ${locatorLabel(step.to)}`;
        case 'press': return `press ${step.key}`;
        case 'goto': return `goto ${step.url}`;
        case 'screenshot': return `screenshot ${step.name}`;
        case 'check': return `check ${step.id}`;
        case 'remember': return `remember ${step.name}`;
        default: return step.action;
    }
};

/** A dialog finding of replay (dialogFindings) as a warning of the run. */
const dialogWarning = (finding, action) => {
    const shown = (dialog) => t('session.dialog.shown', { type: dialog.type, message: String(dialog.message ?? '').slice(0, 120) });
    if (finding.type === 'dialog-missing') return { type: 'dialog-missing', text: t('session.dialog.missing', { action, type: finding.expected.type }) };
    if (finding.type === 'dialog-type') return { type: 'dialog-type', text: t('session.dialog.otherType', { action, expected: finding.expected.type, dialog: shown(finding.dialog) }) };
    return { type: 'dialog-unexpected', text: t('session.dialog.unexpected', { action, dialog: shown(finding.dialog) }) };
};

/** How the workbench names an element: its text in quotes, otherwise its kind, e.g. button [2]. */
const shownTarget = (target) => {
    const shown = locatorText(target);
    return shown === undefined ? locatorLabel(target) : t('session.point.quoted', { text: shown });
};

/**
 * An action of the recording as a point in the step list: kind and short description. Entered values never appear,
 * they could be a password.
 * @param expects  expectation per step ID, for the text of a check
 * @returns { kind, label }
 */
export const stepPoint = (step, expects = new Map()) => {
    switch (step.action) {
        case 'click': return { kind: t('session.point.click'), label: shownTarget(step.target) };
        case 'dblclick': return { kind: t('session.point.dblclick'), label: shownTarget(step.target) };
        case 'fill':
        case 'type': return { kind: t('session.point.type'), label: shownTarget(step.target) };
        case 'upload': return { kind: t('session.point.upload'), label: shownTarget(step.target) };
        case 'download': return { kind: t('session.point.download'), label: shownTarget(step.target) };
        case 'hover': return { kind: t('session.point.hover'), label: shownTarget(step.target) };
        case 'dragTo': return { kind: t('session.point.drag'), label: t('session.point.dragTo', { from: shownTarget(step.target), to: shownTarget(step.to) }) };
        case 'press': return { kind: t('session.point.press'), label: step.key };
        case 'goto': return { kind: t('session.point.goto'), label: step.url };
        case 'reload': return { kind: t('session.point.reload'), label: t('session.point.page') };
        case 'screenshot': return { kind: t('session.point.screenshot'), label: step.name };
        case 'wait-ready': return { kind: t('session.point.wait'), label: t('session.point.pageQuiet') };
        case 'check': return { kind: t('session.point.check'), label: expects.get(step.id) ?? step.id };
        case 'remember': return { kind: t('session.point.remember'), label: step.name };
        default: return { kind: step.action, label: '' };
    }
};

/**
 * The steps as workbench groups, one point per recorded action with its position as ID (`a<position>`).
 * Steps without recorded actions (not recorded yet) have no points.
 */
export const stepGroups = (steps, replay) => {
    const expects = new Map(steps.map(({ id, expect }) => [id, expect]));
    const points = new Map(steps.map(({ id }) => [id, []]));
    let owner = null;
    (replay?.steps ?? []).forEach((step, index) => {
        // As on playback: an action belongs to the next check; what comes after the last one belongs to the last, the entry of a
        // step (replayToEntry) to that step.
        owner = step.entry ?? replay.steps.slice(index).find(({ action }) => action === 'check')?.id ?? owner;
        points.get(owner)?.push({ id: `a${index + 1}`, ...stepPoint(step, expects) });
    });
    return steps.map(({ id, name }) => ({ id, name, points: points.get(id) ?? [] }));
};

/**
 * Plays back a recording. There are no fixed pauses: every step waits for its condition until its timeout expires.
 * The verdict also goes through the handler, so hard console errors count as they do for the agent.
 *
 * @param filesDir  the project's caw folder: files for upload live there, e.g. caw/fixtures/.
 */
/**
 * @param judgeDesign (design, page) => judged design (design.mjs createDesignJudge); without it designs are not judged
 * @param designFail  config design.fail: with 'target' a design not met fails its step, otherwise it only warns
 * @param reads       the config's `reads` patterns: what they name is no write when a renamed target is proposed
 * @param capture     (id) => the step's screen (visual.mjs captureStep), taken at most once per passed check, for the
 *                    screenshot; without it nothing visual is captured
 * @param look        (id, { capture, page }) => { record?, observed?, fail?, warnings? } after the design: screenshot
 *                    and visual regression (run.mjs); `fail` { kind, text, evidence } fails the passed step without stopping
 * @param hintLook    (id, { page, texts }) => { served, masks } after a passed step, for the look suggestion after a recording
 *                    (look-hints.mjs); returned per step as `lookHints`, only in memory
 */
export const playReplay = async ({ replay, handler, session, base, authMarker, stepTimeoutMs, runTag, filesDir, reads = [], log = () => {}, sleep = sleepMs, now = Date.now, effectFail = DEFAULT_EFFECT_FAIL, judgeDesign, designFail = DEFAULT_DESIGN_FAIL, capture, look, hintLook }) => {
    // Effects per action: what this run saw (last attempt) and the first deviation from the learned effects per step.
    const measure = session.trail === undefined ? null : createEffects({ session });
    const observed = new Map();
    const deviations = new Map();
    // Steps that only ran as warm-up for a new attempt: their effects are neither compared nor learned.
    const warmup = new Set();
    // Steps with a new attempt; the failing deviation key of the last attempt per step; and those that deviated the same twice.
    const retried = new Set();
    // Per step the repeated clicks that were skipped because the first one had already opened a dialog.
    const repeatSkipped = new Map();
    const effectKeys = new Map();
    const repeated = new Set();
    const results = new Map();
    // Steps whose check failed because it evaluated to something other than true, not because it threw: a draft's red step
    // counts as red only like that.
    const evaluated = new Set();
    // The judged target design per step (design.mjs), for result.json.
    const designs = new Map();
    // Per step what the visual layer found (screenshot, look) for result.json, and the look it saw, for learning.
    const looks = new Map();
    const seenLooks = new Map();
    // Per passed step whether its screen shows data that changes (hintLook), for the look suggestion.
    const lookHints = new Map();
    // What stopped the earlier attempts, per step. It stays visible in the report even if a later attempt passes.
    const history = new Map();
    // Steps whose retry did not run because a new attempt cannot change anything, with the reason.
    const skipped = new Map();
    // Per step the self-abort of the last attempt: only if it repeats is another attempt pointless.
    const aborts = new Map();
    /** The reason together with the earlier attempts. Equal reasons appear only once, otherwise long check expressions repeat. */
    const withTries = (id, reason) => {
        const tried = history.get(id);
        const why = skipped.has(id) ? ` ${skipped.get(id)}` : '';
        if (tried === undefined) return `${reason}${why}`;
        const others = [...new Set(tried)].filter((text) => text !== reason);
        if (others.length === 0) return t('session.replay.allTriesFailed', { count: tried.length + 1, reason, why });
        return t('session.replay.tryFailed', { count: tried.length + 1, reason, others: others.join('; '), why });
    };
    // The bare reason per failed check, without earlier attempts: only that goes into the history.
    const causes = new Map();
    const known = replay.knownMessages === undefined ? null : textMatcher(replay.knownMessages);
    // Unknown status notes fail nothing, they come and go with timing. The report lists each once as a warning.
    const noted = new Set();
    // Every message and status note per step, known or not: promoting a draft takes its red step's as known (commands.mjs).
    const shownMessages = new Map();
    const readState = async () => {
        const state = await readPageState(session.framework ?? frameworkOf(), session.page(), authMarker, session.messageSelectors).catch(() => null);
        if (activeOwner !== undefined) {
            const seen = shownMessages.get(activeOwner) ?? new Set();
            for (const message of [...(state?.messages ?? []), ...(state?.notes ?? [])]) if (typeof message === 'string' && message !== '') seen.add(message);
            if (seen.size > 0) shownMessages.set(activeOwner, seen);
        }
        for (const note of state?.notes ?? []) {
            if (known?.(note) || noted.has(note)) continue;
            noted.add(note);
            // The step being played, where one is: the CI reports name it like any other step's warning.
            session.warn?.({ type: 'note', ...(activeOwner === undefined ? {} : { step: activeOwner }), text: t('session.replay.newNote', { note: shownMessage(note) }) });
        }
        return state;
    };
    const unknownMessage = (state) => (known === null ? undefined : state?.messages.find((message) => !known(message)));

    /** Hard failure or unexpected message: the test fails, whether or not the next step would still work. */
    const externalProblem = async () => {
        const [failure] = session.failures?.() ?? [];
        if (failure !== undefined) return t('session.replay.hardFailure', { type: failure.type, text: failure.text });
        const message = unknownMessage(await readState());
        return message === undefined ? null : t('session.replay.unexpectedMessage', { message: shownMessage(message) });
    };

    /**
     * On every failure, not only a missing target: an expired session usually shows as an unmet check, as 401, 500 or HTML
     * instead of JSON. The sentence in the reason lets the classification attribute the consequences to the sign-in.
     */
    const LOST = t('session.replay.signInLost');
    const withSignIn = async (message) => {
        if (authMarker === undefined || message.includes(LOST)) return message;
        const state = await readState();
        return state !== null && state.signedIn === false ? `${message} ${LOST}` : message;
    };

    /** Why a target is missing: if the page itself is in a wrong state, there is nothing to fix in the step. */
    const stateProblem = (state, step, recorded) => {
        if (state === null) return t('session.replay.pageUnreadable');
        if (!state.appLoaded) return t('session.replay.appNotLoaded', { framework: (session.framework ?? frameworkOf()).label() });
        if (!state.signedIn) return LOST;
        if (state.loading) return t('session.replay.loadMask');
        if (step.path !== undefined && state.path !== step.path && !samePath(state.path, recorded?.path)) return t('session.replay.wrongPath', { actual: state.path, expected: step.path });
        const message = unknownMessage(state);
        return message === undefined ? null : t('session.replay.unexpectedMessage', { message: shownMessage(message) });
    };

    // Steps whose wait for a quiet page ran out: the report says so once per step instead of every action silently waiting.
    const unsettled = new Set();
    let activeOwner;
    const settle = async (timeoutMs) => {
        await session.page().waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
        const ready = await session.waitReady({ timeout: timeoutMs }).catch(() => null);
        if (ready?.settled !== false || activeOwner === undefined || unsettled.has(activeOwner)) return;
        unsettled.add(activeOwner);
        session.warn?.({ type: 'note', text: t('session.replay.notSettled', { step: activeOwner, seconds: Math.round(timeoutMs / 1000) }) });
    };

    /**
     * Files for upload, relative to the caw folder: only from caw/fixtures, also after links (never caw/.env or caw/.auth).
     * Anything missing or outside aborts before anything is clicked.
     */
    const uploadFiles = (files) => files.map((file) => {
        const path = filesDir === undefined ? null : fixturePath(filesDir, file);
        if (path === null) throw finalError(t('session.replay.uploadMissing', { file }), 'state');
        return join(filesDir, path);
    });
    // The page whose events belong to the element: in the workbench the app is a frame, the events come from the page.
    const pageOf = async (element) => {
        const frame = typeof element.ownerFrame === 'function' ? await element.ownerFrame().catch(() => null) : null;
        return frame?.page() ?? session.page();
    };
    /** A file input gets the files directly. A button in front opens the file chooser on click, which then gets them. */
    const upload = async (element, step, files, remaining) => {
        if (!await setFiles(element, files, { page: await pageOf(element), timeout: remaining })) {
            throw finalError(t('session.replay.noChooser', { target: locatorLabel(step.target) }));
        }
    };
    /** The click starts a download: its name matches the pattern and the file is not empty. */
    const download = async (element, step, remaining) => {
        const started = (await pageOf(element)).waitForEvent('download', { timeout: remaining }).catch(() => null);
        await element.click({ timeout: remaining, delay: CLICK_DELAY_MS });
        const file = await started;
        if (file === null) throw finalError(t('session.replay.noDownload', { target: locatorLabel(step.target), seconds: Math.round(remaining / 1000) }), 'check');
        const name = file.suggestedFilename();
        const path = await file.path().catch(() => null);
        const size = path === null || !existsSync(path) ? 0 : statSync(path).size;
        await file.delete?.().catch(() => {});
        if (!new RegExp(step.file).test(name)) throw finalError(t('session.replay.downloadName', { name, pattern: step.file }), 'check');
        if (size === 0) throw finalError(t('session.replay.downloadEmpty', { name }), 'check');
    };

    /**
     * @param previous the action before: if it is the same click on the same target and a dialog now lies on top, the first
     *                 click already took effect (e.g. "Cancel" opens the confirmation). The second is then skipped instead
     *                 of waiting for the timeout; whether the step is right is up to its check.
     * @returns 'skipped', 'absent' or undefined
     */
    const act = async (step, timeoutMs, previous) => {
        const deadline = now() + timeoutMs;
        const files = step.action === 'upload' ? uploadFiles(step.files) : [];
        const framework = session.framework ?? frameworkOf();
        // The application's main frame, fresh on every poll: with the workbench the frame in its iframe, which a reload replaces.
        const root = () => session.page().mainFrame();
        const label = locatorLabel(step.target);
        if (step.action === 'click' && previous?.action === 'click' && previous.target === step.target) {
            const { element } = await waitForLocator(framework, root, step.target, { timeoutMs: Math.min(timeoutMs, REPEAT_CLICK_MS), sleep, now });
            if (element !== null) await element.dispose().catch(() => {});
            else if ((await explainLocator(framework, root, step.target).catch(() => null))?.covered !== undefined) return 'skipped';
        }
        // Optional, e.g. the cookie banner on the first visit: if the target is not there, there is nothing to do ('absent').
        if (step.optional === true) {
            const { element } = await waitForLocator(framework, root, step.target, { timeoutMs: Math.min(timeoutMs, OPTIONAL_CLICK_MS), sleep, now });
            if (element === null) return 'absent';
            await element.dispose().catch(() => {});
        }
        // A disabled target can also be covered by the field that unlocks it (the open list of an ExtJS combobox): it only
        // becomes reachable once that field is left, so leave it before waiting, as the recording did.
        await leaveForDisabled(locatorFor(session.page(), step.target));
        for (;;) {
            const remaining = Math.max(deadline - now(), 1);
            // Exactly one reachable element: several that stay longer than a dialog transition fail instead of guessing.
            const { element, ambiguous } = await waitForLocator(framework, root, step.target, { timeoutMs: remaining, sleep, now });
            if (element === null && ambiguous !== undefined) {
                throw finalError(t('session.replay.ambiguous', { target: label, count: ambiguous.count, candidates: ambiguityText(ambiguous) }), 'target');
            }
            if (element === null) {
                // Is the target missing, or is something on top of it? An open dialog with a message explains more than "missing".
                const why = await explainLocator(framework, root, step.target).catch(() => null);
                const error = new Error(t('session.replay.notClickable', { target: label, seconds: Math.round(timeoutMs / 1000), why: explainText(why) }));
                if (why !== null) error.blocker = why;
                throw error;
            }
            try {
                await leaveForDisabled(element);
                if (step.action === 'click') await element.click({ timeout: remaining, delay: CLICK_DELAY_MS });
                else if (step.action === 'dblclick') await element.dblclick({ timeout: remaining, delay: CLICK_DELAY_MS });
                else if (step.action === 'fill') await fillField(element, step.value, { timeout: remaining });
                else if (step.action === 'upload') await upload(element, step, files, remaining);
                else if (step.action === 'download') await download(element, step, remaining);
                else if (step.action === 'hover') await element.hover({ timeout: remaining });
                // An element handle cannot drag: the locator (unique, as just checked) drags onto the target of to.
                else if (step.action === 'dragTo') await locatorFor(session.page(), step.target).dragTo(locatorFor(session.page(), step.to), { timeout: remaining });
                else await element.type(step.value, { timeout: remaining });
                return;
            } catch (error) {
                // ExtJS rebuilds elements. As long as time remains, the target is looked up again.
                if (error.final || now() >= deadline) throw error;
                await sleep(CHECK_POLL_MS);
            } finally {
                await element.dispose().catch(() => {});
            }
        }
    };

    const check = async (step, timeoutMs) => {
        const deadline = now() + timeoutMs;
        let last = t('session.replay.noEvaluation');
        let failedWith = null;
        for (;;) {
            try {
                const { pass, value } = await handler({ action: 'check', id: step.id, code: step.code });
                last = JSON.stringify(value) ?? String(value);
                failedWith = null;
                if (pass) break;
            } catch (error) {
                // During a page change e.g. Ext is briefly undefined.
                last = firstLine(error);
                failedWith = last;
            }
            if (now() >= deadline) {
                const timedOut = t('session.replay.checkTimeout', { seconds: Math.round(timeoutMs / 1000), code: step.expect ?? step.code });
                const cause = await withSignIn(failedWith === null ? timedOut : `${timedOut} ${t('session.replay.checkError', { error: failedWith })}`);
                causes.set(step.id, cause);
                if (failedWith === null) evaluated.add(step.id);
                else evaluated.delete(step.id);
                results.set(step.id, { id: step.id, status: 'fail', evidence: { type: 'eval', value: `${step.code} => ${last}` }, note: withTries(step.id, cause) });
                return;
            }
            await sleep(CHECK_POLL_MS);
        }
        evaluated.delete(step.id);
        const tried = history.get(step.id);
        const notes = [
            ...(tried === undefined ? [] : [t('session.replay.passedOnTry', { count: tried.length + 1, tries: tried.join('; ') })]),
            ...(repeatSkipped.get(step.id) ?? []).map(({ label, outcome }) => t(outcome === 'absent' ? 'session.replay.skippedOptional' : 'session.replay.skippedRepeat', { label })),
        ];
        results.set(step.id, {
            id: step.id,
            status: 'pass',
            evidence: { type: 'eval', value: `${step.code} => ${last}` },
            ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
        });
    };

    /** The value comes from this run. It may only appear shortly after the previous step, hence the retries. */
    const remembered = new Map();
    const hidden = [];
    const mask = (value) => (hidden.length === 0 ? value : redactDeep(value, hidden));
    const remember = async (step, timeoutMs) => {
        const deadline = now() + timeoutMs;
        for (;;) {
            try {
                const command = { action: 'remember', name: step.name, code: step.code };
                const { name, value } = await (step.secret === true && handler.reveal !== undefined ? handler.reveal(command) : handler(command));
                remembered.set(`{{${name}}}`, value);
                // Secret: from now on the value appears neither in the log nor in the report, and the session redacts it like the role password.
                if (step.secret === true) {
                    hidden.push(value);
                    session.hide?.(value);
                }
                return;
            } catch (error) {
                if (now() >= deadline) throw new Error(t('session.replay.unreadable', { name: step.name, error: firstLine(error) }));
                await sleep(CHECK_POLL_MS);
            }
        }
    };

    const run = async (step, timeoutMs, previous) => {
        // The recorded decision for a dialog this action opens; any other dialog is dismissed and reported.
        // Dialogs between actions (e.g. an alert while signing in or waiting) nobody answered: reported with this action.
        for (const finding of dialogFindings(undefined, session.dialogs?.begin() ?? [])) session.warn?.(dialogWarning(finding, stepLabel(step)));
        session.dialogs?.arm(step.dialog);
        try {
            return await runAction(step, timeoutMs, previous);
        } finally {
            for (const finding of dialogFindings(step.dialog, session.dialogs?.end() ?? [])) session.warn?.(dialogWarning(finding, stepLabel(step)));
        }
    };
    const runAction = async (step, timeoutMs, previous) => {
        if (TARGETED.has(step.action)) {
            const outcome = await act(step, timeoutMs, previous);
            if (outcome !== undefined) return outcome;
        } else if (step.action === 'check') await check(step, timeoutMs);
        else if (step.action === 'remember') await remember(step, timeoutMs);
        else if (step.action === 'goto' && step.denied) {
            const denied = await handler({ action: 'goto', url: step.url }).then(() => false, (error) => error.code === 'host-blocked');
            if (!denied) throw new Error(t('session.replay.notDenied', { url: step.url }));
        } else if (step.action === 'goto') await handler({ action: 'goto', url: new URL(step.url, base).href });
        else if (step.action === 'wait-ready') await session.waitReady({ timeout: timeoutMs, ...(step.for === undefined ? {} : { store: step.for }), ...(step.minCount === undefined ? {} : { minCount: step.minCount }) }).catch(() => {});
        else await handler(step);
        if (CHANGES_PAGE.has(step.action) && !step.denied) await settle(timeoutMs);
        return undefined;
    };

    // The entry of a step (replayToEntry) belongs to that step, although its check does not follow.
    const ownerOf = (index) => replay.steps[index]?.entry ?? replay.steps.slice(index).find(({ action }) => action === 'check')?.id ?? replay.steps.findLast(({ action }) => action === 'check')?.id;
    let broken = null;
    const stop = async (position, label, kind, given, blocker) => {
        const message = await withSignIn(given);
        // Actions belong to the next check, so the abort names that one too.
        const owner = ownerOf(position - 1);
        // Clean: nothing of this step has run yet, so the page is right before it. An external failure may have changed it.
        const clean = kind !== 'external' && position - 1 === starts.get(owner);
        broken = { number: `${position}/${replay.steps.length}`, step: owner, label, kind, message, clean, ...(blocker === undefined ? {} : { blocker }) };
        const name = `failure-step-${position}.png`;
        await handler({ action: 'screenshot', name }).then(() => { broken.screenshot = name; }, () => {});
    };

    /**
     * The step's check passed: does its screen match the target design? Not met fails the step with kind 'design' (or only
     * warns), but the replay goes on: the app works, it just does not look as designed yet. No new attempt, since waiting
     * does not build a screen, and the failed result keeps its effects from being learned in this run.
     */
    const judge = async (id, result) => {
        const design = replay.designs?.[id];
        if (design === undefined || judgeDesign === undefined) return;
        const judged = await judgeDesign({ ...design, step: id, texts: varying() }, session.page()).catch((error) => ({ file: design.file, verdict: 'error', note: t('session.design.error', { file: design.file, error: firstLine(error) }) }));
        designs.set(id, judged);
        if (judged.verdict === 'met') return;
        const details = designText(judged);
        const text = judged.verdict === 'not-met' ? t('session.design.notMet', { id, details }) : judged.note;
        if (judged.verdict === 'error' || !designFail.includes('target')) {
            session.warn?.({ type: 'design', step: id, text });
            return;
        }
        results.set(id, { ...result, status: 'fail', kind: 'design', evidence: { type: 'eval', value: judged.verdict === 'not-met' ? details : judged.note }, note: text });
    };

    /**
     * After the design: what the visual layer sees in this state. A finding that fails (design.fail with visual) fails the
     * passed step like a design not met: the replay goes on, nothing is retried or learned in this step.
     */
    const inspect = async (id, shot) => {
        if (look === undefined) return;
        const seen = await look(id, { capture: shot, page: session.page() }).catch((error) => ({ warnings: [t('session.visual.error', { id, error: firstLine(error) })] }));
        if (seen.record !== undefined && Object.keys(seen.record).length > 0) looks.set(id, seen.record);
        if (seen.observed !== undefined) seenLooks.set(id, seen.observed);
        for (const warning of seen.warnings ?? []) session.warn?.(typeof warning === 'string' ? { type: 'visual', step: id, text: warning } : { step: id, ...warning });
        const result = results.get(id);
        if (seen.fail === undefined || result?.status !== 'pass') return;
        results.set(id, { ...result, status: 'fail', kind: seen.fail.kind, evidence: { type: 'eval', value: seen.fail.evidence }, note: seen.fail.text });
    };
    /** What varies from run to run on a screen: the run tag and the remembered values. */
    const varying = () => [...(runTag === undefined ? [] : [runTag, runTag.toLowerCase()]), ...remembered.values()];
    /** The step's screen, captured on first use: at most one capture per passed check. */
    const shotOf = (id) => {
        if (capture === undefined) return undefined;
        let taken = null;
        return () => {
            taken ??= capture(id);
            return taken;
        };
    };

    // Where each step starts in the flat list.
    const starts = new Map();
    let segment = 0;
    replay.steps.forEach(({ action, id }, index) => {
        if (action !== 'check') return;
        starts.set(id, segment);
        segment = index + 1;
    });
    const entryAt = replay.steps.findIndex(({ entry }) => entry !== undefined);
    if (entryAt !== -1) starts.set(replay.steps[entryAt].entry, entryAt);
    const marks = new Map();
    const netMarks = new Map();
    // How many write requests there were at the start of each step: a new attempt after a write would create things twice.
    const writeMarks = new Map();
    const writeCount = () => (session.writes?.() ?? []).reduce((sum, { count }) => sum + count, 0);
    const readMatchers = compileReads(reads);
    // Per step the proposed replacement of a renamed target, until its check decides: { step, action, from, to, effect, ... }.
    const proposals = new Map();

    /**
     * A target that is gone because the UI renamed it ("Speichern" to "Sichern"): caw proposes the one similar element without
     * AI and proves it. Gates: exactly one similar name, an action whose work shows in its learned effect (learned, for this
     * action, and not writing), a name the recording spells out. The candidate runs with writes held (aborted, no failure) and
     * must cause the learned effect again without any write; the step's unchanged check decides later (see the check below).
     * @returns { step, action, from, to, effect } or null
     */
    const proposeTarget = async ({ index, recorded, step, owner, kind, error }) => {
        if (kind !== 'target' || !REPAIRABLE.has(step.action) || recorded.entry !== undefined || measure === null || session.holdWrites === undefined || proposals.has(owner)) return null;
        const similar = error?.blocker?.similar ?? [];
        if (similar.length !== 1 || error.blocker.missing !== true) return null;
        const learned = replay.effects?.[owner];
        const number = index - starts.get(owner) + 1;
        const effect = learned?.actions?.find(({ action }) => action === number);
        if (learned === undefined || learned.runs < LEARN_RUNS || effect === undefined || writesIn(effect, readMatchers)) return null;
        const candidate = renamedLocator(recorded.target, similar[0].name, { framework: (session.framework ?? frameworkOf()).name });
        if (candidate === null) return null;
        let seen = null;
        let blocked = [];
        try {
            await session.holdWrites();
            await measure.before();
            const tried = fillStep({ ...recorded, target: candidate.code });
            if (await run(tried, tried.timeoutMs ?? stepTimeoutMs, undefined) !== undefined) return null;
            await session.waitReady({ timeout: EFFECT_SETTLE_MS }).catch(() => {});
            seen = await measure.after();
        } catch {
            return null;
        } finally {
            blocked = session.releaseWrites();
        }
        // effectChange ignores requests the learned effect does not name, so a write needs its own look.
        if (seen === null || blocked.length > 0 || writesIn(seen, readMatchers) || stepDeviation(learned, number, seen) !== null) return null;
        return { step: owner, action: number, from: recorded.target, to: candidate.code, effect: seen };
    };

    /** Records the effect and compares it with the learned one. A new attempt replaces what the old one saw. */
    const noteEffect = (owner, number, effect, label) => {
        if (!observed.has(owner)) observed.set(owner, new Map());
        observed.get(owner).set(number, effect);
        if (deviations.has(owner)) return;
        const deviation = stepDeviation(replay.effects?.[owner], number, effect);
        if (deviation !== null) deviations.set(owner, { step: owner, label, ...deviation });
    };
    // The action whose effect is still being measured.
    let pending = null;
    /** Would missing or new controls fail the step? Only that can still change by waiting. */
    const controlsFail = (owner, number, effect) => {
        const learned = replay.effects?.[owner];
        if (learned === undefined || learned.runs < LEARN_RUNS || deviations.has(owner) || !effectFail.includes('controls')) return false;
        const change = effectChange(learned.actions.find(({ action }) => action === number) ?? {}, effect);
        return change !== null && change.lists.includes('controls');
    };
    const settleEffect = async () => {
        if (pending === null) return;
        const { owner, number, label } = pending;
        pending = null;
        await session.waitReady({ timeout: EFFECT_SETTLE_MS }).catch(() => {});
        let effect = await measure.after().catch(() => null);
        // Re-measure like a check before the next action runs. Healthy runs pay nothing for this.
        const deadline = now() + Math.min(stepTimeoutMs, EFFECT_REMEASURE_MS);
        while (effect !== null && controlsFail(owner, number, effect) && now() < deadline) {
            await sleep(EFFECT_REMEASURE_POLL_MS);
            await session.waitReady({ timeout: EFFECT_SETTLE_MS }).catch(() => {});
            effect = await measure.after().catch(() => null) ?? effect;
        }
        if (effect !== null) noteEffect(owner, number, effect, label);
    };

    /**
     * New attempt: wait, reload, run again from the given step. Hard failures since its start belong to the failed attempt;
     * they drop out of the verdict, their text stays in the step's note.
     * @returns where to continue, null if no attempt is left
     */
    const again = async (owner, reason) => {
        const retry = replay.retries?.[owner];
        const tried = history.get(owner) ?? [];
        if (retry === undefined || tried.length >= retry.times) return null;
        const from = retry.from ?? owner;
        // Already written since the attempt started: a new attempt would send the same again, with the same run tag.
        const written = writeMarks.has(from) ? writeCount() - writeMarks.get(from) : 0;
        if (written > 0) {
            skipped.set(owner, t('session.replay.skipWritten', { from, count: written }));
            const result = results.get(owner);
            if (result?.status === 'fail') result.note = withTries(owner, causes.get(owner));
            log({ position: starts.get(owner) + 1, number: `${starts.get(owner) + 1}/${replay.steps.length}`, owner, label: t('session.replay.skipWrittenLog', { owner, from }) });
            return null;
        }
        // If the app aborts by itself and already did so in the previous attempt, reloading yields the same.
        const abort = netMarks.has(owner) ? selfAbort(session.network.since(netMarks.get(owner).from), replay.baselines?.[owner]) : null;
        const pointless = abort !== null && aborts.get(owner) === abort ? abort : null;
        if (abort !== null) aborts.set(owner, abort);
        if (pointless !== null) {
            skipped.set(owner, t('session.replay.skipAbort', { reason: pointless }));
            const result = results.get(owner);
            if (result?.status === 'fail') result.note = withTries(owner, causes.get(owner));
            log({ position: starts.get(owner) + 1, number: `${starts.get(owner) + 1}/${replay.steps.length}`, owner, label: t('session.replay.skipAbortLog', { owner }) });
            return null;
        }
        // Same deviation as in the previous attempt: the app reliably reacts differently, another attempt changes nothing.
        if (isEffectCause(reason) && repeated.has(owner)) {
            pending = null;
            skipped.set(owner, t('session.replay.skipEffect'));
            const result = results.get(owner);
            if (result?.status === 'fail') result.note = withTries(owner, causes.get(owner));
            log({ position: starts.get(owner) + 1, number: `${starts.get(owner) + 1}/${replay.steps.length}`, owner, label: t('session.replay.skipEffectLog', { owner }) });
            return null;
        }
        history.set(owner, [...tried, reason]);
        retried.add(owner);
        const start = starts.get(from) ?? starts.get(owner);
        const ids = replay.steps.slice(start).filter(({ action }) => action === 'check').map(({ id }) => id);
        pending = null;
        ids.slice(0, ids.indexOf(owner) + 1).forEach((id) => {
            results.delete(id);
            evaluated.delete(id);
            designs.delete(id);
            looks.delete(id);
            seenLooks.delete(id);
            lookHints.delete(id);
            observed.delete(id);
            deviations.delete(id);
            proposals.delete(id);
            // Only warm-up for the retried step: the previous attempt already changed the app, e.g. opened a task.
            // Its effects then rightly deviate and do not count.
            if (id !== owner) warmup.add(id);
        });
        log({ position: start + 1, number: `${start + 1}/${replay.steps.length}`, owner, label: t('session.replay.retryLog', { owner, count: tried.length + 2, total: retry.times + 1, from }) });
        await sleep(retry.waitMs ?? DEFAULT_RETRY_WAIT_MS);
        await handler({ action: 'reload' }).catch(() => {});
        // Up to the reload everything belongs to the old attempt, including an error the old page throws while unloading. What
        // the new page throws on start stays: it is a finding of this attempt and does not vanish with a passed run.
        const cut = session.failures?.().length ?? 0;
        await settle(stepTimeoutMs);
        const dropFrom = marks.get(from) ?? marks.get(owner) ?? 0;
        // A script error disappears from the verdict with the new attempt, but not from the report: it may be a rare app bug.
        // Also console errors with a source: script errors caught by the framework (diagnose counts them like `pageerror`).
        for (const failure of (session.failures?.() ?? []).slice(dropFrom, cut).filter((entry) => entry.type === 'pageerror' || isCaughtScriptError(entry))) {
            session.warn?.({ type: 'retry', text: t('session.replay.hiddenScriptError', { owner, count: tried.length + 1, text: failure.text }) });
        }
        session.retractFailures?.(dropFrom, cut);
        return start;
    };

    /** Placeholders filled: run tag, remembered values and dates; in the target only through its string arguments. */
    const fillStep = (recorded) => {
        const today = zonedNow(session.browser?.timezone);
        const { target, ...rest } = recorded;
        const tagged = runTag === undefined ? rest : fillRun(rest, runTag);
        const filled = fillDates([...remembered].reduce((current, [placeholder, value]) => swapText(current, placeholder, value), tagged), today, session.browser?.locale);
        if (typeof target !== 'string') return filled;
        const lookup = (placeholder) => {
            if (runTag !== undefined && placeholder === RUN_TAG_PLACEHOLDER) return runTag;
            if (runTag !== undefined && placeholder === RUN_TAG_LOWER_PLACEHOLDER) return runTag.toLowerCase();
            if (remembered.has(placeholder)) return remembered.get(placeholder);
            const date = fillDates(placeholder, today, session.browser?.locale);
            return date === placeholder ? undefined : date;
        };
        return { action: filled.action, target: fillTarget(target, lookup), ...filled, ...(typeof filled.to === 'string' ? { to: fillTarget(filled.to, lookup) } : {}) };
    };

    let index = 0;
    while (index < replay.steps.length) {
        const position = index + 1;
        const recorded = replay.steps[index];
        const owner = ownerOf(index);
        const opensStep = index === starts.get(owner);
        activeOwner = owner;
        const step = fillStep(recorded);
        const problem = await externalProblem();
        if (problem !== null) {
            // At the start of a step the failure comes from the previous step; a new attempt here would not reach it.
            const restart = opensStep ? null : await again(owner, problem);
            if (restart !== null) {
                index = restart;
                continue;
            }
            await stop(position, stepLabel(step), 'external', withTries(owner, problem));
            break;
        }
        if (opensStep) {
            marks.set(owner, session.failures?.().length ?? 0);
            writeMarks.set(owner, writeCount());
            if (session.network !== undefined) netMarks.set(owner, { from: session.network.mark() });
        }
        log({ position, number: `${position}/${replay.steps.length}`, step: mask(step), owner, label: mask(stepLabel(step)) });
        // Effect of an action: from before it up to the next action or check, including the wait afterwards. A measuring
        // error does not affect the run.
        // Before a check, measure only after it: some things load while it waits, so the state it sees is what counts.
        if (step.action !== 'wait-ready' && step.action !== 'screenshot' && step.action !== 'check') await settleEffect();
        // The entry of a step is only navigation towards it: its effects are neither compared nor learned.
        if (measure !== null && EFFECT_ACTIONS.has(step.action) && recorded.entry === undefined) {
            await measure.before().catch(() => {});
            pending = { owner, number: index - starts.get(owner) + 1, label: stepLabel(step) };
        }
        try {
            const outcome = await run(step, step.timeoutMs ?? stepTimeoutMs, index > 0 ? fillStep(replay.steps[index - 1]) : undefined);
            if (outcome === 'skipped' || outcome === 'absent') {
                repeatSkipped.set(owner, [...(repeatSkipped.get(owner) ?? []), { label: stepLabel(step), outcome }]);
                if (EFFECT_ACTIONS.has(step.action)) pending = null;
            }
        } catch (error) {
            // If the action itself failed, it caused nothing to compare. The wait after it did.
            if (EFFECT_ACTIONS.has(step.action)) pending = null;
            else await settleEffect();
            // Playwright waits for an enabled target and only says so in the log below the first line. A locked target is a
            // state of the app, not a stale step, and not a load mask either, even if a progress indicator runs next to it.
            // An error with its own classification, e.g. a download with the wrong name, already says what is going on.
            const sorted = error?.kind !== undefined;
            const locked = !sorted && TARGETED.has(step.action) && LOCKED.test(String(error?.message ?? ''));
            const state = locked ? t('session.replay.locked') : (TARGETED.has(step.action) && !sorted ? stateProblem(await readState(), step, recorded) : null);
            const kind = sorted ? error.kind : TARGETED.has(step.action) && state === null ? 'target' : 'state';
            const message = state === null ? firstLine(error) : `${firstLine(error)} ${state}`;
            const restart = await again(owner, message);
            if (restart !== null) {
                index = restart;
                continue;
            }
            const proposal = await proposeTarget({ index, recorded, step, owner, kind, error });
            if (proposal !== null) {
                // The step goes on with the candidate; its check decides whether the proposal holds.
                proposals.set(owner, { ...proposal, position, label: stepLabel(step), message: withTries(owner, message), blocker: error.blocker });
                if (!observed.has(owner)) observed.set(owner, new Map());
                observed.get(owner).set(proposal.action, proposal.effect);
                index += 1;
                continue;
            }
            await stop(position, stepLabel(step), kind, withTries(owner, message), error.blocker);
            break;
        }
        if (step.action === 'check' && proposals.has(step.id)) {
            await settleEffect();
            const proposal = proposals.get(step.id);
            const result = results.get(step.id);
            // Proven only if the step ends as recorded: its unchanged check passes, nothing deviates, nothing failed hard.
            const proven = result.status === 'pass' && !deviations.has(step.id) && await externalProblem() === null;
            if (!proven) {
                // The missing target stands as it was found; what the candidate did is no evidence for the step.
                results.delete(step.id);
                observed.delete(step.id);
                deviations.delete(step.id);
                await stop(proposal.position, proposal.label, 'target', proposal.message, proposal.blocker);
                break;
            }
            // Still a failure: the recording names a target that is gone. The replay goes on, since the step's check holds.
            results.set(step.id, {
                id: step.id,
                status: 'fail',
                kind: 'target',
                evidence: result.evidence,
                note: `${proposal.message} ${t('session.replay.proposal', { target: locatorLabel(proposal.to), number: proposal.action })}`,
                proposal: { step: step.id, action: proposal.action, from: proposal.from, to: proposal.to, evidence: { effect: proposal.effect, check: result.evidence.value } },
            });
            index += 1;
            continue;
        }
        if (step.action === 'check') {
            await settleEffect();
            // Whatever came within the step after the measurement was just slower and is not missing.
            if (deviations.has(step.id) && netMarks.has(step.id)) {
                const answered = session.network.since(netMarks.get(step.id).from)
                    .filter(({ outcome }) => outcome === 'ok' || outcome === 'http').map(({ name, status }) => `${name} ${status}`);
                const rest = withoutLate(deviations.get(step.id), answered);
                if (rest === null) deviations.delete(step.id);
                else deviations.set(step.id, rest);
            }
            // Passed, but the app reacted differently than in healthy runs, in a reliable signal.
            const deviation = deviations.get(step.id);
            // After a retry the state is no longer that of a healthy run, e.g. a task already taken over: then only the retried
            // step itself fails on its effects, later ones only warn.
            const comparable = !warmup.has(step.id) && (retried.size === 0 || retried.has(step.id));
            if (results.get(step.id)?.status === 'pass' && comparable && failsStep(deviation, effectFail)) {
                deviation.fails = true;
                // Same as in the previous attempt, measured by what fails the step: another attempt changes nothing.
                const key = JSON.stringify(effectFail.flatMap((list) => (list === 'console' ? deviation.extra : deviation.byList?.[list] ?? [])));
                if (effectKeys.get(step.id) === key) repeated.add(step.id);
                effectKeys.set(step.id, key);
                const cause = await withSignIn(`${effectCause()} ${deviationText(deviation)}`);
                causes.set(step.id, cause);
                results.set(step.id, { id: step.id, status: 'fail', evidence: { type: 'eval', value: deviationText(deviation) }, note: withTries(step.id, cause) });
            }
            if (netMarks.has(step.id)) netMarks.get(step.id).end = session.network.mark();
            const result = results.get(step.id);
            const failure = result.status === 'fail' ? causes.get(step.id) : await externalProblem();
            const restart = failure === null ? null : await again(step.id, failure);
            if (restart !== null) {
                index = restart;
                continue;
            }
            // A hard failure while the check waited: it belongs to this step, not to the next one that would merely find it.
            if (failure !== null && result.status === 'pass') {
                results.set(step.id, { ...result, status: 'fail', note: withTries(step.id, failure) });
                await stop(position, stepLabel(step), 'external', withTries(step.id, failure));
                break;
            }
            // Failed check without retry: continuing would run the test on an already wrong state, including write steps,
            // and later failures would be blamed on this step.
            if (result.status === 'fail') {
                await stop(position, stepLabel(step), 'check', result.note);
                break;
            }
            const shot = shotOf(step.id);
            await judge(step.id, result);
            await inspect(step.id, shot);
            if (hintLook !== undefined && results.get(step.id)?.status === 'pass') lookHints.set(step.id, await hintLook(step.id, { page: session.page(), texts: varying() }).catch(() => null));
        }
        index += 1;
    }
    if (broken === null) {
        const problem = await externalProblem();
        if (problem !== null) await stop(replay.steps.length, t('session.replay.end'), 'external', problem);
    }
    // The first pending step's target design at its entry (the state the run ended in, healthy): a design shows the screen after
    // its step, so only its controls are looked for here, how far the screen is built. It fails nothing; once recorded, the step
    // is judged after its check like any other. A step with needs: they say it (run.mjs checks them), no design browser.
    let pendingDesign;
    const healthy = broken === null && [...results.values()].every(({ status, kind }) => status === 'pass' || LOOK_KINDS.has(kind));
    if (replay.pendingDesign !== undefined && judgeDesign !== undefined && healthy) {
        const { step, ...design } = replay.pendingDesign;
        if (replay.needs?.step === step) pendingDesign = { step, file: design.file };
        else {
            const judged = await judgeDesign({ ...design, step, texts: varying(), entry: true }, session.page()).catch((error) => ({ file: design.file, verdict: 'error', note: t('session.design.error', { file: design.file, error: firstLine(error) }) }));
            pendingDesign = { step, ...judged };
        }
    }
    // Per step the requests of its last attempt, evidence for classifying a failure.
    const requests = new Map([...netMarks].map(([id, { from, end }]) => [id, session.network.since(from, end)]));
    await settleEffect();
    // A passed step that acts differently than learned: drift before a check breaks. Learned effects count, those still being learned do not.
    for (const id of warmup) {
        observed.delete(id);
        deviations.delete(id);
    }
    for (const [id, deviation] of deviations) {
        if (results.get(id)?.status === 'pass' && deviation.learned) session.warn?.({ type: 'effect', step: id, text: deviationText(deviation) });
    }
    // Secret values stay in `remembered` for the run; in results and abort, i.e. in the report, they are redacted.
    return { results: new Map([...results].map(([id, result]) => [id, mask(result)])), broken: mask(broken), remembered, requests, effects: observed, deviations, retried, evaluated, designs: new Map([...designs].map(([id, judged]) => [id, mask(judged)])), looks: new Map([...looks].map(([id, record]) => [id, mask(record)])), seenLooks, lookHints, shownMessages: new Map([...shownMessages].map(([id, seen]) => [id, mask([...seen])])), ...(pendingDesign === undefined ? {} : { pendingDesign: mask(pendingDesign) }) };
};

/**
 * Baselines a recording still lacks: a passed step shows which requests a healthy run makes.
 * Only on the target the step was recorded on, otherwise the durations do not match. What exists stays; only values
 * from before parameter names were recorded get replaced.
 * @returns Map step -> recording.network
 */
export const missingBaselines = ({ spec, results, requests, target }) => {
    const found = new Map();
    for (const step of spec.steps) {
        const { recording } = step;
        const complete = recording?.network !== undefined && recording.network.every((entry) => entry.params !== undefined);
        if (recording === undefined || complete || recording.recordedOn !== target) continue;
        if (results.get(step.id)?.status !== 'pass' || !requests?.has(step.id)) continue;
        found.set(step.id, summarizeRequests(requests.get(step.id), { answeredOnly: true }));
    }
    return found;
};

/**
 * The steps whose effects are still being learned on this target: recorded there, with an action that has effects, and fewer
 * than LEARN_RUNS healthy runs learned. Until then a deviation of theirs fails nothing. For the CI reports.
 * @returns [{ id, runs }]
 */
export const effectsLearning = (spec, target) => spec.steps
    .filter(({ recording }) => recording !== undefined && recording.recordedOn === target && recording.actions.some(({ action }) => EFFECT_ACTIONS.has(action)))
    .map((step) => ({ id: step.id, runs: currentEffects(spec, step)?.runs ?? 0 }))
    .filter(({ runs }) => runs < LEARN_RUNS);

/**
 * The lines a learning run drops from the effects it learns (droppedEffects), per step.
 * @param effects  learnedEffects' result
 * @param observed this run's effects per step (playReplay) and `forms` (hash -> JSON field paths): a dropped response
 *                 names the fields that changed
 * @returns [{ step, lines }]
 */
export const droppedWhileLearning = (spec, effects, { observed, forms } = {}) => spec.steps.flatMap((step) => {
    if (!effects.has(step.id)) return [];
    const lines = droppedEffects(currentEffects(spec, step), effects.get(step.id), { observed: observed?.get(step.id), forms });
    return lines.length === 0 ? [] : [{ step: step.id, lines }];
});

/**
 * Learned effects per action from passed steps, only on the recording target. After LEARN_RUNS healthy runs they are
 * frozen: only adopting or forgetting them changes them. A step with a deviation does not learn: otherwise a bug would
 * vanish from the comparison instead of standing out.
 * @returns Map step -> recording.effects
 */
export const learnedEffects = ({ spec, results, effects, deviations, target }) => {
    const found = new Map();
    for (const step of spec.steps) {
        const { recording } = step;
        if (recording === undefined || recording.recordedOn !== target || results.get(step.id)?.status !== 'pass') continue;
        if (deviations?.get(step.id)?.learned || !effects?.has(step.id)) continue;
        const learned = learnEffects(currentEffects(spec, step), effects.get(step.id));
        if (learned !== null) found.set(step.id, withBasis(spec, step, learned));
    }
    return found;
};

/** Adds learned effects. The hash stays. */
export const withEffects = (spec, effects) => ({
    ...spec,
    steps: spec.steps.map((step) => (effects.has(step.id) && step.recording !== undefined ? { ...step, recording: { ...step.recording, effects: effects.get(step.id) } } : step)),
});

/** Forgets the learned effects of a step: the next healthy runs learn them anew. The hash stays. */
export const withoutEffects = (spec, id) => ({
    ...spec,
    steps: spec.steps.map((step) => {
        if (step.id !== id || step.recording?.effects === undefined) return step;
        const recording = { ...step.recording };
        delete recording.effects;
        return { ...step, recording };
    }),
});

/**
 * Adopts a proposed target (playReplay): only that action's target changes. Hash, description and learned effects stay, since
 * the proof showed the same effect and the same check. Nothing changes if the action no longer has the old target.
 */
export const withProposal = (spec, { step: id, action, from, to }) => ({
    ...spec,
    steps: spec.steps.map((step) => (step.id !== id || step.recording?.actions?.[action - 1]?.target !== from ? step : {
        ...step,
        recording: { ...step.recording, actions: step.recording.actions.map((entry, index) => (index === action - 1 ? { ...entry, target: to } : entry)) },
    })),
});

/** Adds baselines to the recordings. The hash stays; `network` is not part of it. */
export const withBaselines = (spec, baselines) => ({
    ...spec,
    steps: spec.steps.map((step) => (baselines.has(step.id) && step.recording !== undefined ? { ...step, recording: { ...step.recording, network: baselines.get(step.id) } } : step)),
});

/** Kinds of a failed step that works but does not look as it should (design, learned look): the replay went on past it. */
export const LOOK_KINDS = new Set(['design', 'visual']);

/**
 * The first failed step and why. Hard failures and unexpected messages look like the app, not like a stale step; the
 * human may still fix it, it is their call.
 * @returns { id, reason, suspect, clean } or null if everything passed; `clean`: the browser is right before the step,
 *          fixing works there without a warm-up. After a failed check playback continued, so never then.
 */
export const failedStep = ({ results, broken, expectations, failures = [], evaluated }) => {
    // A design not met leaves the replay running: a later step that really failed, or the break, says more and comes first.
    const fails = expectations.filter(({ id }) => results.get(id)?.status === 'fail');
    const failed = fails.find(({ id }) => !LOOK_KINDS.has(results.get(id).kind)) ?? (broken === null ? fails[0] : undefined);
    const suspect = broken?.kind === 'external' || failures.length > 0;
    if (failed !== undefined && LOOK_KINDS.has(results.get(failed.id).kind)) return { id: failed.id, reason: results.get(failed.id).note, kind: results.get(failed.id).kind, suspect: false, clean: false };
    // A proposed target (playReplay) goes along: the chat offers it as a button. evaluated: the check ran and answered "no"
    // (playReplay), which is what a draft's red step must do while the bug is there.
    const proposal = failed === undefined ? undefined : results.get(failed.id).proposal;
    if (failed !== undefined) return { id: failed.id, reason: results.get(failed.id).note, suspect, clean: false, ...(proposal === undefined ? {} : { proposal }), ...(evaluated?.has(failed.id) ? { evaluated: true } : {}) };
    return broken === null ? null : { id: broken.step, reason: `${broken.label}: ${broken.message}`, suspect, clean: broken.clean === true && failures.length === 0 };
};

/**
 * One record per step for result.json: what each step did in this run, the same data a later comparison or trend needs.
 * A step the replay did not reach is `skipped`. `kind` says why a step failed: its check, its effect, or the break that
 * stopped the replay there (target, state, check, external).
 * @param ids          the test's step ids in order
 * @param durations    seconds per step id, as measured by the run
 * @param withEffects  false on production: effect lines carry visible names, which may be personal data
 * @param designs      the judged target designs per step id (playReplay)
 * @param looks        what the visual layer recorded per step id (playReplay): screenshot, visual
 * @returns [{ id, status, kind?, seconds?, requests?, effects?, deviation?, design?, screenshot?, visual?, messages?, proposal? }];
 *          `kind` 'design': its screen does not match its target design, 'visual': its learned look
 *          changed; `proposal`: the proven replacement of a renamed target (without the effect on production)
 */
export const stepRecords = ({ ids, results, broken = null, requests, effects, deviations, designs, looks, shownMessages, durations = {}, withEffects: effectsShown = true }) => ids.map((id) => {
    // The step the playback broke at has no result yet (replayVerdict fills it in): it failed, the ones after it were not reached.
    const status = results?.get(id)?.status ?? (broken?.step === id ? 'fail' : 'skipped');
    const deviation = deviations?.get(id);
    const kind = status !== 'fail' ? undefined : results?.get(id)?.kind ?? (broken?.step === id ? broken.kind : deviation?.fails === true ? 'effect' : 'check');
    const design = designs?.get(id);
    const proposal = results?.get(id)?.proposal;
    const seen = effects?.get(id);
    const shownDeviation = deviation === undefined ? undefined
        : effectsShown ? { number: deviation.number, learned: deviation.learned, lists: deviation.lists, missing: deviation.missing, extra: deviation.extra, instead: deviation.instead, ...(deviation.fails === true ? { fails: true } : {}) }
            : { lists: deviation.lists, learned: deviation.learned, ...(deviation.fails === true ? { fails: true } : {}) };
    return {
        id,
        status,
        ...(kind === undefined ? {} : { kind }),
        ...(durations[id] === undefined ? {} : { seconds: Math.round(durations[id] * 1000) / 1000 }),
        ...(requests?.has(id) ? { requests: summarizeRequests(requests.get(id)) } : {}),
        ...(effectsShown && seen !== undefined ? { effects: [...seen].map(([action, effect]) => ({ action, ...effect })) } : {}),
        ...(shownDeviation === undefined ? {} : { deviation: shownDeviation }),
        ...(design === undefined ? {} : { design: { file: design.file, verdict: design.verdict, missing: design.missing ?? [], extra: design.extra ?? [], styleDiffs: design.styleDiffs ?? [], layoutDiffs: design.layoutDiffs ?? [], textDiffs: design.textDiffs ?? [] } }),
        ...(looks?.get(id) ?? {}),
        ...(effectsShown && shownMessages !== undefined ? { messages: [...new Set(shownMessages.get(id) ?? [])].sort() } : {}),
        ...(proposal === undefined ? {} : { proposal: effectsShown ? proposal : { ...proposal, evidence: { check: proposal.evidence.check } } }),
    };
});

/** Builds the result for `finish` from playback: what was not reached is fail, never silently pass. */
export const replayVerdict = ({ results, broken, expectations }) => {
    const note = broken === null ? t('session.replay.noCheck') : t('session.replay.brokenAt', { number: broken.number, label: broken.label, message: broken.message });
    const evidence = broken?.screenshot === undefined ? { type: 'eval', value: t('session.replay.notReached') } : { type: 'screenshot', value: broken.screenshot };
    const owner = broken?.step;
    const items = expectations.map(({ id }) => results.get(id) ?? { id, status: 'fail', evidence, note: id === owner || owner === undefined ? note : t('session.replay.notReachedBecause', { owner }) });
    // Even if all points were already proven: a later abort must not end as pass.
    if (broken !== null && items.length > 0 && items.every(({ status }) => status === 'pass')) {
        items[items.length - 1] = { ...items.at(-1), status: 'fail', note };
    }
    return { expectations: items };
};
