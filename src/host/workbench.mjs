// The workbench: one page for the whole run, in Graphite (style.mjs) and the personal mode (system, light or dark). Left the
// steps with their marks, in the middle the application iframe with its address bar and a status line whose counts open
// requests and console, right the chat. The chat is a document of its own (srcdoc); its page is the one from chat.mjs.
//
// No toolbars: the header holds the product, the breadcrumb with the test and a badge with the run's mode, the run facts,
// the status pill, the REC/PLAY/PAUSE chip and one ⋯ menu (also Ctrl+K) that lists every function with its key. Pane
// titles collapse their pane (F4, F6). F8 shows only the application with one line back, F10 stops all animation, Ctrl+,
// opens the settings page, a view of the workbench (not a dialog) that changes only cosmetic prefs and shows the rest
// read-only. The chat forwards these keys, and posts them for its slash commands (CHAT_KEYS).
//
// Refresh (F5) reloads the application's current page without cache after the hand-over; chat and steps stay, the steps
// then show "state left". While the test runs, reloading is locked: it would corrupt the state for the following steps.
// If someone reloads the whole workbench, the host rebuilds it. F11 and F12 stay with Chrome.
//
// The application shares the origin with the workbench (top.Ext & co.), not with the chat: that one is sandboxed in an opaque
// origin, and the host knows it as the frame the workbench created on load, never by its name. A fake iframe named caw-chat
// therefore cannot speak as the human. Sharing the workbench's origin, the application can still remove the chat iframe's
// sandbox or reload it: the host writes the chat only into the frame's first document and only while that has an opaque
// origin (chat.mjs, writeChat); a reloaded chat frame ends the run (chat-tampered). The application may trigger a refresh (F5 inside it reports anyway); it only takes
// effect after the hand-over. For the same reason everything the page shows can be read by the application: the settings
// page gets names, flags, the home folder as ~ and line counts, never the content of a note. The workbench tells the chat a
// new mode by postMessage; the chat takes it only from its parent and only as one of the three modes.

import { APP_FRAME, CHAT_FRAME_NAME, FOCUS_SCRIPT, RELOAD_SCRIPT, frameView, interceptDocuments, sourceTag } from './app-view.mjs';
import { markAppFrame } from './host-lock.mjs';
import { language, t, texts } from '../shared/i18n.mjs';
import { LONG_NAME } from '../shared/brand.mjs';
import { readPrefs, writePagePref } from '../shared/prefs.mjs';
import { BASE_CSS, FAVICON, MODES, MODE_SCRIPT, icon, logo, modeAttr, styleSheet, tokenCss } from './style.mjs';

export const CHAT_FRAME = CHAT_FRAME_NAME;
export const PREF_BINDING = 'cawPref';
export const REFRESH_BINDING = 'cawRefresh';
/** Application only (F8): toggles the solo view. */
export const FULLSCREEN_BINDING = 'cawFullscreen';
/** Pick a state (F1): run a test up to a step. */
export const STATE_BINDING = 'cawState';
/**
 * The chat runs in a sandboxed iframe without allow-same-origin, so with its own opaque origin. The workbench shares its
 * origin with the application (so top.Ext & co. work). Without the sandbox the application could reach the chat and decide
 * as the human, e.g. adopt a change. This way it reaches neither its DOM nor its binding. The attribute alone does not hold:
 * the application can remove it and reload the frame. Hence the host checks the opaque origin before writing the chat and
 * treats any later navigation of the chat frame as tampering (chat.mjs).
 */
export const CHAT_SANDBOX = 'allow-scripts allow-forms';
/** Keys the chat may pass on to the workbench, also for its slash commands: they open views and menus, never decide. A message
 * from the chat cannot trigger more. */
export const CHAT_KEYS = ['F1', 'F2', 'F3', 'F4', 'F6', 'F8', 'F10', 'Ctrl+,', 'Ctrl+K', '?'];
const RELOADED_MS = 15000;
/** The preparation group: Chrome, login, local code, loading. */
export const PREP = 'prep';
const PANEL_MS = 1000;
const MAX_ROWS = 300;
// A binding can be exposed only once per page; per page the host remembers who currently handles refresh.
const benches = new WeakMap();

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
/** JSON for a <script>: `<` cannot end it. */
const json = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
/** Takes a new mode from the workbench, as the chat page does (chat.mjs): only from the parent, only one of the three. */
const MODE_LISTENER = `addEventListener('message',(event)=>{const p=event.data?.pref;if(event.source===parent&&event.data?.caw==='mode'&&${json(MODES)}.includes(p))document.documentElement.dataset.pref=p;});`;
/** The placeholder in the chat frame until the chat arrives. In the current language and mode, so built on use; one line
 * of text, so without the fonts. */
const chatPlaceholder = (mode) => `<!doctype html><html lang="${language()}"${modeAttr(mode)}><meta charset="utf-8"><title>${t('workbench.chat')}</title><script>${MODE_SCRIPT}${MODE_LISTENER}${sourceTag}</script><style>${tokenCss()}${BASE_CSS}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--panel);color:var(--muted)}
p{flex:1;display:grid;place-items:center;margin:0;padding:24px;text-align:center;font-size:13px}</style>
<p>${t('workbench.chatPlaceholder')}</p></html>`;

/** The ⋯ menu: [icon, label, key shown, attributes]; null is a separator, a string a heading. Every item presses its key. */
const menuItems = (ctrl, still) => [
    t('workbench.menuRun'),
    ['pause', t('workbench.page.keyPause'), 'F9', 'id="mPause" data-key="F9" data-press="F9"'],
    ['reload', t('workbench.keyReload'), 'F5', `id="reload" data-press="F5" disabled title="${esc(t('workbench.page.refreshLockedTitle'))}"`],
    ['x', t('workbench.keyAbort'), 'Esc', 'id="mCancel" class="danger" data-key="Escape" data-press="Escape"'],
    null,
    ['play', t('workbench.stateTitle'), 'F1', 'data-states data-press="F1" hidden'],
    t('workbench.menuView'),
    ['arrows', t('workbench.requests'), 'F2', 'data-tabkey="requests" data-press="F2"'],
    ['terminal', t('workbench.console'), 'F3', 'data-tabkey="console" data-press="F3"'],
    ['panel', t('workbench.page.hideSteps'), 'F4', 'id="fSteps" data-press="F4"'],
    ['msg', t('workbench.page.hideChat'), 'F6', 'id="fChat" data-press="F6"'],
    ['expand', t('workbench.solo'), 'F8', 'data-solo data-press="F8"'],
    null,
    ['wave', t('workbench.still'), 'F10', `id="still" role="menuitemcheckbox" aria-checked="${still}" data-press="F10" title="${esc(t('workbench.stillTitle'))}"`],
    ['gear', t('workbench.page.settings'), `${ctrl} ,`, 'id="mSettings" data-press="Ctrl+,"'],
    ['keyboard', t('workbench.shortcuts'), '?', 'id="mKeys" data-press="?"'],
];

/** The key list of the settings page. */
const keyList = (ctrl) => [
    [t('workbench.keys.more'), `${ctrl} K`], [t('workbench.keys.open'), 'F1'], [t('workbench.keys.drawer'), 'F2 · F3'], [t('workbench.keys.panels'), 'F4 · F6'],
    [t('workbench.keys.reload'), 'F5'], [t('workbench.solo'), 'F8'], [t('workbench.keys.pause'), 'F9'], [t('workbench.still'), 'F10'], [t('workbench.keys.cancel'), 'Esc Esc'],
    [t('workbench.page.settings'), `${ctrl} ,`], [t('workbench.shortcuts'), '?'],
];

/** The settings page: everything static here, the values come from the host (window.workbench.settings) as text. */
const settingsView = (ctrl) => {
    const row = (title, hint, value, extra = '') => `<div class="set-r"${extra}><div class="l"><b>${title}</b>${hint ? `<small>${hint}</small>` : ''}</div><div class="set-v">${value}</div></div>`;
    const ro = (id = '') => `<span class="ro-tag"${id ? ` id="${id}"` : ''}>${icon('lock')}<span>${t('workbench.page.setReadOnly')}</span></span>`;
    const keyed = (key, id, label) => `<span class="kv-row"><kbd>${key}</kbd><button type="button" class="switch" role="switch" id="${id}" aria-checked="true" aria-label="${esc(label)}"></button></span>`;
    const nav = (name, glyph, label) => `<button type="button" data-sec="${name}">${icon(glyph)}${label}</button>`;
    const mode = (name, glyph) => `<button type="button" data-mode="${name}" aria-pressed="false">${icon(glyph)}${t(`workbench.set.${name}`)}</button>`;
    return `<section id="settings" class="spage" hidden aria-label="${t('workbench.page.settings')}">
<nav class="snav" aria-label="${t('workbench.set.nav')}"><button type="button" class="back" id="setBack">${icon('chev-l')}${t('workbench.set.back')}<kbd>Esc</kbd></button>${nav('general', 'sliders', t('workbench.set.general'))}${nav('claude', 'spark', t('workbench.set.claude'))}${nav('notes', 'book', t('workbench.set.notes'))}${nav('keys', 'keyboard', t('workbench.set.keys'))}${nav('run', 'db', t('workbench.set.run'))}</nav>
<div class="scont" id="scont"><div class="sin">
<section data-sec="general" id="set-general"><h2 tabindex="-1" id="setHead">${t('workbench.set.general')}</h2><p class="lede" id="setLede"></p></section>
<section><h3 class="sgrp-h">${t('workbench.set.appearance')}</h3><div class="sgrp">
${row(t('workbench.set.mode'), t('workbench.set.modeHint'), `<div class="seg" id="setMode" role="group" aria-label="${t('workbench.set.mode')}">${mode('system', 'monitor')}${mode('light', 'sun')}${mode('dark', 'moon')}</div>`)}
${row(t('workbench.set.animations'), t('workbench.set.animationsHint'), keyed('F10', 'setStill', t('workbench.set.animations')))}
${row(t('workbench.set.language'), t('workbench.set.languageHint'), `<span class="stack"><span id="setLang"></span><span class="ro-tag" id="setLangSrc"></span></span>`)}
</div></section>
<section><h3 class="sgrp-h">${t('workbench.set.layout')}</h3><div class="sgrp">
${row(t('workbench.set.stepsPanel'), t('workbench.set.panelHint'), keyed('F4', 'setSteps', t('workbench.set.stepsPanel')))}
${row(t('workbench.set.chatPanel'), t('workbench.set.panelHint'), keyed('F6', 'setChat', t('workbench.set.chatPanel')))}
</div></section>
<section data-sec="claude" id="set-claude"><h3 class="sgrp-h">${t('workbench.set.claude')}</h3><div class="sgrp">
${row(t('workbench.set.token'), t('workbench.set.tokenHint'), `<span class="stack"><span id="setToken"></span>${ro()}</span>`)}
${row(t('workbench.set.agent'), t('workbench.set.agentHint'), `<span class="stack"><code id="setAgent"></code><span class="ro-tag">${icon('lock')}<span>${t('workbench.page.setFromCommand')}</span></span></span>`, ' id="setAgentRow" hidden')}
</div></section>
<section data-sec="notes" id="set-notes"><h3 class="sgrp-h">${t('workbench.set.notes')}</h3><div class="sgrp">
${row(t('workbench.set.personal'), `${t('workbench.set.personalHint')}<span class="path"><code id="setPersonalPath"></code><span id="setPersonalLines"></span></span>`, `<button type="button" class="lnk" id="setCopy">${icon('copy')}<span>${t('workbench.page.setCopy')}</span></button>`)}
${row(t('workbench.set.projectNotes'), `<span class="path"><code id="setProjectPath"></code><span id="setProjectLines"></span></span>${t('workbench.set.projectNotesHint')}`, ro())}
</div></section>
<div class="two"><section data-sec="keys" id="set-keys"><h3 class="sgrp-h">${t('workbench.set.keys')}</h3><div class="sgrp pad"><div class="keys">${keyList(ctrl).map(([label, key]) => `<span>${label}</span><kbd>${key}</kbd>`).join('')}</div></div></section>
<section data-sec="run" id="set-run"><h3 class="sgrp-h">${t('workbench.set.run')} ${ro()}</h3><div class="sgrp pad"><dl class="kv" id="setRun"></dl></div></section></div>
</div></div></section>`;
};

/**
 * The workbench page. `appUrl` loads the iframe; the host sets everything else via `window.workbench`.
 * @param prefs   personal settings: animations 'on' | 'off', steps and chat 'open' | 'closed', mode 'system' | 'light' | 'dark'
 */
export const workbenchHtml = ({ appUrl, title, prefs = {} }) => {
    const still = prefs.animations === 'off';
    const classes = [still ? 'still' : '', prefs.steps === 'closed' ? 'fold-steps' : '', prefs.chat === 'closed' ? 'fold-chat' : ''].filter(Boolean).join(' ');
    const refreshTitle = t('workbench.refreshTitle');
    const test = String(title ?? '').replace(/^caw\s*·?\s*/, '');
    const ctrl = t('workbench.page.keyCtrl');
    const menu = menuItems(ctrl, still).map((item) => {
        if (item === null) return '<div class="pop-sep" role="separator"></div>';
        if (typeof item === 'string') return `<div class="pop-h" role="presentation">${item}</div>`;
        const [glyph, label, key, attrs] = item;
        // An item may bring its own class (danger) and role (menuitemcheckbox).
        const cls = /class="([^"]*)"/.exec(attrs)?.[1];
        const role = /role="([^"]*)"/.exec(attrs)?.[1] ?? 'menuitem';
        const rest = attrs.replace(/ ?(class|role)="[^"]*"/g, '');
        return `<button type="button" class="pop-i${cls ? ` ${cls}` : ''}" role="${role}" tabindex="-1" ${rest}>${icon(glyph)}<span class="nm">${label}</span><kbd>${key}</kbd></button>`;
    }).join('');
    const pane = (name, label, foldLabel, unfoldLabel, key, chevFold, chevUnfold, extra = '') => `<div class="pane-h"><h2 class="pane-t"><button type="button" class="pane-tb" id="${name}Title" aria-expanded="true" title="${esc(foldLabel)} (${key})">${esc(label)}</button></h2>${extra}<button class="fold ib" id="${name}Fold" type="button" aria-expanded="true" aria-label="${foldLabel}" title="${foldLabel} (${key})">${icon(chevFold)}</button></div><button class="strip" id="${name}Strip" type="button" aria-expanded="false" aria-label="${unfoldLabel}" title="${unfoldLabel} (${key})">${icon(chevUnfold)}${label}${name === 'steps' ? ' <span id="stripTally"></span>' : ''}</button>`;
    return `<!doctype html><html lang="${language()}"${modeAttr(prefs.mode)}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><script>${MODE_SCRIPT}</script>${FAVICON}<style>
${styleSheet()}
[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{background:var(--bg)}
.pa{height:100vh;display:flex}
#bench{flex:1;min-width:0;display:flex;flex-direction:column}
/* The header: product, breadcrumb with the run's title, facts, status pill, transport chip and the one menu. */
.top{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;min-height:48px;padding:0 16px;background:var(--nav);color:var(--nav-text);border-bottom:1px solid var(--nav-line)}
.brand{flex:none;display:flex;align-items:center;gap:10px;color:var(--nav-text)}
.brand .word{font:600 20px/1 var(--font);letter-spacing:-.04em}
.crumb{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 200px;font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden}
.crumb .sl{color:var(--line2);font-size:18px;font-weight:300}
.crumb b{color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis}
#title{flex:0 1 auto;min-width:0;display:block;line-height:20px;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.top-r{margin-left:auto;display:flex;align-items:center;gap:10px;min-width:0}
.facts{display:flex;gap:14px;margin:0;padding:0;list-style:none;font:400 11.5px/1 var(--font-mono);color:var(--nav-muted);white-space:nowrap;min-width:0;overflow:hidden}
.facts li{overflow:hidden;text-overflow:ellipsis}
#state{display:none}#state.on{display:inline-flex}
#notice{font-size:12px;color:var(--warn)}
#transport{display:none}#transport.on{display:inline-flex}
#more[aria-expanded=true]{background:var(--panel2);color:var(--text)}
/* The ⋯ menu: every function with its key. */
#menu{position:fixed;top:44px;right:12px;z-index:35;width:280px;max-width:calc(100vw - 24px);max-height:calc(100vh - 56px);overflow:auto}
#menu .pop-i:focus{outline:none;background:var(--accent-soft)}#menu .pop-i:focus .i{color:var(--accent-text)}
#menu .pop-i[aria-checked=true] .i{color:var(--accent-text)}
.panes{flex:1;min-height:0;display:grid;gap:0;
--col-steps:minmax(270px,288px);--col-chat:minmax(300px,372px);grid-template-columns:var(--col-steps) minmax(0,1fr) var(--col-chat);grid-template-rows:minmax(0,1fr);
grid-template-areas:"steps browser chat"}
.win{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--panel)}
.win+.win{border-left:1px solid var(--line)}
.pane-h{flex:none;display:flex;align-items:center;gap:8px;height:44px;padding:0 10px 0 14px;border-bottom:1px solid var(--line)}
.pane-t{margin:0;font:500 13px/1 var(--font);color:var(--text);min-width:0}
.pane-tb{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}
.cnt{margin-left:auto;font:400 11.5px/1 var(--font-mono);color:var(--faint)}
.fold{width:24px;height:24px;opacity:0;margin-left:auto}.cnt+.fold{margin-left:0}
.fold .i{width:14px;height:14px}
.pane-h:hover .fold,.fold:focus-visible{opacity:1}
.pa-steps{grid-area:steps}
.pa-browser{grid-area:browser}
.pa-chat{grid-area:chat}
.strip{display:none;border:0;cursor:pointer;background:none;color:var(--muted);font:500 12px/1 var(--font);writing-mode:vertical-rl;padding:14px 0;align-items:center;gap:10px;width:100%;height:100%}
.strip:hover{color:var(--text);background:var(--panel2)}
#stripTally{font:400 11px/1 var(--font-mono);color:var(--faint)}
.left-state #steps{opacity:.45}
#leftNote{margin:10px 14px 0;padding:8px 10px;font-size:12.5px;line-height:1.45;color:var(--muted);background:var(--warn-soft);border-radius:var(--r1)}
#leftNote strong{display:block;margin-bottom:3px;font-weight:600;color:var(--warn)}
.hint{margin:12px 14px;font-size:12px;color:var(--faint)}
/* The step list: a quiet list. The list scrolls by itself with the current item, hence no scrollbar; the wheel still works. */
#track{flex:1;min-height:0;overflow:auto;scrollbar-width:none;padding:0 0 10px}#track::-webkit-scrollbar{display:none}
#steps,#steps .pts{list-style:none;margin:0;padding:0}
#steps .head{position:relative;display:grid;grid-template-columns:18px auto minmax(0,1fr) auto;gap:9px;align-items:start;min-height:var(--row);padding:6px 14px 5px}
#steps .head>.id,#steps .head>.ms{padding-top:4px}
#steps .id{font:500 11px/1 var(--font-mono);color:var(--faint)}
#steps .text{min-width:0}
#steps .head .name{font-weight:500;overflow-wrap:anywhere}
#steps .ms{font:400 11px/1 var(--font-mono);color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
#steps .head>.ms,#steps .head>.hov{grid-column:4;grid-row:1}
#steps>li[data-state=running]>.head .name{color:var(--run)}
#steps>li[data-state=fail]>.head .name{color:var(--fail)}
#steps>li[data-state=waiting]>.head .name,#steps>li[data-state=skipped]>.head .name{color:var(--muted)}
#steps>li[data-state=skipped]>.head .text::after{content:${JSON.stringify(t('workbench.page.skipped'))};display:block;margin-top:3px;font-size:11.5px;color:var(--faint)}
/* The fail note under its step, coloured text. */
#steps>li>.note{margin:2px 14px 6px 37px;font-size:12px;line-height:1.45;color:var(--fail);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.pts .note{font-size:11.5px;color:var(--fail);overflow-wrap:anywhere}
/* Phases (preparation, wrap-up, Claude investigates or reproduces) and the run section are group headings. */
#steps>li[data-kind=phase]>.head,#steps>li[data-kind=section]>.head{grid-template-columns:minmax(0,1fr) auto;min-height:0;padding:14px 14px 6px}
#steps>li[data-kind=phase]>.head>.st{display:none}
#steps>li[data-kind=phase]>.head .name,#steps>li[data-kind=section]>.head .name{font:500 12px/1.2 var(--font);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
#steps>li[data-kind=phase][data-state=fail]>.head .name{color:var(--fail)}
#steps>li[data-kind=phase]>.head>.ms,#steps>li[data-kind=section]>.head>.ms{grid-column:2;padding-top:0}
#steps>li[data-kind=phase]>.head,#steps>li[data-kind=section]>.head{align-items:baseline}
/* A hovered step offers to open its state (F1), only when the host offers it for this test. */
.hov{display:none;align-items:center;gap:2px;white-space:nowrap}
.hov .lnk{font-size:12px}.hov .ib{width:22px;height:22px}
#steps>li.openable>.head:hover,#steps>li.openable>.head:focus-within{background:var(--panel2)}
#steps>li.openable>.head:hover>.ms,#steps>li.openable>.head:focus-within>.ms{display:none}
#steps>li.openable>.head:hover>.hov,#steps>li.openable>.head:focus-within>.hov{display:inline-flex}
/* The items: in a phase rows with their own mark; under a step its actions, hanging off a hairline. */
.pts>li{display:grid;gap:6px 9px;align-items:baseline;min-width:0}
.pts .tree{display:none}
#steps>li[data-kind=phase]>.pts>li{grid-template-columns:18px minmax(0,1fr);align-items:center;min-height:var(--row);padding:5px 14px;font:400 13px/1.4 var(--font);color:var(--text)}
#steps>li[data-kind=phase] .mk,#steps>li[data-kind=step] .pts .st{display:none}
#steps>li[data-kind=step]>.pts{margin:0 0 4px 22px;border-left:1px solid var(--line);padding:2px 0}
#steps>li[data-kind=step]>.pts:empty{display:none}
#steps>li[data-kind=step]>.pts>li{grid-template-columns:minmax(0,1fr);padding:3px 12px 3px 14px;font:400 12px/1.4 var(--font-mono);color:var(--muted)}
#steps>li[data-kind=step] .pts .text{display:block;position:relative;padding-left:46px}
#steps>li[data-kind=step] .pts .text>.kind{position:absolute;left:0;top:0;width:42px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pts .text>.ms{float:right;margin-left:8px;line-height:calc(13px*1.4)}#steps>li[data-kind=step] .pts .text>.ms{font-size:10.5px;line-height:calc(12px*1.4)}
#steps>li[data-kind=step] .pts .text>.name{color:var(--text)}
#steps>li[data-kind=step] .pts>li[data-state=running]{box-shadow:inset 1px 0 0 var(--run);margin-left:-1px;padding-left:15px}
#steps>li[data-kind=step] .pts>li[data-state=fail]{box-shadow:inset 1px 0 0 var(--fail);margin-left:-1px;padding-left:15px}
.pts .text{min-width:0;overflow-wrap:anywhere}
#steps>li[data-kind=phase] .pts .kind{margin-right:5px}
#steps>li[data-kind=phase] .pts>li[data-state=waiting]{color:var(--muted)}#steps>li[data-kind=phase] .pts>li[data-state=running]{color:var(--run)}#steps>li[data-kind=phase] .pts>li[data-state=fail]{color:var(--fail)}
#steps>li[data-kind=step] .pts>li[data-state=running] .name{color:var(--run)}#steps>li[data-kind=step] .pts>li[data-state=fail] .name{color:var(--fail)}
#steps>li[data-kind=step] .pts>li[data-state=waiting] .name,#steps>li[data-state=skipped] .pts .name{color:var(--faint)}
.pts .live{display:block;font-size:11px;color:var(--run)}
/* The marks: an icon per state, a spinner while running. */
.st{display:inline-grid;place-items:center;width:18px}
.tag{display:inline-grid;place-items:center;width:18px;height:18px}.tag .i{width:14px;height:14px;stroke-width:2.2}
.tag-ok{color:var(--pass)}.tag-fail{color:var(--fail)}.tag-run{color:var(--run)}.tag-open,.tag-skip{color:var(--faint)}
.bad{color:var(--fail)!important}
/* The application: address bar, the app's own look, the status line with the counts, the drawer. */
.appbar{flex:none;display:flex;gap:10px;align-items:center;height:44px;padding:0 14px;white-space:nowrap;overflow:hidden;border-bottom:1px solid var(--line)}
#url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font:400 12px/1 var(--font-mono);color:var(--muted)}
#browserState{font:700 10.5px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--run)}
#browserState.rec,#browserState.bad{color:var(--fail)}#browserState.ask{color:var(--warn)}
#vp{font:400 11.5px/1 var(--font-mono);color:var(--faint)}
#appBox{flex:1;min-height:0;display:flex;position:relative;overflow:hidden}
#app{flex:1;min-height:0;width:100%;border:0;display:block;background:#fff}
/* A pinned viewport: the frame has exactly the recorded size, scaled down (never up) to fit, centred. */
#appBox.pinned{background:var(--sunk)}#appBox.pinned #app{flex:none;position:absolute;top:0;transform-origin:0 0}
.drawer{display:none;flex:none;border-top:1px solid var(--line);background:var(--panel)}.drawer.open{display:block}
.tabs{display:flex;align-items:center;gap:16px;height:34px;padding:0 14px;border-bottom:1px solid var(--line)}
.tabs button[role=tab]{font:400 12px/1 var(--font);color:var(--muted);background:none;border:0;padding:0;height:100%;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.tabs button[role=tab]:hover{color:var(--text)}
.tabs button[aria-selected=true]{color:var(--text);font-weight:600;box-shadow:inset 0 -2px 0 var(--accent)}
.tabs .count{font:500 11px/1 var(--font-mono);color:inherit}.tabs .count.bad{color:var(--fail)}
.tabs .end{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font:400 11px/1 var(--font-mono);color:var(--faint)}
#drawerClose{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}#drawerClose:hover{color:var(--text)}
.panel{height:26vh;min-height:110px;overflow:auto;background:var(--panel)}
table{width:100%;border-collapse:collapse;table-layout:fixed;font:400 11.5px/1.3 var(--font-mono)}
td{padding:6px 14px;border-top:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
tr:first-child td{border-top:0}
td.m{width:64px;color:var(--muted)}td.m.w{color:var(--warn)}td.p{width:auto;color:var(--text)}td.ok{color:var(--pass)}td.bad{color:var(--fail)}td.open{color:var(--muted)}td.res{width:90px}td.t{text-align:right;color:var(--faint);width:80px}
.empty{padding:10px 14px;color:var(--muted);font:12px var(--font-mono)}
.cline{padding:4px 14px;border-top:1px solid var(--line);font:11.5px/1.45 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}.cline:first-child{border-top:0}.cline.fail{color:var(--fail)}.cline.warn{color:var(--warn)}
.afoot{flex:none;display:flex;align-items:center;gap:10px;height:34px;padding:0 14px;border-top:1px solid var(--line);font:400 11.5px/1 var(--font-mono);color:var(--muted);white-space:nowrap;overflow:hidden}
.afoot button{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}.afoot button:hover{color:var(--text)}
.afoot .sep{color:var(--line2)}.afoot .keys{margin-left:auto;color:var(--faint)}
#chat{flex:1;width:100%;min-height:0;border:0;display:block;background:var(--panel)}
/* Application only (F8): one line stays for the way back. */
.soloBar{display:none;align-items:center;gap:12px;height:36px;padding:0 14px;white-space:nowrap;overflow:hidden;background:var(--nav);color:var(--nav-text);border-bottom:1px solid var(--line)}
#soloUrl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font:400 12px/1 var(--font-mono);color:var(--muted)}
.soloBar .lnk{font-size:12px}
.solo .soloBar{display:flex}
.solo .top,.solo .pa-steps,.solo .pa-chat,.solo .appbar,.solo .drawer,.solo .afoot{display:none}
.solo .panes{grid-template-columns:minmax(0,1fr);grid-template-areas:"browser"}
.solo .pa-browser{border:0}
/* Open… (F1): tests on the left, their steps on the right, the explanation and Open at the bottom. Also in solo view. */
#stateDlg{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:var(--overlay)}
#stateDlg>.dlg{width:min(860px,calc(100vw - 32px));height:min(600px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line2);border-radius:var(--r3);box-shadow:var(--shadow-lg);overflow:hidden}
.dlg-h{flex:none;display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.dlg-h h2{margin:0;font:600 15px/1.2 var(--font);letter-spacing:-.01em}
.dlg-h .sub{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dlg-h .lnk{margin-left:auto;font-size:12px;flex:none}
.scols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);flex:1;min-height:0}
.scol{display:flex;flex-direction:column;min-height:0;min-width:0;padding:14px;gap:6px}.scol+.scol{border-left:1px solid var(--line)}
.sec{font:600 10.5px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:4px 0 6px}
.sfilter{margin-bottom:4px}
.slist{overflow:auto;display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
.srow{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;border:0;border-radius:var(--r1);background:none;cursor:pointer;padding:8px;width:100%;color:var(--text);font-size:13px}
.srow:hover:enabled{background:var(--panel2)}.srow:disabled{cursor:not-allowed;color:var(--faint)}
.srow[aria-selected=true],.srow[aria-selected=true]:hover{background:var(--accent-soft)}
.srow .mk{display:inline-grid;place-items:center;color:var(--faint)}.srow .mk .i{width:15px;height:15px}.srow[aria-selected=true] .mk{color:var(--accent-text)}
.srow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .sid{font:500 11px/1 var(--font-mono);color:var(--faint);margin-right:6px}.srow[aria-selected=true] .sid{color:var(--accent-text)}
.srow .meta{font-size:11px;color:var(--faint);white-space:nowrap}.srow .meta.w{color:var(--warn)}
.srow.all .nm{color:var(--accent-text)}
.sfoot{flex:none;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;border-top:1px solid var(--line);padding:12px 16px;background:var(--panel2)}
.sfoot p{margin:0;font-size:12px;line-height:1.45;color:var(--muted);min-width:0;flex:1 1 260px}
#sgo kbd{margin-left:2px}
/* Settings (Ctrl+,): a view of the workbench, the panes step back. */
.spage{display:none;flex:1;min-height:0;grid-template-columns:220px minmax(0,1fr);background:var(--panel)}
.settings-on .spage{display:grid}.settings-on .panes{display:none}
.snav{display:flex;flex-direction:column;gap:2px;padding:14px 10px;border-right:1px solid var(--line);background:var(--bg);overflow:auto}
.snav button{display:flex;align-items:center;gap:9px;padding:7px 10px;border:0;border-radius:var(--r1);background:none;color:var(--muted);font-size:13px;text-align:left;cursor:pointer}
.snav button:hover{color:var(--text)}.snav button .i{width:15px;height:15px}
.snav button.on{background:var(--panel);color:var(--text);box-shadow:0 0 0 1px var(--line)}
.snav .back{margin-bottom:10px;font-size:12px;color:var(--faint)}.snav .back kbd{margin-left:auto}
.scont{overflow:auto;min-height:0;padding:28px 40px 40px}
.sin{max-width:760px;display:flex;flex-direction:column;gap:28px}
.sin section{scroll-margin-top:20px}
.sin h2{margin:0;font:600 22px/1.2 var(--font);letter-spacing:-.025em;outline:0}
.lede{margin:4px 0 0;font-size:13px;color:var(--muted)}
.lede code,.set-r code{font-size:11px;color:var(--code-text);background:var(--code);padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}
.sgrp-h{margin:0 0 8px;font:500 13px/1.3 var(--font);display:flex;align-items:center;gap:8px}
.sgrp{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--r3);overflow:hidden}.sgrp.pad{padding:14px 16px}
.set-r{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:14px 16px;border-top:1px solid var(--line)}.set-r:first-child{border-top:0}
.set-r .l{min-width:0}.set-r .l b{display:block;font-weight:500;font-size:13px}
.set-r .l small{display:block;margin-top:2px;font-size:11.5px;line-height:1.4;color:var(--muted)}
.set-r .path{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;margin:4px 0}
.set-v{font-size:12px;color:var(--muted);text-align:right}
.set-v code{font:400 12px/1 var(--font-mono);background:none;padding:0;color:var(--text)}
.stack{display:inline-flex;flex-direction:column;align-items:flex-end;gap:3px}
.kv-row{display:inline-flex;align-items:center;gap:8px}
.ro-tag{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:500;color:var(--faint)}.ro-tag .i{width:11px;height:11px}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}
.keys{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;font-size:12.5px;align-items:center}.keys kbd{justify-self:end}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin:0;font-size:12.5px}
.kv dt{padding-top:2px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere;display:flex;flex-wrap:wrap;gap:4px}
.kv code{font:400 12px/1.4 var(--font-mono);color:var(--text)}
@media (max-width:859px){.scols{grid-template-columns:minmax(0,1fr)}.scol+.scol{border-left:0;border-top:1px solid var(--line)}.two{grid-template-columns:minmax(0,1fr)}}
@media (max-width:699px){.spage{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.snav{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}.snav .back{margin:0 8px 0 0}.scont{padding:20px 16px 32px}.set-r{grid-template-columns:minmax(0,1fr)}.set-v{text-align:left}.stack{align-items:flex-start}}
/* Three columns from 1000px; narrower sides up to 1500px so the application keeps its desktop layout. */
@media (min-width:1000px) and (max-width:1499px){.panes{--col-steps:minmax(220px,260px);--col-chat:minmax(280px,330px)}}
@media (min-width:1000px){
.fold-steps .panes{--col-steps:44px}.fold-chat .panes{--col-chat:44px}
.fold-steps .pa-steps>:not(#stepsStrip),.fold-chat .pa-chat>:not(#chatStrip){display:none}
.fold-steps #stepsStrip,.fold-chat #chatStrip{display:flex}}
@media (max-width:999px){
.fold{display:none}.pane-tb{cursor:default}
.pa{height:auto;min-height:100vh}
.panes{grid-template-columns:minmax(300px,380px) minmax(0,1fr);grid-template-rows:auto minmax(60vh,1fr);grid-template-areas:"steps browser" "chat browser"}
.pa-steps{max-height:40vh}
.win+.win{border-left:0}.pa-browser{border-left:1px solid var(--line)}.pa-chat{border-top:1px solid var(--line)}}
@media (max-width:859px){
.panes{grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-template-areas:"steps" "chat" "browser"}
.pa-steps{max-height:none}#track{overflow:visible}.pa-chat{height:72vh}.pa-browser{height:78vh;border-left:0;border-top:1px solid var(--line)}
.top{padding:6px 16px}.top-r{margin-left:0}}
</style></head><body class="${classes}"><div class="pa"><div id="bench">
<div class="soloBar">${logo({ size: 18, label: 'caw' })}<span id="soloUrl"></span><button class="lnk" type="button" data-solo data-press="F8">${t('workbench.backToBench')}<kbd>F8</kbd></button></div>
<header class="top"><div class="brand" title="${esc(LONG_NAME)}">${logo({ size: 28, label: 'caw' })}<b class="word" aria-hidden="true">caw</b></div>
<nav class="crumb" aria-label="${t('workbench.crumb')}"><span class="sl" id="projectSep" hidden>/</span><span id="project" hidden></span><span class="sl">/</span><b id="crumbTest">${esc(test || 'caw')}</b><span id="title" class="bdg line" data-test="${esc(test)}">${esc(test || 'caw')}</span></nav>
<div class="top-r"><ul class="facts" id="facts" aria-label="${t('workbench.runFacts')}"></ul><span id="notice" role="status" hidden></span><span id="state" class="pill" role="status"></span><span id="transport" class="tp" role="img"><i></i><span></span></span><button type="button" class="ib" id="more" aria-haspopup="menu" aria-expanded="false" aria-controls="menu" aria-label="${t('workbench.more')}" title="${t('workbench.more')} (${ctrl} K)">${icon('more')}</button></div></header>
<div id="menu" class="pop" role="menu" aria-label="${t('workbench.menu')}" hidden>${menu}</div>
<main class="panes">
<section class="pa-steps win" id="stepsCard" aria-label="${t('workbench.steps')}">${pane('steps', t('workbench.steps'), t('workbench.stepsFold'), t('workbench.stepsUnfold'), 'F4', 'chev-l', 'chev-r', '<span class="cnt" id="tally"></span>')}
<p id="leftNote" hidden></p><p class="hint" id="stepsHint">${t('workbench.stepsHint')}</p><div id="track"><ol id="steps" aria-label="${t('workbench.steps')}"></ol></div></section>
<section class="pa-browser win" aria-label="${t('workbench.app')}"><div class="appbar"><span id="url"></span><span id="envBadge" class="bdg" hidden></span><span id="browserState"></span><span id="vp" hidden></span></div>
<div id="appBox"><iframe id="app" name="${APP_FRAME}" title="${t('workbench.app')}" src="${esc(appUrl)}" allow="clipboard-write"></iframe></div>
<div class="drawer" id="drawer"><div class="tabs" role="tablist"><button type="button" role="tab" data-tab="requests" aria-selected="false">${t('workbench.requests')}<span class="count" data-count="requests">0</span></button><button type="button" role="tab" data-tab="console" aria-selected="false">${t('workbench.console')}<span class="count" data-count="console">0</span></button><span class="end"><span>F2 · F3 ·</span><button type="button" id="drawerClose" aria-label="${t('workbench.drawerCloseLabel')}">${t('workbench.drawerEsc')}</button></span></div>
<div class="panel" id="panel"></div></div>
<div class="afoot"><button type="button" id="footRequests" data-tabkey="requests" data-press="F2" title="${t('workbench.requests')} (F2)"></button><span class="sep">·</span><button type="button" id="footConsole" data-tabkey="console" data-press="F3" title="${t('workbench.console')} (F3)"></button><span class="keys">F2 · F3</span></div></section>
<section class="pa-chat win" id="chatCard" aria-label="${t('workbench.chatLabel')}">${pane('chat', t('workbench.chat'), t('workbench.chatFold'), t('workbench.chatUnfold'), 'F6', 'chev-r', 'chev-l')}<iframe id="chat" name="${CHAT_FRAME}" title="${t('workbench.chatLabel')}" sandbox="${CHAT_SANDBOX}" allow="clipboard-write" srcdoc="${esc(chatPlaceholder(prefs.mode))}"></iframe></section>
</main>
${settingsView(ctrl)}
</div></div>
<div id="stateDlg" hidden role="dialog" aria-modal="true" aria-label="${t('workbench.stateTitle')}"><div class="dlg"><div class="dlg-h">${icon('play')}<h2>${t('workbench.stateTitle')}</h2><span class="sub">${t('workbench.stateSub')}</span><button type="button" class="lnk lnk-m" id="sclose">${t('workbench.close')}<kbd>Esc</kbd></button></div>
<div class="scols"><div class="scol"><div class="sec">${t('workbench.page.stateTest')}</div><label class="field sfilter">${icon('search')}<input id="sq" type="search" autocomplete="off" spellcheck="false" placeholder="${t('workbench.page.stateSearch')}" aria-label="${t('workbench.page.stateSearch')}"></label><div class="slist" id="stests" role="listbox" aria-label="${t('workbench.page.stateTest')}"></div></div>
<div class="scol"><div class="sec" id="sstepsHead">${t('workbench.page.stateSteps')}</div><div class="slist" id="ssteps" role="listbox" aria-label="${t('workbench.page.stateSteps')}"></div></div></div>
<div class="sfoot"><p id="sfoot"></p><button type="button" class="lnk lnk-m" id="scancel">${t('workbench.page.stateCancel')}</button><button type="button" class="btn btn-p" id="sgo" disabled>${t('workbench.page.stateGo')}<kbd>↵</kbd></button></div></div></div>
<script>
const T=${json(texts('workbench.page.'))};
// The chat header labels (Claude working, caw working, pausing …, paused): the pill shows them first.
const PILL=${json(Object.fromEntries(Object.entries(texts('chat.status.')).filter(([name]) => name.endsWith('.label'))))};
const MODES=${json(MODES)};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]??key);
const $=(id)=>document.getElementById(id);
const state={tab:null,requests:[],console:[]};
const LABELS={waiting:T['workbench.page.waiting'],running:T['workbench.page.running'],pass:T['workbench.page.pass'],fail:T['workbench.page.fail'],skipped:T['workbench.page.skipped']};
// The groups of the list; the section heading above the steps is no group.
const items=()=>[...$('steps').children].filter((li)=>li.dataset.kind!=='section');
// Only the test's steps are counted; preparation, wrap-up and investigate failure are phases.
const stepItems=()=>items().filter((li)=>li.dataset.kind!=='phase');
const pointsOf=(li)=>[...li.querySelector(':scope>.pts').children];
// Group or item, even before the node is in the list.
const isGroup=(node)=>node.querySelector(':scope>.head')!==null;
const groupTitle=(li)=>li.dataset.kind==='phase'?li.dataset.name:li.dataset.id;
const duration=(ms)=>ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(1).replace('.',T['workbench.page.decimal'])+' s';
const cell=(text,cls)=>{const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;td.title=text;return td;};
const still=()=>document.body.classList.contains('still');
const settingsOn=()=>document.body.classList.contains('settings-on');
// The marks as icons (static SVG from the host); running is a CSS spinner.
const ICON=${json({ ok: icon('check'), fail: icon('x'), open: icon('circle'), skip: icon('dash'), chev: icon('chev-r'), file: icon('file'), more: icon('more') })};
const markInto=(el,kind)=>{if(kind==='run'){const s=document.createElement('span');s.className='spinner';el.replaceChildren(s);}else el.innerHTML=ICON[kind]??ICON.open;};
const render=()=>{
  const panel=$('panel');panel.replaceChildren();
  const empty=(key)=>{const div=document.createElement('div');div.className='empty';div.textContent=T[key];panel.append(div);};
  if(state.tab==='requests'){
    if(state.requests.length===0){empty('workbench.page.noRequests');return;}
    const table=document.createElement('table');
    for(const r of state.requests.slice().reverse()){const tr=document.createElement('tr');const cls=r.outcome==='ok'?'ok':r.outcome==='open'?'open':'bad';
      const name=String(r.name??''),at=name.indexOf(' '),method=at>0&&name.slice(0,at)===name.slice(0,at).toUpperCase()?name.slice(0,at):'';
      tr.append(cell(method,'m'+(method&&method!=='GET'?' w':'')),cell(method?name.slice(at+1):name,'p'),cell(r.result,'res '+cls),cell(r.ms===undefined?'':Math.round(r.ms)+' ms','t'));table.append(tr);}
    panel.append(table);
  }else if(state.tab==='console'){
    if(state.console.length===0){empty('workbench.page.noConsole');return;}
    for(const c of state.console.slice().reverse()){const div=document.createElement('div');div.className='cline '+c.severity;div.textContent=c.text;panel.append(div);}
  }
};
const select=(tab)=>{state.tab=state.tab===tab?null:tab;try{sessionStorage.setItem('caw-bench-tab',state.tab??'');}catch{}$('drawer').classList.toggle('open',state.tab!==null);for(const b of document.querySelectorAll('[data-tab]'))b.setAttribute('aria-selected',String(b.dataset.tab===state.tab));render();};
const closeDrawer=()=>{if(state.tab!==null)select(state.tab);};
// The console only opens by itself on new errors; only the human closes it.
let seenFails=0;
for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>select(b.dataset.tab));
// The open tab stays open after a workbench reload.
try{const tab=sessionStorage.getItem('caw-bench-tab');if(tab==='requests'||tab==='console')select(tab);}catch{}
$('drawerClose').addEventListener('click',closeDrawer);
// The counts: in the drawer's tabs and as the status line under the application, which opens the drawer.
const setCount=(name,value,bad)=>{for(const node of document.querySelectorAll('[data-count='+name+']')){node.textContent=(bad===true?'✕ ':'')+value;node.classList.toggle('bad',bad===true);}
  const foot=name==='requests'?$('footRequests'):$('footConsole');foot.textContent=(bad===true?'✕ ':'')+fill(name==='requests'?(value===1?'workbench.page.footRequest':'workbench.page.footRequests'):'workbench.page.footConsole',{count:value});foot.classList.toggle('bad',bad===true);};
setCount('requests',0);setCount('console',0);
let aborted=false;
// What the run does, for the chip at the top right: record, play, pause or null (no chip). Set by the host.
let transport=null;
// What the chat currently wants: ask from the mood, plus its state (showing: the human is demonstrating).
let asking=false,chatState=null;
const stepsHintText=$('stepsHint').textContent;
// One heading "Run" right before the first step, none without steps.
const section=()=>{const list=$('steps'),first=items().find((li)=>li.dataset.kind==='step');let sec=[...list.children].find((li)=>li.dataset.kind==='section');
  if(!first){sec?.remove();return;}
  if(!sec){sec=document.createElement('li');sec.dataset.kind='section';sec.setAttribute('role','presentation');const head=document.createElement('div');head.className='head';const name=document.createElement('span');name.className='name';const ms=document.createElement('span');ms.className='ms';head.append(name,ms);sec.append(head);}
  sec.querySelector('.name').textContent=T['workbench.page.runSection'];
  // Total time like the phases: the measured steps, once none is running any more.
  const steps=items().filter((li)=>li.dataset.kind==='step'),timed=steps.filter((li)=>li.dataset.ms!==undefined);
  sec.querySelector('.ms').textContent=timed.length>0&&!steps.some((li)=>li.dataset.state==='running')?duration(timed.reduce((total,li)=>total+Number(li.dataset.ms),0)):'';
  if(sec.nextElementSibling!==first)list.insertBefore(sec,first);};
// The status pill: dot and word. The chat header's label first (pausing and paused are the human's turn), then Claude
// reproducing, the chat waiting for the human, a failed step, all passed, ready. Nothing while a step runs without a label.
const pillOf=(failed,running,n,pass)=>{
  const label=aborted||chatState===null?undefined:PILL['chat.status.'+chatState+'.label'];
  const reproducing=items().some((li)=>li.dataset.id==='reproduce'&&li.dataset.state==='running');
  if(aborted)return ['fail',T['workbench.page.pillCancelled']];
  if(chatState==='paused'||chatState==='pausing')return ['turn',label];
  if(reproducing)return ['claude',T['workbench.page.pillReproduces']];
  if(chatState==='starting'&&label!==undefined)return ['claude',label];
  if(label!==undefined)return ['run',label];
  if(asking)return ['turn',T['workbench.page.pillYourTurn']];
  if(failed)return ['fail',fill('workbench.page.pillFailed',{id:groupTitle(failed)})];
  if(n>0&&pass===n)return ['pass',T['workbench.page.pillPassed']];
  if(running)return null;
  return n>0?['idle',T['workbench.page.pillReady']]:null;};
// Header, counter, pill and the application bar follow the steps: what runs, what failed, how many passed.
const summarize=()=>{
  section();
  const list=stepItems(),n=list.length,all=items();
  $('stepsHint').hidden=all.length>0;$('stepsHint').textContent=chatState==='showing'?T['workbench.page.stepsHintShowing']:stepsHintText;
  const pass=list.filter((li)=>li.dataset.state==='pass').length;
  $('tally').textContent=$('stripTally').textContent=n===0?'':pass+'/'+n;
  const failed=all.find((li)=>li.dataset.state==='fail'),running=list.find((li)=>li.dataset.state==='running')??all.find((li)=>li.dataset.state==='running');
  const left=document.body.classList.contains('left-state');
  let browserText=aborted?T['workbench.page.aborted']:failed?T['workbench.page.browserFailed']:running?T['workbench.page.browserRunning']:n>0&&pass===n?T['workbench.page.browserPassed']:pass>0&&left?T['workbench.page.browserReloaded']:n>0?T['workbench.page.ready']:'';
  let tone=failed&&!aborted?'bad':'';
  // If the chat waits for the human, the application bar says so too.
  if(!aborted&&asking){browserText=T['workbench.page.browserYourTurn'];tone='ask';}
  if(!aborted&&chatState==='showing'){browserText=T['workbench.page.recording'];tone='rec';}
  if(refreshing)browserText=T['workbench.page.reloading'];
  $('browserState').textContent=browserText;$('browserState').className=tone;
  const kind=pillOf(failed,running,n,pass),pill=$('state');
  pill.className='pill'+(kind===null?'':' on '+kind[0]);pill.dataset.state=chatState??'';
  if(kind===null)pill.replaceChildren();else{const dot=document.createElement('span');dot.className='dot';pill.replaceChildren(dot,kind[1]);}
  // Only while something runs: record or play from the host, pause while that run is paused (F9). Cancelled: nothing.
  const mode=transport===null||aborted?null:chatState==='paused'||chatState==='pausing'?'pause':transport;
  const chip=$('transport'),name=mode===null?'':mode[0].toUpperCase()+mode.slice(1);chip.className='tp'+(mode===null?'':' on '+({record:'rec',play:'play',pause:'pause'})[mode]);chip.dataset.kind=mode??'';
  chip.querySelector('span').textContent=mode===null?'':T['workbench.page.transport'+name];
  const word=mode===null?'':T['workbench.page.transport'+name+'Title'];chip.setAttribute('aria-label',word);chip.title=word;
  menuLabels();
};
// The host decides on refresh: after the hand-over reload the page without cache, during a running test not at all.
let appUrl=$('app').src;$('url').textContent=$('soloUrl').textContent=appUrl;
let refreshing=false,noticeTimer=0,refreshOn=false;
const REFRESH_TITLE=${json(refreshTitle)};
const notice=(text)=>{const box=$('notice');box.textContent=text;box.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{box.hidden=true;},6000);};
const refresh=async()=>{
  if(refreshing)return;refreshing=true;$('reload').disabled=true;summarize();
  let done=false;try{done=(await window.${REFRESH_BINDING}?.())===true;}catch{}
  if(!done)notice(T['workbench.page.refreshLocked']);
  refreshing=false;$('reload').disabled=!refreshOn;summarize();
};
// Personal settings: the host validates key and value.
const pref=(key,value)=>{try{const result=window.${PREF_BINDING}?.(key,value);result?.catch?.(()=>{});}catch{}};
const wide=()=>matchMedia('(min-width:1000px)').matches;
// Steps and chat can be collapsed. When the chat asks something it unfolds by itself without overriding the choice.
const foldMarks=(name,on)=>{for(const id of [name+'Fold',name+'Strip',name+'Title'])$(id).setAttribute('aria-expanded',String(id===name+'Strip'?on:!on));
  $(name==='steps'?'setSteps':'setChat').setAttribute('aria-checked',String(!on));menuLabels();};
const fold=(name,on,remember=true)=>{document.body.classList.toggle('fold-'+name,on);foldMarks(name,on);if(remember){pref(name,on?'closed':'open');if(name==='steps')autoSteps=false;}};
const toggleFold=(name)=>fold(name,!document.body.classList.contains('fold-'+name));
// Without an own choice the step list starts collapsed in narrow windows: the space belongs to the application.
let autoSteps=${prefs.steps === undefined ? 'true' : 'false'};
// When a step fails or the steps are known, the list unfolds by itself, but only if it was collapsed automatically.
let stepsWanted=false;
const fitSteps=()=>{if(!autoSteps)return;const on=innerWidth<1500&&!stepsWanted;document.body.classList.toggle('fold-steps',on);foldMarks('steps',on);};
const showSteps=()=>{if(!autoSteps||stepsWanted)return;stepsWanted=true;fitSteps();};
$('stepsFold').addEventListener('click',()=>fold('steps',true));$('stepsStrip').addEventListener('click',()=>fold('steps',false));
$('chatFold').addEventListener('click',()=>fold('chat',true));$('chatStrip').addEventListener('click',()=>fold('chat',false));
// The pane titles collapse their pane too, where panes can collapse at all.
$('stepsTitle').addEventListener('click',()=>{if(wide())toggleFold('steps');});$('chatTitle').addEventListener('click',()=>{if(wide())toggleFold('chat');});
// Application only: the workbench steps back, the browser window stays as it is (no fullscreen like F11). The host remembers
// it and restores it after a workbench reload.
const showSolo=(on)=>{document.body.classList.toggle('solo',on);};
const solo=(on=!document.body.classList.contains('solo'))=>{if(on)openSettings(false);showSolo(on);try{const result=window.${FULLSCREEN_BINDING}?.(on);result?.catch?.(()=>{});}catch{}};
// Animations off (F10): no blinking, no spinner, no cursor. Also applies to the next runs.
const setStill=(on)=>{document.body.classList.toggle('still',on);$('still').setAttribute('aria-checked',String(on));$('setStill').setAttribute('aria-checked',String(!on));pref('animations',on?'off':'on');};
// Pause and abort belong to the chat: the workbench only passes the key on.
const chatWindow=()=>{try{return $('chat').contentWindow;}catch{return null;}};
const toChat=(key)=>{try{chatWindow()?.postMessage({caw:'key',key},'*');}catch{}};
// The mode: data-pref on <html>, the mode script follows. The chat has an opaque origin and gets it as a message.
const tellChat=()=>{try{chatWindow()?.postMessage({caw:'mode',pref:document.documentElement.dataset.pref},'*');}catch{}};
const setMode=(value)=>{if(!MODES.includes(value))return;document.documentElement.dataset.pref=value;pref('mode',value);tellChat();modeMarks();};
const modeMarks=()=>{for(const b of $('setMode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.mode===document.documentElement.dataset.pref));};
$('chat').addEventListener('load',tellChat);
// The menu's words follow the state: hide or show a pane, pause or continue.
const menuLabels=()=>{const word=(id,key)=>{$(id).querySelector('.nm').textContent=T[key];};
  word('fSteps',document.body.classList.contains('fold-steps')?'workbench.page.showSteps':'workbench.page.hideSteps');
  word('fChat',document.body.classList.contains('fold-chat')?'workbench.page.showChat':'workbench.page.hideChat');
  word('mPause',chatState==='paused'||chatState==='pausing'?'workbench.page.keyContinue':'workbench.page.keyPause');};

const KIND={waiting:'open',running:'run',pass:'ok',fail:'fail',skipped:'skip'};
const makeMark=(point)=>{const st=document.createElement('span');st.className='st';st.setAttribute('role','img');st.setAttribute('aria-label',LABELS.waiting);
  const tg=document.createElement('span');tg.className='tag'+(point?' pt-tag':'');st.append(tg);
  if(point){const mk=document.createElement('span');mk.className='mk';st.append(mk);}return st;};
const paint=(node)=>{const own=isGroup(node),st=node.querySelector(own?':scope>.head>.st':':scope>.st'),k=KIND[node.dataset.state]??'open';
  const tg=st.querySelector('.tag');tg.className='tag tag-'+k+(own?'':' pt-tag');markInto(tg,k);};
// A group's fail note sits under the group, an item's under its text.
const setState=(node,stateName,note)=>{const label=LABELS[stateName]??stateName,own=isGroup(node);node.dataset.state=stateName;node.setAttribute('aria-label',node.dataset.label+' – '+label);
  node.querySelector(own?':scope>.head [role=img]':'[role=img]').setAttribute('aria-label',label);paint(node);
  if(note!==undefined||stateName!=='fail'){const box=own?node:node.querySelector('.text');box.querySelector(':scope>.note')?.remove();
    if(note){const div=document.createElement('div');div.className='note';div.textContent=note;div.title=note;box.append(div);}}};
const showMs=(node,ms)=>{const cell=node.querySelector(isGroup(node)?':scope>.head .ms':'.ms');if(ms===undefined){cell.textContent='';delete node.dataset.ms;}else{cell.textContent=duration(ms);node.dataset.ms=String(Math.round(ms));}};
const liveText=(text)=>'› '+text;
const makePoint=(p)=>{const li=document.createElement('li');li.dataset.id=p.id;li.dataset.state='waiting';if(p.kind)li.dataset.kind=p.kind;li.dataset.label=((p.kind?p.kind+' ':'')+(p.label??'')).trim();li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const tree=document.createElement('span');tree.className='tree';tree.setAttribute('aria-hidden','true');
  const text=document.createElement('span');text.className='text';if(p.kind){const kind=document.createElement('span');kind.className='kind';kind.textContent=p.kind;text.append(kind);}
  const name=document.createElement('span');name.className='name';name.textContent=p.label??'';text.append(name);
  // The duration floats right at the start of the text, so the text wraps under it and keeps the whole width.
  const ms=document.createElement('span');ms.className='ms';text.insertBefore(ms,name);li.append(tree,makeMark(true),text);paint(li);return li;};
const phaseName=(li)=>{li.querySelector(':scope>.head .name').textContent=li.dataset.name;};
// A step's hover action: open the state up to it (F1), shown only when the host offers this test (openable).
const hoverOf=(id)=>{const box=document.createElement('span');box.className='hov';
  const go=document.createElement('button');go.type='button';go.className='lnk lnk-m';go.textContent=fill('workbench.page.openUpTo',{id});go.addEventListener('click',()=>openStates(true,{step:id}));
  const more=document.createElement('button');more.type='button';more.className='ib';more.innerHTML=ICON.more;more.title=T['workbench.page.openTest'];more.setAttribute('aria-label',more.title);more.addEventListener('click',()=>openStates(true,{step:null}));
  box.append(go,more);return box;};
const makeGroup=(g)=>{const li=document.createElement('li');const phase=g.kind==='phase';li.dataset.id=g.id;li.dataset.kind=phase?'phase':'step';li.dataset.name=g.name;li.dataset.state='waiting';li.dataset.label=(phase?'':g.id+' ')+g.name;li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const head=document.createElement('div');head.className='head';head.append(makeMark(false));
  if(!phase){const id=document.createElement('span');id.className='id';id.textContent=g.id;head.append(id);}
  const text=document.createElement('span');text.className='text';const name=document.createElement('span');name.className='name';name.textContent=g.name;text.append(name);
  const ms=document.createElement('span');ms.className='ms';head.append(text,ms);if(!phase)head.append(hoverOf(g.id));
  const pts=document.createElement('ol');pts.className='pts';li.append(head,pts);pts.append(...(g.points??[]).map(makePoint));paint(li);if(phase)phaseName(li);return li;};
// Pick a state (F1): only after the hand-over, when the host offers tests. A picked step opens at its entry; without a step the
// test runs up to the last reachable one.
let STATES=[],sTest=null,sStep=null;
const stateDlg=$('stateDlg');
const okSteps=(test)=>test.steps.filter((step)=>step.ok);
const ownTest=()=>STATES.find((test)=>test.id===$('title').dataset.test);
const openable=()=>{const test=ownTest();for(const li of items())if(li.dataset.kind==='step')li.classList.toggle('openable',test?.steps.some((step)=>step.id===li.dataset.id&&step.ok)===true);};
const sRow=(cls,mark,name,meta,selected,disabled,sid)=>{const b=document.createElement('button');b.type='button';b.className='srow'+(cls?' '+cls:'');b.setAttribute('role','option');b.setAttribute('aria-selected',String(selected));b.disabled=disabled===true;
  const m=document.createElement('span');m.className='mk';if(mark)m.innerHTML=ICON[mark];const n=document.createElement('span');n.className='nm';
  if(sid){const s=document.createElement('span');s.className='sid';s.textContent=sid;n.append(s);}n.append(name);
  const x=document.createElement('span');x.className='meta'+(meta?.warn?' w':'');x.textContent=meta?.text??'';b.append(m,n,x);return b;};
const renderStates=()=>{
  const q=$('sq').value.trim().toLowerCase();
  const shown=STATES.filter((test)=>test.id.toLowerCase().includes(q)||test.name.toLowerCase().includes(q)||String(test.role??'').toLowerCase().includes(q));
  if(sTest!==null&&!STATES.some((test)=>test.id===sTest))sTest=null;
  $('stests').replaceChildren(...shown.map((test)=>{const row=sRow('','file',test.id,test.writes?{text:(test.role?test.role+' · ':'')+T['workbench.page.stateWrites'],warn:true}:{text:(test.role?test.role+' · ':'')+fill('workbench.page.stateCount',{count:test.steps.length})},test.id===sTest);
    row.addEventListener('click',()=>{sTest=test.id;sStep=null;renderStates();});return row;}));
  const test=STATES.find((entry)=>entry.id===sTest);
  $('sstepsHead').textContent=test?T['workbench.page.stateSteps']+' · '+test.id:T['workbench.page.stateSteps'];
  if(!test){$('ssteps').replaceChildren();$('sgo').disabled=true;$('sfoot').textContent=T['workbench.page.stateHint'];return;}
  const last=okSteps(test).at(-1);
  const all=sRow('all',sStep===null?'chev':'',fill('workbench.page.stateAll',{id:last.id}),{text:fill('workbench.page.stateCount',{count:test.steps.length})},sStep===null);
  all.addEventListener('click',()=>{sStep=null;renderStates();});
  const rows=test.steps.map((step)=>{const row=sRow('',sStep===step.id?'chev':'',step.name,step.ok?null:{text:T['workbench.page.stateWhy.'+step.why]??''},sStep===step.id,!step.ok,step.id);
    row.addEventListener('click',()=>{sStep=step.id;renderStates();});return row;});
  $('ssteps').replaceChildren(all,...rows);
  $('sgo').disabled=false;
  $('sfoot').textContent=(sStep===null?fill('workbench.page.stateFoot',{test:test.id,step:last.id}):fill('workbench.page.stateFootEntry',{test:test.id,step:sStep}))+(test.role?fill('workbench.page.stateFootRole',{role:test.role}):'')+(test.writes?T['workbench.page.stateFootWrites']:'');
};
let stateFocus=null;
// pre { step }: opened from a step's hover action, preselected on this run's test and that step (null: the whole test).
const openStates=(on=stateDlg.hidden,pre)=>{if(on&&STATES.length===0)return;
  if(on&&pre!==undefined){const test=ownTest();if(!test)return;sTest=test.id;sStep=pre.step!==null&&test.steps.some((step)=>step.id===pre.step&&step.ok)?pre.step:null;}
  stateDlg.hidden=!on;
  if(on){if(stateFocus===null)stateFocus=returnTarget();closeMenu(false);if(sTest===null&&STATES.length===1)sTest=STATES[0].id;renderStates();$('sq').focus();}else{const back=stateFocus;stateFocus=null;back?.focus?.();}};
const goState=()=>{const test=STATES.find((entry)=>entry.id===sTest);if(!test)return;openStates(false);
  try{const result=window.${STATE_BINDING}?.(test.id,sStep);result?.catch?.(()=>{});}catch{}};
$('sq').addEventListener('input',renderStates);
$('sq').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!$('sgo').disabled){event.preventDefault();goState();}});
$('scancel').addEventListener('click',()=>openStates(false));$('sclose').addEventListener('click',()=>openStates(false));$('sgo').addEventListener('click',goState);
stateDlg.addEventListener('click',(event)=>{if(event.target===stateDlg)openStates(false);});

// Settings (Ctrl+,): a view of the workbench. Only the cosmetic prefs change here, through the host (cawPref), which
// checks key and value; the rest is shown read-only.
let setFocus=null;
// Where the focus goes back to: the element that had it, or ⋯ when the menu opened the view.
const returnTarget=()=>{const active=document.activeElement;return active===null||active===document.body||$('menu').contains(active)?$('more'):active;};
const navMark=(name)=>{for(const b of document.querySelectorAll('.snav [data-sec]'))b.classList.toggle('on',b.dataset.sec===name);};
const openSettings=(on=!settingsOn(),sec='general')=>{if(on===settingsOn()){if(on)goSection(sec);return;}
  if(on){setFocus=returnTarget();closeMenu(false);}
  document.body.classList.toggle('settings-on',on);$('settings').hidden=!on;
  if(on){titleNodes=[...$('title').childNodes];$('title').textContent=T['workbench.page.settings'];}else $('title').replaceChildren(...titleNodes);
  if(on){modeMarks();goSection(sec);}else{const back=setFocus;setFocus=null;(back&&back!==document.body?back:$('more')).focus?.();}};
const goSection=(name)=>{navMark(name);const box=document.querySelector('.sin [data-sec='+name+']');
  if(name==='general'){$('scont').scrollTop=0;$('setHead').focus({preventScroll:true});}else{box?.scrollIntoView({block:'start'});box?.querySelector('h3')?.setAttribute('tabindex','-1');box?.querySelector('h3')?.focus({preventScroll:true});}};
$('setBack').addEventListener('click',()=>openSettings(false));
for(const b of document.querySelectorAll('.snav [data-sec]'))b.addEventListener('click',()=>goSection(b.dataset.sec));
$('scont').addEventListener('scroll',()=>{const top=$('scont').getBoundingClientRect().top+40;let at='general';for(const box of document.querySelectorAll('.sin [data-sec]'))if(box.getBoundingClientRect().top<=top)at=box.dataset.sec;navMark(at);},{passive:true});
for(const b of $('setMode').querySelectorAll('button'))b.addEventListener('click',()=>setMode(b.dataset.mode));
$('setStill').addEventListener('click',()=>setStill(!still()));
$('setSteps').addEventListener('click',()=>toggleFold('steps'));$('setChat').addEventListener('click',()=>toggleFold('chat'));
let shownPath='';
$('setCopy').addEventListener('click',async()=>{if(!shownPath)return;let ok=false;try{await navigator.clipboard.writeText(shownPath);ok=true;}catch{}
  if(ok){const word=$('setCopy').querySelector('span');word.textContent=T['workbench.page.setCopied'];setTimeout(()=>{word.textContent=T['workbench.page.setCopy'];},1500);}});
const lines=(count)=>count===null||count===undefined?T['workbench.page.setMissing']:count===1?T['workbench.page.setLine']:fill('workbench.page.setLines',{count});
const badge=(cls,text)=>{const b=document.createElement('span');b.className='bdg '+cls;b.textContent=text;return b;};
const code=(text)=>{const c=document.createElement('code');c.textContent=text;return c;};
// What the host passes (run.mjs, benchSettings), shown as text only.
const fillSettings=(data)=>{
  const lede=$('setLede');lede.replaceChildren(...T['workbench.page.setLede'].split('{file}').flatMap((part,i)=>i===0?[part]:[code(String(data.prefsFile??'')),part]));
  $('setLang').textContent=T['workbench.page.setLang.'+data.language?.value]??String(data.language?.value??'');
  $('setLangSrc').textContent=T['workbench.page.setSource.'+data.language?.source]??'';
  $('setToken').textContent=data.tokenNotice==='off'?T['workbench.page.setOff']:T['workbench.page.setOn'];
  $('setAgentRow').hidden=typeof data.agent!=='string';$('setAgent').textContent=data.agent??'';
  shownPath=String(data.personal?.path??'');$('setPersonalPath').textContent=shownPath;$('setPersonalLines').textContent='· '+lines(data.personal?.lines);
  $('setProjectPath').textContent=String(data.projectNotes?.path??'');$('setProjectLines').textContent='· '+lines(data.projectNotes?.lines);
  const env=data.env??{};
  const kv=(label,...values)=>{const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.append(...values);return [dt,dd];};
  const sep=()=>document.createTextNode(' · ');
  $('setRun').replaceChildren(
    ...kv(KV.project,String(data.project??''),sep(),code(String(data.config??''))),
    ...kv(KV.env,String(env.name??''),sep(),code(String(env.url??''))),
    ...kv(KV.switches,badge(env.claude?'acc':'line',T[env.claude?'workbench.page.setClaudeAllowed':'workbench.page.setNoClaude']),badge(env.writable?'pass':'warn',T[env.writable?'workbench.page.setWritable':'workbench.page.setNotWritable']),badge(env.production?'fail':'line',T[env.production?'workbench.page.setProduction':'workbench.page.setNotProduction'])),
    ...(data.role===undefined?[]:kv(KV.role,String(data.role))),
    ...kv(KV.code,String(data.code??'')),
    ...kv(KV.version,String(data.version??'')));
  // The project in the breadcrumb, and in the application bar what the environment does not allow.
  $('project').textContent=String(data.project??'');$('project').hidden=$('projectSep').hidden=!data.project;
  const envBadge=$('envBadge');envBadge.hidden=!(env.production||env.writable===false);envBadge.className='bdg '+(env.production?'fail':'warn');
  envBadge.textContent=env.production?T['workbench.page.setProduction']:T['workbench.page.setNotWritable'];};
const KV=${json({ project: t('workbench.set.kvProject'), env: t('workbench.set.kvEnv'), switches: t('workbench.set.kvSwitches'), role: t('workbench.set.kvRole'), code: t('workbench.set.kvCode'), version: t('workbench.set.kvVersion') })};

// The ⋯ menu (also Ctrl+K): arrow keys, Home, End, Enter; Esc and Tab close it, the focus returns to ⋯.
const menuBox=$('menu'),moreButton=$('more');
const menuButtons=()=>[...menuBox.querySelectorAll('.pop-i')].filter((b)=>!b.hidden&&!b.disabled);
const openMenu=()=>{if(!menuBox.hidden)return;menuLabels();menuBox.hidden=false;moreButton.setAttribute('aria-expanded','true');menuButtons()[0]?.focus();};
const closeMenu=(focus=true)=>{if(menuBox.hidden)return;menuBox.hidden=true;moreButton.setAttribute('aria-expanded','false');if(focus)moreButton.focus();};
moreButton.addEventListener('click',()=>{if(menuBox.hidden)openMenu();else closeMenu();});
menuBox.addEventListener('keydown',(event)=>{const list=menuButtons(),at=list.indexOf(document.activeElement);
  const to=(i)=>{event.preventDefault();list[(i+list.length)%list.length]?.focus();};
  if(event.key==='ArrowDown')to(at+1);else if(event.key==='ArrowUp')to(at<0?list.length-1:at-1);else if(event.key==='Home')to(0);else if(event.key==='End')to(list.length-1);
  else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu();}
  else if(event.key==='Tab')closeMenu(false);});
addEventListener('pointerdown',(event)=>{if(!menuBox.hidden&&!menuBox.contains(event.target)&&!moreButton.contains(event.target))closeMenu(false);},true);
addEventListener('blur',()=>closeMenu(false));
// Every function is a key: menu items, the status line's counts and the solo bar's way back press it.
document.addEventListener('click',(event)=>{const b=event.target.closest?.('[data-press]');if(!b||b.disabled)return;
  const inMenu=menuBox.contains(b);press(b.dataset.press);if(inMenu)closeMenu();});

// The workbench keys. F11 and F12 stay with Chrome; F5 and Ctrl+R mean refresh.
const isRefreshKey=(event)=>event.key==='F5'||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='r');
const press=(key)=>{
  if(key==='F1'){openSettings(false);openStates();return true;}
  if(key==='F5'){refresh();return true;}
  if(key==='Ctrl+,'){openSettings(true);return true;}
  if(key==='?'){openSettings(true,'keys');return true;}
  if(key==='Ctrl+K'){if(menuBox.hidden)openMenu();else closeMenu();return true;}
  if(key==='F2'||key==='F3'){openSettings(false);select(key==='F2'?'requests':'console');}else if(key==='F4')toggleFold('steps');else if(key==='F6')toggleFold('chat');
  else if(key==='F8')solo();else if(key==='F10')setStill(!still());else if(key==='F9'||key==='Escape')toChat(key);else return false;
  return true;};
addEventListener('keydown',(event)=>{
  if(isRefreshKey(event)){event.preventDefault();refresh();return;}
  const field=event.target?.closest?.('input,textarea,select');
  if(event.key==='Escape'){
    if(!menuBox.hidden){event.preventDefault();closeMenu();return;}
    if(!stateDlg.hidden){event.preventDefault();openStates(false);return;}
    if(field)return;
    if(settingsOn()){event.preventDefault();openSettings(false);return;}
    if(state.tab!==null){event.preventDefault();closeDrawer();return;}}
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&(event.key===','||event.key.toLowerCase()==='k')){event.preventDefault();press(event.key===','?'Ctrl+,':'Ctrl+K');return;}
  if(event.ctrlKey||event.altKey||event.metaKey)return;
  if(event.key==='?'){if(!field&&stateDlg.hidden){event.preventDefault();press('?');}return;}
  if(press(event.key))event.preventDefault();});
// F5 in the application or chat is reported here by its frame, and the chat also forwards its F keys. Such a message cannot trigger more.
const CHAT_KEYS=${json(CHAT_KEYS)};
addEventListener('message',(event)=>{const fromChat=event.source===chatWindow();
  if(event.data?.caw==='refresh'&&(event.source===$('app').contentWindow||fromChat))refresh();
  if(event.data?.caw==='key'&&fromChat&&CHAT_KEYS.includes(event.data.key))press(event.data.key);
  if(event.data?.caw==='key'&&event.data.key==='F1'&&event.source===$('app').contentWindow)press('F1');});

// The current item always stays in view: running, else failed, else the first open one; it sits in the upper third.
const track=$('track');let followFrame=0;
const innermost=(state)=>[...document.querySelectorAll('#steps li[data-state='+state+']')].find((li)=>!li.querySelector('li[data-state='+state+']'));
const follow=()=>{cancelAnimationFrame(followFrame);followFrame=requestAnimationFrame(()=>{
  if(track.scrollHeight<=track.clientHeight+1)return;
  const li=innermost('running')??innermost('fail')??document.querySelector('#steps li[data-state=waiting]');
  const el=li?(li.parentElement.id==='steps'?li.querySelector(':scope>.head'):li):null;
  const box=track.getBoundingClientRect();
  const top=el?track.scrollTop+el.getBoundingClientRect().top-box.top-track.clientHeight/3:track.scrollHeight;
  track.scrollTo({top:Math.max(0,Math.round(top)),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});};
new MutationObserver(follow).observe($('steps'),{subtree:true,childList:true,attributes:true,attributeFilter:['data-state']});
new ResizeObserver(follow).observe(track);
// The pinned viewport of the app frame: { width, height } or null (the frame fills its pane). The bar names its size.
let pinned=null;
const fitApp=()=>{const box=$('appBox');const app=$('app');box.classList.toggle('pinned',pinned!==null);$('vp').hidden=pinned===null;
  if(pinned===null){app.style.width=app.style.height=app.style.transform=app.style.left='';box.removeAttribute('title');return;}
  const scale=Math.min(1,box.clientWidth/pinned.width,box.clientHeight/pinned.height);
  app.style.width=pinned.width+'px';app.style.height=pinned.height+'px';app.style.transform='scale('+scale+')';
  app.style.left=Math.max(0,Math.round((box.clientWidth-pinned.width*scale)/2))+'px';
  $('vp').textContent=pinned.width+' × '+pinned.height;
  box.title=$('vp').title=fill('workbench.page.viewportPinned',{width:pinned.width,height:pinned.height,percent:Math.round(scale*100)});};
new ResizeObserver(fitApp).observe($('appBox'));
// The badge shows "Settings" while the settings page is open; the run's title waits here.
let titleNodes=[];
window.workbench={
  viewport:(size)=>{pinned=size&&size.width>0&&size.height>0?{width:Math.round(size.width),height:Math.round(size.height)}:null;fitApp();},
  // The first entry is the title: [label, sentence, badge]. The badge shows the mode only ("Claude records"), the breadcrumb
  // already names the test; the sentence is its tooltip. Without a badge it shows the sentence. The rest are the facts, shown
  // by their values in mono.
  facts:(entries)=>{const [first,...rest]=entries;const title=$('title');
    if(first){const text=String(first[1]);const nodes=[document.createTextNode(first[2]===undefined||first[2]===null?text:String(first[2]))];
      if(settingsOn())titleNodes=nodes;else title.replaceChildren(...nodes);title.title=text;}
    $('facts').replaceChildren(...rest.map(([label,value])=>{const li=document.createElement('li');li.title=label+': '+value;li.setAttribute('aria-label',label+': '+value);li.textContent=String(value);return li;}));},
  url:(url)=>{appUrl=url;$('url').textContent=$('soloUrl').textContent=url;$('url').title=url;},
  steps:(groups)=>{aborted=false;$('steps').replaceChildren(...groups.map(makeGroup));if(groups.length>0)showSteps();openable();summarize();},
  // Adds or renames a group, e.g. "Fehler klären" when Claude investigates. Existing items stay.
  group:(def)=>{const known=items().find((li)=>li.dataset.id===def.id);if(known){known.dataset.name=def.name;if(known.dataset.kind==='phase')phaseName(known);else known.querySelector(':scope>.head .name').textContent=def.name;for(const point of def.points??[])if(!pointsOf(known).some((li)=>li.dataset.id===point.id))known.querySelector(':scope>.pts').append(makePoint(point));}else $('steps').append(makeGroup(def));openable();summarize();},
  step:(id,stateName,note)=>{for(const li of items()){if(li.dataset.id===id){setState(li,stateName,note);
      if(stateName==='running'){if(!li.dataset.t0)li.dataset.t0=String(performance.now());}else if((stateName==='pass'||stateName==='fail')&&li.dataset.t0){showMs(li,performance.now()-Number(li.dataset.t0));delete li.dataset.t0;}else if(stateName==='waiting'){showMs(li);delete li.dataset.t0;}
      // The step carries its items along: passed means all ran, failed hits the running one, waiting resets all.
      for(const point of pointsOf(li)){const s=point.dataset.state;
        if(stateName==='pass'&&s!=='pass'&&s!=='fail'){setState(point,'pass');point.querySelector('.live')?.remove();}
        else if(stateName==='fail'&&s==='running'){setState(point,'fail');point.querySelector('.live')?.remove();}
        else if(stateName==='waiting'){setState(point,'waiting');showMs(point);point.querySelector('.live')?.remove();}}}
    else if(stateName==='running'&&li.dataset.state==='running'&&li.dataset.kind!=='phase')window.workbench.step(li.dataset.id,'pass');}summarize();},
  // An item of a group; unknown ones are appended. ms: duration from the host, live: what is happening, note: why it failed.
  point:(groupId,id,stateName,opts={})=>{const li=items().find((node)=>node.dataset.id===groupId);if(!li)return;
    let point=pointsOf(li).find((node)=>node.dataset.id===id);
    if(!point){point=makePoint({id,label:opts.label??'',kind:opts.kind});li.querySelector(':scope>.pts').append(point);}
    else if(opts.label!==undefined){point.querySelector('.name').textContent=opts.label;point.dataset.label=((point.dataset.kind?point.dataset.kind+' ':'')+opts.label).trim();}
    if(stateName==='running')for(const other of pointsOf(li))if(other!==point&&other.dataset.state==='running'){setState(other,'pass');other.querySelector('.live')?.remove();}
    setState(point,stateName,opts.note);
    if(opts.ms!==undefined)showMs(point,opts.ms);else if(stateName==='waiting'||stateName==='running')showMs(point);
    point.querySelector('.live')?.remove();
    if(stateName==='running'&&opts.live){const live=document.createElement('span');live.className='live';live.dataset.text=opts.live;live.textContent=liveText(opts.live);point.querySelector('.text').append(live);}
    // A phase's state follows its items.
    if(li.dataset.kind==='phase'){const states=pointsOf(li).map((node)=>node.dataset.state);
      setState(li,states.includes('fail')?'fail':states.length>0&&states.every((s)=>s==='pass')?'pass':states.some((s)=>s==='running'||s==='pass')?'running':'waiting');
      const sum=pointsOf(li).reduce((total,node)=>total+Number(node.dataset.ms||0),0);showMs(li,li.dataset.state==='pass'||li.dataset.state==='fail'?sum:undefined);}
    summarize();},
  panels:(data)=>{state.requests=data.requests;state.console=data.console;const fails=data.console.filter((c)=>c.severity==='fail').length;setCount('requests',data.requests.length);setCount('console',data.console.length,fails>0);const fresh=fails>seenFails;seenFails=fails;if(fresh&&state.tab===null)select('console');else render();},
  // Mood of the run: wait, fail, done, aborted, ask (the chat asks: it unfolds if collapsed, without changing the choice).
  mood:(value)=>{if(value==='aborted')aborted=true;else if(['wait','fail','done','ask'].includes(value))aborted=false;
    if(value==='ask'){if(!asking&&document.body.classList.contains('fold-chat'))fold('chat',false,false);asking=true;}else if(['wait','fail','done','aborted'].includes(value))asking=false;
    if(value==='fail')showSteps();summarize();},
  // The chat's state, e.g. showing: the application bar then shows that recording is on.
  chatState:(value)=>{chatState=typeof value==='string'?value:null;summarize();},
  // Application only, set by the host: automatically after the hand-over, again after a reload.
  solo:(on)=>{if(on===true)openSettings(false);showSolo(on===true);},
  // Record (Claude records or fixes), play (replay, check run, restoring a state) or pause; anything else hides the chip.
  transport:(value)=>{transport=['record','play','pause'].includes(value)?value:null;summarize();},
  // The tests from which a state can be reached here; empty hides F1 and the steps' hover action.
  states:(list)=>{STATES=Array.isArray(list)?list.filter((test)=>Array.isArray(test?.steps)&&test.steps.some((step)=>step.ok)):[];for(const b of document.querySelectorAll('[data-states]'))b.hidden=STATES.length===0;openable();if(!stateDlg.hidden)renderStates();},
  // Refresh only works if the host allows it; otherwise the menu item is locked.
  refreshable:(on)=>{refreshOn=on===true;$('reload').disabled=!refreshOn||refreshing;$('reload').title=refreshOn?REFRESH_TITLE:T['workbench.page.refreshLockedTitle'];summarize();},
  // After a reload the page is no longer reliably in the run's state; "restore state" brings it back.
  left:(on,text)=>{document.body.classList.toggle('left-state',on);const box=$('leftNote');box.hidden=!on;const title=document.createElement('strong');title.textContent=T['workbench.page.pageReloaded'];box.replaceChildren(title,text||'');summarize();},
  // What the settings page shows read-only and the breadcrumb's project (run.mjs, benchSettings).
  settings:(data)=>{if(data!==null&&typeof data==='object')fillSettings(data);},
};
// The application often assumes it is the top window (top.Ext, parent.config, top.location.href). So the workbench forwards the
// application's globals it does not have itself, and its address follows the application. The shared origin makes both possible.
const forwarded=new Set();
const appWindow=()=>{try{return $('app').contentWindow;}catch{return null;}};
const forward=()=>{const app=appWindow();if(!app)return;let names;try{names=Object.getOwnPropertyNames(app);}catch{return;}
  for(const name of names){if(forwarded.has(name)||name in window)continue;
    try{Object.defineProperty(window,name,{configurable:true,get(){try{return appWindow()?.[name];}catch{return undefined;}},set(value){try{appWindow()[name]=value;}catch{}}});forwarded.add(name);}catch{}}};
const mirror=()=>{try{const href=appWindow()?.location.href;if(href&&/^https?:/.test(href)&&href!==location.href&&new URL(href).origin===location.origin)history.replaceState(history.state,'',href);}catch{}};
$('app').addEventListener('load',()=>{forward();mirror();});
// The address follows the application's route changes (pushState) quickly and cheaply. Globals the application creates late are
// forwarded every half second: walking all names costs about a millisecond.
setInterval(mirror,400);
setInterval(forward,500);
forward();mirror();
fitSteps();addEventListener('resize',fitSteps);
foldMarks('steps',document.body.classList.contains('fold-steps'));foldMarks('chat',document.body.classList.contains('fold-chat'));
$('setStill').setAttribute('aria-checked',String(!still()));modeMarks();
summarize();${sourceTag}</script></body></html>`;
};

/**
 * Opens the workbench in the first tab and loads the application in it. Before: logged in, local code applied.
 * @param hosts  hosts whose documents may be embedded: those of the application
 * @param refuse ({ method, url, headers, postData }) => true for a top-window POST that must not be sent (see interceptDocuments)
 * @returns { page, view, show } `view` is the application in the iframe with the interface of a page
 */
export const openWorkbench = async (context, { appUrl, hosts, title = 'caw', rewrite, refuse }) => {
    const page = context.pages()[0];
    // Only the workbench itself may save and refresh, not the application in the iframe and not the chat. writePref validates the values.
    // The frame check is a mitigation, not an isolation: the application shares the workbench's origin (it must, see forward()),
    // so it or Claude's eval can call top.cawPref(...) or click the workbench's buttons and pass as the main frame. Hence the
    // bindings themselves stay harmless: settings only cosmetic ones (writePagePref), a state picked with F1 only after the human
    // confirms it in the chat, which has an opaque origin and a token the application cannot read (chat.mjs).
    let bench = benches.get(page);
    if (bench === undefined) {
        const holder = { refresh: null, rebuild: null, html: null, chat: null, app: null, navigations: new WeakMap(), fullscreen: null, state: null };
        bench = holder;
        benches.set(page, holder);
        // The workbench lives at the application's address: the tool answers only the top window's document.
        // Settings are read fresh per delivery, so a reload shows what was chosen last.
        await interceptDocuments(context, page, hosts, { workbench: (url) => holder.html(url), request: context.request, rewrite, refuse });
        await context.addInitScript(FOCUS_SCRIPT);
        await context.addInitScript(RELOAD_SCRIPT);
        // A new document in the top window is always a freshly delivered workbench: F5, the address bar button or the
        // application itself (top.location, form with target=_top). In-document navigation (replaceState) does not count.
        // This document's chat: the workbench's second iframe (after the application), created by the parser. At this point
        // the application has not run any script yet; whatever it creates or renames later is never the chat.
        page.on('domcontentloaded', () => {
            holder.chat = page.mainFrame().childFrames()[1] ?? null;
            holder.rebuild?.();
        });
        // Documents per frame. The chat frame has exactly one, the placeholder from the workbench HTML; the host writes the chat
        // into it without navigating. A second one was loaded by the page under test (chat.mjs).
        page.on('framenavigated', (frame) => {
            holder.navigations.set(frame, (holder.navigations.get(frame) ?? 0) + 1);
        });
        // The application frame: the first frame the parser attaches to each new workbench document, before any of the
        // application's scripts run. Known by identity, never by its name, which the application can change (window.name).
        // A new workbench document detaches the old frames before attaching its own.
        page.on('frameattached', (frame) => {
            if ((holder.app !== null && !holder.app.isDetached()) || frame.parentFrame() !== page.mainFrame()) return;
            holder.app = frame;
            markAppFrame(frame);
        });
        await page.exposeBinding(PREF_BINDING, ({ frame }, key, value) => {
            if (frame !== page.mainFrame()) return;
            try {
                writePagePref(key, value);
            } catch {
                // unknown or non-cosmetic setting, or not writable: keeps for this run only
            }
        });
        // Pick a state (F1): only the workbench itself. The host checks against its catalogue what may be reached (onState) and asks
        // the human in the chat before restoring (flows.mjs).
        await page.exposeBinding(STATE_BINDING, async ({ frame }, test, step) => {
            if (frame !== page.mainFrame() || holder.state === null || typeof test !== 'string') return;
            await holder.state(test, typeof step === 'string' ? step : undefined);
        });
        // Application only (F8): only the workbench itself reports it; the host remembers it for reloads.
        await page.exposeBinding(FULLSCREEN_BINDING, async ({ frame }, on) => {
            if (frame !== page.mainFrame() || holder.fullscreen === null) return;
            await holder.fullscreen(on === true);
        });
        // true: the host reloaded. false: locked, the test is running.
        await page.exposeBinding(REFRESH_BINDING, async ({ frame }) => {
            if (frame !== page.mainFrame() || holder.refresh === null) return false;
            await holder.refresh();
            return true;
        });
    }
    bench.html = (url) => workbenchHtml({ appUrl: url, title, prefs: readPrefs() });
    bench.refresh = null;
    bench.rebuild = null;
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    const frame = await (await page.waitForSelector(`iframe[name="${APP_FRAME}"]`)).contentFrame();
    await frame.waitForLoadState('load');
    const view = frameView(page, frame, () => bench.app);
    const call = (name, ...args) => page.evaluate(([fn, values]) => window.workbench?.[fn](...values), [name, args]).catch(() => {});
    // The host remembers what it has shown and restores it after a workbench reload.
    const shown = { facts: null, steps: null, states: new Map(), points: new Map(), url: null, mood: null, left: null, chatState: null, transport: null, solo: false, catalog: null, viewport: null, settings: null };
    // The host remembers solo view so it comes back after a workbench reload. The browser window stays untouched.
    bench.fullscreen = async (on) => {
        shown.solo = on;
    };
    // When an item started running: the host measures the duration so it survives a workbench reload.
    const started = new Map();
    // The step that started last: Claude's actions land there while recording.
    let runningStep = null;
    const reloads = new Set();
    let rebuilding = null;
    // If the next document arrives while restoring (F5 twice, a redirect chain via top.location), a second pass restores
    // that one too. Otherwise the chat placeholder would remain there and nobody could answer.
    let again = false;
    bench.rebuild = () => {
        if (rebuilding !== null) {
            again = true;
            return rebuilding;
        }
        rebuilding = (async () => {
            do {
                again = false;
                await restore();
            } while (again);
            rebuilding = null;
        })();
        return rebuilding;
    };
    const restore = async () => {
        try {
            await page.waitForFunction(() => window.workbench !== undefined, null, { timeout: RELOADED_MS });
            await page.waitForSelector(`iframe[name="${APP_FRAME}"]`, { timeout: RELOADED_MS });
            if (shown.facts !== null) await call('facts', shown.facts);
            if (shown.settings !== null) await call('settings', shown.settings);
            if (shown.steps !== null) await call('steps', shown.steps);
            for (const [id, [state, note]] of shown.states) await call('step', id, state, note);
            for (const [group, id, state, opts] of shown.points.values()) await call('point', group, id, state, opts);
            if (shown.url !== null) await call('url', shown.url);
            if (shown.mood !== null) await call('mood', shown.mood);
            if (shown.left !== null) await call('left', ...shown.left);
            if (shown.chatState !== null) await call('chatState', shown.chatState);
            if (shown.transport !== null) await call('transport', shown.transport);
            // Solo view survives the reload; the window is still in that mode anyway.
            if (shown.solo) await call('solo', true);
            if (shown.catalog !== null) await call('states', shown.catalog);
            if (shown.viewport !== null) await call('viewport', shown.viewport);
            await call('refreshable', bench.refresh !== null);
            // Reloaded by the human (F5, browser button) or by the application itself (top.location, form with target=_top).
            // Only the former disturbs a running test; the latter is the application's behaviour.
            // Unknown (the document is already gone, a top.location chain): the next pass decides; if there is none,
            // it does not count as human. Only reload and back_forward come from a human.
            const type = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type ?? null).catch(() => null);
            if (type === null && again) return;
            const human = type === 'reload' || type === 'back_forward';
            // The chat first, then whoever else needs to know the page is new (e.g. developing).
            for (const listener of [...reloads]) await Promise.resolve(listener({ human })).catch(() => {});
        } catch {
            // window closed or page navigated away: nothing left to restore
        }
    };
    return {
        page,
        view,
        chatFrame: () => bench.chat,
        /** How many documents the frame has had; the chat frame keeps its first one (chat.mjs). */
        chatNavigations: (chat) => bench.navigations.get(chat) ?? 0,
        facts: (items) => {
            shown.facts = items;
            return call('facts', items);
        },
        /**
         * The step list groups: { id, name, kind?: 'phase', points?: [{ id, kind, label }] }. Preparation stays in front;
         * it is shown before the run knows its steps.
         */
        steps: (steps) => {
            const prep = shown.steps?.find(({ id }) => id === PREP) ?? null;
            const kept = prep === null || steps.some(({ id }) => id === PREP) ? [] : [prep];
            shown.steps = [...kept, ...steps];
            shown.states.clear();
            for (const [key, [group]] of shown.points) if (!kept.some(({ id }) => id === group)) shown.points.delete(key);
            shown.left = null;
            return (async () => {
                await call('steps', shown.steps);
                for (const [group, id, state, opts] of shown.points.values()) await call('point', group, id, state, opts);
            })();
        },
        /** The step currently running, or null. */
        running: () => runningStep,
        /** Adds a group, e.g. "Fehler klären"; if it exists, only new items are added. */
        group: (def) => {
            const list = shown.steps ?? [];
            const at = list.findIndex(({ id }) => id === def.id);
            shown.steps = at < 0 ? [...list, def] : list.map((known, index) => (index === at ? { ...known, name: def.name, points: [...(known.points ?? []), ...(def.points ?? []).filter((point) => !(known.points ?? []).some(({ id }) => id === point.id))] } : known));
            return call('group', def);
        },
        /**
         * An item of a group. Its duration starts when it runs; passed or failed shows it.
         * @param opts { label, kind, live, note, ms }
         */
        point: (group, id, state, opts = {}) => {
            const key = `${group}|${id}`;
            const now = Date.now();
            if (state === 'running' && !started.has(key)) started.set(key, now);
            // As on the page: when an item starts, the previous running one of the same group is done.
            if (state === 'running') {
                for (const [other, entry] of shown.points) {
                    if (other === key || entry[0] !== group || entry[2] !== 'running') continue;
                    const rest = { ...entry[3] };
                    delete rest.live;
                    shown.points.set(other, [group, entry[1], 'pass', { ...rest, ...(started.has(other) ? { ms: now - started.get(other) } : {}) }]);
                    started.delete(other);
                }
            }
            const ms = opts.ms ?? ((state === 'pass' || state === 'fail') && started.has(key) ? now - started.get(key) : undefined);
            if (state !== 'running') started.delete(key);
            const merged = { ...(shown.points.get(key)?.[3] ?? {}), ...opts, ...(ms === undefined ? {} : { ms }) };
            if (state === 'running' || state === 'waiting') delete merged.ms;
            if (state !== 'running') delete merged.live;
            shown.points.set(key, [group, id, state, merged]);
            return call('point', group, id, state, merged);
        },
        step: (id, state, note) => {
            shown.states.set(id, [state, note]);
            if (state === 'running') runningStep = id;
            else if (runningStep === id) runningStep = null;
            // As on the page: the step carries its items along, so a reload shows the same.
            for (const [key, entry] of shown.points) {
                if (entry[0] !== id) continue;
                if (state === 'pass' && entry[2] !== 'pass' && entry[2] !== 'fail') shown.points.set(key, [id, entry[1], 'pass', entry[3]]);
                else if (state === 'fail' && entry[2] === 'running') shown.points.set(key, [id, entry[1], 'fail', entry[3]]);
                else if (state === 'waiting') shown.points.delete(key);
            }
            return call('step', id, state, note);
        },
        /** What the settings page shows read-only (run.mjs, benchSettings): names, flags, paths with ~, line counts. */
        settings: (data) => {
            shown.settings = data;
            return call('settings', data);
        },
        url: (url) => {
            shown.url = url;
            return call('url', url);
        },
        mood: (state) => {
            shown.mood = state;
            return call('mood', state);
        },
        /** The chat's state (running, showing, deciding ...): header and application bar show what it wants from the human. */
        chatState: (state) => {
            shown.chatState = state;
            return call('chatState', state);
        },
        /** The chip at the top right while something runs: 'record', 'play' or null (nothing runs). Pausing (F9) shows pause on its own. */
        transport: (kind) => {
            shown.transport = kind;
            return call('transport', kind);
        },
        /** The page is no longer reliably in the run's state (true, with text) or back in it (false). */
        left: (on, text = '') => {
            shown.left = on ? [true, text] : null;
            return call('left', on, text);
        },
        /** Who performs refresh; null: locked, the test is running. */
        onRefresh: (handler) => {
            bench.refresh = handler ?? null;
            return call('refreshable', bench.refresh !== null);
        },
        /** The tests for F1, from states.mjs (stateCatalog). */
        states: (catalog) => {
            shown.catalog = catalog;
            return call('states', catalog);
        },
        /**
         * Who reaches a state picked with F1: (test, step | undefined, { name, role, until }); null: off. A picked step means its
         * entry; without one `until` is the last reachable step, the end of the whole test. Only tests and reachable steps from the
         * catalogue get through, so the question in the chat never shows text from the page.
         */
        onState: (handler) => {
            bench.state = typeof handler !== 'function' ? null : (test, step) => {
                const entry = shown.catalog?.find(({ id }) => id === test);
                const reachable = entry?.steps.filter(({ ok }) => ok) ?? [];
                if (reachable.length === 0 || (step !== undefined && !reachable.some(({ id }) => id === step))) return undefined;
                return handler(test, step, { name: entry.name, role: entry.role, ...(step === undefined ? { until: reachable.at(-1).id } : {}) });
            };
        },
        /** The app frame at exactly this CSS size, scaled down to fit (OPEN-15); null lets it fill its pane again. */
        viewport: (size) => {
            shown.viewport = size ?? null;
            return call('viewport', shown.viewport);
        },
        /** Application only (F8) on or off, e.g. automatically after the hand-over for developing. The window stays as it is. */
        solo: async (on) => {
            await bench.fullscreen(on === true);
            await call('solo', on === true);
        },
        /** The chat needs a decision: App only hides it, so bring steps and chat back. Nothing happens otherwise. */
        showChat: async () => {
            if (!shown.solo) return;
            await bench.fullscreen(false);
            await call('solo', false);
        },
        /**
         * After a reload of the whole workbench, once steps and counters are back. The listener gets { human }: true for
         * the human's F5 or back, false if the application navigated the top window itself. @returns an unsubscribe function
         */
        onReload: (listener) => {
            reloads.add(listener);
            return () => reloads.delete(listener);
        },
        panels: (data) => call('panels', { requests: data.requests.slice(-MAX_ROWS), console: data.console.slice(-MAX_ROWS) }),
        PANEL_MS,
    };
};
