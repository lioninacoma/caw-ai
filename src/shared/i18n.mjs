// UI language: German or English. Workbench, chat, CLI and error messages get their texts via t(). A project speaks one
// language: without a personal choice the UI follows the team language (config `language`), so caw's texts and the test's own
// texts don't mix. The team language also decides what Claude writes and the language of report.md (teamLanguage, inLanguage).
//
// Order: CAW_LANG, then "language" in prefs.json (both a deliberate personal choice), then the project's team language when it
// is de or en, then LC_ALL / LC_MESSAGES / LANG / LANGUAGE, then the system language (Intl), else English.
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

/**
 * The UI language: a personal choice (CAW_LANG, prefs.json), else the project's team language, else the system's.
 * @param team the `language` of the project's caw.config.json, if any
 */
export const detectLanguage = ({ env = process.env, system = () => Intl.DateTimeFormat().resolvedOptions().locale, prefs = () => readPrefs(env), team } = {}) => {
    const forced = pick(env.CAW_LANG);
    if (forced !== null) return forced;
    const chosen = pick(prefs().language);
    if (chosen !== null) return chosen;
    const project = pick(team);
    if (project !== null) return project;
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

/**
 * Where the UI language comes from, in the order of detectLanguage: 'env' (CAW_LANG), 'prefs' (prefs.json), 'project'
 * (the config's team language) or 'system' (locale variables, the system, the fallback). For the workbench's settings page.
 */
export const languageSource = ({ env = process.env, prefs = () => readPrefs(env), team } = {}) => {
    if (pick(env.CAW_LANG) !== null) return 'env';
    if (pick(prefs().language) !== null) return 'prefs';
    return pick(team) !== null ? 'project' : 'system';
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

/** The agent that runs or is connected, as texts name it ({agent}). There is one today: Claude Code. */
export const AGENT_NAME = 'Claude Code';
// agentDash: in a German compound the name is coupled with hyphens (Claude-Code-Session).
const DEFAULTS = { agent: AGENT_NAME, agentDash: AGENT_NAME.replaceAll(' ', '-') };
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = vars[name] ?? DEFAULTS[name];
    return value === undefined ? whole : String(value);
});

/**
 * The text for key in the current language. Catalogue entries are strings with {placeholders} or functions (vars) => text,
 * e.g. for plurals. Missing in the language: English, then German, then the key itself.
 */
export const t = (key, vars = {}) => {
    const entry = CATALOGS[language()]?.[key] ?? CATALOGS.en?.[key] ?? CATALOGS.de?.[key];
    if (entry === undefined) return key;
    return typeof entry === 'function' ? fill(entry(vars), DEFAULTS) : fill(entry, vars);
};

/** All texts with this prefix as a flat object, for page scripts in the browser (workbench, chat). Strings only. */
export const texts = (prefix) => {
    const out = {};
    for (const catalog of [CATALOGS.de, CATALOGS.en, CATALOGS[language()]]) {
        for (const [key, value] of Object.entries(catalog ?? {})) if (key.startsWith(prefix) && typeof value === 'string') out[key] = fill(value, DEFAULTS);
    }
    return out;
};
