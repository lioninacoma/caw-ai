// Vorschlaege bei Tippfehlern: "Meintest du list?" fuer lsit, create-tiket oder s4.

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
 */
export const closest = (word, candidates) => {
    const limit = Math.max(1, Math.floor(String(word).length / 3));
    const scored = [...new Set(candidates)].map((candidate) => ({ candidate, distance: editDistance(word, candidate) })).filter(({ distance }) => distance <= limit);
    if (scored.length === 0) return undefined;
    const best = Math.min(...scored.map(({ distance }) => distance));
    const winners = scored.filter(({ distance }) => distance === best);
    return winners.length === 1 ? winners[0].candidate : undefined;
};
