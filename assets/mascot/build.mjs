// Baut das Spritesheet des Maskottchens: .blend -> (Blender, headless) GLB -> (Pixor) Pixel-Frames -> Sheet der Werkbank.
//
//   npm run mascot                Vorschau nach assets/mascot/out/ (final.png, final-x6.png, gif/<clip>.gif)
//   npm run mascot -- --watch     dasselbe bei jedem Speichern der .blend, von fixes.aseprite, mascot.json oder animate.py
//   npm run mascot -- --install   zusaetzlich nach assets/raven-sheet.png und assets/favicon-32.png (ersetzt den urspruenglichen Raben), nur wenn alle Zellen da sind und die Credits stimmen
//   npm run mascot -- --import X  ein von Hand bereinigtes final.png (X) als Korrekturen nach fixes.aseprite uebernehmen
//   npm run mascot -- --look P    Licht, Lichttoene und Kamerawinkel aus einem Pixor-Projekt (P, siehe out/mascot.pixor) uebernehmen
//
// Handkorrekturen liegen in fixes.aseprite (Ebenen render, erase, fix; siehe fixes.lua) und werden bei jedem Build auf
// das gerenderte Sheet gelegt.
//
// Braucht Blender (BLENDER=Pfad, sonst die neueste Installation unter Program Files bzw. `blender`), Pixor
// (PXR=Pfad, sonst `pxr` im PATH) und fuer die Korrekturen Aseprite (ASEPRITE=Pfad, sonst Program Files bzw. `aseprite`).
// Pixor darf laut Lizenz nicht ins Repo und nicht in CI: Die PNGs werden committet.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watchFile, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { blank, decodePng, encodePng, upscale } from './png.mjs';
import { bobFrames, cleanFrames, openBeak, recolor, countColors, outlineFrames, plantFeet, stampEyes, steadyBeak, steadyFrames } from './clean.mjs';
import { buildSheet, pixorClips, ravenClipsModule } from './sheet.mjs';

const here = import.meta.dirname;
const root = join(here, '..', '..');
const argv = process.argv.slice(2);
const args = new Set(argv);
// --size N: eine Variante mit N px grossen Zellen zum Ausprobieren, nach out/size-N/; mascot.json bleibt, wie es ist.
const sizeArg = args.has('--size') ? Number(argv[argv.indexOf('--size') + 1]) : null;
if (sizeArg !== null && !(Number.isInteger(sizeArg) && sizeArg >= 8)) throw new Error('--size braucht eine ganze Zahl ab 8');
const out = sizeArg ? join(here, 'out', `size-${sizeArg}`) : join(here, 'out');
// --import PNG: ein von Hand bereinigtes fertiges Sheet in fixes.aseprite uebernehmen (siehe fixes.lua).
const importPath = args.has('--import') ? resolve(argv[argv.indexOf('--import') + 1] ?? '') : null;
// --look PROJEKT.pixor: Licht, Lichttoene und Kamerawinkel aus einem in der Pixor-App gespeicherten Projekt uebernehmen.
const lookPath = args.has('--look') ? resolve(argv[argv.indexOf('--look') + 1] ?? '') : null;

// Schreibt die Werte aus dem Projekt in die Pixor-Argumente von mascot.json (Text ersetzen, damit die Formatierung bleibt).
const takeLook = (file) => {
    const project = JSON.parse(readFileSync(file, 'utf8'));
    const style = project.styles?.[0]?.overrides ?? {}, camera = project.cameras?.[0] ?? {};
    const values = {
        '--light': style.light && `${Math.round(style.light.azimuth)},${Math.round(style.light.elevation)}`,
        '--bands': style.bands != null && String(style.bands),
        '--pitch': camera.pitch != null && String(Math.round(camera.pitch)),
    };
    const path = join(here, 'mascot.json');
    let text = readFileSync(path, 'utf8');
    const taken = [];
    for (const [flag, value] of Object.entries(values)) {
        if (!value) continue;
        const pattern = new RegExp(`("${flag}",\\s*")[^"]*(")`);
        if (!pattern.test(text)) continue;
        text = text.replace(pattern, `$1${value}$2`);
        taken.push(`${flag} ${value}`);
    }
    writeFileSync(path, text);
    console.log(`Aus ${basename(file)} uebernommen: ${taken.join(', ') || 'nichts'}`);
};

const findBlender = () => {
    if (process.env.BLENDER) return process.env.BLENDER;
    const base = 'C:\\Program Files\\Blender Foundation';
    if (process.platform === 'win32' && existsSync(base)) {
        const versions = readdirSync(base).filter((name) => existsSync(join(base, name, 'blender.exe')))
            .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
        if (versions.length > 0) return join(base, versions[0], 'blender.exe');
    }
    return 'blender';
};

const findAseprite = () => {
    if (process.env.ASEPRITE) return process.env.ASEPRITE;
    const candidates = ['C:\\Program Files\\Aseprite\\Aseprite.exe', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Aseprite\\Aseprite.exe',
        '/Applications/Aseprite.app/Contents/MacOS/aseprite'];
    return candidates.find((path) => existsSync(path)) ?? 'aseprite';
};

// MASCOT_BLEND probiert eine andere .blend aus, ohne mascot.json zu aendern.
const blendPath = (spec) => resolve(here, process.env.MASCOT_BLEND || spec.blend);
const fixesPath = sizeArg ? join(out, 'fixes.aseprite') : join(here, 'fixes.aseprite');
const ENV = { Pixor: 'PXR', Blender: 'BLENDER', Aseprite: 'ASEPRITE' };

const run = (command, argv, what, env = {}) => {
    const result = spawnSync(command, argv, { cwd: here, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
    if (result.error?.code === 'ENOENT') throw new Error(`${what} nicht gefunden (${command}). ${ENV[what]}=Pfad setzen oder in den PATH legen.`);
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) throw new Error(`${what} ist gescheitert (Exit ${result.status}):\n${text.trim()}`);
    return text;
};

// Skaliert alles, was an der Zellgroesse haengt: Render-Groesse, Augenstempel, Lichtpunkt und die Filtergrenzen
// (Flaechen mit dem Quadrat).
const resize = (spec, size) => {
    if (!size || size === spec.cell) return spec;
    const k = size / spec.cell, clean = { ...spec.clean };
    const at = (v, f = k, min = 1) => Math.max(min, Math.round(v * f));
    if (clean.eyeSize) clean.eyeSize = at(clean.eyeSize);
    if (clean.island) clean.island = at(clean.island, k * k);
    if (clean.blob) clean.blob = at(clean.blob, k * k, 2);
    if (clean.crown) clean.crown = { ...clean.crown, width: at(clean.crown.width ?? 2) };
    return { ...spec, cell: size, render: at(spec.render ?? spec.cell, k, size), clean };
};

const build = () => {
    if (lookPath) takeLook(lookPath);
    const spec = resize(JSON.parse(readFileSync(join(here, 'mascot.json'), 'utf8')), sizeArg);
    mkdirSync(out, { recursive: true });
    const glb = join(out, 'mascot.glb');

    const blender = (file, env) => run(findBlender(), ['-b', blendPath(spec), '--factory-startup', '--python-exit-code', '1',
        '--python', join(here, 'export.py'), '--', file], 'Blender', env);
    const exported = blender(glb);
    // Sonde: dasselbe mit offenem nahem Auge. Wo sie ein Auge hat und der Render keins, ist es zu (clean.mjs).
    const probeGlb = join(out, 'probe.glb');
    blender(probeGlb, { MASCOT_EYES: 'open' });
    const actions = JSON.parse(/export\.py: actions (.*)/.exec(exported)?.[1] ?? '[]');

    // Nur die Clips, die das Sheet braucht: Pixor passt alle gerenderten Clips gemeinsam in die Zelle ein.
    const wanted = new Set(spec.clips);
    const used = actions.map((a) => a.name).filter((name) => wanted.has(name));
    const clipArgs = used.length > 0 ? used.flatMap((name) => ['--clip', name]) : ['--clip', 'all'];

    const pixor = (file, png, exports, size, extra = []) => run(process.env.PXR || 'pxr', ['render', file, '--size', String(size), ...clipArgs,
        '--fps', String(spec.fps), ...spec.pixor, '--export', exports, '--anim-scale', '4', '-o', png, ...extra], 'Pixor');

    // Rendern und zuschneiden, so gross wie moeglich: `render` in mascot.json ist die Obergrenze. Ragt etwas ueber die Zelle,
    // schaetzt der Build die passende Groesse und tastet sich dann pixelweise an die groesste heran, bei der alles passt.
    let first = true;
    const attempt = (render) => {
        // out/mascot.pixor: dasselbe als Projekt fuer die Pixor-App, zum Anschauen und Ausprobieren (siehe --look).
        const rendered = pixor(glb, join(out, 'pixor.png'), 'png,json', render, ['--save-project', join(out, 'mascot.pixor')]);
        pixor(probeGlb, join(out, 'probe.png'), 'png', render);
        if (first) for (const line of rendered.split(/\r?\n/)) if (/^(sheet|warning)|flicker/.test(line.trim()) && !/triangles for/.test(line)) console.log(`  pxr: ${line.trim()}`);
        first = false;
        const pixorJson = JSON.parse(readFileSync(join(out, 'pixor.json'), 'utf8'));
        // Reihenfolge: aufraeumen, Zeitfilter, dann die Augen stempeln (clean.mjs).
        const { image: clipsImage, stats } = cleanFrames(decodePng(readFileSync(join(out, 'pixor.png'))), { cell: render, ...spec.clean });
        const clipRects = [...pixorClips(pixorJson)];
        const steadied = clipRects.reduce((sum, [name, rects]) =>
            sum + steadyFrames(clipsImage, rects, { loop: spec.loops.includes(name), blob: spec.clean.blob }), 0);
        Object.assign(stats, stampEyes(clipsImage, clipRects.map(([name, rects]) => ({ rects, loop: spec.loops.includes(name) })),
            { probe: decodePng(readFileSync(join(out, 'probe.png'))), ...spec.clean }));
        if (spec.beak) stats.beak = steadyBeak(clipsImage, clipRects.filter(([name]) => spec.beak.clips.includes(name)).map(([, rects]) => rects),
            { colors: spec.beak.colors, eyeShine: spec.clean.eyeShine });
        if (spec.mouth) stats.mouth = clipRects.filter(([name]) => spec.mouth.clips.includes(name))
            .reduce((sum, [, rects]) => sum + openBeak(clipsImage, rects, { ...spec.mouth, eyeShine: spec.clean.eyeShine }), 0);
        if (spec.recolor) for (const [name, map] of Object.entries(spec.recolor)) recolor(clipsImage, clipRects.find(([n]) => n === name)?.[1] ?? [], map);
        if (spec.outline) stats.outline = outlineFrames(clipsImage, render, spec.outline);
        if (spec.plant) stats.planted = plantFeet(clipsImage, clipRects.filter(([name]) => spec.plant.clips.includes(name)).map(([, rects]) => rects),
            { colors: spec.plant.colors, outline: spec.outline.color });
        // Wippen um ein Pixel (bob in mascot.json): je Clip die Frames [von, bis] der Quelle, in denen der Koerper oben ist
        // (bis < von laeuft ueber das Loop-Ende), und optional rest: der Frame, aus dem alle anderen entstehen.
        if (spec.bob) stats.bobbed = Object.entries(spec.bob).reduce((sum, [name, { up: [from, to], rest }]) => {
            const rects = clipRects.find(([n]) => n === name)?.[1] ?? [];
            const inside = (i) => (from <= to ? i >= from && i <= to : i >= from || i <= to);
            return sum + bobFrames(clipsImage, rects.map((rect, i) => ({ rect, up: inside(i), rest: rest === undefined ? null : rects[rest] })),
                { colors: spec.plant.colors });
        }, 0);
        return { render, pixorJson, clipsImage, stats, steadied, result: buildSheet(clipsImage, pixorJson, { ...spec, render }) };
    };
    const top = spec.render ?? spec.cell;
    let state = attempt(top), best = state.result.clipped === 0 ? state : null;
    if (!best) {
        let r = Math.max(Math.ceil(spec.cell / 2), Math.min(top - 1, Math.floor(top * spec.cell / state.result.extent)));
        for (;;) {
            state = attempt(r);
            if (state.result.clipped === 0) { best = state; if (r + 1 >= top) break; r += 1; }
            else if (best) break;
            else if (r <= spec.cell / 2) throw new Error(`Der Vogel passt nicht in ${spec.cell} px (${state.result.clipped} px zu gross)`);
            else r -= 1;
        }
        // Die Dateien in out/ stammen vom letzten Versuch; war der zu gross, den besten noch einmal rendern.
        if (state !== best) best = attempt(best.render);
    }
    const { render, pixorJson, clipsImage, stats, steadied, result } = best;
    writeFileSync(join(out, 'clips.png'), encodePng(clipsImage));
    const { sheet, table, missing } = result;
    console.log(`Gerendert mit ${render} px, zugeschnitten auf ${spec.cell} px; Fuesse ${table.feet} px ueber dem Zellboden.`);
    writeFileSync(join(out, 'sheet.png'), encodePng(sheet));
    writeFileSync(join(out, 'clips.json'), `${JSON.stringify(table)}\n`);
    const fixed = applyFixes(spec);
    makeGifs(spec, table);
    writeFileSync(join(out, 'final-x6.png'), encodePng(upscale(decodePng(readFileSync(join(out, 'final.png'))), 6)));

    const clips = [...new Set(pixorJson.frames.map((f) => f.pixor?.action).filter(Boolean))];
    console.log(`Actions in der .blend: ${actions.map((a) => `${a.name} (${a.start}-${a.end})`).join(', ') || 'keine'}`);
    console.log(`Clips bei Pixor: ${clips.join(', ') || 'keine'}`);
    console.log(`Bereinigt: ${stats.alpha} Alpha-Kanten, ${stats.orphans} verwaiste Pixel, ${stats.islands} Pixel in Farbinseln, `
        + `${stats.eyes} offene und ${stats.lids} geschlossene Augen gestempelt, ${steadied} Pixel, die nur einen Frame lang `
        + `aufblitzten, ${stats.planted ?? 0} Fuss- und ${stats.beak ?? 0} Schnabel-Pixel festgesetzt; ${countColors(clipsImage)} Farben`);
    console.log(`Sheet: ${table.width}x${table.height}, ${Object.entries(table.clips).map(([name, f]) => `${name} ${f.length}`).join(', ')}; `
        + `${fixed} -> ${join(out, 'final.png')}`);
    if (missing.length > 0) console.log(`Fehlt: ${missing.join(', ')}`);
    return { spec, table, missing };
};

// out/gif/<clip>.gif aus final.png, genau so, wie die Werkbank es abspielt (Tabelle aus buildSheet), 4-fach.
// Ohne Aseprite keine GIFs.
const makeGifs = (spec, table) => {
    const dir = join(out, 'gif');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const list = join(out, 'gif-frames.txt');
    const lines = Object.entries(table.clips).flatMap(([name, frames]) => frames.map(([c, r, ms]) => `${name} ${c} ${r} ${ms}`));
    writeFileSync(list, `${lines.join('\n')}\n`);
    try {
        run(findAseprite(), ['-b', '--script-param', `sheet=${join(out, 'final.png')}`, '--script-param', `list=${list}`, '--script-param', `dir=${dir}`,
            '--script-param', `cell=${spec.cell}`, '--script-param', 'scale=4', '--script', join(here, 'gifs.lua')], 'Aseprite');
    } catch (error) {
        if (!/nicht gefunden/.test(error.message)) throw error;
    }
};

// Legt fixes.aseprite auf out/sheet.png -> out/final.png. Ohne Aseprite und ohne fixes.aseprite ist final.png das Sheet.
let fixesWritten = 0;
const applyFixes = (spec) => {
    try {
        const text = run(findAseprite(), ['-b', '--script-param', `render=${join(out, 'sheet.png')}`, '--script-param', `file=${fixesPath}`,
            '--script-param', `out=${join(out, 'final.png')}`, '--script-param', `cell=${spec.cell}`,
            '--script-param', `import=${importPath ?? ''}`, '--script', join(here, 'fixes.lua')], 'Aseprite');
        if (importPath) console.log(`Uebernommen nach fixes.aseprite: ${importPath}`);
        fixesWritten = statSync(fixesPath).mtimeMs;
        return /fixes\.lua: (.*)/.exec(text)?.[1] ?? 'Korrekturen angewendet';
    } catch (error) {
        if (existsSync(fixesPath) || !/nicht gefunden/.test(error.message)) throw error;
        copyFileSync(join(out, 'sheet.png'), join(out, 'final.png'));
        return 'ohne Korrekturen (Aseprite fehlt)';
    }
};

// Das Favicon: die Logo-Kachel (FAVICON_TILE) mit dem ersten idle-Frame, doppelt so gross wie die Zelle (16 -> 32 px).
const FAVICON_TILE = [0x2f, 0x5f, 0x7c, 255];
const favicon = (sheet, table) => {
    const { cell } = table, [col, row] = table.clips.idle[0];
    const frame = blank(cell, cell);
    for (let y = 0; y < cell; y++) sheet.data.copy(frame.data, y * cell * 4, ((row * cell + y) * sheet.width + col * cell) * 4, ((row * cell + y) * sheet.width + (col + 1) * cell) * 4);
    const big = upscale(frame, 32 / cell), icon = blank(32, 32);
    for (let i = 0; i < icon.data.length; i += 4) icon.data.set(big.data[i + 3] ? big.data.subarray(i, i + 4) : FAVICON_TILE, i);
    return icon;
};

const install = ({ spec, table, missing }) => {
    const problems = [];
    if (missing.length > 0) problems.push(`Clips fehlen noch: ${missing.join(', ')}`);
    const { title, author, source, license } = spec.credits ?? {};
    if (![title, author, source, license].every(Boolean)) problems.push('credits in mascot.json unvollstaendig (title, author, source, license)');
    else if (!readFileSync(join(root, 'NOTICE.md'), 'utf8').includes(author)) {
        problems.push(`NOTICE.md nennt ${author} nicht. Vorschlag:\n  - **Raven:** \`assets/raven-sheet.png\` and \`assets/favicon-32.png\` are rendered from "${title}" by ${author} (${source}), ${license}, posed, animated and converted to pixel art for caw-ai.`);
    }
    if (problems.length > 0) throw new Error(`Nicht installiert:\n- ${problems.join('\n- ')}`);
    const sheet = readFileSync(join(out, 'final.png'));
    writeFileSync(join(root, 'assets', 'raven-sheet.png'), sheet);
    writeFileSync(join(root, 'assets', 'favicon-32.png'), encodePng(favicon(decodePng(sheet), table)));
    writeFileSync(join(root, 'src', 'host', 'raven-clips.mjs'), ravenClipsModule(table));
    console.log('Installiert: assets/raven-sheet.png, assets/favicon-32.png, src/host/raven-clips.mjs');
};

const once = () => {
    try {
        const result = build();
        if (args.has('--install')) install(result);
        return true;
    } catch (error) {
        console.error(error.message);
        return false;
    }
};

if (args.has('--watch')) {
    const blend = blendPath(JSON.parse(readFileSync(join(here, 'mascot.json'), 'utf8')));
    const watched = [blend, fixesPath, join(here, 'mascot.json'), join(here, 'animate.py'), join(here, 'export.py')];
    once();
    let busy = false;
    console.log(`Warte auf Aenderungen an ${watched.map((path) => basename(path)).join(', ')} (Strg+C beendet) ...`);
    for (const path of watched) {
        watchFile(path, { interval: 1000 }, (now, before) => {
            if (busy || now.mtimeMs === before.mtimeMs) return;
            // Der Build schreibt fixes.aseprite selbst (neue render-Ebene): das loest keinen neuen Build aus.
            if (path === fixesPath && now.mtimeMs === fixesWritten) return;
            busy = true;
            console.log(`\n${new Date().toLocaleTimeString()} ${basename(path)} geaendert, neu bauen ...`);
            once();
            busy = false;
        });
    }
} else if (!once()) process.exit(1);
