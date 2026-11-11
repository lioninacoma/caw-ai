import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { AUTH_DIR } from '../shared/config.mjs';
import { RUN_DIR } from '../shared/names.mjs';
import { SECRET_DIRS, isSecretPath } from './secrets.mjs';

export const templatePath = (name) => fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

/** Devcontainer files are JSONC: comments and trailing commas, but never inside strings. */
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

/** Only the image counts from the devcontainer config, so the sandbox has the same tools. */
export const projectImage = (base) => {
    if (typeof base.image !== 'string' || base.image === '') {
        throw new CawError('devcontainer-unsupported', t('session.sandbox.noImage'));
    }
    // As in sandboxImage: the image ends up in FROM {{image}}. A line break would otherwise inject lines into the Dockerfile.
    if (!/^[\w./:@-]+$/.test(base.image)) throw new CawError('devcontainer-unsupported', t('session.sandbox.badImage', { image: JSON.stringify(base.image) }));
    return base.image;
};

export const renderDockerfile = ({ image, user }) => readFileSync(templatePath('Dockerfile.tpl'), 'utf8')
    .replaceAll('{{image}}', image)
    .replaceAll('{{user}}', user);

/** The container only talks to the Anthropic API. Application and browser live on the host. */
export const CONTAINER_HOSTS = ['api.anthropic.com'];

// At the root: Claude configuration, worktrees, earlier runs and saved sessions (cookies of the test account).
const MASKED_DIRS = ['.claude', '.worktrees', RUN_DIR, AUTH_DIR];
// At any depth: Git data (folder, or file for submodules and worktrees); remotes may contain credentials.
const MASKED_ANYWHERE = new Set(['.git']);
// Not searched: large and without the project's own secrets.
const SKIPPED_DIRS = new Set(['node_modules', '.pnpm-store', '.turbo', RUN_DIR]);
// At any depth, whole folders: cloud and SSH credentials (secrets.mjs). Secret files: isSecretPath, the same list as for advice.
const MASKED_SECRET_DIRS = new Set(SECRET_DIRS);

/**
 * What the agent must not see despite read-only access: Git data, local Claude configuration, earlier runs, saved sessions,
 * all .env files (test accounts included), common key and credential files, .aws and .ssh folders. The host does the login.
 * Docker needs existing targets. Files are covered by an empty host file, because not every Docker way accepts /dev/null as a source.
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
            if (MASKED_ANYWHERE.has(entry.name) || (entry.isDirectory() && MASKED_SECRET_DIRS.has(entry.name.toLowerCase()))) {
                args.push(...hide(child, entry.isDirectory()));
                continue;
            }
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) walk(child);
            } else if ((entry.isFile() || entry.isSymbolicLink()) && isSecretPath(child)) {
                args.push(...hideFile(posix.join(containerRoot, child)));
            }
        }
    };
    walk('');
    return args;
};

/** `host*` is the source as Docker sees it, `container*` the target. Only this run's agent folder is writable. */
export const sandboxRunArgs = ({ hostRoot, containerRoot, image, masks, name, hostAgentDir, containerAgentDir, command, color = false, limits = {} }) => [
    'run', '--rm', '--init', '--name', name,
    // Only the firewall needs NET_ADMIN at start; the entrypoint drops all capabilities afterwards.
    '--cap-add=NET_ADMIN', '--cap-add=NET_RAW', '--security-opt=no-new-privileges',
    // The user's API key from the Claude Console, by name only: Docker takes the value from the environment, it never ends up
    // in the image, a file or caw-ai's output. Subscription logins are not passed into containers.
    '-e', 'ANTHROPIC_API_KEY',
    ...Object.entries(limits).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-e', `CAW_ALLOWED_HOSTS=${CONTAINER_HOSTS.join(' ')}`,
    '-e', `CAW_AGENT_DIR=${containerAgentDir}`,
    // The container has no terminal and cannot tell by itself whether colour is possible.
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

/** Rebuild only when the image or the tool changes. Line endings do not count: WSL and Windows share the image. */
export const toolFingerprint = (dir, parts, image) => {
    const hash = createHash('sha256').update(image);
    for (const file of parts.flatMap((part) => filesBelow(join(dir, part)))) {
        hash.update(file.slice(dir.length).replaceAll('\\', '/'));
        hash.update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
    }
    return hash.digest('hex').slice(0, 12);
};
