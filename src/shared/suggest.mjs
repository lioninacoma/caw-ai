// Vorschlaege bei Tippfehlern: "Meintest du list?" fuer lsit, create-tiket oder s4; insecureTls fuer insecureTLS, targets fuer target.

/** Editierabstand nach Damerau-Levenshtein (eine Vertauschung zaehlt einfach), ohne Unterschied von Gross und Klein. */
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
 * Der naechste Kandidat, wenn er nah genug und eindeutig ist; sonst undefined. Nah genug: hoechstens ein Drittel der Laenge
 * abweichend, mindestens aber ein Zeichen. Mehrere gleich nahe Kandidaten (S7 bei S1 bis S6) ergeben keinen Vorschlag.
 * Fuer Namen, die der Mensch eintippt: Tests, Schritte, Befehle.
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
 * Das erlaubte Feld, das einem unbekannten Feld am naechsten liegt: gleich bis auf Gross- und Kleinschreibung oder hoechstens zwei
 * Zeichen anders, bei sehr kurzen Namen eins. Fuer Felder in Config und Testdateien.
 * @returns der Name oder undefined
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
