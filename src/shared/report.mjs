import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';

/** Art einer Warnung, wie der Mensch sie liest (Text unter config.report.warning.<art>). Unbekannte Arten stehen mit ihrem Schluessel da. */
const WARNING_TYPES = ['console', 'pageerror', 'requestfailed', 'http', 'retry', 'effect', 'note'];
const warningLabel = (type) => (WARNING_TYPES.includes(type) ? t(`config.report.warning.${type}`) : type);

const rejected = (message) => new CawError('finish-rejected', message);
const EVIDENCE_TYPES = ['eval', 'screenshot'];

const checkEvidence = (item, fileExists) => {
    const { evidence } = item;
    if (evidence === undefined || !EVIDENCE_TYPES.includes(evidence.type) || typeof evidence.value !== 'string' || evidence.value.trim() === '') {
        throw rejected(t('config.finish.evidenceMissing', { id: String(item.id) }));
    }
    if (evidence.type === 'screenshot' && !fileExists(evidence.value)) {
        throw rejected(t('config.finish.screenshotMissing', { id: String(item.id), value: evidence.value }));
    }
};

/**
 * Bewertet das, was der Agent am Ende einreicht. Ohne vollstaendige Belege gibt es kein Ergebnis, und
 * harte Konsolenfehler bestimmen den Status unabhaengig vom Urteil des Agenten.
 */
export const evaluateFinish = ({ expectations, results, failures, fileExists }) => {
    if (results.status === 'error') {
        if (typeof results.reason !== 'string' || results.reason.trim() === '') throw rejected(t('config.finish.reason'));
        return { status: 'error', reason: results.reason, results: [], failures };
    }

    const items = results.expectations;
    if (!Array.isArray(items)) throw rejected(t('config.finish.expectations'));
    const known = expectations.map(({ id }) => id);
    const unknown = items.find((item) => !known.includes(item.id));
    if (unknown !== undefined) throw rejected(t('config.finish.unknown', { id: String(unknown.id) }));
    const missing = known.filter((id) => !items.some((item) => item.id === id));
    if (missing.length > 0) throw rejected(t('config.finish.missing', { ids: missing.join(', ') }));
    for (const item of items) {
        if (item.status !== 'pass' && item.status !== 'fail') throw rejected(t('config.finish.status', { id: String(item.id) }));
        checkEvidence(item, fileExists);
    }

    const passed = items.every((item) => item.status === 'pass') && failures.length === 0;
    return { status: passed ? 'pass' : 'fail', results: items, failures };
};

/** Bekannte Meldungen darf consoleIgnore erlauben. HTTP-Status ab 500 bleiben immer hart, auch wenn ein Muster passt. */
export const isAllowedFailure = (observation, url, patterns) => {
    if (observation.type === 'http') return false;
    const haystack = `${observation.text} ${url ?? ''}`;
    return patterns.some((pattern) => pattern.test(haystack));
};

const STATIC_FILE = /\.(png|jpe?g|gif|svg|ico|webp|css|woff2?|ttf|eot|map)$/i;

/**
 * Die Datei, in der ein Fehler entstand: der oberste Stack-Eintrag ausserhalb der Dateien in `skip`, etwa des Frameworks, das fast
 * immer nur weiterreicht.
 */
export const stackOrigin = (stack, skip = null) => (stack ?? '').split('\n')
    .filter((line) => line.trim().startsWith('at '))
    .map((line) => line.match(/https?:\/\/[^\s)]+/)?.[0])
    .find((url) => url !== undefined && (skip === null || !skip.test(url)));

const isStaticFile = (url) => {
    try {
        return STATIC_FILE.test(new URL(url).pathname);
    } catch {
        return false;
    }
};

/**
 * Wie schwer wiegt ein harter Konsolenfehler? Nur was sicher fremd oder nebensaechlich ist, wird zur Warnung. Alles Unbekannte, auch
 * ein Fehler ohne Stack, bleibt ein Fehler: Macht fremder Code wirklich etwas kaputt, scheitert ohnehin die Pruefung des Schritts.
 * @param details { url, stack }
 * @param rules   { ignored, foreign, skip } reguläre Ausdruecke; `skip`: Dateien, die Fehler nur weiterreichen (vom Framework-Adapter)
 * @returns 'ignore', 'warn' oder 'fail'
 */
export const classifyFailure = (observation, { url, stack } = {}, { ignored = [], foreign = [], skip = null } = {}) => {
    if (observation.type === 'http') return 'fail';
    if (isAllowedFailure(observation, url, ignored)) return 'ignore';
    if (observation.type === 'requestfailed') return isStaticFile(url) ? 'warn' : 'fail';
    // Ein Konsolenfehler mit Stack (vom Framework gefangen) zaehlt wie ein Skriptfehler nach seinem Ursprung, nicht nach der Datei,
    // die console.error rief: Das ist fast immer das Framework.
    const origin = observation.type === 'pageerror' ? stackOrigin(stack, skip) : (stack === undefined ? url : stackOrigin(stack, skip) ?? url);
    return origin !== undefined && foreign.some((pattern) => pattern.test(origin)) ? 'warn' : 'fail';
};

const cell = (text) => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

const DECISIONS = ['adopted', 'discarded', 'shown', 'open', 'applied'];
const decisionLabel = (decision) => (DECISIONS.includes(decision) ? t(`config.report.decision.${decision}`) : decision);

/** Empfehlungen von Claude samt Entscheidung. Der Prompt einer Anwendungsempfehlung steht hier, damit er den Chat ueberdauert. */
const adviceLines = ({ items, note: adviceNote }) => {
    const lines = ['', `## ${t('config.report.advice')}`, ''];
    if (adviceNote !== undefined) lines.push(adviceNote, '');
    if (items.length === 0 && adviceNote === undefined) lines.push(t('config.report.advice.none'));
    for (const { side, title, reason, about, target, changes = [], prompt, decision, evidence, contradicts, edits = [] } of items) {
        lines.push(`### ${side === 'app' ? t('config.report.advice.app') : t('config.report.advice.test')}: ${cell(title)} (${decisionLabel(decision)})`, '');
        if (about !== undefined || target !== undefined) lines.push(t('config.report.advice.about', { list: [about, target].filter(Boolean).map(cell).join(', ') }), '');
        if (evidence !== undefined) lines.push(t('config.report.advice.evidence', { evidence: cell(evidence) }), '');
        if (contradicts) lines.push(t('config.report.advice.contradicts'), '');
        lines.push(reason, '');
        for (const { label, before, after } of changes) lines.push(`- ${cell(label)}: ${before === '' ? '' : `${cell(before)} -> `}${cell(after)}`);
        if (changes.length > 0) lines.push('');
        for (const { file, line, find, replace, why } of edits) {
            lines.push(`${file}${line === undefined ? '' : `:${line}`}${why === undefined ? '' : ` – ${cell(why)}`}`, '', '```diff');
            for (const text of find.split(/\r?\n/)) lines.push(`- ${text.replaceAll('```', "'''")}`);
            for (const text of replace.split(/\r?\n/)) lines.push(`+ ${text.replaceAll('```', "'''")}`);
            lines.push('```', '');
        }
        if (prompt !== undefined) lines.push('```text', prompt.replaceAll('```', "'''"), '```', '');
    }
    while (lines.at(-1) === '') lines.pop();
    return lines;
};

const OUTCOMES = { ok: (request) => String(request.status), http: (request) => `HTTP ${request.status}`, aborted: (request) => (request.routed ? t('config.report.outcome.abortedRoute') : request.navigated ? t('config.report.outcome.abortedPage') : t('config.report.outcome.aborted')), failed: (request) => t('config.report.outcome.failed', { error: String(request.error) }), open: () => t('config.report.outcome.open') };
const duration = (ms) => (ms === undefined ? '-' : `${Math.round(ms)} ms`);

/** Woran der Schritt gescheitert ist, mit den Requests des Schritts neben denen der Aufnahme. */
const diagnosisLines = ({ step, text, findings = [], requests = [], recorded }) => {
    const lines = ['', `## ${t('config.report.diagnosis')}`, '', `${step}: ${text}`, ''];
    for (const finding of findings) lines.push(`- ${finding}`);
    if (requests.length > 0 || recorded !== undefined) {
        const before = new Map((recorded ?? []).map((entry) => [entry.name, entry]));
        lines.push('', t('config.report.diagnosis.header', { step: String(step) }), '|---|---|---|---|');
        for (const request of requests) {
            const then = before.get(request.name);
            lines.push(`| ${cell(request.name)} | ${cell((OUTCOMES[request.outcome] ?? OUTCOMES.open)(request))} | ${duration(request.ms)} | ${then === undefined ? '-' : `${cell(String(then.status))} in ${duration(then.ms)}`} |`);
        }
        const seen = new Set(requests.map(({ name }) => name));
        for (const entry of recorded ?? []) if (!seen.has(entry.name)) lines.push(`| ${cell(entry.name)} | ${t('config.report.diagnosis.missing')} | - | ${cell(String(entry.status))} in ${duration(entry.ms)} |`);
    }
    if (recorded === undefined) lines.push('', t('config.report.diagnosis.noBaseline'));
    return lines;
};

export const renderReport = ({ status, reason, note, testId, target, source, expectations = [], results = [], failures = [], warnings = [], writes = [], dropped = [], advice, diagnosis }) => {
    const stand = source === 'overlay' ? t('config.report.source.watch') : t('config.report.source.deployed');
    const lines = [
        t('config.report.title', { testId: String(testId), target: String(target), status: String(status) }),
        '',
        t('config.report.source', { source: stand }),
    ];
    if (reason !== undefined) lines.push('', t('config.report.reason', { reason: String(reason) }));
    if (note !== undefined) lines.push('', t('config.report.note', { note: String(note) }));
    if (results.length > 0) {
        lines.push('', t('config.report.results.header'), '|---|---|---|---|---|');
        for (const { id, text } of expectations) {
            const item = results.find((candidate) => candidate.id === id);
            lines.push(`| ${id} | ${cell(text)} | ${item?.status ?? '-'} | ${cell(item?.evidence?.type)}: ${cell(item?.evidence?.value)} | ${cell(item?.note)} |`);
        }
    }
    if (diagnosis !== undefined) lines.push(...diagnosisLines(diagnosis));
    if (failures.length > 0) {
        lines.push('', `## ${t('config.report.failures')}`, '');
        for (const failure of failures) lines.push(`- ${failure.type}: ${failure.text}${failure.url ? ` (${failure.url})` : ''}${failure.at ? t('config.report.failures.at', { at: String(failure.at) }) : ''}`);
    }
    if (warnings.length > 0) {
        lines.push('', `## ${t('config.report.warnings')}`, '', t('config.report.warnings.intro'), '');
        for (const { type, text, origin, url, count } of warnings) lines.push(`- ${warningLabel(type)}: ${text}${origin || url ? ` (${origin ?? url})` : ''}${count > 1 ? ` (${count}x)` : ''}`);
    }
    if (writes.length > 0) {
        lines.push('', `## ${t('config.report.writes')}`, '', t('config.report.writes.intro'), '');
        for (const { label, count } of writes) lines.push(`- ${label} (${count}x)`);
    }
    if (dropped.length > 0) {
        lines.push('', `## ${t('config.report.dropped')}`, '', t('config.report.dropped.intro'), '');
        for (const step of dropped) lines.push(`- ${cell(step)}`);
    }
    if (advice !== undefined) lines.push(...adviceLines(advice));
    return `${lines.join('\n')}\n`;
};

// Fehler eines Requests, die die Anwendung nur protokolliert (axios, Angulars HttpClient, fetch): Ihr Stack zeigt in die Bibliothek,
// die Ursache ist der Request, nicht das Skript.
const REQUEST_ERROR = /\b(AxiosError|HttpErrorResponse|Http failure response|Request failed with status code|Failed to fetch|NetworkError|ERR_NETWORK|ERR_BAD_(REQUEST|RESPONSE))\b/i;

/**
 * Ein Konsolenfehler, den das Framework gefangen hat und der auf eigenen Code zeigt (Angulars ErrorHandler, Vue, Error Boundary): So
 * klar wie ein Skriptfehler. Nicht, wenn die Quelle in einer Bibliothek liegt oder der Text ein protokollierter Request-Fehler ist.
 */
export const isCaughtScriptError = (failure) => failure?.type === 'console' && typeof failure.at === 'string' && failure.at !== ''
    && !/(^|\/)node_modules\//.test(failure.at) && !REQUEST_ERROR.test(String(failure.text ?? '').split('\n')[0]);
