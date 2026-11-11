// Text or pattern: where content changes on every run (checksum, time, a counter in a button label), a test states
// `{pattern: "<regular expression>"}` instead of the fixed text. As with consoleIgnore, the pattern takes no flags and need not
// match the whole text; use ^ and $ for that.

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A pattern of the form `{pattern: "..."}`, with no other fields and a valid expression. */
export const isPattern = (value) => {
    if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.pattern !== 'string' || value.pattern === '') return false;
    try {
        new RegExp(value.pattern);
        return true;
    } catch {
        return false;
    }
};

/** Short form for messages: /expression/. */
export const patternLabel = (value) => (isPattern(value) ? `/${value.pattern}/` : String(value));

/** Does a text match one of the entries? Fixed texts must match exactly, patterns via RegExp. */
export const textMatcher = (entries = []) => {
    const fixed = new Set(entries.filter((entry) => typeof entry === 'string'));
    const patterns = entries.filter(isPattern).map(({ pattern }) => new RegExp(pattern));
    return (text) => typeof text === 'string' && (fixed.has(text) || patterns.some((pattern) => pattern.test(text)));
};
