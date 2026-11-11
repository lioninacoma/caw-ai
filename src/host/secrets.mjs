// Passwords never leave the browser as text. Playwright's ARIA snapshot includes the value of every field, password fields too;
// without this redaction the role's password would end up in the snapshot for Claude and in the effect of a recording.

/* global document -- passwordValues runs inside the browser page */

export const MASK = '••••';
const MIN_SECRET = 4;

/** Runs in the browser: the values of all password fields, including open shadow roots and revealed fields with autocomplete. */
export function passwordValues() {
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of root.querySelectorAll('*')) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    // A revealed password is a text field; autocomplete still gives it away.
    return deepAll('input[type=password], input[autocomplete=current-password], input[autocomplete=new-password]').map((input) => input.value).filter((value) => value !== '');
}

/** Replaces every secret in the text with the mask. Values that are too short stay, they would match arbitrary words. */
export const redact = (text, secrets) => {
    if (typeof text !== 'string') return text;
    const wanted = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);
    return wanted.reduce((current, secret) => current.split(secret).join(MASK), text);
};

/** Like `redact`, for every string in arrays and plain objects, e.g. a result for the report. */
export const redactDeep = (value, secrets) => {
    if (typeof value === 'string') return redact(value, secrets);
    if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]));
    return value;
};

/**
 * Redacts a text with the known secrets (the role's password) and the password fields of the page.
 * @param page page or frame with `evaluate`
 */
export const redactFor = async (page, text, known = []) => {
    // Wrapped in an async function so that a synchronous throw from evaluate is caught too.
    const values = await (async () => page.evaluate(passwordValues))().catch(() => []);
    return redact(text, [...known, ...(Array.isArray(values) ? values : [])]);
};
