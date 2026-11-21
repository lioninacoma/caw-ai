// The visual layer: what a step's screen looks like, in pixels and in computed styles. Three uses build on the same capture:
// a .png target design is judged pixel by pixel, design tokens are linted per reached state, and a learned look (visual
// regression, per step with `look: true`) is compared in later runs. Everything is decided without AI and without a new dependency: PNGs are decoded and
// compared in a Chrome canvas, the design browser's (design.mjs), which has neither the app's scripts nor network.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { t } from '../shared/i18n.mjs';
import { RECORDING_DIR } from '../shared/names.mjs';
import { roleAndName } from './accessible-name.mjs';
import { compareStructure, cssHex, designPath, listDesigns, renderDesign, structureOf } from './design.mjs';

/**
 * Thresholds until measured (e2e/spike/visual): conservative, so that noise between runs does not fail a step.
 * - tolerance: per color channel (0-255), a smaller difference is the same pixel (anti-aliasing, font hinting);
 * - maxRatio: share of differing pixels a learned look may have (visual regression);
 * - designMaxRatio: the same against a .png target design, which is drawn by hand or exported and never matches exactly.
 */
export const DEFAULT_VISUAL = { tolerance: 24, maxRatio: 0.01, designMaxRatio: 0.03 };
/** The config's visual settings with the defaults. */
export const visualSettings = (config = {}) => ({ ...DEFAULT_VISUAL, screenshots: false, ...(config.visual ?? {}), ignore: config.visualIgnore ?? [] });

/** Healthy runs until a look counts as learned. Not the effects' number: the baseline spike did not measure looks. */
export const LOOK_LEARN_RUNS = 2;
const LEARN_RUNS = LOOK_LEARN_RUNS;

// A capture waits this long for its masks; the page is quiet after a passed check, it only has to measure.
const MASK_TIMEOUT_MS = 5000;
const MAX_MASKS = 400;
const COMPARE_TIMEOUT_MS = 20_000;

/**
 * Runs in the browser: boxes of what differs from run to run although the app is right, in CSS pixels of the viewport.
 * - text containing the run tag or a remembered value (`texts`);
 * - numeric dates (11/23/2026, 23.11.2026, 2026-11-23): a screen also shows creation and change dates that no placeholder
 *   (dates.mjs) covers, since only dates near today become placeholders;
 * - rows of lists and tables (as effects.mjs counts them), list entries and cards (`li`, listitem, `article`): data, often of
 *   other records. Header rows stay, and so do entries of navigation, menus and tab lists: they are the app's, not data;
 * - what the config's `visualIgnore` selectors find (an invalid selector finds nothing).
 * @returns [{ x, y, width, height, why }]
 */
export function maskProbe({ texts, ignore, max }) {
    const boxes = [];
    const add = (rect, why) => {
        if (boxes.length >= max || rect.width <= 0 || rect.height <= 0) return;
        boxes.push({ x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.ceil(rect.width) + 1, height: Math.ceil(rect.height) + 1, why });
    };
    const shown = (node) => node !== null && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const wanted = texts.filter((text) => typeof text === 'string' && text.length >= 3);
    const DATE = /(?<!\d)(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})(?!\d)/;
    const varies = (text) => DATE.test(text) || wanted.some((value) => text.includes(value));
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!varies(node.data) || !shown(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) add(rect, 'text');
    }
    // Field contents are no text nodes.
    for (const field of document.querySelectorAll('input, textarea')) {
        if (typeof field.value === 'string' && varies(field.value) && shown(field)) add(field.getBoundingClientRect(), 'text');
    }
    for (const row of document.querySelectorAll('[role=row], [role=option], [role=treeitem], tr')) {
        if (row.querySelector('th, [role=columnheader]') === null && shown(row)) add(row.getBoundingClientRect(), 'row');
    }
    const NAVIGATION = 'nav, [role=navigation], [role=menu], [role=menubar], [role=tablist], [role=toolbar]';
    for (const entry of document.querySelectorAll('li:not([role]), [role=listitem], article, [role=article]')) {
        const card = entry.matches('article, [role=article]');
        if ((card || entry.closest(NAVIGATION) === null) && shown(entry)) add(entry.getBoundingClientRect(), 'row');
    }
    for (const selector of ignore) {
        let found = [];
        try {
            found = [...document.querySelectorAll(selector)];
        } catch {
            continue;
        }
        for (const node of found) if (shown(node)) add(node.getBoundingClientRect(), 'ignore');
    }
    return boxes;
}

/**
 * Captures the step's screen at the recorded viewport: in a plain page its viewport, in the workbench the app frame unscaled
 * (workbench.unscaled lifts the fit-to-pane scale for the moment of the capture). CSS pixels, so a 125 % display gives the
 * same image as CI.
 * @param page      session.page(): a page or the workbench's frame view
 * @param unscaled  (shoot) => the workbench's unscaled capture, or undefined without a workbench
 * @param texts     run tag and remembered values: masked
 * @param ignore    the config's visualIgnore selectors
 * @returns { png: Buffer, masks, width, height }
 */
export const captureStep = async (page, { unscaled, texts = [], ignore = [] } = {}) => {
    const masks = await Promise.race([
        page.mainFrame().evaluate(maskProbe, { texts, ignore, max: MAX_MASKS }),
        new Promise((resolve) => { setTimeout(() => resolve([]), MASK_TIMEOUT_MS).unref?.(); }),
    ]).catch(() => []);
    // Animations are left alone: finishing them fires animationend in the app, which a capture must not cause.
    const shoot = () => page.screenshot({ scale: 'css', caret: 'hide' });
    const png = page.isFrameView === true && unscaled !== undefined ? await unscaled(shoot) : await shoot();
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    return { png, masks, width, height };
};

/**
 * Runs in the comparison page: decodes both PNGs, draws the target at the actual image's width (a @2x export is scaled down),
 * compares the common area pixel by pixel and paints the difference: differing pixels red, masked ones blue, the rest faded.
 * @returns { width, height, compared, differing, scaled, cropped, diff: data URL }
 */
async function comparePng({ actual, target, masks, tolerance }) {
    const bitmap = (base64) => createImageBitmap(new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], { type: 'image/png' }));
    const [a, b] = await Promise.all([bitmap(actual), bitmap(target)]);
    const width = a.width;
    const scale = width / b.width;
    const targetHeight = Math.round(b.height * scale);
    const height = Math.min(a.height, targetHeight);
    const pixels = (image, drawnHeight) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        // Transparency counts as white, as the page behind a design usually is.
        context.fillStyle = '#fff';
        context.fillRect(0, 0, width, height);
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, width, drawnHeight);
        return context.getImageData(0, 0, width, height).data;
    };
    const pa = pixels(a, a.height);
    const pb = pixels(b, targetHeight);
    const masked = new Uint8Array(width * height);
    for (const { x, y, width: w, height: h } of masks) {
        for (let row = Math.max(0, y); row < Math.min(height, y + h); row += 1) masked.fill(1, row * width + Math.max(0, x), row * width + Math.max(0, Math.min(width, x + w)));
    }
    const out = new ImageData(width, height);
    let compared = 0;
    let differing = 0;
    for (let index = 0; index < width * height; index += 1) {
        const at = index * 4;
        out.data[at + 3] = 255;
        if (masked[index] === 1) {
            out.data[at] = 120; out.data[at + 1] = 160; out.data[at + 2] = 255;
            continue;
        }
        compared += 1;
        const delta = Math.max(Math.abs(pa[at] - pb[at]), Math.abs(pa[at + 1] - pb[at + 1]), Math.abs(pa[at + 2] - pb[at + 2]));
        if (delta > tolerance) {
            differing += 1;
            out.data[at] = 230; out.data[at + 1] = 30; out.data[at + 2] = 40;
        } else {
            const gray = Math.round((pa[at] + pa[at + 1] + pa[at + 2]) / 3);
            out.data[at] = out.data[at + 1] = out.data[at + 2] = 200 + Math.round(gray / 255 * 55);
        }
    }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(out, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const diff = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
    return { width, height, compared, differing, scaled: scale !== 1, cropped: a.height !== targetHeight, diff };
}

/**
 * Compares two PNGs in a page of `browser` (its own context: offline, nothing loads).
 * @param masks     boxes in the actual image's CSS pixels: neither image counts there
 * @param tolerance per color channel
 * @returns { ratio, width, height, compared, differing, scaled, cropped, diffPng: Buffer }
 */
export const comparePixels = async (browser, actual, target, { masks = [], tolerance = DEFAULT_VISUAL.tolerance } = {}) => {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    try {
        await context.route(/^(?!data:|about:|blob:)/, (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(COMPARE_TIMEOUT_MS);
        const result = await page.evaluate(comparePng, { actual: actual.toString('base64'), target: target.toString('base64'), masks, tolerance });
        const diffPng = Buffer.from(result.diff.slice(result.diff.indexOf(',') + 1), 'base64');
        return { ratio: result.compared === 0 ? 0 : result.differing / result.compared, width: result.width, height: result.height, compared: result.compared, differing: result.differing, scaled: result.scaled, cropped: result.cropped, diffPng };
    } finally {
        await context.close().catch(() => {});
    }
};

/** A ratio as people read it: 0.4 %. */
export const percent = (ratio) => `${Math.round(ratio * 1000) / 10} %`;

/** The design file's content hash: part of the visual basis, so a new design invalidates the look learned against the old. */
export const fileHash = (path) => (path === null || !existsSync(path) ? undefined : createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12));

// ---------------------------------------------------------------------------------------------------------------- token lint

/**
 * Runs in the browser: what the lint needs of each visible element, without values of fields. `nameOf` is roleAndName.
 * @returns [{ path, label, colors, spacing, text?, clipped?, unnamed? }]
 */
export function lintProbe(nameOf, { max }) {
    const CONTROL = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=combobox], [role=textbox], [role=menuitem], [role=switch]';
    const transparent = (value) => value === 'transparent' || /^rgba\(.*,\s*0\)$/.test(value);
    const pathOf = (node) => {
        const parts = [];
        for (let element = node; element !== null && element !== document.documentElement; element = element.parentElement) {
            let index = 1;
            for (let sibling = element.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) if (sibling.tagName === element.tagName) index += 1;
            parts.unshift(`${element.tagName.toLowerCase()}:nth-of-type(${index})`);
        }
        return parts.join(' > ');
    };
    const labelOf = (node) => {
        let named = null;
        try { named = nameOf(node); } catch { /* no role */ }
        if (named !== null) return `${named.role} "${named.name.slice(0, 40)}"`;
        const text = (node.innerText ?? '').trim().split('\n')[0].slice(0, 40);
        return text === '' ? node.tagName.toLowerCase() : `${node.tagName.toLowerCase()} "${text}"`;
    };
    // The color behind a text: the first opaque background up the tree. A background image makes it unknown.
    const backgroundOf = (node) => {
        for (let element = node; element !== null; element = element.parentElement) {
            const style = getComputedStyle(element);
            if (style.backgroundImage !== 'none') return null;
            if (!transparent(style.backgroundColor)) return style.backgroundColor;
        }
        return 'rgb(255, 255, 255)';
    };
    const ownText = (node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.data.trim() !== '');
    const facts = [];
    for (const node of document.body?.querySelectorAll('*') ?? []) {
        if (facts.length >= max) break;
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BR'].includes(node.tagName)) continue;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || node.getClientRects().length === 0) continue;
        const text = ownText(node);
        const colors = [
            ...(text ? [style.color] : []),
            ...(transparent(style.backgroundColor) ? [] : [style.backgroundColor]),
            ...(parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none' && !transparent(style.borderTopColor) ? [style.borderTopColor] : []),
        ];
        const spacing = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap']
            .map((key) => parseFloat(style[key])).filter((value) => Number.isFinite(value) && value > 0);
        const clips = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY) || style.textOverflow === 'ellipsis';
        const clipped = text && clips && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
        let unnamed = false;
        if (node.matches(CONTROL)) {
            try { unnamed = nameOf(node) === null; } catch { unnamed = true; }
        }
        if (colors.length === 0 && spacing.length === 0 && !text && !unnamed) continue;
        facts.push({
            path: pathOf(node),
            label: labelOf(node),
            colors,
            spacing,
            ...(text ? { text: { color: style.color, background: backgroundOf(node), size: parseFloat(style.fontSize), weight: Number(style.fontWeight) || 400 } } : {}),
            ...(clipped ? { clipped: true } : {}),
            ...(unnamed ? { unnamed: true } : {}),
        });
    }
    return facts;
}

/** Reads the lint facts of a page or frame. */
export const lintFacts = (frame, { max = 1500 } = {}) => frame.evaluate(`(${lintProbe})(${roleAndName}, ${JSON.stringify({ max })})`);

const hexRgb = (hex) => {
    const value = String(hex).trim().replace(/^#/, '');
    const full = value.length === 3 || value.length === 4 ? [...value.slice(0, 3)].map((char) => char + char).join('') : value.slice(0, 6);
    if (!/^[\da-f]{6}$/i.test(full)) return null;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
};
const rgbOf = (css) => hexRgb(cssHex(css));

/** A DTCG color value: a hex string, or the 2025 object form with `hex` or sRGB components. */
const tokenColor = (value) => {
    if (typeof value === 'string') return hexRgb(value);
    if (value !== null && typeof value === 'object') {
        if (typeof value.hex === 'string') return hexRgb(value.hex);
        if (Array.isArray(value.components) && (value.colorSpace ?? 'srgb') === 'srgb') return value.components.slice(0, 3).map((part) => Math.round(Number(part) * 255));
    }
    return null;
};
const pxOf = (value) => {
    const text = typeof value === 'object' && value !== null ? `${value.value}${value.unit}` : String(value);
    const match = /^(-?\d+(?:\.\d+)?)(px|rem|em)?$/.exec(text.trim());
    if (match === null) return null;
    return Number(match[1]) * (match[2] === 'rem' || match[2] === 'em' ? 16 : 1);
};
const SPACING_GROUP = /^(?:spacing|spacings|space|spaces|gap|gaps)$/i;

/**
 * The tokens the lint uses, from every DTCG file under caw/design (tokens.json, brand.tokens.json): colors by name, and the
 * spacing scale (dimensions in a group named spacing, space or gap). `$type` is inherited from the group.
 * @returns { colors: [{ name, rgb }], spacing: [px] }, or null without a tokens file: then nothing is linted
 */
export const readTokens = (cawDir) => {
    const colors = [];
    const spacing = [];
    const walk = (node, path, type) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
        const own = typeof node.$type === 'string' ? node.$type : type;
        if (Object.hasOwn(node, '$value')) {
            if (own === 'color' && tokenColor(node.$value) !== null) colors.push({ name: path.join('.'), rgb: tokenColor(node.$value) });
            if (own === 'dimension' && path.slice(0, -1).some((part) => SPACING_GROUP.test(part)) && pxOf(node.$value) !== null) spacing.push(pxOf(node.$value));
            return;
        }
        for (const [key, inner] of Object.entries(node)) if (!key.startsWith('$')) walk(inner, [...path, key], own);
    };
    const files = listDesigns(cawDir).filter(({ kind }) => kind === 'tokens');
    if (files.length === 0) return null;
    for (const { file } of files) {
        try {
            walk(JSON.parse(readFileSync(join(cawDir, file), 'utf8')), [], undefined);
        } catch {
            // caw_design checked it on writing; a hand-edited broken file only lints nothing.
        }
    }
    return { colors, spacing: [...new Set(spacing.map((value) => Math.round(value)))].filter((value) => value > 0).sort((a, b) => a - b) };
};

// CIE76 on Lab: below about 2.3 people see no difference; 3 leaves room for rounding in exports.
const SAME_COLOR = 3;
const lab = ([r, g, b]) => {
    const linear = (channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const [lr, lg, lb] = [r, g, b].map(linear);
    const xyz = [(lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047, lr * 0.2126 + lg * 0.7152 + lb * 0.0722, (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883];
    const f = (value) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
    const [fx, fy, fz] = xyz.map(f);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
export const colorDistance = (a, b) => {
    const [la, lb] = [lab(a), lab(b)];
    return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
};

const luminance = ([r, g, b]) => {
    const channel = (value) => {
        const part = value / 255;
        return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
/** WCAG contrast ratio of two colors, 1 to 21. */
export const contrastRatio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
};
// WCAG AA: 4.5 for text, 3 for large text (24 px, or 18.66 px bold).
const needed = ({ size, weight }) => (size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5);

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const hexText = (rgb) => `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
const MAX_FINDINGS = 12;

/**
 * The lint findings of one state, grouped so that one wrong color on twenty elements is one line.
 * - color: a color that is no token (only with color tokens), with the nearest token;
 * - spacing: padding, margin or gap off the spacing scale (only with spacing tokens): neither a token nor a multiple of their
 *   greatest common divisor;
 * - contrast: text below WCAG AA against its background;
 * - clipped: text cut off by its box;
 * - unnamed: a control without an accessible name.
 * @returns [{ rule, text, label, path, count }]
 */
export const lintFindings = (facts, tokens = { colors: [], spacing: [] }) => {
    const groups = new Map();
    const add = (key, rule, fact, vars) => {
        const known = groups.get(key);
        if (known !== undefined) {
            known.count += 1;
            return;
        }
        groups.set(key, { rule, label: fact.label, path: fact.path, count: 1, vars });
    };
    const grid = tokens.spacing.length === 0 ? null : tokens.spacing.reduce(gcd);
    for (const fact of facts) {
        if (tokens.colors.length > 0) {
            for (const css of new Set(fact.colors)) {
                const rgb = rgbOf(css);
                if (rgb === null) continue;
                const nearest = tokens.colors.map((token) => ({ ...token, distance: colorDistance(rgb, token.rgb) })).sort((a, b) => a.distance - b.distance)[0];
                if (nearest.distance > SAME_COLOR) add(`color ${hexText(rgb)}`, 'color', fact, { value: hexText(rgb), token: nearest.name, tokenValue: hexText(nearest.rgb), distance: Math.round(nearest.distance * 10) / 10 });
            }
        }
        if (grid !== null) {
            for (const value of new Set(fact.spacing.map((px) => Math.round(px)))) {
                if (value > 0 && !tokens.spacing.includes(value) && value % grid !== 0) add(`spacing ${value}`, 'spacing', fact, { value: `${value}px`, grid: `${grid}px` });
            }
        }
        if (fact.text !== undefined && fact.text.background !== null) {
            const [fg, bg] = [rgbOf(fact.text.color), rgbOf(fact.text.background)];
            if (fg !== null && bg !== null) {
                const ratio = contrastRatio(fg, bg);
                const minimum = needed(fact.text);
                if (ratio < minimum) add(`contrast ${hexText(fg)} ${hexText(bg)}`, 'contrast', fact, { color: hexText(fg), background: hexText(bg), ratio: Math.round(ratio * 100) / 100, minimum });
            }
        }
        if (fact.clipped) add(`clipped ${fact.path}`, 'clipped', fact, {});
        if (fact.unnamed) add(`unnamed ${fact.path}`, 'unnamed', fact, {});
    }
    return [...groups.values()].slice(0, MAX_FINDINGS * 5).map(({ rule, label, path, count, vars }) => ({
        rule,
        label,
        path,
        count,
        text: t(`session.lint.${rule}`, { ...vars, label, count, more: count > 1 ? t('session.lint.more', { count: count - 1 }) : '' }),
    }));
};

/** The findings in one sentence, at most a few, for warnings and the step's note. */
export const lintText = (findings) => {
    const shown = findings.slice(0, MAX_FINDINGS).map(({ text }) => text);
    return findings.length > MAX_FINDINGS ? `${shown.join('; ')}; ${t('session.lint.andMore', { count: findings.length - MAX_FINDINGS })}` : shown.join('; ');
};

// ----------------------------------------------------------------------------------------------------------- visual regression

/**
 * The computed styles per control (design.mjs structureFrom) as lines, the part of a look that YAML can show: one line per
 * role and style with how many controls have it, `button ×3: color #ffffff, font-size 13px`. Not by the control's name:
 * names carry data (`button "Complete Feed the raven"`), a look is what the controls look like.
 */
export const styleLines = (styles) => {
    const count = new Map();
    for (const [control, style] of Object.entries(styles)) {
        const role = control.split(' ')[0];
        const key = `${role}: ${Object.entries(style).map(([name, value]) => `${name} ${value}`).join(', ')}`;
        count.set(key, (count.get(key) ?? 0) + 1);
    }
    return [...count].map(([key, times]) => key.replace(': ', ` ×${times}: `)).sort();
};

// A style line's parts: `button ×3: color #fff` is { key: 'button: color #fff', role: 'button', style: 'color #fff', count: 3 };
// `×?` (the count differed while learning) has count null.
const COUNTED = /^(\S+) ×(\d+|\?): (.*)$/;
const lineParts = (line) => {
    const match = COUNTED.exec(line);
    if (match === null) return { key: line, role: line, style: '', count: null };
    return { key: `${match[1]}: ${match[3]}`, role: match[1], style: match[3], count: match[2] === '?' ? null : Number(match[2]) };
};
const byKey = (lines) => new Map(lines.map((line) => [lineParts(line).key, lineParts(line)]));

/**
 * Style lines of two runs while learning: a role and style both have with the same count stays as it is; one whose count
 * differs, or that only one run has, keeps its style with `×?` (there, any number is right, also none).
 */
const mergeStyles = (learned, now) => {
    const [was, is] = [byKey(learned), byKey(now)];
    const keys = [...new Set([...was.keys(), ...is.keys()])];
    return keys.map((key) => {
        const { role, style } = was.get(key) ?? is.get(key);
        const same = was.get(key)?.count !== null && was.get(key)?.count === is.get(key)?.count;
        return same ? `${role} ×${was.get(key).count}: ${style}` : `${role} ×?: ${style}`;
    }).sort();
};

/** Where a learned look's image lives, relative to the project: per test and step, per platform (fonts render differently). */
export const lookImage = (test, step, platform = process.platform) => `${RECORDING_DIR}/${test}/${step}.${platform}.png`;

/**
 * What a learned look is valid for: the state its step starts in (the previous step's recording time, as for effects) and its
 * target design's content. A re-recorded earlier step or a new design makes it learn anew.
 */
export const lookBasis = (spec, step, designHash) => {
    const previous = spec.steps[spec.steps.findIndex(({ id }) => id === step.id) - 1]?.recording?.recordedAt;
    const parts = [...(previous === undefined ? [] : [previous]), ...(designHash === undefined ? [] : [`design:${designHash}`])];
    return parts.length === 0 ? undefined : parts.join(' ');
};

/** The step's learned look if it belongs to this basis, else undefined (learn anew). */
export const currentLook = (step, basis) => {
    const look = step.recording?.visual;
    return look === undefined || look.basis !== basis ? undefined : look;
};

/** The step's design content hash, when it has a design file. */
const designHashOf = (cawDir, step) => (step.design === undefined ? undefined : fileHash(designPath(cawDir, step.design)));

/**
 * What differs from the learned style lines in this run, in plain words: a role and style with fewer or more controls than
 * learned (`1 button fewer with color #000000`), also none any more, or a role and style that was not there. A `×?` line
 * allows any number.
 */
const styleChanges = (learned, now) => {
    const [was, is] = [byKey(learned), byKey(now)];
    const changes = [];
    for (const [key, { role, style, count }] of was) {
        const seen = is.get(key)?.count ?? 0;
        if (count === null || seen === count) continue;
        changes.push(t(seen < count ? 'session.visual.fewer' : 'session.visual.more', { count: Math.abs(seen - count), role, style }));
    }
    for (const [key, { role, style, count }] of is) if (!was.has(key)) changes.push(t('session.visual.more', { count, role, style }));
    return changes;
};

/**
 * The visual layer after a passed check (playReplay `look`): screenshot (opt-in), token lint (when caw/design has tokens) and
 * the learned look (visual regression, for steps with `look: true`). Lint and look fail the step only when design.fail names
 * them, else they warn. Pixels of a look are learned and compared only headless: the viewport is fixed there (the recorded
 * one, else the headless default), while a window's app view has the size of its pane. A run in a window compares the style
 * lines only and leaves the image as it is.
 * @param settings   visualSettings(config)
 * @param pixels     headless run: the image is learned and compared too
 * @param tokens     readTokens(cawDir), or null: no lint
 * @param compare    (actual, target, masks) => comparePixels result, in the design browser
 * @param save       (name, png) => the file name in the run folder, or undefined
 * @param readImage  (path) => Buffer or null
 * @param secrets    () => values the style lines must not show
 * @returns (id, { capture, page }) => { record, warnings, fail?, observed? }
 */
export const createLook = ({ spec, cawDir, root, settings, tokens = null, compare, save, readImage, designFail = [], secrets = () => [], platform = process.platform, pixels = true }) => {
    const steps = new Map(spec.steps.map((step) => [step.id, step]));
    return async (id, { capture, page }) => {
        const record = {};
        const warnings = [];
        let fail;
        let observed;
        if (capture === undefined) return { record, warnings };
        if (settings.screenshots) {
            const name = save(`step-${id}.png`, (await capture()).png);
            if (name !== undefined) record.screenshot = name;
        }
        if (tokens !== null) {
            const findings = lintFindings(await lintFacts(page.mainFrame()), tokens);
            if (findings.length > 0) {
                record.lint = findings;
                const text = t('session.lint.found', { id, list: lintText(findings) });
                if (designFail.includes('lint')) fail = { kind: 'design', text, evidence: lintText(findings) };
                else warnings.push({ type: 'lint', text });
            }
        }
        const step = steps.get(id);
        if (step?.look === true && step.recording !== undefined) {
            const basis = lookBasis(spec, step, designHashOf(cawDir, step));
            const learned = currentLook(step, basis);
            const shot = pixels ? await capture() : undefined;
            const styles = styleLines((await structureOf(page, { secrets: secrets() })).styles);
            let imageRuns = pixels ? learned?.images?.[platform] ?? 0 : 0;
            const stored = imageRuns === 0 ? null : readImage(join(root, lookImage(spec.id, id, platform)));
            // The YAML names an image that is not there (not committed, deleted): learned anew.
            if (stored === null) imageRuns = 0;
            const compared = stored === null ? null : await compare(shot.png, stored, shot.masks);
            const ratio = compared?.ratio;
            const stylesLearned = (learned?.runs ?? 0) >= LEARN_RUNS;
            const changedStyles = stylesLearned ? styleChanges(learned.styles, styles) : [];
            const changedPixels = imageRuns >= LEARN_RUNS && ratio > settings.maxRatio;
            const changed = changedStyles.length > 0 || changedPixels;
            const diff = changedPixels ? save(`step-${id}-look-diff.png`, compared.diffPng) : undefined;
            // In a window the styles alone decide; `pixels` says that the image was not looked at.
            const verdict = changed ? 'changed' : stylesLearned && (!pixels || imageRuns >= LEARN_RUNS) ? 'same' : 'learning';
            record.visual = { verdict, ...(pixels ? {} : { pixels: 'headless-only' }), ...(ratio === undefined ? {} : { ratio }), ...(diff === undefined ? {} : { diff }), ...(changedStyles.length === 0 ? {} : { styles: changedStyles }) };
            observed = { ...(pixels ? { png: shot.png, imageRuns } : {}), styles, ...(ratio === undefined ? {} : { ratio }), ...(basis === undefined ? {} : { basis }), platform, changed };
            if (changed) {
                const details = [
                    ...(changedPixels ? [t('session.visual.pixels', { ratio: percent(ratio), max: percent(settings.maxRatio), diff: diff ?? '-' })] : []),
                    ...(changedStyles.length === 0 ? [] : [t('session.visual.styles', { list: changedStyles.join('; ') })]),
                ].join(' ');
                const text = t('session.visual.changed', { id, details });
                if (designFail.includes('visual')) fail ??= { kind: 'visual', text, evidence: details };
                else warnings.push({ type: 'visual', text });
            }
        }
        return { record, warnings, ...(fail === undefined ? {} : { fail }), ...(observed === undefined ? {} : { observed }) };
    };
};

/**
 * One step's look after a healthy run, learned like effects: the first run stores it, a second one that matches confirms it
 * (LEARN_RUNS). A count that differs while learning becomes `×?` (mergeStyles); an image that differs while learning is
 * replaced and counts from one again. A run in a window (no `png`) learns the styles only. A learned look stays as it is.
 * @returns { visual, png? } or null when nothing changes; `png` { platform, data } is the image to write
 */
export const learnLook = (current, observed, { maxRatio }) => {
    const runs = current?.runs ?? 0;
    const learnedStyles = runs >= LEARN_RUNS;
    const styles = current === undefined ? observed.styles : learnedStyles ? current.styles : mergeStyles(current.styles, observed.styles);
    const images = { ...(current?.images ?? {}) };
    let png;
    if (observed.png === undefined) {
        // A window's view: its image is not comparable, the stored one stays.
    } else if (observed.imageRuns === 0) {
        images[observed.platform] = 1;
        png = { platform: observed.platform, data: observed.png };
    } else if (observed.imageRuns < LEARN_RUNS) {
        if (observed.ratio !== undefined && observed.ratio <= maxRatio) images[observed.platform] = observed.imageRuns + 1;
        else {
            images[observed.platform] = 1;
            png = { platform: observed.platform, data: observed.png };
        }
    }
    const visual = { runs: learnedStyles ? runs : runs + 1, ...(observed.basis === undefined ? {} : { basis: observed.basis }), styles, images, ...(current?.adopted === undefined ? {} : { adopted: current.adopted }) };
    if (png === undefined && JSON.stringify(visual) === JSON.stringify(current)) return null;
    return { visual, ...(png === undefined ? {} : { png }) };
};

/**
 * Looks to learn from a run: passed steps only, only on the target the step was recorded on, never a step whose look changed.
 * @param seen playReplay's seenLooks
 * @returns Map step -> { visual, png? }
 */
export const learnedLooks = ({ spec, results, seen, target, maxRatio = DEFAULT_VISUAL.maxRatio }) => {
    const found = new Map();
    for (const step of spec.steps) {
        const observed = seen?.get(step.id);
        if (observed === undefined || observed.changed || step.recording === undefined || step.recording.recordedOn !== target || results.get(step.id)?.status !== 'pass') continue;
        const learned = learnLook(currentLook(step, observed.basis), observed, { maxRatio });
        if (learned !== null) found.set(step.id, learned);
    }
    return found;
};

/** Adds learned looks to the recordings; writeTest writes their images. The hash stays. */
export const withLooks = (spec, looks) => ({
    ...spec,
    steps: spec.steps.map((step) => (looks.has(step.id) && step.recording !== undefined
        ? { ...step, recording: { ...step.recording, visual: looks.get(step.id).visual, ...(looks.get(step.id).png === undefined ? {} : { lookPng: looks.get(step.id).png }) } }
        : step)),
});

/**
 * The human adopts the new look ("Adopt new look") of every step whose look changed in the run, at once: the styles count as
 * learned, and the day it was adopted goes along, which audit lists. The images of all platforms learn anew. A look seen in a
 * window has no comparable image: its stored image on this platform is deleted (`png.data` null, writeTest) and the next
 * headless runs learn it. One seen headless brings its image and counts as learned on this platform.
 * @param looks Map step -> observed (createLook)
 */
export const withAdoptedLooks = (spec, looks, day = new Date().toISOString().slice(0, 10)) => withLooks(spec, new Map([...looks].map(([id, observed]) => [id, {
    visual: {
        runs: LEARN_RUNS,
        ...(observed.basis === undefined ? {} : { basis: observed.basis }),
        styles: observed.styles,
        images: observed.png === undefined ? {} : { [observed.platform]: LEARN_RUNS },
        adopted: day,
    },
    png: { platform: observed.platform, data: observed.png ?? null },
}])));

// ------------------------------------------------------------------------------------------------------------ design overlay

/**
 * What the workbench lays over the app for `open <test>@S3 --design`: the design as an image at the recorded width (a .png as
 * it is, an .html rendered without scripts or network) and the deviations as rows. A row with `element` (a CSS path in the
 * app) hands that element to the attached session when clicked, as /element does.
 * @param page     the app (session.page())
 * @param launch   () => a Playwright Browser for the design (closed again here)
 * @param unscaled the workbench's unscaled capture, for the pixel row of a .png design
 * @returns { src, width, rows } or null without a design file
 */
export const designOverlay = async ({ cawDir, file, viewport, page, launch, settings, tokens = null, unscaled, secrets = [] }) => {
    const path = designPath(cawDir, file);
    if (path === null) return null;
    const browser = await launch();
    try {
        const rows = [];
        let image;
        if (path.toLowerCase().endsWith('.png')) {
            image = readFileSync(path);
            const shot = await captureStep(page, { unscaled, ignore: settings.ignore });
            const compared = await comparePixels(browser, shot.png, image, { masks: shot.masks, tolerance: settings.tolerance });
            rows.push({ text: t('session.design.pixelsRow', { ratio: percent(compared.ratio), max: percent(settings.designMaxRatio) }) });
        } else {
            const rendered = await renderDesign(browser, readFileSync(path, 'utf8'), viewport);
            try {
                image = await rendered.screenshot({ scale: 'css' });
                const { missing, styleDiffs } = compareStructure(await structureOf(rendered), await structureOf(page, { secrets }));
                rows.push(...missing.map((line) => ({ text: t('session.design.missingRow', { line }) })), ...styleDiffs.map((text) => ({ text })));
            } finally {
                await rendered.context().close().catch(() => {});
            }
        }
        if (tokens !== null) rows.push(...lintFindings(await lintFacts(page.mainFrame()), tokens).map(({ text, path: element, label }) => ({ text, element, label })));
        return { src: `data:image/png;base64,${image.toString('base64')}`, width: viewport.width, rows };
    } finally {
        await browser.close().catch(() => {});
    }
};

/** Runs in the app: marks the element at a CSS path (lintProbe) so markedTarget can name it; false when it is gone. */
export function markPath({ path, attribute, mark }) {
    const element = document.querySelector(path);
    if (element === null) return false;
    element.setAttribute(attribute, mark);
    return true;
}
