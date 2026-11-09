// Was die Anwendung waehrend eines Laufs angefragt hat, unabhaengig vom Framework: Methode, Name, Status, Dauer, Ausgang.
import { t } from '../shared/i18n.mjs';

// Werte von Parametern landen nie hier, nur die Namen aus `requestKeys`, die einen Request ausmachen.

const MAX_SUMMARY = 20;
const ABORTED = /ERR_ABORTED|NS_BINDING_ABORTED|aborted/i;
// Ein Router bricht offene Requests ab, wenn er die Route wechselt, manchmal kurz bevor er die Adresse setzt (Angular aktualisiert
// sie erst nach der Aktivierung). Ein Routenwechsel zaehlt als Ursache, wenn er bis 1 s vor oder 0,5 s nach dem Abbruch liegt.
const ROUTE_GRACE_MS = 500;

// Abschnitte eines Pfads, die einen Datensatz meinen, nicht die Schnittstelle: Zahlen, UUIDs, lange Hex- oder Zufallskennungen und
// die Laufkennung. Sonst hiesse /bestellung/1001 bei der Aufnahme anders als /bestellung/1002 im Lauf. Kurze Zufallskennungen
// (nanoid, Firebase: "j46FjCJIrJQ4V0gp") erkennt man an Ziffern zusammen mit grossen und kleinen Buchstaben.
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[\w-]*\d)[\w-]{20,}|.*CAW-\d{8,}.*)$/i;
const RANDOM_SEGMENT = /^(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{12,}$/;

const isId = (part) => ID_SEGMENT.test(part) || RANDOM_SEGMENT.test(part);

/** Der Pfad mit `:id` statt Kennungen. */
export const neutralPath = (pathname) => pathname.split('/').map((part) => (isId(decodeURIComponentSafe(part)) ? ':id' : part)).join('/');
const decodeURIComponentSafe = (part) => {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
};

/** Ein Name, wie er in aelteren Aufnahmen steht, mit neutralem Pfad: "GET /a/1001 x=1" ergibt "GET /a/:id x=1". */
export const neutralName = (name) => {
    const [method, path, ...rest] = String(name).split(' ');
    return path === undefined || !path.startsWith('/') ? name : [method, neutralPath(path), ...rest].join(' ');
};

/**
 * Der Name eines Requests: Methode und Pfad, Kennungen im Pfad als `:id`. Leitet eine Anwendung alles ueber einen Pfad, nennt `keys` die Parameter, die ihn unterscheiden.
 * @param keys Namen von Query-Parametern, deren Wert zum Namen gehoert, etwa ["action"]
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
/** Schluessel eines JSON-Bodys stehen mit diesem Praefix bei den Parametern, getrennt von gleichnamigen der Query. */
export const JSON_PREFIX = 'json.';

/**
 * Die Namen der Parameter, ohne Werte: aus der Query und aus einem Formular-Body. Weichen sie von der Aufnahme ab, hat
 * sich der Aufruf geaendert, etwa ein umbenannter Parameter. Die Namen aus `requestKeys` stehen schon im Namen des Requests.
 */
export const parameterNames = ({ url, postData = null, contentType = '' }, keys = []) => {
    const skip = new Set(keys.map((key) => key.toLowerCase()));
    const names = new Set();
    try {
        for (const [key] of new URL(url).searchParams) names.add(key);
    } catch {
        // Ohne lesbare URL bleibt es bei den Namen aus dem Body.
    }
    if (typeof postData === 'string' && /application\/x-www-form-urlencoded/i.test(contentType)) {
        for (const [key] of new URLSearchParams(postData)) names.add(key);
    }
    // Ein umbenanntes Feld im JSON-Body: die Schluessel der obersten Ebene, bei einer Liste die des ersten Eintrags.
    if (typeof postData === 'string' && /json/i.test(contentType)) {
        try {
            const body = JSON.parse(postData);
            const shape = Array.isArray(body) ? body[0] : body;
            if (shape !== null && typeof shape === 'object' && !Array.isArray(shape)) for (const key of Object.keys(shape)) names.add(`${JSON_PREFIX}${key}`);
        } catch {
            // Kein JSON trotz Typ: dann bleibt es bei der Query.
        }
    }
    return [...names].filter((name) => !skip.has(name.toLowerCase())).map((name) => name.slice(0, 60)).sort().slice(0, MAX_PARAMS);
};

/** Der Ausgang in einem Wort, fuer Bericht, Chat und Claude. */
export const outcomeText = ({ outcome, status, error }) => {
    if (outcome === 'ok') return String(status);
    if (outcome === 'http') return `HTTP ${status}`;
    if (outcome === 'aborted') return t('run.network.aborted');
    if (outcome === 'failed') return t('run.network.failed', { error });
    // Kopfzeilen da, Ende nie gemeldet (Stream oder Proxy ohne sauberes Ende): Der Status ist trotzdem bekannt.
    if (status !== undefined) return status >= 400 ? `HTTP ${status}` : String(status);
    return t('run.network.open');
};

/**
 * Nach den Kopfzeilen bekommt der Inhalt so lange, bis eine Antwort nicht mehr als offen zaehlt. Manche Proxys (etwa der von Vite bei
 * 401) melden das Ende nie; ohne diese Frist wartete jede Aktion danach bis zur Grenze fuer haengende Requests.
 */
const BODY_GRACE_MS = 1500;

/**
 * Protokoll der Requests. Der Host speist es aus den Browser-Ereignissen.
 * @param now Uhr in ms
 */
export const createNetworkLog = ({ now = () => Date.now() } = {}) => {
    const entries = [];
    const open = new Map();
    // Je Seite der Beginn des letzten Seitenwechsels: Ein Abbruch danach gehoert zu ihm, nicht zur Anwendung. Ein Wechsel nur des
    // Hash oder per pushState zaehlt nicht, dabei bleibt das Dokument und bricht nichts ab.
    const navigations = new Map();
    // Je Seite die Zeitpunkte von Routenwechseln im selben Dokument (pushState, replaceState, popstate, Hash): Ein Single-Page-Router
    // bricht dabei offene Requests ab, die zur alten Ansicht gehoeren. Das ist kein Fehler der Anwendung.
    const routes = new Map();
    const routedAfter = (entry) => (routes.get(entry.page) ?? []).some((at) => at >= Math.max(entry.start, entry.end - ROUTE_GRACE_MS * 2) && at <= entry.end + ROUTE_GRACE_MS);
    const finish = (key, fields) => {
        const entry = open.get(key);
        if (entry === undefined) return;
        open.delete(key);
        Object.assign(entry, fields, { ms: Math.max(0, now() - entry.start) });
    };
    return {
        /** @param params Namen der Parameter, auch leer: Der Vergleich mit der Aufnahme braucht beides, `[]` und unbekannt. */
        started: (key, { name, page, params }) => {
            const entry = { name, ...(params === undefined ? {} : { params }), page, start: now(), outcome: 'open' };
            entries.push(entry);
            open.set(key, entry);
        },
        finished: (key, status) => finish(key, status >= 400 ? { outcome: 'http', status } : { outcome: 'ok', status }),
        /**
         * Die Kopfzeilen sind da. Ein Stream (Server-Sent Events, NDJSON) bleibt offen, solange die Seite lebt, und haelt das Warten
         * nicht auf; sonst bekommt der Inhalt noch BODY_GRACE_MS.
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
        /** Die Anwendung wechselt die Route, ohne ein neues Dokument zu laden. */
        routed: (page) => {
            const list = routes.get(page) ?? [];
            list.push(now());
            routes.set(page, list.slice(-50));
        },
        /** Die Seite laedt ein neues Dokument: Anfrage des Hauptframes. */
        navigating: (page) => navigations.set(page, now()),
        /**
         * Das neue Dokument steht. Was das alte vor dem Wechsel begonnen hat und noch offen ist, endet mit ihm: Der Browser meldet
         * solche Abbrueche nicht immer.
         */
        replaced: (page) => {
            const since = navigations.get(page);
            if (since === undefined) return;
            for (const [key, entry] of open) if (entry.page === page && entry.start <= since) finish(key, { outcome: 'aborted', navigated: true });
        },
        /**
         * Offene Requests einer Seite, fuer das Warten auf Ruhe. Was laenger als `staleMs` offen ist (Long-Polling, Streams), zaehlt
         * nicht: Sonst kaeme eine Seite mit Dauerverbindung nie zur Ruhe.
         */
        pending: (page, staleMs = 10_000) => [...open.values()].filter((entry) => entry.page === page && entry.stream !== true
            && (entry.answeredAt === undefined || now() - entry.answeredAt < BODY_GRACE_MS) && now() - entry.start < staleMs).length,
        /** Stelle im Protokoll, ab der ein Schritt beginnt. */
        mark: () => entries.length,
        /** Die Requests ab dieser Stelle bis vor `end`, ohne die Seite und mit offenen als `open`. */
        since: (mark = 0, end = undefined) => entries.slice(mark, end).map((entry) => {
            const { page, start, end: abortedAt, ...rest } = entry;
            if (rest.outcome === 'open') return { ...rest, ms: Math.max(0, now() - start) };
            if (rest.outcome === 'aborted' && !rest.navigated && routedAfter(entry)) return { ...rest, navigated: true, routed: true };
            return rest;
        }),
    };
};

/**
 * Kurzfassung: gleiche Namen und Ausgaenge zusammengefasst, hoechste Dauer, keine Abbrueche durch Seitenwechsel.
 * @param answeredOnly nur beantwortete Requests, so wie es fuer den Vergleich aus der Aufnahme sein soll: Fehlversuche gehoeren nicht dazu
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
            // Derselbe Request mit verschiedenen Parametern: Alle Namen zaehlen, sonst haengt der Vergleich an der Reihenfolge.
            if (request.params !== undefined) known.params = [...new Set([...(known.params ?? []), ...request.params])].sort();
        }
    }
    return [...byName.values()].slice(0, MAX_SUMMARY).map(({ count, ...rest }) => (count === 1 ? rest : { ...rest, count }));
};
