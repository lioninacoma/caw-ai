// Ways to learn baselines and effects, replayed offline over captured runs (capture.mjs). Every method sees the same data a
// run's result.json has per step (status, requests with duration, observed effects per action) and decides, as the product
// would, whether a step fails on its effects, warns, or flags a slow request, and what it writes into the recording.
//
// M0 is the logic before the spike decision (two learning runs, pruning by healthy runs, view lines among the effects). It
// is kept here, not taken from src/host/effects.mjs, so the report stays reproducible after the product moved to M1. The
// comparison of effects is kept here too, with the view lines; deviation text, failure rule and diagnosis are the
// product's. The other methods change one thing each:
//   M1  learning phase of the first 5 healthy runs (intersection), then frozen, no pruning
//   M2  a line is learned if seen in at least 4 of the first 5 healthy runs, then frozen
//   M3  request baselines are the median of 5 healthy runs instead of one run
//   M4  generous start (no effect failures before 5 healthy runs) and only strong duration outliers count
//   M5  rolling relearning over the last 5 healthy runs (a control: it shows how relearning absorbs creep and regressions)
//   V   a modifier: view lines that carry list rows are dropped before learning and comparing
import { DEFAULT_EFFECT_FAIL, deviationText, effectCause, failsStep, viewLines } from '../../src/host/effects.mjs';
import { diagnose, slowness } from '../../src/host/diagnose.mjs';

const unique = (lines) => [...new Set(lines)];

/** The effect lists as captured: with the view lines the product measured before the spike decision. */
export const EFFECT_LISTS = ['controls', 'view', 'requests', 'responses', 'console'];
/** M0's learning runs: the logic before the spike decision. */
export const M0_LEARN_RUNS = 2;

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values, q) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * q;
    const low = Math.floor(at);
    return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
};

// ---- What a captured step offers

/** Neutral like the product's view lines: numbers become #. */
const neutral = (text) => String(text).replace(/\d+/g, '#');

/**
 * V on captured data: a view line is row content if it contains a row title of the app (capture.mjs records them per run).
 * This is an oracle for what the product would do on the ARIA tree (see viewLinesWithoutRows): it catches the
 * data-dependent lines, but also a title outside the list (the detail heading), which the tree filter would keep.
 */
export const rowlessView = (lines, rows = []) => {
    const texts = rows.map(neutral).filter((text) => text.length >= 3);
    return lines.filter((line) => !texts.some((text) => line.includes(text)));
};

/**
 * V as the product would implement it: the ARIA snapshot without the subtrees of list items, rows, options and tree items,
 * then the product's own viewLines. Needs the indented tree, which result.json does not keep, hence the oracle above.
 */
export const viewLinesWithoutRows = (aria) => {
    const kept = [];
    let skipBelow = null;
    for (const line of aria.split('\n')) {
        const indent = line.length - line.trimStart().length;
        if (skipBelow !== null && indent > skipBelow) continue;
        skipBelow = null;
        if (/^\s*- (?:listitem|row|option|treeitem|gridcell)\b/.test(line)) {
            skipBelow = indent;
            continue;
        }
        kept.push(line);
    }
    return viewLines(kept.join('\n'));
};

/** The observed effects of a captured step: Map action -> effect, view filtered by V when the method asks for it. */
export const observedOf = (step, { rows, rowless = false } = {}) => new Map((step.effects ?? []).map(({ action, ...effect }) => [
    action,
    rowless && effect.view !== undefined ? Object.fromEntries(Object.entries({ ...effect, view: rowlessView(effect.view, rows) }).filter(([, lines]) => lines.length > 0)) : effect,
]));

/** Answered requests of a step as `name status` lines: what came after the measurement is late, not missing. */
const answeredLines = (step) => (step.requests ?? []).filter(({ status }) => typeof status === 'number').map(({ name, status }) => `${name} ${status}`);
/** The step's answered requests: what missingBaselines would store from this run. */
const answeredEntries = (step) => (step.requests ?? []).filter(({ status }) => typeof status === 'number');

/** Summarized requests back to the raw shape diagnose reads: a number is an answer, a text an outcome. */
export const rawRequests = (requests = []) => requests.map(({ name, status, ms, params }) => {
    const base = { name, ms, ...(params === undefined ? {} : { params }) };
    if (typeof status === 'number') return { ...base, outcome: status < 400 ? 'ok' : 'http', status };
    if (/abort|abgebrochen/i.test(String(status))) return { ...base, outcome: 'aborted' };
    if (/open|offen/i.test(String(status))) return { ...base, outcome: 'open' };
    return { ...base, outcome: 'failed', error: String(status) };
});

// ---- Comparing, as the product did before the spike decision (src/host/effects.mjs, with the view lines)

/** Summarizes the deviation per list; null if nothing remains. */
const summarized = ({ byList, extra, instead }) => {
    const missing = Object.values(byList).flat();
    if (missing.length === 0 && extra.length === 0) return null;
    const lists = EFFECT_LISTS.filter((list) => (list === 'console' ? extra.length > 0 : (byList[list] ?? []).length > 0));
    return { missing: missing.slice(0, 8), extra, instead, lists, byList };
};

/** effectChange with the view lines: missing entries count, in the console new ones; `instead` from controls and view. */
export const effectChange = (recorded, observed) => {
    if (recorded === undefined || observed === undefined) return null;
    const now = observed ?? {};
    const nameOf = (line) => line.replace(/ form [0-9a-f]+.*$/, '');
    const answered = new Set((now.responses ?? []).map(nameOf));
    const counts = (list, line) => list !== 'responses' || answered.has(nameOf(line));
    const byList = Object.fromEntries(EFFECT_LISTS.filter((list) => list !== 'console')
        .map((list) => [list, (recorded[list] ?? []).filter((line) => !(now[list] ?? []).includes(line) && counts(list, line))]));
    const extra = (now.console ?? []).filter((line) => !(recorded.console ?? []).includes(line));
    const instead = ['controls', 'view'].flatMap((list) => (now[list] ?? []).filter((line) => !(recorded[list] ?? []).includes(line))).slice(0, 6);
    return summarized({ byList, extra: extra.slice(0, 5), instead });
};

/** withoutLate with the view lines: a request answered later in the same step is not missing. */
export const withoutLate = (deviation, answered) => {
    if (deviation === undefined || deviation === null) return null;
    const late = new Set(answered);
    const byList = { ...deviation.byList, requests: (deviation.byList?.requests ?? []).filter((line) => !late.has(line)) };
    const rest = summarized({ byList, extra: deviation.extra, instead: deviation.instead });
    return rest === null ? null : { ...deviation, ...rest };
};

/**
 * M0's self-cleanup: what was missing in a fully healthy run in a list outside `fail` dropped out of the learned effects.
 * @returns the new effects or null if there is nothing to drop
 */
export const pruneEffects = (recorded, deviation, fail = DEFAULT_EFFECT_FAIL) => {
    if (recorded === undefined || deviation === undefined || deviation === null || deviation.lists.some((list) => fail.includes(list))) return null;
    const drop = Object.entries(deviation.byList ?? {}).filter(([list]) => !fail.includes(list));
    if (drop.every(([, lines]) => lines.length === 0)) return null;
    const actions = recorded.actions.map((entry) => {
        if (entry.action !== deviation.number) return entry;
        const kept = Object.fromEntries(EFFECT_LISTS.map((list) => {
            const gone = new Set(drop.find(([name]) => name === list)?.[1] ?? []);
            return [list, (entry[list] ?? []).filter((line) => !gone.has(line))];
        }).filter(([, lines]) => lines.length > 0));
        return { action: entry.action, ...kept };
    }).filter((entry) => Object.keys(entry).length > 1);
    return { ...recorded, actions };
};

// ---- Learners

/**
 * The product's learnEffects with the number of learning runs as a parameter: the intersection of the first `runs` healthy
 * runs, the console as a union. M0 uses it with two runs; with the product's LEARN_RUNS and without view lines it is the
 * product's function (a unit test pins that).
 */
export const learnIntersect = (recorded, observed, runs) => {
    if (recorded !== undefined && recorded.runs >= runs) return null;
    const known = new Map((recorded?.actions ?? []).map((entry) => [entry.action, entry]));
    const numbers = recorded === undefined ? [...observed.keys()] : [...known.keys()];
    const actions = numbers.sort((a, b) => a - b).map((number) => {
        const now = observed.get(number) ?? {};
        const then = known.get(number);
        const lists = EFFECT_LISTS.map((list) => {
            const fresh = now[list] ?? [];
            if (then === undefined) return [list, fresh];
            const old = then[list] ?? [];
            return [list, list === 'console' ? unique([...old, ...fresh]).slice(0, 12) : old.filter((line) => fresh.includes(line))];
        }).filter(([, lines]) => lines.length > 0);
        return lists.length === 0 ? null : { action: number, ...Object.fromEntries(lists) };
    }).filter((entry) => entry !== null);
    return { runs: (recorded?.runs ?? 0) + 1, actions };
};

/**
 * Effects by frequency: a line counts if it was seen in at least `threshold` of the given runs; the console as a union.
 * @param history observed effects of healthy runs, each a Map action -> effect
 */
export const learnFrequency = (history, threshold, runs = history.length) => {
    const numbers = unique(history.flatMap((observed) => [...observed.keys()])).sort((a, b) => a - b);
    const actions = numbers.map((number) => {
        const lists = EFFECT_LISTS.map((list) => {
            const seen = history.map((observed) => observed.get(number)?.[list] ?? []);
            if (list === 'console') return [list, unique(seen.flat()).slice(0, 12)];
            const counts = new Map();
            for (const lines of seen) for (const line of unique(lines)) counts.set(line, (counts.get(line) ?? 0) + 1);
            return [list, [...counts].filter(([, count]) => count >= threshold).map(([line]) => line)];
        }).filter(([, lines]) => lines.length > 0);
        return lists.length === 0 ? null : { action: number, ...Object.fromEntries(lists) };
    }).filter((entry) => entry !== null);
    return { runs, actions };
};

// ---- The methods

/**
 * effects: how effects are learned (before: two learning runs + pruneEffects, the logic before the spike decision;
 *          intersect; frequency; rolling)
 * durations: how request baselines are learned (single: the first healthy run, as missingBaselines; median; strong; rolling)
 * generous: healthy runs a step must have seen before its effects may fail it
 */
const METHOD_LIST = [
    { id: 'M0', label: "today's logic", effects: { kind: 'before' }, durations: { kind: 'single' }, learnRuns: M0_LEARN_RUNS },
    { id: 'M1', label: 'learn 5, then frozen', effects: { kind: 'intersect', runs: 5 }, durations: { kind: 'single' }, learnRuns: 5 },
    { id: 'M2', label: 'lines seen in >=4 of 5', effects: { kind: 'frequency', runs: 5, threshold: 4 }, durations: { kind: 'single' }, learnRuns: 5 },
    { id: 'M3', label: 'median of 5 durations', effects: { kind: 'before' }, durations: { kind: 'median', runs: 5 }, learnRuns: M0_LEARN_RUNS },
    { id: 'M4', label: 'strong outliers only', effects: { kind: 'before' }, durations: { kind: 'strong', runs: 5 }, generous: 5, learnRuns: 5 },
    { id: 'M5', label: 'rolling relearning', effects: { kind: 'rolling', runs: 5, threshold: 4 }, durations: { kind: 'rolling', runs: 5 }, learnRuns: 5 },
];
export const METHODS = Object.fromEntries([
    ...METHOD_LIST.map((method) => [method.id, method]),
    // V on the effect learners it could change.
    ...['M0', 'M1', 'M2'].map((id) => [`${id}V`, { ...METHOD_LIST.find((method) => method.id === id), id: `${id}V`, label: `${METHOD_LIST.find((method) => method.id === id).label} + V`, rowless: true }]),
]);

/** A fresh state: per step id { effects, history, network, samples, healthy }. */
export const initState = () => ({ steps: {} });
const stepState = (state, id) => state.steps[id] ?? { healthy: 0 };

const isLearned = (method, learned) => learned !== undefined && learned.runs >= (method.effects.kind === 'before' ? M0_LEARN_RUNS : method.effects.runs);

/** The request baseline used for duration and diagnosis: name -> { ms, status, params } or undefined while learning. */
const baselineOf = (method, own) => {
    if (method.durations.kind === 'single') return own.network;
    if (own.samples === undefined || Object.keys(own.samples).length === 0) return undefined;
    const enough = method.durations.kind === 'rolling' ? own.healthy >= method.durations.runs : Object.values(own.samples).some((list) => list.length >= method.durations.runs);
    if (!enough) return undefined;
    return Object.entries(own.samples).map(([name, list]) => ({ ...own.shape[name], name, ms: Math.round(median(list)) }));
};

/** Does this answered request count as slow for the method? Today: slowness() with the baseline of one run. */
const slowFlag = (method, own, request) => {
    const baseline = baselineOf(method, own);
    const then = baseline?.find(({ name }) => name === request.name);
    const verdict = slowness(request.ms ?? 0, then);
    if (method.durations.kind !== 'strong') return verdict !== null;
    // Strong: nothing before the learning runs, then only outliers far beyond the spread of the healthy runs.
    const list = own.samples?.[request.name];
    if (list === undefined || list.length < method.durations.runs) return false;
    const q1 = quantile(list, 0.25);
    const q3 = quantile(list, 0.75);
    return verdict !== null && request.ms > q3 + 3 * Math.max(q3 - q1, 1);
};

/**
 * Judges one captured run with the method's learned state.
 * @param ctx { fail: lists that fail a step, compare: whether effects and durations are compared at all on this environment }
 * @returns { steps: [{ id, status, cause, deviation, warn, slow }], failed, failedBy, warnings, slowFlags }
 */
export const judgeRun = (method, state, row, { fail = DEFAULT_EFFECT_FAIL, compare = true } = {}) => {
    const steps = [];
    let failed = null;
    let failedBy = null;
    for (const step of row.steps ?? []) {
        if (failed !== null) {
            steps.push({ id: step.id, status: 'skipped' });
            continue;
        }
        if (step.status !== 'pass') {
            // The step's check, target or a hard failure: the product decides that, whatever the method learned.
            steps.push({ id: step.id, status: step.status, cause: 'product' });
            if (step.status === 'fail') {
                failed = step.id;
                failedBy = 'product';
            }
            continue;
        }
        const own = stepState(state, step.id);
        const learned = compare ? own.effects : undefined;
        let deviation = null;
        if (learned !== undefined) {
            for (const [number, effect] of [...observedOf(step, { rows: row.rows, rowless: method.rowless })].sort(([a], [b]) => a - b)) {
                const change = effectChange(learned.actions.find(({ action }) => action === number) ?? {}, effect);
                if (change !== null) {
                    deviation = { step: step.id, label: step.id, number, learned: isLearned(method, learned), ...change };
                    break;
                }
            }
            deviation = withoutLate(deviation, answeredLines(step));
        }
        const allowed = own.healthy >= (method.generous ?? 0);
        const fails = deviation !== null && allowed && failsStep(deviation, fail);
        const slow = compare ? answeredEntries(step).filter((request) => slowFlag(method, own, request)).map(({ name }) => name) : [];
        if (fails) {
            steps.push({ id: step.id, status: 'fail', cause: 'effect', deviation: { ...deviation, fails: true }, slow });
            failed = step.id;
            failedBy = 'effect';
        } else {
            steps.push({ id: step.id, status: 'pass', deviation, warn: deviation !== null && deviation.learned === true, slow });
        }
    }
    return {
        steps,
        failed,
        failedBy,
        warnings: steps.filter(({ warn }) => warn).length,
        slowFlags: steps.reduce((sum, { slow }) => sum + (slow?.length ?? 0), 0),
    };
};

/** Learns the effects of one passed step; returns the new effects or undefined to keep them. */
const learnedEffectsOf = (method, own, observed, deviation, { healthyRun, fail }) => {
    const { effects } = method;
    if (effects.kind === 'before') {
        // replay.mjs learnedEffects before the decision: a learned deviation is never learned; a fully healthy run prunes it
        // outside `fail`.
        if (deviation?.learned) return (healthyRun ? pruneEffects(own.effects, deviation, fail) : null) ?? undefined;
        return learnIntersect(own.effects, observed, M0_LEARN_RUNS) ?? undefined;
    }
    if (effects.kind === 'intersect') return deviation?.learned ? undefined : learnIntersect(own.effects, observed, effects.runs) ?? undefined;
    if (effects.kind === 'frequency') {
        if ((own.history?.length ?? 0) >= effects.runs) return undefined;
        const history = [...(own.history ?? []), observed];
        return { learned: learnFrequency(history, Math.min(effects.threshold, history.length), history.length), history };
    }
    // Rolling: every healthy run joins the window, deviations included. That is how relearning absorbs a change.
    const history = [...(own.history ?? []), observed].slice(-effects.runs);
    return { learned: learnFrequency(history, Math.min(effects.threshold, history.length), (own.effects?.runs ?? 0) + 1), history };
};

/**
 * Learns from one judged run, as a run outside CI does after its verdict (missingBaselines + learnedEffects).
 * @returns the new state (the old one if nothing changed)
 */
export const learnRun = (method, state, row, judgment, { fail = DEFAULT_EFFECT_FAIL } = {}) => {
    const healthyRun = judgment.failed === null;
    const steps = { ...state.steps };
    let changed = false;
    for (const verdict of judgment.steps) {
        if (verdict.status !== 'pass') continue;
        const step = row.steps.find(({ id }) => id === verdict.id);
        const own = { ...stepState(state, step.id) };
        own.healthy += 1;
        const observed = observedOf(step, { rows: row.rows, rowless: method.rowless });
        if (step.effects !== undefined) {
            const learned = learnedEffectsOf(method, own, observed, verdict.deviation, { healthyRun, fail });
            if (learned !== undefined && 'history' in learned) {
                own.history = learned.history;
                own.effects = learned.learned;
            } else if (learned !== undefined) own.effects = learned;
        }
        const answered = answeredEntries(step);
        if (method.durations.kind === 'single') {
            // missingBaselines: only while there is none, or one from before parameter names were recorded.
            const complete = own.network !== undefined && own.network.every((entry) => entry.params !== undefined);
            if (!complete && answered.length > 0) own.network = answered;
        } else {
            const rolling = method.durations.kind === 'rolling';
            const samples = { ...(own.samples ?? {}) };
            const shape = { ...(own.shape ?? {}) };
            for (const request of answered) {
                const list = samples[request.name] ?? [];
                if (!rolling && list.length >= method.durations.runs) continue;
                samples[request.name] = [...list, request.ms ?? 0].slice(-method.durations.runs);
                shape[request.name] ??= { status: request.status, ...(request.params === undefined ? {} : { params: request.params }) };
            }
            own.samples = samples;
            own.shape = shape;
        }
        steps[step.id] = own;
        changed = true;
    }
    return changed ? { steps } : state;
};

/**
 * What the method keeps in the recording, per step: the learned effects and the baselines. Samples still being collected
 * are part of it: a method that needs five runs has to keep them somewhere the next run reads.
 */
export const persisted = (method, state) => Object.fromEntries(Object.entries(state.steps).map(([id, own]) => {
    const network = method.durations.kind === 'single' ? own.network
        : own.samples === undefined ? undefined
            : Object.entries(own.samples).map(([name, list]) => ({ name, ...own.shape[name], ms: Math.round(median(list)), ...(list.length < method.durations.runs || method.durations.kind === 'rolling' ? { samples: list } : {}) }));
    return [id, { ...(own.effects === undefined ? {} : { effects: own.effects }), ...(network === undefined ? {} : { network }) }];
}));

/**
 * The product's diagnosis of a failed run, with the method's baseline and deviation as evidence.
 * @returns { side, strength } or null if the run did not fail
 */
export const diagnoseRun = (method, state, row, judgment) => {
    if (judgment.failed === null) return null;
    const index = row.steps.findIndex(({ id }) => id === judgment.failed);
    const step = row.steps[index];
    const verdict = judgment.steps[index];
    const product = row.diagnosis?.step === step.id ? row.diagnosis : undefined;
    const requests = product?.requests ?? rawRequests(step.requests);
    const effectFail = verdict.cause === 'effect';
    const reason = effectFail ? `${effectCause()} ${deviationText(verdict.deviation)}` : row.results?.find(({ id }) => id === step.id)?.note ?? '';
    const broken = effectFail ? { kind: 'check', step: step.id } : step.kind === undefined ? null : { kind: step.kind, step: step.id };
    // The first deviation up to this step: where the app first behaved differently.
    const first = judgment.steps.slice(0, index + 1).map(({ deviation: found }) => found).find((found) => found !== null && found !== undefined) ?? null;
    // Before the decision diagnose counted view lines like controls as a page-only deviation.
    const deviation = first === null ? null : { ...first, lists: unique(first.lists.map((list) => (list === 'view' ? 'controls' : list))) };
    const previous = index > 0 ? row.steps[index - 1] : null;
    const found = diagnose({
        failed: { id: step.id, reason },
        broken,
        failures: row.failures ?? [],
        requests,
        baseline: baselineOf(method, stepState(state, step.id)),
        deviation,
        earlier: previous === null ? null : { id: previous.id, requests: rawRequests(previous.requests) },
    });
    return { side: found.side, strength: found.strength };
};

export { median, quantile };
