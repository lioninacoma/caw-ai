// Built-in fonts: IBM's own Plex files under lower-case names.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_THEMES, loadTheme, missingFonts } from '../src/shared/theme-package.mjs';

test('fonts: the built-in themes find all their font files', () => {
    for (const name of BUILTIN_THEMES) assert.deepEqual(missingFonts(loadTheme(name)), [], name);
});
