// The look of caw-ai, shared by workbench, chat, report and explore map: a "console" style from the active theme package
// (src/shared/theme-package.mjs, themes/<name>/theme.json).
//
// - Colours: 13 base colours as CSS variables, everything else derived via color-mix. Set only as variables, never baked
//   into rules: custom themes can also come from the workbench.
// - Fonts: display (headings, legends, marks, F keys, logo) and text (body) from the package, inlined as data URLs:
//   the test browser blocks foreign hosts, and the chat has no origin of its own.
// - CRT only on case, background and headings; scanlines and vignette sit beneath the content. Body text and the
//   application under test stay sharp, the application without any filter.
// - The logo is the theme's ASCII raven everywhere. It blinks now and then; a click makes it squint and send up hearts.
// - The package's theme.css only comes from disk and is placed after the own rules.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HEX, THEME_KEYS, activeTheme, builtinFontUrl, themeDir } from '../shared/theme-package.mjs';

const dataUrl = (location, type) => {
    try {
        return `data:${type};base64,${readFileSync(location).toString('base64')}`;
    } catch {
        return null;
    }
};

const fontList = (entry) => (Array.isArray(entry) ? entry : entry === undefined ? [] : [entry]);
const FAMILY = /^[A-Za-z0-9 -]{1,48}$/;

/** The theme's fonts as @font-face; files from assets/fonts (builtin:) or from fonts/ in the package. */
export const fontFaces = (theme = activeTheme()) => [...fontList(theme.fonts?.display), ...fontList(theme.fonts?.text)].map((font) => {
    if (typeof font?.file !== 'string' || !FAMILY.test(font.family ?? '')) return '';
    const dir = themeDir(theme.name);
    const location = font.file.startsWith('builtin:') ? builtinFontUrl(font.file)
        : typeof dir === 'string' ? join(dir, font.file) : new URL(font.file, dir);
    const src = /^(builtin:[a-z0-9-]+\.woff2|fonts\/[A-Za-z0-9._-]+\.woff2)$/.test(font.file) ? dataUrl(location, 'font/woff2') : null;
    const weight = Number.isInteger(font.weight) ? font.weight : 400;
    return src === null ? '' : `@font-face{font-family:"${font.family}";src:url(${src}) format("woff2");font-weight:${weight};font-style:normal;font-display:block}`;
}).join('');

/** Old name: the active theme's fonts. */
export const FONT_FACES = fontFaces();

const family = (entry, fallback) => {
    const name = fontList(entry).find((font) => FAMILY.test(font?.family ?? ''))?.family;
    return name === undefined ? fallback : `"${name}",${fallback}`;
};
const num = (value, fallback, max) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : fallback);
const hex = (value, fallback) => (typeof value === 'string' && HEX.test(value) ? value : fallback);

/** A theme's base colours as declarations. Known keys only, #rrggbb only. */
export const colorVars = (colors) => THEME_KEYS.filter((key) => typeof colors?.[key] === 'string' && HEX.test(colors[key])).map((key) => `--${key}:${colors[key]}`).join(';');

/** The CRT values as declarations, all validated. */
export const crtVars = (crt = {}) => [
    `--scan-color:${hex(crt.scanlines?.color, '#ffffff')}`, `--scan-alpha:${num(crt.scanlines?.alpha, 0.035, 1)}`,
    `--vignette:${num(crt.vignette, 0.45, 1)}`, `--heading-glow:${num(crt.headingGlowPx, 8, 24)}px`,
    `--text-glow:${num(crt.textGlow?.px, 0, 8)}px`, `--text-glow-alpha:${num(crt.textGlow?.alpha, 0, 1) * 100}%`,
].join(';');

// Derived from the base colours, plus the names that pages from before the redesign still use.
const DERIVED = `--page:color-mix(in srgb,var(--screen) 55%,#000);
--case:color-mix(in srgb,var(--frame) 24%,var(--screen));--case-hi:color-mix(in srgb,var(--frame) 42%,var(--screen));
--pane-2:color-mix(in srgb,var(--frame) 16%,var(--pane));--line:color-mix(in srgb,var(--frame) 55%,var(--pane));
--faint:color-mix(in srgb,var(--frame) 80%,var(--text) 20%);--glow:color-mix(in srgb,var(--info) 45%,transparent);--ink:var(--screen);
--scan:color-mix(in srgb,var(--scan-color) calc(var(--scan-alpha) * 100%),transparent);
--text-shine:color-mix(in srgb,var(--text) var(--text-glow-alpha),transparent);
--fail-tint:color-mix(in srgb,var(--fail) 14%,var(--pane));--fail-line:color-mix(in srgb,var(--fail) 35%,var(--pane));
--drop-shadow:rgba(0,0,0,.45);
--bg:var(--page);--surface:var(--pane);--surface-2:var(--pane-2);--shadow:var(--drop-shadow);--rail:var(--line);--subtle:var(--faint);
--ok-text:var(--ok);--fail-text:var(--fail);--pending:var(--faint);--icon-ink:var(--ink);--auto:var(--claude);
--primary:var(--info);--primary-hover:color-mix(in srgb,var(--info) 85%,#000);--primary-ink:var(--ink);--primary-text:var(--info);
--primary-deep:var(--screen);--primary-soft:color-mix(in srgb,var(--info) 40%,var(--pane));--bubble-frame:var(--frame)`;

const SIZES = `--fs-label:12px;--fs-meta:11px;--fs-small:13px;--fs-body:14px;--fs-step:15px;--fs-logo:24px;--fs-crt:20px;
--gap-page:16px;--gap-card:14px;--pad-card:16px 12px 10px;--frame-w:2px;--frame-w-sm:2px`;

/**
 * Fonts, colours, CRT values and spacing as CSS. Always dark; monochrome themes set data-mono on <html> (themeAttr).
 * @param theme resolved theme; default: the active one
 */
export const themeCss = (theme = activeTheme()) => `${fontFaces(theme)}:root{${themeVars(theme)}}`;

/** The declarations alone, without selector and fonts: for a shadow root (:host), e.g. the explore map. */
export const themeVars = (theme = activeTheme()) => {
    const display = family(theme.fonts?.display, 'ui-monospace,Consolas,monospace');
    const text = family(theme.fonts?.text, 'ui-monospace,Consolas,monospace');
    return `color-scheme:dark;${colorVars(theme.colors)};${crtVars(theme.crt)};${DERIVED};
--font-crt:${display};--font-ui:${text};--font-deco:var(--font-crt);--font-body:var(--font-ui);--font-mono:var(--font-ui);${SIZES}`;
};

/** The attribute for <html>: data-mono for monochrome themes. */
export const themeAttr = (theme = activeTheme()) => (theme.mono ? ' data-mono="on"' : '');

/** The package's theme.css as <style>, to include after the own rules; empty without one. `</` is escaped. */
export const themeStyle = (theme = activeTheme()) => (theme.css ? `<style data-caw-theme-css>${theme.css.replaceAll('</', '<\\/')}</style>` : '');

/**
 * The theme for a page: everything except css and files. The page sets colours only as variables and texts only as textContent.
 */
export const clientTheme = (theme = activeTheme()) => {
    const { pkg, ...rest } = theme;
    delete rest.css;
    delete rest.fonts;
    return { ...rest, pkg: pkg === undefined ? undefined : { ...pkg, css: undefined } };
};

/** Pixel frame as four hard shadows, one per side. */
export const ring = (width, color) => {
    const minus = width.startsWith('var(') ? `calc(${width} * -1)` : `-${width}`;
    return `0 ${minus} 0 ${color},0 ${width} 0 ${color},${minus} 0 0 ${color},${width} 0 0 ${color}`;
};

// VT323 lacks block characters (quarter and half blocks). Instead of a fallback font the page draws them as elements:
// one currentColor gradient per quarter, selected via data-q (top left, top right, bottom left, bottom right).
// All other characters stay text; a theme with frames like |/-\ keeps getting text. The terminal keeps the characters.
export const BLOCK_GLYPHS = {
    '▘': '1000', '▝': '0100', '▖': '0010', '▗': '0001', '▚': '1001', '▞': '0110', '▙': '1011', '▛': '1110', '▜': '1101', '▟': '0111',
    '▀': '1100', '▄': '0011', '▌': '1010', '▐': '0101', '█': '1111',
};
const QUARTER_AT = ['0 0', '100% 0', '0 100%', '100% 100%'];
const quarters = (pattern) => [...pattern].map((bit, index) => (bit === '1' ? QUARTER_AT[index] : null)).filter(Boolean);

/**
 * Styles for the drawn block characters: .qb as element, .qbp[data-q]::before for pages that show it in a pseudo-element.
 */
export const GLYPH_CSS = `.qb{display:inline-block;width:1ch;height:1em;vertical-align:-.15em;background-repeat:no-repeat}
${[...new Set(Object.values(BLOCK_GLYPHS))].map((pattern) => {
        const at = quarters(pattern);
        return `.qb[data-q="${pattern}"],.qbp[data-q="${pattern}"]::before{background-image:${at.map(() => 'linear-gradient(currentColor,currentColor)').join(',')};background-position:${at.join(',')};background-size:${at.map(() => '50% 50%').join(',')};background-repeat:no-repeat}`;
    }).join('\n')}`;

/**
 * A character for the page: block characters as <span class="qb" data-q>, everything else as text. Runs in the page.
 * cawGlyphQ(char) returns only the pattern (or null), for pseudo-elements.
 */
function cawGlyph(char) {
    const q = cawGlyphQ(char);
    if (q === null) return document.createTextNode(String(char));
    const span = document.createElement('span');
    span.className = 'qb';
    span.dataset.q = q;
    span.setAttribute('aria-hidden', 'true');
    return span;
}

/** The glyph script to embed: defines cawGlyphQ(char) and cawGlyph(char). */
export const GLYPH_SCRIPT = `const cawGlyphQ=(char)=>(${JSON.stringify(BLOCK_GLYPHS)})[char]??null;\n${cawGlyph.toString()}`;

/**
 * The console building blocks: case (.crt-case), screen with scanlines (.crt), window with legend (.win, .lg),
 * status marks (.tag-*), sections (.sec), buttons, pills, progress, glow (.glow, .readable). No rounded corners.
 */
export const CONSOLE_CSS = `.crt-case{background:var(--case);box-shadow:inset 0 2px 0 var(--case-hi),inset 0 -4px 0 rgba(0,0,0,.35)}
.crt{position:relative;background:var(--screen);isolation:isolate}
.crt::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:-1;
background:repeating-linear-gradient(0deg,var(--scan) 0 1px,transparent 1px 3px),radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,var(--vignette)) 100%)}
.readable{text-shadow:0 0 var(--text-glow) var(--text-shine)}
.glow{text-shadow:0 0 var(--heading-glow) var(--glow)}
.win{position:relative;background:var(--pane);border:2px solid var(--frame);box-shadow:4px 4px 0 var(--drop-shadow);min-width:0;min-height:0}
.lg{position:absolute;top:-13px;left:10px;z-index:2;background:var(--screen);padding:0 6px;font:400 var(--fs-crt)/1 var(--font-crt);color:var(--accent);white-space:nowrap}
.sec{font:400 19px/1.2 var(--font-crt);color:var(--faint);white-space:nowrap;overflow:hidden}
.sec b{font-weight:400;color:var(--accent)}
.tag{flex:none;font:400 18px/1 var(--font-crt);white-space:pre}
.tag-ok{color:var(--ok)}.tag-warn{color:var(--warn)}.tag-fail{color:var(--fail)}.tag-fail.inverted{background:var(--fail);color:var(--ink)}.tag-run,.tag-ask{color:var(--info)}.tag-open{color:var(--faint)}
.px-label{font:400 19px/1 var(--font-crt);letter-spacing:.02em;text-transform:uppercase}
.px-btn{font:400 19px/1 var(--font-crt);border:0;border-radius:0;cursor:pointer;padding:6px 12px;color:var(--text);background:var(--pane-2);box-shadow:inset 0 0 0 2px var(--frame)}
.px-btn:hover:enabled{background:var(--line)}.px-btn:active:enabled{transform:translate(1px,1px)}
.px-btn--primary{background:var(--accent);color:var(--ink);box-shadow:4px 4px 0 var(--drop-shadow)}.px-btn--primary:hover:enabled{background:var(--accent);filter:brightness(1.08)}
.px-btn:disabled{opacity:.45;cursor:default}
.px-pill{display:inline-flex;align-items:center;gap:8px;font:400 20px/1 var(--font-crt);padding:4px 10px;color:var(--muted);box-shadow:inset 0 0 0 2px currentColor;white-space:nowrap}
.px-pill--fail{color:var(--fail)}.px-pill--ok{color:var(--ok)}.px-pill--run{color:var(--info)}.px-pill--warn{color:var(--warn)}
.gauge{font:400 20px/1.1 var(--font-crt);white-space:pre}
/* The spinner cell is exactly one mark-font character wide: [  ▖   ] stays as wide as [  OK  ]. */
.spinf{display:inline-block;width:1ch;text-align:center;white-space:nowrap}
:focus-visible{outline:2px dashed var(--info);outline-offset:3px}
${GLYPH_CSS}`;

/** The background of a whole page. */
export const PAGE_BG = 'background:var(--page)';

/** Old name of the building blocks, for pages that already include them. */
export const PIXEL_CSS = CONSOLE_CSS;

/**
 * The raven's lines as HTML, coloured via the parts' variables (body, eye, beak). Everything escaped.
 * @param eye  which eye: open, shut, happy
 */
function cawRavenRows(raven, eye) {
    const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const PARTS = ['frame', 'text', 'muted', 'accent', 'info'];
    const part = (name, fallback) => (PARTS.includes(raven.parts?.[name]) ? raven.parts[name] : fallback);
    const glyph = esc(raven.eyes?.[eye] ?? '•');
    return raven.lines.map((line) => `<span style="color:var(--${part('body', 'frame')})">${esc(line)
        .replace('{eye}', `<span class="eye" style="color:var(--${part('eye', 'text')})">${glyph}</span>`)
        .replace('{beak}', `<span class="beak" style="color:var(--${part('beak', 'accent')})">${esc(raven.beak ?? '>')}</span>`)}</span>`).join('\n');
}

/**
 * The logo. `size` is the font size in px. A click sends up hearts: an easter egg, so it does not look clickable (no hand cursor,
 * no hover frame) and is not in the tab order.
 */
export const ravenLogo = (theme = activeTheme(), { size = 22, label = 'caw' } = {}) => `<button class="raven" type="button" tabindex="-1" data-raven aria-label="${String(label).replaceAll('"', '&quot;')}" style="font-size:${Number(size)}px">${cawRavenRows(theme.raven, 'open')}</button>`;

/** Styles of the logo and the hearts. */
export const RAVEN_CSS = `.raven{background:none;border:0;padding:2px 4px;margin:0;cursor:default;font:400 22px/1 var(--font-crt);white-space:pre;text-align:left;color:var(--frame)}
.raven:focus,.raven:focus-visible{outline:none}
.caw-heart{position:fixed;pointer-events:none;z-index:2147483646;white-space:pre;font:400 14px/1 var(--font-crt);color:var(--heart);text-shadow:0 0 var(--heart-glow,8px) var(--heart);animation:caw-rise var(--dur,1.4s) steps(var(--steps,9),end) forwards}
@keyframes caw-rise{0%{transform:translate(0,0);opacity:1}70%{opacity:1}100%{transform:translate(var(--dx,0),var(--rise,-80px));opacity:0}}
@media (prefers-reduced-motion:reduce){.caw-heart{display:none}}
.still .caw-heart{display:none}`;

/**
 * The logo script, runs in the page. Values from theme.raven: blinking (blink.ms, firstMs, pauseMs, double) and
 * click (pet.happyMs, pet.hearts). Reduced motion or `still()`: no blinking and no hearts; hearts in flight disappear
 * (they are hidden by CSS and removed when their time is up) instead of freezing. The raven can be
 * swapped later via setRaven (the theme dialog).
 * @param scope  document or shadow root with the [data-raven] buttons
 * @param layer  where the hearts go
 * @param still  () => true while "animations off" applies
 * @returns { setRaven(raven) } for a theme change
 */
function cawRaven(scope, layer, still, initial) {
    let raven = initial;
    const ravens = () => [...scope.querySelectorAll('[data-raven]')];
    const busy = new Set();
    const draw = (el, eye) => {
        el.innerHTML = cawRavenRows(raven, eye);
    };
    const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || still();
    const n = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
    const shut = (ms) => {
        const open = ravens().filter((el) => !busy.has(el));
        open.forEach((el) => draw(el, 'shut'));
        setTimeout(() => open.forEach((el) => !busy.has(el) && draw(el, 'open')), ms);
    };
    const blink = () => {
        const b = raven.blink ?? {};
        if (!reduce()) {
            shut(n(b.ms, 160));
            if (Math.random() < n(b.double?.chance, 0)) setTimeout(() => shut(n(b.double?.ms, 140)), n(b.double?.afterMs, 320));
        }
        const [lo, hi] = Array.isArray(b.pauseMs) ? b.pauseMs : [4000, 9000];
        setTimeout(blink, Math.max(500, n(lo, 4000) + Math.random() * Math.max(0, n(hi, 9000) - n(lo, 4000))));
    };
    setTimeout(blink, n(raven.blink?.firstMs, 1800));
    scope.addEventListener('click', (event) => {
        const el = event.target.closest?.('[data-raven]');
        if (!el || !ravens().includes(el)) return;
        event.stopPropagation();
        const h = raven.pet?.hearts ?? {};
        const glyphs = Array.isArray(h.glyphs) && h.glyphs.length > 0 ? h.glyphs : ['♥'];
        // Animations off or reduced motion: the raven still squints, but no hearts rise.
        const count = reduce() ? 0 : Math.min(20, n(h.count, 6));
        const [lo, hi] = Array.isArray(h.durationMs) ? h.durationMs : [1100, 1800];
        const box = el.getBoundingClientRect();
        for (let i = 0; i < count; i += 1) {
            const heart = document.createElement('span');
            heart.className = 'caw-heart';
            heart.setAttribute('aria-hidden', 'true');
            heart.textContent = String(glyphs[Math.floor(Math.random() * glyphs.length)]);
            heart.style.left = `${Math.round(box.left + box.width * (0.1 + 0.8 * (count > 1 ? i / (count - 1) : 0.5)) - 8)}px`;
            heart.style.top = `${Math.round(box.top + box.height * n(h.startAt, 0.2))}px`;
            heart.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 2 * n(h.driftPx, 20))}px`);
            heart.style.setProperty('--rise', `${-n(h.risePx, 80)}px`);
            heart.style.setProperty('--steps', String(Math.max(1, Math.round(n(h.steps, 9)))));
            heart.style.setProperty('--heart-glow', `${n(h.glowPx, 8)}px`);
            heart.style.setProperty('--dur', `${((n(lo, 1100) + Math.random() * Math.max(0, n(hi, 1800) - n(lo, 1100))) / 1000).toFixed(2)}s`);
            heart.style.animationDelay = `${i * n(h.staggerMs, 70)}ms`;
            layer.appendChild(heart);
            heart.addEventListener('animationend', () => heart.remove());
            // Also without animationend: "animations off" stops the animation, the heart must not stay behind.
            setTimeout(() => heart.remove(), Math.ceil(parseFloat(heart.style.getPropertyValue('--dur')) * 1000) + i * n(h.staggerMs, 70) + 100);
        }
        busy.add(el);
        draw(el, 'happy');
        setTimeout(() => {
            busy.delete(el);
            draw(el, 'open');
        }, n(raven.pet?.happyMs, 800));
    }, true);
    return {
        setRaven: (next) => {
            if (next && Array.isArray(next.lines)) raven = next;
            ravens().forEach((el) => !busy.has(el) && draw(el, 'open'));
        },
    };
}

/** The logo script to embed: defines cawRavenRows(raven, eye) and cawRaven(scope, layer, still, raven). */
export const RAVEN_SCRIPT = `${cawRavenRows.toString()}\n${cawRaven.toString()}`;

/**
 * Sets a theme's colours and CRT values on an element; runs in pages that receive the theme by message
 * (chat, theme dialog). Validates on its own: known keys only, #rrggbb only, numbers within bounds.
 */
function cawApplyTheme(root, theme) {
    const keys = ['screen', 'pane', 'frame', 'text', 'muted', 'accent', 'ok', 'warn', 'fail', 'info', 'claude', 'human', 'heart'];
    const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    const inRange = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
    if (!theme || typeof theme !== 'object') return;
    for (const key of keys) if (isHex(theme.colors?.[key])) root.style.setProperty(`--${key}`, theme.colors[key]);
    const crt = theme.crt ?? {};
    if (isHex(crt.scanlines?.color)) root.style.setProperty('--scan-color', crt.scanlines.color);
    if (inRange(crt.scanlines?.alpha, 1)) root.style.setProperty('--scan-alpha', String(crt.scanlines.alpha));
    if (inRange(crt.vignette, 1)) root.style.setProperty('--vignette', String(crt.vignette));
    if (inRange(crt.headingGlowPx, 24)) root.style.setProperty('--heading-glow', `${crt.headingGlowPx}px`);
    if (inRange(crt.textGlow?.px, 8)) root.style.setProperty('--text-glow', `${crt.textGlow.px}px`);
    if (inRange(crt.textGlow?.alpha, 1)) root.style.setProperty('--text-glow-alpha', `${crt.textGlow.alpha * 100}%`);
    if (theme.mono === true) root.dataset.mono = 'on';
    else delete root.dataset.mono;
}

/** The theme script to embed: defines cawApplyTheme(root, theme). */
export const APPLY_THEME_SCRIPT = cawApplyTheme.toString();

/**
 * The favicon: the raven's head "(•>" on the theme's screen colour, as SVG. No file; the colours are validated.
 */
export const favicon = (theme = activeTheme()) => {
    const color = (key, fallback) => hex(theme.colors?.[key], fallback);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${color('screen', '#0f1026')}"/>`
        + `<rect x="1" y="1" width="30" height="30" fill="none" stroke="${color('frame', '#5a61b0')}" stroke-width="2"/>`
        + `<path d="M9 9h2v2H9zM7 11h2v10H7zM9 21h2v2H9z" fill="${color('frame', '#5a61b0')}"/>`
        + `<rect x="13" y="14" width="4" height="4" fill="${color('text', '#e8e9f7')}"/>`
        + `<path d="M20 11h2v2h2v2h2v2h-2v2h-2v2h-2v-2h2v-2h2v-2h-2v-2h-2z" fill="${color('accent', '#f2c94c')}"/></svg>`;
    return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(svg)}">`;
};

/** The active theme's favicon at module load. */
export const FAVICON = favicon();
