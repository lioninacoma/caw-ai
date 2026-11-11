// Themes as packages: a folder with theme.json (themeApi 1, see themes/theme.schema.json), optionally theme.css and fonts/.
// Built-in: caw-ai/themes/<name>/. Custom: <prefsDir>/themes/<name>/; they name a built-in theme as base and list only the
// differences; anything missing or broken comes from base.
//
// Which one applies, last wins: nacht, optional team default in caw.config.json ({ "theme": { "base", "colors" } }),
// prefs.json ("theme": "<name>").
//
// The workbench can save themes too. So saveTheme checks the whole object against the schema, without css and without
// fonts.file: theme.css and fonts only come from disk. Pages set colours only as CSS variables.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { language, t } from './i18n.mjs';
import { prefsDir, readPrefs } from './prefs.mjs';

const TOOL_THEMES = new URL('../../themes/', import.meta.url);
const SCHEMA = JSON.parse(readFileSync(new URL('theme.schema.json', TOOL_THEMES), 'utf8'));

/** The base colours in the order of the theme dialog. */
export const THEME_KEYS = ['screen', 'pane', 'frame', 'text', 'muted', 'accent', 'ok', 'warn', 'fail', 'info', 'claude', 'human', 'heart'];
export const BUILTIN_THEMES = ['nacht', 'bernstein', 'phosphor'];
export const DEFAULT_THEME = 'nacht';
export const THEME_NAME = /^[a-z0-9-]{1,32}$/;
export const HEX = /^#[0-9a-f]{6}$/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A small validator for exactly the parts of JSON Schema that theme.schema.json uses.
const check = (schema, value, path, problems) => {
    if (schema.$ref !== undefined) return check(schema.$ref.split('/').slice(1).reduce((node, key) => node[key], SCHEMA), value, path, problems);
    if (schema.oneOf !== undefined) {
        const passing = schema.oneOf.filter((option) => check(option, value, path, []) === 0);
        if (passing.length !== 1) problems.push(`${path}: ${t(passing.length === 0 ? 'config.theme.schema.noShape' : 'config.theme.schema.ambiguous')}`);
        return problems.length;
    }
    const before = problems.length;
    const fail = (why) => problems.push(`${path}: ${why}`);
    if (schema.const !== undefined && value !== schema.const) fail(t('config.theme.schema.const', { value: JSON.stringify(schema.const) }));
    if (schema.enum !== undefined && !schema.enum.includes(value)) fail(t('config.theme.schema.enum', { values: schema.enum.join(', ') }));
    const type = schema.type;
    if (type === 'object') {
        if (!isObject(value)) return fail(t('config.theme.schema.notObject')), problems.length;
        for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(t('config.theme.schema.required', { key }));
        for (const [key, entry] of Object.entries(value)) {
            if (schema.propertyNames?.pattern !== undefined && !new RegExp(schema.propertyNames.pattern).test(key)) fail(t('config.theme.schema.badKey', { key }));
            const own = schema.properties?.[key];
            if (own !== undefined) check(own, entry, `${path}.${key}`, problems);
            else if (schema.additionalProperties === false) fail(t('config.theme.schema.unknown', { key }));
            else if (isObject(schema.additionalProperties)) check(schema.additionalProperties, entry, `${path}.${key}`, problems);
        }
    } else if (type === 'array') {
        if (!Array.isArray(value)) return fail(t('config.theme.schema.notList')), problems.length;
        if (schema.minItems !== undefined && value.length < schema.minItems) fail(t('config.theme.schema.atLeast', { n: schema.minItems }));
        if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(t('config.theme.schema.atMost', { n: schema.maxItems }));
        if (schema.items !== undefined) value.forEach((entry, index) => check(schema.items, entry, `${path}[${index}]`, problems));
    } else if (type === 'string') {
        if (typeof value !== 'string') return fail(t('config.theme.schema.notText')), problems.length;
        if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail(t('config.theme.schema.maxLength', { n: schema.maxLength }));
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) fail(t('config.theme.schema.pattern'));
    } else if (type === 'number' || type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) return fail(t(type === 'integer' ? 'config.theme.schema.notInteger' : 'config.theme.schema.notNumber')), problems.length;
        if (schema.minimum !== undefined && value < schema.minimum) fail(t('config.theme.schema.atLeast', { n: schema.minimum }));
        if (schema.maximum !== undefined && value > schema.maximum) fail(t('config.theme.schema.atMost', { n: schema.maximum }));
    } else if (type === 'boolean' && typeof value !== 'boolean') fail(t('config.theme.schema.notBoolean'));
    return problems.length - before;
};

/**
 * What is wrong with a package, as a list of readable lines; empty if it is fine.
 * @param fromPage  from the workbench: then neither css nor fonts.file, and base is required
 */
export const validateTheme = (pkg, { fromPage = false } = {}) => {
    const problems = [];
    check(SCHEMA, pkg, 'theme', problems);
    if (fromPage && isObject(pkg)) {
        if (pkg.css !== undefined) problems.push(t('config.theme.cssOnlyInPackage'));
        const fonts = Object.values(isObject(pkg.fonts) ? pkg.fonts : {}).flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
        if (fonts.some((font) => isObject(font) && font.file !== undefined)) problems.push(t('config.theme.fontFilesOnlyInPackage'));
        if (pkg.base === undefined) problems.push(t('config.theme.baseMissing'));
    }
    return problems;
};

/** The team default in caw.config.json: { base, colors }. Problems as a list of { key }. */
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

// A text, or one per language.
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

/** The stored package for a name, built-in or custom; broken or foreign yields undefined. */
export const readThemePackage = (name, env = process.env) => {
    if (!THEME_NAME.test(String(name))) return undefined;
    if (BUILTIN_THEMES.includes(name)) return builtin(name);
    const pkg = readJson(join(ownDir(env), name, 'theme.json'));
    return pkg !== undefined && pkg.name === name && BUILTIN_THEMES.includes(pkg.base) && validateTheme(pkg).length === 0 ? pkg : undefined;
};

/** A package's files: the folder theme.css and fonts/ come from. */
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
 * A resolved package: base underneath, texts in the current language, theme.css read.
 * @param extra  merged on top last, e.g. the team default's colours
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

/** A theme by name, resolved; undefined if there is none. */
export const loadTheme = (name, env = process.env) => {
    const pkg = readThemePackage(name, env);
    return pkg === undefined ? undefined : resolvePackage(pkg, { env });
};

// The team default from caw.config.json, set when the config is loaded.
let project;
export const setProjectTheme = (value) => {
    project = value;
};

/** The theme in effect: nacht, then team default, then the own choice from prefs.json. */
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

/** All themes: built-in first, then the readable custom ones. */
export const listThemes = (env = process.env) => {
    let own = [];
    try {
        own = readdirSync(ownDir(env)).filter((name) => !BUILTIN_THEMES.includes(name) && readThemePackage(name, env) !== undefined).sort();
    } catch {
        // No folder: no custom themes.
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

/** Saves a custom theme, e.g. from the workbench. Validates as for the page; built-in names are taken. */
export const saveTheme = (pkg, env = process.env) => {
    const problems = validateTheme(pkg, { fromPage: true });
    if (problems.length > 0) throw new Error(`Invalid theme: ${problems.slice(0, 5).join('; ')}`);
    if (BUILTIN_THEMES.includes(pkg.name)) throw new Error(`${pkg.name} is built in`);
    const dir = join(ownDir(env), pkg.name);
    mkdirSync(dir, { recursive: true });
    // An existing css in the package is kept: the page may neither set nor delete it.
    const before = readJson(join(dir, 'theme.json'));
    const keep = isObject(before) && typeof before.css === 'string' ? { css: before.css } : {};
    const fonts = isObject(before?.fonts) ? { fonts: before.fonts } : {};
    writeJson(join(dir, 'theme.json'), { ...pkg, ...fonts, ...keep });
};

/** Deletes a custom theme and its folder. Built-in themes cannot be deleted. */
export const deleteTheme = (name, env = process.env) => {
    if (!THEME_NAME.test(String(name)) || BUILTIN_THEMES.includes(name)) throw new Error(`${name} cannot be deleted`);
    rmSync(join(ownDir(env), name), { recursive: true, force: true });
};

/** Renames a custom theme: folder and name in the package. */
export const renameTheme = (from, to, env = process.env) => {
    if (!THEME_NAME.test(String(from)) || BUILTIN_THEMES.includes(from)) throw new Error(`${from} cannot be renamed`);
    if (!THEME_NAME.test(String(to)) || BUILTIN_THEMES.includes(to) || existsSync(join(ownDir(env), to))) throw new Error(`${to} is taken or invalid`);
    const pkg = readJson(join(ownDir(env), from, 'theme.json'));
    if (!isObject(pkg)) throw new Error(`${from} does not exist`);
    renameSync(join(ownDir(env), from), join(ownDir(env), to));
    writeJson(join(ownDir(env), to, 'theme.json'), { ...pkg, name: to });
};

/** WCAG contrast between two #rrggbb colours. */
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

/** Non-blocking hints for a resolved theme: marks of different widths, contrast below 4.5:1. */
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

/** A package's missing font files. */
export const missingFonts = (theme, env = process.env) => {
    const fonts = Object.values(theme.fonts ?? {}).flatMap((entry) => (Array.isArray(entry) ? entry : [entry])).filter((font) => typeof font?.file === 'string');
    return fonts.map((font) => font.file).filter((file) => {
        if (file.startsWith('builtin:')) return !existsSync(new URL(`../../assets/fonts/${file.slice(8)}`, import.meta.url));
        const dir = themeDir(theme.name, env);
        return !existsSync(typeof dir === 'string' ? join(dir, file) : new URL(file, dir));
    });
};
