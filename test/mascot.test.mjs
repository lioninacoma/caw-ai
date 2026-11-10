import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RAVEN_CLIPS } from '../src/host/raven-clips.mjs';
import { bobFrames, cleanFrames, openBeak, outlineFrames, plantFeet, stampEyes, steadyBeak, steadyFrames } from '../assets/mascot/clean.mjs';
import { blank, decodePng, encodePng } from '../assets/mascot/png.mjs';
import { buildSheet } from '../assets/mascot/sheet.mjs';

const px = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const paint = (image, x, y, rgba) => image.data.set(rgba, (y * image.width + x) * 4);
const fill = (image, x0, y0, w, h, rgba) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) paint(image, x, y, rgba); };

test('mascot: PNG hin und zurueck', () => {
    const image = blank(3, 2);
    paint(image, 0, 0, [8, 8, 12, 255]);
    paint(image, 2, 1, [196, 200, 222, 128]);
    const back = decodePng(encodePng(image));
    assert.deepEqual([back.width, back.height], [3, 2]);
    assert.deepEqual(back.data, image.data);
});

test('mascot: raven-clips.mjs passt zu assets/raven-sheet.png', () => {
    const sheet = decodePng(readFileSync(new URL('../assets/raven-sheet.png', import.meta.url)));
    const { cell, width, height, clips } = RAVEN_CLIPS;
    // Das Sheet wird auf width x height CSS-Pixel gezogen, jede Zelle muss darin liegen.
    assert.equal(width / height, sheet.width / sheet.height);
    for (const name of ['idle', 'fly', 'peck', 'blink', 'caw', 'puff', 'doze', 'wave', 'joy', 'sad', 'sigh', 'nod']) {
        assert.ok(clips[name]?.length > 0, name);
        for (const [c, r, ms] of clips[name]) {
            assert.ok((c + 1) * cell <= width && (r + 1) * cell <= height && ms > 0, `${name} ${c},${r}`);
        }
    }
    // Logo und "Animationen aus" zeigen die Zelle oben links: der erste Frame von idle.
    assert.deepEqual(clips.idle[0].slice(0, 2), [0, 0]);
});

test('mascot: eine Zeile je Clip, gleiche Frames werden gehalten, Fuesse auf dem Zellenboden', () => {
    // Pixor-Ausgabe: idle mit drei Frames zu 4x4 (die ersten zwei gleich), fly fehlt.
    const pixor = blank(12, 4);
    paint(pixor, 0, 1, [1, 2, 3, 255]);
    paint(pixor, 4, 1, [1, 2, 3, 255]);
    paint(pixor, 9, 1, [4, 5, 6, 255]);
    const json = { frames: [0, 1, 2].map((index) => ({ frame: { x: index * 4, y: 0, w: 4, h: 4 }, pixor: { action: 'idle', index } })) };
    const { sheet, table, missing, dy } = buildSheet(pixor, json, { cell: 4, fps: 10, clips: ['idle', 'fly'] });
    assert.deepEqual([sheet.width, sheet.height], [8, 8]);
    assert.equal(dy, 2);
    // Der gemeinsame Rahmen (Spalten 0-1) steht waagrecht in der Mitte der 4er-Zelle: eine Spalte nach rechts.
    assert.deepEqual(px(sheet, 1, 3), [1, 2, 3, 255]);
    assert.deepEqual(px(sheet, 6, 3), [4, 5, 6, 255]);
    assert.deepEqual(table, { cell: 4, width: 8, height: 8, feet: 0, shift: {}, clips: { idle: [[0, 0, 200], [1, 0, 100]], fly: [] } });
    assert.deepEqual(missing, ['fly']);
});

test('mascot: groesser rendern und ohne Skalieren auf die Zelle zuschneiden', () => {
    // Pixor rendert 6x6, die Zelle ist 4x4: Der Vogel (Spalten 1-4, Fuesse in Zeile 4) wird ausgeschnitten, nicht verkleinert.
    const pixor = blank(6, 6);
    fill(pixor, 1, 2, 4, 3, [9, 9, 9, 255]);
    const json = { frames: [{ frame: { x: 0, y: 0, w: 6, h: 6 }, pixor: { action: 'idle', index: 0 } }] };
    const { sheet, clipped } = buildSheet(pixor, json, { cell: 4, render: 6, fps: 10, clips: ['idle'] });
    assert.deepEqual([sheet.width, sheet.height], [4, 4]);
    assert.equal(clipped, 0);
    for (const [x, y] of [[0, 1], [3, 1], [0, 3], [3, 3]]) assert.deepEqual(px(sheet, x, y), [9, 9, 9, 255]);
    assert.deepEqual(px(sheet, 0, 0), [0, 0, 0, 0]);
});

test('mascot: haengt ein Clip tiefer als die Fuesse, rueckt alles hoch und feet sagt, wie weit', () => {
    // idle: Fuesse in Zeile 2; fly haengt bis Zeile 3. Die Zelle muss Zeile 3 noch zeigen, die Fuesse stehen 1 px hoch.
    const pixor = blank(8, 4);
    fill(pixor, 1, 1, 2, 2, [9, 9, 9, 255]);
    fill(pixor, 5, 2, 2, 2, [7, 7, 7, 255]);
    const json = { frames: [['idle', 0], ['fly', 4]].map(([action, x]) => ({ frame: { x, y: 0, w: 4, h: 4 }, pixor: { action, index: 0 } })) };
    const { sheet, table, clipped } = buildSheet(pixor, json, { cell: 4, fps: 10, clips: ['idle', 'fly'] });
    assert.equal(clipped, 0);
    assert.equal(table.feet, 1);
    assert.deepEqual(px(sheet, 1, 7), [7, 7, 7, 255]);
    assert.deepEqual(px(sheet, 1, 2), [9, 9, 9, 255]);
});

test('mascot: ein freier Clip bekommt seinen eigenen Zuschnitt und shift', () => {
    // idle 2x2 unten links im Frame; fly 2x2 oben rechts, frei: Es wird fuer sich zentriert, shift fuehrt es zurueck.
    const pixor = blank(12, 6);
    fill(pixor, 0, 4, 2, 2, [9, 9, 9, 255]);
    fill(pixor, 10, 0, 2, 2, [7, 7, 7, 255]);
    const json = { frames: [['idle', 0], ['fly', 6]].map(([action, x]) => ({ frame: { x, y: 0, w: 6, h: 6 }, pixor: { action, index: 0 } })) };
    const { sheet, table, clipped } = buildSheet(pixor, json, { cell: 4, render: 6, fps: 10, clips: ['idle', 'fly'], free: ['fly'] });
    assert.equal(clipped, 0);
    assert.deepEqual(px(sheet, 1, 3), [9, 9, 9, 255]);  // idle: waagrecht mitten, unten
    assert.deepEqual(px(sheet, 1, 4), [7, 7, 7, 255]);  // fly: waagrecht mitten, senkrecht nur so weit hoch wie noetig
    // Gemeinsam zugeschnitten stuende das Pixel bei (5,-2) statt (1,0): shift = eigen - gemeinsam, die Werkbank schiebt um -shift.
    assert.deepEqual(table.shift, { fly: [-4, 2] });
});

test('mascot: ein freier Clip, der senkrecht passt, bleibt auf dem Boden', () => {
    // idle und wave stehen beide unten; wave ragt nur seitlich weiter: Es wird waagrecht fuer sich zentriert, nicht gehoben.
    const pixor = blank(12, 6);
    fill(pixor, 0, 3, 2, 3, [9, 9, 9, 255]);
    fill(pixor, 8, 3, 4, 3, [7, 7, 7, 255]);
    const json = { frames: [['idle', 0], ['wave', 6]].map(([action, x]) => ({ frame: { x, y: 0, w: 6, h: 6 }, pixor: { action, index: 0 } })) };
    const { sheet, table } = buildSheet(pixor, json, { cell: 4, render: 6, fps: 10, clips: ['idle', 'wave'], free: ['wave'] });
    assert.equal(table.shift.wave[1], 0);
    assert.deepEqual(px(sheet, 0, 7), [7, 7, 7, 255]);
    assert.deepEqual(px(sheet, 3, 7), [7, 7, 7, 255]);
});

test('mascot: Fuesse stehen in sitzenden Clips fest, Koerperzeilen bleiben', () => {
    const body = [20, 20, 28, 255], toe = [44, 44, 52, 255], ink = [8, 8, 12, 255];
    // Drei Frames zu 6x4: Zeile 0 Koerper (wandert), Zeile 2 Zehen (in Frame 1 um 1 px versetzt), Zeile 3 Umriss darunter.
    const image = blank(18, 4);
    for (const [f, dx] of [[0, 0], [1, 1], [2, 0]]) {
        paint(image, f * 6 + 1 + f, 0, body);
        paint(image, f * 6 + 2 + dx, 2, toe);
        paint(image, f * 6 + 2 + dx, 3, ink);
    }
    const rects = [0, 6, 12].map((x) => ({ x, y: 0, w: 6, h: 4 }));
    const changed = plantFeet(image, [rects], { colors: ['#2c2c34'], outline: '#08080c' });
    assert.equal(changed, 4);
    assert.deepEqual([px(image, 8, 2), px(image, 9, 2), px(image, 8, 3)], [toe, [0, 0, 0, 0], ink]);
    assert.deepEqual(px(image, 8, 0), body);  // der Koerper bewegt sich weiter
});


test('mascot: zu gross wird gemeldet', () => {
    const pixor = blank(6, 6);
    fill(pixor, 0, 2, 6, 2, [9, 9, 9, 255]);
    const json = { frames: [{ frame: { x: 0, y: 0, w: 6, h: 6 }, pixor: { action: 'idle', index: 0 } }] };
    const { clipped, extent } = buildSheet(pixor, json, { cell: 4, render: 6, fps: 10, clips: ['idle'] });
    assert.deepEqual([clipped, extent], [2, 6]);
});

test('mascot: Bereinigung nach Pixel-Art-Regeln', () => {
    const body = [58, 62, 96, 255], spot = [104, 110, 160, 255];
    const image = blank(8, 8);
    fill(image, 2, 2, 4, 4, body);
    paint(image, 3, 3, spot);                 // Farbinsel aus einem Pixel
    paint(image, 0, 7, body);                 // verwaistes Pixel
    paint(image, 3, 1, [58, 62, 96, 90]);     // halbtransparent
    const { image: clean, stats } = cleanFrames(image, { cell: 8, eyeDark: '#14090c', eyeShine: '#e8e9f7' });
    assert.deepEqual(px(clean, 3, 3), body);
    assert.deepEqual(px(clean, 0, 7), [0, 0, 0, 0]);
    assert.deepEqual(px(clean, 3, 1), [0, 0, 0, 0]);
    assert.deepEqual([stats.islands, stats.orphans, stats.alpha], [1, 1, 1]);
});

test('mascot: Augen als fester Stempel, geschlossen als Strich', () => {
    const head = [58, 62, 96, 255], dark = [20, 9, 12, 255], shine = [232, 233, 247, 255], line = [8, 8, 12, 255];
    const options = { eyeDark: '#14090c', eyeShine: '#e8e9f7', lid: '#08080c', halo: ['#3a3e60'] };
    // Zwei Frames zu 8x8: im ersten ein schiefes 3er-Auge mit zwei Glanzpunkten und dunkler Linie daneben, im zweiten keins.
    const image = blank(16, 8);
    fill(image, 0, 0, 16, 8, head);
    paint(image, 3, 3, shine); paint(image, 4, 3, dark); paint(image, 4, 4, shine);
    paint(image, 2, 3, line);
    const probe = blank(16, 8);
    fill(probe, 11, 3, 2, 2, dark);
    const rects = [0, 8].map((x) => ({ x, y: 0, w: 8, h: 8 }));
    const stats = stampEyes(image, [{ rects, loop: false }], { ...options, probe });
    assert.deepEqual(stats, { eyes: 1, lids: 1 });
    assert.deepEqual([px(image, 3, 3), px(image, 4, 3), px(image, 3, 4), px(image, 4, 4)], [shine, dark, dark, dark]);
    assert.deepEqual(px(image, 2, 3), head);  // die dunkle Linie am Auge wird Kopffarbe
    assert.deepEqual([px(image, 11, 4), px(image, 12, 4), px(image, 11, 3)], [line, line, head]);
});

test('mascot: kein Boiling, ein Fleck fuer einen Frame nimmt den Wert davor und danach an', () => {
    const a = [10, 10, 10, 255], b = [200, 200, 200, 255];
    const image = blank(12, 4);
    fill(image, 0, 0, 12, 4, a);
    paint(image, 5, 1, b);                    // Frame 1: ein Pixel blitzt auf
    fill(image, 8, 0, 4, 4, b);               // Frame 2: echte Aenderung der ganzen Flaeche, bleibt
    const rects = [0, 4, 8].map((x) => ({ x, y: 0, w: 4, h: 4 }));
    assert.equal(steadyFrames(image, rects, { blob: 2 }), 0); // Frame 1 hat davor a, danach b: kein Blitzer
    paint(image, 9, 1, a);
    fill(image, 8, 0, 4, 4, a);
    assert.equal(steadyFrames(image, rects, { blob: 2 }), 1);
    assert.deepEqual(px(image, 5, 1), a);
});

test('mascot: eigener Umriss, Schnabel mit eigener Farbe, Zehenluecken geschlossen', () => {
    const body = [20, 20, 28, 255], beak = [232, 192, 80, 255], toe = [44, 44, 52, 255];
    const ink = [8, 8, 12, 255], brown = [106, 66, 16, 255];
    const image = blank(8, 8);
    fill(image, 3, 2, 2, 2, body);
    paint(image, 2, 2, beak);
    paint(image, 3, 5, toe); paint(image, 5, 5, toe);  // zwei Zehen mit 1-px-Luecke
    const drawn = outlineFrames(image, 8, { color: '#08080c', by: { '#e8c050': '#6a4210' }, bridge: ['#2c2c34'] });
    assert.ok(drawn > 0);
    assert.deepEqual(px(image, 1, 2), brown);  // links vom Schnabel
    assert.deepEqual(px(image, 5, 2), ink);    // rechts vom Koerper
    assert.deepEqual(px(image, 4, 5), toe);    // Luecke gefuellt statt Kamm
    assert.deepEqual(px(image, 0, 0), [0, 0, 0, 0]);
});

test('mascot: der Schnabel ist in ruhigen Clips ein starres Stueck, gemessen vom Auge', () => {
    const head = [38, 42, 64, 255], beak = [232, 192, 80, 255], shine = [232, 233, 247, 255], dark = [20, 20, 28, 255];
    // Drei Frames zu 8x6; im dritten sitzt der Kopf 1 px tiefer. Frame 1 rastert die Schnabelspitze anders (dunkles Pixel).
    const image = blank(24, 6);
    for (const [f, dy] of [[0, 0], [1, 0], [2, 1]]) {
        fill(image, f * 8 + 2, 1 + dy, 5, 3, head);
        paint(image, f * 8 + 4, 1 + dy, shine);
        paint(image, f * 8 + 1, 2 + dy, beak); paint(image, f * 8 + 2, 2 + dy, beak);
    }
    paint(image, 9, 2, dark);
    const rects = [0, 8, 16].map((x) => ({ x, y: 0, w: 8, h: 6 }));
    assert.equal(steadyBeak(image, [rects], { colors: ['#e8c050'], eyeShine: '#e8e9f7' }), 1);
    assert.deepEqual(px(image, 9, 2), beak);
    assert.deepEqual([px(image, 17, 3), px(image, 18, 3)], [beak, beak]);  // im tieferen Frame mitgewandert
});

test('mascot: Clips in twos laufen auf Zweien, jede Zeichnung steht zwei Frames', () => {
    // Vier verschiedene Frames zu 2x2: auf Zweien bleiben Frame 0 und 2, je doppelt so lang.
    const pixor = blank(8, 2);
    for (let f = 0; f < 4; f++) paint(pixor, f * 2, 1, [10 + f, 0, 0, 255]);
    const json = { frames: [0, 1, 2, 3].map((index) => ({ frame: { x: index * 2, y: 0, w: 2, h: 2 }, pixor: { action: 'idle', index } })) };
    const { sheet, table } = buildSheet(pixor, json, { cell: 2, fps: 10, clips: ['idle'], twos: ['idle'] });
    assert.deepEqual(table.clips.idle, [[0, 0, 200], [1, 0, 200]]);
    assert.deepEqual([px(sheet, 0, 1)[0], px(sheet, 2, 1)[0]], [10, 12]);
});

test('mascot: wippen um genau ein Pixel, die Beine strecken sich', () => {
    const body = [20, 20, 28, 255], leg = [44, 44, 52, 255];
    // 3x6: Koerper Zeilen 1-2, Gelenk Zeile 3, Bein Zeile 4, Zeile 5 leer.
    const image = blank(3, 6);
    fill(image, 0, 1, 3, 2, body); fill(image, 0, 3, 3, 1, leg); paint(image, 1, 4, leg);
    const r = { x: 0, y: 0, w: 3, h: 6 };
    assert.equal(bobFrames(image, [{ rect: r, up: true, rest: null }], { colors: ['#2c2c34'] }), 1);
    assert.deepEqual([px(image, 1, 0), px(image, 1, 2), px(image, 0, 2), px(image, 1, 3), px(image, 1, 4)], [body, leg, leg, leg, leg]);
    assert.deepEqual(px(image, 0, 3), [0, 0, 0, 0]);
});

test('mascot: offener Schnabel als Stempel neben dem Auge', () => {
    const head = [38, 42, 64, 255], up = [232, 192, 80, 255], low = [192, 138, 40, 255], shine = [232, 233, 247, 255];
    const image = blank(8, 6);
    fill(image, 4, 0, 4, 6, head);
    paint(image, 6, 2, shine);
    paint(image, 3, 2, up); paint(image, 3, 3, low);  // gerenderter Klumpen
    const opts = { upper: '#e8c050', lower: '#c08a28', mouth: '#782834', head: '#262a40', eyeShine: '#e8e9f7', pattern: ['YYhW', 'mmh ', 'yyh '] };
    assert.equal(openBeak(image, [{ x: 0, y: 0, w: 8, h: 6 }], opts), 1);
    assert.deepEqual([px(image, 3, 2), px(image, 3, 3), px(image, 3, 4), px(image, 5, 3)], [up, [120, 40, 52, 255], low, [38, 42, 64, 255]]);
});
