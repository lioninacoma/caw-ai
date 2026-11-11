// Themes als Pakete: ein Ordner mit theme.json (themeApi 1, siehe themes/theme.schema.json), optional theme.css und fonts/.
// Eingebaut: caw-ai/themes/<name>/. Eigene: <prefsDir>/themes/<name>/, sie nennen ein eingebautes als base und listen nur
// Abweichungen; Fehlendes oder Kaputtes kommt aus base.
//
// Welches gilt, das Letzte gewinnt: nacht, optionaler Team-Standard in caw.config.json ({ "theme": { "base", "colors" } }),
// prefs.json ("theme": "<name>").
//
// Gespeichert werden kann auch aus der Werkbank. Darum prueft saveTheme das ganze Objekt gegen das Schema, ohne css und ohne
// fonts.file: theme.css und Schriften kommen nur von der Platte. Farben setzen die Seiten nur als CSS-Variablen.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { language } from './i18n.mjs';
import { prefsDir, readPrefs } from './prefs.mjs';

const TOOL_THEMES = new URL('../../themes/', import.meta.url);
const SCHEMA = JSON.parse(readFileSync(new URL('theme.schema.json', TOOL_THEMES), 'utf8'));

/** Die Grundfarben in der Reihenfolge des Theme-Dialogs. */
export const THEME_KEYS = ['screen', 'pane', 'frame', 'text', 'muted', 'accent', 'ok', 'warn', 'fail', 'info', 'claude', 'human', 'heart'];
export const BUILTIN_THEMES = ['nacht', 'bernstein', 'phosphor'];
export const DEFAULT_THEME = 'nacht';
export const THEME_NAME = /^[a-z0-9-]{1,32}$/;
export const HEX = /^#[0-9a-f]{6}$/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Ein kleiner Pruefer fuer genau die Teile von JSON Schema, die theme.schema.json nutzt.
const check = (schema, value, path, problems) => {
    if (schema.$ref !== undefined) return check(schema.$ref.split('/').slice(1).reduce((node, key) => node[key], SCHEMA), value, path, problems);
    if (schema.oneOf !== undefined) {
        const passing = schema.oneOf.filter((option) => check(option, value, path, []) === 0);
        if (passing.length !== 1) problems.push(`${path}: ${passing.length === 0 ? 'passt zu keiner Form' : 'mehrdeutig'}`);
        return problems.length;
    }
    const before = problems.length;
    const fail = (why) => problems.push(`${path}: ${why}`);
    if (schema.const !== undefined && value !== schema.const) fail(`muss ${JSON.stringify(schema.const)} sein`);
    if (schema.enum !== undefined && !schema.enum.includes(value)) fail(`erlaubt: ${schema.enum.join(', ')}`);
    const type = schema.type;
    if (type === 'object') {
        if (!isObject(value)) return fail('kein Objekt'), problems.length;
        for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`${key} fehlt`);
        for (const [key, entry] of Object.entries(value)) {
            if (schema.propertyNames?.pattern !== undefined && !new RegExp(schema.propertyNames.pattern).test(key)) fail(`Schluessel ${key} ungueltig`);
            const own = schema.properties?.[key];
            if (own !== undefined) check(own, entry, `${path}.${key}`, problems);
            else if (schema.additionalProperties === false) fail(`unbekannt: ${key}`);
            else if (isObject(schema.additionalProperties)) check(schema.additionalProperties, entry, `${path}.${key}`, problems);
        }
    } else if (type === 'array') {
        if (!Array.isArray(value)) return fail('keine Liste'), problems.length;
        if (schema.minItems !== undefined && value.length < schema.minItems) fail(`mindestens ${schema.minItems}`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`hoechstens ${schema.maxItems}`);
        if (schema.items !== undefined) value.forEach((entry, index) => check(schema.items, entry, `${path}[${index}]`, problems));
    } else if (type === 'string') {
        if (typeof value !== 'string') return fail('kein Text'), problems.length;
        if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail(`hoechstens ${schema.maxLength} Zeichen`);
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) fail('Form passt nicht');
    } else if (type === 'number' || type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) return fail(type === 'integer' ? 'keine ganze Zahl' : 'keine Zahl'), problems.length;
        if (schema.minimum !== undefined && value < schema.minimum) fail(`mindestens ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) fail(`hoechstens ${schema.maximum}`);
    } else if (type === 'boolean' && typeof value !== 'boolean') fail('nicht true oder false');
    return problems.length - before;
};

/**
 * Was an einem Paket falsch ist, als Liste lesbarer Zeilen; leer, wenn es passt.
 * @param fromPage  aus der Werkbank: dann weder css noch fonts.file, und base ist Pflicht
 */
export const validateTheme = (pkg, { fromPage = false } = {}) => {
    const problems = [];
    check(SCHEMA, pkg, 'theme', problems);
    if (fromPage && isObject(pkg)) {
        if (pkg.css !== undefined) problems.push('theme.css: nur als Datei im Paket');
        const fonts = Object.values(isObject(pkg.fonts) ? pkg.fonts : {}).flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
        if (fonts.some((font) => isObject(font) && font.file !== undefined)) problems.push('theme.fonts: Schriftdateien nur im Paket');
        if (pkg.base === undefined) problems.push('theme.base fehlt');
    }
    return problems;
};

/** Der Team-Standard in caw.config.json: { base, colors }. Probleme als Liste { key }. */
export const projectThemeProblems = (value) => {
    if (!isObject(value)) return [{ key: 'theme' }];
    return Object.entries(value).flatMap(([key, entry]) => {
        if (key === 'base') return BUILTIN_THEMES.includes(entry) ? [] : [{ key }];
        if (key !== 'colors') return [{ key }];
        if (!isObject(entry)) return [{ key }];
        return Object.entries(entry).filter(([name, hex]) => !THEME_KEYS.includes(name) || typeof hex !== 'string' || !HEX.test(hex)).map(([name]) => ({ key: `colors.${name}` }));
    });
};

const merge = (base, own) => {
    if (!isObject(base) || !isObject(own)) return own === undefined ? base : own;
    const out = { ...base };
    for (const [key, value] of Object.entries(own)) out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
    return out;
};

// Ein Text oder einer je Sprache.
const local = (value) => (isObject(value) ? value[language()] ?? value.en ?? Object.values(value)[0] : value);
const LOCAL = { marks: ['ok', 'warn', 'fail', 'run', 'open', 'ask'], bullets: ['ok', 'warn', 'fail', 'run', 'info', 'pause'], prompt: ['claude', 'human'] };

const readJson = (path) => {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
};

const ownDir = (env) => join(prefsDir(env), 'themes');
const builtin = (name) => readJson(new URL(`${name}/theme.json`, TOOL_THEMES));

/** Das gespeicherte Paket eines Namens, eingebaut oder eigen; kaputt oder fremd ergibt undefined. */
export const readThemePackage = (name, env = process.env) => {
    if (!THEME_NAME.test(String(name))) return undefined;
    if (BUILTIN_THEMES.includes(name)) return builtin(name);
    const pkg = readJson(join(ownDir(env), name, 'theme.json'));
    return pkg !== undefined && pkg.name === name && BUILTIN_THEMES.includes(pkg.base) && validateTheme(pkg).length === 0 ? pkg : undefined;
};

/** Die Dateien eines Pakets: der Ordner, aus dem theme.css und fonts/ kommen. */
export const themeDir = (name, env = process.env) => (BUILTIN_THEMES.includes(name) ? new URL(`${name}/`, TOOL_THEMES) : join(ownDir(env), name));

const readCss = (name, file, env) => {
    if (typeof file !== 'string' || !/^[A-Za-z0-9._-]+\.css$/.test(file)) return '';
    const dir = themeDir(name, env);
    try {
        return readFileSync(typeof dir === 'string' ? join(dir, file) : new URL(file, dir), 'utf8');
    } catch {
        return '';
    }
};

/**
 * Ein Paket aufgeloest: base darunter, Texte in der aktuellen Sprache, theme.css gelesen.
 * @param extra  zuletzt darueber, etwa die Farben des Team-Standards
 */
export const resolvePackage = (pkg, { env = process.env, extra } = {}) => {
    const base = BUILTIN_THEMES.includes(pkg?.base) ? builtin(pkg.base) : builtin(DEFAULT_THEME);
    const merged = merge(BUILTIN_THEMES.includes(pkg?.name) && pkg.base === undefined ? pkg : merge(base, pkg ?? {}), extra ?? {});
    const theme = { ...merged, builtin: BUILTIN_THEMES.includes(merged.name), base: merged.base ?? merged.name };
    theme.label = local(merged.label) ?? merged.name;
    theme.description = local(merged.description) ?? '';
    for (const [group, keys] of Object.entries(LOCAL)) theme[group] = { ...merged[group], ...Object.fromEntries(keys.map((key) => [key, local(merged[group]?.[key])])) };
    theme.mono = merged.mono === true;
    theme.css = readCss(merged.name, pkg?.css, env);
    theme.pkg = pkg;
    return theme;
};

/** Ein Theme nach Namen, aufgeloest; undefined, wenn es keines gibt. */
export const loadTheme = (name, env = process.env) => {
    const pkg = readThemePackage(name, env);
    return pkg === undefined ? undefined : resolvePackage(pkg, { env });
};

// Der Team-Standard aus caw.config.json, gesetzt beim Laden der Config.
let project;
export const setProjectTheme = (value) => {
    project = value;
};

/** Das Theme, das gerade gilt: nacht, dann Team-Standard, dann die eigene Wahl aus prefs.json. */
export const activeTheme = (env = process.env) => {
    const chosen = readPrefs(env).theme;
    const own = chosen === undefined ? undefined : readThemePackage(chosen, env);
    if (own !== undefined) return resolvePackage(own, { env });
    if (isObject(project) && projectThemeProblems(project).length === 0) {
        const base = builtin(project.base ?? DEFAULT_THEME);
        return resolvePackage(base, { env, extra: project.colors === undefined ? undefined : { colors: project.colors } });
    }
    return resolvePackage(builtin(DEFAULT_THEME), { env });
};

/** Alle Themes: erst die eingebauten, dann die eigenen, die sich lesen lassen. */
export const listThemes = (env = process.env) => {
    let own = [];
    try {
        own = readdirSync(ownDir(env)).filter((name) => !BUILTIN_THEMES.includes(name) && readThemePackage(name, env) !== undefined).sort();
    } catch {
        // Kein Ordner: keine eigenen Themes.
    }
    return [...BUILTIN_THEMES, ...own].map((name) => {
        const pkg = readThemePackage(name, env);
        return { name, builtin: BUILTIN_THEMES.includes(name), base: pkg.base ?? name, label: local(pkg.label) ?? name };
    });
};

const writeJson = (path, value) => {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
};

/** Speichert ein eigenes Theme, etwa aus der Werkbank. Prueft wie fuer die Seite; eingebaute Namen sind vergeben. */
export const saveTheme = (pkg, env = process.env) => {
    const problems = validateTheme(pkg, { fromPage: true });
    if (problems.length > 0) throw new Error(`Theme ungueltig: ${problems.slice(0, 5).join('; ')}`);
    if (BUILTIN_THEMES.includes(pkg.name)) throw new Error(`${pkg.name} ist eingebaut`);
    const dir = join(ownDir(env), pkg.name);
    mkdirSync(dir, { recursive: true });
    // Ein vorhandenes css aus dem Paket bleibt: Die Seite darf es weder setzen noch loeschen.
    const before = readJson(join(dir, 'theme.json'));
    const keep = isObject(before) && typeof before.css === 'string' ? { css: before.css } : {};
    const fonts = isObject(before?.fonts) ? { fonts: before.fonts } : {};
    writeJson(join(dir, 'theme.json'), { ...pkg, ...fonts, ...keep });
};

/** Loescht ein eigenes Theme samt Ordner. Eingebaute lassen sich nicht loeschen. */
export const deleteTheme = (name, env = process.env) => {
    if (!THEME_NAME.test(String(name)) || BUILTIN_THEMES.includes(name)) throw new Error(`${name} laesst sich nicht loeschen`);
    rmSync(join(ownDir(env), name), { recursive: true, force: true });
};

/** Benennt ein eigenes Theme um: Ordner und name im Paket. */
export const renameTheme = (from, to, env = process.env) => {
    if (!THEME_NAME.test(String(from)) || BUILTIN_THEMES.includes(from)) throw new Error(`${from} laesst sich nicht umbenennen`);
    if (!THEME_NAME.test(String(to)) || BUILTIN_THEMES.includes(to) || existsSync(join(ownDir(env), to))) throw new Error(`${to} ist vergeben oder ungueltig`);
    const pkg = readJson(join(ownDir(env), from, 'theme.json'));
    if (!isObject(pkg)) throw new Error(`${from} gibt es nicht`);
    renameSync(join(ownDir(env), from), join(ownDir(env), to));
    writeJson(join(ownDir(env), to, 'theme.json'), { ...pkg, name: to });
};

/** Kontrast nach WCAG zwischen zwei #rrggbb. */
export const contrast = (one, two) => {
    const lum = (hex) => {
        const [r, g, b] = hex.slice(1).match(/../g).map((part) => {
            const c = parseInt(part, 16) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(one), lum(two)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
};

/** Hinweise zu einem aufgeloesten Theme, die nichts sperren: Marken unterschiedlich breit, Kontrast unter 4,5:1. */
export const themeWarnings = (theme) => {
    const warnings = [];
    const widths = new Set(Object.values(theme.marks ?? {}).map((mark) => [...String(mark).replace('{spinner}', theme.spinner?.frames?.[0] ?? ' ')].length));
    if (widths.size > 1) warnings.push({ kind: 'width', text: 'marks' });
    for (const ground of ['screen', 'pane']) {
        const ratio = contrast(theme.colors.text, theme.colors[ground]);
        if (ratio < 4.5) warnings.push({ kind: 'contrast', text: `text/${ground}`, ratio: Math.round(ratio * 10) / 10 });
    }
    return warnings;
};

/** Fehlen Schriftdateien eines Pakets? Liste der fehlenden. */
export const missingFonts = (theme, env = process.env) => {
    const fonts = Object.values(theme.fonts ?? {}).flatMap((entry) => (Array.isArray(entry) ? entry : [entry])).filter((font) => typeof font?.file === 'string');
    return fonts.map((font) => font.file).filter((file) => {
        if (file.startsWith('builtin:')) return !existsSync(new URL(`../../assets/fonts/${file.slice(8)}`, import.meta.url));
        const dir = themeDir(theme.name, env);
        return !existsSync(typeof dir === 'string' ? join(dir, file) : new URL(file, dir));
    });
};
