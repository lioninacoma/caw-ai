// Uebersetzt den Stack eines Skriptfehlers ueber Quellkarten in Dateien des Quellcodes: aus `main.3f9a.js:1:48211` wird
// `src/app/orders.service.ts:42:7`. Gilt fuer jedes Framework und jeden Bundler (Vite, webpack, Angular CLI, esbuild), weil nur das
// Format der Quellkarte (Version 3) zaehlt. Ohne Quellkarte bleibt die Zeile, wie sie ist; das Tool scheitert nie daran.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...B64].map((char, index) => [char, index]));
const MAX_MAP_BYTES = 30 * 1024 * 1024;
const FRAME = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/;

/** Base64-VLQ eines Segments, etwa "AAgBC", in Zahlen. */
export const decodeVlq = (text) => {
    const values = [];
    let value = 0;
    let shift = 0;
    for (const char of text) {
        const digit = DIGIT.get(char);
        if (digit === undefined) throw new Error(`kein Base64-Zeichen: ${char}`);
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
 * Die Zuordnungen einer Quellkarte, je erzeugter Zeile die Segmente [Spalte, Quelle, Zeile, Spalte], alle ab 0.
 * Segmente ohne Quelle (nur eine Spalte) fallen weg.
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

/**
 * Wo eine Stelle im erzeugten Code herkommt: das letzte Segment der Zeile, das nicht hinter der Spalte beginnt.
 * @param line, column wie im Stack, ab 1
 * @returns { source, line, column } ab 1, oder null
 */
/** `sourceRoot` vor der Quelle, wie Browser es tun: mit genau einem / dazwischen, ausser die Quelle ist selbst absolut. */
export const withRoot = (root, source) => {
    if (typeof root !== 'string' || root === '' || /^[a-z][\w+.-]*:/i.test(source) || source.startsWith('/')) return source;
    return `${root.endsWith('/') ? root : `${root}/`}${source}`;
};

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
 * Der Pfad einer Quelle, wie ein Mensch ihn im Projekt sucht. Bundler schreiben Praefixe davor: `webpack://name/./src/a.ts`,
 * `/@fs/C:/…`, `ng://`, oder eine absolute URL des Dev-Servers.
 */
export const sourcePath = (source, mapUrl) => {
    const bundler = /^(webpack|ng|vite|rollup):\/\//.test(source);
    let path = source.replace(/^webpack:\/\/[^/]*\//, '').replace(/^(ng|vite|rollup):\/\/\/?/, '');
    // Relativ zur Quellkarte nur, was keine Bundler-Adresse ist: `../src/a.ts` neben `assets/index.js.map`.
    if (!bundler && (!/^[a-z]+:/i.test(path) || /^https?:/i.test(path))) {
        try {
            path = new URL(path, mapUrl).pathname;
        } catch {
            // Bleibt, wie es ist.
        }
    }
    return decodeURIComponent(path).replace(/^\/@fs\//, '').replace(/^\/+/, '').replace(/^(\.\/)+/, '').replace(/[?#].*$/, '');
};

const stripQuery = (url) => url.replace(/[?#].*$/, '');

/**
 * Quellkarten aus der Anwendung laden und Stacks uebersetzen. Geladen wird nur vom Origin des Skripts selbst und nur, was `allowed`
 * zulaesst: Die Seite kann eine Quellkarte ueberall hin zeigen lassen, der Host folgt dem nicht.
 * @param fetchText (url) => Promise<string|null>, z. B. ueber den Request-Kontext des Browsers (gleiche Cookies, gleiche TLS-Regeln)
 * @param allowed   (url) => boolean, etwa die Host-Sperre
 */
export const createSourceMapper = ({ fetchText, allowed = () => true }) => {
    const cache = new Map();
    const load = async (scriptUrl) => {
        const script = await fetchText(scriptUrl);
        if (typeof script !== 'string') return null;
        // Der letzte Kommentar zaehlt; eine Inline-Karte (Vite im Dev-Modus) ist oft Megabytes lang, darum nicht nur das Dateiende.
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
        if (map.version !== 3 || typeof map.mappings !== 'string') return null;
        return { map, lines: parseMappings(map.mappings), mapUrl };
    };
    const mapFor = (scriptUrl) => {
        if (!cache.has(scriptUrl)) cache.set(scriptUrl, (allowed(scriptUrl) ? load(scriptUrl) : Promise.resolve(null)).catch(() => null));
        return cache.get(scriptUrl);
    };

    /** Eine Zeile des Stacks: `src/a.ts:12:5` mit Quellkarte, sonst die URL mit Zeile und Spalte. */
    const frame = async (line) => {
        const found = line.match(FRAME);
        if (found === null) return null;
        const [, url, row, col] = found;
        const loaded = await mapFor(url);
        const position = loaded === null ? null : originalPosition(loaded.map, loaded.lines, Number(row), Number(col));
        return position === null
            ? { url, at: `${url}:${row}:${col}`, mapped: false }
            : { url, at: `${sourcePath(position.source, loaded.mapUrl)}:${position.line}:${position.column}`, mapped: true };
    };

    return {
        /**
         * Die Zeilen eines Stacks, uebersetzt. `skip` (regulaerer Ausdruck) kennzeichnet Dateien, die Fehler nur weiterreichen,
         * etwa das Framework selbst; gegen den uebersetzten Pfad und gegen die URL geprueft.
         * @returns { at, stack } `at` ist die erste eigene Stelle, `stack` bis zu `max` Zeilen
         */
        translate: async (stack, { skip = null, max = 8 } = {}) => {
            const lines = (stack ?? '').split('\n').filter((line) => line.trim().startsWith('at ')).slice(0, 40);
            const frames = (await Promise.all(lines.map(frame))).filter((entry) => entry !== null);
            const own = frames.find(({ url, at }) => skip === null || !(skip.test(at) || skip.test(url)));
            return { at: own?.at, stack: frames.slice(0, max).map(({ at }) => at) };
        },
    };
};
