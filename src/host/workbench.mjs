// Die Werkbank: eine Seite fuer den ganzen Lauf, drei Spalten im Pixel-Stil. Links Schritte und Zaehler, in der Mitte die
// Anwendung im iframe mit Requests und Konsole darunter, rechts der Chat. Der Chat ist ein eigenes Dokument im selben Origin
// (srcdoc), seine Seite bleibt die aus chat.mjs.
//
// Der Rabe aus dem Logo begleitet den Lauf: Er fliegt auf den aktuellen Schritt, zum Chat, wenn der Mensch gefragt ist, und am
// Ende zurueck ins Logo. „Animationen aus“ in der Kopfzeile schickt ihn ins Logo und haelt dort alles still.
//
// Aktualisieren (Knopf, F5, Klick aufs Logo) laedt nach der Uebergabe die aktuelle Seite der Anwendung ohne Cache neu; Chat und
// Schritte bleiben, die Schritte zeigen danach „Zustand verlassen“. Solange der Test laeuft, ist Neuladen gesperrt: Es wuerde den
// Zustand fuer die folgenden Schritte verfaelschen. Laedt jemand die ganze Werkbank neu, baut der Host sie wieder auf.
//
// Die Anwendung teilt den Origin mit der Werkbank (top.Ext & Co.), nicht mit dem Chat: Der liegt sandboxed in einem opaken Origin,
// und der Host kennt ihn als den Frame, den die Werkbank beim Laden angelegt hat, nie ueber seinen Namen. Ein nachgebautes iframe
// namens caw-chat spricht darum nicht als Mensch. Aktualisieren darf die Anwendung ausloesen (F5 in ihr meldet sich ohnehin), es
// greift erst nach der Uebergabe.

import { APP_FRAME, FOCUS_SCRIPT, RELOAD_SCRIPT, frameView, interceptDocuments, sourceTag } from './app-view.mjs';
import { language, t, texts } from '../shared/i18n.mjs';
import { readPrefs, writePref } from '../shared/prefs.mjs';
import { RAVEN_CLIPS } from './raven-clips.mjs';
import { FAVICON, FONT_FACES, PAGE_BG, PIXEL_CSS, RAVEN_SHEET, TOKENS, ring } from './theme.mjs';

export const CHAT_FRAME = 'caw-chat';
export const PREF_BINDING = 'cawPref';
export const REFRESH_BINDING = 'cawRefresh';
/**
 * Der Chat laeuft in einem sandboxed iframe ohne allow-same-origin, also mit eigenem, opakem Origin. Die Werkbank teilt sich den
 * Origin mit der Anwendung (damit top.Ext & Co. gehen). Ohne die Sandbox koennte die Anwendung den Chat erreichen und als Mensch
 * entscheiden, etwa eine Aenderung uebernehmen. So erreicht sie weder sein DOM noch sein Binding.
 */
export const CHAT_SANDBOX = 'allow-scripts allow-forms';
const RELOADED_MS = 15000;
/** Die Gruppe der Vorbereitung: Chrome, Anmelden, lokaler Code, Laden. */
export const PREP = 'prep';
const PANEL_MS = 1000;
const MAX_ROWS = 300;
// Ein Binding laesst sich je Seite nur einmal anlegen; je Seite merkt sich der Host, wer gerade aktualisiert.
const benches = new WeakMap();

/** Ein Pixelbild aus Zeilen ("X" = Pixel) als box-shadow eines 2-px-Elements. */
// Hell und dunkel: Sonne und Mond als Pixelbild, je Zeile ein Rechteck pro gesetztem Pixel.
const pixelSvg = (rows) => `<svg class="pixel-icon" viewBox="0 0 ${rows[0].length} ${rows.length}" shape-rendering="crispEdges" aria-hidden="true"><path d="${rows.flatMap((row, y) => [...row].map((cell, x) => (cell === 'X' ? `M${x} ${y}h1v1h-1z` : ''))).join('')}"/></svg>`;
const SUN = pixelSvg(['....X....', '.X.....X.', '...XXX...', '..XXXXX..', 'X.XXXXX.X', '..XXXXX..', '...XXX...', '.X.....X.', '....X....']);
const MOON = pixelSvg(['...XXXX..', '..XXX....', '.XXX.....', '.XXX.....', '.XXX.....', '.XXX.....', '.XXXX...X', '..XXXXXX.', '...XXXX..']);
const pixels = (rows, color, size = 2) => rows.flatMap((row, y) => [...row].map((cell, x) => (cell === 'X' ? `${x * size}px ${y * size}px 0 ${color}` : null))).filter(Boolean).join(',');
// Ein- und Ausklappen: ein einfacher Winkel, der in die Richtung zeigt, in die die Spalte geht.
const chevron = (path) => `<svg class="panel-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
const LEFT = chevron('M10 3.5 5.5 8l4.5 4.5');
const RIGHT = chevron('M6 3.5 10.5 8 6 12.5');
const STEPS_CLOSE = LEFT;
const STEPS_OPEN = RIGHT;
const CHAT_CLOSE = RIGHT;
const CHAT_OPEN = LEFT;
const HEART = pixels(['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'], 'var(--fail)');
const CRUMB = pixels(['XX.', 'XXX'], 'var(--crumb)');
const CLOUD = pixels(['....XXXX......', '..XXXXXXXX.XX.', '.XXXXXXXXXXXXX', 'XXXXXXXXXXXXXX', '.XXXXXXXXXXXX.'], 'var(--cloud)');
const CONFETTI = ['var(--ok)', 'var(--primary)', 'var(--fail)', 'var(--warn)'];
const CHECK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8.5l3.5 3.5L13 4.5' fill='none' stroke='%23000' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
const CROSS = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 9 9' shape-rendering='crispEdges'%3E%3Cpath d='M2 2h1v1h1v1h1V3h1V2h1v1H6v1H5v1h1v1h1v1H6V6H5V5H4v1H3v1H2V6h1V5h1V4H3V3H2z'/%3E%3C/svg%3E\")";

/** Der Platzhalter im Chat-Frame, bis der Chat kommt. In der aktuellen Sprache, darum erst beim Gebrauch. */
const chatPlaceholder = () => `<!doctype html><html lang="${language()}"><meta charset="utf-8"><title>${t('workbench.chat')}</title><script>(()=>{addEventListener('message',(event)=>{if(event.source!==parent||event.data?.caw!=='theme')return;const theme=event.data.theme;if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme;else delete document.documentElement.dataset.theme;});try{parent.postMessage({caw:'theme-request'},'*');}catch{}})();${sourceTag}</script><style>${FONT_FACES}${TOKENS}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--surface);color:var(--muted)}
header{padding:14px 18px 14px 56px;border-bottom:var(--frame-w) solid var(--frame);font:500 var(--fs-label) var(--font-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--text)}
p{flex:1;display:grid;place-items:center;margin:0;padding:24px;text-align:center;font:var(--fs-body)/1.5 var(--font-body)}</style>
<header>Chat · Claude</header><p>${t('workbench.chatPlaceholder')}</p></html>`;

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/**
 * Die Seite der Werkbank. `appUrl` laedt das iframe, alles Weitere setzt der Host per `window.workbench`.
 * @param prefs  persoenliche Einstellungen: animations 'on' | 'off', steps und chat 'open' | 'closed'
 */
export const workbenchHtml = ({ appUrl, title, prefs = {} }) => {
    const still = prefs.animations === 'off';
    const theme = prefs.theme === 'light' || prefs.theme === 'dark' ? ` data-theme="${prefs.theme}"` : '';
    const classes = [still ? 'still' : '', prefs.steps === 'closed' ? 'fold-steps' : '', prefs.chat === 'closed' ? 'fold-chat' : ''].filter(Boolean).join(' ');
    const refreshTitle = t('workbench.refreshTitle');
    return `<!doctype html><html lang="${language()}"${theme}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FAVICON}<style>
${FONT_FACES}${TOKENS}${PIXEL_CSS}
*,*::before,*::after{box-sizing:border-box}html,body{height:100%;margin:0}
body{${PAGE_BG};color:var(--text);font:var(--fs-body)/1.4 var(--font-body)}
button{font:inherit;color:inherit}
:focus-visible{outline:3px dashed var(--primary-text);outline-offset:3px}
.pa{height:100vh;display:flex;flex-direction:column}
.pa-header{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:10px 22px;padding:10px var(--gap-page);background:var(--surface);border-bottom:var(--frame-w) solid var(--frame)}
.pa-logo{display:flex;align-items:center;gap:12px}
.pa-logo__mark{position:relative;padding:8px 0 0;margin:0;border:0;background:none;cursor:pointer}
.pa-logo__tile{display:block;position:relative;width:40px;height:40px;background:var(--surface)}
.raven-away .pa-logo__tile::after{content:'';position:absolute;left:4px;top:4px;width:32px;height:32px;background:url(${RAVEN_SHEET}) no-repeat 0 0/${RAVEN_CLIPS.width * 32 / RAVEN_CLIPS.cell}px ${RAVEN_CLIPS.height * 32 / RAVEN_CLIPS.cell}px;image-rendering:pixelated;transform:scaleX(-1);opacity:.28}
.raven-away .pa-logo__bubble{visibility:hidden}
.pa-logo__bubble{position:absolute;left:24px;top:0;font:9px var(--font-deco);padding:1px 5px 2px;background:var(--primary);color:var(--primary-ink);box-shadow:${ring('2px', 'var(--bubble-frame)')}}
.pa-logo__word{font:var(--fs-logo)/.85 var(--font-deco);padding-top:8px}
#state{display:none}#state.on{display:inline-flex}
.pa-meta{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none;min-width:0;flex:1 1 280px}
.pa-chip{padding:4px 9px;font-size:14px;background:var(--surface-2);box-shadow:${ring('2px', 'var(--shadow)')};white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.pa-chip__label{font:500 var(--fs-meta) var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-right:6px}
.pa-tools{margin-left:auto;display:flex;align-items:center;gap:18px}#reload{padding:9px 12px}
#theme{display:grid;place-items:center;width:38px;height:36px;padding:0}.pixel-icon{display:block;width:18px;height:18px;fill:currentColor}
#notice{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;font:500 12px var(--font-ui);color:var(--muted);background:var(--surface-2);box-shadow:${ring('2px', 'var(--pending)')}}#notice::before{content:"";width:6px;height:6px;background:var(--pending)}#notice[hidden]{display:none}
.left-state #steps,.left-state #progress{opacity:.45}
#leftNote{margin:14px 2px 2px;padding:10px 12px;font-size:13px;line-height:1.45;color:var(--muted);background:var(--surface-2);box-shadow:${ring('2px', 'var(--pending)')}}#leftNote[hidden]{display:none}
#leftNote strong{display:flex;align-items:center;gap:7px;margin-bottom:3px;font:500 12px var(--font-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--text)}#leftNote strong::before{content:"";width:6px;height:6px;background:var(--pending)}
.pa-check{display:inline-flex;align-items:center;gap:8px;font:500 12px var(--font-ui);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);cursor:pointer;white-space:nowrap}.pa-check:hover{color:var(--text)}
.pa-check input{appearance:none;display:grid;place-content:center;width:18px;height:18px;margin:0;background:var(--surface);box-shadow:${ring('2px', 'var(--frame)')};cursor:pointer}
.pa-check input:checked{background:var(--primary)}.pa-check input:checked::after{content:"";width:14px;height:14px;background:var(--primary-ink);-webkit-mask:${CHECK} center/100% no-repeat;mask:${CHECK} center/100% no-repeat}
.pa-main{flex:1;min-height:0;display:grid;gap:var(--gap-page);padding:var(--gap-page);
--col-steps:minmax(280px,320px);--col-chat:minmax(320px,400px);grid-template-columns:var(--col-steps) minmax(0,1fr) var(--col-chat);grid-template-rows:minmax(0,1fr);
grid-template-areas:"steps browser chat"}
.pa-card{min-width:0}.pa-steps,.pa-chat{position:relative}
/* Einklappen: ein Pfeil bündig in der Ecke zur Mitte hin, ohne Fläche und Rahmen. */
.pa-fold{position:absolute;top:6px;z-index:3;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;background:transparent;color:var(--muted);cursor:pointer}
#stepsFold{right:6px}#chatFold{left:6px}.pa-fold:hover{color:var(--text);background:var(--surface-2)}
.panel-icon{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pa-steps .pa-card__head{padding-right:34px}
.pa-strip{display:none;flex:1;width:100%;flex-direction:column;align-items:center;gap:12px;padding:14px 0;border:0;background:none;cursor:pointer;color:var(--text);font:500 12px var(--font-ui);letter-spacing:.08em;text-transform:uppercase}
.pa-strip:hover{background:var(--surface-2)}.pa-strip span{writing-mode:vertical-rl}.pa-strip .panel-icon{color:var(--muted);margin-bottom:4px}.pa-strip:hover .panel-icon{color:var(--text)}
.pa-steps{grid-area:steps;align-self:start;max-height:100%;min-height:0;display:flex;flex-direction:column;padding:var(--pad-card)}
.pa-card__head{display:flex;justify-content:space-between;align-items:center;gap:8px}.pa-card__head .px-label{font-size:12px}
.pa-muted{color:var(--muted)}
#progress{margin:12px 0 2px}#progress:empty{display:none}
/* Die Liste scrollt von selbst mit dem aktuellen Punkt, darum ohne Scrollbalken. Mausrad geht weiter. */
#track{min-height:0;overflow:auto;margin:0 -6px 0 0;padding-right:6px;scrollbar-width:none}#track::-webkit-scrollbar{display:none}
/* Variante B: Jede Gruppe (Vorbereitung, S1..Sn, Abschluss, Fehler klaeren) ist eine Zwischenueberschrift, darunter jede Aktion als Punkt.
   Die Schiene laeuft durch alle Symbole, der Rabe landet auf jedem Punkt. */
#steps,#steps .pts{list-style:none;margin:0;padding:0}
#steps{padding:8px 0 4px;position:relative}
#steps::before{content:"";position:absolute;left:20px;width:4px;top:24px;bottom:18px;background:repeating-linear-gradient(var(--rail) 0 4px,transparent 4px 8px)}
#steps .head{display:grid;grid-template-columns:44px 36px minmax(0,1fr) auto;align-items:center;min-height:44px;margin-top:6px}
#steps>li:first-child>.head{margin-top:0}
#steps>li[data-kind=phase]>.head{grid-template-columns:44px minmax(0,1fr) auto}
.step-icon{justify-self:center;width:18px;height:18px;position:relative;z-index:1;background:var(--surface)}
.pt-icon{justify-self:center;width:12px;height:12px;position:relative;z-index:1;background:var(--surface)}
#steps>li[data-state=waiting]>.head .step-icon,.pts>li[data-state=waiting] .pt-icon{box-shadow:inset 0 0 0 2px var(--pending)}
#steps>li[data-state=skipped]>.head .step-icon,#steps>li[data-state=skipped] .pt-icon{box-shadow:inset 0 0 0 2px var(--pending);opacity:.45}
#steps>li[data-state=running]>.head .step-icon,.pts>li[data-state=running] .pt-icon{background:var(--primary);animation:run 1s steps(1,end) infinite}
#steps>li[data-state=pass]>.head .step-icon,.pts>li[data-state=pass] .pt-icon{background:var(--ok)}
#steps>li[data-state=fail]>.head .step-icon,.pts>li[data-state=fail] .pt-icon{background:var(--fail)}
#steps>li[data-state=pass]>.head .step-icon::after,#steps>li[data-state=fail]>.head .step-icon::after,.pts>li[data-state=fail] .pt-icon::after{content:"";position:absolute;inset:0;background:var(--icon-ink);-webkit-mask:var(--glyph) center/100% no-repeat;mask:var(--glyph) center/100% no-repeat}
#steps>li[data-state=pass]>.head{--glyph:${CHECK}}#steps>li[data-state=fail]>.head,.pts>li[data-state=fail]{--glyph:${CROSS}}
#steps>li[data-state=fail]>.head{background:var(--fail-tint)}
#steps .id{font:500 11px var(--font-ui);color:var(--muted)}
#steps .text{min-width:0;padding:5px 0}
#steps .head .name{display:block;font-size:15px;font-weight:500;line-height:1.3;overflow-wrap:anywhere;hyphens:auto}
#steps>li[data-kind=phase]>.head .name{font:500 12px var(--font-ui);letter-spacing:.08em;text-transform:uppercase}
#steps .note{font:12px/1.35 var(--font-mono);color:var(--fail-text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
#steps .ms{font:12px var(--font-mono);color:var(--muted);padding:0 8px;font-variant-numeric:tabular-nums;white-space:nowrap}
#steps>li[data-state=waiting]>.head .name,#steps>li[data-state=skipped]>.head .name{color:var(--subtle)}
#steps>li[data-state=skipped]>.head .text::after{content:${JSON.stringify(t('workbench.page.skipped'))};display:block;font:500 10px var(--font-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--subtle)}
#steps>li[data-state=running]>.head .name{color:var(--primary-text)}
#steps>li[data-state=fail]>.head :is(.name,.id,.ms){color:var(--fail-text)}
.pts>li{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;min-height:28px}
.pts .text{font-size:13px;line-height:1.35;overflow-wrap:anywhere}
.pts .kind{font:500 10px var(--font-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--auto);margin-right:7px}
.pts .ms{font-size:11px!important}
.pts>li[data-state=waiting] .text,#steps>li[data-state=skipped] .pts .text{color:var(--subtle)}
.pts>li[data-state=running] .text{color:var(--primary-text)}
.pts>li[data-state=fail]{background:var(--fail-tint)}.pts>li[data-state=fail] .text{color:var(--fail-text)}
.pts .live{display:block;font-size:12px;color:var(--primary-text)}
.pts .live::before{content:"";display:inline-block;width:4px;height:4px;margin-right:18px;vertical-align:middle;background:var(--primary);box-shadow:6px 0 var(--muted),12px 0 var(--muted);animation:dots .9s steps(1,end) infinite}
@keyframes dots{33%{background:var(--muted);box-shadow:6px 0 var(--primary),12px 0 var(--muted)}66%{background:var(--muted);box-shadow:6px 0 var(--muted),12px 0 var(--primary)}}
.hint{margin:14px 0 4px;font-size:var(--fs-small);color:var(--subtle)}#stepsHint[hidden]{display:none}
.bad{color:var(--fail-text)!important}
.pa-browser{grid-area:browser;display:flex;flex-direction:column;min-height:0;min-width:0}
.pa-browser__bar{flex:none;display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--primary);color:var(--primary-ink);border-bottom:var(--frame-w) solid var(--frame)}
.pa-browser__dots{display:flex;gap:6px}.pa-browser__dots i{width:10px;height:10px}
.pa-browser__dots i:nth-child(1){background:var(--browser-dot-1)}.pa-browser__dots i:nth-child(2){background:var(--browser-dot-2)}.pa-browser__dots i:nth-child(3){background:var(--browser-dot-3)}
#url{flex:1;min-width:0;padding:5px 10px;background:var(--primary-deep);font:13px var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#browserState{font:500 11px var(--font-ui);letter-spacing:.06em;color:var(--primary-soft);white-space:nowrap}
/* Beim Vorfuehren zaehlt jeder Klick: rot wie eine Aufnahme. Wartet der Chat auf den Menschen, sagt es auch die Leiste. */
#browserState.rec,#browserState.ask{padding:3px 8px;background:var(--surface)}#browserState.rec{color:var(--fail-text)}#browserState.ask{color:var(--warn)}
.px-pill--warn{color:var(--warn);background:var(--surface-2)}
#reload:disabled{opacity:.5;cursor:not-allowed}
#app{flex:1;min-height:0;width:100%;border:0;display:block;background:#fff}
.drawer{flex:none;border-top:var(--frame-w) solid var(--frame);background:var(--surface)}
.tabs{display:flex;gap:4px;padding:6px 10px}
.tabs button{font:500 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:none;border:0;padding:5px 10px;cursor:pointer}
.tabs button:hover{color:var(--text)}
.tabs button[aria-selected=true]{color:var(--text);background:var(--surface-2);box-shadow:inset 0 -3px 0 var(--primary)}
.tabs .count{margin-left:8px}.tabs .count.bad::before{content:"✕ "}
.tabs #drawerClose{display:none;margin-left:auto;box-shadow:${ring('2px', 'var(--frame)')}}.drawer.open #drawerClose{display:inline-flex}
.panel{display:none;height:28vh;min-height:120px;overflow:auto;border-top:2px solid var(--line)}.drawer.open .panel{display:block}
table{width:100%;border-collapse:collapse;font:12px/1.4 var(--font-mono)}
td{padding:5px 12px;border-top:2px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}
tr:first-child td{border-top:0}
td.name{width:60%}td.ok{color:var(--ok-text,var(--ok))}td.bad{color:var(--fail-text)}td.open{color:var(--muted)}td.ms{text-align:right;color:var(--muted);width:90px}
.empty{padding:10px 14px;color:var(--muted);font:12px var(--font-mono)}
.line{padding:5px 14px;border-top:2px solid var(--line);font:12px/1.45 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}.line:first-child{border-top:0}.line.fail{color:var(--fail-text)}.line.warn{color:var(--warn)}
.pa-chat{grid-area:chat;min-height:0;min-width:0;display:flex}
#chat{flex:1;width:100%;height:100%;border:0;display:block;background:var(--surface)}
/* Ab 1000px drei Spalten; bis 1500px schmalere Raender, damit die Anwendung ihr Desktop-Layout behaelt. */
@media (min-width:1000px) and (max-width:1499px){.pa-main{--col-steps:minmax(220px,260px);--col-chat:minmax(300px,340px)}}
@media (min-width:1000px){
.fold-steps .pa-main{--col-steps:48px}.fold-chat .pa-main{--col-chat:48px}
.fold-steps .pa-steps{align-self:stretch;padding:0}.fold-steps .pa-steps>:not(#stepsStrip),.fold-chat #chat,.fold-chat #chatFold{display:none}
.fold-steps #stepsStrip,.fold-chat #chatStrip{display:flex}}
@media (max-width:999px){
.pa-fold{display:none}
.pa{height:auto;min-height:100vh}
.pa-main{grid-template-columns:minmax(300px,380px) minmax(0,1fr);grid-template-rows:auto minmax(60vh,1fr);grid-template-areas:"steps browser" "chat browser"}
.pa-steps{max-height:40vh}}
@media (max-width:859px){
.pa-main{grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-template-areas:"steps" "chat" "browser"}
.pa-steps{max-height:none}#track{overflow:visible}.pa-chat{height:72vh}.pa-browser{height:78vh}.pa-tools{margin-left:0}}
@keyframes run{50%{background:var(--primary-soft)}}
#ravenLayer{position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden}
#raven{position:absolute;left:0;top:0;width:${RAVEN_CLIPS.cell}px;height:${RAVEN_CLIPS.cell}px;pointer-events:auto;cursor:pointer;transform-origin:50% 85%;will-change:transform}
#raven.home{pointer-events:none}
#raven .sprite{display:block;width:${RAVEN_CLIPS.cell}px;height:${RAVEN_CLIPS.cell}px;background:url(${RAVEN_SHEET}) no-repeat 0 0/${RAVEN_CLIPS.width}px ${RAVEN_CLIPS.height}px;image-rendering:pixelated;scale:var(--raven-dir,-1) 1;translate:calc(var(--raven-dir,-1) * var(--raven-shift-x,0px) * -1) calc(var(--raven-shift-y,0px) * -1);
filter:drop-shadow(1px 0 0 var(--raven-outline)) drop-shadow(-1px 0 0 var(--raven-outline)) drop-shadow(0 1px 0 var(--raven-outline)) drop-shadow(0 -1px 0 var(--raven-outline)) drop-shadow(0 0 3px var(--raven-outline-fade))}
#ravenSay{position:absolute;left:0;top:0;font:13px/1.2 var(--font-deco);padding:3px 9px 4px;white-space:nowrap;color:var(--primary-ink);background:var(--primary);box-shadow:${ring('2px', 'var(--bubble-frame)')}}
#ravenSay[hidden]{display:none}#ravenSay.zz{background:var(--surface-2);color:var(--muted)}
#ravenSay.pop{animation:say-pop .2s steps(2,end) 1}#ravenSay.float{animation:say-float 2.4s steps(4,end) infinite}
@keyframes say-pop{from{opacity:0;translate:0 4px}to{opacity:1;translate:0 0}}
@keyframes say-float{from{translate:0 0;opacity:1}to{translate:0 -8px;opacity:.4}}
.heart,.crumb{position:absolute;width:2px;height:2px}
/* Regenwoelkchen ueber dem Raben, solange sein Punkt gescheitert ist */
#ravenCloud{position:absolute;left:0;top:0;width:28px;height:22px}#ravenCloud[hidden]{display:none}
#ravenCloud::before{content:"";position:absolute;left:0;top:0;width:2px;height:2px;box-shadow:${CLOUD}}
#ravenCloud i{position:absolute;top:12px;width:2px;height:4px;background:var(--drop);animation:drop .7s steps(4,end) infinite}
#ravenCloud i:nth-child(1){left:6px}#ravenCloud i:nth-child(2){left:12px;animation-delay:-.25s}#ravenCloud i:nth-child(3){left:18px;animation-delay:-.5s}
@keyframes drop{from{translate:0 0;opacity:1}to{translate:0 10px;opacity:0}}
.confetti{position:absolute;width:4px;height:4px;animation:confetti 1.6s steps(12,end) forwards}
@keyframes confetti{0%{translate:0 0}45%{translate:calc(var(--dx) * .6) var(--up)}100%{translate:var(--dx) 24px;opacity:0}}
.heart{box-shadow:${HEART};animation:heart-up .9s steps(6,end) both}
@keyframes heart-up{from{translate:0 0;opacity:1}to{translate:0 -24px;opacity:0}}
.crumb{box-shadow:${CRUMB};animation:crumb-drop .24s steps(4,end) both}
@keyframes crumb-drop{from{translate:0 -16px}to{translate:0 0}}
.still *,.still *::before,.still *::after{animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body class="${classes}"><div class="pa">
<header class="pa-header">
<div class="pa-logo"><button class="pa-logo__mark" id="logo" type="button" aria-label="${t('workbench.refresh')}" title="${refreshTitle}"><span class="pa-logo__tile px-frame-sm" id="tile"></span><span class="pa-logo__bubble" aria-hidden="true">caw!</span></button><span class="pa-logo__word">caw-ai</span></div>
<span id="state" class="px-pill" role="status"></span>
<ul class="pa-meta" id="facts" aria-label="${t('workbench.runFacts')}"></ul>
<div class="pa-tools"><span id="notice" role="status" hidden></span><label class="pa-check" title="${t('workbench.stillTitle')}"><input type="checkbox" id="still"${still ? ' checked' : ''}>${t('workbench.still')}</label>
<button id="theme" class="px-btn" type="button" aria-label="${t('workbench.theme')}" title="${t('workbench.themeTitle')}"></button>
<button id="reload" class="px-btn" type="button" disabled title="${t('workbench.page.refreshLockedTitle')}">↻ ${t('workbench.refresh')}</button></div>
</header>
<main class="pa-main">
<section class="pa-steps pa-card px-frame" id="stepsCard" aria-label="${t('workbench.steps')}"><button class="pa-fold" id="stepsFold" type="button" aria-expanded="true" aria-label="${t('workbench.stepsFold')}" title="${t('workbench.stepsFold')}">${STEPS_CLOSE}</button><button class="pa-strip" id="stepsStrip" type="button" aria-expanded="false" aria-label="${t('workbench.stepsUnfold')}" title="${t('workbench.stepsUnfold')}">${STEPS_OPEN}<span>${t('workbench.steps')} <span id="stripTally"></span></span></button><div class="pa-card__head"><span class="px-label">${t('workbench.steps')}</span><span class="px-label pa-muted" id="tally"></span></div>
<div class="px-progress" id="progress" aria-hidden="true"></div><p id="leftNote" hidden></p><p class="hint" id="stepsHint">${t('workbench.stepsHint')}</p><div id="track"><ol id="steps" aria-label="${t('workbench.steps')}"></ol></div></section>
<section class="pa-browser px-frame" aria-label="${t('workbench.app')}"><div class="pa-browser__bar"><span class="pa-browser__dots" aria-hidden="true"><i></i><i></i><i></i></span><span id="url"></span><span id="browserState"></span></div>
<iframe id="app" name="${APP_FRAME}" title="${t('workbench.app')}" src="${esc(appUrl)}" allow="clipboard-read; clipboard-write"></iframe>
<div class="drawer" id="drawer"><div class="tabs" role="tablist"><button type="button" role="tab" data-tab="requests" aria-selected="false">${t('workbench.requests')}<span class="count" data-count="requests">0</span></button><button type="button" role="tab" data-tab="console" aria-selected="false">${t('workbench.console')}<span class="count" data-count="console">0</span></button><button type="button" id="drawerClose" aria-label="${t('workbench.drawerCloseLabel')}" title="${t('workbench.collapse')}">▾ ${t('workbench.collapse')}</button></div>
<div class="panel" id="panel"></div></div></section>
<section class="pa-chat pa-card px-frame" id="chatCard" aria-label="${t('workbench.chatLabel')}"><button class="pa-fold" id="chatFold" type="button" aria-expanded="true" aria-label="${t('workbench.chatFold')}" title="${t('workbench.chatFold')}">${CHAT_CLOSE}</button><button class="pa-strip" id="chatStrip" type="button" aria-expanded="false" aria-label="${t('workbench.chatUnfold')}" title="${t('workbench.chatUnfold')}">${CHAT_OPEN}<span>${t('workbench.chat')}</span></button><iframe id="chat" name="${CHAT_FRAME}" title="${t('workbench.chatLabel')}" sandbox="${CHAT_SANDBOX}" allow="clipboard-write" srcdoc="${esc(chatPlaceholder())}"></iframe></section>
</main></div>
<div id="ravenLayer"><div id="raven" aria-hidden="true"><span class="sprite"></span></div><span id="ravenSay" hidden aria-hidden="true"></span><span id="ravenCloud" hidden aria-hidden="true"><i></i><i></i><i></i></span></div>
<script>
const T=${JSON.stringify(texts('workbench.page.'))};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]);
const $=(id)=>document.getElementById(id);
const state={tab:null,requests:[],console:[]};
const LABELS={waiting:T['workbench.page.waiting'],running:T['workbench.page.running'],pass:T['workbench.page.pass'],fail:T['workbench.page.fail'],skipped:T['workbench.page.skipped']};
const items=()=>[...$('steps').children];
// Gezaehlt werden nur die Schritte des Tests; Vorbereitung, Abschluss und Fehler klaeren sind Phasen.
const stepItems=()=>items().filter((li)=>li.dataset.kind!=='phase');
const pointsOf=(li)=>[...li.querySelector(':scope>.pts').children];
// Wo der Rabe landen kann: jeder Punkt, und eine Gruppe ohne Punkte selbst.
const spots=()=>items().flatMap((li)=>{const points=pointsOf(li);return points.length>0?points:[li];});
const groupOf=(spot)=>spot.closest('#steps>li');
const spotState=(spot)=>{const li=groupOf(spot);return li!==spot&&li.dataset.state==='skipped'?'skipped':spot.dataset.state;};
const spotIcon=(spot)=>spot.querySelector(groupOf(spot)===spot?':scope>.head .step-icon':'.pt-icon');
const groupTitle=(li)=>li.dataset.kind==='phase'?li.dataset.name.toUpperCase():li.dataset.id;
const duration=(ms)=>ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(1).replace('.',T['workbench.page.decimal'])+' s';
const cell=(text,cls)=>{const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;td.title=text;return td;};
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
const select=(tab)=>{state.tab=state.tab===tab?null:tab;$('drawer').classList.toggle('open',state.tab!==null);for(const b of document.querySelectorAll('[data-tab]'))b.setAttribute('aria-selected',String(b.dataset.tab===state.tab));render();};
// Die Konsole oeffnet sich nur bei neuen Fehlern von selbst; schliessen tut sie nur der Mensch.
let seenFails=0;
for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>select(b.dataset.tab));
$('drawerClose').addEventListener('click',()=>{if(state.tab!==null)select(state.tab);});
const setCount=(name,value,bad)=>{for(const node of document.querySelectorAll('[data-count='+name+']')){node.textContent=value;node.classList.toggle('bad',bad===true);}};
let aborted=false;
// Was der Chat gerade will: ask aus der Stimmung, dazu sein Zustand (showing: der Mensch fuehrt vor).
let asking=false,chatState=null;
const stepsHintText=$('stepsHint').textContent;
// Kopfzeile, Fortschritt und Zaehler folgen den Schritten: was laeuft, was gescheitert ist, wie viele bestanden sind.
const summarize=()=>{
  const list=stepItems(),n=list.length,all=items();
  $('stepsHint').hidden=all.length>0;$('stepsHint').textContent=chatState==='showing'?T['workbench.page.stepsHintShowing']:stepsHintText;
  const count=(name)=>list.filter((li)=>li.dataset.state===name).length;
  const pass=count('pass');
  $('tally').textContent=$('stripTally').textContent=n===0?'':pass+' / '+n;
  const segments=$('progress');if(segments.children.length!==n)segments.replaceChildren(...list.map(()=>document.createElement('i')));
  list.forEach((li,i)=>{const s=li.dataset.state;segments.children[i].className=s==='pass'?'pass':s==='fail'?'fail':s==='running'?'run':'';});
  const failed=all.find((li)=>li.dataset.state==='fail'),running=list.find((li)=>li.dataset.state==='running')??all.find((li)=>li.dataset.state==='running');
  const [kind,text,browser]=aborted?['fail',T['workbench.page.aborted'],T['workbench.page.aborted']]:failed?['fail',fill('workbench.page.groupFailed',{id:groupTitle(failed)}),T['workbench.page.browserFailed']]:running?['run',fill('workbench.page.groupRunning',{id:groupTitle(running)}),T['workbench.page.browserRunning']]:n>0&&pass===n?['ok',T['workbench.page.allPassed'],T['workbench.page.browserPassed']]:pass>0?(document.body.classList.contains('left-state')?['',fill('workbench.page.left',{id:list.filter((li)=>li.dataset.state==='pass').at(-1).dataset.id}),T['workbench.page.browserReloaded']]:['ok',fill('workbench.page.reached',{id:list.filter((li)=>li.dataset.state==='pass').at(-1).dataset.id}),T['workbench.page.ready']]):n>0?['',T['workbench.page.ready'],T['workbench.page.ready']]:[null,'',''];
  let [pillKind,pillText,browserText,tone]=[kind,text,browser,''];
  // Wartet der Chat auf den Menschen, sagt das auch die Kopfzeile: Sonst stuende dort BEREIT, waehrend der Plan auf Freigabe wartet.
  if(!aborted&&asking){pillKind='warn';pillText=T['workbench.page.yourTurn'];browserText=T['workbench.page.browserYourTurn'];tone='ask';}
  if(!aborted&&chatState==='showing'){browserText=T['workbench.page.recording'];tone='rec';}
  const pill=$('state');pill.className='px-pill'+(pillKind?' px-pill--'+pillKind:'')+(pillKind!==null?' on':'');pill.dataset.state=failed?'fail':running?'running':n>0&&pass===n?'pass':'';pill.textContent=pillText;
  $('browserState').textContent=browserText;$('browserState').className=tone;
  raven.update();
};
// Aktualisieren entscheidet der Host: nach der Uebergabe die Seite ohne Cache neu laden, im laufenden Test gar nicht.
let appUrl=$('app').src;$('url').textContent=appUrl;
let refreshing=false,noticeTimer=0,refreshOn=false;
const REFRESH_TITLE=${JSON.stringify(refreshTitle)};
const notice=(text)=>{const box=$('notice');box.textContent=text;box.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{box.hidden=true;},6000);};
const refresh=async()=>{
  if(refreshing)return;refreshing=true;$('reload').disabled=true;$('browserState').textContent=T['workbench.page.reloading'];
  let done=false;try{done=(await window.${REFRESH_BINDING}?.())===true;}catch{}
  if(!done)notice(T['workbench.page.refreshLocked']);
  refreshing=false;$('reload').disabled=!refreshOn;summarize();
};
$('reload').addEventListener('click',refresh);$('logo').addEventListener('click',refresh);
const isRefreshKey=(event)=>event.key==='F5'||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='r');
addEventListener('keydown',(event)=>{if(isRefreshKey(event)){event.preventDefault();refresh();}});
// F5 in der Anwendung oder im Chat meldet deren Frame hierher. Mehr als Aktualisieren kann eine solche Nachricht nicht ausloesen.
addEventListener('message',(event)=>{if(event.data?.caw==='refresh'&&(event.source===$('app').contentWindow||event.source===$('chat').contentWindow))refresh();
  if(event.data?.caw==='theme-request'&&event.source===$('chat').contentWindow)sendTheme();
  if(event.data?.caw==='perch'&&event.source===$('chat').contentWindow&&Number.isFinite(event.data.y)){chatPerch={y:event.data.y,x:Number.isFinite(event.data.x)?event.data.x:null};raven.update();}});
// Die Linie unter dem Kopf des Chats, gemeldet vom Chat selbst; bis dahin eine Schaetzung.
let chatPerch=null;
// Der Chat liegt abgeschottet in einem eigenen Origin: Sein Thema bekommt er als Nachricht.
const sendTheme=()=>{try{$('chat').contentWindow.postMessage({caw:'theme',theme:document.documentElement.dataset.theme??null},'*');}catch{}};
// Persoenliche Einstellungen: Der Host prueft Schluessel und Wert.
const pref=(key,value)=>{try{const result=window.${PREF_BINDING}?.(key,value);result?.catch?.(()=>{});}catch{}};
// Hell oder dunkel: ohne Wahl wie das System, mit Wahl fest und gemerkt. Der Knopf zeigt, wohin er schaltet.
const systemDark=matchMedia('(prefers-color-scheme: dark)');
const isDark=()=>{const chosen=document.documentElement.dataset.theme;return chosen?chosen==='dark':systemDark.matches;};
const paintTheme=()=>{const dark=isDark();$('theme').innerHTML=dark?'${SUN}':'${MOON}';$('theme').setAttribute('aria-label',dark?T['workbench.page.toLight']:T['workbench.page.toDark']);};
$('theme').addEventListener('click',()=>{const next=isDark()?'light':'dark';document.documentElement.dataset.theme=next;pref('theme',next);paintTheme();sendTheme();});
systemDark.addEventListener('change',paintTheme);paintTheme();
// Schritte und Chat lassen sich einklappen. Fragt der Chat etwas, klappt er von selbst auf, ohne die Wahl zu ueberschreiben.
const fold=(name,on,remember=true)=>{document.body.classList.toggle('fold-'+name,on);$(name+'Fold').setAttribute('aria-expanded',String(!on));$(name+'Strip').setAttribute('aria-expanded',String(!on));if(remember){pref(name,on?'closed':'open');if(name==='steps')autoSteps=false;}raven.update();};
const folded=(name)=>document.body.classList.contains('fold-'+name)&&innerWidth>=1000;
// Ohne eigene Wahl startet die Schrittliste in schmalen Fenstern eingeklappt: Der Platz gehoert der Anwendung.
let autoSteps=${prefs.steps === undefined ? 'true' : 'false'};
// Scheitert ein Schritt oder stehen die Schritte fest, klappt die Liste von selbst auf, aber nur, wenn sie auch von selbst zu war.
let stepsWanted=false;
const fitSteps=()=>{if(!autoSteps)return;const on=innerWidth<1500&&!stepsWanted;document.body.classList.toggle('fold-steps',on);$('stepsFold').setAttribute('aria-expanded',String(!on));$('stepsStrip').setAttribute('aria-expanded',String(!on));};
fitSteps();addEventListener('resize',fitSteps);
const showSteps=()=>{if(!autoSteps||stepsWanted)return;stepsWanted=true;fitSteps();raven.update();};
$('stepsFold').addEventListener('click',()=>fold('steps',true));$('stepsStrip').addEventListener('click',()=>fold('steps',false));
$('chatFold').addEventListener('click',()=>fold('chat',true));$('chatStrip').addEventListener('click',()=>fold('chat',false));

// Der Rabe: derselbe wie im Logo. Er sitzt im Logo, auf dem ersten nicht bestandenen Schritt oder auf dem Chat.
// Ein Schritt weiter huepft er, weiter weg fliegt er. Mit „Animationen aus“ sitzt er still im Logo. Alles rein kosmetisch.
const raven=(()=>{
  const K=2,S=${RAVEN_CLIPS.cell},SETTLE=170,motion=matchMedia('(prefers-reduced-motion: reduce)');
  // Die Clips des Sheets (raven-clips.mjs): je Frame [Spalte, Zeile, ms]. Was einmal laeuft, dauert so lang wie sein Clip.
  // FEET: so viele Pixel stehen die Fuesse ueber dem Zellboden (Platz fuer den Flug darunter); er sitzt auf den Fuessen.
  // SHIFT: Clips mit eigenem Zuschnitt (der Flug) stehen in ihrer Zelle versetzt; die Grafik wird um so viel zurueckgeschoben.
  const CLIPS=${JSON.stringify(RAVEN_CLIPS.clips)},FEET=${RAVEN_CLIPS.feet ?? 0},SHIFT=${JSON.stringify(RAVEN_CLIPS.shift ?? {})},len=(n)=>CLIPS[n].reduce((s,f)=>s+f[2],0);
  // Weniger Bewegung gilt sofort, auch wenn der Mensch es mitten im Lauf im System umstellt.
  let reduce=motion.matches,fed=${Number(prefs.fed) || 0};
  const IDLE={blink:[2.5,len('blink')],caw:[1,len('caw')],look:[.5,900],puff:[1.5,len('puff')],peck:[1.5,900],hop:[.3,520],doze:[0,3200],feed:[0,1000],wave:[0,960],joy:[0,len('joy')],nod:[0,700],sigh:[0,len('sigh')],confetti:[0,0]};
  const AT_HOME=['blink','look','peck','puff'];
  // Er sagt nie Woerter: nur caw, ! und ?.
  const REACT={greet:[{name:'caw',text:'caw!'},'wave'],fail:[{name:'caw',text:'caw?!'},'sigh'],done:[{name:'caw',text:'caw!'},'home'],home:['wave','joy','confetti'],ask:[{name:'caw',text:'caw?'},'look'],aborted:['doze']};
  const layer=$('ravenLayer'),wrap=$('raven'),sprite=wrap.firstElementChild,say=$('ravenSay'),cloud=$('ravenCloud'),tile=$('tile'),toggle=$('still');
  const LOGO={kind:'logo'};
  let place=LOGO,want=LOGO,move=null,settle=0,act=null,queue=[],nextIdle=0,recent=[],waitSince=0,bubbleTill=0,lastKey='',x=0,y=0;
  // Ruhe statt Hin und Her: Eine kurze Rueckfrage holt ihn nicht in den Chat, und nach einer Rueckfrage bleibt er dort eine Weile
  // sitzen. Folgen mehrere aufeinander (Start, Token-Hinweis, Plan), fliegt er so nicht jedes Mal zurueck.
  const ASK_DELAY=450,LINGER=8000;
  let askSince=0,askEnd=0,recheck=0;
  let still=${still},homing=false,mood=null,celebrated=false,greeted=false,cheering=false,clickTimer=0,cur={x:0,y:0};
  const same=(a,b)=>a.kind===b.kind&&a.i===b.i;
  const shown=(r)=>r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;
  const anchor=(p)=>{
    if(p.kind==='step'){const spot=spots()[p.i],icon=spot&&spotIcon(spot);if(icon){const r=icon.getBoundingClientRect(),t=$('track').getBoundingClientRect(),mid=r.top+r.height/2;return {x:r.left+r.width/2,y:r.top+K,show:mid>=t.top&&mid<=t.bottom&&shown(r)};}}
    if(p.kind==='chat'){const r=$('chatCard').getBoundingClientRect(),f=$('chat').getBoundingClientRect();return {x:chatPerch?.x==null?r.left+Math.round(r.width*.55):f.left+chatPerch.x,y:chatPerch===null?r.top+42:f.top+chatPerch.y+K,show:shown(r)};}
    if(p.kind==='pos')return {x:p.x,y:p.y,show:true};
    const r=tile.getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom,show:shown(r)};
  };
  const frame=(c,r)=>{sprite.style.backgroundPosition=(-c*S)+'px '+(-r*S)+'px';};
  // Ein Frame des Clips (i<0 zaehlt von hinten), oder der Clip zur Zeit t: im Kreis, oder einmal und dann stehen bleiben.
  let shifted='';
  const clip=(n)=>{if(n===shifted)return;shifted=n;const d=SHIFT[n]||[0,0];sprite.style.setProperty('--raven-shift-x',d[0]+'px');sprite.style.setProperty('--raven-shift-y',d[1]+'px');};
  const pose=(n,i=0)=>{const f=CLIPS[n].at(i);clip(n);frame(f[0],f[1]);};
  const play=(n,t,loop=true)=>{const L=len(n);let u=loop?((t%L)+L)%L:t;clip(n);for(const f of CLIPS[n]){if(u<f[2]){frame(f[0],f[1]);return;}u-=f[2];}pose(n,-1);};
  const face=(dir)=>{sprite.style.setProperty('--raven-dir',String(dir));};
  const setT=(px,py,lift,rot)=>{cur={x:px,y:py};wrap.style.transform='translate('+Math.round(px-S/2)+'px,'+Math.round(py-S+FEET-(lift||0))+'px)'+(rot?' rotate('+Math.round(rot)+'deg)':'');};
  const hideSay=()=>{say.hidden=true;say.className='';bubbleTill=0;};
  const showCloud=(on)=>{const show=on&&!still&&wrap.style.visibility!=='hidden';cloud.hidden=!show;if(show){cloud.style.left=Math.round(x-14)+'px';cloud.style.top=Math.round(y-S-24)+'px';}};
  // Konfetti aus dem Fortschrittsbalken, wenn alles gruen ist und er zu Hause angekommen ist.
  const burst=()=>{if(still||reduce)return;const bar=$('progress').getBoundingClientRect();if(bar.width===0)return;
    for(let i=0;i<28;i+=1){const bit=document.createElement('i');bit.className='confetti';bit.style.background=${JSON.stringify(CONFETTI)}[i%4];
      bit.style.left=Math.round(bar.left+Math.random()*bar.width)+'px';bit.style.top=Math.round(bar.top)+'px';
      bit.style.setProperty('--dx',Math.round((Math.random()-.5)*60)+'px');bit.style.setProperty('--up',Math.round(-30-Math.random()*50)+'px');
      bit.style.animationDelay=Math.round(Math.random()*200)+'ms';layer.append(bit);setTimeout(()=>bit.remove(),2000);}};
  const speak=(text,zz,ms)=>{if(still)return;say.textContent=text;say.className=zz?'zz':'';say.hidden=false;void say.offsetWidth;say.classList.add(zz?'float':'pop');bubbleTill=performance.now()+(ms||1300);placeSay();};
  // Die Blase haengt an der Sitzposition, in ganzen Pixeln, und bleibt im Fenster.
  const placeSay=()=>{
    const home=place.kind==='logo';let bx=home?x+S/2+6:x+S*0.4,by=home?y-S+2:y-S-26;
    bx=Math.min(Math.max(bx,4),innerWidth-say.offsetWidth-4);by=Math.max(by,4);
    say.style.left=Math.round(bx)+'px';say.style.top=Math.round(by)+'px';
  };
  const wanted=()=>{
    const list=spots(),n=list.length;
    if(still||homing||mood==='aborted'||n===0)return LOGO;
    const now=performance.now(),here=move?move.target:place;
    if(mood==='ask'){
      if(folded('chat'))return LOGO;
      if(here.kind!=='chat'&&now-askSince<ASK_DELAY){recheck=askSince+ASK_DELAY;return here;}
      return {kind:'chat'};
    }
    // Laeuft schon ein Schritt, gibt es dort etwas zu sehen: dann ohne Warten zurueck.
    if(here.kind==='chat'&&now-askEnd<LINGER&&!folded('chat')&&!list.some((spot)=>spotState(spot)==='running')){recheck=askEnd+LINGER;return here;}
    if(folded('steps'))return LOGO;
    // Jeder Punkt ist ein Ziel: der laufende, sonst der gescheiterte, sonst der erste offene. Nicht erreichte Punkte hinter einem
    // hergestellten Zustand sind keines, dann bleibt er auf dem letzten bestandenen.
    const states=list.map(spotState),open=states.findIndex((s)=>s!=='pass'&&s!=='skipped'),done=mood==='done'||open<0;
    const last=Math.max(0,states.lastIndexOf('pass')),running=states.lastIndexOf('running'),failed=states.indexOf('fail');
    if(!done)celebrated=false;
    if(done&&celebrated)return LOGO;
    return {kind:'step',i:done?(open<0&&mood!=='done'?last:n-1):running>=0?running:failed>=0?failed:open};
  };
  const condition=()=>{
    if(place.kind==='chat')return mood==='ask'?'ask':'';
    if(place.kind==='logo')return mood==='aborted'?'aborted':mood==='done'&&celebrated?'home':'';
    const list=spots(),spot=list[place.i];if(!spot)return '';
    const state=spotState(spot);
    if(state==='fail'||(mood==='fail'&&!list.some((other)=>spotState(other)==='fail')))return 'fail';
    return place.i===list.length-1&&(mood==='done'||list.every((other)=>spotState(other)==='pass'))?'done':'';
  };
  const label=()=>{toggle.checked=still||homing;document.body.classList.toggle('still',still);};
  const rest=()=>{homing=false;still=true;act=null;queue=[];hideSay();showCloud(false);label();};
  const wake=()=>{still=false;homing=false;lastKey='';nextIdle=performance.now()+600;label();update();};
  const update=()=>{want=wanted();kick();};
  toggle.addEventListener('change',()=>{kick();if(!toggle.checked){wake();pref('animations','on');return;}
    homing=true;act=null;queue=[];hideSay();label();pref('animations','off');
    // Mitten im Flug: von der aktuellen Stelle direkt ins Logo, ohne den Flug zu Ende zu fliegen.
    if(move){place={kind:'pos',x:cur.x,y:cur.y};move=null;settle=0;}
    if(reduce||place.kind==='logo'){place=LOGO;rest();}
    update();});
  const startAct=(a,now)=>{
    const name=typeof a==='string'?a:a.name;
    if(name==='home'){celebrated=true;update();return;}
    if(name==='confetti'){burst();return;}
    act={name,start:now,dur:IDLE[name][1],text:a.text};
    if(name==='caw')setTimeout(()=>{if(act&&act.name==='caw')speak(act.text||'caw!');},140);
    if(name==='doze')speak('z z z',true,IDLE.doze[1]);
    if(name==='hop')hideSay();
  };
  const pickIdle=(now)=>{
    const home=place.kind==='logo',waited=now-waitSince;
    // Die letzten zwei Aktionen kommen nicht gleich wieder, damit er abwechslungsreich bleibt.
    const pool=Object.entries(IDLE).filter(([n])=>n!=='feed'&&!recent.includes(n)&&(!home||AT_HOME.includes(n))).map(([n,[w]])=>[n,n==='doze'?(waited>9000?1.5:0):w]);
    let r=Math.random()*pool.reduce((sum,[,w])=>sum+w,0),pick='blink';
    for(const [n,w] of pool)if((r-=w)<0){pick=n;break;}
    recent=[pick,...recent].slice(0,2);return pick;
  };
  const startMove=(now)=>{
    const from=anchor(place),to=anchor(want),target=want;
    hideSay();showCloud(false);act=null;queue=[];cheering=false;
    if(reduce){place=target;lastKey='';return;}
    // Zwischen Schritten gezielt: ein, zwei Schritte ein Hopser, weiter ein flacher Flug geradewegs hin. Sonst (Logo, Chat)
    // fliegt er nicht quer ueber die Anwendung, sondern an der naechsten Seite aus dem Fenster und an der Seite des Ziels
    // wieder herein.
    const steps=place.kind==='step'&&target.kind==='step',d=steps?Math.abs(target.i-place.i):0;
    move={origin:place,from,to,target,start:now,steps,d,kind:steps?(d<=2?'hop':'glide'):'out',dir:to.x<from.x-2?1:-1};
    const side=(p)=>(p.x<innerWidth/2?-S*2:innerWidth+S*2);
    if(move.kind==='out'){move.exit={x:side(from),y:from.y-S*3};move.enter={x:side(to),y:to.y-S*3};
      const leg=(a,b)=>Math.min(900,Math.max(380,Math.hypot(b.x-a.x,b.y-a.y)*1.2));move.out=leg(from,move.exit);move.away=260;move.dur=move.out+move.away+leg(move.enter,to);}
    else move.dur=move.kind==='hop'?420+80*(d-1):360+70*Math.min(d,8);
  };
  // Start und Ziel in jedem Bild neu messen: Scrollt die Schrittliste oder verschiebt sich der Chat waehrend des Flugs, fliegt er mit,
  // statt zur alten Stelle zu fliegen und dort zu springen.
  const live=(p,fallback)=>(p.kind==='step'||p.kind==='chat'?anchor(p):fallback);
  const flying=(now)=>{
    const m=move,t=Math.min(1,(now-m.start)/m.dur),e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2,f=live(m.origin,m.from),g=live(m.target,m.to),lean=m.dir<0?1:-1;
    wrap.style.visibility='';face(m.dir);
    if(m.kind==='hop'){
      // Geradewegs zum Ziel, nur ein kleiner Bogen nach oben.
      setT(f.x+(g.x-f.x)*e,f.y+(g.y-f.y)*e,Math.sin(Math.PI*t)*S*.45,lean*Math.sin(Math.PI*t)*8);
      if(t<.12||t>.9)pose('peck');else pose('fly',t<.5?0:-1);
    }else if(m.kind==='glide'){
      setT(f.x+(g.x-f.x)*e,f.y+(g.y-f.y)*e,Math.sin(Math.PI*t)*S*.3,0);
      play('fly',now);
    }else{
      // Hinaus, kurz weg, an der Seite des Ziels wieder herein. Raus beschleunigt er, rein bremst er.
      const u=now-m.start,inn=m.dur-m.out-m.away;
      if(u<m.out){const k=u/m.out,a=k*k;face(m.exit.x<f.x?1:-1);setT(f.x+(m.exit.x-f.x)*a,f.y+(m.exit.y-f.y)*a,0,lean*-8);}
      else if(u<m.out+m.away){wrap.style.visibility='hidden';}
      else{const k=Math.min(1,(u-m.out-m.away)/inn),b=1-(1-k)*(1-k);face(g.x<m.enter.x?1:-1);setT(m.enter.x+(g.x-m.enter.x)*b,m.enter.y+(g.y-m.enter.y)*b,0,0);}
      play('fly',now);
    }
    if(t>=1){place=m.target;move=null;lastKey='';waitSince=now;nextIdle=now+3000+Math.random()*4000;}
  };
  const perched=(now)=>{
    const p=anchor(place);x=p.x;y=p.y;wrap.style.visibility=p.show?'':'hidden';
    face(-1);
    if(still){pose('idle');setT(x,y);return;}
    const c=condition(),key=place.kind+(place.i??'')+':'+c;
    // Weniger Bewegung: kein Huepfen, Drehen oder Picken; nur die Blase sagt, was los ist.
    if(reduce){if(key!==lastKey){lastKey=key;const said=c?REACT[c].find((a)=>a.text):null;if(said)speak(said.text);}pose('idle');setT(x,y);return;}
    if(key!==lastKey){lastKey=key;if(c){act=null;queue=REACT[c].slice();}
      // Der erste Punkt nach dem Einflug: Er gruesst einmal.
      else if(!greeted&&place.kind==='step'){greeted=true;act=null;queue=REACT.greet.slice();}}
    showCloud(c==='fail');
    if(!act){if(queue.length)startAct(queue.shift(),now);else if(!reduce&&now>nextIdle&&c!=='done')startAct(pickIdle(now),now);}
    let lift=0;const a=act;
    if(!a){if(c==='fail')pose('sad',-1);else play('idle',now);}
    else{
      const t=now-a.start;
      // Einmal kurz zurueckblicken, nicht hin und her.
      if(a.name==='look'){pose('idle');if(t>200&&t<700)face(1);}
      else if(a.name==='feed'){if(t<240)pose('idle');else play('peck',t-240);}
      else if(a.name==='hop'){if(t>=80&&t<=440){pose('fly');lift=Math.sin(Math.PI*(t-80)/360)*S/3;}else pose('peck');}
      // Einmal: blink, caw, puff, joy, sigh; im Kreis, solange die Handlung dauert: peck, doze, wave, nod.
      else if(['blink','caw','puff','joy','sigh'].includes(a.name))play(a.name,t,false);
      else if(CLIPS[a.name])play(a.name,t);
      // Animationen nur ab und zu: zwischen zwei Handlungen sitzt er ein paar Sekunden ruhig da (idle atmet weiter).
      if(t>=a.dur){act=null;nextIdle=now+5000+Math.random()*7000;if(queue.length===0)cheering=false;}
    }
    setT(x,y,lift);
  };
  const loop=(now)=>{
    if(!move&&!same(place,want)&&want.kind==='step'&&cheering&&(act!==null||queue.length>0)){/* erst die zwei Huepfer zu Ende */}
    else if(!move&&!same(place,want)){
      const ahead=place.kind==='step'&&want.kind==='step'&&want.i>place.i;
      if(!settle)settle=now+(reduce?0:ahead?SETTLE:80);
      if(now>=settle){settle=0;startMove(now);}
    }else if(!move)settle=0;
    if(recheck&&now>=recheck){recheck=0;update();}
    if(homing&&!move&&place.kind==='logo')rest();
    if(move)flying(now);else perched(now);
    wrap.classList.toggle('home',!move&&place.kind==='logo');
    document.body.classList.toggle('raven-away',move!==null||place.kind!=='logo');
    if(bubbleTill&&now>bubbleTill)hideSay();
    if(!say.hidden)placeSay();
    // Still im Logo gibt es nichts zu bewegen: Die Schleife ruht, bis sich etwas aendert (wake, update, Fenstergroesse).
    if(still&&!homing&&!move&&place.kind==='logo'&&same(want,LOGO)&&say.hidden){looping=false;return;}
    requestAnimationFrame(loop);
  };
  let looping=true;
  const kick=()=>{if(!looping){looping=true;requestAnimationFrame(loop);}};
  addEventListener('resize',kick);
  motion.addEventListener?.('change',(event)=>{reduce=event.matches;lastKey='';kick();});
  // Klick: Herzchen. Doppelklick: ein Kruemel, er pickt und plustert sich. Nach jeder dritten Fuetterung bedankt er sich.
  const pet=()=>{
    // Auf das 2-px-Raster der Pixelkunst: Sonst landen die Pixel bei krummem Zoom auf halben Geraetepixeln und das Herz wirkt verzerrt.
    const grid=(v)=>Math.round(v/2)*2;
    for(let i=0;i<3;i+=1){const heart=document.createElement('i');heart.className='heart';heart.style.left=grid(x-7+(i-1)*12)+'px';heart.style.top=grid(y-S-14-(i%2)*6)+'px';heart.style.animationDelay=(i*120)+'ms';layer.append(heart);setTimeout(()=>heart.remove(),1400);}
    if(!act)queue.unshift('blink');
  };
  const feed=()=>{
    const crumb=document.createElement('i');crumb.className='crumb';crumb.style.left=Math.round(x+13)+'px';crumb.style.top=Math.round(y-4)+'px';layer.append(crumb);setTimeout(()=>crumb.remove(),1000);
    act=null;hideSay();queue=['feed','puff'];
    fed+=1;pref('fed',String(fed));
    if(fed%3===0)queue.push({name:'caw',text:'caw!'});
  };
  const busy=()=>still||homing||move!==null||place.kind==='logo';
  wrap.addEventListener('click',()=>{if(busy())return;clearTimeout(clickTimer);clickTimer=setTimeout(pet,240);});
  wrap.addEventListener('dblclick',()=>{if(busy())return;clearTimeout(clickTimer);feed();});
  label();pose('idle');face(-1);
  requestAnimationFrame(loop);
  return {
    update,
    mood:(value)=>{if(value==='ask'&&mood!=='ask'){askSince=performance.now();if(document.body.classList.contains('fold-chat'))fold('chat',false,false);}
      else if(value!=='ask'&&mood==='ask')askEnd=performance.now();if(value==='wait')mood=null;else if(['ask','fail','done','aborted'].includes(value))mood=value;else return;if(value!=='aborted')aborted=false;update();},
    reset:()=>{mood=null;celebrated=false;greeted=false;lastKey='';update();},
    // Ein Schritt ist bestanden und er sitzt darauf: zwei kleine Huepfer, dann weiter.
    cheer:(li)=>{if(still||reduce||move||place.kind!=='step')return;const spot=spots()[place.i];if(!spot||groupOf(spot)!==li)return;act=null;queue=['hop','hop'];cheering=true;kick();},
    // Eine Nachricht vom Menschen: Er nickt, ohne Zeichen.
    nod:()=>{if(still||reduce||move)return;act=null;queue.unshift('nod');kick();},
  };
})();
const makeIcon=(cls)=>{const icon=document.createElement('span');icon.className=cls;icon.setAttribute('role','img');icon.setAttribute('aria-label',LABELS.waiting);return icon;};
const setState=(node,stateName,note)=>{const label=LABELS[stateName]??stateName,own=groupOf(node)===node;node.dataset.state=stateName;node.setAttribute('aria-label',node.dataset.label+' – '+label);
  node.querySelector(own?':scope>.head [role=img]':'[role=img]').setAttribute('aria-label',label);
  if(note!==undefined||stateName!=='fail'){const text=node.querySelector(own?':scope>.head .text':'.text');text.querySelector(':scope>.note')?.remove();
    if(note){const div=document.createElement('div');div.className='note';div.textContent=note;div.title=note;text.append(div);}}};
const showMs=(node,ms)=>{const cell=node.querySelector(groupOf(node)===node?':scope>.head .ms':'.ms');if(ms===undefined){cell.textContent='';delete node.dataset.ms;}else{cell.textContent=duration(ms);node.dataset.ms=String(Math.round(ms));}};
const makePoint=(p)=>{const li=document.createElement('li');li.dataset.id=p.id;li.dataset.state='waiting';if(p.kind)li.dataset.kind=p.kind;li.dataset.label=((p.kind?p.kind+' ':'')+(p.label??'')).trim();li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const text=document.createElement('span');text.className='text';if(p.kind){const kind=document.createElement('span');kind.className='kind';kind.textContent=p.kind;text.append(kind);}
  const name=document.createElement('span');name.className='name';name.textContent=p.label??'';text.append(name);
  const ms=document.createElement('span');ms.className='ms';li.append(makeIcon('pt-icon'),text,ms);return li;};
const makeGroup=(g)=>{const li=document.createElement('li');const phase=g.kind==='phase';li.dataset.id=g.id;li.dataset.kind=phase?'phase':'step';li.dataset.name=g.name;li.dataset.state='waiting';li.dataset.label=(phase?'':g.id+' ')+g.name;li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const head=document.createElement('div');head.className='head';head.append(makeIcon('step-icon'));
  if(!phase){const id=document.createElement('span');id.className='id';id.textContent=g.id;head.append(id);}
  const text=document.createElement('span');text.className='text';const name=document.createElement('span');name.className='name';name.textContent=g.name;text.append(name);
  const ms=document.createElement('span');ms.className='ms';head.append(text,ms);
  const pts=document.createElement('ol');pts.className='pts';pts.append(...(g.points??[]).map(makePoint));li.append(head,pts);return li;};
// Der aktuelle Punkt bleibt immer im Bild: laufend, sonst gescheitert, sonst der erste offene; er steht im oberen Drittel.
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
window.workbench={
  facts:(entries)=>{$('facts').replaceChildren(...entries.map(([label,value])=>{const li=document.createElement('li');li.className='pa-chip';li.title=label+': '+value;const span=document.createElement('span');span.className='pa-chip__label';span.textContent=label;li.append(span,String(value));return li;}));},
  url:(url)=>{appUrl=url;$('url').textContent=url;$('url').title=url;},
  steps:(groups)=>{aborted=false;raven.reset();$('steps').replaceChildren(...groups.map(makeGroup));if(groups.length>0)showSteps();summarize();},
  // Eine Gruppe dazu oder neu benannt, etwa „Fehler klären“, wenn Claude untersucht. Bestehende Punkte bleiben.
  group:(def)=>{const known=items().find((li)=>li.dataset.id===def.id);if(known){known.dataset.name=def.name;known.querySelector(':scope>.head .name').textContent=def.name;for(const point of def.points??[])if(!pointsOf(known).some((li)=>li.dataset.id===point.id))known.querySelector(':scope>.pts').append(makePoint(point));}else $('steps').append(makeGroup(def));summarize();},
  step:(id,stateName,note)=>{for(const li of items()){if(li.dataset.id===id){setState(li,stateName,note);
      if(stateName==='running'){if(!li.dataset.t0)li.dataset.t0=String(performance.now());}else if((stateName==='pass'||stateName==='fail')&&li.dataset.t0){showMs(li,performance.now()-Number(li.dataset.t0));delete li.dataset.t0;}else if(stateName==='waiting'){showMs(li);delete li.dataset.t0;}
      // Der Schritt nimmt seine Punkte mit: bestanden heisst alle gelaufen, gescheitert trifft den laufenden, offen setzt alle zurueck.
      for(const point of pointsOf(li)){const s=point.dataset.state;
        if(stateName==='pass'&&s!=='pass'&&s!=='fail'){setState(point,'pass');point.querySelector('.live')?.remove();}
        else if(stateName==='fail'&&s==='running'){setState(point,'fail');point.querySelector('.live')?.remove();}
        else if(stateName==='waiting'){setState(point,'waiting');showMs(point);point.querySelector('.live')?.remove();}}
      if(stateName==='pass'&&li.dataset.kind!=='phase')raven.cheer(li);}
    else if(stateName==='running'&&li.dataset.state==='running'&&li.dataset.kind!=='phase')window.workbench.step(li.dataset.id,'pass');}summarize();},
  // Ein Punkt einer Gruppe; unbekannt kommt er ans Ende. ms: Dauer vom Host, live: was gerade passiert, note: warum gescheitert.
  point:(groupId,id,stateName,opts={})=>{const li=items().find((node)=>node.dataset.id===groupId);if(!li)return;
    let point=pointsOf(li).find((node)=>node.dataset.id===id);
    if(!point){point=makePoint({id,label:opts.label??'',kind:opts.kind});li.querySelector(':scope>.pts').append(point);}
    else if(opts.label!==undefined){point.querySelector('.name').textContent=opts.label;point.dataset.label=((point.dataset.kind?point.dataset.kind+' ':'')+opts.label).trim();}
    if(stateName==='running')for(const other of pointsOf(li))if(other!==point&&other.dataset.state==='running'){setState(other,'pass');other.querySelector('.live')?.remove();}
    setState(point,stateName,opts.note);
    if(opts.ms!==undefined)showMs(point,opts.ms);else if(stateName==='waiting'||stateName==='running')showMs(point);
    point.querySelector('.live')?.remove();
    if(stateName==='running'&&opts.live){const live=document.createElement('span');live.className='live';live.textContent=opts.live;point.querySelector('.text').append(live);}
    // Eine Phase steht so, wie ihre Punkte stehen.
    if(li.dataset.kind==='phase'){const states=pointsOf(li).map((node)=>node.dataset.state);
      setState(li,states.includes('fail')?'fail':states.length>0&&states.every((s)=>s==='pass')?'pass':states.some((s)=>s==='running'||s==='pass')?'running':'waiting');
      const sum=pointsOf(li).reduce((total,node)=>total+Number(node.dataset.ms||0),0);showMs(li,li.dataset.state==='pass'||li.dataset.state==='fail'?sum:undefined);}
    summarize();},
  panels:(data)=>{state.requests=data.requests;state.console=data.console;const fails=data.console.filter((c)=>c.severity==='fail').length;setCount('requests',data.requests.length);setCount('console',data.console.length,fails>0);const fresh=fails>seenFails;seenFails=fails;if(fresh&&state.tab===null)select('console');else render();},
  // Stimmung des Raben: wait (auf dem aktuellen Schritt), fail, done (Jubel, dann ins Logo), aborted (ins Logo, doesen), ask (zum Chat).
  mood:(value)=>{if(value==='aborted')aborted=true;if(value==='ask')asking=true;else if(['wait','fail','done','aborted'].includes(value))asking=false;if(value==='fail')showSteps();raven.mood(value);summarize();},
  // Der Zustand des Chats, etwa showing: Dann zeigt die Leiste der Anwendung, dass aufgenommen wird.
  chatState:(value)=>{chatState=typeof value==='string'?value:null;summarize();},
  // Aktualisieren geht nur, wenn der Host es erlaubt; sonst ist der Knopf gesperrt.
  refreshable:(on)=>{refreshOn=on===true;$('reload').disabled=!refreshOn||refreshing;$('reload').title=refreshOn?REFRESH_TITLE:T['workbench.page.refreshLockedTitle'];},
  nod:()=>raven.nod(),
  // Nach dem Neuladen steht die Seite nicht mehr sicher auf dem Zustand des Laufs; „Zustand neu herstellen“ holt ihn zurueck.
  left:(on,text)=>{document.body.classList.toggle('left-state',on);const box=$('leftNote');box.hidden=!on;const title=document.createElement('strong');title.textContent=T['workbench.page.pageReloaded'];box.replaceChildren(title,text||'');summarize();},
};
// Die Anwendung haelt sich oft selbst fuer das oberste Fenster (top.Ext, parent.config, top.location.href). Darum reicht die Werkbank
// globale Namen der Anwendung durch, die sie selbst nicht hat, und ihre Adresse folgt der Anwendung. Gleicher Origin macht beides moeglich.
const forwarded=new Set();
const appWindow=()=>{try{return $('app').contentWindow;}catch{return null;}};
const forward=()=>{const app=appWindow();if(!app)return;let names;try{names=Object.getOwnPropertyNames(app);}catch{return;}
  for(const name of names){if(forwarded.has(name)||name in window)continue;
    try{Object.defineProperty(window,name,{configurable:true,get(){try{return appWindow()?.[name];}catch{return undefined;}},set(value){try{appWindow()[name]=value;}catch{}}});forwarded.add(name);}catch{}}};
const mirror=()=>{try{const href=appWindow()?.location.href;if(href&&/^https?:/.test(href)&&href!==location.href&&new URL(href).origin===location.origin)history.replaceState(history.state,'',href);}catch{}};
$('app').addEventListener('load',()=>{forward();mirror();});
// Die Adresse folgt Routenwechseln der Anwendung (pushState) schnell und billig. Spaet angelegte globale Namen der Anwendung reichen
// alle halbe Sekunde: Das Durchlaufen aller Namen kostet etwa eine Millisekunde.
setInterval(mirror,400);
setInterval(forward,500);
forward();mirror();
summarize();${sourceTag}</script></body></html>`;
};

/**
 * Oeffnet die Werkbank im ersten Tab und laedt darin die Anwendung. Vorher: angemeldet, lokaler Code eingespielt.
 * @param hosts  Hosts, deren Dokumente sich einbetten lassen duerfen: die der Anwendung
 * @returns { page, view, show } `view` ist die Anwendung im iframe mit der Schnittstelle einer Seite
 */
export const openWorkbench = async (context, { appUrl, hosts, title = 'caw-ai', rewrite }) => {
    const page = context.pages()[0];
    // Nur die Werkbank selbst darf speichern und aktualisieren, nicht die Anwendung im iframe und nicht der Chat. Die Werte prueft writePref.
    let bench = benches.get(page);
    if (bench === undefined) {
        const holder = { refresh: null, rebuild: null, html: null, chat: null };
        bench = holder;
        benches.set(page, holder);
        // Die Werkbank liegt auf der Adresse der Anwendung: Nur das Dokument des obersten Fensters beantwortet das Tool.
        // Einstellungen frisch je Auslieferung, damit ein Neuladen zeigt, was zuletzt gewaehlt war.
        await interceptDocuments(context, page, hosts, { workbench: (url) => holder.html(url), request: context.request, rewrite });
        await context.addInitScript(FOCUS_SCRIPT);
        await context.addInitScript(RELOAD_SCRIPT);
        // Ein neues Dokument im obersten Fenster ist immer eine neu ausgelieferte Werkbank: F5, Knopf der Adressleiste oder die
        // Anwendung selbst (top.location, Formular mit target=_top). Sprung im Dokument (replaceState) zaehlt nicht.
        // Der Chat dieses Dokuments: das zweite iframe der Werkbank (nach der Anwendung), angelegt vom Parser. Zu diesem Zeitpunkt hat
        // die Anwendung noch kein Skript ausgefuehrt; was sie spaeter anlegt oder umbenennt, ist nie der Chat.
        page.on('domcontentloaded', () => {
            holder.chat = page.mainFrame().childFrames()[1] ?? null;
            holder.rebuild?.();
        });
        await page.exposeBinding(PREF_BINDING, ({ frame }, key, value) => {
            if (frame !== page.mainFrame()) return;
            try {
                writePref(key, value);
            } catch {
                // unbekannter Wert oder nicht schreibbar: bleibt fuer diesen Lauf
            }
        });
        // true: Der Host hat neu geladen. false: gesperrt, der Test laeuft.
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
    const view = frameView(page, frame);
    const call = (name, ...args) => page.evaluate(([fn, values]) => window.workbench?.[fn](...values), [name, args]).catch(() => {});
    // Was der Host gezeigt hat, merkt er sich: Nach dem Neuladen der Werkbank stellt er es wieder her.
    const shown = { facts: null, steps: null, states: new Map(), points: new Map(), url: null, mood: null, left: null, chatState: null };
    // Wann ein Punkt zu laufen begann: Die Dauer misst der Host, so steht sie auch nach dem Neuladen der Werkbank.
    const started = new Map();
    // Der Schritt, der zuletzt anlief: Dort landen Claudes Aktionen beim Aufnehmen.
    let runningStep = null;
    const reloads = new Set();
    let rebuilding = null;
    // Kommt waehrend des Wiederherstellens schon das naechste Dokument (zweimal F5, eine Weiterleitungskette per top.location), stellt
    // ein zweiter Durchgang danach auch dieses her. Sonst bliebe dort der Platzhalter des Chats stehen, und niemand koennte antworten.
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
            await call('refreshable', bench.refresh !== null);
            // Neu geladen hat der Mensch (F5, Knopf des Browsers) oder die Anwendung selbst (top.location, Formular mit target=_top).
            // Nur das erste stoert einen laufenden Test; das zweite gehoert zum Verhalten der Anwendung.
            // Unbekannt (das Dokument ist schon wieder weg, eine Kette von top.location): Der naechste Durchgang entscheidet; gibt es keinen,
            // zaehlt es nicht als Mensch. Nur reload und back_forward macht ein Mensch.
            const type = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type ?? null).catch(() => null);
            if (type === null && again) return;
            const human = type === 'reload' || type === 'back_forward';
            // Erst der Chat, dann wer sonst wissen muss, dass die Seite neu ist (etwa das Entwickeln).
            for (const listener of [...reloads]) await Promise.resolve(listener({ human })).catch(() => {});
        } catch {
            // Fenster zu oder Seite woanders hin: nichts mehr wiederherzustellen
        }
    };
    return {
        page,
        view,
        chatFrame: () => bench.chat,
        facts: (items) => {
            shown.facts = items;
            return call('facts', items);
        },
        /**
         * Die Gruppen der Schrittliste: { id, name, kind?: 'phase', points?: [{ id, kind, label }] }. Die Vorbereitung bleibt vorn,
         * sie steht schon, bevor der Lauf seine Schritte kennt.
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
        /** Der Schritt, der gerade laeuft, oder null. */
        running: () => runningStep,
        /** Eine Gruppe dazu, etwa „Fehler klären“; gibt es sie schon, kommen nur neue Punkte dazu. */
        group: (def) => {
            const list = shown.steps ?? [];
            const at = list.findIndex(({ id }) => id === def.id);
            shown.steps = at < 0 ? [...list, def] : list.map((known, index) => (index === at ? { ...known, name: def.name, points: [...(known.points ?? []), ...(def.points ?? []).filter((point) => !(known.points ?? []).some(({ id }) => id === point.id))] } : known));
            return call('group', def);
        },
        /**
         * Ein Punkt einer Gruppe. Laeuft er an, beginnt seine Dauer; bestanden oder gescheitert zeigt sie.
         * @param opts { label, kind, live, note, ms }
         */
        point: (group, id, state, opts = {}) => {
            const key = `${group}|${id}`;
            const now = Date.now();
            if (state === 'running' && !started.has(key)) started.set(key, now);
            // Wie auf der Seite: Laeuft ein Punkt an, ist der vorige derselben Gruppe fertig.
            if (state === 'running') {
                for (const [other, entry] of shown.points) {
                    if (other === key || entry[0] !== group || entry[2] !== 'running') continue;
                    const { live, ...rest } = entry[3];
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
            // Wie auf der Seite: Der Schritt nimmt seine Punkte mit, damit ein Neuladen dasselbe zeigt.
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
        /** Der Zustand des Chats (running, showing, deciding ...): Kopfzeile und Leiste der Anwendung zeigen, was er vom Menschen will. */
        chatState: (state) => {
            shown.chatState = state;
            return call('chatState', state);
        },
        /** Eine Nachricht vom Menschen ist angekommen: Der Rabe nickt. */
        nod: () => call('nod'),
        /** Die Seite steht nicht mehr sicher auf dem Zustand des Laufs (true, mit Text) oder wieder darauf (false). */
        left: (on, text = '') => {
            shown.left = on ? [true, text] : null;
            return call('left', on, text);
        },
        /** Wer Aktualisieren ausfuehrt; null: gesperrt, der Test laeuft. */
        onRefresh: (handler) => {
            bench.refresh = handler ?? null;
            return call('refreshable', bench.refresh !== null);
        },
        /**
         * Nach dem Neuladen der ganzen Werkbank, wenn Schritte und Zaehler wieder stehen. Der Listener bekommt { human }: true bei
         * F5 oder Zurueck des Menschen, false, wenn die Anwendung das oberste Fenster selbst navigiert hat. @returns zum Abmelden
         */
        onReload: (listener) => {
            reloads.add(listener);
            return () => reloads.delete(listener);
        },
        panels: (data) => call('panels', { requests: data.requests.slice(-MAX_ROWS), console: data.console.slice(-MAX_ROWS) }),
        PANEL_MS,
    };
};
