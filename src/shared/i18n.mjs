// UI language: German or English. Workbench, chat, CLI, error messages and report get their texts via t().
// Prompts to Claude stay in one language; Claude answers in the project's language.
//
// Order: CAW_LANG, then "language" in caw.config.json, then LC_ALL / LC_MESSAGES / LANG / LANGUAGE, then the system language
// (Intl), else English.
//
// Rule for modules: never call t() at module top level, because the language is not known yet at import time.
// Texts belong inside functions or are fetched when used.

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

/** The language from environment, config and system; root: project folder with caw.config.json, if known. */
export const detectLanguage = ({ root, env = process.env, system = () => Intl.DateTimeFormat().resolvedOptions().locale } = {}) => {
    const forced = pick(env.CAW_LANG);
    if (forced !== null) return forced;
    if (root !== undefined) {
        try {
            const configured = pick(JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8')).language);
            if (configured !== null) return configured;
        } catch {
            // Missing or broken config: loadConfig reports that itself later.
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

/** Sets the language; unknown values fall back to English. */
export const setLanguage = (value) => {
    current = pick(value) ?? FALLBACK;
    return current;
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
