// Liegt ein Fehlschlag am Test, an der Anwendung oder an der Umgebung? Das Tool ordnet ihn aus Belegen ein, die jeder Browser liefert:
// Requests mit Dauer und Ausgang, harte Fehler und der Vergleich mit der Aufnahme. Kein Wissen ueber Framework oder Umgebung.

import { language, t } from '../shared/i18n.mjs';
import { deviationText, isEffectCause } from './effects.mjs';
import { JSON_PREFIX, neutralName, neutralPath, outcomeText } from './network-log.mjs';
import { isCaughtScriptError } from '../shared/report.mjs';

const QUICK_ABORT_MS = 1000;
const QUICK_SHARE = 0.2;
const SLOW_MS = 5000;
const SLOW_FACTOR = 3;
// Ohne Vergleich aus der Aufnahme: Was so lange braucht, ist eher die Umgebung als die Anwendung.
const VERY_SLOW_MS = 10_000;
// So lange offen gilt ein Request als Dauerverbindung (Long-Polling, Stream), wie beim Warten auf Ruhe.
const STALE_MS = 10_000;
// Antworten eines Gateways: Der Dienst dahinter laeuft nicht oder startet noch.
const GATEWAY = new Set([502, 503, 504]);
// Abgelehnte Daten, nicht ein falscher Aufruf: Konflikt (etwa ein Name, den es schon gibt) oder eine fachliche Pruefung.
const DATA_STATUS = new Set([409, 422]);
// Meldungen, die von Daten sprechen, nicht von der Anwendung: etwas gibt es schon, muss eindeutig sein, ist ungueltig.
/** Wenn nur die Wirkung abweicht: Der Datenstand kann sich geaendert haben, dann ist die neue Wirkung richtig. */
export const dataStateHint = () => t('config.diag.dataStateHint');
const DATA_WORDING = /bereits|existiert|schon vergeben|gibt es schon|trägt schon|eindeutig|ungültig|pflicht|already|exists|unique|duplicate|invalid|required/i;

const RANK = { 'app:clear': 6, 'environment:clear': 5, 'app:likely': 4, 'environment:likely': 3, 'test:likely': 2, 'unclear:likely': 1 };
// Seiten der Einschaetzung: app, environment, test, unclear (Text unter config.diag.side.<seite>).
const sideText = (side) => t(`config.diag.side.${side}`);

const seconds = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', language() === 'de' ? ',' : '.')} s` : `${Math.round(ms)} ms`);
const recorded = (entry) => (entry === undefined ? '' : t('config.diag.recorded', { status: String(entry.status), time: seconds(entry.ms) }));

/**
 * Ein Abbruch, auf den ein neuer Aufruf desselben Namens folgt: ueberholt, etwa eine Suche beim Tippen oder ein neu ladender
 * Store. Das ist normal, egal wie der neue Aufruf ausgeht.
 */
const superseded = (request, all) => {
    const at = all.indexOf(request);
    return all.some((other, index) => other !== request && other.name === request.name && (index > at || other.outcome === 'ok'));
};

/**
 * Bricht die Anwendung einen Request kurz nach dem Start selbst ab, und kam er bei der Aufnahme durch? Nur mit Vergleich: Ohne ihn
 * kann es auch ein Abbruch beim Schliessen einer Ansicht sein (Aufraeumen eines Effekts, eines Abos).
 */
const quickAbort = (request, then, all = []) => request.outcome === 'aborted' && !request.navigated && then !== undefined
    && (request.ms ?? 0) < Math.max(QUICK_ABORT_MS, then.ms * QUICK_SHARE) && !superseded(request, all);

/** Meint der harte Fehler mit dieser Adresse denselben Request? Verglichen wird der neutrale Pfad. */
const sameRequest = (request, url) => {
    try {
        return request.name.split(' ')[1] === neutralPath(new URL(url).pathname);
    } catch {
        return url === undefined;
    }
};

/** Was sich an den Parameternamen geaendert hat, oder null. */
export const paramChange = (given, then) => {
    // Schluessel eines JSON-Bodys kennen erst neuere Aufnahmen: Fehlen sie dort ganz, zaehlen sie auch jetzt nicht.
    const now = then.some((name) => name.startsWith(JSON_PREFIX)) ? given : given.filter((name) => !name.startsWith(JSON_PREFIX));
    const gone = then.filter((name) => !now.includes(name));
    const added = now.filter((name) => !then.includes(name));
    if (gone.length === 0 && added.length === 0) return null;
    return [gone.length === 0 ? '' : t('config.diag.paramsGone', { names: gone.join(', ') }), added.length === 0 ? '' : t('config.diag.paramsAdded', { names: added.join(', ') })].filter(Boolean).join(', ');
};

/**
 * Ein Abbruch, den ein neuer Versuch nicht aendert: Die Anwendung bricht den Request selbst ab, jedes Mal gleich.
 * Andere Befunde, etwa ein Skriptfehler, koennen nach dem Neuladen verschwinden; dort bleibt `retry`.
 * @returns der Satz fuer den Bericht oder null
 */
export const selfAbort = (requests = [], baseline = []) => {
    const before = new Map((baseline ?? []).map((entry) => [neutralName(entry.name), entry]));
    const hit = requests.find((request) => quickAbort(request, before.get(request.name), requests));
    return hit === undefined ? null : t('config.diag.selfAbort', { name: hit.name, time: seconds(hit.ms ?? 0) });
};

/**
 * @param failed    der gescheiterte Schritt aus failedStep, mit reason
 * @param broken    der Abbruch des Abspielens oder null, wenn eine Pruefung nicht erfuellt war
 * @param failures  harte Fehler des Laufs
 * @param requests  die Requests des gescheiterten Schritts aus dem Abspielen
 * @param baseline  recording.network des Schritts, fehlt bei aelteren Aufnahmen
 * @param deviation die erste Aktion bis zu diesem Schritt, die anders wirkt als gelernt, oder null
 * @param earlier   { id, requests } des Schritts davor: Dort kann die Ursache liegen, auch wenn seine Pruefung bestand
 * @returns { side, strength, findings, text }
 */
export const diagnose = ({ failed, broken = null, failures = [], requests = [], baseline, deviation = null, earlier = null }) => {
    const found = [];
    // Eine gescheiterte Pruefung meldet sich selbst als Abbruch (kind check): Das schliesst die Wirkung als einzigen Grund nicht aus.
    const effectOnly = (broken === null || broken.kind === 'check') && isEffectCause(failed?.reason);
    const add = (side, strength, text) => found.push({ side, strength, text });
    // Die erste Aktion, die anders wirkt als in gesunden Laeufen: Die Anwendung reagiert anders, der Test hat sich nicht geaendert.
    // Laesst sie den Schritt scheitern, war das Signal in allen gesunden Laeufen stabil: dann eindeutig.
    // Noch nicht gelernte Wirkung (zu wenige gesunde Laeufe) ist nur ein Beleg. Fehlt das Ziel und hat sich die Oberflaeche davor
    // umgestellt, ohne dass das den Schritt scheitern laesst, ist das eher eine geaenderte Seite als ein Fehler.
    const notes = [];
    const uiChanged = deviation !== null && !deviation.fails && broken?.kind === 'target' && (deviation.instead ?? []).length > 0;
    // Nur die Oberflaeche anders, ohne andere Requests und ohne Konsolenfehler: eine absichtliche Aenderung oder ein Fehler, das
    // entscheidet erst ein Blick in den Code.
    const pageOnly = deviation !== null && (deviation.lists ?? []).every((list) => list === 'controls' || list === 'view');
    if (deviation !== null && pageOnly && (deviation.fails || (deviation.learned === true && !uiChanged))) {
        add('unclear', 'likely', t('config.diag.pageOnly', { deviation: deviationText(deviation), hint: effectOnly ? ` ${dataStateHint()}` : '' }));
    } else if (deviation !== null && deviation.fails && effectOnly) {
        // Die Pruefung ist erfuellt, nur die Wirkung ist anders: Das kann auch ein anderer Datenstand sein, etwa eine Liste, die beim Lernen leer war.
        add('app', 'likely', `${deviationText(deviation)} ${dataStateHint()}`);
    } else if (deviation !== null && deviation.fails) add('app', 'clear', deviationText(deviation));
    else if (deviation !== null && deviation.learned === true && !uiChanged) add('app', 'likely', deviationText(deviation));
    else if (deviation !== null) notes.push(deviationText(deviation));
    const before = new Map((baseline ?? []).map((entry) => [neutralName(entry.name), entry]));
    const own = requests.filter((request) => !(request.outcome === 'aborted' && request.navigated));
    const covered = broken?.kind === 'target' ? broken.blocker?.covered : undefined;

    // Andere Parameternamen als bei der Aufnahme: Die Anwendung ruft die Schnittstelle anders auf als damals, als sie ging.
    // Nur bei einem gescheiterten Request: Manche Schnittstellen werden mit wechselnden Parametern aufgerufen, ohne dass etwas falsch ist.
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
            // Bei der Aufnahme genauso: gewollt, etwa eine optionale Einstellung, die es nicht gibt.
            continue;
        } else if (request.outcome === 'http' && covered !== undefined && DATA_STATUS.has(request.status)) {
            // Abgelehnt mit einem Dialog darueber: Das ordnet der Abschnitt zum verdeckten Ziel ein, zusammen mit der Meldung.
            continue;
        } else if (request.outcome === 'http' && request.status === 403 && answeredBefore) {
            add('app', 'likely', t('config.diag.forbidden', { name: request.name, recorded: recorded(then) }));
        } else if (request.outcome === 'http' && (request.status === 401 || request.status === 403)) {
            add('environment', 'likely', t('config.diag.unauthorized', { name: request.name, status: String(request.status), recorded: recorded(then) }));
        } else if (request.outcome === 'open' && ms >= SLOW_MS) {
            // Eine Dauerverbindung, die auch bei der Aufnahme lange lief oder dort nie antwortete, ist kein Befund.
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

    // Was die Aufnahme kannte, aber jetzt fehlt: Nur aussagekraeftig, wenn die Aktionen des Schritts gelaufen sind. Ein fehlendes
    // Schreiben ist ein Befund; ein fehlendes Lesen nur ein Hinweis, es kann aus einem Cache kommen oder einmalig sein (Token-Erneuerung).
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
        // Mit Quelle (Stack ueber Quellkarten aufgeloest) ist es ein gefangener Skriptfehler der Anwendung, etwa aus Angulars ErrorHandler.
        else if (isCaughtScriptError(failure)) add('app', 'clear', t('config.diag.pageerror', { text: String(failure.text).split('\n')[0], at: t('config.diag.pageerrorAt', { at: String(failure.at) }) }));
        else if (failure.type === 'console') add('app', 'likely', t('config.diag.console', { text: String(failure.text) }));
        else if (failure.type === 'http' && !own.some((request) => `HTTP ${request.status}` === failure.text && sameRequest(request, failure.url))) {
            const status = Number(/\d+/.exec(failure.text ?? '')?.[0]);
            const vars = { url: String(failure.url ?? t('config.diag.aRequest')), text: String(failure.text) };
            if (GATEWAY.has(status)) add('environment', 'likely', t('config.diag.failureGateway', vars));
            else add('app', 'clear', t('config.diag.failureHttp', vars));
        }
    }

    // Ein Ziel, das da ist, aber unter einem offenen Dialog liegt: Die Aktion davor hat den Dialog nicht geschlossen. Meldet er etwas,
    // hat die Anwendung eine Eingabe abgelehnt; lehnte sie dabei einen Request ab (4xx), passt das zu Testdaten oder einem Zustand aus
    // einem frueheren Lauf, etwa einem Namen, der eindeutig sein muss. Ein Fehler der Anwendung ist das nur selten.
    const refused = (list) => list.filter((request) => request.outcome === 'http' && request.status >= 400 && request.status < 500 && request.status !== 401 && request.status !== 403);
    const rejected = refused(earlier?.requests ?? []);
    const rejectedHere = refused(own);
    // Ein schlichtes Element ohne Rolle darueber, waehrend ein Request noch offen ist: vermutlich eine Ladeanzeige, die auf ihn wartet.
    const waiting = covered !== undefined && covered.role === undefined ? own.find((request) => request.outcome === 'open') : undefined;
    if (waiting !== undefined) {
        add('environment', 'likely', t('config.diag.loading', { tag: String(covered.tag), name: waiting.name, time: seconds(waiting.ms ?? 0) }));
    } else if (covered !== undefined) {
        const by = `${covered.role ?? covered.tag}${covered.name === undefined ? '' : (language() === 'de' ? ` „${covered.name}“` : ` "${covered.name}"`)}`;
        const messages = covered.messages ?? [];
        const said = messages.length === 0 ? '' : t('config.diag.says', { messages: messages.join(t('config.diag.saysJoin')), end: /[.!?]$/.test(messages.at(-1)) ? '' : '.' });
        const listed = (list) => list.map((request) => t('config.diag.listed', { name: request.name, status: String(request.status) })).join(', ');
        const cause = [
            rejectedHere.length === 0 ? '' : t('config.diag.rejectedHere', { list: listed(rejectedHere) }),
            rejected.length === 0 ? '' : t('config.diag.rejectedBefore', { id: String(earlier.id), list: listed(rejected) }),
        ].join('');
        const all = [...rejectedHere, ...rejected];
        const text = t('config.diag.covered', { by, said, cause });
        // Testdaten nur mit Beleg: ein Konflikt oder eine fachliche Ablehnung, oder eine Meldung, die von den Daten spricht.
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
    // Eine verlorene Anmeldung erklaert die Folgen (401, 500, HTML statt JSON, leere Masken): Sie geht allem vor.
    // Der Grund kommt aus replay.mjs in der Sprache des Laufs, darum beide Fassungen.
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
