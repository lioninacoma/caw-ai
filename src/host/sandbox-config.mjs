import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { AUTH_DIR } from '../shared/config.mjs';
import { RUN_DIR } from '../shared/names.mjs';

export const templatePath = (name) => fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

/** Devcontainer-Dateien sind JSONC: Kommentare und nachgestellte Kommata, aber nie innerhalb von Strings. */
export const parseJsonc = (text) => {
    const skipTrivia = (from) => {
        let i = from;
        for (;;) {
            if (/\s/.test(text[i] ?? '')) {
                i += 1;
            } else if (text[i] === '/' && text[i + 1] === '/') {
                while (i < text.length && text[i] !== '\n') i += 1;
            } else if (text[i] === '/' && text[i + 1] === '*') {
                i = text.indexOf('*/', i + 2) + 2;
            } else {
                return i;
            }
        }
    };
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const start = i;
            i += 1;
            while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            i += 1;
            out += text.slice(start, i);
        } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            i = skipTrivia(i);
        } else if (c === ',' && (text[skipTrivia(i + 1)] === '}' || text[skipTrivia(i + 1)] === ']')) {
            i += 1;
        } else {
            out += c;
            i += 1;
        }
    }
    return JSON.parse(out);
};

/** Aus der Devcontainer-Config zaehlt nur das Image, damit die Sandbox dieselben Werkzeuge hat. */
export const projectImage = (base) => {
    if (typeof base.image !== 'string' || base.image === '') {
        throw new CawError('devcontainer-unsupported', t('session.sandbox.noImage'));
    }
    return base.image;
};

export const renderDockerfile = ({ image, user }) => readFileSync(templatePath('Dockerfile.tpl'), 'utf8')
    .replaceAll('{{image}}', image)
    .replaceAll('{{user}}', user);

/** Der Container spricht nur mit der Anthropic-API. Anwendung und Browser liegen auf dem Host. */
export const CONTAINER_HOSTS = ['api.anthropic.com'];

// Am Wurzelordner: Claude-Konfiguration, Worktrees, fruehere Laeufe und gespeicherte Sitzungen (Cookies des Testkontos).
const MASKED_DIRS = ['.claude', '.worktrees', RUN_DIR, AUTH_DIR];
// In jeder Tiefe: Git-Daten (Ordner oder Datei bei Submodulen und Worktrees), dort koennen Zugangsdaten in Remotes stehen.
const MASKED_ANYWHERE = new Set(['.git']);
// Nicht durchsucht: gross und ohne eigene Geheimnisse des Projekts.
const SKIPPED_DIRS = new Set(['node_modules', '.pnpm-store', '.turbo', RUN_DIR]);
// Windows unterscheidet keine Gross- und Kleinschreibung: .ENV ist dieselbe Datei wie .env.
const isSecretFile = (name) => {
    const lower = name.toLowerCase();
    if (/^\.env(\..+)?$/.test(lower)) return lower !== '.env.example';
    return ['.npmrc', '.netrc', '.pgpass', '.git-credentials'].includes(lower) || /\.(pem|key|p12|pfx)$/.test(lower) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(lower);
};

/**
 * Was der Agent trotz Read-only nicht sehen soll: Git-Daten, lokale Claude-Konfiguration, fruehere Laeufe, gespeicherte Sitzungen,
 * alle .env-Dateien (auch die Testkonten) und uebliche Schluesseldateien. Die Anmeldung macht der Host. Docker braucht vorhandene
 * Ziele. Dateien verdeckt eine leere Datei vom Host, denn /dev/null als Quelle versteht nicht jeder Docker-Weg.
 */
export const maskArgs = (root, containerRoot, emptyFile) => {
    const hideFile = (target) => ['--mount', `type=bind,source=${emptyFile},target=${target},readonly`];
    const hide = (relative, isDirectory) => (isDirectory ? ['--tmpfs', posix.join(containerRoot, relative)] : hideFile(posix.join(containerRoot, relative)));
    const args = [];
    const masked = new Set();
    for (const name of MASKED_DIRS) {
        const path = join(root, name);
        if (!existsSync(path)) continue;
        masked.add(name);
        args.push(...hide(name, statSync(path).isDirectory()));
    }
    const walk = (relative) => {
        for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
            const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
            if (masked.has(child)) continue;
            if (MASKED_ANYWHERE.has(entry.name)) {
                args.push(...hide(child, entry.isDirectory()));
                continue;
            }
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) walk(child);
            } else if ((entry.isFile() || entry.isSymbolicLink()) && isSecretFile(entry.name)) {
                args.push(...hideFile(posix.join(containerRoot, child)));
            }
        }
    };
    walk('');
    return args;
};

/** `host*` ist die Quelle aus Sicht von Docker, `container*` das Ziel. Beschreibbar ist nur der Agent-Ordner dieses Laufs. */
export const sandboxRunArgs = ({ hostRoot, containerRoot, image, masks, name, hostAgentDir, containerAgentDir, command, color = false }) => [
    'run', '--rm', '--init', '--name', name,
    // NET_ADMIN braucht nur die Firewall beim Start; der Einstiegspunkt gibt danach alle Rechte ab.
    '--cap-add=NET_ADMIN', '--cap-add=NET_RAW', '--security-opt=no-new-privileges',
    '-e', 'CLAUDE_CODE_OAUTH_TOKEN',
    '-e', `CAW_ALLOWED_HOSTS=${CONTAINER_HOSTS.join(' ')}`,
    '-e', `CAW_AGENT_DIR=${containerAgentDir}`,
    // Der Container hat kein Terminal und kann selbst nicht sehen, ob Farbe moeglich ist.
    ...(color ? ['-e', 'CAW_COLOR=1'] : []),
    '--mount', `type=bind,source=${hostRoot},target=${containerRoot},readonly`,
    ...masks,
    '--mount', `type=bind,source=${hostAgentDir},target=${containerAgentDir}`,
    '--workdir', containerRoot,
    image,
    ...command,
];

const filesBelow = (path) => (statSync(path).isDirectory()
    ? readdirSync(path).sort().flatMap((name) => filesBelow(join(path, name)))
    : [path]);

/** Neu gebaut wird nur, wenn sich Image oder Tool aendern. Zeilenenden zaehlen nicht: WSL und Windows teilen sich das Image. */
export const toolFingerprint = (dir, parts, image) => {
    const hash = createHash('sha256').update(image);
    for (const file of parts.flatMap((part) => filesBelow(join(dir, part)))) {
        hash.update(file.slice(dir.length).replaceAll('\\', '/'));
        hash.update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
    }
    return hash.digest('hex').slice(0, 12);
};
