// Tag swap: in the served document, the app's code tags are replaced by those of the local page (build or dev server). The page
// itself, its inline scripts, cookies and everything else stay the server's. This way a build with a different split also starts
// (webpack with other chunks, Angular with other polyfills): it gets exactly the tags it was built with, instead of a per-request mapping.

// <noscript>…</noscript> as one unit, then <script …>…</script>, then <link …>. Comments first, so a commented-out tag does not count.
const TAG = /<!--[\s\S]*?-->|<noscript\b[^>]*>[\s\S]*?<\/noscript>|<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi;
const CODE_REL = /^(?:stylesheet|modulepreload|preload|prefetch)$/i;
// Data in a script tag is not code: JSON, templates. An importmap counts as code.
const DATA_TYPE = /^(?:application\/(?:ld\+)?json|text\/(?:template|x-template|html))$/i;

const openTag = (tag) => tag.match(/^<[^>]*>/)[0];
export const attr = (tag, name) => {
    const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(openTag(tag));
    return found === null ? undefined : found.slice(1).find((value) => value !== undefined);
};
const hasAttr = (tag, name) => new RegExp(`\\s${name}(?:\\s*=|[\\s>/])`, 'i').test(openTag(tag));

// SSR: the page carries the server's rendered state. With other code, hydration would run against foreign markup.
const SSR_MARKERS = [
    ['Next.js', /self\.__next_f\b|id=["']?__NEXT_DATA__/],
    ['Nuxt', /window\.__NUXT__|id=["']?__NUXT_DATA__/],
    ['SvelteKit', /\sdata-sveltekit-/],
    ['Angular SSR', /\sng-server-context\s*=/],
];

/** Detects a server-side rendered page. @returns the framework name or null */
export const ssrMarker = (html) => SSR_MARKERS.find(([, marker]) => marker.test(html))?.[0] ?? null;

const isCode = (tag) => {
    if (/^<noscript/i.test(tag)) return true;
    if (/^<script/i.test(tag)) return !DATA_TYPE.test(attr(tag, 'type') ?? '');
    return CODE_REL.test(attr(tag, 'rel') ?? '');
};

/**
 * The code tags of a document with their URLs (absolute against base, unresolvable ones dropped).
 * @returns [{ tag, index, head, urls, inline }]; `inline`: a script without src, its text is inside the tag
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

/** The address a page's URLs resolve against: <base href>, otherwise its own. */
export const baseOf = (html, url) => {
    const href = /<base\b[^>]*\shref\s*=\s*["']?([^"'\s>]+)/i.exec(html)?.[1];
    try {
        return href === undefined ? url : new URL(href, url).href;
    } catch {
        return url;
    }
};

/** The page's nonce (CSP with nonce): inserted tags need it, otherwise Chrome does not run them. */
export const nonceOf = (html) => /<(?:script|link|style)\b[^>]*\snonce\s*=\s*["']?([^"'\s>]+)/i.exec(html)?.[1];

/**
 * Swaps the code tags. The new tags take the place of the first removed tag in head or body; if none was removed there,
 * they go to the end of head or body.
 * @param html   the served document (byte string, see rewriteBytes)
 * @param base   the address its URLs resolve against (baseOf)
 * @param owned  (deployedTag) => true if the tag belongs to the app and gets replaced
 * @param local  the local page's tags to insert, from codeTags, already filtered
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
        // Placeholder with no meaning in HTML; later replaced by the new tags (the first one per part) or nothing.
        out += deployed.head ? '\u0000H' : '\u0000B';
        last = deployed.index + deployed.tag.length;
        removed.push(deployed);
    }
    out += html.slice(last);
    const part = (head) => local.filter((tag) => tag.head === head).map((tag) => withNonce(tag.tag)).join('');
    const tags = { H: part(true), B: part(false) };
    const done = { H: false, B: false };
    // eslint-disable-next-line no-control-regex -- matches the NUL placeholder inserted above
    out = out.replace(/\u0000([HB])/g, (_, key) => {
        if (done[key]) return '';
        done[key] = true;
        return tags[key];
    });
    if (!done.H && tags.H !== '') out = /<\/head\s*>/i.test(out) ? out.replace(/<\/head\s*>/i, (end) => `${tags.H}${end}`) : `${tags.H}${out}`;
    if (!done.B && tags.B !== '') out = /<\/body\s*>/i.test(out) ? out.replace(/<\/body\s*>/i, (end) => `${tags.B}${end}`) : `${out}${tags.B}`;
    return { html: out, removed: removed.map(({ urls, tag }) => urls[0] ?? tag.slice(0, 80)), inserted: local.length };
};
