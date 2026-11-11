// Let Claude run a test once, then repeat it quickly without a model. Recording happens on the host only. Playback goes
// through the same handler as the agent, so the same limits apply.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { isCaughtScriptError } from '../shared/report.mjs';
import { CLICK_DELAY_MS, locatorFor } from './agent-commands.mjs';
import { patternLabel, textMatcher } from './patterns.mjs';
import { redactDeep } from './secrets.mjs';
import { selfAbort } from './diagnose.mjs';
import { DATE_NAMES, fillDates, markDates } from './dates.mjs';
import { DEFAULT_EFFECT_FAIL, LEARN_RUNS, createEffects, deviationText, effectCause, effectChange, failsStep, isEffectCause, learnEffects, pruneEffects, withoutLate } from './effects.mjs';
import { summarizeRequests } from './network-log.mjs';
import { describeElement, describeLocator, explainTarget, explainText, frameworkOf, readPageState, targetLabel, waitForTarget } from './framework/index.mjs';
import { brokenChain, staleSteps, stepHash, withExpectations } from './test-file.mjs';

const DESCRIBE_TIMEOUT_MS = 5000;
const CHECK_POLL_MS = 250;
const DEFAULT_RETRY_WAIT_MS = 10_000;
const TARGETED = new Set(['click', 'fill', 'type', 'upload', 'download']);
// How long a repeated click may wait for its target before a dialog on top makes it skip.
const REPEAT_CLICK_MS = 1500;
// How long an optional click (e.g. a cookie banner) waits for its target; if it does not appear, the click is dropped.
const OPTIONAL_CLICK_MS = 3000;
const CHANGES_PAGE = new Set(['click', 'press', 'goto', 'reload']);
const EFFECT_ACTIONS = new Set(['click', 'fill', 'type', 'press', 'upload', 'download']);
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
const shownMessage = (text) => (text.length <= MESSAGE_SHOWN ? text : `${text.slice(0, MESSAGE_SHOWN)}…`);
/**
 * An error that a new attempt within the action will not fix, e.g. a download with the wrong name: a second click would
 * download again. `kind` classifies it for the abort; without it the usual look at the page applies.
 */
const finalError = (message, kind) => Object.assign(new Error(message), { final: true, ...(kind === undefined ? {} : { kind }) });

/**
 * Makes every run distinguishable: Claude writes the tag into free text, so each run finds its own record again. Only digits
 * next to the fixed part, because numbers in messages are treated as equal.
 */
export const newRunTag = (now = new Date()) => `CAW-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
const jsonText = (text) => JSON.stringify(String(text)).slice(1, -1);
export const swapText = (value, from, to) => JSON.parse(JSON.stringify(value).replaceAll(jsonText(from), () => jsonText(to)));
/** Replaces the run tag in both spellings with its placeholders. */
export const tagRun = (value, runTag) => swapText(swapText(value, runTag, RUN_TAG_PLACEHOLDER), runTag.toLowerCase(), RUN_TAG_LOWER_PLACEHOLDER);
/** Inserts the run tag into both placeholders. */
export const fillRun = (value, runTag) => swapText(swapText(value, RUN_TAG_PLACEHOLDER, runTag), RUN_TAG_LOWER_PLACEHOLDER, runTag.toLowerCase());

const TOKEN_FIELDS = ['value', 'code', 'url'];
const TARGET_FIELDS = ['own', 'text', 'label', 'name'];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces a remembered value with its placeholder, only as a whole token and only in inputs, checks, URLs and the visible
 * texts of a target. A number 2026 thus matches neither the date 07.11.2026 nor VG-2026 nor a selector.
 */
export const swapToken = (step, value, placeholder) => {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}._-])${escapeRegExp(value)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'gu');
    const swap = (text) => (typeof text === 'string' ? text.replace(pattern, () => placeholder) : text);
    const next = { ...step };
    for (const key of TOKEN_FIELDS) if (key in next) next[key] = swap(next[key]);
    // Also the enclosing iframe: a frame with an order number in its title needs the new one on the next run.
    const swapTarget = (given) => {
        const target = { ...given };
        for (const key of TARGET_FIELDS) if (key in target) target[key] = swap(target[key]);
        if (typeof target.inside?.name === 'string') target.inside = { ...target.inside, name: swap(target.inside.name) };
        if (target.frame !== null && typeof target.frame === 'object') target.frame = swapTarget(target.frame);
        return target;
    };
    if (next.target !== null && typeof next.target === 'object') next.target = swapTarget(next.target);
    return next;
};

const relativeUrl = (url, base) => {
    const parsed = new URL(url);
    return parsed.origin === new URL(base).origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : url;
};

/** With `page` also inside iframes: if the element is in a frame of the app, the target carries `frame`. */
export const describeSafely = async (locator, framework = frameworkOf(), page = undefined) => {
    try {
        if (typeof page?.mainFrame !== 'function' || typeof locator.elementHandle !== 'function') return await describeLocator(framework, locator, { timeout: DESCRIBE_TIMEOUT_MS });
        const element = await locator.elementHandle({ timeout: DESCRIBE_TIMEOUT_MS });
        try {
            return await describeElement(framework, page, element, { timeout: DESCRIBE_TIMEOUT_MS });
        } finally {
            await element.dispose().catch(() => {});
        }
    } catch {
        return null;
    }
};

/**
 * Records what actually moved the run forward: successful steps, no failed attempts and nothing read-only. The target is
 * resolved before the action, because afterwards the element is often gone.
 */
export const createRecorder = ({ handler, session, base, authMarker, runTag, remembered = new Map(), now = () => new Date() }) => {
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
    const add = (step) => {
        const named = [...placeholders].sort(([a], [b]) => b.length - a.length).reduce((current, [value, placeholder]) => swapToken(current, value, placeholder), step);
        const tagged = runTag === undefined ? named : tagRun(named, runTag);
        keep(markDates(tagged, now()));
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
        /** Steps the human demonstrated in the live browser. */
        addSteps: (shown) => shown.forEach(add),
        /** The numbered list from which the agent names its detours. */
        list: () => steps.map((step, index) => `${index + 1} ${stepLabel(step)}`),
        /** Forgets the checks of these steps; their actions then belong to the next check. */
        forgetChecks: (ids) => {
            for (let index = steps.length - 1; index >= 0; index -= 1) {
                if (steps[index].action !== 'check' || !ids.has(steps[index].id)) continue;
                steps.splice(index, 1);
                const [seen] = seenAfter.splice(index, 1);
                for (const message of seen) (index === 0 ? initial : seenAfter[index - 1]).add(message);
            }
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
            const target = TARGETED.has(command?.action) && typeof command.target === 'string'
                ? await describeSafely(locatorFor(session.page(), command.target), session.framework, session.page())
                : undefined;
            const path = currentPath();
            let value;
            try {
                value = await handler(command);
            } catch (error) {
                if (command?.action === 'goto' && error.code === 'target-denied') add({ action: 'goto', url: command.url, denied: true });
                throw error;
            }
            switch (command.action) {
                case 'click':
                case 'fill':
                case 'type':
                    // An optional click without a target did nothing: nothing to record.
                    if (value === 'absent') break;
                    if (target === null) problems.push(t('session.replay.unstableTarget', { action: command.action, target: command.target }));
                    else add({ action: command.action, target, ...path, ...(command.value === undefined ? {} : { value: command.value }), ...(command.action === 'click' && command.optional === true ? { optional: true } : {}) });
                    break;
                case 'press': add({ action: 'press', key: command.key }); break;
                case 'goto': add({ action: 'goto', url: relativeUrl(command.url, base) }); break;
                case 'reload': add({ action: 'reload' }); break;
                case 'screenshot': add({ action: 'screenshot', name: command.name }); break;
                case 'wait-ready':
                    // A custom timeout also applies on playback: if the page needed longer while recording, it will again.
                    if (value?.settled) add({ action: 'wait-ready', ...(command.store === undefined ? {} : { store: command.store }), ...(command.minCount === undefined ? {} : { minCount: command.minCount }), ...(Number.isFinite(command.timeout) ? { timeoutMs: command.timeout } : {}) });
                    break;
                case 'check':
                    if (value?.pass) add({ action: 'check', id: command.id, code: command.code });
                    break;
                case 'remember':
                    add({ action: 'remember', name: value.name, code: command.code });
                    placeholders.set(value.value, `{{${value.name}}}`);
                    break;
                default:
            }
            return value;
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
 * @returns { problems, candidate, fresh }; `fresh` lists messages the recording did not know so far
 */
export const buildReplay = ({ recorder, outcome, spec, target, draft, previous, now = new Date() }) => {
    const problems = [...recorder.problems];
    // All steps proven, only a hard failure on the way, e.g. in a dropped failed attempt: the check run without Claude settles that.
    const onlyHardFailures = outcome?.status === 'fail' && outcome.failures?.length > 0 && outcome.results.every(({ status }) => status === 'pass');
    if (outcome?.status !== 'pass' && !onlyHardFailures) problems.push(t('session.replay.endedWith', { status: outcome?.status ?? t('session.replay.noVerdict') }));
    const { groups, trailing } = groupSteps(recorder.steps);
    const missing = spec.steps.map(({ id }) => id).filter((id) => !groups.has(id));
    if (missing.length > 0) problems.push(t('session.replay.withoutCheck', { ids: missing.join(', ') }));
    if (trailing.length > 0) problems.push(t('session.replay.trailing', { actions: trailing.map(stepLabel).join(', ') }));
    const strays = [...groups.keys()].filter((id) => !spec.steps.some((step) => step.id === id));
    if (strays.length > 0) problems.push(t('session.replay.strays', { ids: strays.join(', ') }));
    if (problems.length > 0) return { problems };

    const order = (draft ?? spec).steps.map(({ id }) => id);
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
    const fresh = [...messages].filter((message) => !known(message)).sort();
    const texts = given.filter((entry) => typeof entry === 'string');
    const candidate = withExpectations({
        ...(draft ?? spec),
        steps: draft === undefined ? recorded : draft.steps.map((step) => recorded.find(({ id }) => id === step.id) ?? step),
        knownMessages: [...[...new Set([...texts, ...fresh])].sort(), ...given.filter((entry) => typeof entry !== 'string')],
    });
    const lost = missingRemembered(candidate);
    return lost.length > 0 ? { problems: lost } : { problems, candidate, fresh };
};

/**
 * A target chosen by position: only by it, or as the second or later of several equal matches. With one more match or a
 * different order it hits another element, and a generic check still passes.
 */
const POSITION_FREE = ['text', 'label', 'own', 'name', 'testid', 'inside', 'id', 'itemId', 'reference'];
export const isPositional = (target) => target?.index !== undefined && (target.index > 0 || POSITION_FREE.every((key) => target[key] === undefined));

/** Actions of the given steps whose target is chosen only by position, e.g. ['S2 click button']. */
export const positionalActions = (spec, ids) => spec.steps.filter(({ id }) => ids === undefined || ids.has(id)).flatMap(({ id, recording }) => (recording?.actions ?? [])
    .filter(({ target }) => isPositional(target)).map((action) => `${id} ${stepLabel(action)}`));

/** Checks before a browser opens: anything stale names the command that fixes it. */
export const assertPlayable = (spec, target, until) => {
    if (spec.steps.every(({ recording }) => recording === undefined)) {
        throw new CawError('replay-missing', t('session.replay.missing', { id: spec.id, target }));
    }
    const end = until === undefined ? spec.steps.length : spec.steps.findIndex(({ id }) => id === until) + 1;
    const reached = { ...spec, steps: spec.steps.slice(0, end) };
    const chain = brokenChain(reached);
    if (chain !== null) throw new CawError('replay-stale', t('session.replay.chainStale', { chain, id: spec.id, target }));
    const [stale] = staleSteps(reached);
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

const flatten = (spec, steps, until) => ({
    test: spec.id,
    recordedOn: steps.at(-1)?.recording?.recordedOn,
    ...(spec.knownMessages === undefined ? {} : { knownMessages: spec.knownMessages }),
    ...(until === undefined ? {} : { until }),
    retries: Object.fromEntries(steps.filter(({ retry }) => retry !== undefined).map(({ id, retry }) => [id, retry])),
    // Baseline from the recording: it shows whether a new attempt can change anything at all.
    baselines: Object.fromEntries(steps.filter(({ recording }) => recording?.network !== undefined).map(({ id, recording }) => [id, recording.network])),
    // Effects per action from healthy runs: they show the first action after which the app behaves differently.
    effects: Object.fromEntries(steps.filter((step) => currentEffects(spec, step) !== undefined).map((step) => [step.id, currentEffects(spec, step)])),
    steps: steps.flatMap(({ id, recording }) => [
        ...recording.actions,
        { action: 'check', id, code: recording.check, ...(recording.timeoutMs === undefined ? {} : { timeoutMs: recording.timeoutMs }) },
    ]),
});

/** The actions of all steps in one row, as they are played back. */
export const replayOf = (spec) => flatten(spec, spec.steps);

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

/** The check run: up to the first step that is still stale. That one gets fixed next anyway. */
export const replayUpToStale = (spec) => {
    const [stale] = staleSteps(spec);
    const end = stale === undefined ? spec.steps.length : spec.steps.findIndex(({ id }) => id === stale.id);
    if (end === spec.steps.length) return flatten(spec, spec.steps);
    return flatten(spec, spec.steps.slice(0, end), spec.steps[end - 1]?.id);
};

export const stepLabel = (step) => {
    switch (step.action) {
        case 'click': return `click ${targetLabel(step.target)}${step.optional === true ? ' (optional)' : ''}`;
        case 'fill':
        case 'type': return `${step.action} ${targetLabel(step.target)}`;
        case 'upload': return `upload ${targetLabel(step.target)} ${step.files.join(', ')}`;
        case 'download': return `download ${targetLabel(step.target)} /${step.file}/`;
        case 'press': return `press ${step.key}`;
        case 'goto': return `goto ${step.url}`;
        case 'screenshot': return `screenshot ${step.name}`;
        case 'check': return `check ${step.id}`;
        case 'remember': return `remember ${step.name}`;
        default: return step.action;
    }
};

/** How the workbench names an element: its text in quotes, otherwise role or tag. */
const shownTarget = (target = {}) => {
    const shown = target.text ?? target.label ?? target.name ?? target.own;
    return shown === undefined ? targetLabel(target) : t('session.point.quoted', { text: patternLabel(shown) });
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
        case 'fill':
        case 'type': return { kind: t('session.point.type'), label: shownTarget(step.target) };
        case 'upload': return { kind: t('session.point.upload'), label: shownTarget(step.target) };
        case 'download': return { kind: t('session.point.download'), label: shownTarget(step.target) };
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
        // As on playback: an action belongs to the next check; what comes after the last one belongs to the last.
        owner = replay.steps.slice(index).find(({ action }) => action === 'check')?.id ?? owner;
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
export const playReplay = async ({ replay, handler, session, base, authMarker, stepTimeoutMs, runTag, filesDir, log = () => {}, sleep = sleepMs, now = Date.now, effectFail = DEFAULT_EFFECT_FAIL }) => {
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
    const readState = async () => {
        const state = await readPageState(session.framework ?? frameworkOf(), session.page(), authMarker, session.messageSelectors).catch(() => null);
        for (const note of state?.notes ?? []) {
            if (known?.(note) || noted.has(note)) continue;
            noted.add(note);
            session.warn?.({ type: 'note', text: t('session.replay.newNote', { note: shownMessage(note) }) });
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
    const stateProblem = (state, step) => {
        if (state === null) return t('session.replay.pageUnreadable');
        if (!state.appLoaded) return t('session.replay.appNotLoaded', { framework: (session.framework ?? frameworkOf()).label });
        if (!state.signedIn) return LOST;
        if (state.loading) return t('session.replay.loadMask');
        if (step.path !== undefined && state.path !== step.path) return t('session.replay.wrongPath', { actual: state.path, expected: step.path });
        const message = unknownMessage(state);
        return message === undefined ? null : t('session.replay.unexpectedMessage', { message: shownMessage(message) });
    };

    const settle = async (timeoutMs) => {
        await session.page().waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
        await session.waitReady({ timeout: timeoutMs }).catch(() => {});
    };

    /** Files for upload, relative to the caw folder. Anything missing or outside aborts before anything is clicked. */
    const uploadFiles = (files) => files.map((file) => {
        const path = resolve(filesDir ?? '', file);
        const inside = filesDir !== undefined && !relative(filesDir, path).startsWith('..') && !isAbsolute(relative(filesDir, path));
        if (!inside || !existsSync(path)) throw finalError(t('session.replay.uploadMissing', { file }), 'state');
        return path;
    });
    // The page whose events belong to the element: in the workbench the app is a frame, the events come from the page.
    const pageOf = async (element) => {
        const frame = typeof element.ownerFrame === 'function' ? await element.ownerFrame().catch(() => null) : null;
        return frame?.page() ?? session.page();
    };
    /** A file input gets the files directly. A button in front opens the file chooser on click, which then gets them. */
    const upload = async (element, step, files, remaining) => {
        if (await element.evaluate((node) => node instanceof globalThis.HTMLInputElement && node.type === 'file')) {
            await element.setInputFiles(files, { timeout: remaining });
            return;
        }
        const chooser = (await pageOf(element)).waitForEvent('filechooser', { timeout: remaining }).catch(() => null);
        // Do not wait for the click first: on Windows it sometimes only returns once the file chooser has been handled.
        const clicked = element.click({ timeout: remaining, delay: CLICK_DELAY_MS }).then(() => null, (error) => error);
        const picker = await Promise.race([chooser, clicked.then((error) => (error === null ? chooser : null))]);
        if (picker === null) {
            const error = await clicked;
            if (error !== null) throw error;
            throw finalError(t('session.replay.noChooser', { target: targetLabel(step.target) }));
        }
        await picker.setFiles(files, { timeout: remaining });
        // The files are set; a click still hanging afterwards changes nothing.
        await clicked;
    };
    /** The click starts a download: its name matches the pattern and the file is not empty. */
    const download = async (element, step, remaining) => {
        const started = (await pageOf(element)).waitForEvent('download', { timeout: remaining }).catch(() => null);
        await element.click({ timeout: remaining, delay: CLICK_DELAY_MS });
        const file = await started;
        if (file === null) throw finalError(t('session.replay.noDownload', { target: targetLabel(step.target), seconds: Math.round(remaining / 1000) }), 'check');
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
        if (step.action === 'click' && previous?.action === 'click' && JSON.stringify(previous.target) === JSON.stringify(step.target)) {
            const element = await waitForTarget(session.framework ?? frameworkOf(), session.page(), step.target, { timeoutMs: Math.min(timeoutMs, REPEAT_CLICK_MS), sleep, now });
            if (element === null && (await explainTarget(session.framework ?? frameworkOf(), session.page(), step.target))?.covered !== undefined) return 'skipped';
        }
        // Optional, e.g. the cookie banner on the first visit: if the target is not there, there is nothing to do ('absent').
        if (step.optional === true) {
            const element = await waitForTarget(session.framework ?? frameworkOf(), session.page(), step.target, { timeoutMs: Math.min(timeoutMs, OPTIONAL_CLICK_MS), sleep, now });
            if (element === null) return 'absent';
        }
        for (;;) {
            const remaining = Math.max(deadline - now(), 1);
            const element = await waitForTarget(session.framework ?? frameworkOf(), session.page(), step.target, { timeoutMs: remaining, sleep, now });
            if (element === null) {
                // Is the target missing, or is something on top of it? An open dialog with a message explains more than "missing".
                const why = await explainTarget(session.framework ?? frameworkOf(), session.page(), step.target);
                const error = new Error(t('session.replay.notClickable', { target: targetLabel(step.target), seconds: Math.round(timeoutMs / 1000), why: explainText(why) }));
                if (why !== null) error.blocker = why;
                throw error;
            }
            try {
                const perform = async () => {
                    if (step.action === 'click') await element.click({ timeout: remaining, delay: CLICK_DELAY_MS });
                    else if (step.action === 'fill') await element.fill(step.value, { timeout: remaining });
                    else if (step.action === 'upload') await upload(element, step, files, remaining);
                    else if (step.action === 'download') await download(element, step, remaining);
                    else await element.type(step.value, { timeout: remaining });
                };
                // If the human is typing in the chat, they get the focus back after the action (see frameView).
                const view = session.page();
                await (typeof view?.keepChatFocus === 'function' ? view.keepChatFocus(perform) : perform());
                return;
            } catch (error) {
                // ExtJS rebuilds elements. As long as time remains, the target is looked up again.
                if (error.final || now() >= deadline) throw error;
                await sleep(CHECK_POLL_MS);
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
                const timedOut = t('session.replay.checkTimeout', { seconds: Math.round(timeoutMs / 1000), code: step.code });
                const cause = await withSignIn(failedWith === null ? timedOut : `${timedOut} ${t('session.replay.checkError', { error: failedWith })}`);
                causes.set(step.id, cause);
                results.set(step.id, { id: step.id, status: 'fail', evidence: { type: 'eval', value: last }, note: withTries(step.id, cause) });
                return;
            }
            await sleep(CHECK_POLL_MS);
        }
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
        if (TARGETED.has(step.action)) {
            const outcome = await act(step, timeoutMs, previous);
            if (outcome !== undefined) return outcome;
        } else if (step.action === 'check') await check(step, timeoutMs);
        else if (step.action === 'remember') await remember(step, timeoutMs);
        else if (step.action === 'goto' && step.denied) {
            const denied = await handler({ action: 'goto', url: step.url }).then(() => false, (error) => error.code === 'target-denied');
            if (!denied) throw new Error(t('session.replay.notDenied', { url: step.url }));
        } else if (step.action === 'goto') await handler({ action: 'goto', url: new URL(step.url, base).href });
        else if (step.action === 'wait-ready') await session.waitReady({ timeout: timeoutMs, ...(step.store === undefined ? {} : { store: step.store }), ...(step.minCount === undefined ? {} : { minCount: step.minCount }) }).catch(() => {});
        else await handler(step);
        if (CHANGES_PAGE.has(step.action) && !step.denied) await settle(timeoutMs);
    };

    const ownerOf = (index) => replay.steps.slice(index).find(({ action }) => action === 'check')?.id ?? replay.steps.findLast(({ action }) => action === 'check')?.id;
    let broken = null;
    const stop = async (position, label, kind, given, blocker) => {
        const message = await withSignIn(given);
        // Actions belong to the next check, so the abort names that one too.
        const owner = ownerOf(position - 1);
        // Clean: nothing of this step has run yet, so the page is right before it. An external failure may have changed it.
        const clean = kind !== 'external' && position - 1 === starts.get(owner);
        broken = { number: `${position}/${replay.steps.length}`, step: owner, label, kind, message, clean, ...(blocker === undefined ? {} : { blocker }) };
        const name = `fehler-schritt-${position}.png`;
        await handler({ action: 'screenshot', name }).then(() => { broken.screenshot = name; }, () => {});
    };

    // Where each step starts in the flat list.
    const starts = new Map();
    let segment = 0;
    replay.steps.forEach(({ action, id }, index) => {
        if (action !== 'check') return;
        starts.set(id, segment);
        segment = index + 1;
    });
    const marks = new Map();
    const netMarks = new Map();
    // How many write requests there were at the start of each step: a new attempt after a write would create things twice.
    const writeMarks = new Map();
    const writeCount = () => (session.writes?.() ?? []).reduce((sum, { count }) => sum + count, 0);

    /** Records the effect and compares it with the learned one. A new attempt replaces what the old one saw. */
    const noteEffect = (owner, number, effect, label) => {
        if (!observed.has(owner)) observed.set(owner, new Map());
        observed.get(owner).set(number, effect);
        const learned = replay.effects?.[owner];
        if (learned === undefined || deviations.has(owner)) return;
        const change = effectChange(learned.actions.find(({ action }) => action === number) ?? {}, effect);
        if (change !== null) deviations.set(owner, { step: owner, number, label, learned: learned.runs >= LEARN_RUNS, ...change });
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
            observed.delete(id);
            deviations.delete(id);
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

    let index = 0;
    while (index < replay.steps.length) {
        const position = index + 1;
        const recorded = replay.steps[index];
        const owner = ownerOf(index);
        const opensStep = index === starts.get(owner);
        const tagged = runTag === undefined ? recorded : fillRun(recorded, runTag);
        const step = fillDates([...remembered].reduce((current, [placeholder, value]) => swapText(current, placeholder, value), tagged));
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
        if (measure !== null && EFFECT_ACTIONS.has(step.action)) {
            await measure.before().catch(() => {});
            pending = { owner, number: index - starts.get(owner) + 1, label: stepLabel(step) };
        }
        try {
            const outcome = await run(step, step.timeoutMs ?? stepTimeoutMs, index > 0 ? replay.steps[index - 1] : undefined);
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
            const state = locked ? t('session.replay.locked') : (TARGETED.has(step.action) && !sorted ? stateProblem(await readState(), step) : null);
            const kind = sorted ? error.kind : TARGETED.has(step.action) && state === null ? 'target' : 'state';
            const message = state === null ? firstLine(error) : `${firstLine(error)} ${state}`;
            const restart = await again(owner, message);
            if (restart !== null) {
                index = restart;
                continue;
            }
            await stop(position, stepLabel(step), kind, withTries(owner, message), error.blocker);
            break;
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
        }
        index += 1;
    }
    if (broken === null) {
        const problem = await externalProblem();
        if (problem !== null) await stop(replay.steps.length, t('session.replay.end'), 'external', problem);
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
        if (results.get(id)?.status === 'pass' && deviation.learned) session.warn?.({ type: 'effect', text: deviationText(deviation) });
    }
    // Secret values stay in `remembered` for the run; in results and abort, i.e. in the report, they are redacted.
    return { results: new Map([...results].map(([id, result]) => [id, mask(result)])), broken: mask(broken), remembered, requests, effects: observed, deviations, retried };
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
 * Learned effects per action from passed steps, only on the recording target. After LEARN_RUNS healthy runs they are
 * fixed. A step with a deviation does not learn: otherwise a bug would vanish from the comparison instead of standing out.
 * @returns Map step -> recording.effects
 */
export const learnedEffects = ({ spec, results, effects, deviations, target, prune = false, fail = DEFAULT_EFFECT_FAIL }) => {
    const found = new Map();
    for (const step of spec.steps) {
        const { recording } = step;
        if (recording === undefined || recording.recordedOn !== target || results.get(step.id)?.status !== 'pass') continue;
        const deviation = deviations?.get(step.id);
        // `prune`: the whole run passed without retries. If a step then deviated only in lists outside `fail`, that is
        // noise and drops out of what was learned.
        if (deviation?.learned) {
            const pruned = prune ? pruneEffects(currentEffects(spec, step), deviation, fail) : null;
            if (pruned !== null) found.set(step.id, withBasis(spec, step, pruned));
            continue;
        }
        if (!effects?.has(step.id)) continue;
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

/** Adds baselines to the recordings. The hash stays; `network` is not part of it. */
export const withBaselines = (spec, baselines) => ({
    ...spec,
    steps: spec.steps.map((step) => (baselines.has(step.id) && step.recording !== undefined ? { ...step, recording: { ...step.recording, network: baselines.get(step.id) } } : step)),
});

/**
 * The first failed step and why. Hard failures and unexpected messages look like the app, not like a stale step; the
 * human may still fix it, it is their call.
 * @returns { id, reason, suspect, clean } or null if everything passed; `clean`: the browser is right before the step,
 *          fixing works there without a warm-up. After a failed check playback continued, so never then.
 */
export const failedStep = ({ results, broken, expectations, failures = [] }) => {
    const failed = expectations.find(({ id }) => results.get(id)?.status === 'fail');
    const suspect = broken?.kind === 'external' || failures.length > 0;
    if (failed !== undefined) return { id: failed.id, reason: results.get(failed.id).note, suspect, clean: false };
    return broken === null ? null : { id: broken.step, reason: `${broken.label}: ${broken.message}`, suspect, clean: broken.clean === true && failures.length === 0 };
};

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
