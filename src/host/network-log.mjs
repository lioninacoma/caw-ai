// What the app requested during a run, independent of the framework: method, name, status, duration, outcome.
import { t } from '../shared/i18n.mjs';

// Parameter values never end up here, only the names from `requestKeys` that identify a request.

const MAX_SUMMARY = 20;
const ABORTED = /ERR_ABORTED|NS_BINDING_ABORTED|aborted/i;
// A router aborts open requests when it changes route, sometimes shortly before it sets the URL (Angular only updates
// it after activation). A route change counts as the cause if it lies up to 1 s before or 0.5 s after the abort.
const ROUTE_GRACE_MS = 500;

// Path segments that denote a record, not the endpoint: numbers, UUIDs, long hex or random IDs and the run tag.
// Otherwise /bestellung/1001 in the recording would be named differently from /bestellung/1002 in the run. Short random IDs
// (nanoid, Firebase: "j46FjCJIrJQ4V0gp") are recognized by digits together with upper and lower case letters.
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[\w-]*\d)[\w-]{20,}|.*CAW-\d{8,}.*)$/i;
const RANDOM_SEGMENT = /^(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{12,}$/;

const isId = (part) => ID_SEGMENT.test(part) || RANDOM_SEGMENT.test(part);

/** The path with `:id` instead of IDs. */
export const neutralPath = (pathname) => pathname.split('/').map((part) => (isId(decodeURIComponentSafe(part)) ? ':id' : part)).join('/');
const decodeURIComponentSafe = (part) => {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
};

/** A name as stored in older recordings, with a neutral path: "GET /a/1001 x=1" becomes "GET /a/:id x=1". */
export const neutralName = (name) => {
    const [method, path, ...rest] = String(name).split(' ');
    return path === undefined || !path.startsWith('/') ? name : [method, neutralPath(path), ...rest].join(' ');
};

/**
 * The name of a request: method and path, IDs in the path as `:id`. If an app routes everything through one path, `keys` names the parameters that tell requests apart.
 * @param keys names of query parameters whose value belongs to the name, e.g. ["action"]
 */
export const requestName = ({ method, url }, keys = []) => {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return `${method.toUpperCase()} ?`;
    }
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const parts = [...parsed.searchParams].filter(([key]) => wanted.has(key.toLowerCase())).map(([key, value]) => `${key}=${value.slice(0, 120)}`);
    return [`${method.toUpperCase()} ${neutralPath(parsed.pathname)}`, ...parts].join(' ');
};

const MAX_PARAMS = 20;
/** Keys of a JSON body appear among the parameters with this prefix, separate from query parameters of the same name. */
export const JSON_PREFIX = 'json.';

/**
 * The parameter names, without values: from the query and from a form body. If they differ from the recording, the
 * call has changed, e.g. a renamed parameter. The names from `requestKeys` are already part of the request name.
 */
export const parameterNames = ({ url, postData = null, contentType = '' }, keys = []) => {
    const skip = new Set(keys.map((key) => key.toLowerCase()));
    const names = new Set();
    try {
        for (const [key] of new URL(url).searchParams) names.add(key);
    } catch {
        // Without a readable URL only the names from the body remain.
    }
    if (typeof postData === 'string' && /application\/x-www-form-urlencoded/i.test(contentType)) {
        for (const [key] of new URLSearchParams(postData)) names.add(key);
    }
    // A renamed field in a JSON body: the top-level keys, for a list those of the first entry.
    if (typeof postData === 'string' && /json/i.test(contentType)) {
        try {
            const body = JSON.parse(postData);
            const shape = Array.isArray(body) ? body[0] : body;
            if (shape !== null && typeof shape === 'object' && !Array.isArray(shape)) for (const key of Object.keys(shape)) names.add(`${JSON_PREFIX}${key}`);
        } catch {
            // Not JSON despite the type: only the query remains.
        }
    }
    return [...names].filter((name) => !skip.has(name.toLowerCase())).map((name) => name.slice(0, 60)).sort().slice(0, MAX_PARAMS);
};

/** The outcome in one word, for report, chat and Claude. */
export const outcomeText = ({ outcome, status, error }) => {
    if (outcome === 'ok') return String(status);
    if (outcome === 'http') return `HTTP ${status}`;
    if (outcome === 'aborted') return t('run.network.aborted');
    if (outcome === 'failed') return t('run.network.failed', { error });
    // Headers arrived, end never reported (stream or proxy without a clean end): the status is known anyway.
    if (status !== undefined) return status >= 400 ? `HTTP ${status}` : String(status);
    return t('run.network.open');
};

/**
 * After the headers, the body gets this long before a response no longer counts as open. Some proxies (e.g. the Vite one on
 * 401) never report the end; without this grace period every following action would wait until the limit for hanging requests.
 */
const BODY_GRACE_MS = 1500;

/**
 * Request log. The host feeds it from browser events.
 * @param now clock in ms
 */
export const createNetworkLog = ({ now = () => Date.now() } = {}) => {
    const entries = [];
    const open = new Map();
    // Per page the start of the last navigation: an abort after it belongs to the navigation, not to the app. A change of
    // only the hash or via pushState does not count, since the document stays and nothing is aborted.
    const navigations = new Map();
    // Per page the times of route changes within the same document (pushState, replaceState, popstate, hash): a single-page
    // router aborts open requests of the old view on those. That is not an app failure.
    const routes = new Map();
    const routedAfter = (entry) => (routes.get(entry.page) ?? []).some((at) => at >= Math.max(entry.start, entry.end - ROUTE_GRACE_MS * 2) && at <= entry.end + ROUTE_GRACE_MS);
    const finish = (key, fields) => {
        const entry = open.get(key);
        if (entry === undefined) return;
        open.delete(key);
        Object.assign(entry, fields, { ms: Math.max(0, now() - entry.start) });
    };
    return {
        /** @param params parameter names, possibly empty: the comparison with the recording needs both, `[]` and unknown. */
        started: (key, { name, page, params }) => {
            const entry = { name, ...(params === undefined ? {} : { params }), page, start: now(), outcome: 'open' };
            entries.push(entry);
            open.set(key, entry);
        },
        finished: (key, status) => finish(key, status >= 400 ? { outcome: 'http', status } : { outcome: 'ok', status }),
        /**
         * The headers arrived. A stream (server-sent events, NDJSON) stays open as long as the page lives and does not hold up
         * waiting; otherwise the body gets BODY_GRACE_MS more.
         */
        answered: (key, status, stream = false) => {
            const entry = open.get(key);
            if (entry === undefined) return;
            entry.status = status;
            if (stream) entry.stream = true;
            else entry.answeredAt = now();
        },
        failed: (key, error) => {
            const entry = open.get(key);
            if (entry === undefined) return;
            const navigated = (navigations.get(entry.page) ?? -1) >= entry.start;
            if (ABORTED.test(error)) {
                Object.assign(entry, { end: now() });
                finish(key, { outcome: 'aborted', navigated });
            } else {
                finish(key, { outcome: 'failed', error: String(error).slice(0, 200) });
            }
        },
        /** The app changes route without loading a new document. */
        routed: (page) => {
            const list = routes.get(page) ?? [];
            list.push(now());
            routes.set(page, list.slice(-50));
        },
        /** The page loads a new document: request of the main frame. */
        navigating: (page) => navigations.set(page, now()),
        /**
         * The new document is in place. Whatever the old one started before the change and is still open ends with it: the
         * browser does not always report such aborts.
         */
        replaced: (page) => {
            const since = navigations.get(page);
            if (since === undefined) return;
            for (const [key, entry] of open) if (entry.page === page && entry.start <= since) finish(key, { outcome: 'aborted', navigated: true });
        },
        /**
         * Open requests of a page, for waiting for quiet. Anything open longer than `staleMs` (long polling, streams) does
         * not count: otherwise a page with a persistent connection would never become quiet.
         */
        pending: (page, staleMs = 10_000) => [...open.values()].filter((entry) => entry.page === page && entry.stream !== true
            && (entry.answeredAt === undefined || now() - entry.answeredAt < BODY_GRACE_MS) && now() - entry.start < staleMs).length,
        /** Position in the log at which a step starts. */
        mark: () => entries.length,
        /** The requests from this position up to before `end`, without the page and with open ones as `open`. */
        since: (mark = 0, end = undefined) => entries.slice(mark, end).map((entry) => {
            const rest = { ...entry };
            delete rest.page;
            delete rest.start;
            delete rest.end;
            if (rest.outcome === 'open') return { ...rest, ms: Math.max(0, now() - entry.start) };
            if (rest.outcome === 'aborted' && !rest.navigated && routedAfter(entry)) return { ...rest, navigated: true, routed: true };
            return rest;
        }),
    };
};

/**
 * Summary: equal names and outcomes merged, highest duration, no aborts caused by navigation.
 * @param answeredOnly only answered requests, as the baseline from the recording should be: failed attempts do not belong in it
 * @returns [{ name, status, ms, count?, params? }]
 */
export const summarizeRequests = (requests, { answeredOnly = false } = {}) => {
    const byName = new Map();
    for (const request of requests) {
        if (request.outcome === 'aborted' && request.navigated) continue;
        if (answeredOnly && request.outcome !== 'ok' && request.outcome !== 'http') continue;
        const status = request.outcome === 'ok' || request.outcome === 'http' ? request.status : outcomeText(request);
        const key = `${request.name}\n${status}`;
        const known = byName.get(key);
        if (known === undefined) byName.set(key, { name: request.name, status, ms: request.ms ?? 0, count: 1, ...(request.params === undefined ? {} : { params: request.params }) });
        else {
            known.count += 1;
            known.ms = Math.max(known.ms, request.ms ?? 0);
            // The same request with different parameters: all names count, otherwise the comparison depends on the order.
            if (request.params !== undefined) known.params = [...new Set([...(known.params ?? []), ...request.params])].sort();
        }
    }
    return [...byName.values()].slice(0, MAX_SUMMARY).map(({ count, ...rest }) => (count === 1 ? rest : { ...rest, count }));
};
