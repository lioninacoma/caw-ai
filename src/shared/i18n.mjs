// Sprache der Oberflaeche: Deutsch oder Englisch. Werkbank, Chat, CLI, Fehlermeldungen und Bericht holen ihre Texte ueber t().
// Die Prompts an Claude bleiben einsprachig; Claude antwortet in der Sprache des Projekts.
//
// Reihenfolge: CAW_LANG, dann "language" in caw.config.json, dann LC_ALL / LC_MESSAGES / LANG / LANGUAGE, dann die Sprache des
// Systems (Intl), sonst Englisch.
//
// Regel fuer Module: t() nie auf oberster Ebene eines Moduls aufrufen, denn beim Import steht die Sprache noch nicht fest.
// Texte gehoeren in Funktionen oder werden beim Gebrauch geholt.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CATALOGS } from './locales/index.mjs';

export const LANGUAGES = ['de', 'en'];
const FALLBACK = 'en';
let current = null;

const pick = (value) => {
    const code = String(value ?? '').trim().toLowerCase().replace('_', '-').split(/[-.@:]/)[0];
    return LANGUAGES.includes(code) ? code : null;
};

/** Die Sprache aus Umgebung, Config und System; root: Projektordner mit caw.config.json, falls bekannt. */
export const detectLanguage = ({ root, env = process.env, system = () => Intl.DateTimeFormat().resolvedOptions().locale } = {}) => {
    const forced = pick(env.CAW_LANG);
    if (forced !== null) return forced;
    if (root !== undefined) {
        try {
            const configured = pick(JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8')).language);
            if (configured !== null) return configured;
        } catch {
            // Keine oder kaputte Config: Das meldet loadConfig spaeter selbst.
        }
    }
    for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
        const found = pick(env[name]);
        if (found !== null) return found;
    }
    try {
        return pick(system()) ?? FALLBACK;
    } catch {
        return FALLBACK;
    }
};

/** Legt die Sprache fest; unbekannte Werte fallen auf Englisch. */
export const setLanguage = (value) => {
    current = pick(value) ?? FALLBACK;
    return current;
};

/** Die aktuelle Sprache; ohne setLanguage ermittelt aus Umgebung und System. */
export const language = () => {
    if (current === null) current = detectLanguage();
    return current;
};

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])));

/**
 * Der Text zu key in der aktuellen Sprache. Katalogeintraege sind Zeichenketten mit {platzhaltern} oder Funktionen (vars) => text,
 * etwa fuer Mehrzahl. Fehlt er in der Sprache, gilt Englisch, dann Deutsch, dann der Schluessel selbst.
 */
export const t = (key, vars = {}) => {
    const entry = CATALOGS[language()]?.[key] ?? CATALOGS.en?.[key] ?? CATALOGS.de?.[key];
    if (entry === undefined) return key;
    return typeof entry === 'function' ? entry(vars) : fill(entry, vars);
};

/** Alle Texte mit diesem Praefix als flaches Objekt, fuer Seiten-JS im Browser (Werkbank, Chat). Nur Zeichenketten. */
export const texts = (prefix) => {
    const out = {};
    for (const catalog of [CATALOGS.de, CATALOGS.en, CATALOGS[language()]]) {
        for (const [key, value] of Object.entries(catalog ?? {})) if (key.startsWith(prefix) && typeof value === 'string') out[key] = value;
    }
    return out;
};
