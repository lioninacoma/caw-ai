import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';

/** Warning type as the human reads it (text under config.report.warning.<type>). Unknown types are shown by their key. */
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
 * Evaluates what the agent submits at the end. Without complete evidence there is no result, and
 * hard console errors decide the status regardless of the agent's verdict.
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

/** consoleIgnore may allow known messages. HTTP status 500+ always stays hard, even if a pattern matches. */
export const isAllowedFailure = (observation, url, patterns) => {
    if (observation.type === 'http') return false;
    const haystack = `${observation.text} ${url ?? ''}`;
    return patterns.some((pattern) => pattern.test(haystack));
};

const STATIC_FILE = /\.(png|jpe?g|gif|svg|ico|webp|css|woff2?|ttf|eot|map)$/i;

/**
 * The file where an error originated: the topmost stack entry outside the files in `skip`, e.g. the framework's, which
 * almost always just passes errors on.
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
 * How serious is a hard console error? Only what is surely foreign or minor becomes a warning. Anything unknown, even
 * an error without a stack, stays an error: if foreign code really breaks something, the step's check fails anyway.
 * @param details { url, stack }
 * @param rules   { ignored, foreign, skip } regular expressions; `skip`: files that only pass errors on (from the framework adapter)
 * @returns 'ignore', 'warn' or 'fail'
 */
export const classifyFailure = (observation, { url, stack } = {}, { ignored = [], foreign = [], skip = null } = {}) => {
    if (observation.type === 'http') return 'fail';
    if (isAllowedFailure(observation, url, ignored)) return 'ignore';
    if (observation.type === 'requestfailed') return isStaticFile(url) ? 'warn' : 'fail';
    // A console error with a stack (caught by the framework) counts like a script error by its origin, not by the file
    // that called console.error: that is almost always the framework.
    const origin = observation.type === 'pageerror' ? stackOrigin(stack, skip) : (stack === undefined ? url : stackOrigin(stack, skip) ?? url);
    return origin !== undefined && foreign.some((pattern) => pattern.test(origin)) ? 'warn' : 'fail';
};

const cell = (text) => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

/** Screenshots are in the run's agent/ folder, next to report.md: as a link that opens from the report. */
export const SCREENSHOT_DIR = 'agent';
const evidenceCell = (evidence) => {
    if (evidence?.type === 'screenshot' && typeof evidence.value === 'string' && evidence.value !== '') {
        return `screenshot: [${cell(evidence.value)}](${encodeURI(`${SCREENSHOT_DIR}/${evidence.value}`)})`;
    }
    return `${cell(evidence?.type)}: ${cell(evidence?.value)}`;
};

/**
 * Was this step never reached because an earlier one failed? Playback marks it as fail with the note "Not reached because S1
 * failed." (session.replay.notReachedBecause); `skipped: true` or status `skipped` say it directly.
 */
export const isSkipped = (item, results = []) => {
    if (item?.skipped === true || item?.status === 'skipped') return true;
    if (item?.status !== 'fail') return false;
    const owner = results.find((candidate) => candidate.status === 'fail');
    return owner !== undefined && owner !== item && item.note === t('session.replay.notReachedBecause', { owner: owner.id });
};

const DECISIONS = ['adopted', 'discarded', 'shown', 'open', 'applied'];
const decisionLabel = (decision) => (DECISIONS.includes(decision) ? t(`config.report.decision.${decision}`) : decision);

/** Claude's advice with its decision. The prompt of an application advice is kept here so it outlives the chat. */
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

/** Why the step failed, with the step's requests next to those of the recording. */
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

/** An error code such as `unreachable`, as opposed to the describeCode line ("dev server localhost:4174, …"). */
export const isErrorCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);

export const renderReport = ({ status, reason, note, testId, target, source, testedCode, expectations = [], results = [], failures = [], warnings = [], writes = [], dropped = [], advice, diagnosis, overlay }) => {
    const sourceLabel = source === 'overlay' ? t('config.report.source.overlay') : t('config.report.source.deployed');
    const lines = [
        t('config.report.title', { testId: String(testId), target: String(target), status: String(status) }),
        '',
        // The same line the terminal prints (describeCode); older results only have source.
        t('config.report.source', { source: typeof testedCode === 'string' && testedCode !== '' ? testedCode : sourceLabel }),
        ...(overlay === undefined ? [] : [t('config.report.overlay', { label: String(overlay.label), local: String(overlay.local), server: String(overlay.server), swapped: t(overlay.swapped ? 'config.report.overlay.yes' : 'config.report.overlay.no') })]),
    ];
    if (reason !== undefined) lines.push('', t('config.report.reason', { reason: String(reason) }));
    if (note !== undefined) lines.push('', t('config.report.note', { note: String(note) }));
    if (results.length > 0) {
        lines.push('', t('config.report.results.header'), '|---|---|---|---|---|');
        for (const { id, text } of expectations) {
            const item = results.find((candidate) => candidate.id === id);
            const skipped = item !== undefined && isSkipped(item, results);
            lines.push(`| ${id} | ${cell(text)} | ${skipped ? 'skipped' : item?.status ?? '-'} | ${skipped ? '-' : evidenceCell(item?.evidence)} | ${cell(item?.note)} |`);
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

// Request errors the application merely logs (axios, Angular's HttpClient, fetch): their stack points into the library,
// the cause is the request, not the script.
const REQUEST_ERROR = /\b(AxiosError|HttpErrorResponse|Http failure response|Request failed with status code|Failed to fetch|NetworkError|ERR_NETWORK|ERR_BAD_(REQUEST|RESPONSE))\b/i;

/**
 * A console error caught by the framework that points to own code (Angular's ErrorHandler, Vue, error boundary): as
 * clear as a script error. Not if the source is in a library or the text is a logged request error.
 */
export const isCaughtScriptError = (failure) => failure?.type === 'console' && typeof failure.at === 'string' && failure.at !== ''
    && !/(^|\/)node_modules\//.test(failure.at) && !REQUEST_ERROR.test(String(failure.text ?? '').split('\n')[0]);
