import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EXIT } from '../src/shared/errors.mjs';
import { readPrefs } from '../src/shared/prefs.mjs';
import { createUi } from '../src/shared/ui.mjs';
import { themeCommand } from '../src/host/theme-command.mjs';

const setup = (t) => {
    const home = mkdtempSync(join(tmpdir(), 'caw-theme-'));
    const root = mkdtempSync(join(tmpdir(), 'caw-theme-root-'));
    t.after(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    });
    const lines = [];
    const ui = createUi({ fancy: false, out: (text) => lines.push(text), err: (text) => lines.push(text) });
    return { home, root, lines, run: (args) => themeCommand(root, args, { ui, env: { CAW_AI_HOME: home } }) };
};

test('theme: listet eingebaute und eigene, markiert das aktive, use waehlt', (t) => {
    const { home, lines, run } = setup(t);
    mkdirSync(join(home, 'themes', 'hafen'), { recursive: true });
    writeFileSync(join(home, 'themes', 'hafen', 'theme.json'), JSON.stringify({ themeApi: 1, name: 'hafen', base: 'nacht', colors: { frame: '#3f8f8a' } }));
    assert.equal(run([]), EXIT.pass);
    assert.match(lines.join('\n'), /nacht +Nacht \(aktiv\)/);
    assert.match(lines.join('\n'), /hafen +hafen · eigenes, auf nacht/);
    assert.equal(run(['use', 'hafen']), EXIT.pass);
    assert.equal(readPrefs({ CAW_AI_HOME: home }).theme, 'hafen');
    assert.throws(() => run(['use', 'gibtsnicht']), /gibt es nicht\. Vorhanden: nacht, bernstein, phosphor, hafen/);
    assert.throws(() => run(['weg']), /Aufruf: caw-ai theme/);
});

test('theme check: Schema, Kontrast, Markenbreite, Schriften', (t) => {
    const { home, lines, run } = setup(t);
    assert.equal(run(['check', 'nacht']), EXIT.pass);
    assert.match(lines.join('\n'), /Schema passt[\s\S]*in Ordnung/);
    mkdirSync(join(home, 'themes', 'grau'), { recursive: true });
    writeFileSync(join(home, 'themes', 'grau', 'theme.json'), JSON.stringify({
        themeApi: 1, name: 'grau', base: 'nacht', colors: { text: '#333333' }, marks: { ok: '[OK]' },
        fonts: { display: { family: 'Pixel', file: 'fonts/pixel.woff2' } },
    }));
    lines.length = 0;
    assert.equal(run(['check', 'grau']), EXIT.error, 'fehlende Schrift');
    const text = lines.join('\n');
    assert.match(text, /unterschiedlich breit/);
    assert.match(text, /Kontrast text\/screen nur/);
    assert.match(text, /Schrift fehlt: fonts\/pixel\.woff2/);
});
