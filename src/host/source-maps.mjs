// Translates the stack of a script error into source files via source maps: `main.3f9a.js:1:48211` becomes
// `src/app/orders.service.ts:42:7`. Works for any framework and bundler (Vite, webpack, Angular CLI, esbuild), since only the
// source map format (version 3) matters. Without a source map the line stays as it is; the tool never fails on that.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...B64].map((char, index) => [char, index]));
const MAX_MAP_BYTES = 30 * 1024 * 1024;
const FRAME = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/;

/** Decodes the Base64 VLQ of a segment, e.g. "AAgBC", into numbers. */
export const decodeVlq = (text) => {
    const values = [];
    let value = 0;
    let shift = 0;
    for (const char of text) {
        const digit = DIGIT.get(char);
        if (digit === undefined) throw new Error(`not a Base64 character: ${char}`);
        value += (digit & 31) << shift;
        if (digit & 32) {
            shift += 5;
        } else {
            values.push(value & 1 ? -(value >>> 1) : value >>> 1);
            value = 0;
            shift = 0;
        }
    }
    return values;
};

/**
 * The mappings of a source map: per generated line the segments [column, source, line, column], all 0-based.
 * Segments without a source (just a column) are dropped.
 */
export const parseMappings = (mappings) => {
    const lines = [];
    let source = 0;
    let line = 0;
    let column = 0;
    for (const text of mappings.split(';')) {
        const segments = [];
        let generated = 0;
        for (const part of text.split(',')) {
            if (part === '') continue;
            const [col, ...rest] = decodeVlq(part);
            generated += col;
            if (rest.length < 3) continue;
            source += rest[0];
            line += rest[1];
            column += rest[2];
            segments.push([generated, source, line, column]);
        }
        lines.push(segments);
    }
    return lines;
};

/** Prefixes `sourceRoot` to the source like browsers do: with exactly one / between, unless the source is absolute itself. */
export const withRoot = (root, source) => {
    if (typeof root !== 'string' || root === '' || /^[a-z][\w+.-]*:/i.test(source) || source.startsWith('/')) return source;
    return `${root.endsWith('/') ? root : `${root}/`}${source}`;
};

/**
 * Where a position in generated code comes from: the last segment of the line that does not start after the column.
 * @param line, column as in the stack, 1-based
 * @returns { source, line, column } 1-based, or null
 */
export const originalPosition = (map, lines, line, column) => {
    const segments = lines[line - 1] ?? [];
    let best = null;
    for (const segment of segments) {
        if (segment[0] > column - 1) break;
        best = segment;
    }
    if (best === null) return null;
    const source = map.sources?.[best[1]];
    if (typeof source !== 'string') return null;
    return { source: withRoot(map.sourceRoot, source), line: best[2] + 1, column: best[3] + 1 };
};

/**
 * The path of a source as a human would look for it in the project. Bundlers add prefixes: `webpack://name/./src/a.ts`,
 * `/@fs/C:/…`, `ng://`, or an absolute dev server URL.
 */
export const sourcePath = (source, mapUrl) => {
    const bundler = /^(webpack|ng|vite|rollup):\/\//.test(source);
    let path = source.replace(/^webpack:\/\/[^/]*\//, '').replace(/^(ng|vite|rollup):\/\/\/?/, '');
    // Only non-bundler addresses are relative to the source map: `../src/a.ts` next to `assets/index.js.map`.
    if (!bundler && (!/^[a-z]+:/i.test(path) || /^https?:/i.test(path))) {
        try {
            path = new URL(path, mapUrl).pathname;
        } catch {
            // keep it as it is
        }
    }
    // `file:///C:/…` (Turbopack) like `/@fs/C:/…` (Vite): an absolute path on the dev server's machine.
    return decodeURIComponent(path).replace(/^file:\/\//, '').replace(/^\/@fs\//, '').replace(/^\/+/, '').replace(/^(\.\/)+/, '').replace(/[?#].*$/, '');
};

const stripQuery = (url) => url.replace(/[?#].*$/, '');

/**
 * Loads source maps from the application and translates stacks. Maps load only from the script's own origin and only if `allowed`
 * permits: the page may point a source map anywhere, the host does not follow.
 * @param fetchText (url) => Promise<string|null>, e.g. via the browser's request context (same cookies, same TLS rules)
 * @param allowed   (url) => boolean, e.g. the host block
 * @param version   (url) => string, the state of a script (e.g. the mtime of the local file); a new state reloads the map
 */
export const createSourceMapper = ({ fetchText, allowed = () => true, version = () => '' }) => {
    const cache = new Map();
    const load = async (scriptUrl) => {
        const script = await fetchText(scriptUrl);
        if (typeof script !== 'string') return null;
        // The last comment wins; an inline map (Vite in dev mode) is often megabytes long, so search the whole file, not just its end.
        const at = script.lastIndexOf('sourceMappingURL=');
        const comment = at === -1 || !/[#@] $/.test(script.slice(at - 2, at)) ? undefined : script.slice(at + 'sourceMappingURL='.length).match(/^\S+/)?.[0];
        let text;
        let mapUrl;
        if (comment?.startsWith('data:')) {
            const comma = comment.indexOf(',');
            const data = comment.slice(comma + 1);
            text = /;base64/.test(comment.slice(0, comma)) ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
            mapUrl = scriptUrl;
        } else {
            mapUrl = new URL(comment ?? `${stripQuery(scriptUrl)}.map`, scriptUrl).href;
            if (new URL(mapUrl).origin !== new URL(scriptUrl).origin || !allowed(mapUrl)) return null;
            text = await fetchText(mapUrl);
        }
        if (typeof text !== 'string' || text.length > MAX_MAP_BYTES) return null;
        const map = JSON.parse(text);
        if (map.version !== 3) return null;
        // Index map (Turbopack, i.e. `next dev`): sections with offsets instead of one map for the whole file.
        if (Array.isArray(map.sections)) {
            const sections = map.sections
                .filter((section) => typeof section?.map?.mappings === 'string' && Number.isInteger(section.offset?.line) && Number.isInteger(section.offset?.column))
                .map((section) => ({ line: section.offset.line, column: section.offset.column, map: section.map, lines: parseMappings(section.map.mappings) }));
            return sections.length === 0 ? null : { sections, mapUrl };
        }
        if (typeof map.mappings !== 'string') return null;
        return { sections: [{ line: 0, column: 0, map, lines: parseMappings(map.mappings) }], mapUrl };
    };
    /** The position in the source; for an index map, in the last section starting before the position. */
    const positionIn = ({ sections }, line, column) => {
        const section = sections.filter((entry) => entry.line < line - 1 || (entry.line === line - 1 && entry.column <= column - 1)).at(-1);
        if (section === undefined) return null;
        const inner = line - section.line;
        return originalPosition(section.map, section.lines, inner, inner === 1 ? column - section.column : column);
    };
    // Per script and state: `version` changes when a watch rewrites the local file, which invalidates the previous map.
    const mapFor = (scriptUrl) => {
        const key = `${scriptUrl}
${version(scriptUrl)}`;
        if (!cache.has(key)) cache.set(key, (allowed(scriptUrl) ? load(scriptUrl) : Promise.resolve(null)).catch(() => null));
        return cache.get(key);
    };

    /** One stack line: `src/a.ts:12:5` with a source map, otherwise the URL with line and column. */
    const frame = async (line) => {
        const found = line.match(FRAME);
        if (found === null) return null;
        const [, url, row, col] = found;
        const loaded = await mapFor(url);
        const position = loaded === null ? null : positionIn(loaded, Number(row), Number(col));
        return position === null
            ? { url, at: `${url}:${row}:${col}`, mapped: false }
            : { url, at: `${sourcePath(position.source, loaded.mapUrl)}:${position.line}:${position.column}`, mapped: true };
    };

    return {
        /**
         * The lines of a stack, translated. `skip` (a regular expression) marks files that only pass errors on, such as the
         * framework itself; checked against the translated path and the URL.
         * @returns { at, stack } `at` is the first own position, `stack` up to `max` lines
         */
        translate: async (stack, { skip = null, max = 8 } = {}) => {
            const lines = (stack ?? '').split('\n').filter((line) => line.trim().startsWith('at ')).slice(0, 40);
            const frames = (await Promise.all(lines.map(frame))).filter((entry) => entry !== null);
            const own = frames.find(({ url, at }) => skip === null || !(skip.test(at) || skip.test(url)));
            return { at: own?.at, stack: frames.slice(0, max).map(({ at }) => at) };
        },
    };
};
