// The human's personal settings across projects and runs (e.g. animations off, chat collapsed, theme).
// Location: CAW_AI_HOME, else %APPDATA%\caw-ai, $XDG_CONFIG_HOME/caw-ai or ~/.config/caw-ai. Never secrets.
// Custom themes live next to it in themes/<name>/ (src/shared/theme-package.mjs).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = 'prefs.json';
// Allowed values or a check per key. `theme`: name of a built-in or custom theme.
const KNOWN = {
    animations: ['on', 'off'], steps: ['open', 'closed'], chat: ['open', 'closed'], tokenNotice: ['on', 'off'],
    theme: (value) => typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value),
};
const allowed = (key, value) => (typeof KNOWN[key] === 'function' ? KNOWN[key](value) === true : KNOWN[key]?.includes(value) === true);

export const prefsDir = (env = process.env, platform = process.platform) => {
    if (env.CAW_AI_HOME) return env.CAW_AI_HOME;
    if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'caw-ai');
    return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'caw-ai');
};

/** Only known keys with allowed values; a broken or foreign file yields the defaults. */
export const readPrefs = (env = process.env) => {
    const path = join(prefsDir(env), FILE);
    if (!existsSync(path)) return {};
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        return Object.fromEntries(Object.keys(KNOWN).filter((key) => raw?.[key] !== undefined && allowed(key, raw[key])).map((key) => [key, raw[key]]));
    } catch {
        return {};
    }
};

/** Sets a known key, null removes it; unknown keys or values (e.g. from the page) are rejected. */
export const writePref = (key, value, env = process.env) => {
    if (value === null ? !Object.hasOwn(KNOWN, key) : !allowed(key, value)) throw new Error(`Unknown setting ${key}=${JSON.stringify(value)}`);
    const dir = prefsDir(env);
    mkdirSync(dir, { recursive: true });
    const next = { ...readPrefs(env), [key]: value };
    if (value === null) delete next[key];
    const path = join(dir, FILE);
    // One temp file per process, so two concurrent runs never leave a half-written file.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temp, path);
    return next;
};

// What the workbench page may set: only how it looks. The page shares its origin with the tested application, so whatever the
// page may set, the application (or code Claude runs there) may set too. tokenNotice (skip the token notice) is never among them.
export const PAGE_PREFS = ['animations', 'steps', 'chat', 'theme'];

/** writePref for a value from the workbench page: only cosmetic keys, everything else is rejected like an unknown key. */
export const writePagePref = (key, value, env = process.env) => {
    if (!PAGE_PREFS.includes(key)) throw new Error(`Setting ${key} cannot be changed from the page`);
    return writePref(key, value, env);
};
