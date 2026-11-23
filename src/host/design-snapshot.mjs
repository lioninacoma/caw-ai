// A design snapshot: the app's current screen as a static design page under caw/design, with the app's own stylesheets as
// files beside it (caw/design/assets/<name>/). It is the starting point for a draft in the app's style: the draft keeps the
// app's markup and class names and only adds what is new, so it can be met without CSS of its own. Only reads the page: the
// DOM, the stylesheets the page already has (CSSOM) and GET requests for the files they and the page reference (fonts,
// images) from the page itself, through the session's guards.

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';

import { t } from '../shared/i18n.mjs';
import { ASSET_TYPES, DESIGN_DIR, DESIGN_LIMITS, designKind, designProblem, settle, writeDesignFile } from './design.mjs';
import { redactFor } from './secrets.mjs';

/** Where a snapshot's files go: design/assets/<name without .html>/. */
export const ASSETS_DIR = 'assets';
// What a snapshot may store: one file, all files together, how many files. An app's theme with its fonts stays below.
// The page itself is limited like any design page (DESIGN_LIMITS.html): its stylesheets are files of their own.
export const SNAPSHOT_LIMITS = { file: 8 * 1024 * 1024, total: 40 * 1024 * 1024, files: 400, html: DESIGN_LIMITS.html };
const BY_TYPE = Object.fromEntries(Object.entries(ASSET_TYPES).reverse().map(([extension, type]) => [type, extension]));

/** design/<name>.html for a --name or a default, or null when it is no design name. */
export const snapshotName = (name) => {
    if (typeof name !== 'string' || name === '') return null;
    const plain = name.startsWith(`${DESIGN_DIR}/`) ? name : `${DESIGN_DIR}/${name}`;
    const file = plain.toLowerCase().endsWith('.html') ? plain : `${plain}.html`;
    if (designKind(file) !== 'html' || file.split('/')[1] === ASSETS_DIR) return null;
    return file;
};

/** The folder of a snapshot's files, relative to the caw folder: design/assets/<path without .html>. */
export const assetsDirOf = (file) => `${DESIGN_DIR}/${ASSETS_DIR}/${file.slice(DESIGN_DIR.length + 1, -'.html'.length)}`;

/**
 * Runs in the browser: the page as static HTML without scripts, and what it references. Stylesheets are taken from the CSSOM
 * (also rules a script inserted, @import resolved in place); a stylesheet of another origin without CORS cannot be read and is
 * left out. Field values are frozen into attributes (never a password or a hidden field's value). Every URL that should be a
 * file of its own is replaced by a token `__caw_asset_<n>__`; `urls[n]` is its absolute address.
 * @returns { html, sheets: [{ token, css }], urls: [absolute], notes: [{ kind, detail }] }
 */
export function snapshotProbe() {
    const urls = [];
    const index = new Map();
    const notes = [];
    const tokenOf = (absolute) => {
        if (!index.has(absolute)) {
            index.set(absolute, urls.length);
            urls.push(absolute);
        }
        return `__caw_asset_${index.get(absolute)}__`;
    };
    const resolve = (value, base) => {
        try {
            return new URL(value, base).href;
        } catch {
            return null;
        }
    };
    // url(...) in CSS text, relative to the sheet's address: a file of its own, data: stays.
    const cssUrls = (css, base) => css.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/g, (whole, _quote, value) => {
        if (value === '' || value.startsWith('data:') || value.startsWith('#')) return whole;
        const absolute = resolve(value, base);
        return absolute === null || !/^https?:/.test(absolute) ? whole : `url("${tokenOf(absolute)}")`;
    });
    const rulesOf = (sheet, base) => {
        let rules;
        try {
            rules = [...sheet.cssRules];
        } catch {
            return null;
        }
        return rules.map((rule) => {
            if (rule instanceof CSSImportRule) {
                if (rule.styleSheet === null) return '';
                const inner = rulesOf(rule.styleSheet, rule.styleSheet.href ?? base);
                if (inner === null) {
                    notes.push({ kind: 'sheet', detail: rule.href });
                    return '';
                }
                const media = rule.media?.mediaText ?? '';
                return media === '' || media === 'all' ? inner : `@media ${media} {\n${inner}\n}`;
            }
            return cssUrls(rule.cssText, base);
        }).join('\n');
    };
    const sheets = [];
    const sheetOf = new Map();
    for (const sheet of document.styleSheets) {
        if (sheet.ownerNode === null) continue;
        const css = rulesOf(sheet, sheet.href ?? document.baseURI);
        if (css === null) notes.push({ kind: 'sheet', detail: sheet.href });
        sheetOf.set(sheet.ownerNode, css === null ? null : { css, disabled: sheet.disabled, media: sheet.media?.mediaText ?? '' });
    }
    const adopted = [...(document.adoptedStyleSheets ?? [])].map((sheet) => rulesOf(sheet, document.baseURI)).filter((css) => css !== null && css !== '');

    const source = document.documentElement;
    const clone = source.cloneNode(true);
    const originals = [source, ...source.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    const drop = [];
    originals.forEach((node, at) => {
        const copy = copies[at];
        const tag = node.tagName;
        for (const { name } of [...copy.attributes]) if (/^on/i.test(name)) copy.removeAttribute(name);
        if (copy.hasAttribute('style')) copy.setAttribute('style', cssUrls(copy.getAttribute('style'), document.baseURI));
        if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'BASE') {
            drop.push(copy);
            return;
        }
        if (tag === 'META' && /^(refresh|content-security-policy)$/i.test(copy.getAttribute('http-equiv') ?? '')) {
            drop.push(copy);
            return;
        }
        if (tag === 'LINK') {
            const sheet = sheetOf.get(node);
            if (!/\bstylesheet\b/i.test(copy.getAttribute('rel') ?? '') || sheet === undefined || sheet === null || sheet.disabled) {
                drop.push(copy);
                return;
            }
            const token = `__caw_sheet_${sheets.length}__`;
            sheets.push({ token, css: sheet.css });
            for (const { name } of [...copy.attributes]) if (!['rel', 'media'].includes(name)) copy.removeAttribute(name);
            copy.setAttribute('href', token);
            return;
        }
        if (tag === 'STYLE') {
            const sheet = sheetOf.get(node);
            if (sheet === undefined || sheet === null) return;
            copy.textContent = sheet.css;
            return;
        }
        if (tag === 'IMG') {
            const src = node.currentSrc || node.src;
            copy.removeAttribute('srcset');
            copy.removeAttribute('sizes');
            copy.removeAttribute('loading');
            if (src && /^https?:/.test(src)) copy.setAttribute('src', tokenOf(src));
            return;
        }
        if (tag === 'SOURCE' && node.parentElement?.tagName === 'PICTURE') {
            drop.push(copy);
            return;
        }
        if (['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO'].includes(tag)) {
            for (const name of ['src', 'srcdoc', 'data', 'poster']) copy.removeAttribute(name);
            if (tag === 'IFRAME' || tag === 'FRAME') notes.push({ kind: 'frame', detail: node.getAttribute('src') ?? '' });
            return;
        }
        if (tag === 'INPUT') {
            const type = (node.getAttribute('type') ?? 'text').toLowerCase();
            if (type === 'checkbox' || type === 'radio') {
                if (node.checked) copy.setAttribute('checked', '');
                else copy.removeAttribute('checked');
            } else if (type === 'password' || type === 'hidden' || type === 'file') {
                copy.removeAttribute('value');
            } else {
                copy.setAttribute('value', node.value);
            }
            return;
        }
        if (tag === 'TEXTAREA') {
            copy.textContent = node.value;
            return;
        }
        if (tag === 'OPTION') {
            if (node.selected) copy.setAttribute('selected', '');
            else copy.removeAttribute('selected');
            return;
        }
        if (node.shadowRoot !== null && node.shadowRoot !== undefined) notes.push({ kind: 'shadow', detail: tag.toLowerCase() });
        if (node.scrollTop > 0 || node.scrollLeft > 0) notes.push({ kind: 'scroll', detail: tag.toLowerCase() });
    });
    for (const node of drop) node.remove();
    if (adopted.length > 0) {
        const style = document.createElement('style');
        style.textContent = adopted.join('\n');
        clone.querySelector('head')?.append(style);
    }
    // A static page has no time: every animation and transition stands at its end, as on the screen once it settled (an
    // animation that ends invisible, a ripple, would otherwise start again when the design is rendered).
    const still = document.createElement('style');
    still.setAttribute('data-caw-snapshot', '');
    still.textContent = '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }';
    (clone.querySelector('head') ?? clone).append(still);
    const doctype = document.doctype === null ? '' : `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''}>\n`;
    if (window.scrollX > 0 || window.scrollY > 0) notes.push({ kind: 'scroll', detail: 'page' });
    return { html: `${doctype}${clone.outerHTML}\n`, sheets, urls, notes };
}

/**
 * Runs in the browser: one file the page references, read with GET like the page would (its cookies, its cache), only from the
 * page's own origin or a file the page has loaded already. A file larger than `max` is not read.
 * @returns { type, data (base64) } or { error }
 */
export async function fetchProbe({ url, max }) {
    const loaded = performance.getEntriesByType('resource').some(({ name }) => name === url);
    if (new URL(url).origin !== location.origin && !loaded) return { error: 'origin' };
    try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' });
        if (!response.ok) return { error: `HTTP ${response.status}` };
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > max) return { error: 'size' };
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
        return { type: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), data: btoa(binary) };
    } catch (error) {
        return { error: String(error?.message ?? error) };
    }
}

const SAFE = /[^\w.-]+/g;
/** A file name for an asset: number, the URL's last segment (plain characters), an extension renderDesign serves. */
const assetFile = (number, url, type, fallback) => {
    let base = 'file';
    try {
        base = decodeURIComponent(new URL(url).pathname.split('/').at(-1) || 'file');
    } catch {
        // the number alone tells the files apart
    }
    base = base.replace(SAFE, '_').replace(/^[._]+/, '').slice(0, 60) || 'file';
    const known = Object.keys(ASSET_TYPES).find((extension) => base.toLowerCase().endsWith(extension));
    const extension = known ?? BY_TYPE[type] ?? fallback;
    const stem = known === undefined ? base : base.slice(0, -known.length);
    return `${number}-${stem || 'file'}${extension}`;
};

/**
 * Reads the snapshot of a page: its static HTML, its stylesheets and the files they reference, as files for caw/design.
 * @param file the design file, design/<name>.html
 * @param secrets values that must not appear (redacted in the HTML like in result.json)
 * @returns { html, assets: [{ file, data }], notes: [{ kind, detail }] } with asset files relative to the caw folder
 */
export const snapshotOf = async (page, file, { secrets = [], limits = SNAPSHOT_LIMITS } = {}) => {
    const frame = page.mainFrame();
    // An element in the middle of an animation (a click's ripple in ExtJS Material) would stay in the snapshot for good.
    await settle(page);
    const { html, sheets, urls, notes } = await frame.evaluate(snapshotProbe);
    const dir = assetsDirOf(file);
    // From the page's folder (design/…) to the assets folder; from a stylesheet in it, the same folder.
    const fromPage = posix.relative(posix.dirname(file), dir);
    const assets = [];
    let total = 0;
    const fetched = [];
    for (const [number, url] of urls.entries()) {
        if (assets.length >= limits.files) {
            notes.push({ kind: 'limit', detail: url });
            fetched.push(null);
            continue;
        }
        const got = await frame.evaluate(fetchProbe, { url, max: limits.file }).catch((error) => ({ error: error.message }));
        if (got.error !== undefined) {
            notes.push({ kind: 'file', detail: `${url} (${got.error})` });
            fetched.push(null);
            continue;
        }
        const data = Buffer.from(got.data, 'base64');
        if (total + data.length > limits.total) {
            notes.push({ kind: 'limit', detail: url });
            fetched.push(null);
            continue;
        }
        total += data.length;
        const name = assetFile(number + 1, url, got.type, '.bin');
        if (!Object.keys(ASSET_TYPES).some((extension) => name.endsWith(extension))) {
            notes.push({ kind: 'file', detail: `${url} (${got.type || 'type'})` });
            fetched.push(null);
            continue;
        }
        assets.push({ file: `${dir}/${name}`, data });
        fetched.push(name);
    }
    // A file that could not be stored keeps its address: offline it does not load, like a missing file.
    const fill = (text, prefix) => text.replace(/__caw_asset_(\d+)__/g, (_, number) => (fetched[number] === null ? urls[number] : `${prefix}${fetched[number]}`));
    let out = html;
    for (const [number, { token, css }] of sheets.entries()) {
        const name = `sheet-${number + 1}.css`;
        const data = Buffer.from(fill(css, ''), 'utf8');
        total += data.length;
        assets.push({ file: `${dir}/${name}`, data });
        out = out.replace(token, `${fromPage}/${name}`);
    }
    out = fill(out, `${fromPage}/`);
    // Inline styles and attributes may name files too; stylesheets in <style> point from the page.
    out = await redactFor(page, out, secrets);
    if (Buffer.byteLength(out, 'utf8') > limits.html) throw new Error(t('run.mcp.designTooLarge', { max: Math.round(limits.html / 1024 / 1024) }));
    return { html: out, assets, notes };
};

/**
 * Writes a snapshot: the page as design/<name>.html, its files under design/assets/<name>/ (files of an earlier snapshot of the
 * same name that are no longer needed go). Nothing is written outside caw/design, no link is followed.
 * @returns { file, bytes, assets: count, assetBytes, replaced }
 */
export const writeSnapshot = (cawDir, file, { html, assets }) => {
    // The page is checked first: a page that would be refused leaves the earlier snapshot as it was.
    const problem = designProblem('html', Buffer.from(html, 'utf8'));
    if (problem !== null) throw new Error(problem);
    const dir = join(cawDir, ...assetsDirOf(file).split('/'));
    if (existsSync(dir)) {
        if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(t('run.mcp.designLink', { file: assetsDirOf(file) }));
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (lstatSync(path).isFile()) rmSync(path);
        }
    }
    for (const asset of assets) writeDesignFile(cawDir, asset.file, asset.data);
    const written = writeDesignFile(cawDir, file, Buffer.from(html, 'utf8'), { html: true });
    return { file, bytes: written.bytes, assets: assets.length, assetBytes: assets.reduce((sum, { data }) => sum + data.length, 0), replaced: written.replaced };
};

// A stylesheet element of a page: <link rel=stylesheet …> or <style>…</style>.
const SHEET = /<link\b[^>]*\brel\s*=\s*["']?stylesheet\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const relativeUrl = (value) => value !== '' && !/^(?:[a-z][\w+.-]*:|\/|#)/i.test(value);

/**
 * A draft with the app's stylesheets instead of its own (caw_design put with stylesFrom): every <link rel=stylesheet> and
 * <style> of the draft goes, the snapshot's stylesheet elements take their place in the draft's head, in their order, their
 * addresses made relative to the draft. The markup, its classes and its style attributes stay as they are.
 * @param draftFile    design/<name>.html of the draft
 * @param snapshotFile design/<name>.html of the snapshot
 * @returns { html, removed: own stylesheet elements, linked: the snapshot's, styled: elements with a style attribute }
 */
export const withStylesFrom = (draft, draftFile, snapshot, snapshotFile) => {
    const from = posix.dirname(snapshotFile);
    const to = posix.dirname(draftFile);
    const move = (value) => (relativeUrl(value) ? posix.relative(to, posix.join(from, value)) : value);
    const sheets = [...snapshot.matchAll(SHEET)].map(([element]) => (element.startsWith('<link')
        ? element.replace(/\bhref\s*=\s*(["'])(.*?)\1/i, (_, quote, href) => `href=${quote}${move(href)}${quote}`)
        : element.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/g, (whole, quote, value) => (relativeUrl(value) ? `url(${quote}${move(value)}${quote})` : whole))));
    const removed = (draft.match(SHEET) ?? []).length;
    const own = draft.replace(SHEET, '');
    const block = `${sheets.join('\n')}\n`;
    let html;
    if (/<\/head\s*>/i.test(own)) html = own.replace(/<\/head\s*>/i, `${block}</head>`);
    else if (/<head\b[^>]*>/i.test(own)) html = own.replace(/<head\b[^>]*>/i, (head) => `${head}\n${block}`);
    else if (/<html\b[^>]*>/i.test(own)) html = own.replace(/<html\b[^>]*>/i, (start) => `${start}<head>\n${block}</head>`);
    else html = `<head>\n${block}</head>\n${own}`;
    const styled = (own.match(/<[a-z][^>]*\sstyle\s*=/gi) ?? []).length;
    return { html, removed, linked: sheets.length, styled };
};
