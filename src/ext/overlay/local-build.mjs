// Local build folder (`overlay.build`): files of a normal, hashed build (Vite, Angular CLI, webpack) instead of the deployed ones.
// The browser requests only the entry files under deployed names, e.g. `assets/index-OLD.js` from the deployed index.html.
// They map to the local file with the same name except for the hash. Everything the local entry loads afterwards carries local
// names and exists in the folder as is.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix } from 'node:path';

const TYPES = {
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.css': 'text/css',
    '.map': 'application/json',
    '.json': 'application/json',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain',
};

export const contentTypeOf = (file) => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

// Which requests a build folder answers: what the browser loads as code, style, font or image. Data via fetch/XHR (e.g.
// `assets/config.json`, which the deployment replaces per environment) always comes from the server; only code may also come via
// fetch (workers, WebAssembly). Without a type (source maps for the host) only the name counts.
const BUILD_TYPES = new Set(['script', 'stylesheet', 'font', 'image', 'media']);
const FETCHED_CODE = /\.(m?js|wasm|css)$/;
export const servesBuild = (resourceType, name) => resourceType === undefined || BUILD_TYPES.has(resourceType)
    || ((resourceType === 'fetch' || resourceType === 'xhr' || resourceType === 'other') && FETCHED_CODE.test(name));

// Bundler hashes, one rule for all: `stem[-.]hash.ext`, the hash 6 to 64 characters of `[A-Za-z0-9_-]` (Vite, Rollup, esbuild:
// 8 characters Base64url like `D-7xQ_aZ`; webpack, Next: hex up to 20; digests up to 64). The length may change between builds
// (different bundler setting). A hash contains a digit or an uppercase letter (every fourth Vite hash has no digit); a word like
// `button` is none. A lowercase-only hash (rare) cannot be told from a word; it only counts when the local page loads the file
// (`loose`). More than one extension may follow the hash (`main.0a1b2c3d.chunk.js`).
const HASH = /^[A-Za-z0-9_-]{6,64}$/;
const hashLike = (text, loose) => HASH.test(text) && (loose || /[0-9A-Z]/.test(text));
const REST = /^(?:\.[A-Za-z0-9]+)+$/;

/** Every split of a name into stem, separator, hash and extension(s), plus the form without hash. */
const splits = (name, loose) => {
    const found = [];
    for (let at = 1; at < name.length; at += 1) {
        const sep = name[at];
        if (sep !== '-' && sep !== '.') continue;
        for (let end = name.indexOf('.', at + 1); end !== -1; end = name.indexOf('.', end + 1)) {
            const hash = name.slice(at + 1, end);
            const rest = name.slice(end);
            if (hashLike(hash, loose) && REST.test(rest)) found.push({ key: `${name.slice(0, at)}\0${sep}\0${rest}`, hash, plain: name.slice(0, at) + rest });
        }
    }
    return found;
};

/**
 * Same name except for the hash? Same stem, separator and extension with a different hash (see above), or one name is the form
 * without hash (`main.js` and `main-A1B2C3D4.js`: a fixed name on one side, a hashed one on the other).
 */
export const sameButHash = (a, b, { loose = false } = {}) => {
    if (a === b) return false;
    const left = splits(a, loose);
    const right = splits(b, loose);
    if (left.some(({ plain }) => plain === b) || right.some(({ plain }) => plain === a)) return true;
    return left.some((one) => right.some((two) => one.key === two.key && one.hash !== two.hash));
};

// File names per folder, text per file; valid while the mtime is unchanged (the watch build rewrites them).
const listings = new Map();
const texts = new Map();

const mtimeOf = (path) => {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return null;
    }
};

const filesIn = (dir) => {
    const mtimeMs = mtimeOf(dir);
    if (mtimeMs === null) return [];
    const cached = listings.get(dir);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.files;
    let files;
    try {
        files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
        files = [];
    }
    listings.set(dir, { mtimeMs, files });
    return files;
};

const textOf = (file) => {
    const mtimeMs = mtimeOf(file);
    if (mtimeMs === null) return '';
    const cached = texts.get(file);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.text;
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        text = '';
    }
    texts.set(file, { mtimeMs, text });
    return text;
};

/** The pages directly in the build folder (index.html, index.csr.html for Angular with SSR), as text. */
const pagesIn = (dir) => filesIn(dir).filter((file) => file.endsWith('.html')).map((file) => textOf(join(dir, file)));

/** The pages in the build folder with names, as byte strings (latin1) like the served page when rewriting. */
export const localPages = (dir) => filesIn(dir).filter((file) => file.endsWith('.html')).map((file) => ({ name: file, text: readFileSync(join(dir, file)).toString('latin1') }));

// A value in a tag: after a quote or `=`, up to a quote, `?`, `#`, whitespace, `>` or the end. It is indexed under every tail
// after a `/` (`/assets/index-x.js` under `assets/index-x.js` and `index-x.js`).
const TAG_VALUE = /["'=]([^"'=?#\s>]+)(?=["'?#\s>]|$)/g;
const tailsOf = (value) => value.split('/').map((_, at, parts) => parts.slice(at).join('/')).filter((tail) => tail !== '' && !tail.startsWith('/'));
// Per build folder: which tags of its pages name a file, by file name. Built once per state of the pages, not per request.
const tagIndex = new Map();
const tagsByName = (dir) => {
    const pages = pagesIn(dir);
    const cached = tagIndex.get(dir);
    if (cached !== undefined && cached.pages.length === pages.length && cached.pages.every((page, at) => page === pages[at])) return cached.byName;
    const byName = new Map();
    for (const tag of pages.flatMap((page) => page.match(/<(script|link)\b[^>]*>/gi) ?? [])) {
        for (const name of [...tag.matchAll(TAG_VALUE)].flatMap(([, value]) => tailsOf(value))) {
            const list = byName.get(name) ?? [];
            if (!list.includes(tag)) list.push(tag);
            byName.set(name, list);
        }
    }
    tagIndex.set(dir, { pages, byName });
    return byName;
};

/** The tags of the local pages that load a file (`<script src=…>`, `<link href=…>`). */
const tagsFor = (dir, file) => tagsByName(dir).get(file) ?? [];

/**
 * Does the local page load the file as an ES module (`type="module"`, `modulepreload`), as a classic script, or not at all?
 * @returns 'module' | 'classic' | null
 */
export const scriptKind = (dir, file) => {
    const tags = tagsFor(dir, file);
    if (tags.some((tag) => /type\s*=\s*["']?module\b|rel\s*=\s*["']?modulepreload\b/i.test(tag))) return 'module';
    if (tags.some((tag) => /^<script\b/i.test(tag))) return 'classic';
    return null;
};

// File names mentioned in a text (`"./chunk-AB12CD34.js"`, `assets/index-x.css`): just the name, without the path.
const NAMED = /[\w.-]+\.(?:m?js|css)\b/g;
const named = new Map();
const namesIn = (file) => {
    const text = textOf(file);
    const cached = named.get(file);
    if (cached !== undefined && cached.text === text) return cached.names;
    const names = new Set(text.match(NAMED) ?? []);
    named.set(file, { text, names });
    return names;
};

/**
 * The files in `at` reachable from the current local state: named by its pages, or by a script or stylesheet in `at` that is
 * reachable itself (entry -> lazy chunk -> chunk). An old build that only names itself is not included.
 */
const reachable = (dir, at, listing) => {
    const files = new Set(listing);
    const live = new Set([...files].filter((file) => tagsFor(dir, file).length > 0));
    const queue = [...live];
    while (queue.length > 0) {
        const file = queue.shift();
        if (!/\.(m?js|css)$/.test(file)) continue;
        for (const name of namesIn(join(at, file))) {
            if (files.has(name) && !live.has(name)) {
                live.add(name);
                queue.push(name);
            }
        }
    }
    return live;
};
// Reachable files per folder, while file list and pages stay the same: a new build writes new (hashed) names, so the list
// changes. Angular names every lazy chunk chunk-<HASH>.js, so each request for one has twins and asks here.
const lives = new Map();
const liveFiles = (dir, at) => {
    const listing = filesIn(at);
    const byName = tagsByName(dir);
    const key = `${dir}\0${at}`;
    const cached = lives.get(key);
    if (cached !== undefined && cached.listing === listing && cached.byName === byName) return cached.live;
    const live = reachable(dir, at, listing);
    lives.set(key, { listing, byName, live });
    return live;
};

/** The folder of a file in the build and its name; never `..`. */
const locate = (dir, name) => {
    if (typeof name !== 'string' || name === '' || name.split('/').some((part) => part === '..' || part === '.')) return null;
    const folder = posix.dirname(name);
    return { at: folder === '.' ? dir : join(dir, ...folder.split('/')), base: posix.basename(name) };
};

const resolveExact = (dir, name) => {
    const place = locate(dir, name);
    if (place === null) return null;
    const { at, base } = place;
    const files = filesIn(at);
    const exact = files.includes(base);
    const twins = files.filter((file) => sameButHash(base, file));
    const loaded = (file) => tagsFor(dir, file).length > 0;
    const hit = (file) => ({ file: join(at, file), contentType: contentTypeOf(file), ...(file === base ? {} : { alias: file }) });
    if (exact) {
        // A leftover old build may carry exactly the deployed name (the deployed state was once built locally). If the current local
        // state does not reach the file (neither its page nor a script loading it) but reaches exactly one twin, that twin wins. A lazy
        // chunk appears in no page, only in the entry: it stays itself even if another chunk is preloaded.
        if (twins.length === 0) return hit(base);
        const live = liveFiles(dir, at);
        if (live.has(base)) return hit(base);
        const current = twins.filter((file) => live.has(file));
        return hit(current.length === 1 ? current[0] : base);
    }
    if (twins.length === 1) return hit(twins[0]);
    // Several twins (Vite names every chunk from an `index.tsx` `index-…js`, a watch without cleanup leaves old builds behind):
    // the one the local page loads. A lowercase-only hash only counts this way.
    const candidates = (twins.length > 1 ? twins : files.filter((file) => sameButHash(base, file, { loose: true }))).filter(loaded);
    return candidates.length === 1 ? hit(candidates[0]) : null;
};

/**
 * The local file for a requested name, e.g. `assets/index-OLD.js`. If the app lives under a path (`/shop/assets/…`) but the build
 * does not (`dist/assets/…`), the name carries that path in front: then the shortest tail found in the folder wins.
 * @param dir  absolute path of the build folder
 * @param name path relative to the folder, with `/`
 * @returns { file, contentType, alias? } or null; `alias` is the local name when it differs from the requested one
 */
export const resolveLocalBuild = (dir, name) => {
    if (typeof name !== 'string') return null;
    const parts = name.split('/');
    for (let skip = 0; skip < parts.length && skip <= 3; skip += 1) {
        const found = resolveExact(dir, parts.slice(skip).join('/'));
        if (found !== null) return found;
    }
    return null;
};

// An ES module has import/export as statements: `import x from`, `import{`, `import"…"`, `export{`, `export default`, `export const`.
// `importScripts(…)`, `exports.x`, `import(…)` (also allowed in classic scripts) do not count.
const MODULE_SYNTAX = /(^|[;\n}])\s*(import\s*(?:[{*"'`]|[\w$]+\s*(?:,|from\b))|export\s*(?:[{*]|(?:default|const|let|var|function|class|async)\b))/;
// A default export only as a statement (`export default …`, `export{a as default}`), never anywhere in the text: a phrase like
// "Set as default" in a string would otherwise add `export { default }`, and the module would fail to load.
const DEFAULT_EXPORT = /(^|[;\n}])\s*export\s*(default\b|\{[^}]*\bas\s+default\s*[,}])/;

/**
 * What the browser gets under the deployed name of an ES module: just a re-export of the local module. Lazy chunks import the entry
 * under its local name (`./index-NEW.js`); if the deployed name got the content itself, the module would run twice, with two
 * instances of Vue or React. null for classic scripts, which get the content.
 * @param kind 'module' | 'classic' | null, how the local page loads the file (scriptKind); without that the syntax decides
 */
export const moduleAlias = (localName, source, kind = null) => {
    if (!/\.m?js$/.test(localName) || kind === 'classic') return null;
    if (kind !== 'module' && !MODULE_SYNTAX.test(source)) return null;
    const from = JSON.stringify(`./${localName}`);
    const withDefault = DEFAULT_EXPORT.test(source);
    return `import ${from};\nexport * from ${from};\n${withDefault ? `export { default } from ${from};\n` : ''}`;
};

/**
 * Does the folder hold a build that `resolveLocalBuild` can find? A page (index.html) or scripts directly in it or one level
 * deeper (Vite: `assets/`). Otherwise, if there is one, the subfolder with a page as a hint: Angular writes to `dist/<app>/browser`.
 * @returns { ok: true } | { ok: false, hint?: path relative to the folder }
 */
export const buildCheck = (dir) => {
    const entries = (path) => {
        try {
            return readdirSync(path, { withFileTypes: true });
        } catch {
            return null;
        }
    };
    const top = entries(dir);
    if (top === null) return { ok: false };
    const scripts = (list) => list.some((entry) => entry.isFile() && /\.m?js$/.test(entry.name));
    if (top.some((entry) => entry.isFile() && entry.name.endsWith('.html')) || scripts(top)) return { ok: true };
    if (top.some((entry) => entry.isDirectory() && scripts(entries(join(dir, entry.name)) ?? []))) return { ok: true };
    const queue = top.filter((entry) => entry.isDirectory()).map((entry) => ({ path: entry.name, depth: 1 }));
    while (queue.length > 0) {
        const { path, depth } = queue.shift();
        const list = entries(join(dir, path)) ?? [];
        if (list.some((entry) => entry.isFile() && entry.name === 'index.html')) return { ok: false, hint: path.split(/[\\/]/).join('/') };
        if (depth < 3) queue.push(...list.filter((entry) => entry.isDirectory() && entry.name !== 'node_modules').map((entry) => ({ path: join(path, entry.name), depth: depth + 1 })));
    }
    return { ok: false };
};

/** Is there a build in the folder? (for the matrix and `checkLocalBuild`) */
export const hasBuild = (dir) => buildCheck(dir).ok;

/**
 * The deployed HTML without Subresource Integrity: the local code has other bytes than the `integrity` hashes, so Chrome would refuse
 * every injected script and stylesheet. Only attributes on `<script>` and `<link>`; the rest stays as the server sends it.
 */
export const withoutIntegrity = (html) => html.replace(/(<(?:script|link)\b[^>]*?)\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
