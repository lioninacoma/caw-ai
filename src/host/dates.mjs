// Datumswerte relativ zu heute. Fuellt Claude bei der Aufnahme ein Datum nahe am heutigen Tag ein oder prueft es, steht in der
// Aufzeichnung ein Platzhalter wie {{today}} oder {{today+7}}; das Abspielen setzt das Datum des Tages ein. Sonst scheiterte der
// Test am naechsten Tag, etwa an "Beginn darf nicht in der Vergangenheit liegen".

const DAY_MS = 24 * 60 * 60 * 1000;
/** Nur Daten so nah an heute gelten als relativ; ein festes Datum weiter weg (Geburtstag, Stichtag) bleibt, wie es ist. */
export const DATE_WINDOW_DAYS = 60;

const pad = (number) => String(number).padStart(2, '0');
const FORMATS = {
    today: (date) => `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    todayIso: (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
};
/** Die Platzhalter, die das Tool kennt; sie brauchen kein `remember`. */
export const DATE_NAMES = new Set(Object.keys(FORMATS));
const PLACEHOLDER = /\{\{(today|todayIso)(?:([+-])(\d{1,3}))?\}\}/g;
// Ein Datum als eigenes Token: keine Ziffer oder kein Punkt mit Ziffer direkt davor oder danach.
const GERMAN = /(?<![\d.])(\d{2})\.(\d{2})\.(\d{4})(?!\.?\d)/g;
const ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g;

const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const shifted = (now, days) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);

/** Tage von heute bis zu diesem Datum, oder null, wenn es kein gueltiges Datum ist. */
const daysFrom = (now, year, month, day) => {
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return Math.round((date - midnight(now)) / DAY_MS);
};

const placeholder = (name, days) => `{{${name}${days === 0 ? '' : `${days > 0 ? '+' : '-'}${Math.abs(days)}`}}}`;

const replaceIn = (value, replace) => JSON.parse(replace(JSON.stringify(value)));

/** Aufnahme: Daten nahe an heute werden zu Platzhaltern. */
export const markDates = (value, now = new Date()) => replaceIn(value, (text) => text
    .replace(GERMAN, (match, day, month, year) => {
        const days = daysFrom(now, Number(year), Number(month), Number(day));
        return days === null || Math.abs(days) > DATE_WINDOW_DAYS ? match : placeholder('today', days);
    })
    .replace(ISO, (match, year, month, day) => {
        const days = daysFrom(now, Number(year), Number(month), Number(day));
        return days === null || Math.abs(days) > DATE_WINDOW_DAYS ? match : placeholder('todayIso', days);
    }));

/** Abspielen: Platzhalter werden zum Datum dieses Tages. */
export const fillDates = (value, now = new Date()) => replaceIn(value, (text) => text.replace(PLACEHOLDER, (match, name, sign, amount) => {
    const days = amount === undefined ? 0 : Number(amount) * (sign === '-' ? -1 : 1);
    return FORMATS[name](shifted(now, days));
}));
