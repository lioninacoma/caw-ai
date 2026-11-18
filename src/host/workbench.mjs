// The workbench: one page for the whole run. Left the steps with their marks, in the middle the application iframe with
// requests and console below, right the chat. F keys at the bottom. The chat is a document of its own (srcdoc); its page is
// the one from chat.mjs.
//
// The look is Graphite (style.mjs) in the personal mode (system, light or dark). F8 shows only the application, F10 stops
// all animation.
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
// effect after the hand-over.

import { APP_FRAME, CHAT_FRAME_NAME, FOCUS_SCRIPT, RELOAD_SCRIPT, frameView, interceptDocuments, sourceTag } from './app-view.mjs';
import { markAppFrame } from './host-lock.mjs';
import { language, t, texts } from '../shared/i18n.mjs';
import { LONG_NAME } from '../shared/brand.mjs';
import { readPrefs, writePagePref } from '../shared/prefs.mjs';
import { BASE_CSS, FAVICON, MODE_SCRIPT, icon, logo, modeAttr, styleSheet, tokenCss } from './style.mjs';

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
/** Keys the chat may pass on to the workbench. A message from the chat cannot trigger more. */
export const CHAT_KEYS = ['F1', 'F2', 'F3', 'F4', 'F6', 'F8', 'F10'];
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
/** The placeholder in the chat frame until the chat arrives. In the current language and mode, so built on use; one line
 * of text, so without the fonts. */
const chatPlaceholder = (mode) => `<!doctype html><html lang="${language()}"${modeAttr(mode)}><meta charset="utf-8"><title>${t('workbench.chat')}</title><script>${MODE_SCRIPT}${sourceTag}</script><style>${tokenCss()}${BASE_CSS}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--panel);color:var(--muted)}
p{flex:1;display:grid;place-items:center;margin:0;padding:24px;text-align:center;font-size:13px}</style>
<p>${t('workbench.chatPlaceholder')}</p></html>`;

/**
 * The workbench page. `appUrl` loads the iframe; the host sets everything else via `window.workbench`.
 * @param prefs   personal settings: animations 'on' | 'off', steps and chat 'open' | 'closed', mode 'system' | 'light' | 'dark'
 */
export const workbenchHtml = ({ appUrl, title, prefs = {} }) => {
    const still = prefs.animations === 'off';
    const classes = [still ? 'still' : '', prefs.steps === 'closed' ? 'fold-steps' : '', prefs.chat === 'closed' ? 'fold-chat' : ''].filter(Boolean).join(' ');
    const refreshTitle = t('workbench.refreshTitle');
    const test = String(title ?? '').replace(/^caw\s*·?\s*/, '');
    const key = (name, label, attrs = '', cls = '') => `<button type="button" class="fk${cls}"${attrs}><b>${name}</b>${label}</button>`;
    const head = (label) => `<h2 class="pane-t">${esc(label)}</h2>`;
    return `<!doctype html><html lang="${language()}"${modeAttr(prefs.mode)}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><script>${MODE_SCRIPT}</script>${FAVICON}<style>
${styleSheet()}
html,body{height:100%;margin:0}
body{background:var(--bg)}
.pa{height:100vh;display:flex}
#bench{flex:1;min-width:0;display:flex;flex-direction:column}
.top{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;min-height:48px;padding:6px 16px;background:var(--nav);color:var(--nav-text);border-bottom:1px solid var(--nav-line)}
/* The product (logo, caw, its long name) and next to it the title sentence of the run. */
.brand{flex:none;display:flex;align-items:center;gap:10px}.brand .name{display:flex;flex-direction:column;gap:2px}.brand .name b{font:600 18px/1 var(--font);letter-spacing:-.04em}.brand .name>span{color:var(--nav-muted);font-size:11px}
.top .id{display:flex;flex-direction:column;gap:2px;min-width:0;padding-left:16px;border-left:1px solid var(--line)}
.top .id b{font:500 14px/1.2 var(--font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top .id b .cmd{color:var(--muted);font-weight:400}
.facts{display:flex;gap:4px 16px;flex-wrap:wrap;font-size:12px;color:var(--nav-muted);margin:0;padding:0;list-style:none;min-width:0;flex:1 1 220px}
.facts li{white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.facts b{color:var(--nav-text);font-weight:500;margin-left:6px}
.tools{margin-left:auto;display:flex;align-items:center;gap:10px}
#state{display:none}#state.on{display:inline-flex}
#stateSpin{color:var(--run)}#stateSpin.claude{color:var(--claude)}#stateSpin[hidden]{display:none}
#notice{font-size:12px;color:var(--warn)}#notice[hidden]{display:none}
.panes{flex:1;min-height:0;display:grid;gap:0;
--col-steps:minmax(270px,320px);--col-chat:minmax(300px,380px);grid-template-columns:var(--col-steps) minmax(0,1fr) var(--col-chat);grid-template-rows:minmax(0,1fr);
grid-template-areas:"steps browser chat"}
.win{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--panel)}
.win+.win{border-left:1px solid var(--line)}
.pane-t{margin:0;display:flex;align-items:center;height:44px;padding:0 14px;flex:none;font:500 13px/1 var(--font);color:var(--text);border-bottom:1px solid var(--line)}
.pa-steps{grid-area:steps}
.pa-browser{grid-area:browser}
.pa-chat{grid-area:chat}
.fold{position:absolute;top:7px;right:8px;z-index:3}
.strip{display:none;border:0;cursor:pointer;background:none;color:var(--muted);font:500 12px/1 var(--font);writing-mode:vertical-rl;padding:12px 0;align-items:center;gap:10px;width:100%;height:100%}
.strip:hover{color:var(--text);background:var(--panel2)}
#gauge{display:flex;gap:3px;align-items:center;margin:10px 14px 2px;font:400 11px/1 var(--font-mono);color:var(--faint)}#gauge:empty{display:none}
#gauge i{flex:1;height:4px;border-radius:2px;background:var(--line)}#gauge i.mk-ok{background:var(--pass)}#gauge i.mk-fail{background:var(--fail)}#gauge i.mk-run{background:var(--run)}
#gauge span{margin-left:6px}
.left-state #steps,.left-state #gauge{opacity:.45}
#leftNote{margin:8px 14px;padding:8px 10px;font-size:12.5px;line-height:1.45;color:var(--muted);background:var(--warn-soft);border-radius:var(--r1)}#leftNote[hidden]{display:none}
#leftNote strong{display:block;margin-bottom:3px;font-weight:600;color:var(--warn)}
.hint{margin:10px 14px;font-size:12px;color:var(--faint)}#stepsHint[hidden]{display:none}
/* The list scrolls by itself with the current item, hence no scrollbar. The mouse wheel still works. */
#track{flex:1;min-height:0;overflow:auto;scrollbar-width:none;padding:6px 0 10px}#track::-webkit-scrollbar{display:none}
#steps,#steps .pts{list-style:none;margin:0;padding:0}
#steps .head{display:grid;grid-template-columns:18px auto minmax(0,1fr) auto;gap:9px;align-items:baseline;padding:5px 14px}
#steps .id{font:500 11px/1 var(--font-mono);color:var(--faint)}
#steps .text{min-width:0}
#steps .head .name{font-weight:500;overflow-wrap:anywhere}
#steps .ms{font:400 11px/1 var(--font-mono);color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
#steps .note{font-size:12px;line-height:1.35;color:var(--fail);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
#steps>li[data-state=running]>.head .name{color:var(--run)}
#steps>li[data-state=fail]>.head .name{color:var(--fail)}
#steps>li[data-state=waiting]>.head .name,#steps>li[data-state=skipped]>.head .name{color:var(--muted)}
#steps>li[data-state=skipped]>.head .text::after{content:${JSON.stringify(t('workbench.page.skipped'))};display:block;font-size:11.5px;color:var(--faint)}
/* Phases (preparation, wrap-up, investigate failure) are group headings, their items below with their own mark. */
#steps>li[data-kind=phase]>.head{grid-template-columns:minmax(0,1fr) auto;padding-top:14px}
#steps>li[data-kind=phase]>.head>.st{display:none}
#steps>li[data-kind=phase]>.head .name,#steps>li[data-kind=section]>.head .name{font:500 12px/1.2 var(--font);color:var(--faint);white-space:nowrap;overflow:hidden;display:block}
#steps>li[data-kind=phase][data-state=fail]>.head .name{color:var(--fail)}
/* The heading of the test's steps, between preparation and wrap-up: a heading like a phase, but no group of its own. */
#steps>li[data-kind=section]>.head{grid-template-columns:minmax(0,1fr) auto;padding-top:14px}
.pts>li{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:6px;align-items:baseline;padding:3px 14px 3px 0;font:400 12px/1.4 var(--font-mono);color:var(--muted)}
#steps>li[data-kind=step]>.pts>li{padding-left:36px}
.pts .tree{color:var(--faint)}
#steps>li[data-kind=phase]>.pts>li{grid-template-columns:18px minmax(0,1fr) auto;gap:9px;padding-left:14px;font:400 13px/1.4 var(--font);color:var(--text)}
#steps>li[data-kind=phase] .tree,#steps>li[data-kind=phase] .mk,#steps>li[data-kind=step] .pt-tag{display:none}
/* The marks: an icon per state, a spinner while running. */
.st{display:inline-grid;place-items:center;width:18px}
.tag{display:inline-grid;place-items:center;width:18px;height:18px}.tag .i{width:14px;height:14px;stroke-width:2.2}
.tag-ok,.mk-ok{color:var(--pass)}.tag-fail,.mk-fail{color:var(--fail)}.tag-run,.mk-run{color:var(--run)}.tag-open,.mk-open{color:var(--faint)}
.pts .text{overflow-wrap:anywhere}
.pts .kind{color:var(--claude);margin-right:6px}
.pts>li[data-state=running] .text{color:var(--run)}.pts>li[data-state=fail] .text{color:var(--fail)}
.pts>li[data-state=waiting] .text,#steps>li[data-state=skipped] .pts .text{color:var(--faint)}
.pts .live{display:block;font-size:11px;color:var(--run)}
.bad{color:var(--fail)!important}
.appbar{flex:none;display:flex;gap:10px;align-items:center;height:44px;padding:0 14px;font-size:12px;white-space:nowrap;overflow:hidden;border-bottom:1px solid var(--line)}
#urlMark{color:var(--pass)}
#url{color:var(--muted);font:400 12px/1 var(--font-mono);overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
#browserState{font:600 10.5px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--run)}
#browserState.rec{color:var(--fail)}#browserState.ask{color:var(--warn)}
.solo-btn b{font:500 10.5px/1 var(--font-mono);color:var(--muted)}
#appBox{flex:1;min-height:0;display:flex;position:relative;overflow:hidden}
#app{flex:1;min-height:0;width:100%;border:0;display:block;background:#fff}
/* A pinned viewport: the frame has exactly the recorded size, scaled down (never up) to fit, centred. */
#appBox.pinned{background:var(--sunk)}#appBox.pinned #app{flex:none;position:absolute;top:0;transform-origin:0 0}
.drawer{flex:none;border-top:1px solid var(--line)}
.tabs{display:flex;align-items:center;gap:16px;height:34px;padding:0 14px}
.tabs button{font:400 12px/1 var(--font);color:var(--muted);background:none;border:0;padding:0;height:100%;cursor:pointer}
.tabs button:hover{color:var(--text)}
.tabs button[aria-selected=true]{color:var(--text);font-weight:600;box-shadow:inset 0 -2px 0 var(--accent)}
.tabs .count{margin-left:6px;font:500 11px/1 var(--font-mono);color:var(--accent-text)}.tabs .count.bad{color:var(--fail)}
.tabs #drawerClose{display:none;margin-left:auto}.drawer.open #drawerClose{display:inline-flex;align-items:center;gap:4px}
.panel{display:none;height:26vh;min-height:110px;overflow:auto;border-top:1px solid var(--line);background:var(--panel)}.drawer.open .panel{display:block}
table{width:100%;border-collapse:collapse;font:400 11.5px/1.3 var(--font-mono)}
td{padding:6px 14px;border-top:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}
tr:first-child td{border-top:0}
td.name{width:60%;color:var(--text)}td.ok{color:var(--pass)}td.bad{color:var(--fail)}td.open{color:var(--muted)}td.ms{text-align:right;color:var(--faint);width:90px}
.empty{padding:10px 14px;color:var(--muted);font:12px var(--font-mono)}
.line{padding:4px 14px;border-top:1px solid var(--line);font:11.5px/1.45 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}.line:first-child{border-top:0}.line.fail{color:var(--fail)}.line.warn{color:var(--warn)}
#chat{flex:1;width:100%;min-height:0;border:0;display:block;background:var(--panel)}
.fkeys{flex:none;display:flex;flex-wrap:wrap;gap:6px 16px;border-top:1px solid var(--line);padding:8px 16px;font-size:12px;color:var(--muted);background:var(--panel)}
.fk{white-space:nowrap;background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit;display:inline-flex;align-items:center;gap:6px}.fk:hover:enabled{color:var(--text)}
.fk b{font:500 10.5px/1 var(--font-mono);padding:3px 5px;border-radius:var(--r1);border:1px solid var(--line2);background:var(--panel2);color:var(--muted)}
.fk.x b{color:var(--fail)}.fk:disabled{opacity:.45;cursor:not-allowed}.fk[aria-pressed=true]{color:var(--text)}.fk[aria-pressed=true] b{border-color:var(--accent);color:var(--accent-text)}
/* Application only (F8): header, steps, chat, bar and requests/console hidden; one line stays for the way back. */
.soloBar{display:none;align-items:center;gap:14px;padding:6px 14px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;background:var(--nav);border-bottom:1px solid var(--line)}
.soloBar .logo{color:var(--text)}#soloTag{color:var(--pass)}#soloTag[hidden]{display:none}
#soloUrl{font:12px var(--font-mono);overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.solo .soloBar{display:flex}
.solo .top,.solo .pa-steps,.solo .pa-chat,.solo .fkeys,.solo .pa-browser>.pane-t,.solo .appbar,.solo .drawer{display:none}
.solo .panes{grid-template-columns:minmax(0,1fr);grid-template-areas:"browser"}
.solo .pa-browser{border:0}
/* Pick a state (F1): tests on the left, their steps on the right, run at the bottom. Also in solo view. */
#stateDlg{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:var(--overlay)}#stateDlg[hidden]{display:none}
#stateDlg>.dlg{width:min(900px,calc(100vw - 32px));height:min(620px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line2);border-radius:var(--r3);box-shadow:var(--shadow-lg);overflow:hidden}
#stateDlg .pane-t{font-size:15px;font-weight:600}
.scols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);flex:1;min-height:0}
.scol{display:flex;flex-direction:column;min-height:0;min-width:0;padding:14px;gap:6px}.scol+.scol{border-left:1px solid var(--line)}
.sec{font:600 10.5px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:4px 0}
.sfilter{margin-bottom:6px}
.slist{overflow:auto;display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
.srow{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;border:0;border-radius:var(--r1);background:none;cursor:pointer;padding:7px 8px;width:100%;color:var(--text);font-size:13px}
.srow:hover:enabled{background:var(--panel2)}.srow:disabled{cursor:not-allowed;color:var(--faint)}
.srow[aria-selected=true]{background:var(--accent-soft)}
.srow .mk{font:400 12px/1 var(--font-mono);color:var(--faint)}.srow[aria-selected=true] .mk{color:var(--accent-text)}
.srow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .meta{font-size:11px;color:var(--faint);white-space:nowrap}.srow .meta.w{color:var(--warn)}
.srow.all .nm{color:var(--accent-text)}
.sfoot{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:12px 16px;background:var(--panel2)}
.sfoot p{margin:0;font-size:12px;color:var(--muted);min-width:0;flex:1 1 300px}
.sfoot .acts{display:flex;gap:8px}
.fk[hidden],.solo-btn[hidden]{display:none}
@media (max-width:859px){.scols{grid-template-columns:minmax(0,1fr)}.scol+.scol{border-left:0;border-top:1px solid var(--line)}}
/* Three columns from 1000px; narrower sides up to 1500px so the application keeps its desktop layout. */
@media (min-width:1000px) and (max-width:1499px){.panes{--col-steps:minmax(220px,260px);--col-chat:minmax(280px,330px)}}
@media (min-width:1000px){
.fold-steps .panes{--col-steps:44px}.fold-chat .panes{--col-chat:44px}
.fold-steps .pa-steps>:not(#stepsStrip),.fold-chat .pa-chat>:not(#chatStrip){display:none}
.fold-steps #stepsStrip,.fold-chat #chatStrip{display:flex}}
@media (max-width:999px){
.fold{display:none}
.pa{height:auto;min-height:100vh}
.panes{grid-template-columns:minmax(300px,380px) minmax(0,1fr);grid-template-rows:auto minmax(60vh,1fr);grid-template-areas:"steps browser" "chat browser"}
.pa-steps{max-height:40vh}}
@media (max-width:859px){
.panes{grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-template-areas:"steps" "chat" "browser"}
.pa-steps{max-height:none}#track{overflow:visible}.pa-chat{height:72vh}.pa-browser{height:78vh}.tools{margin-left:0}}
/* Record, play, pause: the transport chip at the top right next to the status pill (.tp). */
#transport{display:none}#transport.on{display:inline-flex}
</style></head><body class="${classes}"><div class="pa"><div id="bench">
<div class="soloBar">${logo({ size: 18, label: 'caw' })}<span id="soloTag" hidden>${esc(t('workbench.handedOver'))}</span><span id="soloState"></span><span id="soloUrl"></span><button class="solo-btn btn btn-s btn-sm" type="button" data-states hidden><b>F1</b>${t('workbench.stateTitle')}</button><button class="solo-btn btn btn-s btn-sm" type="button" data-solo><b>F8</b>${t('workbench.bench')}</button></div>
<header class="top"><div class="brand">${logo({ size: 28, label: 'caw' })}<div class="name"><b>caw</b><span>${LONG_NAME}</span></div></div><div class="id"><b id="title" data-test="${esc(test)}">${esc(test || 'caw')}</b></div>
<ul class="facts" id="facts" aria-label="${t('workbench.runFacts')}"></ul>
<div class="tools"><span id="notice" role="status" hidden></span><span id="stateSpin" class="spinner" aria-hidden="true" hidden></span><span id="state" class="pill" role="status"></span><span id="transport" class="tp" role="img"><i></i><span></span></span></div></header>
<main class="panes">
<section class="pa-steps win" id="stepsCard" aria-label="${t('workbench.steps')}">${head(t('workbench.steps'))}<button class="fold ib" id="stepsFold" type="button" aria-expanded="true" aria-label="${t('workbench.stepsFold')}" title="${t('workbench.stepsFold')} (F4)">${icon('chev-l')}</button><button class="strip" id="stepsStrip" type="button" aria-expanded="false" aria-label="${t('workbench.stepsUnfold')}" title="${t('workbench.stepsUnfold')} (F4)">${icon('chev-r')}${t('workbench.steps')} <span id="stripTally"></span></button>
<div class="gauge" id="gauge" aria-hidden="true"></div><span id="tally" hidden></span><p id="leftNote" hidden></p><p class="hint" id="stepsHint">${t('workbench.stepsHint')}</p><div id="track"><ol id="steps" aria-label="${t('workbench.steps')}"></ol></div></section>
<section class="pa-browser win" aria-label="${t('workbench.app')}"><div class="appbar"><span id="urlMark" aria-hidden="true">${icon('lock')}</span><span id="url"></span><span id="browserState"></span><button class="solo-btn btn btn-s btn-sm" type="button" data-solo title="${t('workbench.soloTitle')}"><b>F8</b>${t('workbench.solo')}</button></div>
<div id="appBox"><iframe id="app" name="${APP_FRAME}" title="${t('workbench.app')}" src="${esc(appUrl)}" allow="clipboard-write"></iframe></div>
<div class="drawer" id="drawer"><div class="tabs" role="tablist"><button type="button" role="tab" data-tab="requests" aria-selected="false">${t('workbench.requests')}<span class="count" data-count="requests">0</span></button><button type="button" role="tab" data-tab="console" aria-selected="false">${t('workbench.console')}<span class="count" data-count="console">0</span></button><button type="button" id="drawerClose" aria-label="${t('workbench.drawerCloseLabel')}" title="${t('workbench.collapse')}">${icon('chev-d')}${t('workbench.collapse')}</button></div>
<div class="panel" id="panel"></div></div></section>
<section class="pa-chat win" id="chatCard" aria-label="${t('workbench.chatLabel')}">${head(t('workbench.chat'))}<button class="fold ib" id="chatFold" type="button" aria-expanded="true" aria-label="${t('workbench.chatFold')}" title="${t('workbench.chatFold')} (F6)">${icon('chev-r')}</button><button class="strip" id="chatStrip" type="button" aria-expanded="false" aria-label="${t('workbench.chatUnfold')}" title="${t('workbench.chatUnfold')} (F6)">${icon('chev-l')}${t('workbench.chat')}</button><iframe id="chat" name="${CHAT_FRAME}" title="${t('workbench.chatLabel')}" sandbox="${CHAT_SANDBOX}" allow="clipboard-write" srcdoc="${esc(chatPlaceholder(prefs.mode))}"></iframe></section>
</main>
<nav class="fkeys" aria-label="${t('workbench.keys')}">${key('F1', t('workbench.stateTitle'), ' data-states hidden')}${key('F5', t('workbench.keyReload'), ` id="reload" disabled title="${t('workbench.page.refreshLockedTitle')}"`)}${key('F9', t('workbench.keyPause'), ' data-key="F9"')}${key('Esc', t('workbench.keyAbort'), ' data-key="Escape"', ' x')}${key('F2', t('workbench.requests'), ' data-tabkey="requests"')}${key('F3', t('workbench.console'), ' data-tabkey="console"')}${key('F4', t('workbench.steps'), ' id="fSteps"')}${key('F6', t('workbench.chat'), ' id="fChat"')}${key('F8', t('workbench.solo'), ' data-solo')}${key('F10', t('workbench.still'), ` id="still" aria-pressed="${still}" title="${t('workbench.stillTitle')}"`)}</nav>
</div></div>
<div id="stateDlg" hidden role="dialog" aria-modal="true" aria-label="${t('workbench.stateTitle')}"><div class="dlg">${head(t('workbench.stateTitle'))}
<div class="scols"><div class="scol"><div class="sec">${t('workbench.page.stateTest')}</div><label class="field sfilter">${icon('search')}<input id="sq" type="search" autocomplete="off" spellcheck="false" placeholder="${t('workbench.page.stateSearch')}" aria-label="${t('workbench.page.stateSearch')}"></label><div class="slist" id="stests" role="listbox" aria-label="${t('workbench.page.stateTest')}"></div></div>
<div class="scol"><div class="sec" id="sstepsHead">${t('workbench.page.stateSteps')}</div><div class="slist" id="ssteps" role="listbox" aria-label="${t('workbench.page.stateSteps')}"></div></div></div>
<div class="sfoot"><p id="sfoot"></p><div class="acts"><button type="button" class="btn btn-s" id="scancel">${t('workbench.page.stateCancel')}</button><button type="button" class="btn btn-p" id="sgo" disabled>${t('workbench.page.stateGo')}</button></div></div></div></div>
<script>
const T=${json(texts('workbench.page.'))};
// The pill labels: the same as in the chat header.
const PILL=${json(Object.fromEntries(Object.entries(texts('chat.status.')).filter(([name]) => name.endsWith('.label'))))};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]??key);
const $=(id)=>document.getElementById(id);
const state={tab:null,requests:[],console:[]};
const LABELS={waiting:T['workbench.page.waiting'],running:T['workbench.page.running'],pass:T['workbench.page.pass'],fail:T['workbench.page.fail'],skipped:T['workbench.page.skipped']};
// The groups of the list; the section heading above the steps is no group.
const items=()=>[...$('steps').children].filter((li)=>li.dataset.kind!=='section');
// Only the test's steps are counted; preparation, wrap-up and investigate failure are phases.
const stepItems=()=>items().filter((li)=>li.dataset.kind!=='phase');
const pointsOf=(li)=>[...li.querySelector(':scope>.pts').children];
const groupOf=(spot)=>spot.closest('#steps>li');
// Group or item, even before the node is in the list.
const isGroup=(node)=>node.querySelector(':scope>.head')!==null;
const groupTitle=(li)=>li.dataset.kind==='phase'?li.dataset.name:li.dataset.id;
const duration=(ms)=>ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(1).replace('.',T['workbench.page.decimal'])+' s';
const cell=(text,cls)=>{const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;td.title=text;return td;};
const still=()=>document.body.classList.contains('still');
// The marks as icons; running is a CSS spinner.
const ICON=${json({ ok: icon('check'), fail: icon('x'), open: icon('circle') })};
const markInto=(el,kind)=>{if(kind==='run'){const s=document.createElement('span');s.className='spinner';el.replaceChildren(s);}else el.innerHTML=ICON[kind]??ICON.open;};
const render=()=>{
  const panel=$('panel');panel.replaceChildren();
  if(state.tab==='requests'){
    if(state.requests.length===0){panel.innerHTML='<div class="empty">'+T['workbench.page.noRequests']+'</div>';return;}
    const table=document.createElement('table');
    for(const r of state.requests.slice().reverse()){const tr=document.createElement('tr');const cls=r.outcome==='ok'?'ok':r.outcome==='open'?'open':'bad';tr.append(cell(r.name,'name'),cell(r.result,cls),cell(r.ms===undefined?'':Math.round(r.ms)+' ms','ms'));table.append(tr);}
    panel.append(table);
  }else if(state.tab==='console'){
    if(state.console.length===0){panel.innerHTML='<div class="empty">'+T['workbench.page.noConsole']+'</div>';return;}
    for(const c of state.console.slice().reverse()){const div=document.createElement('div');div.className='line '+c.severity;div.textContent=c.text;panel.append(div);}
  }
};
const select=(tab)=>{state.tab=state.tab===tab?null:tab;try{sessionStorage.setItem('caw-bench-tab',state.tab??'');}catch{}$('drawer').classList.toggle('open',state.tab!==null);for(const b of document.querySelectorAll('[data-tab]'))b.setAttribute('aria-selected',String(b.dataset.tab===state.tab));render();};
// The console only opens by itself on new errors; only the human closes it.
let seenFails=0;
for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>select(b.dataset.tab));
// The open tab stays open after a workbench reload.
try{const tab=sessionStorage.getItem('caw-bench-tab');if(tab==='requests'||tab==='console')select(tab);}catch{}
for(const b of document.querySelectorAll('[data-tabkey]'))b.addEventListener('click',()=>select(b.dataset.tabkey));
$('drawerClose').addEventListener('click',()=>{if(state.tab!==null)select(state.tab);});
const setCount=(name,value,bad)=>{for(const node of document.querySelectorAll('[data-count='+name+']')){node.textContent=(bad===true?'✕ ':'')+value;node.classList.toggle('bad',bad===true);}};
let aborted=false;
// What the run does, for the chip at the top right: record, play, pause or null (no chip). Set by the host.
let transport=null;
// What the chat currently wants: ask from the mood, plus its state (showing: the human is demonstrating).
let asking=false,chatState=null;
const stepsHintText=$('stepsHint').textContent;
// Progress as a bar: one cell per step, passed, running, failed or open, and the count.
const gauge=(list)=>{const box=$('gauge');if(list.length===0){box.replaceChildren();return;}
  const pass=list.filter((li)=>li.dataset.state==='pass').length;
  const parts=list.map((li)=>{const s=li.dataset.state;const cell=document.createElement('i');cell.className=s==='pass'?'mk-ok':s==='fail'?'mk-fail':s==='running'?'mk-run':'mk-open';return cell;});
  const sum=document.createElement('span');sum.textContent=pass+'/'+list.length;box.replaceChildren(...parts,sum);};
// Tree glyphs of the sub-items: the last one ends the branch.
const trees=()=>{for(const ol of document.querySelectorAll('#steps .pts')){const all=[...ol.children];all.forEach((li,i)=>{li.querySelector(':scope>.tree').textContent=i===all.length-1?'└':'├';});}};
// Header, progress and counter follow the steps: what runs, what failed, how many passed.
// One heading "Run" right before the first step, none without steps.
const section=()=>{const list=$('steps'),first=items().find((li)=>li.dataset.kind==='step');let sec=[...list.children].find((li)=>li.dataset.kind==='section');
  if(!first){sec?.remove();return;}
  if(!sec){sec=document.createElement('li');sec.dataset.kind='section';sec.setAttribute('role','presentation');const head=document.createElement('div');head.className='head';const name=document.createElement('span');name.className='name';const ms=document.createElement('span');ms.className='ms';head.append(name,ms);sec.append(head);}
  sec.querySelector('.name').textContent=T['workbench.page.runSection'];
  // Total time like the phases: the measured steps, once none is running any more.
  const steps=items().filter((li)=>li.dataset.kind==='step'),timed=steps.filter((li)=>li.dataset.ms!==undefined);
  sec.querySelector('.ms').textContent=timed.length>0&&!steps.some((li)=>li.dataset.state==='running')?duration(timed.reduce((total,li)=>total+Number(li.dataset.ms),0)):'';
  if(sec.nextElementSibling!==first)list.insertBefore(sec,first);};
const summarize=()=>{
  section();
  const list=stepItems(),n=list.length,all=items();
  $('stepsHint').hidden=all.length>0;$('stepsHint').textContent=chatState==='showing'?T['workbench.page.stepsHintShowing']:stepsHintText;
  const count=(name)=>list.filter((li)=>li.dataset.state===name).length;
  const pass=count('pass');
  $('tally').textContent=$('stripTally').textContent=n===0?'':pass+'/'+n;
  gauge(list);trees();
  const failed=all.find((li)=>li.dataset.state==='fail'),running=list.find((li)=>li.dataset.state==='running')??all.find((li)=>li.dataset.state==='running');
  const [kind,text,browser]=aborted?['fail',T['workbench.page.aborted'],T['workbench.page.aborted']]:failed?['fail',fill('workbench.page.groupFailed',{id:groupTitle(failed)}),T['workbench.page.browserFailed']]:running?['run',fill('workbench.page.groupRunning',{id:groupTitle(running)}),T['workbench.page.browserRunning']]:n>0&&pass===n?['ok',T['workbench.page.allPassed'],T['workbench.page.browserPassed']]:pass>0?(document.body.classList.contains('left-state')?['',fill('workbench.page.left',{id:list.filter((li)=>li.dataset.state==='pass').at(-1).dataset.id}),T['workbench.page.browserReloaded']]:['ok',fill('workbench.page.reached',{id:list.filter((li)=>li.dataset.state==='pass').at(-1).dataset.id}),T['workbench.page.ready']]):n>0?['',T['workbench.page.ready'],T['workbench.page.ready']]:[null,'',''];
  let [browserText,tone]=[browser,''];
  // If the chat waits for the human, the application bar says so; the pill does not, the chat already does.
  if(!aborted&&asking){browserText=T['workbench.page.browserYourTurn'];tone='ask';}
  if(!aborted&&chatState==='showing'){browserText=T['workbench.page.recording'];tone='rec';}
  // The pill top right: only the four chat header labels (Claude working, caw working, pausing …, paused), no step.
  // States without a label show no pill. The step list shows the current step.
  const label=aborted||chatState===null?undefined:PILL['chat.status.'+chatState+'.label'];
  const claudeWorks=chatState==='running'||chatState==='advising',cawWorks=label!==undefined&&!claudeWorks&&chatState!=='pausing'&&chatState!=='paused';
  const pill=$('state');pill.className='pill'+(label===undefined?'':' on')+(claudeWorks?' claude':cawWorks?' run':chatState==='paused'||chatState==='pausing'?' turn':'');pill.dataset.state=chatState??'';
  if(label===undefined)pill.replaceChildren();else{const dot=document.createElement('span');dot.className='dot';pill.replaceChildren(dot,label);}
  $('stateSpin').hidden=!(claudeWorks||cawWorks);$('stateSpin').classList.toggle('claude',claudeWorks);
  $('browserState').textContent=browserText;$('browserState').className=tone;
  $('soloState').textContent=text;$('soloTag').hidden=!refreshOn;
  // Only while something runs: record or play from the host, pause while that run is paused (F9). Cancelled: nothing.
  const mode=transport===null||aborted?null:chatState==='paused'||chatState==='pausing'?'pause':transport;
  const chip=$('transport'),name=mode===null?'':mode[0].toUpperCase()+mode.slice(1);chip.className='tp'+(mode===null?'':' on '+({record:'rec',play:'play',pause:'pause'})[mode]);chip.dataset.kind=mode??'';
  chip.querySelector('span').textContent=mode===null?'':T['workbench.page.transport'+name];
  const word=mode===null?'':T['workbench.page.transport'+name+'Title'];chip.setAttribute('aria-label',word);chip.title=word;
};
// The host decides on refresh: after the hand-over reload the page without cache, during a running test not at all.
let appUrl=$('app').src;$('url').textContent=$('soloUrl').textContent=appUrl;
let refreshing=false,noticeTimer=0,refreshOn=false;
const REFRESH_TITLE=${json(refreshTitle)};
const notice=(text)=>{const box=$('notice');box.textContent=text;box.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{box.hidden=true;},6000);};
const refresh=async()=>{
  if(refreshing)return;refreshing=true;$('reload').disabled=true;$('browserState').textContent=T['workbench.page.reloading'];
  let done=false;try{done=(await window.${REFRESH_BINDING}?.())===true;}catch{}
  if(!done)notice(T['workbench.page.refreshLocked']);
  refreshing=false;$('reload').disabled=!refreshOn;summarize();
};
$('reload').addEventListener('click',refresh);
// Personal settings: the host validates key and value.
const pref=(key,value)=>{try{const result=window.${PREF_BINDING}?.(key,value);result?.catch?.(()=>{});}catch{}};
// Steps and chat can be collapsed. When the chat asks something it unfolds by itself without overriding the choice.
const fold=(name,on,remember=true)=>{document.body.classList.toggle('fold-'+name,on);$(name+'Fold').setAttribute('aria-expanded',String(!on));$(name+'Strip').setAttribute('aria-expanded',String(!on));if(remember){pref(name,on?'closed':'open');if(name==='steps')autoSteps=false;}};
const toggleFold=(name)=>fold(name,!document.body.classList.contains('fold-'+name));
// Without an own choice the step list starts collapsed in narrow windows: the space belongs to the application.
let autoSteps=${prefs.steps === undefined ? 'true' : 'false'};
// When a step fails or the steps are known, the list unfolds by itself, but only if it was collapsed automatically.
let stepsWanted=false;
const fitSteps=()=>{if(!autoSteps)return;const on=innerWidth<1500&&!stepsWanted;document.body.classList.toggle('fold-steps',on);$('stepsFold').setAttribute('aria-expanded',String(!on));$('stepsStrip').setAttribute('aria-expanded',String(!on));};
fitSteps();addEventListener('resize',fitSteps);
const showSteps=()=>{if(!autoSteps||stepsWanted)return;stepsWanted=true;fitSteps();};
$('stepsFold').addEventListener('click',()=>fold('steps',true));$('stepsStrip').addEventListener('click',()=>fold('steps',false));
$('chatFold').addEventListener('click',()=>fold('chat',true));$('chatStrip').addEventListener('click',()=>fold('chat',false));
$('fSteps').addEventListener('click',()=>toggleFold('steps'));$('fChat').addEventListener('click',()=>toggleFold('chat'));
// Application only: the workbench steps back, the browser window stays as it is (no fullscreen like F11). The host remembers
// it and restores it after a workbench reload.
const showSolo=(on)=>{document.body.classList.toggle('solo',on);};
const solo=(on=!document.body.classList.contains('solo'))=>{showSolo(on);try{const result=window.${FULLSCREEN_BINDING}?.(on);result?.catch?.(()=>{});}catch{}};
for(const b of document.querySelectorAll('[data-solo]'))b.addEventListener('click',()=>solo());
// Animations off (F10): no blinking, no spinner, no cursor. Also applies to the next runs.
const setStill=(on)=>{document.body.classList.toggle('still',on);$('still').setAttribute('aria-pressed',String(on));pref('animations',on?'off':'on');};
$('still').addEventListener('click',()=>setStill(!still()));
// Pause and abort belong to the chat: the workbench only passes the key on.
const chatWindow=()=>{try{return $('chat').contentWindow;}catch{return null;}};
const toChat=(key)=>{try{chatWindow()?.postMessage({caw:'key',key},'*');}catch{}};
for(const b of document.querySelectorAll('[data-key]'))b.addEventListener('click',()=>toChat(b.dataset.key));

const KIND={waiting:'open',running:'run',pass:'ok',fail:'fail',skipped:'open'};
const BULLET={running:'›',pass:'·',fail:'✕'};
const makeMark=(point)=>{const st=document.createElement('span');st.className='st';st.setAttribute('role','img');st.setAttribute('aria-label',LABELS.waiting);
  const tg=document.createElement('span');tg.className='tag'+(point?' pt-tag':'');st.append(tg);
  if(point){const mk=document.createElement('span');mk.className='mk';st.append(mk);}return st;};
const paint=(node)=>{const own=isGroup(node),st=node.querySelector(own?':scope>.head>.st':':scope>.st'),stateName=node.dataset.state,k=KIND[stateName]??'open';
  const tg=st.querySelector('.tag');tg.className='tag tag-'+k+(own?'':' pt-tag');markInto(tg,k);
  const mk=st.querySelector('.mk');if(mk){mk.className='mk mk-'+k;mk.textContent=BULLET[stateName]??'·';}};
const setState=(node,stateName,note)=>{const label=LABELS[stateName]??stateName,own=isGroup(node);node.dataset.state=stateName;node.setAttribute('aria-label',node.dataset.label+' – '+label);
  node.querySelector(own?':scope>.head [role=img]':'[role=img]').setAttribute('aria-label',label);paint(node);
  if(note!==undefined||stateName!=='fail'){const text=node.querySelector(own?':scope>.head .text':'.text');text.querySelector(':scope>.note')?.remove();
    if(note){const div=document.createElement('div');div.className='note';div.textContent=note;div.title=note;text.append(div);}}};
const showMs=(node,ms)=>{const cell=node.querySelector(isGroup(node)?':scope>.head .ms':'.ms');if(ms===undefined){cell.textContent='';delete node.dataset.ms;}else{cell.textContent=duration(ms);node.dataset.ms=String(Math.round(ms));}};
const liveText=(text)=>'› '+text;
const makePoint=(p)=>{const li=document.createElement('li');li.dataset.id=p.id;li.dataset.state='waiting';if(p.kind)li.dataset.kind=p.kind;li.dataset.label=((p.kind?p.kind+' ':'')+(p.label??'')).trim();li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const tree=document.createElement('span');tree.className='tree';tree.setAttribute('aria-hidden','true');
  const text=document.createElement('span');text.className='text';if(p.kind){const kind=document.createElement('span');kind.className='kind';kind.textContent=p.kind;text.append(kind);}
  const name=document.createElement('span');name.className='name';name.textContent=p.label??'';text.append(name);
  const ms=document.createElement('span');ms.className='ms';li.append(tree,makeMark(true),text,ms);paint(li);return li;};
const phaseName=(li)=>{li.querySelector(':scope>.head .name').textContent=li.dataset.name;};
const makeGroup=(g)=>{const li=document.createElement('li');const phase=g.kind==='phase';li.dataset.id=g.id;li.dataset.kind=phase?'phase':'step';li.dataset.name=g.name;li.dataset.state='waiting';li.dataset.label=(phase?'':g.id+' ')+g.name;li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const head=document.createElement('div');head.className='head';head.append(makeMark(false));
  if(!phase){const id=document.createElement('span');id.className='id';id.textContent=g.id;head.append(id);}
  const text=document.createElement('span');text.className='text';const name=document.createElement('span');name.className='name';name.textContent=g.name;text.append(name);
  const ms=document.createElement('span');ms.className='ms';head.append(text,ms);
  const pts=document.createElement('ol');pts.className='pts';li.append(head,pts);pts.append(...(g.points??[]).map(makePoint));paint(li);if(phase)phaseName(li);return li;};
// Pick a state (F1): only after the hand-over, when the host offers tests. A picked step opens at its entry; without a step the
// test runs up to the last reachable one.
let STATES=[],sTest=null,sStep=null;
const stateDlg=$('stateDlg');
const okSteps=(test)=>test.steps.filter((step)=>step.ok);
const sRow=(cls,mark,name,meta,selected,disabled)=>{const b=document.createElement('button');b.type='button';b.className='srow'+(cls?' '+cls:'');b.setAttribute('role','option');b.setAttribute('aria-selected',String(selected));b.disabled=disabled===true;
  const m=document.createElement('span');m.className='mk';m.textContent=mark;const n=document.createElement('span');n.className='nm';n.textContent=name;const x=document.createElement('span');x.className='meta'+(meta?.warn?' w':'');x.textContent=meta?.text??'';b.append(m,n,x);return b;};
const renderStates=()=>{
  const q=$('sq').value.trim().toLowerCase();
  const shown=STATES.filter((test)=>test.id.toLowerCase().includes(q)||test.name.toLowerCase().includes(q)||String(test.role??'').toLowerCase().includes(q));
  if(sTest!==null&&!STATES.some((test)=>test.id===sTest))sTest=null;
  $('stests').replaceChildren(...shown.map((test)=>{const row=sRow('',test.id===sTest?'▸':' ',test.id,test.writes?{text:(test.role?test.role+' · ':'')+T['workbench.page.stateWrites'],warn:true}:{text:(test.role?test.role+' · ':'')+fill('workbench.page.stateCount',{count:test.steps.length})},test.id===sTest);
    row.addEventListener('click',()=>{sTest=test.id;sStep=null;renderStates();});return row;}));
  const test=STATES.find((entry)=>entry.id===sTest);
  $('sstepsHead').textContent=test?T['workbench.page.stateSteps']+' · '+test.id:T['workbench.page.stateSteps'];
  if(!test){$('ssteps').replaceChildren();$('sgo').disabled=true;$('sfoot').textContent=T['workbench.page.stateHint'];return;}
  const last=okSteps(test).at(-1);
  const all=sRow('all',sStep===null?'▸':' ',fill('workbench.page.stateAll',{id:last.id}),null,sStep===null);
  all.addEventListener('click',()=>{sStep=null;renderStates();});
  const rows=test.steps.map((step,i,list)=>{const row=sRow('',(i===list.length-1?'└':'├'),fill('workbench.page.stateStep',{id:step.id,name:step.name}),step.ok?null:{text:T['workbench.page.stateWhy.'+step.why]??'',warn:true},sStep===step.id,!step.ok);
    if(sStep===step.id)row.querySelector('.mk').textContent='▸';
    row.addEventListener('click',()=>{sStep=step.id;renderStates();});return row;});
  $('ssteps').replaceChildren(all,...rows);
  $('sgo').disabled=false;
  $('sfoot').textContent=(sStep===null?fill('workbench.page.stateFoot',{test:test.id,step:last.id}):fill('workbench.page.stateFootEntry',{test:test.id,step:sStep}))+(test.role?fill('workbench.page.stateFootRole',{role:test.role}):'')+(test.writes?T['workbench.page.stateFootWrites']:'');
};
let stateFocus=null;
const openStates=(on=stateDlg.hidden)=>{if(on&&STATES.length===0)return;stateDlg.hidden=!on;
  if(on){stateFocus=document.activeElement;if(sTest===null&&STATES.length===1)sTest=STATES[0].id;renderStates();$('sq').focus();}else stateFocus?.focus?.();};
const goState=()=>{const test=STATES.find((entry)=>entry.id===sTest);if(!test)return;openStates(false);
  try{const result=window.${STATE_BINDING}?.(test.id,sStep);result?.catch?.(()=>{});}catch{}};
$('sq').addEventListener('input',renderStates);
$('sq').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!$('sgo').disabled){event.preventDefault();goState();}});
$('scancel').addEventListener('click',()=>openStates(false));$('sgo').addEventListener('click',goState);
stateDlg.addEventListener('click',(event)=>{if(event.target===stateDlg)openStates(false);});
for(const b of document.querySelectorAll('[data-states]'))b.addEventListener('click',()=>openStates(true));

// The workbench keys. F11 and F12 stay with Chrome; F5 and Ctrl+R mean refresh.
const isRefreshKey=(event)=>event.key==='F5'||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='r');
const press=(key)=>{
  if(key==='F1'){openStates();return true;}
  if(key==='F2')select('requests');else if(key==='F3')select('console');else if(key==='F4')toggleFold('steps');else if(key==='F6')toggleFold('chat');
  else if(key==='F8')solo();else if(key==='F10')setStill(!still());else if(key==='F9'||key==='Escape')toChat(key);else return false;
  return true;};
addEventListener('keydown',(event)=>{
  if(isRefreshKey(event)){event.preventDefault();refresh();return;}
  if(event.key==='Escape'&&!stateDlg.hidden){event.preventDefault();openStates(false);return;}
  if(event.key==='Escape'&&event.target?.closest?.('input,textarea,select'))return;
  if(event.ctrlKey||event.altKey||event.metaKey)return;
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
// The pinned viewport of the app frame: { width, height } or null (the frame fills its pane).
let pinned=null;
const fitApp=()=>{const box=$('appBox');const app=$('app');box.classList.toggle('pinned',pinned!==null);
  if(pinned===null){app.style.width=app.style.height=app.style.transform=app.style.left='';box.removeAttribute('title');return;}
  const scale=Math.min(1,box.clientWidth/pinned.width,box.clientHeight/pinned.height);
  app.style.width=pinned.width+'px';app.style.height=pinned.height+'px';app.style.transform='scale('+scale+')';
  app.style.left=Math.max(0,Math.round((box.clientWidth-pinned.width*scale)/2))+'px';
  box.title=fill('workbench.page.viewportPinned',{width:pinned.width,height:pinned.height,percent:Math.round(scale*100)});};
new ResizeObserver(fitApp).observe($('appBox'));
window.workbench={
  viewport:(size)=>{pinned=size&&size.width>0&&size.height>0?{width:Math.round(size.width),height:Math.round(size.height)}:null;fitApp();},
  // The first entry is the title, a sentence with the test's name (shown plain, the words around it in the accent colour);
  // the rest are the chips.
  facts:(entries)=>{const [first,...rest]=entries;const title=$('title');const test=title.dataset.test;
    if(first){const text=String(first[1]);const at=test?text.indexOf(test):-1;const word=(part)=>{const span=document.createElement('span');span.className='cmd';span.textContent=part;return span;};
      title.replaceChildren(...(at<0?[word(text)]:[text.slice(0,at),test,text.slice(at+test.length)].map((part,index)=>index===1?document.createTextNode(part):part===''?null:word(part)).filter(Boolean)));title.title=text;}
    $('facts').replaceChildren(...rest.map(([label,value])=>{const li=document.createElement('li');li.title=label+': '+value;const b=document.createElement('b');b.textContent=String(value);li.append(label,b);return li;}));},
  url:(url)=>{appUrl=url;$('url').textContent=$('soloUrl').textContent=url;$('url').title=url;},
  steps:(groups)=>{aborted=false;$('steps').replaceChildren(...groups.map(makeGroup));if(groups.length>0)showSteps();summarize();},
  // Adds or renames a group, e.g. "Fehler klären" when Claude investigates. Existing items stay.
  group:(def)=>{const known=items().find((li)=>li.dataset.id===def.id);if(known){known.dataset.name=def.name;if(known.dataset.kind==='phase')phaseName(known);else known.querySelector(':scope>.head .name').textContent=def.name;for(const point of def.points??[])if(!pointsOf(known).some((li)=>li.dataset.id===point.id))known.querySelector(':scope>.pts').append(makePoint(point));}else $('steps').append(makeGroup(def));summarize();},
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
  solo:(on)=>showSolo(on===true),
  // Record (Claude records or fixes), play (replay, check run, restoring a state) or pause; anything else hides the chip.
  transport:(value)=>{transport=['record','play','pause'].includes(value)?value:null;summarize();},
  // The tests from which a state can be reached here; empty hides F1.
  states:(list)=>{STATES=Array.isArray(list)?list.filter((test)=>Array.isArray(test?.steps)&&test.steps.some((step)=>step.ok)):[];for(const b of document.querySelectorAll('[data-states]'))b.hidden=STATES.length===0;if(!stateDlg.hidden)renderStates();},
  // Refresh only works if the host allows it; otherwise the button is locked.
  refreshable:(on)=>{refreshOn=on===true;$('reload').disabled=!refreshOn||refreshing;$('reload').title=refreshOn?REFRESH_TITLE:T['workbench.page.refreshLockedTitle'];summarize();},
  // After a reload the page is no longer reliably in the run's state; "restore state" brings it back.
  left:(on,text)=>{document.body.classList.toggle('left-state',on);const box=$('leftNote');box.hidden=!on;const title=document.createElement('strong');title.textContent=T['workbench.page.pageReloaded'];box.replaceChildren(title,text||'');summarize();},
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
    const shown = { facts: null, steps: null, states: new Map(), points: new Map(), url: null, mood: null, left: null, chatState: null, transport: null, solo: false, catalog: null, viewport: null };
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
