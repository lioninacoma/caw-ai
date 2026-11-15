// The seam to the framework of the application under test: judging the elements a locator finds, page state, readiness. Chosen via
// `framework` in the config; `web` is the default and needs no framework knowledge. Everything else in the tool is neutral.
//
// An adapter is an object with:
// - `targets(element, { mode, target })`: runs in the browser on an element a locator found: `reachable` (visible and not covered),
//   `blocked` (why not: { hidden } | { covered } | null), `near` ({ x, y, near }: where it is and the text around it); without an
//   element: `names` (names of visible elements with role target.role) and `scroll` (a virtual list one step further)
// - `hint(element)`: optional, runs in the browser: { component, source? } for a recorded element, a hint for diagnosis only
// - `pageState({ marker, selectors })`: runs in the browser; { appLoaded, signedIn, loading, path, messages }
// - `probe(store)`: runs in the browser; { pendingAjax, loadingStores, counts, appReady }. With `readyIgnore` it gets { store, ignore }
//   instead: CSS selectors of areas whose changes and progress indicators do not count (live ticker, clock, permanent spinner)
// - `countNetwork`: open requests from the network log count while waiting
// - `floats`: record the order of floating windows; `stackSkip`: files that only pass errors on
// - `messageSelectors`: page messages, unless the config names some
// - `hints`: optional, hints for Claude where to look in the source code
// - `watch`: optional, { label(), command, start }: the framework's watch as overlay source (--overlay); `command` recognizes its
//   process, only to find the port of a watch that runs elsewhere; `start` is the usual command, for messages
// - `overlay`: optional, with `watch`: the watch's web server as overlay source:
//   { defaultUrl, identify(base, appDir, fetch, hint), stale(base, appDir, bootstrap, fetch, hint), createWatchSource(base, appDir,
//   fetch, hint), checkAppFiles(appDir, hint), expected?(appDir, bootstrap) }. `identify` proves the server at base serves this app:
//   { state: ready, bootstrap } | { state: down } | { state: wrong-app | stale, message }; `stale` returns a message if sources are
//   missing. `expected` returns [{ label, kind, names }]: every part the overlay should replace, for the completeness check after
//   loading (a script request carrying one of the names that came from the server is a mixed state). Without it the check is skipped
// - `hydrates`: optional, true: before filling in the login, wait until `probe` reports appReady (SSR hydration)
// - `name`: for the config; `label()`: the localized name for messages (called at runtime, never at import)

import { extjs } from '../../ext/extjs/extjs.mjs';
import { angular, react, vue } from './spa.mjs';
import { web } from './web.mjs';
import { buildLocator, locatorLabel, parseLocator } from '../locator.mjs';
import { t } from '../../shared/i18n.mjs';

export const FRAMEWORKS = { web, extjs, react, vue, angular };
export const DEFAULT_FRAMEWORK = 'web';

export const frameworkOf = (config) => FRAMEWORKS[config?.framework ?? DEFAULT_FRAMEWORK] ?? web;

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// How long a locator may match several reachable elements before an action gives up. Briefly two hits are normal, e.g. while a
// dialog closes and the next one opens with the same button.
export const AMBIGUOUS_MS = 2000;

// Roles of list entries: a locator that names one may need a virtual list scrolled before its element exists.
const LISTISH = new Set(['row', 'listitem', 'option', 'gridcell', 'cell', 'treeitem']);

const isNested = (value) => value !== null && typeof value === 'object' && Array.isArray(value.chain);

/** The roles of getByRole calls in the chain, nested locators (has, and, or) included. */
const rolesIn = (chain) => chain.flatMap(({ method, args }) => [
    ...(method === 'getByRole' && typeof args[0] === 'string' ? [args[0]] : []),
    ...args.flatMap((argument) => {
        if (isNested(argument)) return rolesIn(argument.chain);
        if (argument !== null && typeof argument === 'object' && !(argument instanceof RegExp)) return Object.values(argument).filter(isNested).flatMap((inner) => rolesIn(inner.chain));
        return [];
    }),
]);

const rootOf = (root) => (typeof root === 'function' ? root() : root);
const dispose = (handles) => Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
const handlesOf = async (root, ast) => {
    try {
        return await buildLocator(root, ast).elementHandles();
    } catch {
        return [];
    }
};

/**
 * The frame the chain's contentFrame() calls lead to: root itself without any. { frame }, or { missing: label } for the first
 * iframe on the way that is missing or has not loaded anything yet.
 */
const frameOfChain = async (root, ast) => {
    let frame = root;
    for (const [index, { method }] of ast.entries()) {
        if (method !== 'contentFrame') continue;
        const handles = await handlesOf(root, ast.slice(0, index));
        const content = handles.length === 0 ? null : await handles[0].contentFrame().catch(() => null);
        await dispose(handles);
        if (content === null) return { missing: locatorLabel(ast.slice(0, index)) };
        frame = content;
    }
    return { frame };
};

/**
 * Waits until the locator matches exactly one reachable element (visible and not covered, as the adapter judges it). Covered or
 * hidden matches do not count, so a step waits for load masks and hits the topmost dialog. Several reachable matches are
 * tolerated for AMBIGUOUS_MS, e.g. while one dialog fades out and the next opens; if they stay, the result names them. No match:
 * keeps polling, and a locator for list entries scrolls a virtual list one step further each time.
 * @param root  Page or Frame the locator starts at (the application's main frame), or a function returning it on every poll
 * @param code  locator code or its AST
 * @returns { element } (an ElementHandle, or null after the timeout) and, if several matched, ambiguous: { count, candidates }
 */
export const waitForLocator = async (framework, root, code, { timeoutMs, pollMs = 150, sleep = sleepMs, now = Date.now } = {}) => {
    const ast = typeof code === 'string' ? parseLocator(code) : code;
    const scrolls = rolesIn(ast).some((role) => LISTISH.has(role));
    const deadline = now() + timeoutMs;
    let ambiguousSince = null;
    for (;;) {
        const scope = rootOf(root);
        const handles = await handlesOf(scope, ast);
        const reachable = [];
        for (const handle of handles) {
            if (await handle.evaluate(framework.targets, { mode: 'reachable' }).catch(() => false) === true) reachable.push(handle);
            else await handle.dispose().catch(() => {});
        }
        if (reachable.length === 1) return { element: reachable[0] };
        if (reachable.length > 1) {
            ambiguousSince ??= now();
            if (now() - ambiguousSince >= AMBIGUOUS_MS || now() >= deadline) {
                const candidates = [];
                for (const [index, handle] of reachable.slice(0, 3).entries()) {
                    const near = await handle.evaluate(framework.targets, { mode: 'near' }).catch(() => null);
                    candidates.push({ index, ...(near !== null && typeof near === 'object' ? near : {}) });
                }
                await dispose(reachable);
                return { element: null, ambiguous: { count: reachable.length, candidates } };
            }
            await dispose(reachable);
        } else {
            ambiguousSince = null;
            if (handles.length === 0 && scrolls) {
                const { frame } = await frameOfChain(scope, ast).catch(() => ({}));
                await frame?.evaluate(`(${framework.targets})(null, { mode: 'scroll' })`).catch(() => {});
            }
        }
        if (now() >= deadline) return { element: null };
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

const NARROWING = new Set(['filter', 'nth', 'first', 'last', 'visible']);

/**
 * Why a locator found nothing clickable: { frameMissing: label } | { missing, similar? } | { hidden } | { covered: { role|tag,
 * name?, messages? } }, or null if the adapter cannot tell. `similar` names elements of the same role whose name is close, e.g. a
 * renamed button.
 * @param root Page or Frame the locator starts at, or a function returning it
 */
export const explainLocator = async (framework, root, code) => {
    const ast = typeof code === 'string' ? parseLocator(code) : code;
    const scope = rootOf(root);
    const reached = await frameOfChain(scope, ast).catch(() => null);
    if (reached === null) return null;
    if (reached.missing !== undefined) return { frameMissing: reached.missing };
    const handles = await handlesOf(scope, ast);
    if (handles.length === 0) {
        const at = ast.findLastIndex(({ method }) => !NARROWING.has(method));
        const last = ast[at];
        const role = last?.method === 'getByRole' ? last.args[0] : undefined;
        // Roles only count visible elements: with includeHidden the element may be there, but hidden.
        if (role !== undefined && last.args[1]?.includeHidden !== true) {
            const options = { ...(last.args[1] ?? {}), includeHidden: true };
            const hidden = await handlesOf(scope, [...ast.slice(0, at), { method: 'getByRole', args: [role, options] }, ...ast.slice(at + 1)]);
            await dispose(hidden);
            if (hidden.length > 0) return { hidden: true };
        }
        const name = role === undefined ? undefined : last.args[1]?.name;
        if (typeof name !== 'string') return { missing: true };
        const names = await reached.frame.evaluate(`(${framework.targets})(null, ${JSON.stringify({ mode: 'names', target: { role } })})`).catch(() => []);
        const similar = closestNames(name, Array.isArray(names) ? names : []);
        return similar.length === 0 ? { missing: true } : { missing: true, similar: similar.map((found) => ({ role, name: found })) };
    }
    try {
        // A covered match explains more than a hidden twin, e.g. the mobile navigation.
        const reasons = [];
        for (const handle of handles) reasons.push(await handle.evaluate(framework.targets, { mode: 'blocked' }).catch(() => null));
        return reasons.find((why) => why?.covered !== undefined) ?? reasons.find((why) => why?.hidden === true) ?? null;
    } finally {
        await dispose(handles);
    }
};

/** The adapter's hint for a recorded element ({ component, source? } in React/Vue/Angular dev builds), or null. */
export const elementHint = async (framework, element) => {
    if (typeof framework.hint !== 'function') return null;
    const found = await element.evaluate(framework.hint).catch(() => null);
    return found !== null && typeof found === 'object' && typeof found.component === 'string' ? found : null;
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

const READY = { timeout: 15_000, quietMs: 250, pollMs: 100 };

/**
 * Waits until the page is quiet: nothing loading according to the adapter, with `countNetwork` no open page request either, and
 * with `minCount` at least that many hits for `store`. Quiet means `quietMs` in a row.
 * @param pending  open requests of this page (only with `countNetwork`)
 * @param ignore   CSS selectors (config `readyIgnore`): areas whose DOM changes and progress indicators do not count
 * @param untilApp also wait for `appReady` (the start page: a dev server's app mounts after `load` once its modules arrive). Quiet
 *                 without the app until the timeout counts as settled, so the caller reports the app as not loaded.
 * @returns { settled, waitedMs, samples, reason, lastSample }
 */
export const waitQuiet = async (framework, page, { store = null, minCount = null, timeout = READY.timeout, quietMs = READY.quietMs, pollMs = READY.pollMs, pending = () => 0, ignore = [], untilApp = false, sleep = sleepMs, now = Date.now } = {}) => {
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
            const app = !untilApp || lastSample.appReady === true || at - start >= timeout;
            if (app && at - quietSince >= quietMs) return { settled: true, waitedMs: at - start, samples, reason: '', lastSample };
        } else {
            quietSince = null;
        }
        if (at - start >= timeout) return { settled: false, waitedMs: at - start, samples, reason: `did not settle within ${timeout}ms`, lastSample };
        await sleep(pollMs);
    }
};
