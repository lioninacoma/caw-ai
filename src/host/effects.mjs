// What does an action do to the page? A healthy run records it per action, a later run compares. This reveals the first
// action after which the app behaves differently, even if only a later target or check fails.
// Everything comes from the browser, with no knowledge of framework or environment, and without values: no field contents, no parameter values.

import { createHash } from 'node:crypto';

import { t } from '../shared/i18n.mjs';
import { CATALOGS } from '../shared/locales/index.mjs';
import { redactFor } from './secrets.mjs';

/** Healthy runs until the effects count as learned. Until then, whatever fluctuates between runs is dropped. */
export const LEARN_RUNS = 2;
const MAX_LINES = 12;
const MAX_CONTROLS = 40;
const MAX_LINE = 120;
export const EFFECT_LISTS = ['controls', 'view', 'requests', 'responses', 'console'];

const shortHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

// Numbers change from run to run (order numbers, dates, counters).
const neutral = (text) => text.replace(/\d+/g, '#');

/** Runs in the browser: state of the visible controls, without values. */
export function controlsProbe() {
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
    const controls = [...document.querySelectorAll('input, select, textarea, button, [role=button], [role=tab], [role=checkbox], [role=combobox], [role=textbox]')]
        .filter((node) => node.type !== 'hidden' && seen(node) && node.closest(ROW) === null)
        .map((node) => `${node.getAttribute('role') ?? node.tagName.toLowerCase()} "${labelOf(node)}" ${flags(node).join(',')}`.trim());
    const lists = [...document.querySelectorAll('[role=grid], [role=treegrid], [role=listbox], [role=tree], [role=table], table')]
        .filter((node) => seen(node) && (node.parentElement?.closest('[role=grid], [role=treegrid], [role=listbox], [role=tree], [role=table], table') ?? null) === null)
        .map((node) => {
            const rows = [...node.querySelectorAll('[role=row], [role=option], [role=treeitem], tr')].filter((row) => seen(row) && row.querySelector('[role=columnheader], th') === null);
            return `list "${short(node.getAttribute('aria-label') || contextOf(node))}" ${rows.length === 0 ? 'empty' : 'rows'}`;
        });
    return [...controls, ...lists];
}

/**
 * The ARIA tree as lines without values: links, field contents and long texts (mostly list data) are dropped, as are lines
 * without a name.
 */
export const viewLines = (aria) => aria.split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !/^\s*- \/url:/.test(line))
    .map((line) => line.replace(/\[ref=[^\]]*\]/g, '').replace(/^(\s*- (?:textbox|combobox|searchbox|spinbutton|slider)(?: "[^"]*")?(?: \[[^\]]*\])*):.*$/, '$1'))
    .filter((line) => line.length <= MAX_LINE && !/^\s*- (?:button|img|generic|list|listitem|group|row|cell|text)?:?$/.test(line))
    .map((line) => neutral(line).trim());

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

/** A JSON response as one line: request name, shape as short hash and business error markers of the top level. */
export const responseLine = (name, body) => {
    const hints = body === null || typeof body !== 'object' || Array.isArray(body) ? [] : Object.entries(body)
        .filter(([key]) => FAILURE_KEYS.test(key))
        .map(([key, value]) => `${key}=${typeof value === 'boolean' ? value : value === null || value === '' ? 'empty' : 'filled'}`);
    return [name, `form ${shortHash([...jsonShape(body)].sort())}`, ...hints].join(' ');
};

const unique = (lines) => [...new Set(lines)].slice(0, MAX_LINES);

/**
 * Measures the effect per action: `before()` before the action, `after()` afterwards, once the page is quiet.
 * @param session browser session with page(), network and trail
 */
export const createEffects = ({ session }) => {
    const read = async () => {
        const page = session.page();
        const [controls, aria] = await Promise.all([
            page.evaluate(controlsProbe).catch(() => null),
            page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => null),
        ]);
        // The effects end up in the recording, i.e. in the repository: without passwords.
        const view = aria === null ? null : viewLines(await redactFor(page, aria, session.secrets?.() ?? []));
        return { controls: controls?.map(neutral) ?? null, view };
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
            if ((before?.controls ?? null) === null || after.controls === null || before.view === null || after.view === null) return null;
            const requests = (session.network?.since(netMark) ?? [])
                .filter(({ outcome }) => outcome === 'ok' || outcome === 'http')
                .map(({ name, status }) => `${name} ${status}`);
            const trail = session.trail?.since(trailMark) ?? [];
            const effect = {
                controls: lineDelta(before.controls, after.controls),
                view: lineDelta(before.view, after.view),
                requests: unique(requests),
                responses: unique(trail.filter(({ kind }) => kind === 'response').map(({ line }) => line)),
                console: unique(trail.filter(({ kind }) => kind === 'console').map(({ line }) => neutral(line).slice(0, MAX_LINE))),
            };
            // Controls are short lines and the most reliable signal: a form quickly has more than a dozen of them.
            effect.controls = effect.controls.slice(0, MAX_CONTROLS);
            effect.view = effect.view.slice(0, MAX_LINES);
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
 * Self-cleanup: what was missing in a passed run in a list that does not decide on failure apparently fluctuates and
 * drops out of the learned effects. Lists from `fail` stay: a deviation there is a finding.
 * @returns the new recording.effects or null if there is nothing to drop
 */
export const pruneEffects = (recorded, deviation, fail = DEFAULT_EFFECT_FAIL) => {
    if (recorded === undefined || deviation === undefined || deviation === null || deviation.lists.some((list) => fail.includes(list))) return null;
    const drop = Object.entries(deviation.byList ?? {}).filter(([list]) => !fail.includes(list));
    if (drop.every(([, lines]) => lines.length === 0)) return null;
    const actions = recorded.actions.map((entry) => {
        if (entry.action !== deviation.number) return entry;
        const kept = Object.fromEntries(EFFECT_LISTS.map((list) => {
            const gone = new Set(drop.find(([name]) => name === list)?.[1] ?? []);
            return [list, (entry[list] ?? []).filter((line) => !gone.has(line))];
        }).filter(([, lines]) => lines.length > 0));
        return { action: entry.action, ...kept };
    }).filter((entry) => Object.keys(entry).length > 1);
    return { ...recorded, actions };
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
    // What happened instead, from the same lists: it shows how the form rearranges itself now.
    const instead = ['controls', 'view'].flatMap((list) => (now[list] ?? []).filter((line) => !(recorded[list] ?? []).includes(line))).slice(0, 6);
    return summarized({ byList, extra: extra.slice(0, 5), instead });
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
// The line itself may come from a snapshot ("- link \"x\":"): the leading dash and trailing colon are not part of the name.
const changeWords = (line) => {
    const plain = (text) => text.replace(/^- /, '').replace(/:$/, '');
    if (line.startsWith('+ ')) return t('run.effect.appears', { what: plain(line.slice(2)) });
    if (line.startsWith('- ')) return t('run.effect.disappears', { what: plain(line.slice(2)) });
    return line;
};

/** The deviation in one sentence, for assessment, report and Claude. */
export const deviationText = ({ step, number, label, missing, extra, instead }) => [
    t('run.effect.differs', { step, number, label }),
    ...(missing.length === 0 ? [] : [t('run.effect.missing', { list: missing.map(changeWords).join('; ') })]),
    ...(instead.length === 0 || missing.length === 0 ? [] : [t('run.effect.instead', { list: instead.map(changeWords).join('; ') })]),
    ...(extra.length === 0 ? [] : [t('run.effect.console', { list: extra.join('; ') })]),
].join(' ');
