// Dates relative to today. If Claude enters or checks a date near today while recording, the recording holds a placeholder
// such as {{today}} or {{today+7}}; replay fills in that day's date. Otherwise the test would fail the next day, e.g. on
// "start must not be in the past".

const DAY_MS = 24 * 60 * 60 * 1000;
/** Only dates this close to today count as relative; a fixed date further away (birthday, deadline) stays as is. */
export const DATE_WINDOW_DAYS = 60;

const pad = (number) => String(number).padStart(2, '0');
const FORMATS = {
    today: (date) => `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    todayIso: (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
};
/** The placeholders the tool knows; they need no `remember`. */
export const DATE_NAMES = new Set(Object.keys(FORMATS));
const PLACEHOLDER = /\{\{(today|todayIso)(?:([+-])(\d{1,3}))?\}\}/g;
// A date as a token of its own: no digit, or dot plus digit, directly before or after it.
const GERMAN = /(?<![\d.])(\d{2})\.(\d{2})\.(\d{4})(?!\.?\d)/g;
const ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g;

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

/** Recording: dates near today become placeholders. */
export const markDates = (value, now = new Date()) => replaceIn(value, (text) => text
    .replace(GERMAN, (match, day, month, year) => {
        const days = daysFrom(now, Number(year), Number(month), Number(day));
        return days === null || Math.abs(days) > DATE_WINDOW_DAYS ? match : placeholder('today', days);
    })
    .replace(ISO, (match, year, month, day) => {
        const days = daysFrom(now, Number(year), Number(month), Number(day));
        return days === null || Math.abs(days) > DATE_WINDOW_DAYS ? match : placeholder('todayIso', days);
    }));

/** Replay: placeholders become this day's date. */
export const fillDates = (value, now = new Date()) => replaceIn(value, (text) => text.replace(PLACEHOLDER, (match, name, sign, amount) => {
    const days = amount === undefined ? 0 : Number(amount) * (sign === '-' ? -1 : 1);
    return FORMATS[name](shifted(now, days));
}));
