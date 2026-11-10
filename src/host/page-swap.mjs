// Tag-Tausch: Im ausgelieferten Dokument weichen die Code-Tags der App denen der lokalen Seite (Build oder Dev-Server). Die Seite selbst,
// ihre Inline-Skripte, Cookies und alles andere bleiben die des Servers. So startet auch ein Build mit anderer Aufteilung (webpack mit
// anderen Chunks, Angular mit anderen Polyfills): Er bekommt genau die Tags, mit denen er gebaut ist, statt der Abbildung je Request.

// <noscript>…</noscript> als Einheit, dann <script …>…</script>, dann <link …>. Kommentare zuerst, damit ein auskommentierter Tag
// nicht zaehlt.
const TAG = /<!--[\s\S]*?-->|<noscript\b[^>]*>[\s\S]*?<\/noscript>|<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi;
const CODE_REL = /^(?:stylesheet|modulepreload|preload|prefetch)$/i;
// Daten in einem script-Tag sind kein Code: JSON, Vorlagen. Eine importmap gehoert zum Code.
const DATA_TYPE = /^(?:application\/(?:ld\+)?json|text\/(?:template|x-template|html))$/i;

const openTag = (tag) => tag.match(/^<[^>]*>/)[0];
export const attr = (tag, name) => {
    const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(openTag(tag));
    return found === null ? undefined : found.slice(1).find((value) => value !== undefined);
};
const hasAttr = (tag, name) => new RegExp(`\\s${name}(?:\\s*=|[\\s>/])`, 'i').test(openTag(tag));

// SSR: Die Seite traegt den gerenderten Zustand des Servers. Mit anderem Code liefe die Hydration gegen fremdes Markup.
const SSR_MARKERS = [
    ['Next.js', /self\.__next_f\b|id=["']?__NEXT_DATA__/],
    ['Nuxt', /window\.__NUXT__|id=["']?__NUXT_DATA__/],
    ['SvelteKit', /\sdata-sveltekit-/],
    ['Angular SSR', /\sng-server-context\s*=/],
];

/** Erkennt eine serverseitig gerenderte Seite. @returns der Name des Frameworks oder null */
export const ssrMarker = (html) => SSR_MARKERS.find(([, marker]) => marker.test(html))?.[0] ?? null;

const isCode = (tag) => {
    if (/^<noscript/i.test(tag)) return true;
    if (/^<script/i.test(tag)) return !DATA_TYPE.test(attr(tag, 'type') ?? '');
    return CODE_REL.test(attr(tag, 'rel') ?? '');
};

/**
 * Die Code-Tags eines Dokuments mit ihren URLs (absolut gegen base, ohne die nicht aufloesbaren).
 * @returns [{ tag, index, head, urls, inline }]; `inline`: ein Skript ohne src, sein Text steht im Tag
 */
export const codeTags = (html, base) => {
    const headEnd = html.search(/<\/head\s*>/i);
    const resolve = (value) => {
        try {
            return new URL(value, base).href;
        } catch {
            return null;
        }
    };
    const tags = [];
    for (const match of html.matchAll(TAG)) {
        const [tag] = match;
        if (tag.startsWith('<!--') || !isCode(tag)) continue;
        const inner = /^<noscript/i.test(tag) ? [...tag.replace(/^<noscript[^>]*>|<\/noscript>$/gi, '').matchAll(TAG)].map(([one]) => one) : [tag];
        const urls = inner.flatMap((one) => ['src', 'href'].map((name) => (one.startsWith('<!--') ? undefined : attr(one, name)))).filter((value) => value !== undefined).map(resolve).filter((url) => url !== null);
        tags.push({ tag, index: match.index, head: headEnd < 0 || match.index < headEnd, urls, inline: /^<script/i.test(tag) && !hasAttr(tag, 'src') });
    }
    return tags;
};

/** Gegen welche Adresse die URLs einer Seite gelten: <base href>, sonst ihre eigene. */
export const baseOf = (html, url) => {
    const href = /<base\b[^>]*\shref\s*=\s*["']?([^"'\s>]+)/i.exec(html)?.[1];
    try {
        return href === undefined ? url : new URL(href, url).href;
    } catch {
        return url;
    }
};

/** Die Nonce der Seite (CSP mit nonce): Eingefuegte Tags brauchen sie, sonst fuehrt Chrome sie nicht aus. */
export const nonceOf = (html) => /<(?:script|link|style)\b[^>]*\snonce\s*=\s*["']?([^"'\s>]+)/i.exec(html)?.[1];

/**
 * Tauscht die Code-Tags. Die neuen Tags kommen an die Stelle des ersten entfernten Tags in head bzw. body; wurde dort keiner entfernt,
 * ans Ende von head bzw. body.
 * @param html   das ausgelieferte Dokument (Byte-String, siehe rewriteBytes)
 * @param base   die Adresse, gegen die seine URLs gelten (baseOf)
 * @param owned  (deployedTag) => true, wenn der Tag der App gehoert und weicht
 * @param local  die einzufuegenden Tags der lokalen Seite, aus codeTags, schon gefiltert
 * @returns { html, removed: [urls], inserted }
 */
export const swapPage = (html, { base, owned, local }) => {
    const nonce = nonceOf(html);
    const withNonce = (tag) => (nonce === undefined || hasAttr(tag, 'nonce') ? tag : tag.replace(/^<(script|link)\b/i, `<$1 nonce="${nonce}"`));
    const removed = [];
    let out = '';
    let last = 0;
    for (const deployed of codeTags(html, base)) {
        if (!owned(deployed)) continue;
        out += html.slice(last, deployed.index);
        // Platzhalter ohne Bedeutung in HTML; danach ersetzt durch die neuen Tags (der erste je Teil) oder nichts.
        out += deployed.head ? '\u0000H' : '\u0000B';
        last = deployed.index + deployed.tag.length;
        removed.push(deployed);
    }
    out += html.slice(last);
    const part = (head) => local.filter((tag) => tag.head === head).map((tag) => withNonce(tag.tag)).join('');
    const tags = { H: part(true), B: part(false) };
    const done = { H: false, B: false };
    out = out.replace(/\u0000([HB])/g, (_, key) => {
        if (done[key]) return '';
        done[key] = true;
        return tags[key];
    });
    if (!done.H && tags.H !== '') out = /<\/head\s*>/i.test(out) ? out.replace(/<\/head\s*>/i, (end) => `${tags.H}${end}`) : `${tags.H}${out}`;
    if (!done.B && tags.B !== '') out = /<\/body\s*>/i.test(out) ? out.replace(/<\/body\s*>/i, (end) => `${tags.B}${end}`) : `${out}${tags.B}`;
    return { html: out, removed: removed.map(({ urls, tag }) => urls[0] ?? tag.slice(0, 80)), inserted: local.length };
};
