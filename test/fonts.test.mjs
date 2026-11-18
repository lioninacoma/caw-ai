// Built-in fonts: Geist and Geist Mono, variable, with their licence; nothing else in assets/fonts.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const FONTS = new URL('../assets/fonts/', import.meta.url);

test('fonts: Geist and Geist Mono as woff2 with the OFL, and nothing else', () => {
    assert.deepEqual(readdirSync(FONTS).sort(), ['OFL-geist.txt', 'geist-mono.woff2', 'geist.woff2']);
    for (const file of ['geist.woff2', 'geist-mono.woff2']) assert.equal(readFileSync(new URL(file, FONTS)).subarray(0, 4).toString('latin1'), 'wOF2', file);
    assert.match(readFileSync(new URL('OFL-geist.txt', FONTS), 'utf8'), /SIL Open Font License, Version 1\.1/);
});
