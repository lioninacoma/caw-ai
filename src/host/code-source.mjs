// Which code runs, in one line for terminal, CI log and validate. The decision is made in checkTest (test-file.mjs); this file
// only phrases it. Whether the source is ready is checked by the overlay before the browser starts (overlay.mjs).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isLoopback } from '../shared/config.mjs';
import { language, t } from '../shared/i18n.mjs';

// Folders that are not sources: dependencies, builds and caches of common tools. Dot folders (.git, .angular, .next,
// .svelte-kit) are skipped anyway.
const NOT_SOURCES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'bower_components']);
// Files whose change needs no new build: docs and the caw-ai config.
const NOT_CODE = /(\.md|^caw\.config\.json)$/i;
const normalized = (path) => join(path).replace(/[\\/]+$/, '');
/** Enough to walk a typical app folder, cheap enough for every run. */
export const MAX_FILES = 5000;

/** The newest file below a folder, excluding the skipped folders. @returns { path, mtimeMs } or null */
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
                // file vanished during the walk: ignore it
            }
        }
    }
    return newest;
};

/** "3 min ago", "2 h ago", "2 days ago": rough enough for one line. */
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

/** One overlay source in words, e.g. "build dist, built 14:02, 3 min ago" or "dev server http://localhost:5173". */
const describeChoice = (config, name, choice, { root, now }) => {
    const severalApps = Object.keys(config.apps ?? {}).length > 1;
    const statics = (choice.statics ?? []).length;
    let text;
    if (choice.kind === 'build') {
        const dir = slash(choice.dir);
        const built = root === undefined ? null : newestFile(join(root, choice.dir), { skipNames: new Set(['node_modules']) });
        text = built === null ? t('cli.code.build', { dir }) : t('cli.code.built', { dir, time: clock(built.mtimeMs), ago: ago(now - built.mtimeMs) });
    } else if (choice.kind === 'dev') text = t('cli.code.dev', { url: choice.url });
    else if (choice.kind === 'watch') text = t('cli.code.watch', { url: choice.url });
    else text = t('cli.code.files', { count: statics });
    if (choice.kind !== 'files' && statics > 0) text = t('cli.code.withStatics', { text, count: statics });
    return severalApps ? t('cli.code.ofApp', { text, app: name }) : text;
};

/**
 * The "Code: …" line without its prefix. With `root`, a build folder line says when it was built; validate omits that.
 * @param checked result of checkTest: source, apps
 */
export const describeCode = (config, spec, checked, { root, now = Date.now() } = {}) => {
    if (checked.source !== 'overlay') {
        // A dev server on this machine is not a deployed state: it runs whatever is in the editor.
        const url = checked.url === undefined ? null : new URL(checked.url);
        return url !== null && url.protocol === 'http:' && isLoopback(url.hostname) ? t('cli.code.devServer', { host: url.host }) : t('cli.code.deployed');
    }
    const parts = Object.entries(checked.apps ?? {}).map(([name, choice]) => describeChoice(config, name, choice, { root, now }));
    return t('cli.code.overlay', { details: parts.join('; ') });
};
