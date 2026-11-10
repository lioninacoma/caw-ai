// Das Aussehen von caw-ai, gemeinsam fuer Werkbank und Chat: Schriften, Farben, Pixel-Bausteine, Rabe, Favicon.
//
// Die Schriften und der Rabe liegen im Tool (Schriften: SIL Open Font License, siehe assets/fonts) und kommen als data-URL in
// die Seite: Der Testbrowser sperrt fremde Hosts, Google Fonts waere nicht erreichbar, und der Chat hat keinen eigenen Origin.

import { readFileSync } from 'node:fs';

const asset = (path, type) => {
    try {
        return `data:${type};base64,${readFileSync(new URL(`../../assets/${path}`, import.meta.url)).toString('base64')}`;
    } catch {
        return null;
    }
};

const face = (family, file, weight) => {
    const src = asset(`fonts/${file}`, 'font/woff2');
    return src === null ? '' : `@font-face{font-family:"${family}";src:url(${src}) format("woff2");font-weight:${weight};font-style:normal;font-display:block}`;
};

export const FONT_FACES = face('Silkscreen', 'silkscreen-latin-400-normal.woff2', 400)
    + face('IBM Plex Mono', 'ibm-plex-mono-latin-400-normal.woff2', 400)
    + face('IBM Plex Mono', 'ibm-plex-mono-latin-500-normal.woff2', 500);

/** Der Rabe als Spritesheet. Welche Zelle zu welchem Clip gehoert und wie lange sie steht, sagt raven-clips.mjs. */
export const RAVEN_SHEET = asset('mascot/raven-sheet.png', 'image/png') ?? '';

const DARK = `--primary-hover:#376f90;--primary-text:#6fb0d6;
--bg:#12132a;--bg-dot:#1d1f42;--surface:#1b1d3c;--surface-2:#22254a;
--frame:#4a5094;--shadow:#080916;--line:#2e3266;--rail:#3a3e74;
--text:#e8e9f7;--muted:#9a9dc0;--subtle:#8b8fb6;
--ok:#5fd18f;--ok-text:#7fe0a8;--fail:#ff6c76;--fail-text:#ff8a92;--fail-tint:#3a1d2e;--fail-line:#4a2a40;--warn:#f2b53c;
--pending:#6a70a8;--icon-ink:#12132a;--auto:#b3a4ee;--cloud:#6a7194;--drop:#7fb2e0;
--raven-outline:rgba(205,213,243,.85);--raven-outline-fade:rgba(205,213,243,.35);--bubble-frame:rgba(205,213,243,.85);
color-scheme:dark`;

/**
 * Farben, Schriften und Abstaende als CSS-Variablen ("Pult"). Hell ist der Standard, dunkel folgt dem System;
 * data-theme="light" oder "dark" auf <html> erzwingt eines davon.
 */
export const TOKENS = `:root{color-scheme:light;
--font-deco:"Silkscreen","Courier New",monospace;--font-ui:"IBM Plex Mono",ui-monospace,Consolas,monospace;--font-body:var(--font-ui);--font-mono:var(--font-ui);
--fs-label:12px;--fs-meta:11px;--fs-small:13px;--fs-body:15px;--fs-step:17px;--fs-logo:24px;
--gap-page:24px;--gap-card:14px;--pad-card:16px 18px;--step-row:72px;--frame-w:3px;--frame-w-sm:2px;
--primary:#2f5f7c;--primary-hover:#27526b;--primary-ink:#ffffff;--primary-text:#2f5f7c;--primary-deep:#1f455c;--primary-soft:#cfe2ee;
--bg:#e7eaf2;--bg-dot:#d6dae6;--surface:#ffffff;--surface-2:#f4f6fa;--frame:#191a2e;--shadow:#c9cee0;--line:#dde1ec;--rail:#c9cee0;
--text:#191a2e;--muted:#5c6080;--subtle:#6d7190;
--ok:#2e8a52;--ok-text:#24713f;--fail:#c23a46;--fail-text:#b0303c;--fail-tint:#fbeaec;--fail-line:#f0c9cd;--warn:#8a6420;--pending:#8b92ae;--icon-ink:#ffffff;--auto:#6b5aa6;--cloud:#9aa3bd;--drop:#4a7fb0;
--raven-outline:#ffffff;--raven-outline-fade:rgba(47,95,124,.35);--bubble-frame:#191a2e;
--browser-dot-1:#ff8a92;--browser-dot-2:#f2b53c;--browser-dot-3:#7fe0a8;--crumb:#c98a3a}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}`;

/** Pixelrahmen als vier harte Schatten, je Seite einer. */
export const ring = (width, color) => {
    const minus = width.startsWith('var(') ? `calc(${width} * -1)` : `-${width}`;
    return `0 ${minus} 0 ${color},0 ${width} 0 ${color},${minus} 0 0 ${color},${width} 0 0 ${color}`;
};

/** Pixel-Bausteine: Rahmen mit Stufenecken ueber box-shadow, Labels, Knoepfe, Status-Pill, Fortschritt. Keine Rundungen. */
export const PIXEL_CSS = `.px-frame{background:var(--surface);box-shadow:${ring('var(--frame-w)', 'var(--frame)')},6px 6px 0 var(--shadow)}
.px-frame-sm{box-shadow:${ring('var(--frame-w-sm)', 'var(--frame)')}}
.px-label{font-family:var(--font-ui);font-weight:500;font-size:var(--fs-label);letter-spacing:.08em;text-transform:uppercase}
.px-btn{font-family:var(--font-ui);font-weight:500;font-size:12px;letter-spacing:.04em;line-height:1.3;border:0;border-radius:0;cursor:pointer;padding:11px 14px;color:var(--text);background:var(--surface);box-shadow:${ring('2px', 'var(--frame)')},4px 4px 0 var(--shadow)}
.px-btn:hover:enabled{background:var(--surface-2)}.px-btn:active:enabled{transform:translate(2px,2px);box-shadow:${ring('2px', 'var(--frame)')}}
.px-btn--primary{background:var(--primary);color:var(--primary-ink)}.px-btn--primary:hover:enabled{background:var(--primary-hover)}
.px-btn:disabled{opacity:.45;cursor:default}
.px-btn:focus-visible{outline:3px dashed var(--primary-text);outline-offset:4px}
.px-pill{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-ui);font-weight:500;font-size:var(--fs-label);letter-spacing:.06em;padding:5px 10px;color:var(--muted);background:var(--surface-2);box-shadow:${ring('2px', 'currentColor')};white-space:nowrap}
.px-pill::before{content:"";width:6px;height:6px;background:currentColor}
.px-pill--fail{color:var(--fail-text);background:var(--fail-tint)}.px-pill--ok{color:var(--ok-text)}.px-pill--run{color:var(--primary-text)}
.px-progress{display:flex;gap:3px;height:8px}.px-progress>i{flex:1;background:var(--line)}
.px-progress>i.pass{background:var(--ok)}.px-progress>i.fail{background:var(--fail)}.px-progress>i.run{background:var(--primary)}`;

/** Der Pixel-Hintergrund der Seite: Punktraster im 8-px-Takt. */
export const PAGE_BG = 'background-color:var(--bg);background-image:radial-gradient(var(--bg-dot) 1.5px,transparent 1.6px);background-size:8px 8px';

const icon = asset('mascot/favicon-32.png', 'image/png');

/** Das Logo als Favicon: die Pixel-Kachel mit dem Raben. */
export const FAVICON = icon === null ? '' : `<link rel="icon" type="image/png" href="${icon}">`;
