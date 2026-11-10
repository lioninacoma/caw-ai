// Pixel-Art-Konventionen auf den Pixor-Frames, bevor Sheet und GIFs entstehen. Arbeitet Zelle fuer Zelle:
//
// - Alpha nur 0 oder 255: halbtransparente Kanten verschwimmen auf jedem Hintergrund.
// - Keine verwaisten Pixel: ein deckendes Pixel ohne deckenden Nachbarn (auch diagonal) ist Rauschen.
// - Keine Farbinseln: 1-2 Pixel einer Farbe mitten in einer anderen Flaeche sind Rauschen (Patches), sie gehen in der
//   Umgebung auf.
// - Das Auge ist in jedem Frame derselbe Stempel (2x2, ein Glanzpunkt) mit einem Rand in Kopffarbe; geschlossen ein
//   Strich an derselben Stelle (die Sonde, ein Render mit offenem Auge, zeigt, wo).

const hex = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
const at = (image, x, y) => (y * image.width + x) * 4;
const same = (image, i, rgb) => image.data[i] === rgb[0] && image.data[i + 1] === rgb[1] && image.data[i + 2] === rgb[2] && image.data[i + 3] > 0;
const put = (image, i, rgb) => { image.data.set([...rgb, 255], i); };

export const cleanFrames = (image, { cell, eyeDark, eyeShine, island = 2 }) => {
    const out = { width: image.width, height: image.height, data: Buffer.from(image.data) };
    const stats = { alpha: 0, orphans: 0, islands: 0 };
    const dark = hex(eyeDark), shine = hex(eyeShine);

    for (let i = 3; i < out.data.length; i += 4) {
        const a = out.data[i];
        if (a !== 0 && a !== 255) { out.data[i] = a < 128 ? 0 : 255; stats.alpha++; }
        if (out.data[i] === 0) out.data.fill(0, i - 3, i);
    }

    for (let cy = 0; cy < out.height; cy += cell) for (let cx = 0; cx < out.width; cx += cell) {
        const opaque = (x, y) => x >= cx && y >= cy && x < cx + cell && y < cy + cell && out.data[at(out, x, y) + 3] > 0;
        const orphans = [];
        for (let y = cy; y < cy + cell; y++) for (let x = cx; x < cx + cell; x++) {
            if (!opaque(x, y)) continue;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && opaque(x + dx, y + dy)) n++;
            if (n === 0) orphans.push(at(out, x, y));
        }
        for (const i of orphans) out.data.fill(0, i, i + 4);
        stats.orphans += orphans.length;

        // Farbinseln: eine Flaeche aus hoechstens `island` Pixeln einer Farbe (4er-Nachbarschaft) wirkt als Rauschen und
        // nimmt die Farbe an, die sie am haeufigsten umgibt. Augen bleiben, wie sie sind.
        for (let pass = 0; pass < 3; pass++) {
            const seen = new Uint8Array(cell * cell);
            let changed = 0;
            for (let y0 = cy; y0 < cy + cell; y0++) for (let x0 = cx; x0 < cx + cell; x0++) {
                const k0 = (y0 - cy) * cell + x0 - cx;
                if (seen[k0] || !opaque(x0, y0)) continue;
                const i0 = at(out, x0, y0), color = out.data.readUInt32BE(i0);
                const region = [], stack = [[x0, y0]];
                seen[k0] = 1;
                while (stack.length > 0) {
                    const [x, y] = stack.pop();
                    region.push([x, y]);
                    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
                        if (!opaque(nx, ny)) continue;
                        const k = (ny - cy) * cell + nx - cx;
                        if (!seen[k] && out.data.readUInt32BE(at(out, nx, ny)) === color) { seen[k] = 1; stack.push([nx, ny]); }
                    }
                }
                if (region.length > island || same(out, i0, dark) || same(out, i0, shine)) continue;
                const around = new Map();
                for (const [x, y] of region) for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
                    // Das Auge waechst nicht: Augenfarben kommen als Ersatz nicht in Frage.
                    const j = at(out, nx, ny);
                    if (!opaque(nx, ny) || same(out, j, dark) || same(out, j, shine)) continue;
                    const c = out.data.readUInt32BE(j);
                    if (c !== color) around.set(c, (around.get(c) ?? 0) + 1);
                }
                if (around.size === 0) continue;
                const [best] = [...around].sort((a, b) => b[1] - a[1])[0];
                for (const [x, y] of region) out.data.writeUInt32BE(best, at(out, x, y));
                changed += region.length;
            }
            stats.islands += changed;
            if (changed === 0) break;
        }

    }
    return { image: out, stats };
};

// Das Auge als fester Stempel. Pixor zeichnet es je nach Kopfhaltung 1x2 bis 3x3 gross, und daneben liegt die dunkle Linie
// zwischen Kopf und Schnabel: Beides verschmilzt zu einem Balken, der von Frame zu Frame waechst und schrumpft. Darum an
// der Mitte des Auges immer dieselben eyeSize x eyeSize Pixel (Glanz oben vorn), rundherum ein Rand in Kopffarbe ohne dunkle Linie
// (heller als `dim`), dazu ein fester Lichtpunkt auf dem Scheitel (`crown`). Ein geschlossenes Auge (die Sonde hat eins, der Render nicht) wird an derselben Stelle ein Strich.
// Springt die Stelle nur fuer einen Frame, bleibt sie, wo sie davor und danach ist. Laeuft nach steadyFrames, sonst mischt
// der Zeitfilter zwei verschobene Stempel. clips: [{ rects, loop }]. Aendert image.
export const stampEyes = (image, clips, { probe = null, eyeDark, eyeShine, lid, halo = ['#3a3e60'], dim = 40, crown = null, eyeSize = 2 }) => {
    const stats = { eyes: 0, lids: 0 };
    const dark = hex(eyeDark), shine = hex(eyeShine), ink = hex(lid);
    const skin = new Set(halo.map((c) => Buffer.from([...hex(c), 255]).readUInt32BE(0)));
    const isEye = (img, x, y) => same(img, at(img, x, y), dark) || same(img, at(img, x, y), shine);
    const n = eyeSize, span = Array.from({ length: n }, (_, k) => k);
    const RING = span.flatMap((k) => [[k, -1], [k, n], [-1, k], [n, k]]);

    const locate = (r) => {
        const find = (img) => {
            const eye = [];
            for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (isEye(img, x, y)) eye.push([x - r.x, y - r.y]);
            return eye;
        };
        let eye = find(image);
        const open = eye.length > 0;
        if (!open && probe) eye = find(probe);
        if (eye.length === 0) return null;
        const mx = eye.reduce((t, [x]) => t + x, 0) / eye.length, my = eye.reduce((t, [, y]) => t + y, 0) / eye.length;
        return { x: Math.round(mx - (n - 1) / 2), y: Math.round(my - (n - 1) / 2), open, eye };
    };

    const stamp = (r, { x: x0, y: y0, open, eye }) => {
        const opaque = (x, y) => x >= 0 && y >= 0 && x < r.w && y < r.h && image.data[at(image, r.x + x, r.y + y) + 3] > 0;
        const idx = (x, y) => at(image, r.x + x, r.y + y);
        // Kopffarbe: die haeufigste der `halo`-Farben um das Auge.
        const count = new Map();
        for (let y = y0 - 3; y <= y0 + n + 2; y++) for (let x = x0 - 3; x <= x0 + n + 2; x++) {
            if (!opaque(x, y)) continue;
            const c = image.data.readUInt32BE(idx(x, y));
            if (skin.has(c)) count.set(c, (count.get(c) ?? 0) + 1);
        }
        const head = count.size > 0 ? [...count].sort((p, q) => q[1] - p[1])[0][0] : [...skin][0];
        if (open) for (const [x, y] of eye) image.data.writeUInt32BE(head, idx(x, y));
        for (const [dx, dy] of RING) {
            const x = x0 + dx, y = y0 + dy;
            if (!opaque(x, y)) continue;
            const i = idx(x, y), [cr, cg, cb] = image.data.subarray(i, i + 3);
            if (0.299 * cr + 0.587 * cg + 0.114 * cb < dim) image.data.writeUInt32BE(head, i);
        }
        const pixels = open ? span.flatMap((dy) => span.map((dx) => [dx, dy, dx === 0 && dy === 0 ? shine : dark])) : span.map((dx) => [dx, n - 1, ink]);
        for (const [dx, dy, rgb] of pixels) if (opaque(x0 + dx, y0 + dy)) put(image, idx(x0 + dx, y0 + dy), rgb);
        // Fester Lichtpunkt: `crown.width` Pixel oben auf dem Scheitel, ab `crown.dx` Spalten rechts der Augenmitte; jeweils
        // das oberste Gefieder-Pixel der Spalte, hoechstens 6 Pixel ueber dem Auge. Er haengt am Auge und am Umriss und
        // wandert darum ruhig mit dem Kopf.
        if (crown) for (let x = x0 + (crown.dx ?? 0); x < x0 + (crown.dx ?? 0) + (crown.width ?? 2); x++) {
            for (let y = Math.max(0, y0 - 6); y < y0; y++) {
                if (!opaque(x, y)) continue;
                if (skin.has(image.data.readUInt32BE(idx(x, y))) && !opaque(x, y - 1)) put(image, idx(x, y), hex(crown.color));
                break;
            }
        }
        if (open) stats.eyes++; else stats.lids++;
    };

    for (const { rects, loop } of clips) {
        const spots = rects.map(locate), n = spots.length;
        const held = spots.map((s, i) => {
            if (!s || n < 3 || (!loop && (i === 0 || i === n - 1))) return s;
            const p = spots[(i - 1 + n) % n], q = spots[(i + 1) % n];
            const jump = p && q && p.x === q.x && p.y === q.y && (s.x !== p.x || s.y !== p.y) && Math.abs(s.x - p.x) <= 1 && Math.abs(s.y - p.y) <= 1;
            return jump ? { ...s, x: p.x, y: p.y } : s;
        });
        held.forEach((s, i) => { if (s) stamp(rects[i], s); });
    }
    return stats;
};

// Wie viele Farben das Bild hat (ohne durchsichtig): Pixel-Art lebt von einer kleinen, festen Palette.
export const countColors = (image) => {
    const colors = new Set();
    for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 3] > 0) colors.add(image.data.readUInt32BE(i));
    return colors.size;
};

// Zeitliche Ruhe (gegen "Boiling"): Ein kleiner Fleck, der nur in einem Frame anders ist als davor und danach (und davor
// gleich danach ist), nimmt deren Wert an. So blinken keine Linien und Beinpixel fuer einen Frame auf oder weg; echte
// Bewegung aendert groessere Flaechen oder mehrere Frames und bleibt. frames: Rechtecke eines Clips in Reihenfolge.
export const steadyFrames = (image, frames, { loop = false, blob = 6 } = {}) => {
    const n = frames.length;
    if (n < 3) return 0;
    const { w, h } = frames[0];
    const pixel = (r, x, y) => image.data.readUInt32BE(((r.y + y) * image.width + r.x + x) * 4);
    const before = frames.map((r) => Array.from({ length: w * h }, (_, k) => pixel(r, k % w, Math.floor(k / w))));
    let fixed = 0;
    for (let i = 0; i < n; i++) {
        if (!loop && (i === 0 || i === n - 1)) continue;
        const prev = before[(i - 1 + n) % n], next = before[(i + 1) % n], cur = before[i];
        const odd = new Uint8Array(w * h);
        for (let k = 0; k < w * h; k++) if (prev[k] === next[k] && cur[k] !== prev[k]) odd[k] = 1;
        const seen = new Uint8Array(w * h);
        for (let k0 = 0; k0 < w * h; k0++) {
            if (!odd[k0] || seen[k0]) continue;
            const region = [k0], stack = [k0];
            seen[k0] = 1;
            while (stack.length > 0) {
                const k = stack.pop(), x = k % w, y = Math.floor(k / w);
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy, nk = ny * w + nx;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[nk] || !odd[nk]) continue;
                    seen[nk] = 1; stack.push(nk); region.push(nk);
                }
            }
            if (region.length > blob) continue;
            const r = frames[i];
            for (const k of region) image.data.writeUInt32BE(prev[k], ((r.y + Math.floor(k / w)) * image.width + r.x + k % w) * 4);
            fixed += region.length;
        }
    }
    return fixed;
};

// Umriss: 1 Pixel breit um alles Deckende, nur waagrecht und senkrecht angesetzt (keine Ecken, die Treppen machen), in
// jedem Frame gleich berechnet und darum lueckenlos. Pixors eigener Umriss (`--outer dark`) laesst an Schnabel und Fuessen
// Luecken. `color` ist die Umrissfarbe, `by` faerbt ihn neben bestimmten Farben anders (Selout, etwa dunkelbraun am gelben
// Schnabel). Laeuft als Letztes; die Zelle braucht dafuer ringsum einen Pixel Platz, den die Groessensuche einplant.
export const outlineFrames = (image, cell, { color, by = {}, bridge = [] }) => {
    const key = (c) => Buffer.from([...hex(c), 255]).readUInt32BE(0);
    const ink = key(color), map = new Map(Object.entries(by).map(([from, to]) => [key(from), key(to)])), bridges = new Set(bridge.map(key));
    let drawn = 0;
    for (let cy = 0; cy < image.height; cy += cell) for (let cx = 0; cx < image.width; cx += cell) {
        const fill = new Uint32Array(cell * cell), solid = new Uint8Array(cell * cell);
        const read = () => {
            for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
                const i = at(image, cx + x, cy + y);
                solid[y * cell + x] = image.data[i + 3] ? 1 : 0;
                fill[y * cell + x] = solid[y * cell + x] ? image.data.readUInt32BE(i) : 0;
            }
        };
        read();
        // Bruecken: Eine 1-px-Luecke zwischen zwei Pixeln in `bridge`-Farben (die Zehen) wird gefuellt, sonst macht der
        // Umriss daraus einen Kamm.
        if (bridges.size > 0) {
            for (let y = 0; y < cell; y++) for (let x = 1; x < cell - 1; x++) {
                const l = fill[y * cell + x - 1], r = fill[y * cell + x + 1];
                if (!solid[y * cell + x] && bridges.has(l) && bridges.has(r)) image.data.writeUInt32BE(l, at(image, cx + x, cy + y));
            }
            read();
        }
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
            if (solid[y * cell + x]) continue;
            const near = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
                .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < cell && ny < cell && solid[ny * cell + nx]);
            if (near.length === 0) continue;
            const special = near.map(([nx, ny]) => map.get(fill[ny * cell + nx])).find((c) => c !== undefined);
            image.data.writeUInt32BE(special ?? ink, at(image, cx + x, cy + y));
            drawn++;
        }
    }
    return drawn;
};

/**
 * Feste Fuesse: In sitzenden Clips bewegen sich die Fuesse nicht, Pixor rastert sie aber jeden Frame etwas anders (Zehen
 * mal 1, mal 3 px, die zwei Grautoene wechseln, beim Atmen rutschen sie mit dem Koerper um 1 px). Jede Zeile, die in allen
 * Frames eines Clips nur Fuss (`colors`), Umriss (`outline`) oder leer ist und einen Fuss zeigt (oder darunter liegt), wird
 * in allen Frames zur haeufigsten Fassung dieser Zeile. Zeilen mit Koerperpixeln bleiben unberuehrt.
 * clips: [[rect, ...], ...] je Clip. Ergebnis: Zahl der geaenderten Pixel.
 */
export const plantFeet = (image, clips, { colors, outline }) => {
    const key = (c) => Buffer.from([...hex(c), 255]).readUInt32BE(0);
    const ink = key(outline), allowed = new Set([0, ink, ...colors.map(key)]);
    const value = (x, y) => { const i = at(image, x, y); return image.data[i + 3] ? image.data.readUInt32BE(i) : 0; };
    let changed = 0;
    for (const rects of clips) {
        if (rects.length < 2) continue;
        const { w, h } = rects[0];
        let below = false; // unter der ersten Zeile mit Fuss: auch reine Umrisszeilen, sonst bleibt der Umriss alter Zehen stehen
        for (let y = 0; y < h; y++) {
            const rows = rects.map((r) => Array.from({ length: w }, (_, x) => value(r.x + x, r.y + y)));
            if (!rows.every((row) => row.every((v) => allowed.has(v)))) continue;
            if (rows.some((row) => row.some((v) => v !== 0 && v !== ink))) below = true;
            if (!below) continue;
            const count = new Map();
            for (const row of rows) { const k = row.join(','); count.set(k, (count.get(k) ?? 0) + 1); }
            const best = [...count].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
            rects.forEach((r, n) => best.forEach((v, x) => {
                if (rows[n][x] === v) return;
                image.data.writeUInt32BE(v, at(image, r.x + x, r.y + y));
                changed++;
            }));
        }
    }
    return changed;
};

/**
 * Fester Schnabel: Beim Atmen hebt und senkt sich der Kopf um Bruchteile eines Pixels, Pixor rastert die Schnabelspitze
 * dann jedes Mal anders und neben dem Schnabel blitzt ein dunkles Pixel. In Clips, in denen sich der Kopf nicht dreht,
 * ist der Schnabel darum ein starres Stueck: Gemessen vom gestempelten Auge (`eyeShine`) bekommt jedes Pixel im Rahmen um
 * den Schnabel (`colors`, 1 px Rand, darueber der Scheitel) den Wert, den es in den meisten Frames hat. Laeuft vor dem Umriss.
 * clips: [[rect, ...], ...] je Clip. Ergebnis: Zahl der geaenderten Pixel.
 */
export const steadyBeak = (image, clips, { colors, eyeShine }) => {
    const key = (c) => Buffer.from([...hex(c), 255]).readUInt32BE(0);
    const beak = new Set(colors.map(key)), shine = key(eyeShine);
    const value = (x, y) => { const i = at(image, x, y); return image.data[i + 3] ? image.data.readUInt32BE(i) : 0; };
    let changed = 0;
    for (const rects of clips) {
        if (rects.length < 2) continue;
        const { w, h } = rects[0];
        const eyes = rects.map((r) => {
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (value(r.x + x, r.y + y) === shine) return [x, y];
            return null;
        });
        if (eyes.some((e) => e === null)) continue; // Auge zu: kein Bezugspunkt
        // Rahmen um alle Schnabelpixel aller Frames, relativ zum Auge.
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        rects.forEach((r, n) => {
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (beak.has(value(r.x + x, r.y + y))) {
                const dx = x - eyes[n][0], dy = y - eyes[n][1];
                x0 = Math.min(x0, dx - 1); y0 = Math.min(y0, dy - 1); x1 = Math.max(x1, dx + 1); y1 = Math.max(y1, dy + 1);
            }
        });
        if (x0 === Infinity) continue;
        // Vor dem Auge der Schnabel; ueber dem Auge auch der Scheitel bis 3 px dahinter. Das Auge selbst bleibt dem Stempel.
        for (let dy = y0; dy <= y1; dy++) for (let dx = x0; dx <= (dy < 0 ? 3 : -1); dx++) {
            const cells = rects.map((r, n) => [eyes[n][0] + dx, eyes[n][1] + dy, r]);
            if (cells.some(([x, y]) => x < 0 || y < 0 || x >= w || y >= h)) continue;
            const values = cells.map(([x, y, r]) => value(r.x + x, r.y + y));
            if (values.every((v) => v === values[0])) continue;
            const count = new Map();
            for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
            const best = [...count].sort((a, b) => b[1] - a[1])[0][0];
            cells.forEach(([x, y, r], n) => {
                if (values[n] === best) return;
                image.data.writeUInt32BE(best, at(image, r.x + x, r.y + y));
                changed++;
            });
        }
    }
    return changed;
};

/**
 * Wippen um genau ein Pixel, wie man es in Pixel-Art von Hand macht: Alles ueber den Fuessen ruckt 1 px hoch, die Bein-Zeile
 * unter dem Gelenk steht doppelt (die Beine strecken sich). Ein in Blender gehobener Koerper liegt oft auf einer Pixelgrenze und
 * springt dann auch waagrecht, oder die Beine werden duenn und loesen sich vom Bauch.
 * frames: [{ rect, up, rest }]; rest: ein rect, dessen Bild der Frame vorher bekommt (idle besteht nur aus der Ruhepose).
 * colors: Fusstoene; die erste Zeile mit einem davon ist die oberste Bein-Zeile. Ergebnis: Zahl der gehobenen Frames.
 */
export const bobFrames = (image, frames, { colors }) => {
    const keys = new Set(colors.map((c) => Buffer.from([...hex(c), 255]).readUInt32BE(0)));
    const row = (r, y) => Buffer.from(image.data.subarray(at(image, r.x, r.y + y), at(image, r.x, r.y + y) + r.w * 4));
    const put = (r, y, buf) => buf.copy(image.data, at(image, r.x, r.y + y));
    let lifted = 0;
    for (const { rect: r, up, rest } of frames) {
        if (rest && rest !== r) for (let y = 0; y < r.h; y++) put(r, y, row(rest, y));
        if (!up) continue;
        let top = -1;
        for (let y = 0; y < r.h && top < 0; y++) {
            const line = row(r, y);
            for (let x = 0; x < r.w; x++) if (line[x * 4 + 3] && keys.has(line.readUInt32BE(x * 4))) { top = y; break; }
        }
        if (top < 1 || top + 1 >= r.h) continue;
        // Bis einschliesslich der Zeile unter der obersten Bein-Zeile hoch: Diese schmale Zeile (das Bein, nicht das breite
        // Gelenk am Bauch) steht danach doppelt.
        const shifted = [];
        for (let y = 1; y <= top + 1; y++) shifted.push(row(r, y));
        shifted.forEach((buf, y) => put(r, y, buf));
        lifted++;
    }
    return lifted;
};

/**
 * Offener Schnabel als fester Stempel, wie das Auge: Bei 16 px rastert Pixor einen offenen Schnabel als Klumpen, weiter
 * geoeffnet verschwindet der Unterschnabel hinter dem Kopf. Ein Frame gilt als offen, wenn er Unterschnabel (`lower`) zeigt.
 * Dann wird der gerenderte Schnabel entfernt (am Rand durchsichtig, innen `head`) und `pattern` gestempelt, gemessen vom
 * Auge (`W` im Muster, `eyeShine` im Bild): Y Oberschnabel, y Unterschnabel, m Rachen, h Kopf (damit der Schnabel am Kopf
 * sitzt, auch wenn der Kopf geneigt ist). Laeuft vor dem Umriss.
 * Ergebnis: Zahl der gestempelten Frames.
 */
export const openBeak = (image, rects, { upper, lower, mouth, head, eyeShine, pattern }) => {
    const key = (c) => Buffer.from([...hex(c), 255]).readUInt32BE(0);
    const up = key(upper), low = key(lower), shine = key(eyeShine);
    const ink = { Y: up, y: low, m: key(mouth), h: key(head) };
    let ex = 0, ey = 0;
    pattern.forEach((line, y) => { const x = line.indexOf('W'); if (x >= 0) { ex = x; ey = y; } });
    const value = (r, x, y) => {
        if (x < 0 || y < 0 || x >= r.w || y >= r.h) return 0;
        const i = at(image, r.x + x, r.y + y); return image.data[i + 3] ? image.data.readUInt32BE(i) : 0;
    };
    const set = (r, x, y, v) => { const i = at(image, r.x + x, r.y + y); if (v) image.data.writeUInt32BE(v, i); else image.data.writeUInt32BE(0, i); };
    let stamped = 0;
    for (const r of rects) {
        let eye = null, open = false;
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
            const v = value(r, x, y);
            if (v === shine && !eye) eye = [x, y];
            if (v === low) open = true;
        }
        if (!eye || !open) continue;
        const beak = [];
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if ([up, low].includes(value(r, x, y))) beak.push([x, y]);
        for (const [x, y] of beak) {
            const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => value(r, x + dx, y + dy) === 0);
            set(r, x, y, edge ? 0 : key(head));
        }
        pattern.forEach((line, py) => [...line].forEach((c, px) => {
            const x = eye[0] + px - ex, y = eye[1] + py - ey;
            if (ink[c] && x >= 0 && y >= 0 && x < r.w && y < r.h) set(r, x, y, ink[c]);
        }));
        stamped++;
    }
    return stamped;
};

/**
 * Farben eines Clips ersetzen (`map`: von -> nach), etwa einen flachen Fluegel beim Winken: Dreht sich der Fluegel durchs
 * Licht, wandert sein Schatten in jedem Frame anders ueber ihn. Ergebnis: Zahl der Pixel.
 */
export const recolor = (image, rects, map) => {
    const key = (c) => Buffer.from([...hex(c), 255]).readUInt32BE(0);
    const to = new Map(Object.entries(map).map(([a, b]) => [key(a), key(b)]));
    let changed = 0;
    for (const r of rects) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = at(image, r.x + x, r.y + y);
        const v = image.data[i + 3] ? to.get(image.data.readUInt32BE(i)) : undefined;
        if (v !== undefined) { image.data.writeUInt32BE(v, i); changed++; }
    }
    return changed;
};
