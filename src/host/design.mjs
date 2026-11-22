// Target designs: a step may name a design (caw/design/<file>) that its screen should match. caw judges it without AI, by
// structure: the same controls, the same view lines and a few computed styles per control. A design comes from a person (Claude
// Design, Figma), the attached Claude Code session writes it with caw_design; caw itself never fetches anything.

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { t } from '../shared/i18n.mjs';
import { controlsProbe } from './effects.mjs';
import { waitForLocator } from './framework/index.mjs';
import { redactFor } from './secrets.mjs';

export const DESIGN_DIR = 'design';
/** What a step's `design:` may name: a page, judged by structure. */
export const DESIGN_KINDS = ['.html'];
// A target design not met and a changed learned look fail their step (the look only on steps with look: true, once learned).
export const DEFAULT_DESIGN_FAIL = ['target', 'visual'];
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
// How long `needs` waits for each locator at the end of a run: the page is already quiet, it only has to be there.
export const NEEDS_TIMEOUT_MS = 2000;
// The rendered design gets this long; it has neither scripts nor network, so it only parses and lays out.
const RENDER_TIMEOUT_MS = 10_000;

const SEGMENT = /^[\w-][\w.-]*$/;

/**
 * Is this a design path as a step names it: relative to the caw folder, under design/, plain segments (no `..`, no
 * absolute path, no backslashes), ending in .html? Only the shape; designPath checks the file.
 */
export const isDesignName = (name) => {
    if (typeof name !== 'string' || name.length > 200) return false;
    const segments = name.split('/');
    return segments.length >= 2 && segments[0] === DESIGN_DIR && segments.slice(1).every((segment) => SEGMENT.test(segment))
        && DESIGN_KINDS.some((kind) => name.toLowerCase().endsWith(kind));
};

const inside = (dir, path) => {
    const rel = relative(dir, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * The design file a step names, relative to the caw folder: it must lie in caw/design (also after resolving links), be a
 * regular file and not a link, as with fixtures.
 * @returns the absolute path or null
 */
export const designPath = (cawDir, name) => {
    if (!isDesignName(name)) return null;
    const root = join(cawDir, DESIGN_DIR);
    const path = resolve(cawDir, name);
    if (!inside(root, path) || !existsSync(path)) return null;
    try {
        if (!inside(realpathSync(root), realpathSync(path)) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return null;
    } catch {
        return null;
    }
    return path;
};

/** The design path relative to the caw folder with forward slashes, for messages. */
export const designName = (cawDir, path) => relative(cawDir, path).split(sep).join('/');

// What caw_design writes, per kind: the most a file may have. A Claude Design or Figma export of one screen stays far below.
export const DESIGN_LIMITS = { html: 2 * 1024 * 1024 };

/** The kind of a file caw_design writes: html, or null. */
export const designKind = (name) => {
    if (typeof name !== 'string' || name.length > 200) return null;
    const segments = name.split('/');
    if (segments.length < 2 || segments[0] !== DESIGN_DIR || !segments.slice(1).every((segment) => SEGMENT.test(segment))) return null;
    const lower = name.toLowerCase();
    return lower.endsWith('.html') ? 'html' : null;
};

/**
 * Checks what caw_design put would write. Nothing about the content is run: html is only rendered later without scripts.
 * @param data the file's bytes
 * @returns a problem as text, or null
 */
export const designProblem = (kind, data) => {
    if (data.length === 0) return t('run.mcp.designEmpty');
    if (data.length > DESIGN_LIMITS[kind]) return t('run.mcp.designTooLarge', { max: Math.round(DESIGN_LIMITS[kind] / 1024 / 1024) || 1 });
    const text = data.toString('utf8');
    if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(data)) return t('run.mcp.designNoText');
    return /<(?:html|body|main|div|form|section)\b/i.test(text) ? null : t('run.mcp.designNoHtml');
};

/**
 * Writes a design file under caw/design. The folders on the way must not be links, and an existing file is replaced only if it
 * is a regular file: nothing ends up outside caw/design.
 * @returns { file, kind, bytes, replaced }
 */
export const writeDesign = (cawDir, name, data) => {
    const kind = designKind(name);
    if (kind === null) throw new Error(t('run.mcp.designName'));
    const problem = designProblem(kind, data);
    if (problem !== null) throw new Error(problem);
    const root = join(cawDir, DESIGN_DIR);
    const path = resolve(cawDir, name);
    if (!inside(root, path)) throw new Error(t('run.mcp.designName'));
    mkdirSync(root, { recursive: true });
    // Every folder from caw/design down to the file: created here, or a real folder, never a link.
    let dir = root;
    for (const segment of relative(root, dirname(path)).split(sep).filter(Boolean)) {
        if (lstatSync(dir).isSymbolicLink()) throw new Error(t('run.mcp.designLink', { file: name }));
        dir = join(dir, segment);
        if (!existsSync(dir)) mkdirSync(dir);
    }
    if (lstatSync(dir).isSymbolicLink() || !inside(realpathSync(cawDir), join(realpathSync(dir), basename(path)))) throw new Error(t('run.mcp.designLink', { file: name }));
    const replaced = existsSync(path);
    if (replaced && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error(t('run.mcp.designLink', { file: name }));
    writeFileSync(path, data);
    return { file: name, kind, bytes: data.length, replaced };
};

/** The files in caw/design, relative to the caw folder, with their kind; links and other files are left out. */
export const listDesigns = (cawDir) => {
    const root = join(cawDir, DESIGN_DIR);
    if (!existsSync(root)) return [];
    return readdirSync(root, { recursive: true })
        .map((entry) => join(root, String(entry)))
        .filter((path) => {
            const stat = lstatSync(path);
            return stat.isFile() && !stat.isSymbolicLink();
        })
        .map((path) => ({ file: designName(cawDir, path), bytes: statSync(path).size }))
        .map((entry) => ({ ...entry, kind: designKind(entry.file) }))
        .filter(({ kind }) => kind !== null)
        .sort((a, b) => a.file.localeCompare(b.file));
};

// Numbers change from run to run (counters, dates, run tags), as in effects.mjs.
const neutral = (text) => text.replace(/\d+/g, '#');
// Longer lines are mostly list data or free text.
const MAX_LINE = 120;

/**
 * The ARIA tree as lines without values: links, field contents and long texts (mostly list data) are dropped, as are lines
 * without a name. For comparing against a target design; effects do not use it.
 */
export const viewLines = (aria) => aria.split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !/^\s*- \/url:/.test(line))
    .map((line) => line.replace(/\[ref=[^\]]*\]/g, '').replace(/^(\s*- (?:textbox|combobox|searchbox|spinbutton|slider)(?: "[^"]*")?(?: \[[^\]]*\])*):.*$/, '$1'))
    .filter((line) => line.length <= MAX_LINE && !/^\s*- (?:button|img|generic|list|listitem|group|row|cell|text)?:?$/.test(line))
    .map((line) => neutral(line).trim());

// Whether a field is filled or a list has rows depends on the data, not on the design.
const withoutData = (line) => line.replace(/ (?:empty|filled)$/, '').replace(/,(?:empty|filled)$/, '').replace(/^(list "[^"]*") (?:empty|rows)$/, '$1');

// Rows, list entries and cells are data, often of other records: a design shows sample rows, the app real ones.
const DATA_ROW = /^(\s*)- (?:row|listitem|option|treeitem|gridcell|cell|rowheader)\b/;
// Free text is content, not structure: a design has sample text. Headings, labels, buttons, links and landmarks stay.
const FREE_TEXT = /^\s*- (?:text|paragraph)\b/;
// A heading or link named by data (a digit, the run tag, a remembered value: layoutProbe's rule) is compared by its place only.
const NAMED = /^\s*- (?:heading|link) "([^"]*)"/;
const dataName = (line, texts) => {
    const name = NAMED.exec(line)?.[1];
    return name !== undefined && (/\d/.test(name) || texts.some((text) => typeof text === 'string' && text.length >= 3 && name.includes(text)));
};

/** The ARIA tree without data rows, free text and headings or links named by data, as view lines (viewLines). */
export const maskedView = (aria, texts = []) => {
    const kept = [];
    let skipBelow = null;
    for (const line of aria.split('\n')) {
        const indent = /^\s*/.exec(line)[0].length;
        if (skipBelow !== null && indent > skipBelow) continue;
        skipBelow = null;
        const row = DATA_ROW.exec(line);
        if (row !== null) {
            skipBelow = row[1].length;
            continue;
        }
        if (!FREE_TEXT.test(line) && !dataName(line, texts)) kept.push(line);
    }
    return viewLines(kept.join('\n'));
};

const px = (value) => String(value).replace(/(-?\d+(?:\.\d+)?)px/g, (_, number) => `${Math.round(Number(number))}px`);
const hex = (part) => Math.round(Number(part)).toString(16).padStart(2, '0');
/** rgb()/rgba() as #rrggbb or #rrggbbaa; fully transparent as `transparent`. */
export const cssHex = (value) => {
    const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(String(value).trim());
    if (match === null) return String(value);
    const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
    if (alpha === 0) return 'transparent';
    return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}${alpha === 1 ? '' : hex(alpha * 255)}`;
};

const STYLE_KEYS = { fontSize: 'font-size', fontWeight: 'font-weight', color: 'color', backgroundColor: 'background-color', borderRadius: 'border-radius', padding: 'padding' };

/** Computed styles as the comparison sees them: whole pixels, colors as hex. */
export const normalStyle = (style = {}) => Object.fromEntries(Object.entries(STYLE_KEYS)
    .filter(([key]) => style[key] !== undefined)
    .map(([key, name]) => [name, key === 'color' || key === 'backgroundColor' ? cssHex(style[key]) : px(style[key])]));

// ---------------------------------------------------------------------------------------------------------- layout and texts

/**
 * Runs in the browser: what a target design shows besides its controls, in document order (controlsProbe numbers the controls
 * the same way). Texts (own text of an element, its box is the text itself), blocks (an element with a background, a border or
 * a shadow: cards, sections, chips, separators) and media (img, svg, canvas, video, hr, role img); html and body are the
 * page, not a block.
 *
 * What is data (DATA RULE, the same in the design and in the app, see docs/guide design): it keeps its place in the layout
 * and its font, but its text is not compared.
 * - an area: a list or table with its rows and entries (as controlsProbe), and an element marked `data-caw-data`; it is one
 *   element, nothing inside it is compared;
 * - a value: what a field holds (also an `<output>`), and a text that is the value of a field on the same page;
 * - a text with a digit (numbers, IDs, dates, counters, the run tag) or with one of `texts` (the run tag, remembered values).
 * @returns [{ kind: 'text'|'block'|'media'|'area', order, end?, sub, x, y, width, height, ... }]
 */
export function layoutProbe({ texts = [] } = {}) {
    const all = [...document.body.querySelectorAll('*')];
    const order = new Map(all.map((node, index) => [node, index]));
    const round = (value) => Math.round(value * 100) / 100;
    const box = (rect) => ({ x: round(rect.left + scrollX), y: round(rect.top + scrollY), width: round(rect.width), height: round(rect.height) });
    const short = (text) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const CONTROL = 'input, select, textarea, button, [role=button], [role=tab], [role=checkbox], [role=combobox], [role=textbox]';
    const ROW = '[role=row], [role=gridcell], [role=listitem], [role=option], [role=treeitem], tr, li';
    const LIST = 'ul, ol, table, [role=list], [role=grid], [role=treegrid], [role=table], [role=listbox], [role=tree]';
    const MEDIA = 'img, svg, canvas, video, picture, hr, [role=img]';
    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'OPTION', 'OPTGROUP', 'DATALIST', 'HEAD', 'TITLE', 'META', 'LINK']);
    const wanted = texts.filter((text) => typeof text === 'string' && text.length >= 3);
    const values = new Set([...document.querySelectorAll('input, textarea, select')].map((field) => short(field.value)).filter((value) => value !== ''));
    const isData = (text) => /\d/.test(text) || values.has(text) || wanted.some((value) => text.includes(value));
    const lastOrder = (node) => {
        const inner = node.querySelectorAll('*');
        return inner.length === 0 ? order.get(node) : order.get(inner[inner.length - 1]);
    };
    const kindOf = (node) => {
        if (/^H[1-6]$/.test(node.tagName) || node.getAttribute('role') === 'heading') return 'heading';
        if (node.tagName === 'LABEL') return 'label';
        if (node.tagName === 'A') return 'link';
        if (node.tagName === 'P') return 'paragraph';
        return 'text';
    };
    const font = (style) => ({ fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle, color: style.color });
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const blockStyle = (style) => {
        const borders = sides.map((side) => (style[`border${side}Style`] === 'none' || style[`border${side}Style`] === 'hidden' || parseFloat(style[`border${side}Width`]) === 0
            ? 'none' : `${style[`border${side}Width`]} ${style[`border${side}Style`]} ${style[`border${side}Color`]}`));
        const transparent = /^rgba\(.*,\s*0\)$|^transparent$/.test(style.backgroundColor);
        return {
            background: style.backgroundImage !== 'none' ? 'image' : transparent ? 'none' : style.backgroundColor,
            borders,
            radius: style.borderRadius,
            shadow: style.boxShadow !== 'none',
        };
    };
    const out = [];
    const visit = (node, inData) => {
        if (SKIP.has(node.tagName)) return;
        const style = getComputedStyle(node);
        if (style.display === 'contents') {
            for (const child of node.children) visit(child, inData);
            return;
        }
        if (node.getClientRects().length === 0 || style.visibility === 'hidden' || style.opacity === '0') return;
        if (node.matches(CONTROL)) return;
        const at = order.get(node);
        // A list, a table, a row outside one, or a marked area: one element of data.
        if (node.matches(LIST) || node.matches(ROW) || node.hasAttribute('data-caw-data')) {
            const label = node.getAttribute('aria-label') ?? '';
            out.push({ kind: 'area', order: at, end: lastOrder(node), sub: 0, ...box(node.getBoundingClientRect()), name: short(label), data: true, tag: node.matches(LIST) || node.matches(ROW) ? 'list' : 'data' });
            return;
        }
        if (node.matches(MEDIA)) {
            out.push({ kind: 'media', order: at, end: lastOrder(node), sub: 0, ...box(node.getBoundingClientRect()), name: short(node.getAttribute('alt') || node.getAttribute('aria-label') || ''), tag: node.tagName === 'HR' ? 'separator' : 'img' });
            return;
        }
        const block = blockStyle(style);
        if (block.background !== 'none' || block.borders.some((side) => side !== 'none') || block.shadow) {
            out.push({ kind: 'block', order: at, end: lastOrder(node), sub: 0, ...box(node.getBoundingClientRect()), style: block });
        }
        const own = [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE && child.data.trim() !== '');
        if (own.length > 0) {
            const text = short(own.map((child) => child.data).join(' '));
            const rects = own.flatMap((child) => {
                const range = document.createRange();
                range.selectNodeContents(child);
                return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
            });
            if (rects.length > 0) {
                const left = Math.min(...rects.map((rect) => rect.left));
                const top = Math.min(...rects.map((rect) => rect.top));
                const right = Math.max(...rects.map((rect) => rect.right));
                const bottom = Math.max(...rects.map((rect) => rect.bottom));
                const data = inData || node.closest('output') !== null || isData(text);
                out.push({ kind: 'text', order: at, sub: 1, ...box({ left, top, width: right - left, height: bottom - top }), text, tag: kindOf(node), data, font: font(style) });
            }
        }
        for (const child of node.children) visit(child, inData || node.tagName === 'OUTPUT');
    };
    for (const child of document.body.children) visit(child, false);
    return out;
}

// What differs from run to run on the same screen is measured in LAYOUT-MESSUNG (design noise): the same design and the same
// app state rendered again in fresh browsers, and the design against an app implementing it exactly. Within this many CSS
// pixels a gap, an indent or a size counts as the same.
export const LAYOUT_TOLERANCE_PX = 1;

const firstFamily = (family = '') => family.split(',')[0].trim().replace(/^["']|["']$/g, '');
const border = (sides) => {
    const shown = sides.map((side) => (side === 'none' ? 'none' : px(side.replace(/rgba?\([^)]*\)/g, (color) => cssHex(color)))));
    return shown.every((side) => side === shown[0]) ? { border: shown[0] } : Object.fromEntries(['top', 'right', 'bottom', 'left'].map((name, index) => [`border-${name}`, shown[index]]));
};
const textStyle = ({ fontFamily, fontSize, fontWeight, fontStyle, color }) => ({ 'font-family': firstFamily(fontFamily), 'font-size': px(fontSize), 'font-weight': String(fontWeight), 'font-style': fontStyle, color: cssHex(color) });
const blockLook = ({ background, borders, radius, shadow }) => ({
    background: background === 'none' || background === 'image' ? background : cssHex(background),
    ...border(borders),
    'border-radius': px(radius),
    shadow: shadow ? 'yes' : 'none',
});

/**
 * The elements of a page in document order with a key each, as the comparison matches them: a control by its line, a text by
 * kind and text, a block by its first text that is not data, data by kind and place (after which element, how many before).
 * @returns [{ key, shown, kind, data, order, end?, x, y, width, height, style, size: [width?, height?] }]
 */
export const layoutElements = (controls, layout) => {
    const items = [
        ...controls.filter(({ at }) => at !== undefined).map(({ shown, key, at }) => ({
            kind: 'control', key, shown, order: at.order, sub: 0, x: at.x, y: at.y, width: at.width, height: at.height, data: false,
            style: { 'font-family': firstFamily(at.fontFamily) }, size: at.select ? [] : ['width', 'height'],
        })),
        ...layout,
    ].sort((a, b) => a.order - b.order || a.sub - b.sub);
    const count = new Map();
    const numbered = (key) => {
        const seen = (count.get(key) ?? 0) + 1;
        count.set(key, seen);
        return seen === 1 ? key : `${key} #${seen}`;
    };
    // A block is named by the first text inside it that is not data, or its first control's label.
    const nameOf = (block) => {
        const first = items.find((item) => item !== block && item.order > block.order - (item.sub > 0 ? 1 : 0) && item.order <= block.end && (item.kind === 'control' || (item.kind === 'text' && !item.data)));
        return first === undefined ? '' : first.kind === 'control' ? (/"([^"]*)"/.exec(first.shown)?.[1] ?? '') : first.text;
    };
    let anchor = '^';
    const sinceAnchor = new Map();
    return items.map((item) => {
        if (item.kind === 'control') {
            anchor = item.key;
            sinceAnchor.clear();
            return item;
        }
        const containsData = item.end !== undefined && items.some((other) => other.data && other.order > item.order && other.order <= item.end);
        if (item.data) {
            const seen = (sinceAnchor.get(item.tag) ?? 0) + 1;
            sinceAnchor.set(item.tag, seen);
            const shown = item.kind === 'text' ? `${item.tag} "${item.text}"` : `${item.tag}${item.name ? ` "${item.name}"` : ''}`;
            return { ...item, key: `${item.tag} (data) after ${anchor} #${seen}`, shown, style: item.kind === 'text' ? textStyle(item.font) : {}, size: [] };
        }
        let element;
        if (item.kind === 'text') element = { ...item, shown: `${item.tag} "${item.text}"`, style: textStyle(item.font), size: [] };
        else if (item.kind === 'block') element = { ...item, shown: `block "${nameOf(item)}"`, style: blockLook(item.style), size: containsData ? [] : ['width'] };
        else element = { ...item, shown: `${item.tag}${item.name ? ` "${item.name}"` : ''}`, style: {}, size: ['width', 'height'] };
        element.key = numbered(element.shown);
        anchor = element.key;
        sinceAnchor.clear();
        return element;
    });
};

const bottom = (box) => box.y + box.height;
const right = (box) => box.x + box.width;
const encloses = (outer, inner) => outer.end !== undefined && ((inner.order > outer.order && inner.order <= outer.end) || (inner.order === outer.order && inner.sub > outer.sub));

/**
 * Where b is from a, the element before it: inside a (a block or area holding it), below, above, right of or left of a, with the
 * gap in CSS pixels (inside: from a's top and left edge).
 */
export const relation = (a, b, slack = LAYOUT_TOLERANCE_PX) => {
    if (encloses(a, b)) return { where: 'inside', gap: b.y - a.y, indent: b.x - a.x };
    if (b.y >= bottom(a) - slack) return { where: 'below', gap: b.y - bottom(a) };
    if (bottom(b) <= a.y + slack) return { where: 'above', gap: a.y - bottom(b) };
    if (b.x >= right(a) - slack) return { where: 'right', gap: b.x - right(a) };
    if (right(b) <= a.x + slack) return { where: 'left', gap: a.x - right(b) };
    return { where: 'over', gap: 0 };
};

// The innermost block or area around an element, else null (the page).
const containerOf = (elements, element) => elements.filter((other) => other !== element && (other.kind === 'block' || other.kind === 'area') && encloses(other, element)).at(-1) ?? null;

/**
 * The layout of the matched elements as numbers, design against app: per neighbour pair in the design's document order the
 * relation and gap, per element its indent in its block (when it does not follow its neighbour in the same row) and its size.
 * Used by compareStructure and to measure the noise.
 * @returns [{ type: 'relation'|'gap'|'indent'|'size', a?, b, name?, target, actual }]
 */
export const layoutMeasures = (target, actual) => {
    const now = new Map(actual.map((element) => [element.key, element]));
    const matched = target.filter((element) => now.has(element.key));
    const measures = [];
    const indexOf = new Map(target.map((element, index) => [element, index]));
    for (let index = 0; index < matched.length; index += 1) {
        const b = matched[index];
        const b2 = now.get(b.key);
        for (const name of b.size) measures.push({ type: 'size', b, name, target: b[name], actual: b2[name] });
        if (index === 0) continue;
        const a = matched[index - 1];
        const a2 = now.get(a.key);
        const was = relation(a, b);
        const is = relation(a2, b2);
        // Something of the design missing in between is reported as missing; its gap would only repeat it.
        const skipped = indexOf.get(b) - indexOf.get(a) > 1 && target.slice(indexOf.get(a) + 1, indexOf.get(b)).some((element) => !now.has(element.key));
        if (was.where !== is.where) {
            measures.push({ type: 'relation', a, b, target: was.where, actual: is.where });
            continue;
        }
        if (!skipped) measures.push({ type: 'gap', a, b, target: was.gap, actual: is.gap });
        if (was.where === 'inside') {
            measures.push({ type: 'indent', a, b, target: was.indent, actual: is.indent });
        } else if (was.where === 'below' || was.where === 'above') {
            const box = containerOf(target, b);
            const box2 = box === null ? null : now.get(box.key) ?? null;
            if (box === null || box2 !== null) measures.push({ type: 'indent', a: box, b, target: b.x - (box?.x ?? 0), actual: b2.x - (box2?.x ?? 0) });
        }
    }
    return measures;
};

const pixels = (value) => `${Math.round(value)}px`;
const where = (place, of) => t(`session.design.where.${place}`, { of });

/** The layout deviations beyond the tolerance as lines. */
const layoutLines = (measures, tolerance) => measures.flatMap((measure) => {
    const { type, a, b } = measure;
    if (type === 'relation') return [t('session.design.moved', { element: b.shown, was: where(measure.target, a.shown), now: where(measure.actual, a.shown) })];
    if (Math.abs(measure.actual - measure.target) <= tolerance) return [];
    const was = pixels(measure.target);
    const now = pixels(measure.actual);
    if (was === now) return [];
    if (type === 'size') return [`${b.shown}: ${measure.name} ${was} → ${now}`];
    if (type === 'gap') return [t('session.design.gap', { from: a.shown, to: b.shown, was, now })];
    return [t('session.design.indent', { from: a === null ? t('session.design.page') : a.shown, to: b.shown, was, now })];
});

/**
 * Texts of the design that are not data and not in the app: one in the same place (after the same element) with the same
 * kind is a changed text, `heading "Note" → "Notes"`; others are missing.
 */
const textChanges = (target, actual) => {
    const keys = new Set(actual.map(({ key }) => key));
    const wanted = new Set(target.map(({ key }) => key));
    // The element before: a control or a text that is not data (a block is named by its first text, which may be the changed one).
    const anchorOf = (elements, element) => elements.slice(0, elements.indexOf(element)).reverse().find((other) => other.kind === 'control' || (other.kind === 'text' && !other.data))?.key ?? '^';
    const free = actual.filter((element) => element.kind === 'text' && !element.data && !wanted.has(element.key));
    const changed = [];
    const missing = [];
    for (const element of target.filter(({ kind, data, key }) => kind === 'text' && !data && !keys.has(key))) {
        const anchor = anchorOf(target, element);
        const index = free.findIndex((other) => other.tag === element.tag && anchorOf(actual, other) === anchor);
        if (index === -1) missing.push(element);
        else changed.push({ element, now: free.splice(index, 1)[0] });
    }
    return { changed, missing };
};

const styleLinesOf = (target, actual) => {
    const now = new Map(actual.map((element) => [element.key, element]));
    return target.flatMap((element) => {
        const other = now.get(element.key);
        if (other === undefined) return [];
        return Object.entries(element.style).filter(([name, value]) => other.style[name] !== undefined && other.style[name] !== value).map(([name, value]) => `${element.shown}: ${name} ${value} → ${other.style[name]}`);
    });
};

/**
 * The structure of a page as caw compares it: control lines, view lines, the styles per control (the same control twice is
 * told apart by its number: `button "Delete" #2`) and, from layoutProbe, the elements with their place and look.
 * @param probe { controls: [{ line, style?, at? }], aria, layout? } as read from the page
 * @returns { lines, styles: { <control>: { <css name>: value } }, elements }
 */
export const structureFrom = ({ controls = [], aria = '', layout, texts = [] }) => {
    const count = new Map();
    const styles = {};
    const placed = [];
    const controlLines = controls.map(({ line, style, at }) => {
        const shown = withoutData(neutral(line));
        const seen = (count.get(shown) ?? 0) + 1;
        count.set(shown, seen);
        const key = seen === 1 ? shown : `${shown} #${seen}`;
        if (style !== undefined) styles[key] = normalStyle(style);
        if (at !== undefined) placed.push({ shown: key, key, at });
        return shown;
    });
    return { lines: [...new Set([...controlLines, ...maskedView(aria, texts)])], styles, elements: layout === undefined ? [] : layoutElements(placed, layout) };
};

/**
 * Reads the structure of a page or frame.
 * @param secrets values that must not appear (the view goes into result.json)
 * @param look    for a learned look: { ignore }, the controls in its masked areas are left out (controlsProbe); then without layout
 * @param texts   values that are data on this screen (the run tag, remembered values; layoutProbe)
 */
export const structureOf = async (page, { secrets = [], look = null, texts = [] } = {}) => {
    const [controls, aria, layout] = await Promise.all([
        page.evaluate(controlsProbe, { style: true, look }),
        page.locator('body').ariaSnapshot({ timeout: RENDER_TIMEOUT_MS }),
        look === null ? page.evaluate(layoutProbe, { texts }) : undefined,
    ]);
    if (layout === undefined) return structureFrom({ controls, aria: await redactFor(page, aria, secrets), texts });
    // Texts go into result.json like the view: one redaction for all of them.
    const shown = layout.filter(({ text }) => text !== undefined);
    const ariaLines = aria.split('\n').length;
    const redacted = (await redactFor(page, [aria, ...shown.map(({ text }) => text)].join('\n'), secrets)).split('\n');
    shown.forEach((element, index) => { element.text = redacted[ariaLines + index] ?? ''; });
    return structureFrom({ controls, aria: redacted.slice(0, ariaLines).join('\n'), layout, texts });
};

/**
 * Target against actual. Missing lines, differing styles, a layout that differs beyond the tolerance and changed texts mean the
 * design is not met; extra lines are only reported, since a design usually leaves out the app's frame (navigation, header).
 * Data (layoutProbe) is compared only by place and font.
 * @returns { met, missing, extra, styleDiffs, layoutDiffs, textDiffs } with lines as `button "Save": color #ffffff → #000000`,
 *          `gap heading "Note" → textarea "Note": 8px → 32px`, `text heading "Note" → "Notes"`
 */
export const compareStructure = (target, actual, { tolerance = LAYOUT_TOLERANCE_PX } = {}) => {
    const has = new Set(actual.lines);
    const wanted = new Set(target.lines);
    let missing = target.lines.filter((line) => !has.has(line));
    let extra = actual.lines.filter((line) => !wanted.has(line));
    const styleDiffs = Object.entries(target.styles).flatMap(([control, style]) => {
        const now = actual.styles[control];
        if (now === undefined) return [];
        return Object.entries(style).filter(([name, value]) => now[name] !== undefined && now[name] !== value).map(([name, value]) => `${control}: ${name} ${value} → ${now[name]}`);
    });
    const elements = target.elements ?? [];
    const present = actual.elements ?? [];
    styleDiffs.push(...styleLinesOf(elements, present));
    const { changed, missing: gone } = textChanges(elements, present);
    const textDiffs = changed.map(({ element, now }) => t('session.design.text', { element: element.tag === 'text' ? `"${element.text}"` : element.shown, now: `"${now.text}"` }));
    // A changed heading or link is told by its text, not again as a missing and an extra view line.
    const quoted = (texts) => (line) => line.startsWith('- ') && texts.some((text) => line.includes(`"${text}"`));
    const wasTold = quoted(changed.map(({ element }) => element.text));
    const nowTold = quoted(changed.map(({ now }) => now.text));
    missing = missing.filter((line) => !wasTold(line));
    extra = extra.filter((line) => !nowTold(line));
    for (const element of gone) if (!missing.some((line) => line.includes(`"${element.text}"`))) missing.push(element.shown);
    const layoutDiffs = layoutLines(layoutMeasures(elements, present), tolerance);
    return { met: missing.length === 0 && styleDiffs.length === 0 && layoutDiffs.length === 0 && textDiffs.length === 0, missing, extra, styleDiffs, layoutDiffs, textDiffs };
};

/**
 * Renders a design page: own context, JavaScript and network off, at the step's viewport. The HTML is set as content, so
 * nothing outside caw/design is read and nothing goes out.
 * @returns the page; the caller closes its context
 */
export const renderDesign = async (browser, html, viewport = DEFAULT_VIEWPORT) => {
    const context = await browser.newContext({ viewport, javaScriptEnabled: false, offline: true, serviceWorkers: 'block' });
    await context.route(/^(?!data:|about:)/, (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    return page;
};

/** A judged design in one line, as evidence and note. */
export const designText = ({ file, missing = [], extra = [], styleDiffs = [], layoutDiffs = [], textDiffs = [] }) => [
    file,
    ...(missing.length === 0 ? [] : [t('session.design.missing', { list: missing.join('; ') })]),
    ...(textDiffs.length === 0 ? [] : [t('session.design.texts', { list: textDiffs.join('; ') })]),
    ...(styleDiffs.length === 0 ? [] : [t('session.design.styles', { list: styleDiffs.join('; ') })]),
    ...(layoutDiffs.length === 0 ? [] : [t('session.design.layout', { list: layoutDiffs.join('; ') })]),
    ...(extra.length === 0 ? [] : [t('session.design.extra', { list: extra.join('; ') })]),
].join(' ');

/**
 * Judges the target designs of a run. The design browser starts on the first design and is separate from the app's: headless,
 * no profile, no network, no scripts.
 * @param cawDir  the project's caw folder
 * @param launch  () => a Playwright Browser (same binary as the session)
 * @param read    (path) => file text, for tests
 * @returns { judge(design, page), close() }; judge returns { file, verdict, missing?, extra?, styleDiffs?, layoutDiffs?,
 *          textDiffs?, note? } with verdict met, not-met, missing (no such file under caw/design). `design.texts`: values that
 *          are data in this run (the run tag, remembered values), the same on both sides
 */
export const createDesignJudge = ({ cawDir, launch, read, secrets = () => [] }) => {
    let browser = null;
    return {
        judge: async ({ file, viewport, texts = [] }, page) => {
            const path = designPath(cawDir, file);
            if (path === null) return { file, verdict: 'missing', note: t('session.design.noFile', { file }) };
            browser ??= await launch();
            const html = await read(path);
            const rendered = await renderDesign(browser, html, viewport ?? DEFAULT_VIEWPORT);
            try {
                const target = await structureOf(rendered, { texts });
                const actual = await structureOf(page, { secrets: secrets(), texts });
                const { met, ...found } = compareStructure(target, actual);
                return { file, verdict: met ? 'met' : 'not-met', ...found };
            } finally {
                await rendered.context().close().catch(() => {});
            }
        },
        close: async () => {
            await browser?.close().catch(() => {});
            browser = null;
        },
    };
};

/**
 * Is the first pending step ready to record? Its `needs` locators must each find exactly one reachable element in the state the
 * run ended in. Never run as code: they are locators, parsed like a recording's targets.
 * @returns the locators that are missing
 */
export const missingNeeds = async (framework, root, needs, { timeoutMs = NEEDS_TIMEOUT_MS } = {}) => {
    const missing = [];
    for (const code of needs) {
        const { element } = await waitForLocator(framework, root, code, { timeoutMs }).catch(() => ({ element: null }));
        if (element === null) missing.push(code);
        else await element.dispose().catch(() => {});
    }
    return missing;
};
