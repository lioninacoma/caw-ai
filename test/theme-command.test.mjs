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

test('theme: lists built-in and own themes, marks the active one, use selects', (t) => {
    const { home, lines, run } = setup(t);
    mkdirSync(join(home, 'themes', 'hafen'), { recursive: true });
    writeFileSync(join(home, 'themes', 'hafen', 'theme.json'), JSON.stringify({ themeApi: 1, name: 'hafen', base: 'terminal', colors: { frame: '#3f8f8a' } }));
    assert.equal(run([]), EXIT.pass);
    assert.match(lines.join('\n'), /Themes \(Modus dunkel\)/);
    assert.match(lines.join('\n'), /studio +Studio \(aktiv\)/);
    assert.match(lines.join('\n'), /hafen +hafen · eigenes, auf terminal/);
    assert.equal(run(['use', 'hafen']), EXIT.pass);
    assert.equal(readPrefs({ CAW_AI_HOME: home }).theme, 'hafen');
    assert.throws(() => run(['use', 'nonexistent']), /gibt es nicht\. Vorhanden: studio, terminal, raster, glas, hafen/);
    assert.throws(() => run(['bogus']), /Aufruf: caw theme/);
    assert.equal(run(['mode', 'light']), EXIT.pass);
    assert.equal(readPrefs({ CAW_AI_HOME: home }).mode, 'light');
    assert.match(lines.join('\n'), /Modus hell gewählt/);
    assert.throws(() => run(['mode', 'grau']), /Aufruf: caw theme/);
});

test('theme check: schema, contrast, mark width, fonts', (t) => {
    const { home, lines, run } = setup(t);
    assert.equal(run(['check', 'terminal']), EXIT.pass);
    assert.match(lines.join('\n'), /Schema passt[\s\S]*in Ordnung/);
    mkdirSync(join(home, 'themes', 'grau'), { recursive: true });
    writeFileSync(join(home, 'themes', 'grau', 'theme.json'), JSON.stringify({
        themeApi: 1, name: 'grau', base: 'terminal', colors: { text: '#333333' }, marks: { ok: '[OK]' },
        fonts: { display: { family: 'Pixel', file: 'fonts/pixel.woff2' } },
    }));
    lines.length = 0;
    assert.equal(run(['check', 'grau']), EXIT.error, 'missing font');
    const text = lines.join('\n');
    assert.match(text, /unterschiedlich breit/);
    assert.match(text, /Kontrast text\/screen \(dunkel\) nur/);
    assert.doesNotMatch(text, /\(hell\)/, 'the light colours of terminal replace the dark text');
    assert.match(text, /Schrift fehlt: fonts\/pixel\.woff2/);
});
