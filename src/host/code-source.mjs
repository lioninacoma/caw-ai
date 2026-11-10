// Welcher Code laeuft, in einer Zeile fuer Terminal, CI-Log und validate. Entschieden wird es in checkTest (test-file.mjs); hier steht
// nur, wie es sich liest. Ob die Quelle bereit ist, prueft das Overlay vor dem Browser (overlay.mjs).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isLoopback } from '../shared/config.mjs';
import { language, t } from '../shared/i18n.mjs';

// Ordner, die keine Quellen sind: Abhaengigkeiten, Builds und Caches gaengiger Werkzeuge. Ordner mit Punkt (.git, .angular,
// .next, .svelte-kit) fallen ohnehin weg.
const NOT_SOURCES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'bower_components']);
// Dateien, deren Aenderung keinen neuen Build verlangt: Doku und die Config von caw-ai.
const NOT_CODE = /(\.md|^caw\.config\.json)$/i;
const normalized = (path) => join(path).replace(/[\\/]+$/, '');
/** Genug, um einen typischen App-Ordner abzulaufen, und billig genug fuer jeden Lauf. */
export const MAX_FILES = 5000;

/** Die juengste Datei unter einem Ordner, ohne die ausgenommenen Ordner. @returns { path, mtimeMs } oder null */
export const newestFile = (dir, { skip = [], skipNames = NOT_SOURCES, max = MAX_FILES } = {}) => {
    const skipped = new Set(skip.map(normalized));
    let newest = null;
    let seen = 0;
    const pending = [dir];
    while (pending.length > 0 && seen < max) {
        const current = pending.pop();
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (seen >= max) break;
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && !skipNames.has(entry.name) && !skipped.has(normalized(path))) pending.push(path);
                continue;
            }
            if (!entry.isFile() || NOT_CODE.test(entry.name)) continue;
            seen += 1;
            try {
                const { mtimeMs } = statSync(path);
                if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
            } catch {
                // Datei waehrend des Laufens verschwunden: zaehlt nicht
            }
        }
    }
    return newest;
};

/** "vor 3 min", "vor 2 h", "vor 2 Tagen": grob genug fuer eine Zeile. */
export const ago = (ms) => {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 1) return t('cli.code.agoNow');
    if (minutes < 120) return t('cli.code.agoMinutes', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t('cli.code.agoHours', { count: hours });
    return t('cli.code.agoDays', { count: Math.round(hours / 24) });
};

const clock = (ms) => new Date(ms).toLocaleTimeString(language() === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
const slash = (path) => path.replaceAll('\\', '/').replace(/\/+$/, '');

/** Eine Quelle des Overlays in Worten, etwa "Build dist, gebaut 14:02, vor 3 min" oder "Dev-Server http://localhost:5173". */
const describeChoice = (config, name, choice, { root, now }) => {
    const many = Object.keys(config.apps ?? {}).length > 1;
    const statics = (choice.statics ?? []).length;
    let text;
    if (choice.kind === 'build') {
        const dir = slash(choice.dir);
        const built = root === undefined ? null : newestFile(join(root, choice.dir), { skipNames: new Set(['node_modules']) });
        text = built === null ? t('cli.code.build', { dir }) : t('cli.code.built', { dir, time: clock(built.mtimeMs), ago: ago(now - built.mtimeMs) });
    } else if (choice.kind === 'dev') text = t('cli.code.dev', { url: choice.url });
    else if (choice.kind === 'watch') text = t('cli.code.watch', { dir: slash(config.apps[name].dir) });
    else text = t('cli.code.files', { count: statics });
    if (choice.kind !== 'files' && statics > 0) text = t('cli.code.withStatics', { text, count: statics });
    return many ? t('cli.code.ofApp', { text, app: name }) : text;
};

/**
 * Die Zeile "Code: …" ohne Praefix. Mit `root` nennt sie beim Build-Ordner, wann er gebaut wurde; validate laesst das weg.
 * @param checked Ergebnis von checkTest: source, apps
 */
export const describeCode = (config, spec, checked, { root, now = Date.now() } = {}) => {
    if (checked.source !== 'overlay') {
        // Ein Dev-Server auf dem eigenen Rechner ist kein ausgelieferter Stand: Dort laeuft, was im Editor steht.
        const url = checked.url === undefined ? null : new URL(checked.url);
        return url !== null && url.protocol === 'http:' && isLoopback(url.hostname) ? t('cli.code.devServer', { host: url.host }) : t('cli.code.deployed');
    }
    const parts = Object.entries(checked.apps ?? {}).map(([name, choice]) => describeChoice(config, name, choice, { root, now }));
    return t('cli.code.overlay', { details: parts.join('; ') });
};
