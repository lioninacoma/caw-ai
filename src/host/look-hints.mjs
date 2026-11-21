// Which steps could get `look: true`: after a recording, its check run without AI measures per passed step whether the screen
// shows data that changes. Two signals, both without AI: text on the screen that came from the server (a value of a JSON
// response to a read of this run), and what the visual layer masks anyway (rows, list entries, cards, dates, remembered values,
// the run tag). A step that hits neither is offered to the human, who decides; caw cannot be sure.
// The response values stay in memory for the run: they may be personal data and never go into a file, the report or a log.

/** Shorter values are words of the app's own texts ("OK", "de") as often as data. */
export const MIN_VALUE = 3;
// Longer strings are documents (HTML, base64), not what a screen shows as one text.
const MAX_VALUE = 500;
/** Values kept per run: enough for the lists a screen shows, bounded for a session that loads a lot. */
export const MAX_VALUES = 20_000;
/** Visible texts read per step. */
export const MAX_TEXTS = 3000;

/** A text as compared: whitespace collapsed, trimmed, lower case. */
export const normalText = (text) => String(text).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Adds the string values of a JSON body, and numbers as the screen would show them, to `into`: normalized, at least MIN_VALUE
 * characters, keys left out (they are the API's names, not data).
 * @returns into
 */
export const responseValues = (body, into = new Set(), { max = MAX_VALUES } = {}) => {
    const stack = [body];
    while (stack.length > 0 && into.size < max) {
        const value = stack.pop();
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
            const text = normalText(value);
            if (text.length >= MIN_VALUE && text.length <= MAX_VALUE) into.add(text);
        } else if (Array.isArray(value)) stack.push(...value);
        else if (value !== null && typeof value === 'object') stack.push(...Object.values(value));
    }
    return into;
};

/**
 * Runs in the browser: the visible texts of the page, in the style of visual.mjs maskProbe: text nodes whose element is shown,
 * and the values of text fields (a form filled from the server shows data too). Passwords are left out.
 * @returns [text]
 */
export function textProbe({ max }) {
    const texts = [];
    const shown = (node) => node !== null && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null && texts.length < max; node = walker.nextNode()) {
        if (node.data.trim() !== '' && shown(node.parentElement)) texts.push(node.data);
    }
    for (const field of document.querySelectorAll('input:not([type=password]):not([type=hidden]), textarea')) {
        if (texts.length >= max) break;
        if (typeof field.value === 'string' && field.value.trim() !== '' && shown(field)) texts.push(field.value);
    }
    return texts;
}

/**
 * Does a visible text contain a value from the server? Values are looked up by their first characters, so a long list of
 * values costs about as much as the texts are long.
 * @param texts  textProbe's texts
 * @param values normalized values (responseValues)
 */
export const showsServed = (texts, values) => {
    const byStart = new Map();
    for (const value of values) {
        const key = value.slice(0, MIN_VALUE);
        if (!byStart.has(key)) byStart.set(key, []);
        byStart.get(key).push(value);
    }
    if (byStart.size === 0) return false;
    for (const raw of texts) {
        const text = normalText(raw);
        for (let at = 0; at + MIN_VALUE <= text.length; at += 1) {
            const candidates = byStart.get(text.slice(at, at + MIN_VALUE));
            if (candidates !== undefined && candidates.some((value) => text.startsWith(value, at))) return true;
        }
    }
    return false;
};

/**
 * The steps to offer for `look: true`: passed in this run, without `look` yet, and with a hint that neither signal hit.
 * @param hints Map step -> { served, masks } (playReplay's lookHints); a step without a hint was not measured
 * @returns [step id], in the order of the test
 */
export const lookCandidates = ({ spec, results, hints }) => spec.steps
    .filter(({ id, look }) => look !== true && results?.get(id)?.status === 'pass' && hints?.get(id) !== undefined && hints.get(id) !== null
        && hints.get(id).served === false && hints.get(id).masks === 0)
    .map(({ id }) => id);
