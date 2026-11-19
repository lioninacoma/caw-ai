// UI consistency: the chat's buttons come from the base components, no bracketed labels.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');

test('chat: buttons come in two sizes from the base, actions .btn 36 px and tools .btn-sm 28 px', () => {
    const base = read('src/host/style.mjs');
    assert.match(base, /\.btn\{[^}]*height:36px/);
    assert.match(base, /\.btn-sm\{height:28px/);
    const chat = read('src/host/chat.mjs');
    const sizes = new Set([...chat.matchAll(/\bbtn(?:-sm)?\b/g)].map(([name]) => name));
    assert.deepEqual([...sizes].sort(), ['btn', 'btn-sm']);
    // Own rules for buttons (not their icons or spinners) only ever set the two sizes, and no third size for a main button.
    const css = chat.slice(chat.indexOf('<style>'), chat.indexOf('</style>'));
    const rules = css.split('}').map((rule) => rule.split('{')).filter(([selector, body]) => body !== undefined && /button|\.btn|#send/.test(selector) && !/::|\s\.i\b|\.i\{/.test(selector));
    const heights = new Set(rules.flatMap(([, body]) => [...body.matchAll(/(?:^|;)(?:min-)?height:(\d+)px/g)].map(([, px]) => Number(px))));
    assert.deepEqual([...heights].sort(), [28, 36]);
    assert.ok(!/button\.big\{/.test(chat), 'no third size for a main button');
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
