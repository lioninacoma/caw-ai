// The seam to the framework of the application under test: describing and finding targets, page state, readiness. Chosen via
// `framework` in the config; `web` is the default and needs no framework knowledge. Everything else in the tool is neutral.
//
// An adapter is an object with:
// - `targets(element, { mode, target })`: runs in the browser; `describe` returns a stable target (with `index` as soon as several
//   elements match), `find` the matching element, `ambiguity` { count, candidates } of all matches
// - `pageState({ marker, selectors })`: runs in the browser; { appLoaded, signedIn, loading, path, messages }
// - `probe(store)`: runs in the browser; { pendingAjax, loadingStores, counts, appReady }. With `readyIgnore` it gets { store, ignore }
//   instead: CSS selectors of areas whose changes and progress indicators do not count (live ticker, clock, permanent spinner)
// - `countNetwork`: open requests from the network log count while waiting
// - `floats`: record the order of floating windows; `stackSkip`: files that only pass errors on
// - `messageSelectors`: page messages, unless the config names some
// - `hints`: optional, hints for Claude where to look in the source code
// - `watch`: optional, { label(), command, start }: the framework's watch as overlay source (--overlay), how to recognize its
//   process and how to start it
// - `overlay`: optional, with `watch`: { createWatchSource(appDir), checkAppFiles(appDir, hint) }; what the watch replaces
// - `hydrates`: optional, true: before filling in the login, wait until `probe` reports appReady (SSR hydration)
// - `name`: for the config; `label()`: the localized name for messages (called at runtime, never at import)

import { extjs } from './extjs.mjs';
import { angular, react, vue } from './spa.mjs';
import { web, webTargets } from './web.mjs';
import { patternLabel } from '../patterns.mjs';
import { t } from '../../shared/i18n.mjs';

export const FRAMEWORKS = { web, extjs, react, vue, angular };
export const DEFAULT_FRAMEWORK = 'web';

export const frameworkOf = (config) => FRAMEWORKS[config?.framework ?? DEFAULT_FRAMEWORK] ?? web;

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Describes the element behind a locator as a stable target, or null. */
export const describeLocator = (framework, locator, options) => locator.evaluate(framework.targets, { mode: 'describe' }, options);

const findExpression = (framework, target) => `(${framework.targets})(null, ${JSON.stringify({ mode: 'find', target })})`;
// How many elements match a target without `index`, with the first three as { index, x, y, near }.
const ambiguityExpression = (framework, target) => `(${framework.targets})(null, ${JSON.stringify({ mode: 'ambiguity', target })})`;

// iframes: a target in a frame of the application carries the iframe element under `frame`, described in the document above,
// with nested frames again under `frame`. The `web` adapter always describes and finds the iframe: a framework adapter like
// ExtJS does not know it as a component.

/**
 * The frame for a `frame` entry: find the iframe in the document above, then its content. Without an entry the page itself; null
 * while the iframe is missing or has not loaded anything yet.
 */
export const frameOf = async (page, frameTarget) => {
    if (frameTarget === undefined) return page;
    const { frame: outer, ...own } = frameTarget;
    const parent = await frameOf(page, outer);
    if (parent === null) return null;
    const handle = await parent.evaluateHandle(`(${webTargets})(null, ${JSON.stringify({ mode: 'find', target: own, exact: true })})`).catch(() => null);
    const element = handle?.asElement() ?? null;
    if (element === null) {
        await handle?.dispose().catch(() => {});
        return null;
    }
    const frame = await element.contentFrame().catch(() => null);
    await element.dispose().catch(() => {});
    return frame;
};

/**
 * The `frame` entry for an element in `frame`: the iframes from that frame up to the application, each described in the document
 * above. undefined in the main frame; null if an iframe cannot be described or the frame does not belong to the application.
 */
export const frameTargetOf = async (page, frame) => {
    const top = page.mainFrame();
    const levels = [];
    let current = frame;
    for (; current !== null && current !== top; current = current.parentFrame()) {
        const element = await current.frameElement().catch(() => null);
        if (element === null) return null;
        const described = await element.evaluate(webTargets, { mode: 'describe', exact: true }).catch(() => null);
        await element.dispose().catch(() => {});
        if (described === null) return null;
        levels.push(described);
    }
    if (current === null) return null;
    let chain;
    for (const level of levels.reverse()) chain = chain === undefined ? level : { ...level, frame: chain };
    return chain;
};

/** Describes an element with its frame: the target as in `describeLocator`, from an iframe with `frame`. null if that fails. */
export const describeElement = async (framework, page, element, options) => {
    const described = await element.evaluate(framework.targets, { mode: 'describe' }, options);
    if (described === null || described === undefined) return null;
    const frame = await element.ownerFrame().catch(() => null);
    if (frame === null || frame === page.mainFrame()) return described;
    const chain = await frameTargetOf(page, frame);
    return chain === null ? null : chain === undefined ? described : { ...described, frame: chain };
};

// How long a target may stay ambiguous before an action that requires a unique one gives up. Briefly two hits are normal, e.g.
// while a dialog closes and the next one opens.
const AMBIGUOUS_MS = 2000;

/**
 * Waits until the target is clickable. Evaluation fails during navigation, which is expected.
 * @param unique  for a target without `index`: 'fail' waits for a single hit and returns null if several stay (`report.ambiguous`
 *                then holds { count, candidates }); 'warn' takes the first hit and only notes the ambiguity in `report`
 */
export const waitForTarget = async (framework, page, target, { timeoutMs, pollMs = 150, sleep = sleepMs, now = Date.now, unique, report } = {}) => {
    const deadline = now() + timeoutMs;
    const { frame: frameTarget, ...own } = target;
    const checkUnique = (unique === 'fail' || unique === 'warn') && own.index === undefined;
    let ambiguousSince = null;
    for (;;) {
        const scope = await frameOf(page, frameTarget);
        const handle = scope === null ? null : await scope.evaluateHandle(findExpression(framework, own)).catch(() => null);
        const found = handle?.asElement() ?? null;
        if (found !== null) {
            const ambiguity = checkUnique ? await (async () => scope.evaluate(ambiguityExpression(framework, own)))().catch(() => null) : null;
            const several = ambiguity !== null && typeof ambiguity === 'object' && ambiguity.count > 1;
            if (report !== undefined) report.ambiguous = several ? ambiguity : undefined;
            if (!several || unique === 'warn') return found;
            await found.dispose().catch(() => {});
            ambiguousSince ??= now();
            if (now() - ambiguousSince >= AMBIGUOUS_MS) return null;
        } else {
            ambiguousSince = null;
            if (report !== undefined) report.ambiguous = undefined;
            await handle?.dispose().catch(() => {});
        }
        if (now() >= deadline) return null;
        await sleep(pollMs);
    }
};

/** The candidates of an ambiguous target for a message: position on the page and the text around it, at most three. */
export const ambiguityText = ({ count, candidates = [] }) => candidates.slice(0, 3).map(({ index, x, y, near }) => t('session.replay.ambiguousCandidate', {
    number: index + 1,
    x: Math.round(x ?? 0),
    y: Math.round(y ?? 0),
    near: typeof near === 'string' && near !== '' ? t('session.replay.ambiguousNear', { text: near }) : '',
})).join('; ') + (count > 3 ? t('session.replay.ambiguousMore', { count: count - 3 }) : '');

/**
 * Why a target was not clickable, if the adapter can tell: { missing } | { hidden } | { covered: { role|tag, name?, messages? } }.
 * Adapters without that information return null.
 */
export const explainTarget = async (framework, page, target) => {
    const { frame: frameTarget, ...own } = target;
    const scope = await frameOf(page, frameTarget).catch(() => null);
    if (scope === null) return { frameMissing: targetLabel(frameTarget) };
    const why = await (async () => scope.evaluate(`(${framework.targets})(null, ${JSON.stringify({ mode: 'explain', target: own })})`))().catch(() => null);
    if (why === null || typeof why !== 'object' || Array.isArray(why) || !(why.missing || why.hidden || why.covered)) return null;
    if (!why.missing) return why;
    const { names, ...rest } = why;
    const similar = closestNames(target.name ?? target.text ?? target.label, Array.isArray(names) ? names : []);
    return similar.length === 0 ? rest : { ...rest, similar: similar.map((name) => ({ role: target.role, name })) };
};

const editDistance = (a, b) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
        const next = [i];
        for (let j = 1; j <= b.length; j += 1) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        row = next;
    }
    return row[b.length];
};
const words = (text) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));

/**
 * The names closest to the wanted one: small edit distance or a shared word. Helps with renamed buttons ("Speichern" to
 * "Sichern", "Akte anlegen" to "Neue Akte anlegen"). At most two, best first.
 */
export const closestNames = (wanted, names) => {
    if (typeof wanted !== 'string' || wanted.trim() === '') return [];
    const goal = wanted.trim().toLowerCase();
    const goalWords = words(goal);
    return names.filter((name) => typeof name === 'string' && name.trim().toLowerCase() !== goal).map((name) => {
        const text = name.trim().toLowerCase();
        const distance = editDistance(goal, text) / Math.max(goal.length, text.length);
        const shared = [...words(text)].some((word) => goalWords.has(word));
        return { name, score: shared ? Math.min(distance, 0.35) : distance };
    }).filter(({ score }) => score <= 0.4).sort((a, b) => a.score - b.score).slice(0, 2).map(({ name }) => name);
};

/** The matching sentence for message and report, or ''. */
export const explainText = (why) => {
    if (why === null || why === undefined) return '';
    if (why.frameMissing) return t('session.explain.frameMissing', { frame: why.frameMissing });
    if (why.missing) {
        const similar = (why.similar ?? []).map(({ role, name }) => `${role} ${t('session.point.quoted', { text: name })}`);
        return t('session.explain.missing') + (similar.length === 0 ? '' : t('session.explain.similar', { names: similar.join(', ') }));
    }
    if (why.hidden) return t('session.explain.hidden');
    const { role, tag, name, messages = [] } = why.covered;
    const by = `${role ?? tag}${name === undefined ? '' : ` ${t('session.point.quoted', { text: name })}`}`;
    if (messages.length === 0) return t('session.explain.covered', { by });
    const said = messages.map((text) => t('session.point.quoted', { text })).join(', ');
    return t('session.explain.coveredSays', { by, messages: said, end: /[.!?]$/.test(messages.at(-1)) ? '' : '.' });
};

export const DEFAULT_SELECTORS = ['[role=alert]', '[role=alertdialog]'];

export const readPageState = async (framework, page, marker, selectors = DEFAULT_SELECTORS) => page.evaluate(framework.pageState, { marker, selectors });

/** Short form for messages, e.g. actionbutton "Weiter" or button "Senden". */
export const targetLabel = ({ xtype, role, tag, text, label, name, own, testid, part, component }) => {
    const shown = text ?? label ?? name ?? own ?? (testid === undefined ? undefined : `#${testid}`);
    return `${xtype ?? role ?? part ?? tag ?? 'Element'}${shown === undefined ? '' : ` "${patternLabel(shown)}"`}${component === undefined ? '' : ` in <${component}>`}`;
};

const READY = { timeout: 15_000, quietMs: 250, pollMs: 100 };

/**
 * Waits until the page is quiet: nothing loading according to the adapter, with `countNetwork` no open page request either, and
 * with `minCount` at least that many hits for `store`. Quiet means `quietMs` in a row.
 * @param pending  open requests of this page (only with `countNetwork`)
 * @param ignore   CSS selectors (config `readyIgnore`): areas whose DOM changes and progress indicators do not count
 * @returns { settled, waitedMs, samples, reason, lastSample }
 */
export const waitQuiet = async (framework, page, { store = null, minCount = null, timeout = READY.timeout, quietMs = READY.quietMs, pollMs = READY.pollMs, pending = () => 0, ignore = [], sleep = sleepMs, now = Date.now } = {}) => {
    const start = now();
    // Without selectors the probe gets the store alone, as always.
    const selectors = Array.isArray(ignore) ? ignore.filter((selector) => typeof selector === 'string' && selector.trim() !== '') : [];
    const argument = selectors.length === 0 ? store : { store, ignore: selectors };
    let samples = 0;
    let lastSample = null;
    let quietSince = null;
    for (;;) {
        const sample = await page.evaluate(framework.probe, argument).catch(() => null);
        samples += 1;
        if (sample !== null) {
            lastSample = framework.countNetwork ? { ...sample, pendingAjax: sample.pendingAjax + pending(page) } : sample;
        }
        const at = now();
        const quiet = sample !== null && lastSample.pendingAjax === 0 && lastSample.loadingStores === 0
            && (minCount === null || (lastSample.counts !== null && lastSample.counts >= minCount));
        if (quiet) {
            quietSince ??= at;
            if (at - quietSince >= quietMs) return { settled: true, waitedMs: at - start, samples, reason: '', lastSample };
        } else {
            quietSince = null;
        }
        if (at - start >= timeout) return { settled: false, waitedMs: at - start, samples, reason: `did not settle within ${timeout}ms`, lastSample };
        await sleep(pollMs);
    }
};
