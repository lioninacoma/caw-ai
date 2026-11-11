// Built-in fonts: IBM's own Plex files under lower-case names, old Fontsource names still resolve for existing themes.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BUILTIN_THEMES, builtinFontUrl, loadTheme, missingFonts } from '../src/shared/theme-package.mjs';

test('fonts: the built-in themes find all their font files', () => {
    for (const name of BUILTIN_THEMES) assert.deepEqual(missingFonts(loadTheme(name)), [], name);
});

test('fonts: old Fontsource names of IBM Plex Mono resolve to the new files', () => {
    for (const [old, now] of [['ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-400.woff2'], ['ibm-plex-mono-latin-500-normal.woff2', 'ibm-plex-mono-500.woff2']]) {
        const url = builtinFontUrl(`builtin:${old}`);
        assert.ok(fileURLToPath(url).endsWith(now), old);
        assert.ok(existsSync(url), now);
    }
    assert.deepEqual(missingFonts({ name: 'own', fonts: { text: { file: 'builtin:ibm-plex-mono-latin-400-normal.woff2' } } }), []);
});
