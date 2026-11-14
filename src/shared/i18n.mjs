// UI language: German or English. Workbench, chat, CLI and error messages get their texts via t(). It is personal: the
// team language (config `language`) only decides what Claude writes and the language of report.md (teamLanguage, inLanguage).
//
// Order: CAW_LANG, then "language" in prefs.json, then LC_ALL / LC_MESSAGES / LANG / LANGUAGE, then the system language
// (Intl), else English.
//
// Rule for modules: never call t() at module top level, because the language is not known yet at import time.
// Texts belong inside functions or are fetched when used.

import { CATALOGS } from './locales/index.mjs';
import { readPrefs } from './prefs.mjs';

export const LANGUAGES = ['de', 'en'];
const FALLBACK = 'en';
let current = null;

const pick = (value) => {
    const code = String(value ?? '').trim().toLowerCase().replace('_', '-').split(/[-.@:]/)[0];
    return LANGUAGES.includes(code) ? code : null;
};

/** The personal UI language from the environment, prefs.json and the system; never from the project's config. */
export const detectLanguage = ({ env = process.env, system = () => Intl.DateTimeFormat().resolvedOptions().locale, prefs = () => readPrefs(env) } = {}) => {
    const forced = pick(env.CAW_LANG);
    if (forced !== null) return forced;
    const chosen = pick(prefs().language);
    if (chosen !== null) return chosen;
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

/** Sets the language; unknown values fall back to English. */
export const setLanguage = (value) => {
    current = pick(value) ?? FALLBACK;
    return current;
};

/**
 * The team language: config `language` (a primary language subtag such as "de", "en", "fr"), else the UI language. Claude writes
 * plans, notes and chat texts in it.
 */
export const teamLanguage = (config) => (typeof config?.language === 'string' && config.language !== '' ? config.language : language());

/**
 * Runs fn with the texts of another language, e.g. report.md in the team language (de/en, otherwise English). Synchronous only:
 * the UI language is back before anything else runs.
 */
export const inLanguage = (value, fn) => {
    const saved = language();
    current = pick(value) ?? FALLBACK;
    try {
        return fn();
    } finally {
        current = saved;
    }
};

/** The current language; without setLanguage it is detected from environment and system. */
export const language = () => {
    if (current === null) current = detectLanguage();
    return current;
};

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])));

/**
 * The text for key in the current language. Catalogue entries are strings with {placeholders} or functions (vars) => text,
 * e.g. for plurals. Missing in the language: English, then German, then the key itself.
 */
export const t = (key, vars = {}) => {
    const entry = CATALOGS[language()]?.[key] ?? CATALOGS.en?.[key] ?? CATALOGS.de?.[key];
    if (entry === undefined) return key;
    return typeof entry === 'function' ? entry(vars) : fill(entry, vars);
};

/** All texts with this prefix as a flat object, for page scripts in the browser (workbench, chat). Strings only. */
export const texts = (prefix) => {
    const out = {};
    for (const catalog of [CATALOGS.de, CATALOGS.en, CATALOGS[language()]]) {
        for (const [key, value] of Object.entries(catalog ?? {})) if (key.startsWith(prefix) && typeof value === 'string') out[key] = value;
    }
    return out;
};
