// Ein unbekanntes Feld ist meist ein Tippfehler: insecureTLS statt insecureTls, target statt targets. Der Vorschlag nennt das
// erlaubte Feld, das gemeint sein duerfte.

/** Editierdistanz nach Levenshtein, fuer kurze Feldnamen. */
const distance = (a, b) => {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length];
};

/**
 * Das erlaubte Feld, das dem unbekannten am naechsten liegt: gleich bis auf Gross- und Kleinschreibung oder hoechstens zwei
 * Zeichen anders. Sehr kurze Namen brauchen mehr Uebereinstimmung, sonst passte fast alles.
 * @returns der Name oder undefined
 */
export const didYouMean = (key, allowed) => {
    const text = String(key);
    const lower = text.toLowerCase();
    const same = allowed.find((name) => name.toLowerCase() === lower);
    if (same !== undefined) return same;
    const limit = text.length <= 3 ? 1 : 2;
    let best;
    let bestDistance = limit + 1;
    for (const name of allowed) {
        const value = distance(lower, name.toLowerCase());
        if (value < bestDistance) {
            best = name;
            bestDistance = value;
        }
    }
    return best;
};
