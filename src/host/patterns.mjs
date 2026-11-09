// Text oder Muster: Wo sich ein Inhalt in jedem Lauf aendert (Pruefsumme, Uhrzeit, ein Zaehler im Namen eines Knopfs), steht statt des
// festen Texts `{pattern: "<regulaerer Ausdruck>"}`. Das Muster gilt wie bei consoleIgnore ohne Flags und muss nicht den ganzen Text
// treffen; wer das will, setzt ^ und $.

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Ein Muster in der Form `{pattern: "..."}`, ohne weitere Felder, mit einem gueltigen Ausdruck. */
export const isPattern = (value) => {
    if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.pattern !== 'string' || value.pattern === '') return false;
    try {
        new RegExp(value.pattern);
        return true;
    } catch {
        return false;
    }
};

/** Die Kurzform fuer Meldungen: /Ausdruck/. */
export const patternLabel = (value) => (isPattern(value) ? `/${value.pattern}/` : String(value));

/** Trifft ein Text einen der Eintraege? Feste Texte zaehlen nur ganz, Muster per RegExp. */
export const textMatcher = (entries = []) => {
    const fixed = new Set(entries.filter((entry) => typeof entry === 'string'));
    const patterns = entries.filter(isPattern).map(({ pattern }) => new RegExp(pattern));
    return (text) => typeof text === 'string' && (fixed.has(text) || patterns.some((pattern) => pattern.test(text)));
};
