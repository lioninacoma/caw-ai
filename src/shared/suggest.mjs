// Suggestions for typos: "Did you mean list?" for lsit, create-tiket or s4; insecureTls for insecureTLS, targets for target.

/** Damerau-Levenshtein edit distance (a transposition counts once), case-insensitive. */
export const editDistance = (left, right) => {
    const a = String(left).toLowerCase();
    const b = String(right).toLowerCase();
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
        }
    }
    return rows[a.length][b.length];
};

/**
 * The closest candidate if it is close enough and unique, else undefined. Close enough: at most a third of the length
 * differs, but at least one character. Several equally close candidates (S7 with S1 to S6) give no suggestion.
 * For names the human types: tests, steps, commands.
 */
export const closest = (word, candidates) => {
    const limit = Math.max(1, Math.floor(String(word).length / 3));
    const scored = [...new Set(candidates)].map((candidate) => ({ candidate, distance: editDistance(word, candidate) })).filter(({ distance }) => distance <= limit);
    if (scored.length === 0) return undefined;
    const best = Math.min(...scored.map(({ distance }) => distance));
    const winners = scored.filter(({ distance }) => distance === best);
    return winners.length === 1 ? winners[0].candidate : undefined;
};

/**
 * The allowed field closest to an unknown field: equal ignoring case, or at most two characters off (one for very
 * short names). For fields in config and test files.
 * @returns the name or undefined
 */
export const didYouMean = (key, allowed) => {
    const text = String(key);
    const same = allowed.find((name) => name.toLowerCase() === text.toLowerCase());
    if (same !== undefined) return same;
    const limit = text.length <= 3 ? 1 : 2;
    let best;
    let bestDistance = limit + 1;
    for (const name of allowed) {
        const value = editDistance(text, name);
        if (value < bestDistance) {
            best = name;
            bestDistance = value;
        }
    }
    return best;
};
