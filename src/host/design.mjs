// Target designs: a step may name a design (caw/design/<file>) that its screen should match. caw judges it without AI, by
// structure: the same controls, the same view lines and a few computed styles per control. A design comes from a person (Claude
// Design, Figma), the attached Claude Code session writes it with caw_design; caw itself never fetches anything.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { t } from '../shared/i18n.mjs';
import { controlsProbe } from './effects.mjs';
import { waitForLocator } from './framework/index.mjs';
import { redactFor } from './secrets.mjs';
import { DEFAULT_VISUAL, comparePixels, percent } from './visual.mjs';

export const DESIGN_DIR = 'design';
/** What a step's `design:` may name: a page (judged by structure) or an image (judged by pixels, visual.mjs). */
export const DESIGN_KINDS = ['.html', '.png'];
// A target design not met and a changed learned look fail their step (the look only on steps with look: true, once learned);
// the token lint only warns until design.fail names "lint".
export const DEFAULT_DESIGN_FAIL = ['target', 'visual'];
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
// How long `needs` waits for each locator at the end of a run: the page is already quiet, it only has to be there.
export const NEEDS_TIMEOUT_MS = 2000;
// The rendered design gets this long; it has neither scripts nor network, so it only parses and lays out.
const RENDER_TIMEOUT_MS = 10_000;

const SEGMENT = /^[\w-][\w.-]*$/;

/**
 * Is this a design path as a step names it: relative to the caw folder, under design/, plain segments (no `..`, no
 * absolute path, no backslashes), ending in .html or .png? Only the shape; designPath checks the file.
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
export const DESIGN_LIMITS = { html: 2 * 1024 * 1024, png: 8 * 1024 * 1024, tokens: 1024 * 1024 };
// A PNG larger than this on either side is no screen, whatever it claims.
const MAX_PNG_SIDE = 16_384;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The kind of a file caw_design writes: html, png, tokens (design tokens as DTCG JSON), or null. */
export const designKind = (name) => {
    if (typeof name !== 'string' || name.length > 200) return null;
    const segments = name.split('/');
    if (segments.length < 2 || segments[0] !== DESIGN_DIR || !segments.slice(1).every((segment) => SEGMENT.test(segment))) return null;
    const lower = name.toLowerCase();
    if (lower.endsWith('tokens.json')) return 'tokens';
    if (lower.endsWith('.html')) return 'html';
    if (lower.endsWith('.png')) return 'png';
    return null;
};

/** Width and height from a PNG's IHDR, or null when the bytes are no PNG. */
export const pngSize = (bytes) => {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/**
 * Design tokens in the DTCG format: groups of tokens, every leaf a token with `$value`. Keys with `$` are properties
 * ($type, $description, $extensions); everything else is a group or a token.
 * @returns a problem as text, or null
 */
export const tokensProblem = (value) => {
    let tokens = 0;
    const walk = (node, at) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) return t('run.mcp.designTokenLeaf', { at: at || '/' });
        if (Object.hasOwn(node, '$value')) {
            tokens += 1;
            return null;
        }
        for (const [key, inner] of Object.entries(node)) {
            if (key.startsWith('$')) continue;
            const problem = walk(inner, `${at}/${key}`);
            if (problem !== null) return problem;
        }
        return null;
    };
    const problem = walk(value, '');
    if (problem !== null) return problem;
    return tokens === 0 ? t('run.mcp.designTokensEmpty') : null;
};

/**
 * Checks what caw_design put would write. Nothing about the content is run: html is only rendered later without scripts.
 * @param data the file's bytes
 * @returns a problem as text, or null
 */
export const designProblem = (kind, data) => {
    if (data.length === 0) return t('run.mcp.designEmpty');
    if (data.length > DESIGN_LIMITS[kind]) return t('run.mcp.designTooLarge', { max: Math.round(DESIGN_LIMITS[kind] / 1024 / 1024) || 1 });
    if (kind === 'png') {
        const size = pngSize(data);
        if (size === null) return t('run.mcp.designNoPng');
        if (size.width < 1 || size.height < 1 || size.width > MAX_PNG_SIDE || size.height > MAX_PNG_SIDE) return t('run.mcp.designPngSize', { width: size.width, height: size.height, max: MAX_PNG_SIDE });
        return null;
    }
    const text = data.toString('utf8');
    if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(data)) return t('run.mcp.designNoText');
    if (kind === 'html') return /<(?:html|body|main|div|form|section)\b/i.test(text) ? null : t('run.mcp.designNoHtml');
    try {
        return tokensProblem(JSON.parse(text));
    } catch (error) {
        return t('run.mcp.designNoJson', { error: String(error.message).split('\n')[0] });
    }
};

/**
 * Writes a design file under caw/design. The folders on the way must not be links, and an existing file is replaced only if it
 * is a regular file: nothing ends up outside caw/design.
 * @returns { file, kind, bytes, replaced, width?, height? }
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
    return { file: name, kind, bytes: data.length, replaced, ...(kind === 'png' ? pngSize(data) : {}) };
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

/** The ARIA tree without data rows and free text, as view lines (viewLines). */
export const maskedView = (aria) => {
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
        if (!FREE_TEXT.test(line)) kept.push(line);
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

/**
 * The structure of a page as caw compares it: control lines, view lines and the styles per control (the same control twice is
 * told apart by its number: `button "Delete" #2`).
 * @param probe { controls: [{ line, style? }], aria } as read from the page
 * @returns { lines, styles: { <control>: { <css name>: value } } }
 */
export const structureFrom = ({ controls = [], aria = '' }) => {
    const count = new Map();
    const styles = {};
    const controlLines = controls.map(({ line, style }) => {
        const shown = withoutData(neutral(line));
        const seen = (count.get(shown) ?? 0) + 1;
        count.set(shown, seen);
        if (style !== undefined) styles[seen === 1 ? shown : `${shown} #${seen}`] = normalStyle(style);
        return shown;
    });
    return { lines: [...new Set([...controlLines, ...maskedView(aria)])], styles };
};

/** Reads the structure of a page or frame. @param secrets values that must not appear (the view goes into result.json) */
export const structureOf = async (page, { secrets = [] } = {}) => {
    const [controls, aria] = await Promise.all([
        page.evaluate(controlsProbe, true),
        page.locator('body').ariaSnapshot({ timeout: RENDER_TIMEOUT_MS }),
    ]);
    return structureFrom({ controls, aria: await redactFor(page, aria, secrets) });
};

/**
 * Target against actual. Missing lines and differing styles mean the design is not met; extra lines are only reported, since a
 * design usually leaves out the app's frame (navigation, header).
 * @returns { met, missing, extra, styleDiffs } with styleDiffs as `button "Save": color #ffffff → #000000`
 */
export const compareStructure = (target, actual) => {
    const has = new Set(actual.lines);
    const wanted = new Set(target.lines);
    const missing = target.lines.filter((line) => !has.has(line));
    const extra = actual.lines.filter((line) => !wanted.has(line));
    const styleDiffs = Object.entries(target.styles).flatMap(([control, style]) => {
        const now = actual.styles[control];
        if (now === undefined) return [];
        return Object.entries(style).filter(([name, value]) => now[name] !== undefined && now[name] !== value).map(([name, value]) => `${control}: ${name} ${value} → ${now[name]}`);
    });
    return { met: missing.length === 0 && styleDiffs.length === 0, missing, extra, styleDiffs };
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
export const designText = ({ file, missing = [], extra = [], styleDiffs = [] }) => [
    file,
    ...(missing.length === 0 ? [] : [t('session.design.missing', { list: missing.join('; ') })]),
    ...(styleDiffs.length === 0 ? [] : [t('session.design.styles', { list: styleDiffs.join('; ') })]),
    ...(extra.length === 0 ? [] : [t('session.design.extra', { list: extra.join('; ') })]),
].join(' ');

/**
 * Judges the target designs of a run. The design browser starts on the first design (or comparison) and is separate from the
 * app's: headless, no profile, no network; scripts run only in the comparison page, which holds nothing but the two images.
 * @param cawDir  the project's caw folder
 * @param launch  () => a Playwright Browser (same binary as the session)
 * @param read    (path) => file text, for tests
 * @param pixels  { tolerance, designMaxRatio } (visual.mjs visualSettings)
 * @param save    (name, png) => the file name the diff image was saved as, or undefined (nothing saved)
 * @returns { judge(design, page, { capture }), compare(actual, target, masks), close() }; judge returns { file, verdict,
 *          missing?, extra?, styleDiffs?, ratio?, diff?, note? } with verdict met, not-met, image (a .png without a capture of
 *          the step, never fails), missing (no such file under caw/design)
 */
export const createDesignJudge = ({ cawDir, launch, read, secrets = () => [], pixels = DEFAULT_VISUAL, save = () => undefined }) => {
    let browser = null;
    const compare = async (actual, target, masks) => {
        browser ??= await launch();
        return comparePixels(browser, actual, target, { masks, tolerance: pixels.tolerance ?? DEFAULT_VISUAL.tolerance });
    };
    return {
        compare,
        judge: async ({ file, viewport, step }, page, { capture } = {}) => {
            const path = designPath(cawDir, file);
            if (path === null) return { file, verdict: 'missing', note: t('session.design.noFile', { file }) };
            if (path.toLowerCase().endsWith('.png')) {
                if (capture === undefined) return { file, verdict: 'image', note: t('session.design.image', { file }) };
                const shot = await capture();
                const compared = await compare(shot.png, readFileSync(path), shot.masks);
                const max = pixels.designMaxRatio ?? DEFAULT_VISUAL.designMaxRatio;
                const met = compared.ratio <= max;
                const diff = met ? undefined : save(`step-${step ?? 'design'}-diff.png`, compared.diffPng);
                return {
                    file,
                    verdict: met ? 'met' : 'not-met',
                    ratio: compared.ratio,
                    ...(diff === undefined ? {} : { diff }),
                    note: t(met ? 'session.design.pixelsMet' : 'session.design.pixelsNotMet', { file, ratio: percent(compared.ratio), max: percent(max), diff: diff ?? '-' }),
                };
            }
            browser ??= await launch();
            const html = await read(path);
            const rendered = await renderDesign(browser, html, viewport ?? DEFAULT_VIEWPORT);
            try {
                const target = await structureOf(rendered);
                const actual = await structureOf(page, { secrets: secrets() });
                const { met, missing, extra, styleDiffs } = compareStructure(target, actual);
                return { file, verdict: met ? 'met' : 'not-met', missing, extra, styleDiffs };
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
