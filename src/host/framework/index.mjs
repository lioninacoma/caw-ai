// Die Naht zum Framework der getesteten Anwendung: Ziele beschreiben und wiederfinden, Seitenzustand, Bereitschaft. Gewaehlt ueber
// `framework` in der Config; `web` ist der Standard und kommt ohne Wissen ueber ein Framework aus. Alles andere im Tool ist neutral.
//
// Ein Adapter ist ein Objekt mit:
// - `targets(element, { mode, target })`: laeuft im Browser; `describe` liefert ein stabiles Ziel, `find` das Element dazu
// - `pageState({ marker, selectors })`: laeuft im Browser; { appLoaded, signedIn, loading, path, messages }
// - `probe(store)`: laeuft im Browser; { pendingAjax, loadingStores, counts, appReady }
// - `countNetwork`: offene Requests aus dem Netzwerkprotokoll zaehlen beim Warten mit
// - `floats`: Reihenfolge schwebender Fenster mitschreiben; `stackSkip`: Dateien, die Fehler nur weiterreichen
// - `messageSelectors`: Meldungen der Seite, solange die Config keine nennt
// - `hints`: optional, Hinweise fuer Claude, wo im Quellcode zu suchen ist
// - `watch`: optional, { label, command }: Woran der Watch des Frameworks als Prozess zu erkennen ist. Laeuft keiner, spielt
//   caw-ai keinen lokalen Code ein und testet den deployten Stand. Ohne `watch` gilt lokaler Code wie konfiguriert.
// - `name`, `label`: fuer Config und Meldungen

import { extjs } from './extjs.mjs';
import { angular, react, vue } from './spa.mjs';
import { web } from './web.mjs';
import { patternLabel } from '../patterns.mjs';

export const FRAMEWORKS = { web, extjs, react, vue, angular };
export const DEFAULT_FRAMEWORK = 'web';

export const frameworkOf = (config) => FRAMEWORKS[config?.framework ?? DEFAULT_FRAMEWORK] ?? web;

const sleepMs = (ms) => new Promise((ok) => { setTimeout(ok, ms); });

/** Beschreibt das Element hinter einem Locator als stabiles Ziel, oder null. */
export const describeLocator = (framework, locator, options) => locator.evaluate(framework.targets, { mode: 'describe' }, options);

const findExpression = (framework, target) => `(${framework.targets})(null, ${JSON.stringify({ mode: 'find', target })})`;

/** Wartet, bis das Ziel klickbar ist. Waehrend eines Seitenwechsels scheitert die Auswertung, das ist normal. */
export const waitForTarget = async (framework, page, target, { timeoutMs, pollMs = 150, sleep = sleepMs, now = Date.now } = {}) => {
    const deadline = now() + timeoutMs;
    for (;;) {
        const handle = await page.evaluateHandle(findExpression(framework, target)).catch(() => null);
        const found = handle?.asElement() ?? null;
        if (found !== null) return found;
        await handle?.dispose().catch(() => {});
        if (now() >= deadline) return null;
        await sleep(pollMs);
    }
};

/**
 * Warum ein Ziel nicht klickbar war, falls der Adapter es sagen kann: { missing } | { hidden } | { covered: { role|tag, name?, messages? } }.
 * Adapter ohne diese Auskunft liefern null.
 */
export const explainTarget = async (framework, page, target) => {
    const why = await (async () => page.evaluate(`(${framework.targets})(null, ${JSON.stringify({ mode: 'explain', target })})`))().catch(() => null);
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
 * Die Namen, die dem gesuchten am naechsten kommen: kleine Tippdistanz oder ein gemeinsames Wort. Hilft bei umbenannten
 * Knoepfen ("Speichern" zu "Sichern", "Akte anlegen" zu "Neue Akte anlegen"). Hoechstens zwei, die besten zuerst.
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

/** Der Satz dazu fuer Meldung und Bericht, oder ''. */
export const explainText = (why) => {
    if (why === null || why === undefined) return '';
    if (why.missing) return ` Es fehlt auf der Seite.${(why.similar ?? []).length === 0 ? '' : ` Ähnlich: ${why.similar.map(({ role, name }) => `${role} „${name}“`).join(', ')}. Wurde es umbenannt?`}`;
    if (why.hidden) return ' Es ist da, aber unsichtbar.';
    const { role, tag, name, messages = [] } = why.covered;
    const by = `${role ?? tag}${name === undefined ? '' : ` „${name}“`}`;
    return ` Es ist da, aber verdeckt von ${by}${messages.length === 0 ? '.' : `, der meldet: „${messages.join('“, „')}“${/[.!?]$/.test(messages.at(-1)) ? '' : '.'}`}`;
};

export const DEFAULT_SELECTORS =['[role=alert]', '[role=alertdialog]'];

export const readPageState = async (framework, page, marker, selectors = DEFAULT_SELECTORS) => page.evaluate(framework.pageState, { marker, selectors });

/** Kurzform fuer Meldungen, z. B. actionbutton "Weiter" oder button "Senden". */
export const targetLabel = ({ xtype, role, tag, text, label, name, own, testid, part, component }) => {
    const shown = text ?? label ?? name ?? own ?? (testid === undefined ? undefined : `#${testid}`);
    return `${xtype ?? role ?? part ?? tag ?? 'Element'}${shown === undefined ? '' : ` "${patternLabel(shown)}"`}${component === undefined ? '' : ` in <${component}>`}`;
};

const READY = { timeout: 15_000, quietMs: 250, pollMs: 100 };

/**
 * Wartet, bis die Seite ruhig ist: nichts laedt laut Adapter, bei `countNetwork` auch kein offener Request der Seite, und mit
 * `minCount` mindestens so viele Treffer fuer `store`. Ruhig heisst: `quietMs` am Stueck.
 * @param pending  offene Requests dieser Seite (nur bei `countNetwork`)
 * @returns { settled, waitedMs, samples, reason, lastSample }
 */
export const waitQuiet = async (framework, page, { store = null, minCount = null, timeout = READY.timeout, quietMs = READY.quietMs, pollMs = READY.pollMs, pending = () => 0, sleep = sleepMs, now = Date.now } = {}) => {
    const start = now();
    let samples = 0;
    let lastSample = null;
    let quietSince = null;
    for (;;) {
        const sample = await page.evaluate(framework.probe, store).catch(() => null);
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
