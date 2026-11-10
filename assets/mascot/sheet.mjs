// Setzt aus Pixors Ausgabe (eine Zeile je Clip, alle Frames) das Spritesheet der Werkbank zusammen: eine Zeile je Clip in
// der Reihenfolge von mascot.json (`clips`), dazu die Tabelle, nach der die Werkbank abspielt.

import { blank } from './png.mjs';

/** Pixors JSON -> Map Clip -> Frame-Rechtecke in Reihenfolge. */
export const pixorClips = (json) => {
    const clips = new Map();
    for (const entry of json.frames) {
        const { action, index } = entry.pixor ?? {};
        if (action == null) continue;
        if (!clips.has(action)) clips.set(action, []);
        clips.get(action)[index] = entry.frame;
    }
    return clips;
};

/** Unterste Zeile mit sichtbarem Pixel im Rechteck, -1 wenn leer. */
const bottomRow = (image, { x, y, w, h }) => {
    for (let row = h - 1; row >= 0; row -= 1) {
        for (let col = 0; col < w; col += 1) if (image.data[((y + row) * image.width + x + col) * 4 + 3] > 0) return row;
    }
    return -1;
};

// Kopiert aus dem Pixor-Frame `rect` das Fenster ab (ox, oy) in Zellgroesse; was ausserhalb des Frames liegt, bleibt leer.
const copyCell = (from, rect, to, tx, ty, ox, oy, cell) => {
    for (let row = 0; row < cell; row += 1) {
        const sy = oy + row;
        if (sy < 0 || sy >= rect.h) continue;
        for (let col = 0; col < cell; col += 1) {
            const sx = ox + col;
            if (sx < 0 || sx >= rect.w) continue;
            const src = ((rect.y + sy) * from.width + rect.x + sx) * 4;
            from.data.copy(to.data, ((ty + row) * to.width + tx + col) * 4, src, src + 4);
        }
    }
};

/** Gemeinsamer Rahmen aller sichtbaren Pixel ueber alle Frames, in Frame-Koordinaten; null, wenn alles leer ist. */
const unionBox = (image, rects) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (const r of rects) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        if (image.data[((r.y + y) * image.width + r.x + x) * 4 + 3] === 0) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
};

const sameRect = (image, a, b) => {
    for (let row = 0; row < a.h; row += 1) {
        const at = (r) => ((r.y + row) * image.width + r.x) * 4;
        if (!image.data.subarray(at(a), at(a) + a.w * 4).equals(image.data.subarray(at(b), at(b) + b.w * 4))) return false;
    }
    return true;
};

/**
 * spec: { cell, render, fps, clips: [name, ...], free: [name, ...], twos: [name, ...], baseline }
 * Pixor rendert `render` x `render` Pixel (Standard: cell); daraus wird je Frame ein Fenster in Zellgroesse geschnitten,
 * ohne zu skalieren. So kann der Vogel die Zelle fuellen, obwohl Pixor beim Einpassen Rand laesst. Waagrecht steht der
 * gemeinsame Rahmen aller Frames in der Mitte; unten das tiefste Pixel aller Frames, die Fuesse des ersten Clips mindestens
 * `baseline` Pixel ueber dem Zellboden. `feet` in der Tabelle sagt der Werkbank, wie hoch die Fuesse in der Zelle stehen.
 * Gleiche Frames hintereinander werden zu einem, der entsprechend laenger steht (Pixel-Art lebt von Haltepunkten).
 * Ergebnis: sheet, table { cell, width, height, feet, shift: { name: [dx, dy] }, clips: { name: [[spalte, zeile, ms], ...] } }, missing (Clips ohne
 * Frames), clipped (wie viele Pixel der Vogel ueber die Zelle ragt) und extent (seine groesste Ausdehnung).
 */
export const buildSheet = (pixorImage, pixorJson, spec) => {
    const { cell, fps, clips: names, baseline = 0 } = spec;
    const render = spec.render ?? cell;
    const clips = pixorClips(pixorJson);
    const missing = names.filter((name) => !clips.get(name)?.length);
    // Clips in `twos` laufen "auf Zweien" wie im Zeichentrick: Jede zweite Zeichnung steht doppelt so lang, die dazwischen
    // faellt weg. Bei 16 px verschiebt fast jeder Frame auf Einsen nur einzelne Pixel, das wirkt zittrig.
    const twos = new Set(spec.twos ?? []);
    const held = names.map((name) => {
        const frames = [];
        for (const [index, rect] of (clips.get(name) ?? []).entries()) {
            if (rect.w !== render || rect.h !== render) throw new Error(`Pixor liefert ${rect.w}x${rect.h}, erwartet ${render}x${render}`);
            const last = frames.at(-1);
            if (last && ((twos.has(name) && index % 2 === 1) || sameRect(pixorImage, last.rect, rect))) last.n += 1; else frames.push({ rect, n: 1 });
        }
        return frames;
    });
    const columns = Math.max(1, ...held.map((frames) => frames.length));
    const sheet = blank(cell * columns, cell * names.length);
    // Die sitzenden Clips teilen sich einen Zuschnitt, damit beim Wechsel nichts springt. Clips in `free` (der Flug) bekommen
    // ihren eigenen und nutzen so den Platz, den die anderen frei lassen; `shift` sagt der Werkbank, um wie viel sie den Clip
    // zuruecksetzen muss, damit er dort steht, wo er mit dem gemeinsamen Zuschnitt stuende.
    const free = new Set(spec.free ?? []);
    const shared = held.filter((_, r) => !free.has(names[r])).flat().map(({ rect }) => rect);
    const fallback = { x0: 0, y0: 0, x1: render - 1, y1: render - 1 };
    const box = unionBox(pixorImage, shared) ?? fallback;
    // Die tiefsten Fuesse aller Frames des ersten Clips, damit kein Frame unten abgeschnitten wird.
    const feet = Math.max(-1, ...(held[0] ?? []).map(({ rect }) => bottomRow(pixorImage, rect)));
    // Unten steht das tiefste Pixel der gemeinsamen Clips, hoechstens aber die Fuesse `baseline` Pixel hoch. Wie weit die Fuesse
    // ueber dem Zellboden stehen, steht als `feet` in der Tabelle.
    const width = box.x1 - box.x0 + 1, bottom = feet < 0 ? box.y1 : Math.max(box.y1, feet + baseline);
    const ox = Math.round(box.x0 - (cell - width) / 2), oy = bottom - (cell - 1);
    let clipped = Math.max(0, width - cell) + Math.max(0, oy - box.y0);
    let extent = Math.max(width, bottom - box.y0 + 1);
    const table = { cell, width: sheet.width, height: sheet.height, feet: feet < 0 ? 0 : bottom - feet, shift: {}, clips: {} };
    const offset = names.map((name, r) => {
        if (!free.has(name)) return [ox, oy];
        const own = unionBox(pixorImage, held[r].map(({ rect }) => rect)) ?? fallback;
        const w = own.x1 - own.x0 + 1, h = own.y1 - own.y0 + 1;
        clipped = Math.max(clipped, Math.max(0, w - cell) + Math.max(0, h - cell));
        extent = Math.max(extent, w, h);
        // Waagrecht fuer sich mittig; senkrecht so nah am gemeinsamen Zuschnitt wie moeglich, damit ein sitzender Clip
        // (Winken) auf dem Boden bleibt und nur ein Clip, der nicht anders passt (Flug), hochrueckt.
        const fx = Math.round(own.x0 - (cell - w) / 2), fy = Math.min(Math.max(oy, own.y1 - (cell - 1)), own.y0);
        table.shift[name] = [ox - fx, oy - fy];
        return [fx, fy];
    });
    for (const [r, frames] of held.entries()) {
        // Ganze Millisekunden, ohne dass sich die Rundung ueber den Clip aufsummiert.
        let t = 0, shown = 0;
        table.clips[names[r]] = frames.map(({ rect, n }, c) => {
            copyCell(pixorImage, rect, sheet, c * cell, r * cell, offset[r][0], offset[r][1], cell);
            t += n;
            const until = Math.round((t * 1000) / fps), ms = until - shown;
            shown = until;
            return [c, r, ms];
        });
    }
    return { sheet, table, missing, dy: -oy, clipped, extent };
};

// Die Tabelle fuer die Werkbank, Seite an Seite mit assets/mascot/raven-sheet.png.
export const ravenClipsModule = (table) => `// Erzeugt von assets/mascot (npm run mascot -- --install), passend zu assets/mascot/raven-sheet.png. Nicht von Hand aendern.
// Je Clip die Frames als [Spalte, Zeile, Millisekunden]; cell, width und height in CSS-Pixeln.
export const RAVEN_CLIPS = ${JSON.stringify(table)};
`;
