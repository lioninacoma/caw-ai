// Dates relative to today. If Claude enters or checks a date near today while recording, the recording holds a placeholder
// such as {{date}} or {{date+7}}; replay fills in that day's date. Otherwise the test would fail the next day, e.g. on "start
// must not be in the past". {{date±n}} is written the way the app's locale writes a numeric date (de-DE 23.11.2026, en-US
// 11/23/2026, en-GB 23/11/2026), {{isoDate±n}} as 2026-11-23 in every locale.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Only dates this close to today count as relative; a fixed date further away (birthday, deadline) stays as is. */
export const DATE_WINDOW_DAYS = 60;
/** Without a locale (no recording, no browser.locale): the host's, as the browser would use it. */
const hostLocale = () => Intl.DateTimeFormat().resolvedOptions().locale;

const pad = (number) => String(number).padStart(2, '0');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The locale's numeric date as an order of day, month and year with the separators between them, from Intl itself: de-DE
 * ['day', '.', 'month', '.', 'year'], en-US ['month', '/', 'day', '/', 'year']. null for a locale whose numeric date is not three
 * numbers (or not Latin digits): then only {{isoDate}} applies.
 */
export const dateFormatOf = (locale) => {
    let parts;
    try {
        parts = new Intl.DateTimeFormat(locale ?? hostLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' }).formatToParts(new Date(2001, 10, 23));
    } catch {
        return null;
    }
    const kept = parts.filter(({ type }) => ['day', 'month', 'year', 'literal'].includes(type)).map(({ type, value }) => (type === 'literal' ? value : type));
    const fields = kept.filter((part) => ['day', 'month', 'year'].includes(part));
    if (fields.length !== 3 || new Set(fields).size !== 3 || kept.length !== 5 || kept[0] === 'literal') return null;
    // A literal that is a digit or empty would make the date ambiguous; RTL marks and the like are not supported.
    if (![kept[1], kept[3]].every((separator) => /^[\s./-]{1,3}$/.test(separator))) return null;
    return kept;
};

const formatWith = (format, date) => format.map((part) => {
    if (part === 'day') return pad(date.getDate());
    if (part === 'month') return pad(date.getMonth() + 1);
    if (part === 'year') return String(date.getFullYear());
    return part;
}).join('');
const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The placeholders the tool knows; they need no `remember`. */
export const DATE_NAMES = new Set(['date', 'isoDate']);
/** The names before 1.0: refused with their new name. */
export const RENAMED_DATES = { today: 'date', todayIso: 'isoDate' };
const PLACEHOLDER = /\{\{(date|isoDate)(?:([+-])(\d{1,3}))?\}\}/g;
const ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g;

/** The locale's numeric date as a pattern of its own token (no digit or separator plus digit around it); null without one. */
const localPattern = (format) => {
    if (format === null) return null;
    const group = { day: '(\\d{2})', month: '(\\d{2})', year: '(\\d{4})' };
    const body = format.map((part) => group[part] ?? escape(part)).join('');
    const edge = escape([...new Set([format[1], format[3]].join(''))].join(''));
    return { regex: new RegExp(`(?<![\\d${edge}])${body}(?![${edge}]?\\d)`, 'g'), order: format.filter((part) => part in group) };
};

const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const shifted = (now, days) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);

/** Days from today to this date, or null if it is not a valid date. */
const daysFrom = (now, year, month, day) => {
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return Math.round((date - midnight(now)) / DAY_MS);
};

const placeholder = (name, days) => `{{${name}${days === 0 ? '' : `${days > 0 ? '+' : '-'}${Math.abs(days)}`}}}`;

const replaceIn = (value, replace) => JSON.parse(replace(JSON.stringify(value)));

/**
 * Recording: dates near today become placeholders, the locale's numeric date as {{date±n}}, an ISO date as {{isoDate±n}}. A date
 * in another locale's order is left alone: 11/23/2026 in de-DE is not a German date.
 */
export const markDates = (value, now = new Date(), locale = undefined) => {
    const format = dateFormatOf(locale);
    const local = format !== null && format.join('') !== 'year-month-day' ? localPattern(format) : null;
    return replaceIn(value, (text) => {
        let marked = text;
        if (local !== null) {
            marked = marked.replace(local.regex, (match, ...groups) => {
                const parts = Object.fromEntries(local.order.map((part, index) => [part, Number(groups[index])]));
                const days = daysFrom(now, parts.year, parts.month, parts.day);
                return days === null || Math.abs(days) > DATE_WINDOW_DAYS ? match : placeholder('date', days);
            });
        }
        return marked.replace(ISO, (match, year, month, day) => {
            const days = daysFrom(now, Number(year), Number(month), Number(day));
            return days === null || Math.abs(days) > DATE_WINDOW_DAYS ? match : placeholder('isoDate', days);
        });
    });
};

/** Replay: placeholders become this day's date, {{date}} in the locale's numeric format (ISO where the locale has none). */
export const fillDates = (value, now = new Date(), locale = undefined) => {
    const format = dateFormatOf(locale);
    return replaceIn(value, (text) => text.replace(PLACEHOLDER, (match, name, sign, amount) => {
        const day = shifted(now, amount === undefined ? 0 : Number(amount) * (sign === '-' ? -1 : 1));
        return name === 'date' && format !== null ? formatWith(format, day) : isoOf(day);
    }));
};

/** {{today}} and {{todayIso}} from before 1.0 in a text, as [{ old, now }] for the renamed message. */
export const renamedDates = (text) => [...String(text).matchAll(/\{\{(today|todayIso)((?:[+-]\d{1,3})?)\}\}/g)]
    .map(([old, name, shift]) => ({ old, now: `{{${RENAMED_DATES[name]}${shift}}}` }));

/**
 * Now as a local date in another time zone: its year, month, day and time are the wall clock there. The browser runs in the
 * pinned time zone of the recording; "today" has to be its today, not the host's, e.g. shortly after midnight on a UTC runner.
 * Without a valid zone the host's now.
 */
export const zonedNow = (timeZone, now = new Date()) => {
    if (typeof timeZone !== 'string' || timeZone === '') return now;
    let parts;
    try {
        parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
            .formatToParts(now).map(({ type, value }) => [type, Number(value)]));
    } catch {
        return now;
    }
    return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, now.getMilliseconds());
};
