// Is a failure caused by the test, the application or the environment? The tool decides from evidence any browser provides:
// requests with duration and outcome, hard failures, and the comparison with the recording. No knowledge of framework or environment.

import { language, t } from '../shared/i18n.mjs';
import { deviationText, isEffectCause } from './effects.mjs';
import { JSON_PREFIX, neutralName, neutralPath, outcomeText } from './network-log.mjs';
import { isCaughtScriptError } from '../shared/report.mjs';

const QUICK_ABORT_MS = 1000;
const QUICK_SHARE = 0.2;
const SLOW_MS = 5000;
const SLOW_FACTOR = 3;
// Without a baseline from the recording: anything this slow points to the environment rather than the application.
const VERY_SLOW_MS = 10_000;
// A request open this long counts as a persistent connection (long polling, stream), as when waiting for idle.
const STALE_MS = 10_000;
// Gateway responses: the service behind it is down or still starting.
const GATEWAY = new Set([502, 503, 504]);
// Rejected data, not a wrong call: a conflict (e.g. a name that already exists) or a business validation.
const DATA_STATUS = new Set([409, 422]);
/** When only the effect deviates: the data may have changed, in which case the new effect is correct. */
export const dataStateHint = () => t('config.diag.dataStateHint');
// Messages about data rather than the application: something already exists, must be unique, is invalid. German and English,
// since these are the application's own texts.
const DATA_WORDING = /bereits|existiert|schon vergeben|gibt es schon|trägt schon|eindeutig|ungültig|pflicht|already|exists|unique|duplicate|invalid|required/i;

const RANK = { 'app:clear': 6, 'environment:clear': 5, 'app:likely': 4, 'environment:likely': 3, 'test:likely': 2, 'unclear:likely': 1 };
// Diagnosis sides: app, environment, test, unclear (text under config.diag.side.<side>).
const sideText = (side) => t(`config.diag.side.${side}`);

const seconds = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', language() === 'de' ? ',' : '.')} s` : `${Math.round(ms)} ms`);
const recorded = (entry) => (entry === undefined ? '' : t('config.diag.recorded', { status: String(entry.status), time: seconds(entry.ms) }));

/**
 * An abort followed by a new call with the same name: superseded, e.g. a search while typing or a store reloading. That is
 * normal, however the new call ends.
 */
const superseded = (request, all) => {
    const at = all.indexOf(request);
    return all.some((other, index) => other !== request && other.name === request.name && (index > at || other.outcome === 'ok'));
};

/**
 * Does the application abort a request itself shortly after it started, while it went through at recording time? Only with a
 * baseline: without one it may also be an abort when a view closes (cleanup of an effect or subscription).
 */
const quickAbort = (request, then, all = []) => request.outcome === 'aborted' && !request.navigated && then !== undefined
    && (request.ms ?? 0) < Math.max(QUICK_ABORT_MS, then.ms * QUICK_SHARE) && !superseded(request, all);

/** Does the hard failure with this URL refer to the same request? Compares the neutral path. */
const sameRequest = (request, url) => {
    try {
        return request.name.split(' ')[1] === neutralPath(new URL(url).pathname);
    } catch {
        return url === undefined;
    }
};

/** What changed in the parameter names, or null. */
export const paramChange = (given, then) => {
    // Only newer recordings know JSON body keys: if the recording has none, they do not count now either.
    const now = then.some((name) => name.startsWith(JSON_PREFIX)) ? given : given.filter((name) => !name.startsWith(JSON_PREFIX));
    const gone = then.filter((name) => !now.includes(name));
    const added = now.filter((name) => !then.includes(name));
    if (gone.length === 0 && added.length === 0) return null;
    return [gone.length === 0 ? '' : t('config.diag.paramsGone', { names: gone.join(', ') }), added.length === 0 ? '' : t('config.diag.paramsAdded', { names: added.join(', ') })].filter(Boolean).join(', ');
};

/**
 * An abort a retry will not change: the application aborts the request itself, the same way every time.
 * Other findings, such as a script error, may disappear after a reload; `retry` stays useful there.
 * @returns the sentence for the report, or null
 */
export const selfAbort = (requests = [], baseline = []) => {
    const before = new Map((baseline ?? []).map((entry) => [neutralName(entry.name), entry]));
    const hit = requests.find((request) => quickAbort(request, before.get(request.name), requests));
    return hit === undefined ? null : t('config.diag.selfAbort', { name: hit.name, time: seconds(hit.ms ?? 0) });
};

/**
 * @param failed    the failed step from failedStep, with reason
 * @param broken    why replay stopped, or null if a check was not met
 * @param failures  the run's hard failures
 * @param requests  the failed step's requests during replay
 * @param baseline  the step's recording.network, missing in older recordings
 * @param deviation the first action up to this step whose effect differs from what was learned, or null
 * @param earlier   { id, requests } of the previous step: the cause may lie there even if its check passed
 * @returns { side, strength, findings, text }
 */
export const diagnose = ({ failed, broken = null, failures = [], requests = [], baseline, deviation = null, earlier = null }) => {
    const found = [];
    // A failed check reports itself as a break (kind check): that does not rule out the effect as the only cause.
    const effectOnly = (broken === null || broken.kind === 'check') && isEffectCause(failed?.reason);
    const add = (side, strength, text) => found.push({ side, strength, text });
    // The first action whose effect differs from healthy runs: the application reacts differently, the test has not changed.
    // If it fails the step, the signal was stable across all healthy runs: then it is clear.
    // An effect not learned yet (too few healthy runs) is only evidence. If the target is missing and the UI changed before it
    // without failing the step, that is more likely a changed page than a bug.
    const notes = [];
    const uiChanged = deviation !== null && !deviation.fails && broken?.kind === 'target' && (deviation.instead ?? []).length > 0;
    // Only the UI differs, no different requests and no console errors: an intended change or a bug; only a look at the code
    // can tell.
    const pageOnly = deviation !== null && (deviation.lists ?? []).every((list) => list === 'controls' || list === 'view');
    if (deviation !== null && pageOnly && (deviation.fails || (deviation.learned === true && !uiChanged))) {
        add('unclear', 'likely', t('config.diag.pageOnly', { deviation: deviationText(deviation), hint: effectOnly ? ` ${dataStateHint()}` : '' }));
    } else if (deviation !== null && deviation.fails && effectOnly) {
        // The check passed, only the effect differs: this may also be different data, e.g. a list that was empty while learning.
        add('app', 'likely', `${deviationText(deviation)} ${dataStateHint()}`);
    } else if (deviation !== null && deviation.fails) add('app', 'clear', deviationText(deviation));
    else if (deviation !== null && deviation.learned === true && !uiChanged) add('app', 'likely', deviationText(deviation));
    else if (deviation !== null) notes.push(deviationText(deviation));
    const before = new Map((baseline ?? []).map((entry) => [neutralName(entry.name), entry]));
    const own = requests.filter((request) => !(request.outcome === 'aborted' && request.navigated));
    const covered = broken?.kind === 'target' ? broken.blocker?.covered : undefined;

    // Different parameter names than at recording time: the application calls the API differently than when it worked.
    // Only for a failed request: some APIs are called with varying parameters without anything being wrong.
    const reported = new Set();
    for (const request of own) {
        const then = before.get(request.name);
        if (then?.params === undefined || reported.has(request.name) || request.outcome === 'ok' || request.outcome === 'open') continue;
        const sent = [...new Set(own.filter(({ name }) => name === request.name).flatMap(({ params }) => params ?? []))];
        const change = paramChange(sent, then.params);
        if (change === null) continue;
        reported.add(request.name);
        add('app', 'clear', t('config.diag.params', { name: request.name, change }));
    }

    for (const request of own) {
        const then = before.get(request.name);
        const ms = request.ms ?? 0;
        const answeredBefore = then !== undefined && typeof then.status === 'number' && then.status < 400;
        if (request.outcome === 'aborted') {
            if (superseded(request, own)) continue;
            const vars = { name: request.name, time: seconds(ms), recorded: recorded(then) };
            if (quickAbort(request, then, own)) add('app', 'clear', t('config.diag.quickAbort', vars));
            else if (ms >= SLOW_MS) add('environment', 'likely', t('config.diag.slowAbort', vars));
            else notes.push(t('config.diag.abort', vars));
        } else if (request.outcome === 'http' && (GATEWAY.has(request.status) || (request.status >= 500 && ms >= SLOW_MS))) {
            add('environment', 'likely', t('config.diag.gateway', { name: request.name, time: seconds(ms), status: String(request.status), recorded: recorded(then) }));
        } else if (request.outcome === 'http' && request.status >= 500) {
            add('app', 'clear', t('config.diag.http', { name: request.name, status: String(request.status), recorded: recorded(then) }));
        } else if (request.outcome === 'http' && then?.status === request.status) {
            // Same at recording time: intended, e.g. an optional setting that does not exist.
            continue;
        } else if (request.outcome === 'http' && covered !== undefined && DATA_STATUS.has(request.status)) {
            // Rejected with a dialog on top: the covered-target section below classifies this together with the message.
            continue;
        } else if (request.outcome === 'http' && request.status === 403 && answeredBefore) {
            add('app', 'likely', t('config.diag.forbidden', { name: request.name, recorded: recorded(then) }));
        } else if (request.outcome === 'http' && (request.status === 401 || request.status === 403)) {
            add('environment', 'likely', t('config.diag.unauthorized', { name: request.name, status: String(request.status), recorded: recorded(then) }));
        } else if (request.outcome === 'open' && ms >= SLOW_MS) {
            // A persistent connection that also ran long at recording time, or never answered there, is not a finding.
            const lasting = (then !== undefined && then.ms >= SLOW_MS) || (then === undefined && baseline !== undefined && ms >= STALE_MS);
            if (lasting) notes.push(t('config.diag.lasting', { name: request.name, time: seconds(ms) }));
            else add('environment', 'likely', t('config.diag.waiting', { name: request.name, time: seconds(ms), recorded: recorded(then) }));
        } else if (request.outcome === 'http') {
            add('app', 'likely', t('config.diag.http', { name: request.name, status: String(request.status), recorded: recorded(then) }));
        } else if (request.outcome === 'failed') {
            add('environment', 'likely', t('config.diag.failed', { name: request.name, outcome: outcomeText(request) }));
        } else if (then !== undefined && ms > Math.max(SLOW_MS, then.ms * SLOW_FACTOR)) {
            add('environment', 'likely', t('config.diag.slow', { name: request.name, time: seconds(ms), recorded: recorded(then) }));
        } else if (then === undefined && ms >= VERY_SLOW_MS) {
            add('environment', 'likely', t('config.diag.verySlow', { name: request.name, time: seconds(ms) }));
        }
    }

    // Requests the recording had but that are missing now: only meaningful if the step's actions ran. A missing write is a
    // finding; a missing read only a note, since it may come from a cache or be a one-off (token refresh).
    const ranThrough = broken === null || broken.kind === 'check';
    if (ranThrough && baseline !== undefined) {
        const now = new Set(own.map(({ name }) => name));
        for (const entry of baseline) {
            const name = neutralName(entry.name);
            if (now.has(name)) continue;
            const text = t('config.diag.missingRequest', { name, status: String(entry.status), time: seconds(entry.ms) });
            if (/^(GET|HEAD|OPTIONS) /.test(name)) notes.push(text);
            else add('app', 'likely', text);
        }
    }

    for (const failure of failures) {
        if (failure.type === 'pageerror') add('app', 'clear', t('config.diag.pageerror', { text: String(failure.text), at: failure.at ? t('config.diag.pageerrorAt', { at: String(failure.at) }) : '' }));
        // With a source (stack resolved via source maps) it is a caught script error of the application, e.g. from Angular's ErrorHandler.
        else if (isCaughtScriptError(failure)) add('app', 'clear', t('config.diag.pageerror', { text: String(failure.text).split('\n')[0], at: t('config.diag.pageerrorAt', { at: String(failure.at) }) }));
        else if (failure.type === 'console') add('app', 'likely', t('config.diag.console', { text: String(failure.text) }));
        else if (failure.type === 'http' && !own.some((request) => `HTTP ${request.status}` === failure.text && sameRequest(request, failure.url))) {
            const status = Number(/\d+/.exec(failure.text ?? '')?.[0]);
            const vars = { url: String(failure.url ?? t('config.diag.aRequest')), text: String(failure.text) };
            if (GATEWAY.has(status)) add('environment', 'likely', t('config.diag.failureGateway', vars));
            else add('app', 'clear', t('config.diag.failureHttp', vars));
        }
    }

    // A target that exists but lies under an open dialog: the previous action did not close the dialog. If the dialog shows a
    // message, the application rejected an input; if a request was rejected too (4xx), that fits test data or state from an
    // earlier run, e.g. a name that must be unique. It is rarely an application bug.
    const refused = (list) => list.filter((request) => request.outcome === 'http' && request.status >= 400 && request.status < 500 && request.status !== 401 && request.status !== 403);
    const rejected = refused(earlier?.requests ?? []);
    const rejectedHere = refused(own);
    // A plain element without a role on top while a request is still open: probably a loading indicator waiting for it.
    const waiting = covered !== undefined && covered.role === undefined ? own.find((request) => request.outcome === 'open') : undefined;
    if (waiting !== undefined) {
        add('environment', 'likely', t('config.diag.loading', { tag: String(covered.tag), name: waiting.name, time: seconds(waiting.ms ?? 0) }));
    } else if (covered !== undefined) {
        const by = `${covered.role ?? covered.tag}${covered.name === undefined ? '' : ` ${t('session.point.quoted', { text: covered.name })}`}`;
        const messages = covered.messages ?? [];
        const said = messages.length === 0 ? '' : t('config.diag.says', { messages: messages.join(t('config.diag.saysJoin')), end: /[.!?]$/.test(messages.at(-1)) ? '' : '.' });
        const listed = (list) => list.map((request) => t('config.diag.listed', { name: request.name, status: String(request.status) })).join(', ');
        const cause = [
            rejectedHere.length === 0 ? '' : t('config.diag.rejectedHere', { list: listed(rejectedHere) }),
            rejected.length === 0 ? '' : t('config.diag.rejectedBefore', { id: String(earlier.id), list: listed(rejected) }),
        ].join('');
        const all = [...rejectedHere, ...rejected];
        const text = t('config.diag.covered', { by, said, cause });
        // Test data only with evidence: a conflict or business rejection, or a message about the data.
        if (all.some(({ status }) => DATA_STATUS.has(status)) || messages.some((message) => DATA_WORDING.test(message))) {
            add('test', 'likely', t('config.diag.coveredData', { text }));
        } else if (all.length > 0) {
            add('app', 'likely', t('config.diag.coveredApp', { text }));
        } else if (messages.length > 0) {
            add('unclear', 'likely', t('config.diag.coveredMessage', { text }));
        } else {
            add('test', 'likely', t('config.diag.coveredAction', { text }));
        }
    } else {
        for (const request of rejected) add('app', 'likely', t('config.diag.earlierHttp', { id: String(earlier.id), name: request.name, status: String(request.status) }));
    }
    if (broken?.kind === 'target' && broken.blocker?.hidden) add('test', 'likely', t('config.diag.hidden'));

    const reason = failed?.reason ?? '';
    // A lost sign-in explains the consequences (401, 500, HTML instead of JSON, empty forms): it takes precedence over everything.
    // The reason comes from replay.mjs in the run's language, hence both versions.
    if (/Anmeldung ist verloren|sign-in was lost/i.test(reason)) {
        return { side: 'environment', strength: 'clear', findings: [t('config.diag.signInLost'), ...found.map(({ text }) => text)].slice(0, 6), text: t('config.diag.verdictStrength', { side: sideText('environment'), strength: t('config.diag.clear') }) };
    }
    if (uiChanged) add('test', 'likely', t('config.diag.uiChanged'));
    else if (found.length === 0 && broken?.kind === 'target') {
        const healthy = baseline === undefined ? t('config.diag.healthyNoBaseline') : t('config.diag.healthyBaseline');
        add('test', 'likely', t('config.diag.elementMissing', { healthy }));
    }
    if (found.length === 0 && /Die Seite ist .* statt |The page is .* instead of /.test(reason)) add('test', 'likely', t('config.diag.otherPage'));

    if (found.length === 0) {
        const text = baseline === undefined ? t('config.diag.noBaseline') : t('config.diag.nothing');
        return { side: 'unclear', strength: 'likely', findings: [text, ...notes].slice(0, 6), text: t('config.diag.verdict', { side: sideText('unclear') }) };
    }
    const top = found.reduce((best, entry) => (RANK[`${entry.side}:${entry.strength}`] > RANK[`${best.side}:${best.strength}`] ? entry : best));
    const findings = [...new Set([...found.filter(({ side }) => side === top.side), ...found.filter(({ side }) => side !== top.side)].map(({ text }) => text).concat(notes))].slice(0, 6);
    if (top.side === 'unclear') return { side: 'unclear', strength: 'likely', findings, text: t('config.diag.verdict', { side: sideText('unclear') }) };
    return { side: top.side, strength: top.strength, findings, text: t('config.diag.verdictStrength', { side: sideText(top.side), strength: top.strength === 'clear' ? t('config.diag.clear') : t('config.diag.likely') }) };
};
