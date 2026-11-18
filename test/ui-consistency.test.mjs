// UI consistency: two button sizes in the chat, every end-card button styled by every theme, no bracketed labels.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');

test('chat: buttons come in two sizes, actions 36 px and tools 28 px', () => {
    const css = read('src/host/chat.mjs');
    const heights = new Set([...css.matchAll(/(?:min-)?height:(\d+)px[^}]*font:400 (?:18|20)px/g)].map((match) => Number(match[1])));
    assert.deepEqual([...heights].sort(), [28, 36]);
    assert.ok(!/button\.big\{/.test(css), 'no third size for a main button');
});

test('themes: every end-card button is styled like the other actions', () => {
    for (const theme of readdirSync(join(repo, 'themes'), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        const css = read(`themes/${theme.name}/theme.css`);
        for (const match of css.matchAll(/#report,#closeWindow(,#learn)?/g)) assert.ok(match[1], `${theme.name}: #learn next to #report,#closeWindow`);
    }
});

test('labels: no bracketed button or tag texts', () => {
    for (const lang of ['de', 'en']) {
        for (const file of readdirSync(join(repo, 'src/shared/locales', lang))) {
            for (const [, key, text] of read(`src/shared/locales/${lang}/${file}`).matchAll(/'((?:chat|workbench)\.[^']+)': '(\[ [^']*\])'/g)) {
                assert.fail(`${lang}/${file} ${key}: ${text}`);
            }
        }
    }
    assert.ok(!/'\[ ' \+|\[ \$\{t\(/.test(read('src/host/workbench.mjs') + read('src/host/explore-card.mjs')), 'no "[ … ]" built around a label');
});
