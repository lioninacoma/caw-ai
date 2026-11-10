// Was bewirkt eine Aktion auf der Seite? Ein gesunder Lauf haelt es je Aktion fest, ein spaeterer vergleicht. So faellt die erste
// Aktion auf, nach der sich die Anwendung anders verhaelt, auch wenn erst ein spaeteres Ziel oder eine Pruefung scheitert.
// Alles aus dem Browser, ohne Wissen ueber Framework oder Umgebung, und ohne Werte: keine Feldinhalte, keine Parameterwerte.

import { createHash } from 'node:crypto';

import { t } from '../shared/i18n.mjs';
import { CATALOGS } from '../shared/locales/index.mjs';
import { redactFor } from './secrets.mjs';

/** Gesunde Laeufe, bis die Wirkung als gelernt gilt. Bis dahin faellt weg, was zwischen den Laeufen schwankt. */
export const LEARN_RUNS = 2;
const MAX_LINES = 12;
const MAX_CONTROLS = 40;
const MAX_LINE = 120;
export const EFFECT_LISTS = ['controls', 'view', 'requests', 'responses', 'console'];

const shortHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

// Zahlen wechseln von Lauf zu Lauf (Bestellnummern, Daten, Zaehler).
const neutral = (text) => text.replace(/\d+/g, '#');

/** Laeuft im Browser: Zustand der sichtbaren Bedienelemente, ohne Werte. */
export function controlsProbe() {
    const seen = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const short = (text) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    // Ohne eigene Beschriftung: die erste Textzeile des naechsten umgebenden Bereichs, etwa die Ueberschrift einer Karte. Sonst
    // stuende nur `textarea ""` da, und niemand faende die Stelle im Code.
    const contextOf = (node) => {
        let current = node.parentElement;
        for (let depth = 0; current !== null && current !== document.body && depth < 6; depth += 1, current = current.parentElement) {
            const line = (current.innerText ?? '').split('\n').map((text) => text.trim()).find((text) => text !== '');
            if (line !== undefined) return line.length <= 60 ? line : '';
        }
        return '';
    };
    // Ohne die Felder im Label: Die Optionen eines <select> sind Daten, nicht die Beschriftung.
    const labelText = (label) => {
        if (!label) return '';
        const copy = label.cloneNode(true);
        for (const inner of copy.querySelectorAll('select, textarea, datalist, [role=listbox]')) inner.remove();
        return copy.textContent;
    };
    const labelOf = (node) => short(node.getAttribute('aria-label')
        || (node.id ? labelText(document.querySelector(`label[for="${CSS.escape(node.id)}"]`)) : '')
        || labelText(node.closest('label'))
        || node.getAttribute('placeholder')
        || node.getAttribute('name')
        || (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || node.getAttribute('role') === 'tab' ? node.innerText : '')
        || node.getAttribute('title')
        || contextOf(node));
    const flags = (node) => [
        node.disabled || node.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
        node.required || node.getAttribute('aria-required') === 'true' ? 'required' : '',
        node.readOnly || node.getAttribute('aria-readonly') === 'true' ? 'readonly' : '',
        node.getAttribute('aria-invalid') === 'true' ? 'invalid' : '',
        node.checked || node.getAttribute('aria-checked') === 'true' ? 'checked' : '',
        node.getAttribute('aria-expanded') === 'true' ? 'expanded' : '',
        node.getAttribute('aria-selected') === 'true' ? 'selected' : '',
        'value' in node && node.type !== 'checkbox' && node.type !== 'radio' && node.tagName !== 'BUTTON' ? (node.value === '' ? 'empty' : 'filled') : '',
    ].filter(Boolean);
    // Zeilen von Listen und Tabellen sind Daten, oft auch fremder Vorgaenge: Ihre Bedienelemente zaehlen nicht. Von einer Liste
    // zaehlt nur, ob sie Zeilen hat.
    const ROW = '[role=row], [role=gridcell], [role=listitem], [role=option], [role=treeitem], tr, li';
    const controls = [...document.querySelectorAll('input, select, textarea, button, [role=button], [role=tab], [role=checkbox], [role=combobox], [role=textbox]')]
        .filter((node) => node.type !== 'hidden' && seen(node) && node.closest(ROW) === null)
        .map((node) => `${node.getAttribute('role') ?? node.tagName.toLowerCase()} "${labelOf(node)}" ${flags(node).join(',')}`.trim());
    const lists = [...document.querySelectorAll('[role=grid], [role=treegrid], [role=listbox], [role=tree], [role=table], table')]
        .filter((node) => seen(node) && node.parentElement?.closest('[role=grid], [role=treegrid], [role=listbox], [role=tree], [role=table], table') == null)
        .map((node) => {
            const rows = [...node.querySelectorAll('[role=row], [role=option], [role=treeitem], tr')].filter((row) => seen(row) && row.querySelector('[role=columnheader], th') === null);
            return `list "${short(node.getAttribute('aria-label') || contextOf(node))}" ${rows.length === 0 ? 'empty' : 'rows'}`;
        });
    return [...controls, ...lists];
}

/**
 * Der ARIA-Baum als Zeilen ohne Werte: Links, Feldinhalte und lange Texte (meist Daten einer Liste) fallen weg, ebenso Zeilen
 * ohne Namen.
 */
export const viewLines = (aria) => aria.split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !/^\s*- \/url:/.test(line))
    .map((line) => line.replace(/\[ref=[^\]]*\]/g, '').replace(/^(\s*- (?:textbox|combobox|searchbox|spinbutton|slider)(?: "[^"]*")?(?: \[[^\]]*\])*):.*$/, '$1'))
    .filter((line) => line.length <= MAX_LINE && !/^\s*- (?:button|img|generic|list|listitem|group|row|cell|text)?:?$/.test(line))
    .map((line) => neutral(line).trim());

/** Unterschied zweier Listen als +/- Zeilen. */
export const lineDelta = (before, after) => {
    const was = new Set(before);
    const now = new Set(after);
    return [...new Set([...after.filter((line) => !was.has(line)).map((line) => `+ ${line}`), ...before.filter((line) => !now.has(line)).map((line) => `- ${line}`)])];
};

/** Form einer JSON-Antwort: Pfade der Schluessel, Arrays zusammengefasst, ohne Werte. */
export const jsonShape = (value, prefix = '', out = new Set(), depth = 0) => {
    if (depth > 5 || out.size > 200) return out;
    if (Array.isArray(value)) {
        out.add(`${prefix}[]`);
        for (const item of value.slice(0, 3)) jsonShape(item, `${prefix}[]`, out, depth + 1);
    } else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
            out.add(`${prefix}.${key}`);
            jsonShape(inner, `${prefix}.${key}`, out, depth + 1);
        }
    }
    return out;
};

const FAILURE_KEYS = /^(success|ok|error|errors|fehler|fehlermeldung)$/i;

/** Eine JSON-Antwort als eine Zeile: Name des Requests, Form als Kurz-Hash und fachliche Fehlerzeichen der obersten Ebene. */
export const responseLine = (name, body) => {
    const hints = body === null || typeof body !== 'object' || Array.isArray(body) ? [] : Object.entries(body)
        .filter(([key]) => FAILURE_KEYS.test(key))
        .map(([key, value]) => `${key}=${typeof value === 'boolean' ? value : value === null || value === '' ? 'empty' : 'filled'}`);
    return [name, `form ${shortHash([...jsonShape(body)].sort())}`, ...hints].join(' ');
};

const unique = (lines) => [...new Set(lines)].slice(0, MAX_LINES);

/**
 * Misst die Wirkung je Aktion: `before()` vor der Aktion, `after()` danach, wenn die Seite ruhig ist.
 * @param session Browser-Session mit page(), network und trail
 */
export const createEffects = ({ session }) => {
    const read = async () => {
        const page = session.page();
        const [controls, aria] = await Promise.all([
            page.evaluate(controlsProbe).catch(() => null),
            page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => null),
        ]);
        // Die Wirkung landet in der Aufzeichnung, also im Repository: ohne Passwoerter.
        const view = aria === null ? null : viewLines(await redactFor(page, aria, session.secrets?.() ?? []));
        return { controls: controls?.map(neutral) ?? null, view };
    };
    let before = null;
    let netMark = 0;
    let trailMark = 0;
    return {
        before: async () => {
            before = await read();
            netMark = session.network?.mark() ?? 0;
            trailMark = session.trail?.mark() ?? 0;
        },
        /** @returns die Wirkung, Listen ohne Eintraege fehlen; null, wenn sich die Seite nicht lesen liess */
        after: async () => {
            const after = await read();
            if (before?.controls == null || after.controls === null || before.view === null || after.view === null) return null;
            const requests = (session.network?.since(netMark) ?? [])
                .filter(({ outcome }) => outcome === 'ok' || outcome === 'http')
                .map(({ name, status }) => `${name} ${status}`);
            const trail = session.trail?.since(trailMark) ?? [];
            const effect = {
                controls: lineDelta(before.controls, after.controls),
                view: lineDelta(before.view, after.view),
                requests: unique(requests),
                responses: unique(trail.filter(({ kind }) => kind === 'response').map(({ line }) => line)),
                console: unique(trail.filter(({ kind }) => kind === 'console').map(({ line }) => neutral(line).slice(0, MAX_LINE))),
            };
            // Bedienelemente sind kurze Zeilen und das verlaesslichste Signal: Eine Maske hat schnell mehr als ein Dutzend davon.
            effect.controls = effect.controls.slice(0, MAX_CONTROLS);
            effect.view = effect.view.slice(0, MAX_LINES);
            return Object.fromEntries(Object.entries(effect).filter(([, lines]) => lines.length > 0));
        },
    };
};

/**
 * Lernt aus einem gesunden Lauf. Bis LEARN_RUNS bleibt nur, was in allen Laeufen gleich war; die Konsole sammelt, was vorkam,
 * denn dort zaehlt spaeter das Neue. Danach aendert ein Lauf nichts mehr: Eine Abweichung ist dann ein Befund, kein Rauschen.
 * @param recorded recording.effects oder undefined
 * @param observed Map Aktionsnummer (ab 1) -> Wirkung aus diesem Lauf
 * @returns die neuen recording.effects oder null, wenn sich nichts aendert
 */
export const learnEffects = (recorded, observed) => {
    if (recorded !== undefined && recorded.runs >= LEARN_RUNS) return null;
    const known = new Map((recorded?.actions ?? []).map((entry) => [entry.action, entry]));
    const numbers = recorded === undefined ? [...observed.keys()] : [...known.keys()];
    const actions = numbers.sort((a, b) => a - b).map((number) => {
        const now = observed.get(number) ?? {};
        const then = known.get(number);
        const lists = EFFECT_LISTS.map((list) => {
            const fresh = now[list] ?? [];
            if (then === undefined) return [list, fresh];
            const old = then[list] ?? [];
            return [list, list === 'console' ? unique([...old, ...fresh]) : old.filter((line) => fresh.includes(line))];
        }).filter(([, lines]) => lines.length > 0);
        return lists.length === 0 ? null : { action: number, ...Object.fromEntries(lists) };
    }).filter((entry) => entry !== null);
    return { runs: (recorded?.runs ?? 0) + 1, actions };
};

/**
 * Selbstbereinigung: Was in einem bestandenen Lauf in einer Liste fehlte, die nicht ueber das Scheitern entscheidet, schwankt
 * offenbar und faellt aus der gelernten Wirkung. Listen aus `fail` bleiben: Dort ist eine Abweichung ein Befund.
 * @returns die neuen recording.effects oder null, wenn nichts zu streichen ist
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

/**
 * Weicht die Wirkung von der gelernten ab? Fehlen zaehlt bei allem ausser der Konsole, dort zaehlt das Neue.
 * @returns { missing, extra, instead } oder null
 */
export const effectChange = (recorded, observed) => {
    if (recorded === undefined || observed === undefined) return null;
    const now = observed ?? {};
    // Eine Antwortform fehlt nur, wenn derselbe Request jetzt anders geformt antwortet. Kam er nicht oder spaeter, zeigt das `requests`.
    const nameOf = (line) => line.replace(/ form [0-9a-f]+.*$/, '');
    const answered = new Set((now.responses ?? []).map(nameOf));
    const counts = (list, line) => list !== 'responses' || answered.has(nameOf(line));
    const byList = Object.fromEntries(EFFECT_LISTS.filter((list) => list !== 'console')
        .map((list) => [list, (recorded[list] ?? []).filter((line) => !(now[list] ?? []).includes(line) && counts(list, line))]));
    const extra = (now.console ?? []).filter((line) => !(recorded.console ?? []).includes(line));
    // Was stattdessen geschah, aus denselben Listen: Es zeigt, wie sich die Maske jetzt umstellt.
    const instead = ['controls', 'view'].flatMap((list) => (now[list] ?? []).filter((line) => !(recorded[list] ?? []).includes(line))).slice(0, 6);
    return summarized({ byList, extra: extra.slice(0, 5), instead });
};

/** Fasst die Abweichung je Liste zusammen; null, wenn nichts bleibt. */
const summarized = ({ byList, extra, instead }) => {
    const missing = Object.values(byList).flat();
    if (missing.length === 0 && extra.length === 0) return null;
    // Welche Listen abweichen: Davon haengt ab, ob die Abweichung den Schritt scheitern laesst.
    const lists = EFFECT_LISTS.filter((list) => (list === 'console' ? extra.length > 0 : (byList[list] ?? []).length > 0));
    return { missing: missing.slice(0, 8), extra, instead, lists, byList };
};

/**
 * Ein Request, der nach der Messung noch im selben Schritt kam, fehlt nicht: Er war nur langsamer.
 * @param answered Zeilen `Name Status` aller beantworteten Requests des Schritts
 * @returns die bereinigte Abweichung oder null
 */
export const withoutLate = (deviation, answered) => {
    if (deviation === undefined || deviation === null) return null;
    const late = new Set(answered);
    const byList = { ...deviation.byList, requests: (deviation.byList?.requests ?? []).filter((line) => !late.has(line)) };
    const rest = summarized({ byList, extra: deviation.extra, instead: deviation.instead });
    return rest === null ? null : { ...deviation, ...rest };
};

/** Standard: Was in gesunden Laeufen voellig stabil war, laesst den Schritt scheitern; der Rest bleibt Warnung. */
export const DEFAULT_EFFECT_FAIL = ['controls', 'console'];

/** Laesst diese Abweichung den Schritt scheitern? Nur gelernte Wirkung, und nur in den Listen aus `fail`. */
export const failsStep = (deviation, fail = DEFAULT_EFFECT_FAIL) => deviation?.learned === true && deviation.lists.some((list) => fail.includes(list));

/** Anfang der Begruendung, wenn nur die Wirkung abweicht. Erkannt wird er in jeder Sprache, auch in Laeufen einer anderen. */
export const effectCause = () => t('run.effect.cause');
// Nach Wiederholungen steht der Grund hinter "In allen 2 Versuchen gescheitert: " bzw. "Auch im 2. Versuch gescheitert: ". Es zaehlt
// der Grund des letzten Versuchs; die davor stehen hinter ihm und zaehlen nicht.
const RETRY_KEYS = ['session.replay.allTriesFailed', 'session.replay.tryFailed'];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RETRY_PREFIXES = Object.values(CATALOGS).flatMap((catalog) => RETRY_KEYS.map((key) => catalog[key]).filter((text) => typeof text === 'string'))
    .map((text) => new RegExp(`^${escapeRegExp(text.split('{reason}')[0]).replace(escapeRegExp('{count}'), '\\d+')}`));
export const isEffectCause = (reason) => {
    const text = String(reason ?? '');
    const bare = [text, ...RETRY_PREFIXES.filter((prefix) => prefix.test(text)).map((prefix) => text.replace(prefix, ''))];
    return Object.values(CATALOGS).some((catalog) => typeof catalog['run.effect.cause'] === 'string'
        && bare.some((candidate) => candidate.startsWith(catalog['run.effect.cause'])));
};

// Bedienelemente stehen als Aenderung in der Wirkung: "+ x" erscheint durch die Aktion, "- x" verschwindet. Fuer Menschen ausgeschrieben.
// Die Zeile selbst kann aus einem Snapshot stammen ("- link \"x\":"): Spiegelstrich und Doppelpunkt am Ende gehoeren nicht zum Namen.
const changeWords = (line) => {
    const plain = (text) => text.replace(/^- /, '').replace(/:$/, '');
    if (line.startsWith('+ ')) return t('run.effect.appears', { what: plain(line.slice(2)) });
    if (line.startsWith('- ')) return t('run.effect.disappears', { what: plain(line.slice(2)) });
    return line;
};

/** Die Abweichung in einem Satz, fuer Einschaetzung, Bericht und Claude. */
export const deviationText = ({ step, number, label, missing, extra, instead }) => [
    t('run.effect.differs', { step, number, label }),
    ...(missing.length === 0 ? [] : [t('run.effect.missing', { list: missing.map(changeWords).join('; ') })]),
    ...(instead.length === 0 || missing.length === 0 ? [] : [t('run.effect.instead', { list: instead.map(changeWords).join('; ') })]),
    ...(extra.length === 0 ? [] : [t('run.effect.console', { list: extra.join('; ') })]),
].join(' ');
