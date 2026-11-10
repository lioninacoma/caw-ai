// Welcher Code laeuft, in einer Zeile fuer Terminal, CI-Log und validate, dazu die Warnung vor einem veralteten lokalen Build.
// Entschieden wird es in checkTest (test-file.mjs); hier steht nur, wie es sich liest.

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { localCodeOf } from '../shared/config.mjs';
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

/** Die Apps des Tests, deren lokaler Code eingespielt wird, mit Herkunft. */
const localSources = (config, spec) => [spec.app, ...(spec.also ?? [])]
    .map((name) => ({ name, local: localCodeOf(config, name) }))
    .filter(({ local }) => local !== null);

/**
 * Die Zeile "Code: …" ohne Praefix. Mit `root` nennt sie beim Build-Ordner, wann er gebaut wurde; validate laesst das weg.
 * @param checked Ergebnis von checkTest: source und sourceReason
 */
export const describeCode = (config, spec, checked, { root, now = Date.now() } = {}) => {
    if (checked.source !== 'watch') {
        return checked.sourceReason === undefined ? t('cli.code.deployed') : t('cli.code.deployedWhy', { reason: checked.sourceReason });
    }
    const parts = localSources(config, spec).map(({ name, local }) => {
        if (local.localBuild === undefined) return t('cli.code.entries', { kinds: local.kinds.join(', '), dir: slash(config.apps[name].dir) });
        const dir = slash(local.localBuild);
        if (root === undefined) return dir;
        const built = newestFile(join(root, local.localBuild), { skipNames: new Set(['node_modules']) });
        return built === null ? dir : t('cli.code.built', { dir, time: clock(built.mtimeMs), ago: ago(now - built.mtimeMs) });
    });
    const details = [...parts, ...(checked.sourceReason === undefined ? [] : [checked.sourceReason])];
    return root === undefined ? t('cli.code.localFrom', { details: details.join('; ') }) : t('cli.code.local', { details: details.join('; ') });
};

/**
 * Ist ein Build-Ordner aelter als die letzte Aenderung unter dem App-Ordner? Dann laeuft vermutlich kein Build-Watch, und der
 * Test prueft nicht, was gerade im Editor steht. Nur eine Warnung: Eine Aenderung an Doku oder Tests braucht keinen neuen Build.
 * @returns die Warnungen als Text, je App hoechstens eine
 */
export const staleBuildWarnings = (root, config, spec, checked, now = Date.now()) => {
    if (checked.source !== 'watch') return [];
    return localSources(config, spec).flatMap(({ name, local }) => {
        if (local.localBuild === undefined) return [];
        const buildDir = join(root, local.localBuild);
        const built = newestFile(buildDir, { skipNames: new Set(['node_modules']) });
        if (built === null) return [];
        const appDir = join(root, config.apps[name].dir);
        const changed = newestFile(appDir, { skip: [buildDir, join(root, 'caw')] });
        if (changed === null || changed.mtimeMs <= built.mtimeMs) return [];
        return [t('cli.code.stale', { dir: slash(local.localBuild), file: slash(relative(appDir, changed.path)), ago: ago(now - changed.mtimeMs) })];
    });
};
