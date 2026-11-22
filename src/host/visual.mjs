// The visual layer: what a step's screen looks like, in computed styles. A learned look (visual regression, per step with
// `look: true`) is compared in later runs, its style lines decided without AI. A run may also keep a screenshot of every
// passed step for its report (visual.screenshots).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { t } from '../shared/i18n.mjs';
import { compareDetailed, designPath, renderDesign, structureOf } from './design.mjs';

/** The config's visual settings with the defaults. */
export const visualSettings = (config = {}) => ({ screenshots: false, ...(config.visual ?? {}), ignore: config.visualIgnore ?? [] });

/** Healthy runs until a look counts as learned. Not the effects' number: the baseline spike did not measure looks. */
export const LOOK_LEARN_RUNS = 2;
const LEARN_RUNS = LOOK_LEARN_RUNS;

/**
 * Runs in the browser: boxes of what differs from run to run although the app is right, in CSS pixels of the viewport. The
 * look suggestion after a recording (look-hints.mjs) counts them: a screen with any is no candidate for `look: true`.
 * - text containing the run tag or a remembered value (`texts`);
 * - numeric dates (11/23/2026, 23.11.2026, 2026-11-23): a screen also shows creation and change dates that no placeholder
 *   (dates.mjs) covers, since only dates near today become placeholders;
 * - rows of lists and tables (as effects.mjs counts them), list entries and cards (`li`, listitem, `article`): data, often of
 *   other records. Header rows stay, and so do entries of navigation, menus and tab lists: they are the app's, not data;
 * - what the config's `visualIgnore` selectors find (an invalid selector finds nothing).
 * The style lines leave out the controls in the same areas (effects.mjs controlsProbe with `look`): keep both in step.
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
 * The step's screen for the report (visual.screenshots), at the recorded viewport: in a plain page its viewport, in the
 * workbench the app frame unscaled (workbench.unscaled lifts the fit-to-pane scale for the moment of the capture). CSS
 * pixels, so a 125 % display gives the same image as CI.
 * @param page      session.page(): a page or the workbench's frame view
 * @param unscaled  (shoot) => the workbench's unscaled capture, or undefined without a workbench
 * @returns { png: Buffer }
 */
export const captureStep = async (page, { unscaled } = {}) => {
    // Animations are left alone: finishing them fires animationend in the app, which a capture must not cause.
    const shoot = () => page.screenshot({ scale: 'css', caret: 'hide' });
    return { png: page.isFrameView === true && unscaled !== undefined ? await unscaled(shoot) : await shoot() };
};

/** The design file's content hash: part of the visual basis, so a new design invalidates the look learned against the old. */
export const fileHash = (path) => (path === null || !existsSync(path) ? undefined : createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12));

// ----------------------------------------------------------------------------------------------------------- visual regression

/**
 * The computed styles per control (design.mjs structureFrom) as lines, the part of a look that YAML can show: one line per
 * role and style with how many controls have it, `button ×3: color #ffffff, font-size 13px`. Not by the control's name:
 * names carry data (`button "Complete Feed the raven"`), a look is what the controls look like. The controls in masked areas
 * (rows, list entries, cards, visualIgnore) are not measured at all (controlsProbe with `look`): their number is data.
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

/**
 * What a learned look is valid for: the state its step starts in (the previous step's recording time, as for effects), its
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
 * The visual layer after a passed check (playReplay `look`): screenshot (opt-in) and the learned look (visual regression,
 * for steps with `look: true`), the same in a window and headless. A changed look fails the step only when design.fail names
 * `visual`, else it warns.
 * @param settings   visualSettings(config)
 * @param save       (name, png) => the file name in the run folder, or undefined
 * @param secrets    () => values the style lines must not show
 * @returns (id, { capture, page }) => { record, warnings, fail?, observed? }
 */
export const createLook = ({ spec, cawDir, settings, save, designFail = [], secrets = () => [] }) => {
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
        const step = steps.get(id);
        if (step?.look === true && step.recording !== undefined) {
            const basis = lookBasis(spec, step, designHashOf(cawDir, step));
            const learned = currentLook(step, basis);
            // Without the controls in masked areas: a list with one entry more has the same look.
            const styles = styleLines((await structureOf(page, { secrets: secrets(), look: { ignore: settings.ignore ?? [] } })).styles);
            const stylesLearned = (learned?.runs ?? 0) >= LEARN_RUNS;
            const changedStyles = stylesLearned ? styleChanges(learned.styles, styles) : [];
            const changed = changedStyles.length > 0;
            const verdict = changed ? 'changed' : stylesLearned ? 'same' : 'learning';
            record.visual = { verdict, ...(changed ? { styles: changedStyles } : {}) };
            observed = { styles, ...(basis === undefined ? {} : { basis }), changed };
            if (changed) {
                const details = t('session.visual.styles', { list: changedStyles.join('; ') });
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
 * (LEARN_RUNS). A count that differs while learning becomes `×?` (mergeStyles). A learned look stays as it is.
 * @returns { visual } or null when nothing changes
 */
export const learnLook = (current, observed) => {
    const runs = current?.runs ?? 0;
    const learnedStyles = runs >= LEARN_RUNS;
    const styles = current === undefined ? observed.styles : learnedStyles ? current.styles : mergeStyles(current.styles, observed.styles);
    const visual = { runs: learnedStyles ? runs : runs + 1, ...(observed.basis === undefined ? {} : { basis: observed.basis }), styles, ...(current?.adopted === undefined ? {} : { adopted: current.adopted }) };
    if (JSON.stringify(visual) === JSON.stringify(current)) return null;
    return { visual };
};

/**
 * Looks to learn from a run: passed steps only, only on the target the step was recorded on, never a step whose look changed.
 * @param seen playReplay's seenLooks
 * @returns Map step -> { visual }
 */
export const learnedLooks = ({ spec, results, seen, target }) => {
    const found = new Map();
    for (const step of spec.steps) {
        const observed = seen?.get(step.id);
        if (observed === undefined || observed.changed || step.recording === undefined || step.recording.recordedOn !== target || results.get(step.id)?.status !== 'pass') continue;
        const learned = learnLook(currentLook(step, observed.basis), observed);
        if (learned !== null) found.set(step.id, learned);
    }
    return found;
};

/** Adds learned looks to the recordings. The hash stays. */
export const withLooks = (spec, looks) => ({
    ...spec,
    steps: spec.steps.map((step) => (looks.has(step.id) && step.recording !== undefined
        ? { ...step, recording: { ...step.recording, visual: looks.get(step.id).visual } }
        : step)),
});

/**
 * The human adopts the new look ("Adopt new look") of every step whose look changed in the run, at once: the styles count as
 * learned, and the day it was adopted goes along, which audit lists.
 * @param looks Map step -> observed (createLook)
 */
export const withAdoptedLooks = (spec, looks, day = new Date().toISOString().slice(0, 10)) => withLooks(spec, new Map([...looks].map(([id, observed]) => [id, {
    visual: {
        runs: LEARN_RUNS,
        ...(observed.basis === undefined ? {} : { basis: observed.basis }),
        styles: observed.styles,
        adopted: day,
    },
}])));

// -------------------------------------------------------------------------------------------------------- design comparison

/** A PNG as the page shows it: data URL and size (CSS px, the screenshots are taken at scale css). */
const pngImage = (png) => ({ src: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/**
 * What the comparison page of `open <test>@S3 --design` shows: the .html design rendered without scripts or network at the
 * recorded viewport, as a whole page; the app as the window shows it now, its frame captured at the recorded viewport; the
 * deviations (design.mjs compareDetailed) with where their element is in both images. The app's boxes are moved by its
 * scroll position, so they sit on the captured part; the design is captured from its top.
 * @param page     the app (session.page())
 * @param capture  () => { png } of the app frame at the recorded viewport (captureStep)
 * @param launch   () => a Playwright Browser for the design (closed again here)
 * @returns { met, design: { src, width, height }, app: { src, width, height }, deviations: [{ kind, text, design?, app? }], extra }
 *          or null without a design file
 */
export const designComparison = async ({ cawDir, file, viewport, page, capture, launch, secrets = [] }) => {
    const path = designPath(cawDir, file);
    if (path === null) return null;
    const browser = await launch();
    try {
        const rendered = await renderDesign(browser, readFileSync(path, 'utf8'), viewport);
        try {
            const design = await rendered.screenshot({ scale: 'css', fullPage: true });
            const target = await structureOf(rendered);
            const actual = await structureOf(page, { secrets });
            const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY })).catch(() => ({ x: 0, y: 0 }));
            const { png } = await capture();
            const { met, extra, deviations } = compareDetailed(target, actual);
            const visible = (box) => ({ ...box, x: box.x - scroll.x, y: box.y - scroll.y });
            return {
                met,
                design: pngImage(design),
                app: pngImage(png),
                deviations: deviations.map((deviation) => (deviation.app === undefined ? deviation : { ...deviation, app: visible(deviation.app) })),
                extra,
            };
        } finally {
            await rendered.context().close().catch(() => {});
        }
    } finally {
        await browser.close().catch(() => {});
    }
};
