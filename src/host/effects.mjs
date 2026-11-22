// What does an action do to the page? A healthy run records it per action, a later run compares. This reveals the first
// action after which the app behaves differently, even if only a later target or check fails.
// Everything comes from the browser, with no knowledge of framework or environment, and without values: no field contents, no parameter values.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { t } from '../shared/i18n.mjs';
import { CATALOGS } from '../shared/locales/index.mjs';
import { FORMS_FILE, RUN_DIR } from '../shared/names.mjs';

/**
 * Healthy runs until the effects count as learned. Until then, whatever fluctuates between runs is dropped; after that
 * they are frozen. Measured in the baseline spike (e2e/spike): five runs learned no flicker by chance.
 */
export const LEARN_RUNS = 5;
const MAX_LINES = 12;
const MAX_CONTROLS = 40;
const MAX_LINE = 120;
export const EFFECT_LISTS = ['controls', 'requests', 'responses', 'console'];

const shortHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

// Numbers change from run to run (order numbers, dates, counters).
const neutral = (text) => text.replace(/\d+/g, '#');

/**
 * Runs in the browser: state of the visible controls, without values.
 * @param style also a few computed styles per control, for comparing against a target design (design.mjs): then each entry
 *              is { line, style? } instead of the line
 * @param look  for a learned look (visual.mjs): { ignore } with the config's visualIgnore selectors. Then exactly the controls
 *              in what maskProbe (visual.mjs) counts as changing data are left out: rows except header rows, list entries except those of
 *              navigation, menus, tab lists and toolbars, articles and cards, and what `ignore` finds. A list with one entry more
 *              then has the same style lines.
 */
export function controlsProbe({ style: withStyle = false, look = null } = {}) {
    const seen = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const short = (text) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    // Without its own label: the first text line of the nearest enclosing area, e.g. the heading of a card. Otherwise
    // it would just say `textarea ""` and nobody could find the spot in the code.
    const contextOf = (node) => {
        let current = node.parentElement;
        for (let depth = 0; current !== null && current !== document.body && depth < 6; depth += 1, current = current.parentElement) {
            const line = (current.innerText ?? '').split('\n').map((text) => text.trim()).find((text) => text !== '');
            if (line !== undefined) return line.length <= 60 ? line : '';
        }
        return '';
    };
    // Without the fields inside the label: the options of a <select> are data, not the label.
    const labelText = (label) => {
        if (!label) return '';
        const copy = label.cloneNode(true);
        for (const inner of copy.querySelectorAll('select, textarea, datalist, [role=listbox]')) inner.remove();
        return copy.textContent;
    };
    const labelOf = (node) => short(node.getAttribute('aria-label')
        || (node.id ? labelText(document.querySelector(`label[for="${CSS.escape(node.id)}"]`)) : '')
        || labelText(node.closest('label'))
        || node.getAttribute('placeholder')
        || node.getAttribute('name')
        || (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || node.getAttribute('role') === 'tab' ? node.innerText : '')
        || node.getAttribute('title')
        || contextOf(node));
    const flags = (node) => [
        node.disabled || node.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
        node.required || node.getAttribute('aria-required') === 'true' ? 'required' : '',
        node.readOnly || node.getAttribute('aria-readonly') === 'true' ? 'readonly' : '',
        node.getAttribute('aria-invalid') === 'true' ? 'invalid' : '',
        node.checked || node.getAttribute('aria-checked') === 'true' ? 'checked' : '',
        node.getAttribute('aria-expanded') === 'true' ? 'expanded' : '',
        node.getAttribute('aria-selected') === 'true' ? 'selected' : '',
        'value' in node && node.type !== 'checkbox' && node.type !== 'radio' && node.tagName !== 'BUTTON' ? (node.value === '' ? 'empty' : 'filled') : '',
    ].filter(Boolean);
    // Rows of lists and tables are data, often of other records: their controls do not count. Of a list, only whether it
    // has rows counts.
    const ROW = '[role=row], [role=gridcell], [role=listitem], [role=option], [role=treeitem], tr, li';
    // What visual.mjs maskProbe counts as changing data (the same selectors): the probe runs in the page, it cannot share them.
    const MASKED_ROW = '[role=row], [role=option], [role=treeitem], tr';
    const ENTRY = 'li:not([role]), [role=listitem]';
    const NAVIGATION = 'nav, [role=navigation], [role=menu], [role=menubar], [role=tablist], [role=toolbar]';
    const ignored = look === null ? [] : look.ignore.flatMap((selector) => {
        try {
            return [...document.querySelectorAll(selector)];
        } catch {
            return [];
        }
    });
    const up = (node, selector) => node.parentElement?.closest(selector) ?? null;
    const masked = (node) => {
        if (node.closest('article, [role=article]') !== null || ignored.some((area) => area.contains(node))) return true;
        for (let row = node.closest(MASKED_ROW); row !== null; row = up(row, MASKED_ROW)) if (row.querySelector('th, [role=columnheader]') === null) return true;
        for (let entry = node.closest(ENTRY); entry !== null; entry = up(entry, ENTRY)) if (entry.closest(NAVIGATION) === null) return true;
        return false;
    };
    const counted = (node) => (look === null ? node.closest(ROW) === null : !masked(node));
    const controls = [...document.querySelectorAll('input, select, textarea, button, [role=button], [role=tab], [role=checkbox], [role=combobox], [role=textbox]')]
        .filter((node) => node.type !== 'hidden' && seen(node) && counted(node))
        .map((node) => {
            const line = `${node.getAttribute('role') ?? node.tagName.toLowerCase()} "${labelOf(node)}" ${flags(node).join(',')}`.trim();
            if (!withStyle) return line;
            const style = getComputedStyle(node);
            return { line, style: { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, padding: style.padding } };
        });
    const lists = [...document.querySelectorAll('[role=grid], [role=treegrid], [role=listbox], [role=tree], [role=table], table')]
        .filter((node) => seen(node) && (node.parentElement?.closest('[role=grid], [role=treegrid], [role=listbox], [role=tree], [role=table], table') ?? null) === null)
        .map((node) => {
            const rows = [...node.querySelectorAll('[role=row], [role=option], [role=treeitem], tr')].filter((row) => seen(row) && row.querySelector('[role=columnheader], th') === null);
            const line = `list "${short(node.getAttribute('aria-label') || contextOf(node))}" ${rows.length === 0 ? 'empty' : 'rows'}`;
            return withStyle ? { line } : line;
        });
    return [...controls, ...lists];
}

/** Difference of two lists as +/- lines. */
export const lineDelta = (before, after) => {
    const was = new Set(before);
    const now = new Set(after);
    return [...new Set([...after.filter((line) => !was.has(line)).map((line) => `+ ${line}`), ...before.filter((line) => !now.has(line)).map((line) => `- ${line}`)])];
};

/** Shape of a JSON response: key paths, arrays collapsed, without values. */
export const jsonShape = (value, prefix = '', out = new Set(), depth = 0) => {
    if (depth > 5 || out.size > 200) return out;
    if (Array.isArray(value)) {
        out.add(`${prefix}[]`);
        for (const item of value.slice(0, 3)) jsonShape(item, `${prefix}[]`, out, depth + 1);
    } else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
            out.add(`${prefix}.${key}`);
            jsonShape(inner, `${prefix}.${key}`, out, depth + 1);
        }
    }
    return out;
};

const FAILURE_KEYS = /^(success|ok|error|errors|fehler|fehlermeldung)$/i;

/**
 * A JSON response as one line: request name, shape as short hash and business error markers of the top level.
 * @param forms a Map that keeps the shape's field paths by its hash, so a changed form can be named by its fields later
 */
export const responseLine = (name, body, forms) => {
    const hints = body === null || typeof body !== 'object' || Array.isArray(body) ? [] : Object.entries(body)
        .filter(([key]) => FAILURE_KEYS.test(key))
        .map(([key, value]) => `${key}=${typeof value === 'boolean' ? value : value === null || value === '' ? 'empty' : 'filled'}`);
    const fields = [...jsonShape(body)].sort();
    const hash = shortHash(fields);
    forms?.set(hash, fields);
    return [name, `form ${hash}`, ...hints].join(' ');
};

const FORM = /^(.*?) form ([0-9a-f]+)(?: (.*))?$/;
const MAX_FORMS = 2000;
const MAX_FIELDS = 6;

/** A response line's parts: { name, hash, markers } or null for any other line. */
const formOf = (line) => {
    const found = FORM.exec(line);
    return found === null ? null : { name: found[1], hash: found[2], markers: found[3] ?? '' };
};

/**
 * The response forms a learning run needs from earlier runs: the recording keeps only a form's hash, so the field paths of
 * the forms the effects learn are kept on this machine (`.caw/response-forms.json`, never values). Reads what earlier runs
 * kept, adds the forms of this run's learned response lines and writes the file again (at most MAX_FORMS, the newest).
 * @param current this run's forms (hash -> field paths)
 * @param learned the effects this run learns (Map step -> { actions })
 * @returns hash -> field paths, earlier and current
 */
export const keptForms = (root, current, learned) => {
    const path = join(root, RUN_DIR, FORMS_FILE);
    let kept = {};
    try {
        const read = JSON.parse(readFileSync(path, 'utf8'));
        if (read !== null && typeof read === 'object' && !Array.isArray(read)) kept = read;
    } catch {
        // none yet, or unreadable: start anew
    }
    const known = new Map(Object.entries(kept).filter(([, fields]) => Array.isArray(fields)));
    const hashes = new Set([...learned.values()].flatMap(({ actions = [] }) => actions.flatMap(({ responses = [] }) => responses.map((line) => formOf(line)?.hash))));
    let added = false;
    for (const [hash, fields] of current ?? []) {
        if (!hashes.has(hash) || known.get(hash)?.join() === fields.join()) continue;
        known.delete(hash);
        known.set(hash, fields);
        added = true;
    }
    if (added) {
        try {
            mkdirSync(join(root, RUN_DIR), { recursive: true });
            writeFileSync(`${path}.tmp`, JSON.stringify(Object.fromEntries([...known].slice(-MAX_FORMS))));
            renameSync(`${path}.tmp`, path);
        } catch {
            // not writable: the next run names the change without the earlier fields
        }
    }
    return new Map([...known, ...(current ?? [])]);
};

/**
 * A response line every earlier run saw and this run did not, in words: what changed between the form then and the form the
 * same request answered with now (JSON fields that came and went, or a changed marker such as success=false).
 * @param now   this run's response lines of the same action
 * @param forms hash -> field paths, of earlier runs (as far as this machine kept them) and of this run
 */
const droppedResponse = (line, now, forms) => {
    const then = formOf(line);
    if (then === null) return line;
    const other = now.map(formOf).find((form) => form !== null && form.name === then.name);
    if (other === undefined) return t('session.effects.formGone', { name: then.name });
    const listed = (fields) => (fields.length <= MAX_FIELDS ? fields : [...fields.slice(0, MAX_FIELDS), t('session.effects.formMore', { count: fields.length - MAX_FIELDS })]).join(', ');
    const before = forms.get(then.hash);
    const after = forms.get(other.hash);
    if (then.hash === other.hash || (before !== undefined && after !== undefined && before.join() === after.join())) {
        return t('session.effects.formMarkers', { name: then.name, now: other.markers || '-', then: then.markers || '-' });
    }
    if (after === undefined) return t('session.effects.formOther', { name: then.name });
    if (before === undefined) return t('session.effects.formUnknown', { name: then.name, fields: listed(after) });
    const added = after.filter((field) => !before.includes(field));
    const removed = before.filter((field) => !after.includes(field));
    const parts = [...(added.length === 0 ? [] : [t('session.effects.formAdded', { fields: listed(added) })]), ...(removed.length === 0 ? [] : [t('session.effects.formRemoved', { fields: listed(removed) })])];
    return t('session.effects.formChanged', { name: then.name, changes: parts.join('; ') });
};

const unique = (lines) => [...new Set(lines)].slice(0, MAX_LINES);

/**
 * Measures the effect per action: `before()` before the action, `after()` afterwards, once the page is quiet.
 * @param session browser session with page(), network and trail
 */
export const createEffects = ({ session }) => {
    const read = async () => {
        const controls = await session.page().evaluate(controlsProbe).catch(() => null);
        return controls?.map(neutral) ?? null;
    };
    let before = null;
    let netMark = 0;
    let trailMark = 0;
    return {
        before: async () => {
            before = await read();
            netMark = session.network?.mark() ?? 0;
            trailMark = session.trail?.mark() ?? 0;
        },
        /** @returns the effect, lists without entries are omitted; null if the page could not be read */
        after: async () => {
            const after = await read();
            if (before === null || after === null) return null;
            const requests = (session.network?.since(netMark) ?? [])
                .filter(({ outcome }) => outcome === 'ok' || outcome === 'http')
                .map(({ name, status }) => `${name} ${status}`);
            const trail = session.trail?.since(trailMark) ?? [];
            const effect = {
                controls: lineDelta(before, after),
                requests: unique(requests),
                responses: unique(trail.filter(({ kind }) => kind === 'response').map(({ line }) => line)),
                console: unique(trail.filter(({ kind }) => kind === 'console').map(({ line }) => neutral(line).slice(0, MAX_LINE))),
            };
            // Controls are short lines and the most reliable signal: a form quickly has more than a dozen of them.
            effect.controls = effect.controls.slice(0, MAX_CONTROLS);
            return Object.fromEntries(Object.entries(effect).filter(([, lines]) => lines.length > 0));
        },
    };
};

/**
 * Learns from a healthy run. Until LEARN_RUNS only what was equal in all runs stays; the console collects what occurred,
 * because later only new entries count there. After that a run changes nothing: a deviation is then a finding, not noise.
 * @param recorded recording.effects or undefined
 * @param observed Map action number (from 1) -> effect from this run
 * @returns the new recording.effects or null if nothing changes
 */
export const learnEffects = (recorded, observed) => {
    if (recorded !== undefined && recorded.runs >= LEARN_RUNS) return null;
    const known = new Map((recorded?.actions ?? []).map((entry) => [entry.action, entry]));
    const numbers = recorded === undefined ? [...observed.keys()] : [...known.keys()];
    const actions = numbers.sort((a, b) => a - b).map((number) => {
        const now = observed.get(number) ?? {};
        const then = known.get(number);
        const lists = EFFECT_LISTS.map((list) => {
            const fresh = now[list] ?? [];
            if (then === undefined) return [list, fresh];
            const old = then[list] ?? [];
            return [list, list === 'console' ? unique([...old, ...fresh]) : old.filter((line) => fresh.includes(line))];
        }).filter(([, lines]) => lines.length > 0);
        return lists.length === 0 ? null : { action: number, ...Object.fromEntries(lists) };
    }).filter((entry) => entry !== null);
    return { runs: (recorded?.runs ?? 0) + 1, actions };
};

/**
 * What a learning run dropped: lines every earlier run had and this one did not. While learning that is how flicker goes, but a
 * regression in the first runs goes the same way, so the run names them. The console only collects, it never drops.
 * @param recorded the effects before the run (undefined: the first run, nothing to drop)
 * @param learned  learnEffects' result
 * @param observed this run's effects of the step (action number -> lists) and `forms` (hash -> JSON field paths, see
 *                 responseLine): with them a dropped response says which fields came and went instead of its form's hash
 * @returns lines `<action> <list>: <line>`
 */
export const droppedEffects = (recorded, learned, { observed = new Map(), forms = new Map() } = {}) => {
    if (recorded === undefined || learned === null || learned === undefined) return [];
    return recorded.actions.flatMap((entry) => {
        const now = learned.actions.find(({ action }) => action === entry.action) ?? {};
        const seen = observed.get(entry.action)?.responses ?? [];
        return EFFECT_LISTS.filter((list) => list !== 'console')
            .flatMap((list) => (entry[list] ?? []).filter((line) => !(now[list] ?? []).includes(line))
                .map((line) => `${entry.action} ${list}: ${list === 'responses' ? droppedResponse(line, seen, forms) : line}`));
    });
};

/**
 * Do the effects deviate from the learned ones? Missing entries count for everything except the console, where new ones count.
 * @returns { missing, extra, instead } or null
 */
export const effectChange = (recorded, observed) => {
    if (recorded === undefined || observed === undefined) return null;
    const now = observed ?? {};
    // A response shape is only missing if the same request now answers with a different shape. If it did not come or came later, `requests` shows that.
    const nameOf = (line) => line.replace(/ form [0-9a-f]+.*$/, '');
    const answered = new Set((now.responses ?? []).map(nameOf));
    const counts = (list, line) => list !== 'responses' || answered.has(nameOf(line));
    const byList = Object.fromEntries(EFFECT_LISTS.filter((list) => list !== 'console')
        .map((list) => [list, (recorded[list] ?? []).filter((line) => !(now[list] ?? []).includes(line) && counts(list, line))]));
    const extra = (now.console ?? []).filter((line) => !(recorded.console ?? []).includes(line));
    // What happened instead, among the controls: it shows how the form rearranges itself now.
    const instead = (now.controls ?? []).filter((line) => !(recorded.controls ?? []).includes(line)).slice(0, 6);
    return summarized({ byList, extra: extra.slice(0, 5), instead });
};

/**
 * How an action's effect deviates from the step's learned effects: the comparison of a replay, also usable without a browser.
 * @param learned the step's learned effects ({ runs, actions }) or undefined
 * @returns { number, learned, missing, extra, instead, lists, byList } or null
 */
export const stepDeviation = (learned, number, effect) => {
    if (learned === undefined) return null;
    const change = effectChange(learned.actions.find(({ action }) => action === number) ?? {}, effect);
    return change === null ? null : { number, learned: learned.runs >= LEARN_RUNS, ...change };
};

/** Summarizes the deviation per list; null if nothing remains. */
const summarized = ({ byList, extra, instead }) => {
    const missing = Object.values(byList).flat();
    if (missing.length === 0 && extra.length === 0) return null;
    // Which lists deviate: that decides whether the deviation fails the step.
    const lists = EFFECT_LISTS.filter((list) => (list === 'console' ? extra.length > 0 : (byList[list] ?? []).length > 0));
    return { missing: missing.slice(0, 8), extra, instead, lists, byList };
};

/**
 * A request that came later within the same step after the measurement is not missing: it was just slower.
 * @param answered lines `name status` of all answered requests of the step
 * @returns the cleaned deviation or null
 */
export const withoutLate = (deviation, answered) => {
    if (deviation === undefined || deviation === null) return null;
    const late = new Set(answered);
    const byList = { ...deviation.byList, requests: (deviation.byList?.requests ?? []).filter((line) => !late.has(line)) };
    const rest = summarized({ byList, extra: deviation.extra, instead: deviation.instead });
    return rest === null ? null : { ...deviation, ...rest };
};

/** Default: what was completely stable in healthy runs fails the step; the rest stays a warning. */
export const DEFAULT_EFFECT_FAIL = ['controls', 'console'];

/** Does this deviation fail the step? Only learned effects, and only in the lists from `fail`. */
export const failsStep = (deviation, fail = DEFAULT_EFFECT_FAIL) => deviation?.learned === true && deviation.lists.some((list) => fail.includes(list));

/** Start of the reason when only the effects deviate. Recognized in every language, also in runs of another one. */
export const effectCause = () => t('run.effect.cause');
// After retries the reason follows a retry prefix (e.g. "Failed in all 2 attempts: ", see RETRY_KEYS).
// The reason of the last attempt counts; the earlier ones follow it and do not count.
const RETRY_KEYS = ['session.replay.allTriesFailed', 'session.replay.tryFailed'];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RETRY_PREFIXES = Object.values(CATALOGS).flatMap((catalog) => RETRY_KEYS.map((key) => catalog[key]).filter((text) => typeof text === 'string'))
    .map((text) => new RegExp(`^${escapeRegExp(text.split('{reason}')[0]).replace(escapeRegExp('{count}'), '\\d+')}`));
export const isEffectCause = (reason) => {
    const text = String(reason ?? '');
    const bare = [text, ...RETRY_PREFIXES.filter((prefix) => prefix.test(text)).map((prefix) => text.replace(prefix, ''))];
    return Object.values(CATALOGS).some((catalog) => typeof catalog['run.effect.cause'] === 'string'
        && bare.some((candidate) => candidate.startsWith(catalog['run.effect.cause'])));
};

// Controls appear as changes in the effects: "+ x" appears through the action, "- x" disappears. Spelled out for humans.
const changeWords = (line) => {
    if (line.startsWith('+ ')) return t('run.effect.appears', { what: line.slice(2) });
    if (line.startsWith('- ')) return t('run.effect.disappears', { what: line.slice(2) });
    return line;
};

/** The deviation in one sentence, for assessment, report and Claude. */
export const deviationText = ({ step, number, label, missing, extra, instead }) => [
    t('run.effect.differs', { step, number, label }),
    ...(missing.length === 0 ? [] : [t('run.effect.missing', { list: missing.map(changeWords).join('; ') })]),
    ...(instead.length === 0 || missing.length === 0 ? [] : [t('run.effect.instead', { list: instead.map(changeWords).join('; ') })]),
    ...(extra.length === 0 ? [] : [t('run.effect.console', { list: extra.join('; ') })]),
].join(' ');
