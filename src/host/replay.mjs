// Einmal von Claude ausfuehren lassen, danach schnell und ohne Modell wiederholen. Aufgezeichnet wird nur auf
// dem Host. Abgespielt wird ueber denselben Handler wie beim Agenten, es gelten also dieselben Grenzen.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CLICK_DELAY_MS, locatorFor } from './agent-commands.mjs';
import { patternLabel, textMatcher } from './patterns.mjs';
import { redactDeep } from './secrets.mjs';
import { selfAbort } from './diagnose.mjs';
import { DATE_NAMES, fillDates, markDates } from './dates.mjs';
import { DEFAULT_EFFECT_FAIL, LEARN_RUNS, createEffects, deviationText, effectCause, effectChange, failsStep, isEffectCause, learnEffects, pruneEffects, withoutLate } from './effects.mjs';
import { summarizeRequests } from './network-log.mjs';
import { describeLocator, explainTarget, explainText, frameworkOf, readPageState, targetLabel, waitForTarget } from './framework/index.mjs';
import { brokenChain, staleSteps, stepHash, withExpectations } from './test-file.mjs';

const DESCRIBE_TIMEOUT_MS = 5000;
const CHECK_POLL_MS = 250;
const DEFAULT_RETRY_WAIT_MS = 10_000;
const TARGETED = new Set(['click', 'fill', 'type', 'upload', 'download']);
const CHANGES_PAGE = new Set(['click', 'press', 'goto', 'reload']);
const EFFECT_ACTIONS = new Set(['click', 'fill', 'type', 'press', 'upload', 'download']);
// So viel einer Meldung steht in Grund und Bericht. Verglichen wird immer der ganze Text.
const MESSAGE_SHOWN = 300;
const EFFECT_SETTLE_MS = 5000;
// So lange misst das Tool die Bedienelemente nach, bevor eine Abweichung zaehlt: Ein langsames Backend baut die Maske spaeter fertig.
const EFFECT_REMEASURE_MS = 10_000;
const EFFECT_REMEASURE_POLL_MS = 500;
export const RUN_TAG_PLACEHOLDER = '{{runTag}}';
// Viele Anwendungen bilden aus einem Namen eine Adresse oder einen Schluessel in Kleinbuchstaben ("Akte CAW-1" wird zu
// /akten/akte-caw-1). Diese Form der Kennung bekommt einen eigenen Platzhalter, sonst stuende sie fest in der Aufzeichnung.
export const RUN_TAG_LOWER_PLACEHOLDER = '{{runTagLower}}';
const RUN_TAG_NAMES = new Set(['runTag', 'runTagLower']);

const LOCKED = /element is not enabled|element is disabled|element is not editable/;
const sleepMs = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
const shownMessage = (text) => (text.length <= MESSAGE_SHOWN ? text : `${text.slice(0, MESSAGE_SHOWN)}…`);
/**
 * Ein Fehler, den ein neuer Versuch innerhalb der Aktion nicht behebt, etwa ein Download mit falschem Namen: Ein zweiter Klick
 * luede ein zweites Mal. `kind` ordnet ihn fuer den Abbruch ein, ohne ihn gilt der uebliche Blick auf die Seite.
 */
const finalError = (message, kind) => Object.assign(new Error(message), { final: true, ...(kind === undefined ? {} : { kind }) });

/**
 * Macht jeden Lauf unterscheidbar: Claude schreibt die Kennung in Freitexte, und jeder Lauf findet so seinen eigenen
 * Datensatz wieder. Nur Ziffern neben dem festen Teil, denn Zahlen in Meldungen gelten als gleich.
 */
export const newRunTag = (now = new Date()) => `CAW-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
const jsonText = (text) => JSON.stringify(String(text)).slice(1, -1);
export const swapText = (value, from, to) => JSON.parse(JSON.stringify(value).replaceAll(jsonText(from), () => jsonText(to)));
/** Ersetzt die Kennung des Laufs in beiden Schreibweisen durch ihre Platzhalter. */
export const tagRun = (value, runTag) => swapText(swapText(value, runTag, RUN_TAG_PLACEHOLDER), runTag.toLowerCase(), RUN_TAG_LOWER_PLACEHOLDER);
/** Setzt die Kennung des Laufs in beide Platzhalter ein. */
export const fillRun = (value, runTag) => swapText(swapText(value, RUN_TAG_PLACEHOLDER, runTag), RUN_TAG_LOWER_PLACEHOLDER, runTag.toLowerCase());

const TOKEN_FIELDS = ['value', 'code', 'url'];
const TARGET_FIELDS = ['own', 'text', 'label', 'name'];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ersetzt einen gemerkten Wert durch seinen Platzhalter, nur als ganzes Token und nur in Eingaben, Pruefungen, Adressen und den
 * sichtbaren Texten eines Ziels. Eine Nummer 2026 trifft so weder das Datum 07.11.2026 noch VG-2026 oder einen Selektor.
 */
export const swapToken = (step, value, placeholder) => {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}._-])${escapeRegExp(value)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'gu');
    const swap = (text) => (typeof text === 'string' ? text.replace(pattern, () => placeholder) : text);
    const next = { ...step };
    for (const key of TOKEN_FIELDS) if (key in next) next[key] = swap(next[key]);
    if (next.target !== null && typeof next.target === 'object') {
        const target = { ...next.target };
        for (const key of TARGET_FIELDS) if (key in target) target[key] = swap(target[key]);
        if (typeof target.inside?.name === 'string') target.inside = { ...target.inside, name: swap(target.inside.name) };
        next.target = target;
    }
    return next;
};

const relativeUrl = (url, base) => {
    const parsed = new URL(url);
    return parsed.origin === new URL(base).origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : url;
};

export const describeSafely = async (locator, framework = frameworkOf()) => {
    try {
        return await describeLocator(framework, locator, { timeout: DESCRIBE_TIMEOUT_MS });
    } catch {
        return null;
    }
};

/**
 * Schneidet mit, was den Lauf wirklich vorangebracht hat: erfolgreiche Schritte, keine Fehlversuche und nichts
 * Lesendes. Das Ziel wird vor der Aktion bestimmt, denn danach ist das Element oft schon weg.
 */
export const createRecorder = ({ handler, session, base, authMarker, runTag, remembered = new Map(), now = () => new Date() }) => {
    const steps = [];
    const problems = [];
    // Meldungen gehoeren zu der Aktion, nach der sie sichtbar waren, und fallen mit ihr weg, wenn sie gestrichen wird. Sonst galte
    // etwa ein Validierungsdialog aus einem Fehlklick fuer immer als bekannt. Was vor der ersten Aktion sichtbar ist, bleibt.
    const initial = new Set();
    const seenAfter = [];
    // Gemerkte Werte, lange zuerst, falls einer im anderen steckt. Vorab gemerkte stammen aus den Schritten davor.
    const placeholders = new Map([...remembered].map(([placeholder, value]) => [value, placeholder]));
    const keep = (step) => {
        // Zwei wait-ready hintereinander werden eins: das gezieltere Warten und das laengere Zeitlimit bleiben.
        const previous = steps.at(-1);
        if (step.action === 'wait-ready' && previous?.action === 'wait-ready') {
            const timeoutMs = Math.max(previous.timeoutMs ?? 0, step.timeoutMs ?? 0);
            steps[steps.length - 1] = { ...previous, ...step, ...(timeoutMs === 0 ? {} : { timeoutMs }) };
            return;
        }
        steps.push(step);
        seenAfter.push(new Set());
    };
    // Danach Daten nahe an heute: Sie gelten relativ, sonst scheiterte der Test am naechsten Tag.
    // Gemerkte Werte zuerst und nur als ganze Tokens: Enthaelt einer die Laufkennung, etwa "Bestellung CAW-1", ginge er sonst verloren.
    // Danach die Laufkennung, eindeutig und ueberall.
    const add = (step) => {
        const named = [...placeholders].sort(([a], [b]) => b.length - a.length).reduce((current, [value, placeholder]) => swapToken(current, value, placeholder), step);
        const tagged = runTag === undefined ? named : tagRun(named, runTag);
        keep(markDates(tagged, now()));
    };
    const currentPath = () => {
        try {
            return { path: new URL(session.page().url()).pathname };
        } catch {
            return {};
        }
    };
    // Vergleichswerte (Requests, Wirkung) entstehen hier nicht: Unter Claudes Steuerung laufen auch Fehlklicks und Umwege, die
    // aus der Aufzeichnung gestrichen werden. Der erste gesunde `run` der bereinigten Aufzeichnung traegt sie ein.
    return {
        steps,
        problems,
        get messages() {
            return new Set([...initial, ...seenAfter.flatMap((seen) => [...seen])]);
        },
        /** Schritte, die der Mensch im laufenden Browser vorgefuehrt hat. */
        addSteps: (shown) => shown.forEach(add),
        /** Die nummerierte Liste, aus der der Agent seine Umwege benennt. */
        list: () => steps.map((step, index) => `${index + 1} ${stepLabel(step)}`),
        /** Vergisst die Pruefungen dieser Schritte; ihre Aktionen gehoeren dann zur naechsten Pruefung. */
        forgetChecks: (ids) => {
            for (let index = steps.length - 1; index >= 0; index -= 1) {
                if (steps[index].action !== 'check' || !ids.has(steps[index].id)) continue;
                steps.splice(index, 1);
                const [seen] = seenAfter.splice(index, 1);
                for (const message of seen) (index === 0 ? initial : seenAfter[index - 1]).add(message);
            }
        },
        /** Streicht Schritte. Danach stehen womoeglich zwei wait-ready hintereinander, einer reicht. */
        drop: (numbers) => {
            const kept = steps.map((step, index) => [step, seenAfter[index]]).filter((_pair, index) => !numbers.includes(index + 1));
            steps.length = 0;
            seenAfter.length = 0;
            for (const [step, seen] of kept) {
                keep(step);
                for (const message of seen) seenAfter.at(-1).add(message);
            }
        },
        handler: async (command) => {
            // Was vor dem Befehl sichtbar ist, gehoert zum Ablauf: Zwischen zwei Befehlen hatte die Seite Zeit zu reagieren.
            const state = await readPageState(session.framework ?? frameworkOf(), session.page(), authMarker, session.messageSelectors).catch(() => null);
            // Statushinweise auch: Ein Banner, das immer steht, soll nicht in jedem Lauf als neu warnen.
            for (const message of [...(state?.messages ?? []), ...(state?.notes ?? [])]) (steps.length === 0 ? initial : seenAfter.at(-1)).add(message);
            const target = TARGETED.has(command?.action) && typeof command.target === 'string'
                ? await describeSafely(locatorFor(session.page(), command.target), session.framework)
                : undefined;
            const path = currentPath();
            let value;
            try {
                value = await handler(command);
            } catch (error) {
                if (command?.action === 'goto' && error.code === 'target-denied') add({ action: 'goto', url: command.url, denied: true });
                throw error;
            }
            switch (command.action) {
                case 'click':
                case 'fill':
                case 'type':
                    if (target === null) problems.push(t('session.replay.unstableTarget', { action: command.action, target: command.target }));
                    else add({ action: command.action, target, ...path, ...(command.value === undefined ? {} : { value: command.value }) });
                    break;
                case 'press': add({ action: 'press', key: command.key }); break;
                case 'goto': add({ action: 'goto', url: relativeUrl(command.url, base) }); break;
                case 'reload': add({ action: 'reload' }); break;
                case 'screenshot': add({ action: 'screenshot', name: command.name }); break;
                case 'wait-ready':
                    // Ein eigenes Zeitlimit gilt auch beim Abspielen: Brauchte die Seite bei der Aufnahme laenger, braucht sie das wieder.
                    if (value?.settled) add({ action: 'wait-ready', ...(command.store === undefined ? {} : { store: command.store }), ...(command.minCount === undefined ? {} : { minCount: command.minCount }), ...(Number.isFinite(command.timeout) ? { timeoutMs: command.timeout } : {}) });
                    break;
                case 'check':
                    if (value?.pass) add({ action: 'check', id: command.id, code: command.code });
                    break;
                case 'remember':
                    add({ action: 'remember', name: value.name, code: command.code });
                    placeholders.set(value.value, `{{${value.name}}}`);
                    break;
                default:
            }
            return value;
        },
    };
};

/**
 * Liest `omit` aus dem Urteil: [12, "14-16"]. Pruefungen sind der Massstab und lassen sich nie streichen. Auch
 * Zahlen und Laengen sind begrenzt, denn die Angabe kommt vom Agenten.
 * @returns die Nummern, aufsteigend
 */
export const dropNumbers = (steps, wanted) => {
    if (wanted === undefined) return [];
    const reject = (message) => new CawError('finish-rejected', `omit: ${message}`);
    if (!Array.isArray(wanted)) throw reject('Erwartet wird eine Liste wie [12, "14-16"].');
    const numbers = new Set();
    for (const entry of wanted) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(String(entry));
        if (match === null) throw reject(`"${String(entry).slice(0, 40)}" ist keine Nummer.`);
        const from = Number(match[1]);
        const to = Number(match[2] ?? match[1]);
        if (from < 1 || to > steps.length || from > to) throw reject(`${String(entry).slice(0, 40)} liegt außerhalb von 1 bis ${steps.length}.`);
        for (let number = from; number <= to; number += 1) numbers.add(number);
    }
    for (const number of numbers) {
        if (steps[number - 1].action === 'check') throw reject(`Schritt ${number} ist eine Prüfung (${steps[number - 1].id}), die bleibt.`);
        if (steps[number - 1].action === 'remember') throw reject(`Schritt ${number} merkt sich ${steps[number - 1].name}, das bleibt.`);
    }
    return [...numbers].sort((a, b) => a - b);
};

/**
 * Was das Tool selbst bereinigt, zusaetzlich zu Claudes `omit`: Screenshots belegen nur den Lauf, und vom zweimal gefuellten
 * Feld zaehlt der letzte Wert. Ein wait-ready dazwischen aendert daran nichts.
 * @returns die Nummern, aufsteigend
 */
export const tidyNumbers = (steps, omitted = []) => {
    const remaining = steps.map((step, index) => ({ step, number: index + 1 })).filter(({ number }) => !omitted.includes(number));
    const numbers = [];
    remaining.forEach(({ step, number }, position) => {
        if (step.action === 'screenshot') numbers.push(number);
        if (step.action !== 'fill') return;
        const next = remaining.slice(position + 1).find((later) => later.step.action !== 'wait-ready' && later.step.action !== 'screenshot');
        if (next?.step.action === 'fill' && JSON.stringify(next.step.target) === JSON.stringify(step.target)) numbers.push(number);
    });
    return numbers;
};

/**
 * Was nach der letzten Pruefung noch steht, gehoert zu keinem Schritt.
 * @returns die Nummern, aufsteigend
 */
export const trailingNumbers = (steps, omitted = []) => {
    const remaining = steps.map((step, index) => ({ step, number: index + 1 })).filter(({ number }) => !omitted.includes(number));
    const last = remaining.findLastIndex(({ step }) => step.action === 'check');
    return remaining.slice(last + 1).map(({ number }) => number);
};

/** Alle Aktionen seit der letzten Pruefung gehoeren zum Schritt dieser Pruefung. Prueft Claude nach, zaehlt die letzte. */
export const groupSteps = (steps) => {
    const groups = new Map();
    let pending = [];
    for (const step of steps) {
        if (step.action !== 'check') {
            pending.push(step);
            continue;
        }
        const group = groups.get(step.id) ?? { actions: [] };
        group.actions.push(...pending);
        group.check = step.code;
        groups.set(step.id, group);
        pending = [];
    }
    return { groups, trailing: pending };
};

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
const usedNames = (value) => [...JSON.stringify(value).matchAll(PLACEHOLDER)].map(([, name]) => name).filter((name) => !RUN_TAG_NAMES.has(name) && !DATE_NAMES.has(name));

/** Jeder Schritt muss seine Platzhalter aus einem Schritt davor oder aus sich selbst kennen, sonst scheitert er erst beim Abspielen. */
export const missingRemembered = (spec) => {
    const known = new Set();
    const problems = [];
    for (const { id, recording } of spec.steps) {
        for (const action of recording?.actions ?? []) {
            if (action.action === 'remember') known.add(action.name);
            else for (const name of usedNames(action)) if (!known.has(name)) problems.push(`${id} braucht {{${name}}}, das davor kein Schritt merkt.`);
        }
        for (const name of usedNames(recording?.check ?? '')) if (!known.has(name)) problems.push(`${id} braucht {{${name}}}, das davor kein Schritt merkt.`);
    }
    return [...new Set(problems)];
};

/**
 * Nur ein bestandener Lauf, der jeden Schritt selbst belegt, wird wiederholbar.
 * @param spec   der freigegebene Plan
 * @param draft  beim Beheben der ganze Test, darin wird genau dieser eine Schritt ersetzt
 * @returns { problems, candidate, fresh }, `fresh` nennt Meldungen, die die Aufzeichnung bisher nicht kannte
 */
export const buildReplay = ({ recorder, outcome, spec, target, draft, now = new Date() }) => {
    const problems = [...recorder.problems];
    // Alle Schritte belegt, nur ein harter Fehler unterwegs, etwa in einem gestrichenen Fehlversuch: Das klaert der Pruefdurchlauf ohne Claude.
    const onlyHardFailures = outcome?.status === 'fail' && outcome.failures?.length > 0 && outcome.results.every(({ status }) => status === 'pass');
    if (outcome?.status !== 'pass' && !onlyHardFailures) problems.push(t('session.replay.endedWith', { status: outcome?.status ?? t('session.replay.noVerdict') }));
    const { groups, trailing } = groupSteps(recorder.steps);
    const missing = spec.steps.map(({ id }) => id).filter((id) => !groups.has(id));
    if (missing.length > 0) problems.push(t('session.replay.withoutCheck', { ids: missing.join(', ') }));
    if (trailing.length > 0) problems.push(t('session.replay.trailing', { actions: trailing.map(stepLabel).join(', ') }));
    const strays = [...groups.keys()].filter((id) => !spec.steps.some((step) => step.id === id));
    if (strays.length > 0) problems.push(t('session.replay.strays', { ids: strays.join(', ') }));
    if (problems.length > 0) return { problems };

    const order = (draft ?? spec).steps.map(({ id }) => id);
    // Ein von Hand als geheim markierter Wert bleibt geheim, auch wenn Claude den Schritt neu aufnimmt: Claude kennt die Markierung nicht.
    const secret = new Set((draft?.steps ?? []).flatMap(({ recording }) => recording?.actions ?? []).filter(({ action, secret: hidden }) => action === 'remember' && hidden === true).map(({ name }) => name));
    const recorded = spec.steps.map((step) => {
        const before = order[order.indexOf(step.id) - 1];
        const { check } = groups.get(step.id);
        const actions = groups.get(step.id).actions.map((action) => (action.action === 'remember' && secret.has(action.name) ? { ...action, secret: true } : action));
        // Ein von Hand gesetztes Zeitlimit der Pruefung ueberlebt das Beheben.
        const timeoutMs = draft?.steps.find(({ id }) => id === step.id)?.recording?.timeoutMs;
        return {
            ...step,
            recording: {
                hash: stepHash(step),
                ...(before === undefined ? {} : { after: before }),
                recordedOn: target,
                recordedAt: now.toISOString(),
                actions,
                check,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            },
        };
    });
    const messages = recorder.messages ?? new Set();
    // Muster von Hand bleiben, hinter den festen Texten; was ein Muster schon deckt, kommt nicht als fester Text dazu.
    const given = draft?.knownMessages ?? [];
    const known = textMatcher(given);
    const fresh = [...messages].filter((message) => !known(message)).sort();
    const texts = given.filter((entry) => typeof entry === 'string');
    const candidate = withExpectations({
        ...(draft ?? spec),
        steps: draft === undefined ? recorded : draft.steps.map((step) => recorded.find(({ id }) => id === step.id) ?? step),
        knownMessages: [...[...new Set([...texts, ...fresh])].sort(), ...given.filter((entry) => typeof entry !== 'string')],
    });
    const lost = missingRemembered(candidate);
    return lost.length > 0 ? { problems: lost } : { problems, candidate, fresh };
};

/**
 * Ein Ziel ueber seine Position: nur ueber sie, oder als zweiter oder spaeterer von mehreren gleichen Treffern. Bei einem Treffer mehr
 * oder anderer Sortierung trifft es ein anderes Element, und eine allgemeine Pruefung besteht trotzdem.
 */
const POSITION_FREE = ['text', 'label', 'own', 'name', 'testid', 'inside', 'id', 'itemId', 'reference'];
export const isPositional = (target) => target?.index !== undefined && (target.index > 0 || POSITION_FREE.every((key) => target[key] === undefined));

/** Aktionen der genannten Schritte, deren Ziel nur ueber die Position gewaehlt ist, etwa ['S2 click button']. */
export const positionalActions = (spec, ids) => spec.steps.filter(({ id }) => ids === undefined || ids.has(id)).flatMap(({ id, recording }) => (recording?.actions ?? [])
    .filter(({ target }) => isPositional(target)).map((action) => `${id} ${stepLabel(action)}`));

/** Prueft, bevor ein Browser aufgeht: Veraltetes nennt den Befehl, der es behebt. */
export const assertPlayable = (spec, target, until) => {
    if (spec.steps.every(({ recording }) => recording === undefined)) {
        throw new CawError('replay-missing', t('session.replay.missing', { id: spec.id, target }));
    }
    const end = until === undefined ? spec.steps.length : spec.steps.findIndex(({ id }) => id === until) + 1;
    const reached = { ...spec, steps: spec.steps.slice(0, end) };
    const chain = brokenChain(reached);
    if (chain !== null) throw new CawError('replay-stale', t('session.replay.chainStale', { chain, id: spec.id, target }));
    const [stale] = staleSteps(reached);
    if (stale !== undefined) throw new CawError('replay-stale', t('session.replay.stepStale', { step: stale.id, why: stale.why, id: spec.id, target }));
};

/**
 * Gelernte Wirkung gilt nur fuer den Zustand, in dem sie gelernt wurde: `basis` ist der Aufnahmezeitpunkt des Schritts davor. Wird
 * ein frueherer Schritt behoben, startet der naechste womoeglich in einem anderen Zustand, und seine Wirkung wird neu gelernt.
 */
const basisOf = (spec, step) => spec.steps[spec.steps.findIndex(({ id }) => id === step.id) - 1]?.recording?.recordedAt;
const currentEffects = (spec, step) => {
    const effects = step.recording?.effects;
    return effects === undefined || effects.basis === undefined || effects.basis === basisOf(spec, step) ? effects : undefined;
};
const withBasis = (spec, step, effects) => {
    const basis = basisOf(spec, step);
    const { basis: _old, ...rest } = effects;
    return basis === undefined ? rest : { ...rest, basis };
};

const flatten = (spec, steps, until) => ({
    test: spec.id,
    recordedOn: steps.at(-1)?.recording?.recordedOn,
    ...(spec.knownMessages === undefined ? {} : { knownMessages: spec.knownMessages }),
    ...(until === undefined ? {} : { until }),
    retries: Object.fromEntries(steps.filter(({ retry }) => retry !== undefined).map(({ id, retry }) => [id, retry])),
    // Vergleich aus der Aufnahme: Er zeigt, ob ein neuer Versuch ueberhaupt etwas aendern kann.
    baselines: Object.fromEntries(steps.filter(({ recording }) => recording?.network !== undefined).map(({ id, recording }) => [id, recording.network])),
    // Wirkung je Aktion aus gesunden Laeufen: Sie zeigt die erste Aktion, nach der sich die Anwendung anders verhaelt.
    effects: Object.fromEntries(steps.filter((step) => currentEffects(spec, step) !== undefined).map((step) => [step.id, currentEffects(spec, step)])),
    steps: steps.flatMap(({ id, recording }) => [
        ...recording.actions,
        { action: 'check', id, code: recording.check, ...(recording.timeoutMs === undefined ? {} : { timeoutMs: recording.timeoutMs }) },
    ]),
});

/** Die Aktionen aller Schritte in einer Reihe, so wie sie abgespielt werden. */
export const replayOf = (spec) => flatten(spec, spec.steps);

/**
 * Das Stueck der Aufzeichnung bis zu einem Zustand. Danach passiert nichts mehr, auch kein Schreibzugriff.
 * `until` markiert das Ergebnis: Spaetere Schritte zaehlen nicht zum Lauf.
 */
export const cutReplay = (spec, until) => {
    const end = spec.steps.findIndex(({ id }) => id === until);
    if (end === -1) throw new CawError('step-unknown', t('session.replay.stepUnknown', { id: spec.id, until }));
    return flatten(spec, spec.steps.slice(0, end + 1), until);
};

/** Was vor einem Schritt laufen muss, um ihn zu beheben. */
export const replayBefore = (spec, id) => {
    const end = spec.steps.findIndex((step) => step.id === id);
    return flatten(spec, spec.steps.slice(0, end));
};

/** Der Pruefdurchlauf: bis vor den ersten Schritt, der noch veraltet ist. Er wird ohnehin als Naechstes behoben. */
export const replayUpToStale = (spec) => {
    const [stale] = staleSteps(spec);
    const end = stale === undefined ? spec.steps.length : spec.steps.findIndex(({ id }) => id === stale.id);
    if (end === spec.steps.length) return flatten(spec, spec.steps);
    return flatten(spec, spec.steps.slice(0, end), spec.steps[end - 1]?.id);
};

export const stepLabel = (step) => {
    switch (step.action) {
        case 'click': return `click ${targetLabel(step.target)}`;
        case 'fill':
        case 'type': return `${step.action} ${targetLabel(step.target)}`;
        case 'upload': return `upload ${targetLabel(step.target)} ${step.files.join(', ')}`;
        case 'download': return `download ${targetLabel(step.target)} /${step.file}/`;
        case 'press': return `press ${step.key}`;
        case 'goto': return `goto ${step.url}`;
        case 'screenshot': return `screenshot ${step.name}`;
        case 'check': return `check ${step.id}`;
        case 'remember': return `remember ${step.name}`;
        default: return step.action;
    }
};

/** Wie die Werkbank ein Element nennt: sein Text in Anfuehrungszeichen, sonst Rolle oder Tag. */
const shownTarget = (target = {}) => {
    const shown = target.text ?? target.label ?? target.name ?? target.own;
    return shown === undefined ? targetLabel(target) : t('session.point.quoted', { text: patternLabel(shown) });
};

/**
 * Eine Aktion der Aufzeichnung als Punkt der Schrittliste: Art und kurze Beschreibung. Eingegebene Werte stehen nie darin,
 * es koennte ein Passwort sein.
 * @param expects  Erwartung je Schritt-ID, fuer den Text einer Pruefung
 * @returns { kind, label }
 */
export const stepPoint = (step, expects = new Map()) => {
    switch (step.action) {
        case 'click': return { kind: t('session.point.click'), label: shownTarget(step.target) };
        case 'fill':
        case 'type': return { kind: t('session.point.type'), label: shownTarget(step.target) };
        case 'upload': return { kind: t('session.point.upload'), label: shownTarget(step.target) };
        case 'download': return { kind: t('session.point.download'), label: shownTarget(step.target) };
        case 'press': return { kind: t('session.point.press'), label: step.key };
        case 'goto': return { kind: t('session.point.goto'), label: step.url };
        case 'reload': return { kind: t('session.point.reload'), label: t('session.point.page') };
        case 'screenshot': return { kind: t('session.point.screenshot'), label: step.name };
        case 'wait-ready': return { kind: t('session.point.wait'), label: t('session.point.pageQuiet') };
        case 'check': return { kind: t('session.point.check'), label: expects.get(step.id) ?? step.id };
        case 'remember': return { kind: t('session.point.remember'), label: step.name };
        default: return { kind: step.action, label: '' };
    }
};

/**
 * Die Schritte als Gruppen der Werkbank, je Aktion der Aufzeichnung ein Punkt mit der Position als ID (`a<position>`).
 * Schritte ohne Aktion in der Aufzeichnung (noch nicht aufgenommen) bleiben ohne Punkte.
 */
export const stepGroups = (steps, replay) => {
    const expects = new Map(steps.map(({ id, expect }) => [id, expect]));
    const points = new Map(steps.map(({ id }) => [id, []]));
    let owner = null;
    (replay?.steps ?? []).forEach((step, index) => {
        // Wie beim Abspielen: Eine Aktion gehoert zur naechsten Pruefung, was nach der letzten kommt, zur letzten.
        owner = replay.steps.slice(index).find(({ action }) => action === 'check')?.id ?? owner;
        points.get(owner)?.push({ id: `a${index + 1}`, ...stepPoint(step, expects) });
    });
    return steps.map(({ id, name }) => ({ id, name, points: points.get(id) ?? [] }));
};

/**
 * Spielt eine Aufzeichnung ab. Feste Pausen gibt es nicht: Jeder Schritt wartet auf seine Bedingung, bis sein
 * Zeitlimit ablaeuft. Auch das Urteil geht durch den Handler, harte Konsolenfehler zaehlen also wie beim Agenten.
 */
/** @param filesDir  der caw-Ordner des Projekts: Dort liegen die Dateien fuer upload, etwa caw/fixtures/. */
export const playReplay = async ({ replay, handler, session, base, authMarker, stepTimeoutMs, runTag, filesDir, log = () => {}, sleep = sleepMs, now = Date.now, effectFail = DEFAULT_EFFECT_FAIL }) => {
    // Wirkung je Aktion: was dieser Lauf sah (letzter Versuch) und die erste Abweichung von der gelernten je Schritt.
    const measure = session.trail === undefined ? null : createEffects({ session });
    const observed = new Map();
    const deviations = new Map();
    // Schritte, die nur als Vorlauf eines neuen Versuchs liefen: Ihre Wirkung wird weder verglichen noch gelernt.
    const warmup = new Set();
    // Schritte mit neuem Versuch, je Schritt die scheiternde Abweichung des letzten Versuchs, und die, die zweimal gleich abwichen.
    const retried = new Set();
    const effectKeys = new Map();
    const repeated = new Set();
    const results = new Map();
    // Was die Versuche davor gestoppt hat, je Schritt. Es bleibt im Bericht sichtbar, auch wenn ein spaeterer Versuch besteht.
    const history = new Map();
    /** Der Grund samt der Versuche davor. Gleiche Gruende stehen nur einmal da, lange Pruefausdruecke sonst mehrfach. */
    // Schritte, deren retry nicht lief, weil ein neuer Versuch nichts aendern kann, mit dem Grund.
    const skipped = new Map();
    // Je Schritt der Selbstabbruch des letzten Versuchs: Erst wenn er sich wiederholt, lohnt kein weiterer Versuch.
    const aborts = new Map();
    const withTries = (id, reason) => {
        const tried = history.get(id);
        const why = skipped.has(id) ? ` ${skipped.get(id)}` : '';
        if (tried === undefined) return `${reason}${why}`;
        const others = [...new Set(tried)].filter((text) => text !== reason);
        if (others.length === 0) return t('session.replay.allTriesFailed', { count: tried.length + 1, reason, why });
        return t('session.replay.tryFailed', { count: tried.length + 1, reason, others: others.join('; '), why });
    };
    // Der reine Grund je gescheiterter Pruefung, ohne die Versuche davor: Nur er geht in die Geschichte.
    const causes = new Map();
    const known = replay.knownMessages === undefined ? null : textMatcher(replay.knownMessages);
    // Unbekannte Statushinweise lassen nichts scheitern, sie kommen je nach Tempo. Der Bericht nennt jeden einmal als Warnung.
    const noted = new Set();
    const readState = async () => {
        const state = await readPageState(session.framework ?? frameworkOf(), session.page(), authMarker, session.messageSelectors).catch(() => null);
        for (const note of state?.notes ?? []) {
            if (known?.(note) || noted.has(note)) continue;
            noted.add(note);
            session.warn?.({ type: 'note', text: t('session.replay.newNote', { note: shownMessage(note) }) });
        }
        return state;
    };
    const unknownMessage = (state) => (known === null ? undefined : state?.messages.find((message) => !known(message)));

    /** Harter Fehler oder fremde Meldung: Der Test schlaegt fehl, egal ob der naechste Schritt noch ginge. */
    const externalProblem = async () => {
        const [failure] = session.failures?.() ?? [];
        if (failure !== undefined) return t('session.replay.hardFailure', { type: failure.type, text: failure.text });
        const message = unknownMessage(await readState());
        return message === undefined ? null : t('session.replay.unexpectedMessage', { message: shownMessage(message) });
    };

    /**
     * Bei jedem Scheitern, nicht nur bei fehlendem Ziel: Eine abgelaufene Sitzung zeigt sich meist als nicht erfuellte Pruefung,
     * als 401, 500 oder HTML statt JSON. Der Satz im Grund laesst die Einordnung die Folgen der Anmeldung zuschreiben.
     */
    const LOST = t('session.replay.signInLost');
    const withSignIn = async (message) => {
        if (authMarker === undefined || message.includes(LOST)) return message;
        const state = await readState();
        return state !== null && state.signedIn === false ? `${message} ${LOST}` : message;
    };

    /** Warum ein Ziel fehlt: Ist die Seite selbst in einem falschen Zustand, gibt es nichts nachzubessern. */
    const stateProblem = (state, step) => {
        if (state === null) return t('session.replay.pageUnreadable');
        if (!state.appLoaded) return t('session.replay.appNotLoaded', { framework: (session.framework ?? frameworkOf()).label });
        if (!state.signedIn) return LOST;
        if (state.loading) return t('session.replay.loadMask');
        if (step.path !== undefined && state.path !== step.path) return t('session.replay.wrongPath', { actual: state.path, expected: step.path });
        const message = unknownMessage(state);
        return message === undefined ? null : t('session.replay.unexpectedMessage', { message: shownMessage(message) });
    };

    const settle = async (timeoutMs) => {
        await session.page().waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
        await session.waitReady({ timeout: timeoutMs }).catch(() => {});
    };

    /** Dateien fuer upload, relativ zum caw-Ordner. Was fehlt oder ausserhalb liegt, bricht ab, bevor etwas angeklickt wird. */
    const uploadFiles = (files) => files.map((file) => {
        const path = resolve(filesDir ?? '', file);
        const inside = filesDir !== undefined && !relative(filesDir, path).startsWith('..') && !isAbsolute(relative(filesDir, path));
        if (!inside || !existsSync(path)) throw finalError(t('session.replay.uploadMissing', { file }), 'state');
        return path;
    });
    // Die Seite, deren Ereignisse zum Element gehoeren: In der Werkbank ist die Anwendung ein Frame, die Ereignisse kommen von der Seite.
    const pageOf = async (element) => {
        const frame = typeof element.ownerFrame === 'function' ? await element.ownerFrame().catch(() => null) : null;
        return frame?.page() ?? session.page();
    };
    /** Ein Dateifeld bekommt die Dateien direkt. Ein Knopf davor oeffnet beim Klick die Dateiauswahl, sie bekommt sie dann. */
    const upload = async (element, step, files, remaining) => {
        if (await element.evaluate((node) => node instanceof HTMLInputElement && node.type === 'file')) {
            await element.setInputFiles(files, { timeout: remaining });
            return;
        }
        const chooser = (await pageOf(element)).waitForEvent('filechooser', { timeout: remaining }).catch(() => null);
        // Nicht erst auf den Klick warten: Unter Windows kehrt er mitunter erst zurueck, wenn die Dateiauswahl bedient ist.
        const clicked = element.click({ timeout: remaining, delay: CLICK_DELAY_MS }).then(() => null, (error) => error);
        const picker = await Promise.race([chooser, clicked.then((error) => (error === null ? chooser : null))]);
        if (picker === null) {
            const error = await clicked;
            if (error !== null) throw error;
            throw finalError(t('session.replay.noChooser', { target: targetLabel(step.target) }));
        }
        await picker.setFiles(files, { timeout: remaining });
        // Die Dateien sind gesetzt; ein Klick, der danach noch haengt, aendert daran nichts.
        await clicked;
    };
    /** Der Klick startet einen Download: Sein Name passt zum Muster, und die Datei ist nicht leer. */
    const download = async (element, step, remaining) => {
        const started = (await pageOf(element)).waitForEvent('download', { timeout: remaining }).catch(() => null);
        await element.click({ timeout: remaining, delay: CLICK_DELAY_MS });
        const file = await started;
        if (file === null) throw finalError(t('session.replay.noDownload', { target: targetLabel(step.target), seconds: Math.round(remaining / 1000) }), 'check');
        const name = file.suggestedFilename();
        const path = await file.path().catch(() => null);
        const size = path === null || !existsSync(path) ? 0 : statSync(path).size;
        await file.delete?.().catch(() => {});
        if (!new RegExp(step.file).test(name)) throw finalError(t('session.replay.downloadName', { name, pattern: step.file }), 'check');
        if (size === 0) throw finalError(t('session.replay.downloadEmpty', { name }), 'check');
    };

    const act = async (step, timeoutMs) => {
        const deadline = now() + timeoutMs;
        const files = step.action === 'upload' ? uploadFiles(step.files) : [];
        for (;;) {
            const remaining = Math.max(deadline - now(), 1);
            const element = await waitForTarget(session.framework ?? frameworkOf(), session.page(), step.target, { timeoutMs: remaining, sleep, now });
            if (element === null) {
                // Fehlt das Ziel, oder liegt etwas darueber? Ein offener Dialog mit Meldung erklaert mehr als "fehlt".
                const why = await explainTarget(session.framework ?? frameworkOf(), session.page(), step.target);
                const error = new Error(t('session.replay.notClickable', { target: targetLabel(step.target), seconds: Math.round(timeoutMs / 1000), why: explainText(why) }));
                if (why !== null) error.blocker = why;
                throw error;
            }
            try {
                if (step.action === 'click') await element.click({ timeout: remaining, delay: CLICK_DELAY_MS });
                else if (step.action === 'fill') await element.fill(step.value, { timeout: remaining });
                else if (step.action === 'upload') await upload(element, step, files, remaining);
                else if (step.action === 'download') await download(element, step, remaining);
                else await element.type(step.value, { timeout: remaining });
                return;
            } catch (error) {
                // ExtJS baut Elemente um. Solange Zeit bleibt, wird das Ziel neu gesucht.
                if (error.final || now() >= deadline) throw error;
                await sleep(CHECK_POLL_MS);
            }
        }
    };

    const check = async (step, timeoutMs) => {
        const deadline = now() + timeoutMs;
        let last = t('session.replay.noEvaluation');
        for (;;) {
            try {
                const { pass, value } = await handler({ action: 'check', id: step.id, code: step.code });
                last = JSON.stringify(value) ?? String(value);
                if (pass) break;
            } catch (error) {
                // Waehrend eines Seitenwechsels ist z. B. Ext kurz undefiniert.
                last = firstLine(error);
            }
            if (now() >= deadline) {
                const cause = await withSignIn(t('session.replay.checkTimeout', { seconds: Math.round(timeoutMs / 1000), code: step.code }));
                causes.set(step.id, cause);
                results.set(step.id, { id: step.id, status: 'fail', evidence: { type: 'eval', value: last }, note: withTries(step.id, cause) });
                return;
            }
            await sleep(CHECK_POLL_MS);
        }
        const tried = history.get(step.id);
        results.set(step.id, {
            id: step.id,
            status: 'pass',
            evidence: { type: 'eval', value: `${step.code} => ${last}` },
            ...(tried === undefined ? {} : { note: t('session.replay.passedOnTry', { count: tried.length + 1, tries: tried.join('; ') }) }),
        });
    };

    /** Der Wert stammt aus diesem Lauf. Er erscheint womoeglich erst kurz nach dem Schritt davor, darum wiederholen. */
    const remembered = new Map();
    const hidden = [];
    const mask = (value) => (hidden.length === 0 ? value : redactDeep(value, hidden));
    const remember = async (step, timeoutMs) => {
        const deadline = now() + timeoutMs;
        for (;;) {
            try {
                const { name, value } = await handler({ action: 'remember', name: step.name, code: step.code });
                remembered.set(`{{${name}}}`, value);
                // Geheim: Ab jetzt steht der Wert weder im Protokoll noch im Bericht, und die Sitzung schwaerzt ihn wie das Passwort der Rolle.
                if (step.secret === true) {
                    hidden.push(value);
                    session.hide?.(value);
                }
                return;
            } catch (error) {
                if (now() >= deadline) throw new Error(t('session.replay.unreadable', { name: step.name, error: firstLine(error) }));
                await sleep(CHECK_POLL_MS);
            }
        }
    };

    const run = async (step, timeoutMs) => {
        if (TARGETED.has(step.action)) await act(step, timeoutMs);
        else if (step.action === 'check') await check(step, timeoutMs);
        else if (step.action === 'remember') await remember(step, timeoutMs);
        else if (step.action === 'goto' && step.denied) {
            const denied = await handler({ action: 'goto', url: step.url }).then(() => false, (error) => error.code === 'target-denied');
            if (!denied) throw new Error(t('session.replay.notDenied', { url: step.url }));
        } else if (step.action === 'goto') await handler({ action: 'goto', url: new URL(step.url, base).href });
        else if (step.action === 'wait-ready') await session.waitReady({ timeout: timeoutMs, ...(step.store === undefined ? {} : { store: step.store }), ...(step.minCount === undefined ? {} : { minCount: step.minCount }) }).catch(() => {});
        else await handler(step);
        if (CHANGES_PAGE.has(step.action) && !step.denied) await settle(timeoutMs);
    };

    const ownerOf = (index) => replay.steps.slice(index).find(({ action }) => action === 'check')?.id ?? replay.steps.findLast(({ action }) => action === 'check')?.id;
    let broken = null;
    const stop = async (position, label, kind, given, blocker) => {
        const message = await withSignIn(given);
        // Aktionen gehoeren zur naechsten Pruefung, also nennt das auch der Abbruch.
        const owner = ownerOf(position - 1);
        // Sauber: Von diesem Schritt ist noch nichts ausgefuehrt, die Seite steht also genau davor. Ein Fehler von aussen kann sie veraendert haben.
        const clean = kind !== 'external' && position - 1 === starts.get(owner);
        broken = { number: `${position}/${replay.steps.length}`, step: owner, label, kind, message, clean, ...(blocker === undefined ? {} : { blocker }) };
        const name = `fehler-schritt-${position}.png`;
        await handler({ action: 'screenshot', name }).then(() => { broken.screenshot = name; }, () => {});
    };

    // Wo jeder Schritt in der flachen Liste beginnt und wie viele harte Fehler es da schon gab.
    const starts = new Map();
    let segment = 0;
    replay.steps.forEach(({ action, id }, index) => {
        if (action !== 'check') return;
        starts.set(id, segment);
        segment = index + 1;
    });
    const marks = new Map();
    const netMarks = new Map();
    // Wie viele schreibende Requests es zu Beginn jedes Schritts schon gab: Ein neuer Versuch nach einem Schreiben legte doppelt an.
    const writeMarks = new Map();
    const writeCount = () => (session.writes?.() ?? []).reduce((sum, { count }) => sum + count, 0);

    /** Haelt die Wirkung fest und vergleicht sie mit der gelernten. Ein neuer Versuch ersetzt, was der alte sah. */
    const noteEffect = (owner, number, effect, label) => {
        if (!observed.has(owner)) observed.set(owner, new Map());
        observed.get(owner).set(number, effect);
        const learned = replay.effects?.[owner];
        if (learned === undefined || deviations.has(owner)) return;
        const change = effectChange(learned.actions.find(({ action }) => action === number) ?? {}, effect);
        if (change !== null) deviations.set(owner, { step: owner, number, label, learned: learned.runs >= LEARN_RUNS, ...change });
    };
    // Die Aktion, deren Wirkung noch gemessen wird.
    let pending = null;
    /** Wuerden fehlende oder neue Bedienelemente den Schritt scheitern lassen? Nur das kann sich durch Warten noch aendern. */
    const controlsFail = (owner, number, effect) => {
        const learned = replay.effects?.[owner];
        if (learned === undefined || learned.runs < LEARN_RUNS || deviations.has(owner) || !effectFail.includes('controls')) return false;
        const change = effectChange(learned.actions.find(({ action }) => action === number) ?? {}, effect);
        return change !== null && change.lists.includes('controls');
    };
    const settleEffect = async () => {
        if (pending === null) return;
        const { owner, number, label } = pending;
        pending = null;
        await session.waitReady({ timeout: EFFECT_SETTLE_MS }).catch(() => {});
        let effect = await measure.after().catch(() => null);
        // Nachmessen wie bei einer Pruefung, bevor die naechste Aktion laeuft. Gesunde Laeufe kostet das nichts.
        const deadline = now() + Math.min(stepTimeoutMs, EFFECT_REMEASURE_MS);
        while (effect !== null && controlsFail(owner, number, effect) && now() < deadline) {
            await sleep(EFFECT_REMEASURE_POLL_MS);
            await session.waitReady({ timeout: EFFECT_SETTLE_MS }).catch(() => {});
            effect = await measure.after().catch(() => null) ?? effect;
        }
        if (effect !== null) noteEffect(owner, number, effect, label);
    };

    /**
     * Neuer Versuch: warten, neu laden, ab dem genannten Schritt noch einmal. Harte Fehler seit dessen Beginn gehoeren zum
     * gescheiterten Versuch; sie fallen aus dem Urteil, ihr Text bleibt in der Notiz des Schritts.
     * @returns wo es weitergeht, null wenn kein Versuch mehr uebrig ist
     */
    const again = async (owner, reason) => {
        const retry = replay.retries?.[owner];
        const tried = history.get(owner) ?? [];
        if (retry === undefined || tried.length >= retry.times) return null;
        const from = retry.from ?? owner;
        // Schon geschrieben seit Beginn des Versuchs: Ein neuer Versuch schickte dasselbe noch einmal, mit derselben Laufkennung.
        const written = writeMarks.has(from) ? writeCount() - writeMarks.get(from) : 0;
        if (written > 0) {
            skipped.set(owner, t('session.replay.skipWritten', { from, count: written }));
            const result = results.get(owner);
            if (result?.status === 'fail') result.note = withTries(owner, causes.get(owner));
            log({ position: starts.get(owner) + 1, number: `${starts.get(owner) + 1}/${replay.steps.length}`, owner, label: t('session.replay.skipWrittenLog', { owner, from }) });
            return null;
        }
        // Bricht die Anwendung selbst ab und tat sie das schon im Versuch davor, kommt beim Neuladen dasselbe heraus.
        const abort = netMarks.has(owner) ? selfAbort(session.network.since(netMarks.get(owner).from), replay.baselines?.[owner]) : null;
        const pointless = abort !== null && aborts.get(owner) === abort ? abort : null;
        if (abort !== null) aborts.set(owner, abort);
        if (pointless !== null) {
            skipped.set(owner, t('session.replay.skipAbort', { reason: pointless }));
            const result = results.get(owner);
            if (result?.status === 'fail') result.note = withTries(owner, causes.get(owner));
            log({ position: starts.get(owner) + 1, number: `${starts.get(owner) + 1}/${replay.steps.length}`, owner, label: t('session.replay.skipAbortLog', { owner }) });
            return null;
        }
        // Dieselbe Abweichung wie im Versuch davor: Die Anwendung reagiert verlaesslich anders, ein weiterer Versuch aendert nichts.
        if (isEffectCause(reason) && repeated.has(owner)) {
            pending = null;
            skipped.set(owner, t('session.replay.skipEffect'));
            const result = results.get(owner);
            if (result?.status === 'fail') result.note = withTries(owner, causes.get(owner));
            log({ position: starts.get(owner) + 1, number: `${starts.get(owner) + 1}/${replay.steps.length}`, owner, label: t('session.replay.skipEffectLog', { owner }) });
            return null;
        }
        history.set(owner, [...tried, reason]);
        retried.add(owner);
        const start = starts.get(from) ?? starts.get(owner);
        const ids = replay.steps.slice(start).filter(({ action }) => action === 'check').map(({ id }) => id);
        pending = null;
        ids.slice(0, ids.indexOf(owner) + 1).forEach((id) => {
            results.delete(id);
            observed.delete(id);
            deviations.delete(id);
            // Nur Vorlauf fuer den wiederholten Schritt: Der Versuch davor hat die Anwendung schon veraendert, etwa eine Aufgabe
            // geoeffnet. Seine Wirkung weicht dann zu Recht ab und zaehlt nicht.
            if (id !== owner) warmup.add(id);
        });
        log({ position: start + 1, number: `${start + 1}/${replay.steps.length}`, owner, label: t('session.replay.retryLog', { owner, count: tried.length + 2, total: retry.times + 1, from }) });
        await sleep(retry.waitMs ?? DEFAULT_RETRY_WAIT_MS);
        await handler({ action: 'reload' }).catch(() => {});
        // Bis zum Neuladen gehoert alles zum alten Versuch, auch ein Fehler, den die alte Seite noch beim Entladen wirft. Was die neue
        // Seite beim Start wirft, bleibt: Es ist ein Befund dieses Versuchs und verschwindet nicht mit einem bestandenen Lauf.
        const cut = session.failures?.().length ?? 0;
        await settle(stepTimeoutMs);
        const dropFrom = marks.get(from) ?? marks.get(owner) ?? 0;
        // Ein Skriptfehler verschwindet mit dem neuen Versuch aus dem Urteil, aber nicht aus dem Bericht: Er kann ein seltener Fehler der Anwendung sein.
        for (const failure of (session.failures?.() ?? []).slice(dropFrom, cut).filter(({ type }) => type === 'pageerror')) {
            session.warn?.({ type: 'retry', text: t('session.replay.hiddenScriptError', { owner, count: tried.length + 1, text: failure.text }) });
        }
        session.retractFailures?.(dropFrom, cut);
        return start;
    };

    let index = 0;
    while (index < replay.steps.length) {
        const position = index + 1;
        const recorded = replay.steps[index];
        const owner = ownerOf(index);
        const opensStep = index === starts.get(owner);
        const tagged = runTag === undefined ? recorded : fillRun(recorded, runTag);
        const step = fillDates([...remembered].reduce((current, [placeholder, value]) => swapText(current, placeholder, value), tagged));
        const problem = await externalProblem();
        if (problem !== null) {
            // Am Anfang eines Schritts stammt der Fehler aus dem Schritt davor, ein neuer Versuch hier wuerde ihn nicht treffen.
            const restart = opensStep ? null : await again(owner, problem);
            if (restart !== null) {
                index = restart;
                continue;
            }
            await stop(position, stepLabel(step), 'external', withTries(owner, problem));
            break;
        }
        if (opensStep) {
            marks.set(owner, session.failures?.().length ?? 0);
            writeMarks.set(owner, writeCount());
            if (session.network !== undefined) netMarks.set(owner, { from: session.network.mark() });
        }
        log({ position, number: `${position}/${replay.steps.length}`, step: mask(step), owner, label: mask(stepLabel(step)) });
        // Wirkung einer Aktion: von davor bis zur naechsten Aktion oder Pruefung, also samt dem Warten danach. Ein Fehler beim
        // Messen aendert nichts am Lauf.
        // Vor einer Pruefung wird erst danach gemessen: Manches laedt erst, waehrend sie wartet, und so zaehlt der Zustand, den sie sieht.
        if (step.action !== 'wait-ready' && step.action !== 'screenshot' && step.action !== 'check') await settleEffect();
        if (measure !== null && EFFECT_ACTIONS.has(step.action)) {
            await measure.before().catch(() => {});
            pending = { owner, number: index - starts.get(owner) + 1, label: stepLabel(step) };
        }
        try {
            await run(step, step.timeoutMs ?? stepTimeoutMs);
        } catch (error) {
            // Ist die Aktion selbst gescheitert, hat sie nichts bewirkt, das sich vergleichen liesse. Das Warten danach schon.
            if (EFFECT_ACTIONS.has(step.action)) pending = null;
            else await settleEffect();
            // Playwright wartet auf ein freigegebenes Ziel und nennt das nur im Protokoll unter der ersten Zeile. Ein gesperrtes Ziel
            // ist ein Zustand der Anwendung, kein veralteter Schritt, und auch keine Lademaske, selbst wenn daneben ein Fortschritt laeuft.
            // Ein Fehler mit eigener Einordnung, etwa ein Download mit falschem Namen, sagt schon, was los ist.
            const sorted = error?.kind !== undefined;
            const locked = !sorted && TARGETED.has(step.action) && LOCKED.test(String(error?.message ?? ''));
            const state = locked ? t('session.replay.locked') : (TARGETED.has(step.action) && !sorted ? stateProblem(await readState(), step) : null);
            const kind = sorted ? error.kind : TARGETED.has(step.action) && state === null ? 'target' : 'state';
            const message = state === null ? firstLine(error) : `${firstLine(error)} ${state}`;
            const restart = await again(owner, message);
            if (restart !== null) {
                index = restart;
                continue;
            }
            await stop(position, stepLabel(step), kind, withTries(owner, message), error.blocker);
            break;
        }
        if (step.action === 'check') {
            await settleEffect();
            // Was nach der Messung noch im Schritt kam, war nur langsamer und fehlt nicht.
            if (deviations.has(step.id) && netMarks.has(step.id)) {
                const answered = session.network.since(netMarks.get(step.id).from)
                    .filter(({ outcome }) => outcome === 'ok' || outcome === 'http').map(({ name, status }) => `${name} ${status}`);
                const rest = withoutLate(deviations.get(step.id), answered);
                if (rest === null) deviations.delete(step.id);
                else deviations.set(step.id, rest);
            }
            // Bestanden, aber die Anwendung reagierte anders als in gesunden Laeufen, und zwar in einem verlaesslichen Signal.
            const deviation = deviations.get(step.id);
            // Nach einer Wiederholung ist der Zustand nicht mehr der eines gesunden Laufs, etwa eine schon uebernommene Aufgabe: Dann
            // scheitert nur noch der wiederholte Schritt selbst an seiner Wirkung, spaetere warnen nur.
            const comparable = !warmup.has(step.id) && (retried.size === 0 || retried.has(step.id));
            if (results.get(step.id)?.status === 'pass' && comparable && failsStep(deviation, effectFail)) {
                deviation.fails = true;
                // Gleich wie im Versuch davor, gemessen an dem, woran der Schritt scheitert: Ein weiterer Versuch aendert nichts.
                const key = JSON.stringify(effectFail.flatMap((list) => (list === 'console' ? deviation.extra : deviation.byList?.[list] ?? [])));
                if (effectKeys.get(step.id) === key) repeated.add(step.id);
                effectKeys.set(step.id, key);
                const cause = await withSignIn(`${effectCause()} ${deviationText(deviation)}`);
                causes.set(step.id, cause);
                results.set(step.id, { id: step.id, status: 'fail', evidence: { type: 'eval', value: deviationText(deviation) }, note: withTries(step.id, cause) });
            }
            if (netMarks.has(step.id)) netMarks.get(step.id).end = session.network.mark();
            const result = results.get(step.id);
            const failure = result.status === 'fail' ? causes.get(step.id) : await externalProblem();
            const restart = failure === null ? null : await again(step.id, failure);
            if (restart !== null) {
                index = restart;
                continue;
            }
            // Ein harter Fehler, waehrend die Pruefung wartete: Er gehoert zu diesem Schritt, nicht zum naechsten, der ihn nur fande.
            if (failure !== null && result.status === 'pass') {
                results.set(step.id, { ...result, status: 'fail', note: withTries(step.id, failure) });
                await stop(position, stepLabel(step), 'external', withTries(step.id, failure));
                break;
            }
            // Gescheiterte Pruefung ohne Versuch: Weiter liefe der Test auf einem Zustand, der schon falsch ist, samt schreibender
            // Schritte, und spaetere Fehler fielen auf diesen Schritt zurueck.
            if (result.status === 'fail') {
                await stop(position, stepLabel(step), 'check', result.note);
                break;
            }
        }
        index += 1;
    }
    if (broken === null) {
        const problem = await externalProblem();
        if (problem !== null) await stop(replay.steps.length, t('session.replay.end'), 'external', problem);
    }
    // Je Schritt die Requests seines letzten Versuchs, Belege fuer die Einordnung eines Fehlers.
    const requests = new Map([...netMarks].map(([id, { from, end }]) => [id, session.network.since(from, end)]));
    await settleEffect();
    // Ein bestandener Schritt, der anders wirkt als gelernt: Drift, bevor eine Pruefung reisst. Gelernte Wirkung zaehlt, die im Lernen nicht.
    for (const id of warmup) {
        observed.delete(id);
        deviations.delete(id);
    }
    for (const [id, deviation] of deviations) {
        if (results.get(id)?.status === 'pass' && deviation.learned) session.warn?.({ type: 'effect', text: deviationText(deviation) });
    }
    // Geheime Werte bleiben fuer den Lauf in `remembered`; in Ergebnis und Abbruch, also im Bericht, stehen sie geschwaerzt.
    return { results: new Map([...results].map(([id, result]) => [id, mask(result)])), broken: mask(broken), remembered, requests, effects: observed, deviations, retried };
};

/**
 * Vergleichswerte, die einer Aufzeichnung noch fehlen: Ein bestandener Schritt zeigt, welche Requests ein gesunder Lauf macht.
 * Nur auf dem Ziel, auf dem der Schritt aufgenommen wurde, sonst passen die Dauern nicht. Was schon da ist, bleibt; nur Werte
 * aus der Zeit vor den Parameternamen werden ersetzt.
 * @returns Map Schritt -> recording.network
 */
export const missingBaselines = ({ spec, results, requests, target }) => {
    const found = new Map();
    for (const step of spec.steps) {
        const { recording } = step;
        const complete = recording?.network !== undefined && recording.network.every((entry) => entry.params !== undefined);
        if (recording === undefined || complete || recording.recordedOn !== target) continue;
        if (results.get(step.id)?.status !== 'pass' || !requests?.has(step.id)) continue;
        found.set(step.id, summarizeRequests(requests.get(step.id), { answeredOnly: true }));
    }
    return found;
};

/**
 * Gelernte Wirkung je Aktion aus bestandenen Schritten, nur auf dem Ziel der Aufnahme. Nach LEARN_RUNS gesunden Laeufen steht
 * sie fest. Ein Schritt mit Abweichung lernt nicht: Sonst verschwaende ein Fehler aus dem Vergleich, statt aufzufallen.
 * @returns Map Schritt -> recording.effects
 */
export const learnedEffects = ({ spec, results, effects, deviations, target, prune = false, fail = DEFAULT_EFFECT_FAIL }) => {
    const found = new Map();
    for (const step of spec.steps) {
        const { recording } = step;
        if (recording === undefined || recording.recordedOn !== target || results.get(step.id)?.status !== 'pass') continue;
        const deviation = deviations?.get(step.id);
        // `prune`: Der ganze Lauf bestand ohne Wiederholung. Wich ein Schritt dann nur in Listen ausserhalb von `fail` ab, ist das
        // Rauschen, und es faellt aus dem Gelernten.
        if (deviation?.learned) {
            const pruned = prune ? pruneEffects(currentEffects(spec, step), deviation, fail) : null;
            if (pruned !== null) found.set(step.id, withBasis(spec, step, pruned));
            continue;
        }
        if (!effects?.has(step.id)) continue;
        const learned = learnEffects(currentEffects(spec, step), effects.get(step.id));
        if (learned !== null) found.set(step.id, withBasis(spec, step, learned));
    }
    return found;
};

/** Traegt gelernte Wirkungen ein. Der Hash bleibt. */
export const withEffects = (spec, effects) => ({
    ...spec,
    steps: spec.steps.map((step) => (effects.has(step.id) && step.recording !== undefined ? { ...step, recording: { ...step.recording, effects: effects.get(step.id) } } : step)),
});

/** Vergisst die gelernte Wirkung eines Schritts: Die naechsten gesunden Laeufe lernen sie neu. Der Hash bleibt. */
export const withoutEffects = (spec, id) => ({
    ...spec,
    steps: spec.steps.map((step) => {
        if (step.id !== id || step.recording?.effects === undefined) return step;
        const { effects, ...recording } = step.recording;
        return { ...step, recording };
    }),
});

/** Traegt Vergleichswerte in die Aufzeichnungen ein. Der Hash bleibt, `network` zaehlt nicht dazu. */
export const withBaselines = (spec, baselines) => ({
    ...spec,
    steps: spec.steps.map((step) => (baselines.has(step.id) && step.recording !== undefined ? { ...step, recording: { ...step.recording, network: baselines.get(step.id) } } : step)),
});

/**
 * Der erste gescheiterte Schritt und warum. Harte Fehler und fremde Meldungen sehen nach der Anwendung aus, nicht nach einem
 * veralteten Schritt; beheben darf der Mensch trotzdem, er entscheidet.
 * @returns { id, reason, suspect, clean } oder null, wenn alles bestanden hat; `clean`: Der Browser steht genau vor dem Schritt,
 *          beheben geht dort ohne Vorlauf. Nach einer gescheiterten Pruefung lief das Abspielen weiter, dann nie.
 */
export const failedStep = ({ results, broken, expectations, failures = [] }) => {
    const failed = expectations.find(({ id }) => results.get(id)?.status === 'fail');
    const suspect = broken?.kind === 'external' || failures.length > 0;
    if (failed !== undefined) return { id: failed.id, reason: results.get(failed.id).note, suspect, clean: false };
    return broken === null ? null : { id: broken.step, reason: `${broken.label}: ${broken.message}`, suspect, clean: broken.clean === true && failures.length === 0 };
};

/** Baut aus dem Abspielen das Ergebnis fuer `finish`: Was nicht erreicht wurde, ist fail, nie stillschweigend pass. */
export const replayVerdict = ({ results, broken, expectations }) => {
    const note = broken === null ? t('session.replay.noCheck') : t('session.replay.brokenAt', { number: broken.number, label: broken.label, message: broken.message });
    const evidence = broken?.screenshot === undefined ? { type: 'eval', value: t('session.replay.notReached') } : { type: 'screenshot', value: broken.screenshot };
    const owner = broken?.step;
    const items = expectations.map(({ id }) => results.get(id) ?? { id, status: 'fail', evidence, note: id === owner || owner === undefined ? note : t('session.replay.notReachedBecause', { owner }) });
    // Auch wenn alle Punkte schon belegt waren: Ein spaeterer Abbruch darf nicht als pass enden.
    if (broken !== null && items.length > 0 && items.every(({ status }) => status === 'pass')) {
        items[items.length - 1] = { ...items.at(-1), status: 'fail', note };
    }
    return { expectations: items };
};
