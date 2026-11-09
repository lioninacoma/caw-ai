// Persoenliche Einstellungen des Menschen, ueber Projekte und Laeufe hinweg (etwa: Animationen aus, Chat eingeklappt).
// Ort: CAW_AI_HOME, sonst %APPDATA%\caw-ai bzw. $XDG_CONFIG_HOME/caw-ai bzw. ~/.config/caw-ai. Nie Geheimnisse.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = 'prefs.json';
// Je Schluessel die erlaubten Werte oder eine Pruefung. `fed`: wie oft der Rabe gefuettert wurde, nur Kosmetik.
const KNOWN = { animations: ['on', 'off'], steps: ['open', 'closed'], chat: ['open', 'closed'], theme: ['light', 'dark'], tokenNotice: ['on', 'off'], fed: (value) => /^\d{1,6}$/.test(value) };
const allowed = (key, value) => (typeof KNOWN[key] === 'function' ? KNOWN[key](String(value)) : KNOWN[key]?.includes(value) === true);

export const prefsDir = (env = process.env, platform = process.platform) => {
    if (env.CAW_AI_HOME) return env.CAW_AI_HOME;
    if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'caw-ai');
    return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'caw-ai');
};

/** Nur bekannte Schluessel mit erlaubten Werten; eine kaputte oder fremde Datei ergibt die Vorgaben. */
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

/** Setzt einen bekannten Schluessel; unbekannte Schluessel oder Werte (etwa aus der Seite) werden abgelehnt. */
export const writePref = (key, value, env = process.env) => {
    if (!allowed(key, value)) throw new Error(`Unbekannte Einstellung ${key}=${value}`);
    const dir = prefsDir(env);
    mkdirSync(dir, { recursive: true });
    const next = { ...readPrefs(env), [key]: value };
    const path = join(dir, FILE);
    // Je Prozess eine eigene Zwischendatei: Zwei Laeufe gleichzeitig ueberschreiben sich nicht halb.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temp, path);
    return next;
};
