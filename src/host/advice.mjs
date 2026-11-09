// Handlungsempfehlungen von Claude zu Fehlern und Warnungen eines Laufs. Jede nennt ihren Beleg. Testseitige Empfehlungen aendern erst
// nach dem Klick des Menschen etwas. Anwendungsseitige bringen einen Prompt und optional konkrete Aenderungen am Code mit; die schreibt
// der Host nur auf Klick, denn die Sandbox liest das Projekt nur.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE, PROJECT_DIR, RUN_DIR } from '../shared/names.mjs';
import { parseTest, renderTest, stepHash } from './test-file.mjs';
import { CONTROL, EMAIL, replaceStep } from './test-plan.mjs';

export { CONTEXT_FILE } from '../shared/names.mjs';
const MAX_ITEMS = 10;
const LIMITS = { title: 200, reason: 2000, prompt: 8000, text: 2000, notes: 4000 };
const STEP_FIELDS = ['name', 'do', 'expect', 'note', 'retry'];
const CONFIG_KEYS = ['consoleIgnore', 'foreignCode'];
// Wo die Seite Meldungen zeigt: Die Empfehlung ersetzt die ganze Liste, etwa den Toast-Container durch den einzelnen Toast.
const SELECTOR_KEY = 'messageSelectors';
const KINDS = ['step', 'test', 'context', 'config'];
const SIDES = ['test', 'app'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;
const keepEol = (raw, text) => (raw.includes('\r\n') ? text.replaceAll(/\r?\n/g, '\r\n') : text);
/** Alle Texte einer Empfehlung, auch verschachtelte: JSON.stringify wuerde Steuerzeichen maskieren. */
const textsOf = (value) => {
    if (typeof value === 'string') return [value];
    if (typeof value !== 'object' || value === null) return [];
    return Object.values(value).flatMap(textsOf);
};

/** Der Schritt nach der Aenderung. `null` entfernt `note` oder `retry`. */
const changedStep = (step, fields) => {
    const next = { ...step };
    for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete next[key];
        else next[key] = typeof value === 'string' ? value.trim() : value;
    }
    return next;
};

const readChange = (change, spec, config, report) => {
    if (!isObject(change) || !KINDS.includes(change.kind)) return report(`change.kind muss eine von ${KINDS.join(', ')} sein.`);
    if (change.kind === 'step') {
        const step = spec.steps.find(({ id }) => id === change.id);
        if (step === undefined) return report(`Schritt ${change.id} gibt es nicht. Neue Schritte trägt der Mensch von Hand ein.`);
        if (!isObject(change.fields) || Object.keys(change.fields).length === 0) return report('change.fields fehlt.');
        const foreign = Object.keys(change.fields).find((key) => !STEP_FIELDS.includes(key));
        if (foreign !== undefined) return report(`Feld ${foreign} lässt sich nicht ändern (erlaubt: ${STEP_FIELDS.join(', ')}).`);
        for (const key of ['name', 'do', 'expect']) if (change.fields[key] === null) return report(`${key} lässt sich nicht entfernen.`);
        // Dieselbe Pruefung wie fuer die Datei: Was hier durchgeht, liest parseTest spaeter auch.
        try {
            parseTest(renderTest(replaceStep(spec, changedStep(step, change.fields))));
        } catch (error) {
            return report(error.message.split('\n').map((line) => line.replace(/^Testdatei: Zeile \d+: /, '')).join(' '));
        }
        return undefined;
    }
    if (change.kind === 'test') return isText(change.notes, LIMITS.notes) ? undefined : report('change.notes muss Text sein.');
    if (change.kind === 'context') {
        if (!isText(change.section, 80) || change.section.includes('\n')) return report('change.section muss eine Überschrift in einer Zeile sein.');
        return isText(change.text, LIMITS.text) ? undefined : report('change.text fehlt.');
    }
    if (change.key === SELECTOR_KEY) {
        const { selectors } = change;
        if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > MAX_ITEMS || !selectors.every((selector) => isText(selector, 200) && !/[\r\n]/.test(selector))) {
            return report(`change.selectors muss eine Liste von 1 bis ${MAX_ITEMS} CSS-Selektoren sein.`);
        }
        if (JSON.stringify(selectors) === JSON.stringify(config[SELECTOR_KEY] ?? [])) return report(`${SELECTOR_KEY} steht schon so in der Config.`);
        return undefined;
    }
    if (!CONFIG_KEYS.includes(change.key)) return report(`change.key muss ${[...CONFIG_KEYS, SELECTOR_KEY].join(', ')} sein.`);
    if (!isText(change.pattern, 300)) return report('change.pattern fehlt.');
    try {
        new RegExp(change.pattern);
    } catch {
        return report(`${change.pattern} ist kein gültiger regulärer Ausdruck.`);
    }
    if ((config[change.key] ?? []).includes(change.pattern)) return report(`${change.pattern} steht schon in ${change.key}.`);
    return undefined;
};

const MAX_EDITS = 10;
const EDIT_LIMIT = 4000;
// Testdateien, Laufordner und Abhaengigkeiten aendert eine Empfehlung fuer die Anwendung nie.
const NOT_APP = new RegExp(`^(${PROJECT_DIR}|\\${RUN_DIR}|node_modules|\\.git|\\.claude)(/|$)`);
const lf = (text) => text.replaceAll('\r\n', '\n');
const occurrences = (text, part) => text.split(part).length - 1;

/**
 * Konkrete Aenderungen am Code der Anwendung, am echten Stand geprueft: Datei vorhanden, die Stelle genau einmal. So bleibt der
 * Vorschlag verankert, und der Mensch sieht die Zeile.
 * @returns die Aenderungen samt Zeile, oder undefined bei Problemen
 */
const readEdits = (edits, root, report) => {
    if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) return report(`edits muss eine Liste mit 1 bis ${MAX_EDITS} Änderungen sein.`);
    const contents = new Map();
    const checked = [];
    edits.forEach((edit, index) => {
        const at = (message) => report(`edits[${index}]: ${message}`);
        if (!isObject(edit)) return at('Eine Änderung braucht file, find und replace.');
        const file = typeof edit.file === 'string' ? edit.file.replaceAll('\\', '/').replace(/^\.\//, '') : '';
        if (file === '' || /^([/]|[A-Za-z]:)/.test(file) || file.split('/').includes('..')) return at('file muss ein Pfad relativ zum Projekt sein.');
        if (NOT_APP.test(file)) return at(`${file} gehört nicht zur Anwendung.`);
        if (!isText(edit.find, EDIT_LIMIT) || typeof edit.replace !== 'string' || edit.replace.length > EDIT_LIMIT) return at(`find und replace sind Text bis ${EDIT_LIMIT} Zeichen, find nicht leer.`);
        if (edit.find === edit.replace) return at('find und replace sind gleich.');
        if (edit.why !== undefined && !isText(edit.why, 500)) return at('why muss kurzer Text sein.');
        if (root === undefined) return checked.push({ file, find: edit.find, replace: edit.replace, ...(edit.why === undefined ? {} : { why: edit.why }) });
        const path = join(root, file);
        if (!contents.has(file)) {
            if (!existsSync(path)) return at(`${file} gibt es nicht.`);
            contents.set(file, lf(readFileSync(path, 'utf8')));
        }
        const text = contents.get(file);
        const find = lf(edit.find);
        const count = occurrences(text, find);
        if (count !== 1) return at(`find steht ${count === 0 ? 'nicht' : `${count}-mal`} in ${file}, es muss genau einmal sein.`);
        const line = text.slice(0, text.indexOf(find)).split('\n').length;
        // Spaetere Aenderungen an derselben Datei sehen den Stand nach den frueheren.
        contents.set(file, text.replace(find, () => lf(edit.replace)));
        return checked.push({ file, line, find: edit.find, replace: edit.replace, ...(edit.why === undefined ? {} : { why: edit.why }) });
    });
    return checked.length === edits.length ? checked : undefined;
};

/** Schreibt die Aenderungen in den Code der Anwendung, nur nach dem Klick des Menschen. @returns die geaenderten Dateien */
export const applyEdits = (root, edits) => {
    const files = [];
    for (const { file, find, replace } of edits) {
        const path = join(root, file);
        const raw = readFileSync(path, 'utf8');
        const text = lf(raw);
        if (occurrences(text, lf(find)) !== 1) throw new CawError('advice-invalid', t('run.advice.fileChanged', { file }));
        writeFileSync(path, keepEol(raw, text.replace(lf(find), () => lf(replace))));
        if (!files.includes(file)) files.push(file);
    }
    return files;
};

/**
 * Prueft, was Claude einreicht, bevor der Mensch es sieht.
 * @param root      Projektordner: Aenderungen am Code werden gegen den echten Stand geprueft
 * @param diagnosis die Einordnung des Tools: Eine testseitige Empfehlung gegen eine klare Einordnung als Anwendungsfehler wird markiert
 * @returns die Empfehlungen
 * @throws advice-invalid mit allen Problemen
 */
export const readAdvice = (raw, spec, config, { root, diagnosis } = {}) => {
    const problems = [];
    if (!isObject(raw) || !Array.isArray(raw.items)) throw new CawError('advice-invalid', 'Erwartet: { "items": [ ... ] }.');
    if (raw.items.length > MAX_ITEMS) problems.push(`Höchstens ${MAX_ITEMS} Empfehlungen.`);
    const items = [];
    raw.items.forEach((given, index) => {
        const report = (message) => { problems.push(`items[${index}]: ${message}`); };
        if (!isObject(given)) return report('Eine Empfehlung muss ein Objekt sein.');
        const item = given;
        if (!isText(item.evidence, 300)) report('evidence fehlt: Nenne kurz den Beleg, etwa "request GET /x", den Text eines harten Fehlers, "Konsole" oder "src/a.js:12".');
        const texts = textsOf(item);
        if (texts.some((text) => CONTROL.test(text))) report('Enthält Steuerzeichen.');
        if (texts.some((text) => EMAIL.test(text))) report('Enthält eine E-Mail-Adresse.');
        if (!SIDES.includes(item.side)) report('side muss test oder app sein.');
        if (!isText(item.title, LIMITS.title)) report(`title fehlt oder ist länger als ${LIMITS.title} Zeichen.`);
        if (!isText(item.reason, LIMITS.reason)) report('reason fehlt.');
        if (item.about !== undefined && !isText(item.about, 100)) report('about muss kurzer Text sein.');
        let edits;
        if (item.side === 'app') {
            if (!isText(item.prompt, LIMITS.prompt)) report('Eine Empfehlung für die Anwendung braucht prompt.');
            if (item.change !== undefined) report('Eine Empfehlung für die Anwendung ändert nichts am Test, change entfällt.');
            if (item.edits !== undefined) edits = readEdits(item.edits, root, report);
        }
        if (item.side === 'test') {
            readChange(item.change, spec, config, report);
            if (item.edits !== undefined) report('edits gibt es nur für Empfehlungen an die Anwendung.');
        }
        const contradicts = item.side === 'test' && diagnosis?.side === 'app' && diagnosis.strength === 'clear';
        items.push({ ...item, ...(edits === undefined ? {} : { edits }), ...(contradicts ? { contradicts: true } : {}) });
        return undefined;
    });
    if (problems.length > 0) throw new CawError('advice-invalid', problems.join(' '));
    return items;
};

/** Beschriftungen auf der Karte: Der Mensch kennt die Felder aus dem Plan, nicht ihre Schluessel in der Datei. */
const LABELED = ['name', 'do', 'expect', 'note', 'retry', 'notes', 'consoleIgnore', 'foreignCode', 'messageSelectors'];
const labelOf = (key) => (LABELED.includes(key) ? t(`run.advice.label.${key}`) : key);

/** „failure 2“ meint den zweiten harten Fehler des Laufs: Auf der Karte steht sein Text. */
const evidenceText = (evidence, failures) => evidence.replace(/\bfailure (\d+)\b/g, (whole, number) => {
    const failure = failures[Number(number) - 1];
    return failure === undefined ? whole : t('run.advice.hardFailure', { number, type: failure.type, text: String(failure.text).slice(0, 160) });
});

/**
 * Was die Karte im Chat zeigt: je Aenderung vorher und nachher.
 * @param failures harte Fehler des Laufs, damit ein Beleg wie „failure 1“ lesbar wird
 */
export const adviceView = (item, spec, failures = [], config = {}) => {
    const base = {
        side: item.side,
        title: item.title,
        reason: item.reason,
        ...(item.about === undefined ? {} : { about: item.about }),
        ...(item.evidence === undefined ? {} : { evidence: evidenceText(item.evidence, failures) }),
        ...(item.contradicts ? { contradicts: true } : {}),
    };
    if (item.side === 'app') return { ...base, prompt: item.prompt, ...(item.edits === undefined ? {} : { edits: item.edits }) };
    const { change } = item;
    if (change.kind === 'step') {
        const step = spec.steps.find(({ id }) => id === change.id);
        const show = (key, value) => {
            if (value === undefined || value === null) return '';
            if (key === 'retry') return t('run.advice.retry', { times: value.times, seconds: (value.waitMs ?? 10_000) / 1000, from: value.from ?? step.id });
            return typeof value === 'string' ? value : JSON.stringify(value);
        };
        return { ...base, target: `${step.id} ${step.name}`, changes: Object.entries(change.fields).map(([key, value]) => ({ label: labelOf(key), before: show(key, step[key]), after: show(key, value) })) };
    }
    if (change.kind === 'test') return { ...base, target: t('run.advice.testCase'), changes: [{ label: labelOf('notes'), before: spec.notes ?? '', after: change.notes }] };
    if (change.kind === 'context') return { ...base, target: CONTEXT_FILE, changes: [{ label: t('run.advice.section', { section: change.section }), before: '', after: change.text }] };
    if (change.key === SELECTOR_KEY) return { ...base, target: CONFIG_FILE, changes: [{ label: labelOf(SELECTOR_KEY), before: (config[SELECTOR_KEY] ?? []).join('  ·  '), after: change.selectors.join('  ·  ') }] };
    return { ...base, target: CONFIG_FILE, changes: [{ label: labelOf(change.key), before: '', after: change.pattern }] };
};

/**
 * Uebernimmt eine Aenderung am Test, nur im Speicher. Ob sie in die Datei geht, entscheidet der Ablauf.
 * @returns { spec, id, stale, notes }: `stale` nennt den Schritt, dessen Aufzeichnung nicht mehr passt
 */
export const applyToSpec = (spec, change) => {
    if (change.kind === 'test') return { spec: { ...spec, notes: change.notes.trim() }, notes: true };
    const step = spec.steps.find(({ id }) => id === change.id);
    const next = changedStep(step, change.fields);
    const stale = step.recording !== undefined && stepHash(next) !== step.recording.hash;
    return { spec: replaceStep(spec, next), id: step.id, stale };
};

const appendContext = (root, { section, text }) => {
    const path = join(root, CONTEXT_FILE);
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '# caw-ai\n\nProjektkontext für die Tests: Eigenheiten der Anwendungen und was jeder Lauf wissen muss.\n';
    const lines = raw.replaceAll('\r\n', '\n').replace(/\n+$/, '').split('\n');
    const entry = `- ${text.trim().replaceAll(/\s*\n\s*/g, ' ')}`;
    const heading = lines.findIndex((line) => line.trim() === `## ${section.trim()}`);
    if (heading === -1) {
        lines.push('', `## ${section.trim()}`, entry);
    } else {
        const next = lines.findIndex((line, index) => index > heading && line.startsWith('## '));
        let end = next === -1 ? lines.length : next;
        while (end > heading + 1 && lines[end - 1].trim() === '') end -= 1;
        lines.splice(end, 0, entry);
    }
    writeFileSync(path, keepEol(raw, `${lines.join('\n')}\n`));
    return CONTEXT_FILE;
};

/** Der Wert eines Config-Schluessels nach der Aenderung: ein Muster mehr, oder die neue Liste der Selektoren. */
export const configValue = (config, change) => (change.key === SELECTOR_KEY ? [...change.selectors] : [...(config[change.key] ?? []), change.pattern]);

const addPattern = (root, change) => {
    const path = join(root, CONFIG_FILE);
    const raw = readFileSync(path, 'utf8');
    const config = JSON.parse(raw);
    config[change.key] = configValue(config, change);
    writeFileSync(path, keepEol(raw, `${JSON.stringify(config, null, 4)}\n`));
    return CONFIG_FILE;
};

/** Projektkontext und Config sind eigene Dateien: Sie aendern sich sofort, unabhaengig vom Testplan. @returns der Pfad */
export const applyToFiles = (root, change) => (change.kind === 'context' ? appendContext(root, change) : addPattern(root, change));

export const changesFiles = (item) => item.side === 'test' && ['context', 'config'].includes(item.change.kind);
