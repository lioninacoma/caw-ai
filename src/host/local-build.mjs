// Lokaler Build-Ordner (`overlay.build`): Dateien eines normalen, gehashten Builds (Vite, Angular CLI, webpack) statt der deployten.
// Der Browser fordert nur die Einstiegsdateien unter deployten Namen an, etwa `assets/index-OLD.js` aus dem deployten index.html.
// Sie werden auf die lokale Datei mit gleichem Namen bis auf den Hash abgebildet. Alles, was der lokale Einstieg nachlaedt, traegt
// lokale Namen und liegt genau so im Ordner.

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

// Welche Requests ein Build-Ordner beantwortet: was der Browser als Code, Stil, Schrift oder Bild laedt. Daten per fetch/XHR (etwa
// `assets/config.json`, die das Deployment je Umgebung ersetzt) kommen immer vom Server; nur Code darf auch per fetch kommen (Worker,
// WebAssembly). Ohne Typ (Quellkarten fuer den Host) zaehlt nur der Name.
const BUILD_TYPES = new Set(['script', 'stylesheet', 'font', 'image', 'media']);
const FETCHED_CODE = /\.(m?js|wasm|css)$/;
export const servesBuild = (resourceType, name) => resourceType === undefined || BUILD_TYPES.has(resourceType)
    || ((resourceType === 'fetch' || resourceType === 'xhr' || resourceType === 'other') && FETCHED_CODE.test(name));

// Hashes der Bundler, eine Regel fuer alle: `stamm[-.]hash.endung`, der Hash 6 bis 64 Zeichen aus `[A-Za-z0-9_-]` (Vite, Rollup,
// esbuild: 8 Zeichen Base64url wie `D-7xQ_aZ`; webpack, Next: Hex bis 20; Digests bis 64). Die Laenge darf sich zwischen den Builds
// aendern (andere Bundler-Einstellung). Ein Hash enthaelt eine Ziffer oder einen Grossbuchstaben (jeder vierte Vite-Hash hat keine
// Ziffer); ein Wort wie `button` ist keiner. Ein Hash nur aus Kleinbuchstaben (selten) ist nicht von einem Wort zu unterscheiden; er
// zaehlt nur, wenn die lokale Seite die Datei laedt (`loose`). Nach dem Hash darf mehr als eine Endung stehen (`main.0a1b2c3d.chunk.js`).
const HASH = /^[A-Za-z0-9_-]{6,64}$/;
const hashLike = (text, loose) => HASH.test(text) && (loose || /[0-9A-Z]/.test(text));
const REST = /^(?:\.[A-Za-z0-9]+)+$/;

/** Jede Zerlegung eines Namens in Stamm, Trenner, Hash und Endung(en); dazu die Form ohne Hash. */
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
 * Gleicher Name bis auf den Hash? Gleicher Stamm, Trenner und Endung, ein anderer Hash (siehe oben), oder einer der Namen ist die Form
 * ohne Hash (`main.js` und `main-A1B2C3D4.js`: ein fester Name auf der einen, ein gehashter auf der anderen Seite).
 */
export const sameButHash = (a, b, { loose = false } = {}) => {
    if (a === b) return false;
    const left = splits(a, loose);
    const right = splits(b, loose);
    if (left.some(({ plain }) => plain === b) || right.some(({ plain }) => plain === a)) return true;
    return left.some((one) => right.some((two) => one.key === two.key && one.hash !== two.hash));
};

// Je Ordner die Dateinamen, je Datei der Text; gueltig, solange sich die mtime nicht aendert (der Watch-Build schreibt neu).
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
    let files = [];
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
    let text = '';
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        text = '';
    }
    texts.set(file, { mtimeMs, text });
    return text;
};

/** Die Seiten im Build-Ordner selbst (index.html, bei Angular mit SSR index.csr.html), als Text. */
const pagesIn = (dir) => filesIn(dir).filter((file) => file.endsWith('.html')).map((file) => textOf(join(dir, file)));

/** Die Seiten im Build-Ordner mit Namen, als Byte-String (latin1) wie die ausgelieferte Seite beim Umschreiben. */
export const localPages = (dir) => filesIn(dir).filter((file) => file.endsWith('.html')).map((file) => ({ name: file, text: readFileSync(join(dir, file)).toString('latin1') }));

// Ein Wert in einem Tag: nach Anfuehrungszeichen oder `=`, bis zu Anfuehrungszeichen, `?`, `#`, Leerraum, `>` oder Ende. Gefunden wird
// er unter jedem Rest hinter einem `/` (`/assets/index-x.js` unter `assets/index-x.js` und `index-x.js`).
const TAG_VALUE = /["'=]([^"'=?#\s>]+)(?=["'?#\s>]|$)/g;
const tailsOf = (value) => value.split('/').map((_, at, parts) => parts.slice(at).join('/')).filter((tail) => tail !== '' && !tail.startsWith('/'));
// Je Build-Ordner: welche Tags seiner Seiten eine Datei nennen, nach Dateiname. Einmal je Stand der Seiten gebaut, nicht je Request.
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

/** Die Tags der lokalen Seiten, die eine Datei laden (`<script src=…>`, `<link href=…>`). */
const tagsFor = (dir, file) => tagsByName(dir).get(file) ?? [];

/**
 * Laedt die lokale Seite die Datei als ES-Modul (`type="module"`, `modulepreload`), als klassisches Skript, oder nennt sie sie nicht?
 * @returns 'module' | 'classic' | null
 */
export const scriptKind = (dir, file) => {
    const tags = tagsFor(dir, file);
    if (tags.some((tag) => /type\s*=\s*["']?module\b|rel\s*=\s*["']?modulepreload\b/i.test(tag))) return 'module';
    if (tags.some((tag) => /^<script\b/i.test(tag))) return 'classic';
    return null;
};

// Dateinamen, die ein Text nennt (`"./chunk-AB12CD34.js"`, `assets/index-x.css`): nur der Name, ohne Pfad davor.
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
 * Die Dateien in `at`, die der aktuelle lokale Stand erreicht: von seinen Seiten genannt, oder von einem Skript bzw. Stylesheet in
 * `at`, das selbst erreicht wird (Einstieg -> lazy Chunk -> Chunk). Ein alter Build, der nur noch sich selbst nennt, gehoert nicht dazu.
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
// Je Ordner der erreichte Stand, solange Dateiliste und Seiten dieselben sind: Ein neuer Build schreibt neue Namen (Hash), die Liste
// aendert sich. Angular nennt jeden lazy Chunk chunk-<HASH>.js, jeder Request darauf hat Zwillinge und fragt hier.
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

/** Der Ordner einer Datei im Build und ihr Name; `..` nie. */
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
        // Ein liegengebliebener alter Build kann genau den deployten Namen tragen (einmal den deployten Stand lokal gebaut). Erreicht der
        // aktuelle lokale Stand die Datei nicht (weder seine Seite noch ein Skript, das sie laedt), wohl aber genau einen Zwilling, gilt
        // der. Ein lazy Chunk steht in keiner Seite, nur im Einstieg: Er bleibt er selbst, auch wenn ein anderer Chunk vorgeladen wird.
        if (twins.length === 0) return hit(base);
        const live = liveFiles(dir, at);
        if (live.has(base)) return hit(base);
        const current = twins.filter((file) => live.has(file));
        return hit(current.length === 1 ? current[0] : base);
    }
    if (twins.length === 1) return hit(twins[0]);
    // Mehrere Zwillinge (Vite nennt jeden Chunk aus einer `index.tsx` `index-…js`, ein Watch ohne Aufraeumen laesst alte Builds
    // liegen): der, den die lokale Seite laedt. Ein Hash ganz aus Kleinbuchstaben zaehlt nur so.
    const candidates = (twins.length > 1 ? twins : files.filter((file) => sameButHash(base, file, { loose: true }))).filter(loaded);
    return candidates.length === 1 ? hit(candidates[0]) : null;
};

/**
 * Die lokale Datei fuer einen angeforderten Namen, etwa `assets/index-OLD.js`. Liegt die App unter einem Pfad (`/shop/assets/…`),
 * der Build aber ohne ihn (`dist/assets/…`), traegt der Name den Pfad davor: Dann zaehlt der kuerzeste Rest, der im Ordner liegt.
 * @param dir  absoluter Pfad des Build-Ordners
 * @param name Pfad relativ zum Ordner, mit `/`
 * @returns { file, contentType, alias? } oder null; `alias` ist der lokale Name, wenn er vom angeforderten abweicht
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

// Ein ES-Modul hat import/export als Anweisung: `import x from`, `import{`, `import"…"`, `export{`, `export default`, `export const`.
// `importScripts(…)`, `exports.x`, `import(…)` (auch in klassischen Skripten erlaubt) zaehlen nicht.
const MODULE_SYNTAX = /(^|[;\n}])\s*(import\s*(?:[{*"'`]|[\w$]+\s*(?:,|from\b))|export\s*(?:[{*]|(?:default|const|let|var|function|class|async)\b))/;
// Ein Default-Export nur als Anweisung (`export default …`, `export{a as default}`), nie irgendwo im Text: Ein Satz wie „Set as
// default“ in einem String haengte sonst `export { default }` an, und das Modul liesse sich nicht laden.
const DEFAULT_EXPORT = /(^|[;\n}])\s*export\s*(default\b|\{[^}]*\bas\s+default\s*[,}])/;

/**
 * Was der Browser unter dem deployten Namen eines ES-Moduls bekommt: nur ein Verweis auf das lokale Modul. Lazy Chunks importieren den
 * Einstieg unter seinem lokalen Namen (`./index-NEW.js`); bekaeme der deployte Name den Inhalt selbst, liefe das Modul zweimal, mit
 * zwei Instanzen von Vue oder React. null fuer klassische Skripte, die bekommen den Inhalt.
 * @param kind 'module' | 'classic' | null, wie die lokale Seite die Datei laedt (scriptKind); ohne Auskunft entscheidet die Syntax
 */
export const moduleAlias = (localName, source, kind = null) => {
    if (!/\.m?js$/.test(localName) || kind === 'classic') return null;
    if (kind !== 'module' && !MODULE_SYNTAX.test(source)) return null;
    const from = JSON.stringify(`./${localName}`);
    const withDefault = DEFAULT_EXPORT.test(source);
    return `import ${from};\nexport * from ${from};\n${withDefault ? `export { default } from ${from};\n` : ''}`;
};

/**
 * Liegt im Ordner ein Build, den `resolveLocalBuild` auch findet? Eine Seite (index.html) oder Skripte direkt darin bzw. eine Ebene
 * tiefer (Vite: `assets/`). Sonst, falls es ihn gibt, der Unterordner mit einer Seite: Angular schreibt nach `dist/<app>/browser`.
 * @returns { ok: true } | { ok: false, hint?: Pfad relativ zum Ordner }
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

/** Liegt ein Build im Ordner? (fuer die Matrix und `checkLocalBuild`) */
export const hasBuild = (dir) => buildCheck(dir).ok;

/**
 * Das deployte HTML ohne Subresource Integrity: Der lokale Code hat andere Bytes als die Hashes in `integrity`, Chrome verweigerte jedes
 * eingespielte Skript und Stylesheet. Nur Attribute an `<script>` und `<link>`, sonst bleibt die Seite, wie der Server sie schickt.
 */
export const withoutIntegrity = (html) => html.replace(/(<(?:script|link)\b[^>]*?)\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
