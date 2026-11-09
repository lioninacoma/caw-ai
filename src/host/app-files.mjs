// Ein Sencha-Watch schreibt bootstrap.json in den App-Ordner und liefert es samt Quellen nur aus. Die
// Sandbox liest das Gleiche direkt aus dem read-only eingebundenen Projekt, ganz ohne Netz zum Watch.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';

/** Nur ein Platzhalter: devlink haengt Pfade an eine Basis-URL, gelesen wird von der Platte. */
export const APP_FILES_BASE = 'http://app-files.invalid/';
const BOOTSTRAP = 'bootstrap.json';

/** Ohne `new URL`: Die schluckt fuehrende ../, und Sencha-Pfade duerfen aus dem App-Ordner herausfuehren. */
const relativePath = (url) => url.slice(APP_FILES_BASE.length).split(/[?#]/)[0];

export const createFileTransport = (appDir) => ({
    get: async (url) => {
        const file = join(appDir, decodeURIComponent(relativePath(url)));
        if (!existsSync(file)) return { status: 404, text: async () => '' };
        return { status: 200, text: async () => readFileSync(file, 'utf8') };
    },
});

/**
 * Vor dem Lauf: Passt bootstrap.json zu den Dateien? Ob ein Watch laeuft, sieht die Sandbox nicht, aber
 * der haeufigste Schaden eines veralteten Stands faellt hier auf statt mitten im Test.
 */
export const checkAppFiles = (appDir) => {
    const hint = t('session.appFiles.hint');
    const file = join(appDir, BOOTSTRAP);
    if (!existsSync(file)) throw new CawError('watch-missing', t('session.appFiles.missing', { file, hint }));
    let bootstrap;
    try {
        bootstrap = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        throw new CawError('watch-missing', t('session.appFiles.unreadable', { file, hint }));
    }
    if (!Array.isArray(bootstrap.loadOrder) || bootstrap.loadOrder.length === 0) {
        throw new CawError('watch-missing', t('session.appFiles.empty', { file, hint }));
    }
    const missing = bootstrap.loadOrder.map((entry) => entry.path).filter((path) => !existsSync(join(appDir, path)));
    if (missing.length > 0) {
        throw new CawError('watch-stale', t('session.appFiles.stale', { bootstrap: BOOTSTRAP, app: basename(appDir), count: missing.length, examples: missing.slice(0, 3).join(', '), hint }));
    }
};
