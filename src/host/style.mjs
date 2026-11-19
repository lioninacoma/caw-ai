// The look of caw-ai, one design ("Graphite") in a light and a dark mode, shared by every page: workbench, chat, report and
// explore card.
//
// - Tokens: colours, radii and fonts as CSS custom properties, light under :root, dark under :root[data-mode=dark].
// - Mode: the personal pref `mode` is system (default, follows prefers-color-scheme live), light or dark. The page carries it
//   as data-pref on <html> (modeAttr); MODE_SCRIPT turns it into data-mode and follows the system while the pref is system.
//   Changing data-pref later switches the page at once.
// - Fonts: Geist and Geist Mono (assets/fonts, variable weights 100 to 900) as data URLs: the test browser blocks foreign
//   hosts, and the chat has no origin of its own.
// - Logo, favicon and line icons as inline SVG, all in currentColor.
// - Base components: buttons, link, icon button, badge, kbd, status pill, transport chip, card, menu, field, segmented control,
//   switch, banner and diff lines. Animations stop with prefers-reduced-motion and with .still (animations off).
// - No ligatures anywhere: Geist Mono's "liga" draws "--" in one cell, so "first-errand --env" read as "first-errand--env". Every
//   `font` shorthand resets font-variant-ligatures, hence !important on all elements.

import { readFileSync } from 'node:fs';

/** The mode prefs: system follows the operating system. */
export const MODES = ['system', 'light', 'dark'];

/** The mode a pref stands for; anything unknown is system. */
export const modeOf = (pref) => (MODES.includes(pref) ? pref : 'system');

/** The token values, light and dark. Every name exists in both. */
export const TOKENS = {
    light: {
        bg: '#F7F8F8', panel: '#FFFFFF', panel2: '#F2F4F4', sunk: '#F7F8F8', line: '#E5E8E9', line2: '#D4D8DA',
        text: '#0E1112', muted: '#5D6568', faint: '#899194',
        accent: '#0891B2', 'accent-text': '#0E7490', 'accent-soft': '#E3F6FA', 'on-accent': '#FFFFFF',
        prim: '#0E1112', 'prim-hi': '#2A3033', 'on-prim': '#FFFFFF',
        pass: '#18794E', 'pass-soft': '#E8F7EE', fail: '#CD2B31', 'fail-soft': '#FDECEC', warn: '#9E5000', 'warn-soft': '#FFF3DA',
        run: '#0E7490', 'run-soft': '#E3F6FA', agent: '#0891B2', 'agent-soft': '#E3F6FA', human: '#0E1112',
        code: '#F7F8F8', 'code-text': '#20262A', 'diff-add': '#E8F7EE', 'diff-del': '#FDECEC',
        nav: '#FFFFFF', 'nav-text': '#0E1112', 'nav-muted': '#5D6568', 'nav-line': '#E5E8E9',
        'shadow-lg': '0 10px 30px rgba(14,17,18,.12),0 0 0 1px rgba(14,17,18,.07)',
        pick: '#0891B2', 'on-pick': '#FFFFFF', 'pick-soft': 'rgba(8,145,178,.12)',
        overlay: 'rgba(14,17,18,.28)', ink: '#0E1112', 'on-ink': '#FFFFFF',
    },
    dark: {
        bg: '#0A0C0D', panel: '#0F1213', panel2: '#171B1C', sunk: '#0A0C0D', line: '#22282A', line2: '#323A3C',
        text: '#ECEFF0', muted: '#9AA3A6', faint: '#677174',
        accent: '#22D3EE', 'accent-text': '#5EE0F2', 'accent-soft': 'rgba(34,211,238,.11)', 'on-accent': '#04191D',
        prim: '#ECEFF0', 'prim-hi': '#FFFFFF', 'on-prim': '#0A0C0D',
        pass: '#3DD68C', 'pass-soft': 'rgba(61,214,140,.11)', fail: '#FF6B70', 'fail-soft': 'rgba(255,99,105,.11)', warn: '#F5B83D', 'warn-soft': 'rgba(245,184,61,.11)',
        run: '#5EE0F2', 'run-soft': 'rgba(34,211,238,.09)', agent: '#22D3EE', 'agent-soft': 'rgba(34,211,238,.11)', human: '#ECEFF0',
        code: '#0A0C0D', 'code-text': '#C9D0D2', 'diff-add': 'rgba(61,214,140,.10)', 'diff-del': 'rgba(255,99,105,.10)',
        nav: '#0F1213', 'nav-text': '#ECEFF0', 'nav-muted': '#9AA3A6', 'nav-line': '#22282A',
        'shadow-lg': '0 16px 40px rgba(0,0,0,.6),0 0 0 1px #2A3133',
        pick: '#22D3EE', 'on-pick': '#04191D', 'pick-soft': 'rgba(34,211,238,.14)',
        overlay: 'rgba(0,0,0,.55)', ink: '#ECEFF0', 'on-ink': '#0A0C0D',
    },
};

// Values that do not change with the mode.
const FIXED = '--font:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:"Geist Mono",ui-monospace,Consolas,monospace;'
    + '--fs:13px;--r1:6px;--r2:8px;--r3:10px;--rp:999px;--row:32px';
const declarations = (values) => Object.entries(values).map(([name, value]) => `--${name}:${value}`).join(';');

/**
 * The tokens as CSS. `root` gets the light values and the fixed ones, `dark` the dark values.
 * For a shadow root: tokenCss({ root: ':host', dark: ':host([data-mode=dark])' }).
 */
export const tokenCss = ({ root = ':root', dark = ':root[data-mode=dark]' } = {}) => `${root}{color-scheme:light;${FIXED};${declarations(TOKENS.light)}}
${dark}{color-scheme:dark;${declarations(TOKENS.dark)}}`;

const FONTS = [['Geist', 'geist.woff2'], ['Geist Mono', 'geist-mono.woff2']];
let faces = null;

/** @font-face for Geist and Geist Mono, both variable (100 to 900), as data URLs. Read once. */
export const fontFaces = () => {
    faces ??= FONTS.map(([family, file]) => {
        const data = readFileSync(new URL(`../../assets/fonts/${file}`, import.meta.url)).toString('base64');
        return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:100 900;font-style:normal;font-display:block}`;
    }).join('');
    return faces;
};

/** The attributes for <html> (or a shadow host): the pref, and the mode right away when it is fixed. */
export const modeAttr = (pref) => {
    const mode = modeOf(pref);
    return ` data-pref="${mode}" data-mode="${mode === 'dark' ? 'dark' : 'light'}"`;
};

/**
 * Runs in the page: sets data-mode on `root` from its data-pref. system follows prefers-color-scheme, also when it changes;
 * a new data-pref applies at once.
 */
function cawMode(root) {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
        const pref = root.dataset.pref;
        const mode = pref === 'light' || pref === 'dark' ? pref : media.matches ? 'dark' : 'light';
        if (root.dataset.mode !== mode) root.dataset.mode = mode;
    };
    apply();
    media.addEventListener('change', apply);
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-pref'] });
}

/** Defines cawMode(root), for pages that apply the mode to something other than <html> (a shadow host). */
export const MODE_FUNCTION = cawMode.toString();

/** The mode script for a page, best placed first in <head>: applies to <html>. */
export const MODE_SCRIPT = `${MODE_FUNCTION}\ncawMode(document.documentElement);`;

/** The line icons: 24-unit paths, drawn with currentColor. */
const ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', circle: '<circle cx="12" cy="12" r="8"/>', dash: '<path d="M7 12h10"/>',
    loader: '<path d="M12 3a9 9 0 1 0 9 9"/>', 'chev-r': '<path d="m9 6 6 6-6 6"/>', 'chev-d': '<path d="m6 9 6 6 6-6"/>', 'chev-u': '<path d="m6 15 6-6 6 6"/>', 'chev-l': '<path d="m15 6-6 6 6 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', cross: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
    more: '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>', reload: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', plus: '<path d="M12 5v14M5 12h14"/>', up: '<path d="M12 19V5M5 12l7-7 7 7"/>', down: '<path d="M12 5v14M5 12l7 7 7-7"/>', pause: '<path d="M9 5v14M15 5v14"/>', play: '<path d="M7 5v14l11-7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>', flag: '<path d="M5 21V4h12l-2.5 4L17 12H5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"/>',
    file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17.5v.01"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', terminal: '<path d="m5 8 4 4-4 4M12 17h7"/>',
    arrows: '<path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3"/>', agent: '<path d="M10 3.5C10.7 9.3 12.7 11.3 18.5 12C12.7 12.7 10.7 14.7 10 20.5C9.3 14.7 7.3 12.7 1.5 12C7.3 11.3 9.3 9.3 10 3.5Z"/><path d="M18.5 2C18.85 4.4 19.6 5.15 22 5.5C19.6 5.85 18.85 6.6 18.5 9C18.15 6.6 17.4 5.85 15 5.5C17.4 5.15 18.15 4.4 18.5 2Z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>', msg: '<path d="M4 5h16v11H9l-5 4z"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    wave: '<path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>', shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>', moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.6-2.4 2.1-2.4 3.6M12 17h.01"/>', list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    bug: '<rect x="8" y="7" width="8" height="13" rx="4"/><path d="M12 7V4.5M9.5 5 8 3.5M14.5 5 16 3.5M8 11H4M8 16H4M16 11h4M16 16h4"/>', bookmark: '<path d="M6 4h12v17l-6-4-6 4z"/>',
    coins: '<ellipse cx="9" cy="7" rx="5" ry="2.5"/><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7"/><path d="M10 15.5c1 1.2 2.9 2 5 2 2.8 0 5-1.1 5-2.5v-4c0-1.4-2.2-2.5-5-2.5"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>', db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};
// Icons drawn as filled shapes instead of strokes.
// agent: a large and a small sparkle, filled; a generic sign for the AI agent, never a vendor's mark.
const FILLED = new Set(['more', 'agent']);

/** The names of the icons. */
export const ICON_NAMES = Object.keys(ICONS);

/**
 * An icon as inline SVG (class "i", aria-hidden). Unknown names give an empty icon.
 * @param cls extra classes, e.g. "spin" for the loader
 */
export const icon = (name, { cls = '' } = {}) => {
    const classes = ['i', FILLED.has(name) ? 'fillc' : '', cls].filter(Boolean).join(' ');
    return `<svg class="${classes}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
};

// The mark: a round body with its beak to the right and an eye cut out in the ground colour.
const LOGO_PATHS = '<circle cx="13" cy="16" r="9.5" fill="currentColor"/><path d="M21 11.6 30.5 16 21 20.4z" fill="currentColor"/>'
    + '<circle cx="15.6" cy="13.4" r="1.9" fill="var(--logo-eye,var(--nav))"/>';

/** The logo as inline SVG in currentColor, `size` in px. With a label it is an image, otherwise decoration. */
export const logo = ({ size = 24, label } = {}) => {
    const px = Number(size) > 0 ? Number(size) : 24;
    const name = typeof label === 'string' && label !== '' ? ` role="img" aria-label="${label.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"` : ' aria-hidden="true"';
    return `<svg class="logo" width="${px}" height="${px}" viewBox="0 0 32 32"${name}>${LOGO_PATHS}</svg>`;
};

// The favicon follows the browser's own scheme: ink on light tabs, light on dark ones.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.b{fill:#0E1112}.e{fill:#FFFFFF}'
    + '@media (prefers-color-scheme:dark){.b{fill:#ECEFF0}.e{fill:#0A0C0D}}</style><circle class="b" cx="13" cy="16" r="9.5"/>'
    + '<path class="b" d="M21 11.6 30.5 16 21 20.4z"/><circle class="e" cx="15.6" cy="13.4" r="1.9"/></svg>';

/** The favicon as <link>, an SVG data URL. */
export const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

/**
 * The base components. Pages add their own layout on top.
 * .btn (36 px) with .btn-p (primary, ink), .btn-s (secondary), .btn-sm (28 px); .lnk; .ib (icon button); .bdg (badge);
 * kbd; .pill with .dot (status); .tp (transport chip REC/PLAY/PAUSE); .card; .pop with .pop-h, .pop-i, .pop-sep (menu);
 * .field; .seg (segmented control); .switch; .banner; .dl (diff lines); .i (icon), .spin, .spinner.
 */
export const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font:400 var(--fs)/1.45 var(--font);-webkit-font-smoothing:antialiased}
button,input,textarea,select{font:inherit;color:inherit}
code,kbd,pre,samp{font-family:var(--font-mono)}
*,*::before,*::after{font-variant-ligatures:none!important}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}
.i.fillc{fill:currentColor;stroke:none}
.logo{flex:none;display:block}
.spin{animation:caw-spin 1s linear infinite;transform-origin:50% 50%}
.spinner{display:inline-block;flex:none;width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;vertical-align:-1px;animation:caw-spin .9s linear infinite}
@keyframes caw-spin{to{transform:rotate(360deg)}}
@keyframes caw-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 15px;border-radius:var(--r1);font:500 13px/1 var(--font);border:1px solid transparent;cursor:pointer;white-space:nowrap;text-decoration:none;background:none}
.btn-p{background:var(--prim);color:var(--on-prim)}.btn-p:hover:enabled{background:var(--prim-hi)}
.btn-s{background:var(--panel);color:var(--text);border-color:var(--line2)}.btn-s:hover:enabled{background:var(--panel2)}
.btn-d{background:var(--fail);color:var(--on-accent)}
.btn-sm{height:28px;padding:0 10px;font-size:12px;gap:6px}
.btn .i{width:15px;height:15px}
.btn kbd{background:transparent;border-color:currentColor;color:inherit;opacity:.65;padding:2px 4px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.lnk{display:inline-flex;align-items:center;gap:5px;color:var(--accent-text);font:500 13px/1.3 var(--font);text-decoration:none;cursor:pointer;background:none;border:0;padding:0}
.lnk:hover{text-decoration:underline;text-underline-offset:3px}.lnk .i{width:14px;height:14px}.lnk-m{color:var(--muted)}
.ib{display:inline-grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:var(--r1);background:none;color:var(--muted);cursor:pointer;flex:none}
.ib:hover:enabled{background:var(--panel2);color:var(--text)}.ib:disabled{opacity:.45;cursor:not-allowed}
.bdg{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:var(--rp);font:600 11px/1 var(--font);white-space:nowrap;background:var(--panel2);color:var(--muted)}
.bdg .i{width:12px;height:12px;stroke-width:2.4}
.bdg.pass{background:var(--pass-soft);color:var(--pass)}.bdg.fail{background:var(--fail-soft);color:var(--fail)}
.bdg.warn{background:var(--warn-soft);color:var(--warn)}.bdg.run{background:var(--run-soft);color:var(--run)}
.bdg.acc{background:var(--accent-soft);color:var(--accent-text)}.bdg.line{background:none;box-shadow:inset 0 0 0 1px var(--line2);color:var(--muted)}
kbd{display:inline-flex;align-items:center;font:500 10.5px/1 var(--font-mono);padding:3px 5px;border-radius:var(--r1);border:1px solid var(--line2);background:var(--panel2);color:var(--muted);white-space:nowrap;letter-spacing:0}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 10px;border-radius:var(--rp);font:500 12px/1 var(--font);white-space:nowrap;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line2);color:var(--text)}
.pill .dot{color:var(--faint)}
.pill.run .dot{color:var(--run);animation:caw-pulse 1.4s ease-in-out infinite}.pill.pass .dot{color:var(--pass)}.pill.fail .dot{color:var(--fail)}
.pill.turn .dot{color:var(--warn)}.pill.agent .dot{color:var(--agent);animation:caw-pulse 1.4s ease-in-out infinite}
.tp{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:var(--rp);font:700 10.5px/1 var(--font-mono);letter-spacing:.08em;box-shadow:inset 0 0 0 1px currentColor;white-space:nowrap}
.tp i{width:9px;height:9px;background:currentColor;border-radius:50%;flex:none}
.tp.rec{color:var(--fail)}.tp.rec i{animation:caw-pulse 1.6s ease-in-out infinite}
.tp.play{color:var(--pass)}.tp.play i{border-radius:0;clip-path:polygon(0 0,100% 50%,0 100%)}
.tp.pause{color:var(--warn)}.tp.pause i{border-radius:0;background:linear-gradient(90deg,currentColor 0 35%,transparent 35% 65%,currentColor 65%)}
.card{display:flex;flex-direction:column;border-radius:var(--r2);background:var(--panel);border:1px solid var(--line);overflow:hidden}
.card-h{display:flex;align-items:center;gap:8px;padding:12px 14px 0;font:500 13px/1.2 var(--font);color:var(--text)}
.card-b{display:flex;flex-direction:column;gap:10px;padding:10px 14px 14px;font-size:13px;line-height:1.5}
.card-f{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px}
.pop{background:var(--panel);border:1px solid var(--line2);border-radius:var(--r2);box-shadow:var(--shadow-lg);padding:5px;display:flex;flex-direction:column;gap:1px;font-size:12.5px;min-width:0}
.pop-h{padding:6px 8px 4px;font:600 10.5px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.pop-i{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:center;padding:6px 8px;border:0;border-radius:5px;background:none;color:var(--text);text-align:left;cursor:pointer;min-width:0;width:100%}
.pop-i .i{width:15px;height:15px;color:var(--muted)}.pop-i:hover:enabled,.pop-i.sel{background:var(--accent-soft)}.pop-i.sel .i{color:var(--accent-text)}
.pop-i.danger,.pop-i.danger .i{color:var(--fail)}.pop-i:disabled,.pop-i.off{opacity:.45;cursor:not-allowed}
.pop-i .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pop-sep{height:1px;background:var(--line);margin:4px 2px}
.field{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-radius:var(--r1);background:var(--sunk);border:1px solid var(--line2);color:var(--text);font-size:13px;min-width:0}
.field:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.field .i{width:15px;height:15px;color:var(--faint)}
.field input{flex:1;min-width:0;border:0;outline:0;background:none;padding:0}
.seg{display:inline-flex;padding:2px;gap:2px;border-radius:var(--r1);background:var(--sunk);border:1px solid var(--line)}
.seg button{border:0;background:none;cursor:pointer;padding:5px 11px;border-radius:4px;font:500 12px/1 var(--font);color:var(--muted);display:inline-flex;align-items:center;gap:6px}
.seg button[aria-pressed=true],.seg button[aria-checked=true]{background:var(--panel);color:var(--text);box-shadow:0 0 0 1px var(--line2)}
.switch{width:34px;height:20px;border-radius:var(--rp);border:0;padding:0;background:var(--line2);position:relative;flex:none;cursor:pointer}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--panel);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .12s}
.switch[aria-checked=true]{background:var(--accent)}.switch[aria-checked=true]::after{left:16px}
.banner{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--r2);font-size:12.5px;line-height:1.45}
.banner .i{width:16px;height:16px;margin-top:1px}.banner b{display:block;font-weight:600}
.banner.prod,.banner.fail{background:var(--fail-soft);color:var(--fail)}.banner.ro,.banner.warn{background:var(--warn-soft);color:var(--warn)}
.banner.info{background:var(--run-soft);color:var(--run)}.banner p{margin:0;color:var(--text)}
.diff{border-radius:var(--r1);border:1px solid var(--line);overflow:hidden;font:400 11.5px/1.5 var(--font-mono);background:var(--code)}
.dl{display:grid;grid-template-columns:30px 14px minmax(0,1fr);padding:1px 8px 1px 0;color:var(--code-text)}
.dl .n{color:var(--faint);text-align:right;padding-right:6px;user-select:none}.dl .sg{color:var(--faint)}
.dl code{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.dl.del{background:var(--diff-del)}.dl.del .sg{color:var(--fail)}.dl.add{background:var(--diff-add)}.dl.add .sg{color:var(--pass)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
.still,.still *,.still *::before,.still *::after{animation:none!important;transition:none!important}`;

/** Everything a page needs in one <style>: fonts, tokens and the base components. */
export const styleSheet = () => `${fontFaces()}${tokenCss()}\n${BASE_CSS}`;
