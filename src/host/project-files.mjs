// Projektkopien: Dateien, die ein Build unveraendert aus dem Projekt uebernimmt (Vite und CRA `public/`, Angular `src/assets`,
// CopyWebpackPlugin). Ein Deployment ersetzt sie oft je Umgebung, etwa `env.js` oder `config.js` mit Adressen und Schaltern. Aus dem
// lokalen Build kaemen sie mit den Werten fuer die Entwicklung, und der Test liefe gegen Staging mit lokaler Konfiguration.
// Erkannt wird das ohne Ordnernamen: Kompilierter Code gleicht nie Byte fuer Byte einer Quelldatei, eine Kopie schon.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Je Projektordner die Quelldateien nach Groesse. Kurz gueltig: Ein Lauf fragt je Request, das Projekt aendert sich in Sekunden kaum.
const FRESH_MS = 10_000;
const indexes = new Map();

/** Die Dateien des Projekts laut Git: versioniert oder neu, aber nicht ignoriert (`dist`, `deploy`, `node_modules` zaehlen nicht). */
const gitFiles = (dir) => {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return out.toString('utf8').split('\0').filter((path) => path !== '').map((path) => join(dir, path));
};

/** Ohne Git: der Ordner ohne `node_modules`, Punktordner und die Build-Ordner. */
const walkFiles = (dir, skip) => {
    const files = [];
    const queue = [dir];
    while (queue.length > 0) {
        const at = queue.shift();
        let entries = [];
        try {
            entries = readdirSync(at, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(at, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.') || skip.some((folder) => path === folder || path.startsWith(`${folder}${sep}`))) continue;
                queue.push(path);
            } else if (entry.isFile()) files.push(path);
        }
    }
    return files;
};

const indexOf = (projectDir, skip) => {
    const key = `${projectDir}\0${skip.join('\0')}`;
    const cached = indexes.get(key);
    if (cached !== undefined && Date.now() - cached.at < FRESH_MS) return cached.bySize;
    let files;
    try {
        files = gitFiles(projectDir);
    } catch {
        files = walkFiles(projectDir, skip);
    }
    // Was in einem Build-Ordner liegt, ist nie Quelle, auch wenn Git ihn nicht ignoriert.
    const inBuild = (file) => skip.some((folder) => !relative(folder, file).startsWith('..'));
    const bySize = new Map();
    for (const file of files) {
        if (inBuild(file)) continue;
        let size;
        try {
            size = statSync(file).size;
        } catch {
            continue;
        }
        const list = bySize.get(size) ?? [];
        list.push(file);
        bySize.set(size, list);
    }
    indexes.set(key, { at: Date.now(), bySize });
    return bySize;
};

/**
 * Ist `bytes` eine unveraenderte Kopie einer Quelldatei des Projekts?
 * @param projectDir der App-Ordner
 * @param bytes      Inhalt der Antwort aus dem lokalen Code
 * @param skip       absolute Pfade, die nie Quelle sind (der Build-Ordner selbst)
 */
export const isProjectCopy = (projectDir, bytes, { skip = [] } = {}) => {
    if (typeof projectDir !== 'string' || projectDir === '' || bytes.length === 0) return false;
    const candidates = indexOf(projectDir, skip.map((folder) => join(folder))).get(bytes.length) ?? [];
    return candidates.some((file) => {
        try {
            return readFileSync(file).equals(bytes);
        } catch {
            return false;
        }
    });
};

/** Wie isProjectCopy, fuer eine Datei: gelesen wird sie nur, wenn eine Quelldatei gleich gross ist. */
export const isProjectCopyFile = (projectDir, file, { skip = [] } = {}) => {
    if (typeof projectDir !== 'string' || projectDir === '') return false;
    let size;
    try {
        size = statSync(file).size;
    } catch {
        return false;
    }
    if (size === 0 || (indexOf(projectDir, skip.map((folder) => join(folder))).get(size) ?? []).length === 0) return false;
    try {
        return isProjectCopy(projectDir, readFileSync(file), { skip });
    } catch {
        return false;
    }
};
