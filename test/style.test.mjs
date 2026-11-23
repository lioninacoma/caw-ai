// The Graphite look (src/host/style.mjs): tokens in both modes, the mode attribute and script, fonts inline, no foreign host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';

import {
    BASE_CSS, FAVICON, ICON_NAMES, MODES, MODE_FUNCTION, MODE_SCRIPT, TOKENS, fontFaces, icon, logo, modeAttr, modeOf, styleSheet, tokenCss,
} from '../src/host/style.mjs';

test('style: both modes define every token, and only those', () => {
    const light = Object.keys(TOKENS.light).sort();
    assert.deepEqual(Object.keys(TOKENS.dark).sort(), light);
    const css = tokenCss();
    const [root, dark] = css.split('\n');
    assert.match(root, /^:root\{color-scheme:light;/);
    assert.match(dark, /^:root\[data-mode=dark\]\{color-scheme:dark;/);
    for (const name of light) {
        assert.ok(root.includes(`--${name}:${TOKENS.light[name]}`), `light ${name}`);
        assert.ok(dark.includes(`--${name}:${TOKENS.dark[name]}`), `dark ${name}`);
    }
    for (const name of ['font', 'font-mono', 'fs', 'r1', 'r2', 'r3', 'rp']) assert.match(root, new RegExp(`--${name}:`));
    assert.match(tokenCss({ root: ':host', dark: ':host([data-mode=dark])' }), /^:host\{[\s\S]*\n:host\(\[data-mode=dark\]\)\{/);
});

test('style: every var() in the base components is a token', () => {
    const known = new Set([...Object.keys(TOKENS.light), 'font', 'font-mono', 'fs', 'r1', 'r2', 'r3', 'rp', 'row', 'logo-eye', 'nav']);
    for (const [, name] of `${BASE_CSS}${logo()}`.matchAll(/var\(--([a-z0-9-]+)/g)) assert.ok(known.has(name), name);
});

test('style: the mode pref becomes data-pref, a fixed one also data-mode', () => {
    assert.deepEqual(MODES, ['system', 'light', 'dark']);
    assert.equal(modeOf('dark'), 'dark');
    assert.equal(modeOf(undefined), 'system');
    assert.equal(modeOf('studio'), 'system');
    assert.equal(modeAttr('dark'), ' data-pref="dark" data-mode="dark"');
    assert.equal(modeAttr('light'), ' data-pref="light" data-mode="light"');
    assert.equal(modeAttr(), ' data-pref="system" data-mode="light"');
    assert.equal(modeAttr('"><script>'), ' data-pref="system" data-mode="light"');
});

test('style: the mode script follows the system for system, keeps a fixed pref and reacts to a new pref', () => {
    assert.doesNotThrow(() => new Script(MODE_SCRIPT));
    assert.ok(MODE_SCRIPT.startsWith(MODE_FUNCTION));
    let changed = null;
    let observed = null;
    const media = { matches: true, addEventListener: (type, listener) => { changed = listener; } };
    const root = { dataset: { pref: 'system' } };
    const context = {
        matchMedia: (query) => (query === '(prefers-color-scheme: dark)' ? media : null),
        MutationObserver: class { constructor(listener) { observed = listener; } observe() {} },
    };
    new Script(`${MODE_FUNCTION}\ncawMode(root);`).runInNewContext({ ...context, root });
    assert.equal(root.dataset.mode, 'dark');
    media.matches = false;
    changed();
    assert.equal(root.dataset.mode, 'light');
    root.dataset.pref = 'dark';
    observed();
    assert.equal(root.dataset.mode, 'dark');
    media.matches = false;
    changed();
    assert.equal(root.dataset.mode, 'dark', 'a fixed pref ignores the system');
});

test('style: Geist and Geist Mono inline, variable weights, no foreign host anywhere', () => {
    const faces = fontFaces();
    for (const family of ['Geist', 'Geist Mono']) {
        assert.match(faces, new RegExp(`@font-face\\{font-family:"${family}";src:url\\(data:font/woff2;base64,[A-Za-z0-9+/=]{1000,}\\) format\\("woff2"\\);font-weight:100 900;`));
    }
    const all = `${styleSheet()}${FAVICON}${logo({ label: 'caw' })}${ICON_NAMES.map((name) => icon(name)).join('')}`;
    // Data URLs only: no url() other than data:, no foreign host, no @import.
    assert.doesNotMatch(all.replace(/base64,[A-Za-z0-9+/=]+/g, '').replaceAll('http://www.w3.org/2000/svg', ''), /https?:|@import|url\((?!data:)/i);
    assert.ok(styleSheet().startsWith(faces));
});

test('style: logo, favicon and icons', () => {
    assert.match(logo({ size: 30 }), /^<svg class="logo" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">/);
    assert.match(logo({ label: 'a"<b' }), /role="img" aria-label="a&quot;&lt;b"/);
    assert.match(logo(), /fill="currentColor"/);
    assert.match(FAVICON, /^<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,%3Csvg/);
    assert.match(decodeURIComponent(FAVICON), /prefers-color-scheme:dark/);
    assert.match(icon('check'), /^<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"\/><\/svg>$/);
    assert.match(icon('more'), /class="i fillc"/);
    assert.match(icon('loader', { cls: 'spin' }), /class="i spin"/);
    assert.equal(icon('nope'), '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"></svg>');
});

test('style: the base components and the motion rules', () => {
    for (const selector of ['.btn{', '.btn-p{', '.btn-s{', '.btn-sm{', '.lnk{', '.ib{', '.bdg{', 'kbd{', '.pill{', '.pill .dot',
        '.card{', '.pop{', '.pop-i{', '.pop-h{', '.pop-sep{', '.field{', '.seg{', '.switch{', '.banner{', '.dl{', '.spinner{', '.spin{']) {
        assert.ok(BASE_CSS.includes(selector), selector);
    }
    assert.match(BASE_CSS, /\.btn\{[^}]*height:36px/);
    assert.match(BASE_CSS, /\.btn-sm\{[^}]*height:28px/);
    assert.match(BASE_CSS, /\.btn-p\{background:var\(--prim\);color:var\(--on-prim\)\}/);
    assert.match(BASE_CSS, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important/);
    assert.match(BASE_CSS, /\.still \*,[^{]*\{animation:none!important/);
});
