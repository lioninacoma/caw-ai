// Die Werkbank: eine Seite fuer den ganzen Lauf im Stil einer Konsole. Links Schritte mit Start-Log-Marken, in der Mitte die
// Anwendung im iframe mit Requests und Konsole darunter, rechts der Chat. Unten die F-Tasten. Der Chat ist ein eigenes Dokument
// (srcdoc), seine Seite bleibt die aus chat.mjs.
//
// Aussehen und Zeichen kommen aus dem aktiven Theme-Paket (src/shared/theme-package.mjs): Farben, Marken, Spinner, Baum, Fortschritt,
// Legenden, Rabe. Das Logo ist der ASCII-Rabe: Er blinzelt ab und an, ein Klick schickt Herzen hoch. Er fliegt nicht mehr.
// F7 waehlt und bearbeitet Themes (eingebaute bleiben, wie sie sind; die erste Aenderung legt eine eigene Kopie an), F8 zeigt nur die
// Anwendung im Vollbild, F10 haelt alles still.
//
// Aktualisieren (F5) laedt nach der Uebergabe die aktuelle Seite der Anwendung ohne Cache neu; Chat und Schritte bleiben, die
// Schritte zeigen danach „Zustand verlassen“. Solange der Test laeuft, ist Neuladen gesperrt: Es wuerde den Zustand fuer die
// folgenden Schritte verfaelschen. Laedt jemand die ganze Werkbank neu, baut der Host sie wieder auf. F11 und F12 bleiben bei Chrome.
//
// Die Anwendung teilt den Origin mit der Werkbank (top.Ext & Co.), nicht mit dem Chat: Der liegt sandboxed in einem opaken Origin,
// und der Host kennt ihn als den Frame, den die Werkbank beim Laden angelegt hat, nie ueber seinen Namen. Ein nachgebautes iframe
// namens caw-chat spricht darum nicht als Mensch. Aktualisieren darf die Anwendung ausloesen (F5 in ihr meldet sich ohnehin), es
// greift erst nach der Uebergabe. Themes speichern darf nur die Werkbank selbst, und nur, was das Schema besteht (nie CSS, nie Dateien).

import { APP_FRAME, CHAT_FRAME_NAME, FOCUS_SCRIPT, RELOAD_SCRIPT, frameView, interceptDocuments, sourceTag } from './app-view.mjs';
import { language, t, texts } from '../shared/i18n.mjs';
import { readPrefs, writePref } from '../shared/prefs.mjs';
import { LONG_NAME } from '../shared/raven.mjs';
import { BUILTIN_THEMES, THEME_KEYS, activeTheme, deleteTheme, listThemes, loadTheme, readThemePackage, renameTheme, saveTheme } from '../shared/theme-package.mjs';
import { APPLY_THEME_SCRIPT, CONSOLE_CSS, FAVICON, GLYPH_SCRIPT, RAVEN_CSS, RAVEN_SCRIPT, clientTheme, ravenLogo, themeAttr, themeCss, themeStyle } from './theme.mjs';

export const CHAT_FRAME = CHAT_FRAME_NAME;
export const PREF_BINDING = 'cawPref';
export const REFRESH_BINDING = 'cawRefresh';
export const THEME_BINDING = 'cawTheme';
/** Nur Anwendung (F8): das Fenster ins Vollbild oder zurueck. */
export const FULLSCREEN_BINDING = 'cawFullscreen';
/** Zustand waehlen (F1): einen Test bis zu einem Schritt herstellen. */
export const STATE_BINDING = 'cawState';
/**
 * Der Chat laeuft in einem sandboxed iframe ohne allow-same-origin, also mit eigenem, opakem Origin. Die Werkbank teilt sich den
 * Origin mit der Anwendung (damit top.Ext & Co. gehen). Ohne die Sandbox koennte die Anwendung den Chat erreichen und als Mensch
 * entscheiden, etwa eine Aenderung uebernehmen. So erreicht sie weder sein DOM noch sein Binding.
 */
export const CHAT_SANDBOX = 'allow-scripts allow-forms';
/** Tasten, die der Chat an die Werkbank weiterreichen darf. Mehr loest eine Nachricht aus dem Chat nicht aus. */
export const CHAT_KEYS = ['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F10'];
const RELOADED_MS = 15000;
/** Die Gruppe der Vorbereitung: Chrome, Anmelden, lokaler Code, Laden. */
export const PREP = 'prep';
const PANEL_MS = 1000;
const MAX_ROWS = 300;
// Ein Binding laesst sich je Seite nur einmal anlegen; je Seite merkt sich der Host, wer gerade aktualisiert.
const benches = new WeakMap();

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
/** JSON fuer ein <script>: `<` kann es nicht beenden. */
const json = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
/** Eine Legende des Themes, etwa ┤ SCHRITTE ├. */
const legend = (theme, title) => esc(String(theme.legend ?? '┤ {title} ├').replace('{title}', title));

/** Der Platzhalter im Chat-Frame, bis der Chat kommt. In der aktuellen Sprache und im aktiven Theme, darum erst beim Gebrauch. */
const chatPlaceholder = (theme = activeTheme()) => `<!doctype html><html lang="${language()}"${themeAttr(theme)}><meta charset="utf-8"><title>${t('workbench.chat')}</title><script>${APPLY_THEME_SCRIPT}
addEventListener('message',(event)=>{if(event.source===parent&&event.data?.caw==='theme')cawApplyTheme(document.documentElement,event.data.theme);});try{parent.postMessage({caw:'theme-request'},'*');}catch{}${sourceTag}</script><style>${themeCss(theme)}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--pane);color:var(--muted)}
header{padding:10px 14px;border-bottom:2px solid var(--line);font:400 20px/1 var(--font-crt);color:var(--claude)}
p{flex:1;display:grid;place-items:center;margin:0;padding:24px;text-align:center;font:var(--fs-body)/1.5 var(--font-body)}</style>
<header>${esc(theme.prompt?.claude ?? 'claude>')}</header><p>${t('workbench.chatPlaceholder')}</p></html>`;

/** Die Themes fuer den Dialog, je mit ihren Farben fuer das Muster. */
export const themeList = (env = process.env) => listThemes(env).map((entry) => ({ ...entry, colors: loadTheme(entry.name, env)?.colors }));

/**
 * Was der Theme-Dialog der Werkbank tun darf: waehlen, speichern (nur eigene, nur was das Schema fuer die Seite erlaubt), loeschen,
 * umbenennen. Die Wahl steht in prefs.json. @returns das Theme, das danach gilt
 */
export const themeAction = (action, payload, env = process.env) => {
    const chosen = () => readPrefs(env).theme;
    if (action === 'use') {
        if (readThemePackage(payload, env) === undefined) throw new Error(`${payload}?`);
        writePref('theme', payload, env);
        return loadTheme(payload, env);
    }
    if (action === 'save') {
        saveTheme(payload, env);
        writePref('theme', payload.name, env);
        return loadTheme(payload.name, env);
    }
    if (action === 'delete') {
        const pkg = readThemePackage(payload, env);
        deleteTheme(payload, env);
        if (chosen() === payload) writePref('theme', BUILTIN_THEMES.includes(pkg?.base) ? pkg.base : BUILTIN_THEMES[0], env);
        return activeTheme(env);
    }
    if (action === 'rename') {
        renameTheme(payload?.from, payload?.to, env);
        if (chosen() === payload.from) writePref('theme', payload.to, env);
        return activeTheme(env);
    }
    throw new Error(`${action}?`);
};

/**
 * Die Seite der Werkbank. `appUrl` laedt das iframe, alles Weitere setzt der Host per `window.workbench`.
 * @param prefs   persoenliche Einstellungen: animations 'on' | 'off', steps und chat 'open' | 'closed'
 * @param theme   das aktive Theme (aufgeloest); ohne: activeTheme()
 * @param themes  die Liste fuer den Dialog (listThemes); ohne: eingebaute und eigene
 */
export const workbenchHtml = ({ appUrl, title, prefs = {}, theme = activeTheme(), themes = themeList() }) => {
    const still = prefs.animations === 'off';
    const classes = [still ? 'still' : '', prefs.steps === 'closed' ? 'fold-steps' : '', prefs.chat === 'closed' ? 'fold-chat' : ''].filter(Boolean).join(' ');
    const refreshTitle = t('workbench.refreshTitle');
    const test = String(title ?? '').replace(/^caw-ai\s*·?\s*/, '');
    const key = (name, label, attrs = '', cls = '') => `<button type="button" class="fk${cls}"${attrs}><b>${name}</b>${label}</button>`;
    const lg = (label) => `<span class="lg glow" data-title="${esc(label.toUpperCase())}">${legend(theme, label.toUpperCase())}</span>`;
    return `<!doctype html><html lang="${language()}"${themeAttr(theme)}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FAVICON}<style>
${themeCss(theme)}${CONSOLE_CSS}${RAVEN_CSS}
*,*::before,*::after{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--page);color:var(--text);font:var(--fs-body)/1.45 var(--font-body)}
button,input{font:inherit;color:inherit}
.pa{height:100vh;padding:10px;display:flex}
#bench{flex:1;min-width:0;display:flex;flex-direction:column;padding:10px 16px 0;box-shadow:inset 0 0 0 2px #000,inset 0 0 60px rgba(0,0,0,.6)}
.top{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding-bottom:10px;border-bottom:2px solid var(--line)}
.id{display:flex;flex-direction:column;gap:2px;min-width:0}
.id b{font:400 28px/1 var(--font-crt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.id b .cmd{color:var(--info)}
.id>span{color:var(--muted);font-size:12px}
.facts{display:flex;gap:4px 18px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin:0;padding:0;list-style:none;min-width:0;flex:1 1 220px}
.facts li{white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.facts b{color:var(--text);font-weight:500;margin-left:6px}
.tools{margin-left:auto;display:flex;align-items:center;gap:10px}
#state{display:none}#state.on{display:inline-flex}.px-pill--claude,#stateSpin.px-pill--claude{color:var(--claude)}
#stateSpin{font:400 20px/1 var(--font-crt);color:var(--info)}#stateSpin[hidden]{display:none}
#notice{font:400 19px/1 var(--font-crt);color:var(--warn)}#notice[hidden]{display:none}
.panes{flex:1;min-height:0;display:grid;gap:14px;padding:20px 0 14px;
--col-steps:minmax(270px,320px);--col-chat:minmax(300px,380px);grid-template-columns:var(--col-steps) minmax(0,1fr) var(--col-chat);grid-template-rows:minmax(0,1fr);
grid-template-areas:"steps browser chat"}
.win{display:flex;flex-direction:column}
.pa-steps{grid-area:steps;padding:16px 12px 10px}
.pa-browser{grid-area:browser;padding:16px 10px 10px}
.pa-chat{grid-area:chat;padding:14px 0 0}
.fold{position:absolute;top:-13px;right:10px;z-index:3;border:0;cursor:pointer;background:var(--screen);color:var(--accent);font:400 22px/1 var(--font-crt);padding:0 6px}
.fold:hover{color:var(--text)}
.strip{display:none;border:0;cursor:pointer;background:none;color:var(--muted);font:400 22px/1 var(--font-crt);writing-mode:vertical-rl;padding:10px 0;align-items:center;gap:10px;width:100%;height:100%}
.strip:hover{color:var(--text);background:var(--pane-2)}.strip b{font-weight:400;color:var(--accent)}
#gauge{margin:2px 0 8px}#gauge:empty{display:none}
.left-state #steps,.left-state #gauge{opacity:.45}
#leftNote{margin:4px 0 8px;padding:8px 10px;font-size:13px;line-height:1.45;color:var(--muted);background:var(--screen);box-shadow:inset 0 0 0 2px var(--line)}#leftNote[hidden]{display:none}
#leftNote strong{display:block;margin-bottom:3px;font:400 19px/1 var(--font-crt);color:var(--warn)}
.hint{margin:6px 0;font-size:var(--fs-small);color:var(--faint)}#stepsHint[hidden]{display:none}
/* Die Liste scrollt von selbst mit dem aktuellen Punkt, darum ohne Scrollbalken. Mausrad geht weiter. */
#track{flex:1;min-height:0;overflow:auto;scrollbar-width:none}#track::-webkit-scrollbar{display:none}
#steps,#steps .pts{list-style:none;margin:0;padding:0}
#steps .head{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:2px 4px;margin:6px -4px 0}
#steps>li:first-child>.head{margin-top:0}
#steps .id{font-size:12px;color:var(--muted)}
#steps .text{min-width:0}
#steps .head .name{font-size:13.5px;overflow-wrap:anywhere}
#steps .ms{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
#steps .note{font-size:12px;line-height:1.35;color:var(--fail);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
#steps>li[data-state=running]>.head{background:var(--pane-2);box-shadow:inset 3px 0 0 var(--info)}
#steps>li[data-state=fail]>.head{background:var(--fail-tint)}
#steps>li[data-state=waiting]>.head .name,#steps>li[data-state=skipped]>.head .name{color:var(--muted)}
#steps>li[data-state=waiting]>.head .id,#steps>li[data-state=skipped]>.head .id{color:var(--faint)}
#steps>li[data-state=skipped]>.head .text::after{content:${JSON.stringify(t('workbench.page.skipped'))};display:block;font:400 16px/1 var(--font-crt);color:var(--faint)}
/* Phasen (Vorbereitung, Abschluss, Fehler klaeren) sind Abschnitte wie ── NAME ───, ihre Punkte stehen mit eigener Marke darunter. */
#steps>li[data-kind=phase]>.head{grid-template-columns:minmax(0,1fr) auto;background:none;box-shadow:none;margin-top:10px}
#steps>li[data-kind=phase]>.head>.st{display:none}
#steps>li[data-kind=phase]>.head .name{font:400 19px/1.2 var(--font-crt);color:var(--faint);white-space:nowrap;overflow:hidden;display:block}
#steps>li[data-kind=phase][data-state=fail]>.head .name{color:var(--fail)}
.pts>li{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:6px;align-items:baseline;padding:1px 4px 1px 0;font-size:12.5px;color:var(--muted)}
#steps>li[data-kind=step]>.pts>li{padding-left:22px}
.pts .tree{color:var(--faint)}
#steps>li[data-kind=phase]>.pts>li{grid-template-columns:auto minmax(0,1fr) auto;padding-left:0;font-size:13px;color:var(--text)}
#steps>li[data-kind=phase] .tree,#steps>li[data-kind=phase] .mk,#steps>li[data-kind=step] .pt-tag{display:none}
.mk-ok{color:var(--ok)}.mk-fail{color:var(--fail)}.mk-run{color:var(--info)}.mk-open{color:var(--faint)}
.pts .text{overflow-wrap:anywhere}
.pts .kind{color:var(--claude);margin-right:6px}
.pts>li[data-state=running] .text{color:var(--text)}.pts>li[data-state=fail] .text{color:var(--fail)}
.pts>li[data-state=waiting] .text,#steps>li[data-state=skipped] .pts .text{color:var(--faint)}
.pts .live{display:block;font-size:12px;color:var(--info)}
.bad{color:var(--fail)!important}
.appbar{flex:none;display:flex;gap:10px;align-items:center;font-size:12px;padding:0 2px 8px;white-space:nowrap;overflow:hidden}
#urlMark{color:var(--ok)}
#url{color:var(--muted);overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
#browserState{font:400 19px/1 var(--font-crt);color:var(--info)}
#browserState.rec{color:var(--fail)}#browserState.ask{color:var(--warn)}
.solo-btn{border:0;cursor:pointer;background:var(--pane-2);color:var(--text);font:400 19px/1 var(--font-crt);padding:3px 8px;box-shadow:inset 0 0 0 2px var(--line);flex:none}
.solo-btn:hover{box-shadow:inset 0 0 0 2px var(--accent)}.solo-btn b{font-weight:400;color:var(--info);margin-right:6px}
#app{flex:1;min-height:0;width:100%;border:0;display:block;background:#fff;box-shadow:0 0 0 2px #000}
.drawer{flex:none;padding-top:8px}
.tabs{display:flex;gap:4px}
.tabs button{font:400 20px/1 var(--font-crt);color:var(--muted);background:none;border:0;padding:3px 10px;cursor:pointer;box-shadow:inset 0 0 0 2px var(--line)}
.tabs button:hover{color:var(--text)}
.tabs button[aria-selected=true]{color:var(--text);box-shadow:inset 0 0 0 2px var(--accent)}
.tabs .count{margin-left:6px;color:var(--info)}.tabs .count.bad{color:var(--fail)}
.tabs #drawerClose{display:none;margin-left:auto}.drawer.open #drawerClose{display:inline-flex}
.panel{display:none;height:26vh;min-height:110px;overflow:auto;margin-top:6px;background:var(--screen);box-shadow:inset 0 0 0 2px var(--line)}.drawer.open .panel{display:block}
table{width:100%;border-collapse:collapse;font:12px/1.4 var(--font-mono)}
td{padding:4px 10px;border-top:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}
tr:first-child td{border-top:0}
td.name{width:60%}td.ok{color:var(--ok)}td.bad{color:var(--fail)}td.open{color:var(--muted)}td.ms{text-align:right;color:var(--muted);width:90px}
.empty{padding:10px 12px;color:var(--muted);font:12px var(--font-mono)}
.line{padding:4px 12px;border-top:1px solid var(--line);font:12px/1.45 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}.line:first-child{border-top:0}.line.fail{color:var(--fail)}.line.warn{color:var(--warn)}
#chat{flex:1;width:100%;min-height:0;border:0;display:block;background:var(--pane)}
.fkeys{flex:none;display:flex;flex-wrap:wrap;gap:6px 16px;border-top:2px solid var(--line);margin:0 -16px;padding:8px 16px 10px;font:400 20px/1 var(--font-crt);color:var(--muted)}
.fk{white-space:nowrap;background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit}.fk:hover:enabled{color:var(--text)}
.fk b{font-weight:400;background:var(--info);color:var(--ink);padding:1px 5px;margin-right:6px}
.fk.x b{background:var(--fail)}.fk:disabled{opacity:.45;cursor:not-allowed}.fk[aria-pressed=true]{color:var(--text)}.fk[aria-pressed=true] b{background:var(--accent)}
/* Nur Anwendung (F8): Kopf, Schritte, Chat, Leiste und Requests/Konsole weg; eine Zeile bleibt fuer den Rueckweg. */
.soloBar{display:none;align-items:center;gap:14px;padding:0 2px 8px;font:400 20px/1 var(--font-crt);color:var(--muted);white-space:nowrap;overflow:hidden}
.soloBar .raven{line-height:1;padding:0 2px}#soloTag{color:var(--ok)}#soloTag[hidden]{display:none}
#soloUrl{font:12px var(--font-mono);overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.solo .soloBar{display:flex}
.solo .top,.solo .pa-steps,.solo .pa-chat,.solo .fkeys,.solo .pa-browser>.lg,.solo .appbar,.solo .drawer{display:none}
.solo .panes{grid-template-columns:minmax(0,1fr);grid-template-areas:"browser";padding:0 0 10px}
.solo .pa-browser{border:0;padding:0;background:none;box-shadow:none}
.solo .pa{padding:0}.solo #bench{padding-top:8px}
/* Zustand waehlen (F1): links die Tests, rechts ihre Schritte, unten Herstellen. Auch im Vollbild. */
#stateDlg{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:rgba(0,0,0,.55)}#stateDlg[hidden]{display:none}
#stateDlg>.win{width:min(900px,calc(100vw - 32px));height:min(620px,calc(100vh - 48px));display:flex;flex-direction:column;padding:22px 16px 14px;background:var(--pane)}
#stateDlg .lg{top:-13px}
.scols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:14px;flex:1;min-height:0}
.scol{display:flex;flex-direction:column;min-height:0;min-width:0}
.scol .sec{margin:0 0 6px}
.sfilter{display:flex;gap:8px;align-items:center;background:var(--screen);box-shadow:inset 0 0 0 2px var(--line);padding:5px 8px;margin-bottom:8px}
.sfilter span{font:400 18px/1 var(--font-crt);color:var(--muted)}
.sfilter input{flex:1;min-width:0;background:none;border:0;color:var(--text);font:13px var(--font-mono);outline:0}
.slist{overflow:auto;display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
.srow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:baseline;text-align:left;border:0;background:none;cursor:pointer;padding:5px 6px;width:100%;color:var(--text);font:13px var(--font-mono)}
.srow:hover:enabled{background:var(--pane-2)}.srow:disabled{cursor:not-allowed;color:var(--faint)}
.srow[aria-selected=true]{background:var(--pane-2);box-shadow:inset 3px 0 0 var(--accent)}
.srow .mk{font:400 17px/1 var(--font-crt);color:var(--faint)}.srow[aria-selected=true] .mk{color:var(--accent)}
.srow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .meta{font-size:11.5px;color:var(--muted);white-space:nowrap}.srow .meta.w{color:var(--warn)}
.srow.all .nm{color:var(--info)}
.sfoot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;border-top:2px solid var(--line);padding-top:10px;margin-top:10px}
.sfoot p{margin:0;font-size:12.5px;color:var(--muted);min-width:0;flex:1 1 300px}
.sfoot .acts{display:flex;gap:8px}
.fk[hidden],.solo-btn[hidden]{display:none}
@media (max-width:859px){.scols{grid-template-columns:minmax(0,1fr)}}
/* Theme (F7): ein Fenster ueber der Werkbank. */
#themeDlg{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:rgba(0,0,0,.55)}#themeDlg[hidden]{display:none}
#themeDlg>.win{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 48px);display:flex;flex-direction:column;padding:22px 0 14px;background:var(--pane)}
#themeDlg .tbody{min-height:0;overflow:auto;padding:0 16px}
#themeDlg .lg{top:-13px}
.tthemes{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:12px;border-bottom:2px solid var(--line)}
.tthemes button{border:0;cursor:pointer;display:grid;grid-template-columns:auto auto;gap:0 8px;align-items:center;text-align:left;background:var(--pane-2);color:var(--muted);padding:5px 10px 5px 6px;box-shadow:inset 0 0 0 2px var(--line)}
.tthemes button i{grid-row:span 2;width:18px;height:18px;display:inline-block;background:var(--sw-screen);box-shadow:inset 0 0 0 3px var(--sw-screen),inset 0 0 0 9px var(--sw-accent)}
.tthemes button span{font:400 20px/1 var(--font-crt)}.tthemes button small{font-size:11px;color:var(--faint)}
.tthemes button[aria-checked=true]{color:var(--text);box-shadow:inset 0 0 0 2px var(--accent),0 0 10px var(--glow)}
.trow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.trow[hidden]{display:none}
.trow label{font-size:12.5px;color:var(--muted)}
.trow input,.tfields input[type=text],.tfields input[type=number]{font:13px var(--font-mono);color:var(--text);background:var(--screen);border:0;box-shadow:inset 0 0 0 2px var(--line);padding:5px 8px}
.trow code{font:11.5px var(--font-mono);color:var(--faint);overflow-wrap:anywhere}
.ttabs{display:flex;gap:4px;margin:4px 0 10px}
.ttabs button{font:400 20px/1 var(--font-crt);color:var(--muted);background:none;border:0;padding:3px 10px;cursor:pointer;box-shadow:inset 0 0 0 2px var(--line)}
.ttabs button[aria-selected=true]{color:var(--text);box-shadow:inset 0 0 0 2px var(--accent)}
.tfields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,220px);gap:4px 12px;align-items:center}
.tfields .grp{grid-column:1/-1;font:400 19px/1 var(--font-crt);color:var(--faint);margin-top:10px;white-space:nowrap;overflow:hidden}.tfields .grp:first-child{margin-top:0}
.tfields label{font-size:13px}
.tfields input{width:100%}
.sw{display:flex;align-items:center;gap:8px}.sw code{font:12px var(--font-mono);color:var(--muted);width:7ch}
.tfields input[type=color]{width:34px;height:24px;border:0;padding:0;background:none;cursor:pointer;box-shadow:0 0 0 2px var(--line)}
.tfields input[type=color]::-webkit-color-swatch-wrapper{padding:0}.tfields input[type=color]::-webkit-color-swatch{border:0}
#tproblems{margin:12px 0 0;padding:0;list-style:none;color:var(--warn);font-size:13px}#tproblems[hidden]{display:none}
.tbtns{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}.tbtns [hidden]{display:none}
#tmsg{font-size:12.5px;color:var(--muted)}
#tjsonBox{margin-top:12px}#tjsonBox summary{cursor:pointer;color:var(--muted);font-size:12.5px}
#tjson{margin:8px 0 0;padding:10px;background:var(--screen);box-shadow:inset 0 0 0 2px var(--line);font:12px/1.45 var(--font-mono);color:var(--muted);white-space:pre;overflow:auto;max-height:220px}
/* Ab 1000px drei Spalten; bis 1500px schmalere Raender, damit die Anwendung ihr Desktop-Layout behaelt. */
@media (min-width:1000px) and (max-width:1499px){.panes{--col-steps:minmax(220px,260px);--col-chat:minmax(280px,330px)}}
@media (min-width:1000px){
.fold-steps .panes{--col-steps:44px}.fold-chat .panes{--col-chat:44px}
.fold-steps .pa-steps,.fold-chat .pa-chat{padding:0}
.fold-steps .pa-steps>:not(#stepsStrip),.fold-chat .pa-chat>:not(#chatStrip){display:none}
.fold-steps #stepsStrip,.fold-chat #chatStrip{display:flex}}
@media (max-width:999px){
.fold{display:none}
.pa{height:auto;min-height:100vh}
.panes{grid-template-columns:minmax(300px,380px) minmax(0,1fr);grid-template-rows:auto minmax(60vh,1fr);grid-template-areas:"steps browser" "chat browser"}
.pa-steps{max-height:40vh}}
@media (max-width:859px){
.panes{grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-template-areas:"steps" "chat" "browser"}
.pa-steps{max-height:none}#track{overflow:visible}.pa-chat{height:72vh}.pa-browser{height:78vh}.tools{margin-left:0}.tfields{grid-template-columns:minmax(0,1fr)}}
.still *,.still *::before,.still *::after{animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>${themeStyle(theme)}</head><body class="${classes}"><div class="pa crt-case"><div class="crt" id="bench">
<div class="soloBar">${ravenLogo(theme, { size: 11, label: 'caw' })}<span id="soloTag" hidden>${esc(t('workbench.handedOver'))}</span><span id="soloState"></span><span id="soloUrl"></span><button class="solo-btn" type="button" data-states hidden><b>F1</b>${t('workbench.stateTitle')}</button><button class="solo-btn" type="button" data-solo><b>F8</b>${t('workbench.bench')}</button></div>
<header class="top">${ravenLogo(theme, { size: 22, label: 'caw' })}<div class="id"><b class="glow">caw-ai <span class="cmd" id="cmd"></span> <span id="testName">${esc(test)}</span></b><span>${LONG_NAME}</span></div>
<ul class="facts" id="facts" aria-label="${t('workbench.runFacts')}"></ul>
<div class="tools"><span id="notice" role="status" hidden></span><span id="stateSpin" class="spinf" aria-hidden="true" hidden></span><span id="state" class="px-pill glow" role="status"></span></div></header>
<main class="panes">
<section class="pa-steps win" id="stepsCard" aria-label="${t('workbench.steps')}">${lg(t('workbench.steps'))}<button class="fold" id="stepsFold" type="button" aria-expanded="true" aria-label="${t('workbench.stepsFold')}" title="${t('workbench.stepsFold')} (F4)">◂</button><button class="strip" id="stepsStrip" type="button" aria-expanded="false" aria-label="${t('workbench.stepsUnfold')}" title="${t('workbench.stepsUnfold')} (F4)"><b>▸</b>${t('workbench.steps').toUpperCase()} <span id="stripTally"></span></button>
<div class="gauge" id="gauge" aria-hidden="true"></div><span id="tally" hidden></span><p id="leftNote" hidden></p><p class="hint" id="stepsHint">${t('workbench.stepsHint')}</p><div id="track" class="readable"><ol id="steps" aria-label="${t('workbench.steps')}"></ol></div></section>
<section class="pa-browser win" aria-label="${t('workbench.app')}">${lg(t('workbench.app'))}<div class="appbar"><span id="urlMark" aria-hidden="true"></span><span id="url"></span><span id="browserState"></span><button class="solo-btn" type="button" data-solo title="${t('workbench.soloTitle')}"><b>F8</b>${t('workbench.solo')}</button></div>
<iframe id="app" name="${APP_FRAME}" title="${t('workbench.app')}" src="${esc(appUrl)}" allow="clipboard-read; clipboard-write"></iframe>
<div class="drawer" id="drawer"><div class="tabs" role="tablist"><button type="button" role="tab" data-tab="requests" aria-selected="false">${t('workbench.requests')}<span class="count" data-count="requests">0</span></button><button type="button" role="tab" data-tab="console" aria-selected="false">${t('workbench.console')}<span class="count" data-count="console">0</span></button><button type="button" id="drawerClose" aria-label="${t('workbench.drawerCloseLabel')}" title="${t('workbench.collapse')}">▾ ${t('workbench.collapse')}</button></div>
<div class="panel readable" id="panel"></div></div></section>
<section class="pa-chat win" id="chatCard" aria-label="${t('workbench.chatLabel')}">${lg(t('workbench.chat'))}<button class="fold" id="chatFold" type="button" aria-expanded="true" aria-label="${t('workbench.chatFold')}" title="${t('workbench.chatFold')} (F6)">▸</button><button class="strip" id="chatStrip" type="button" aria-expanded="false" aria-label="${t('workbench.chatUnfold')}" title="${t('workbench.chatUnfold')} (F6)"><b>◂</b>${t('workbench.chat').toUpperCase()}</button><iframe id="chat" name="${CHAT_FRAME}" title="${t('workbench.chatLabel')}" sandbox="${CHAT_SANDBOX}" allow="clipboard-write" srcdoc="${esc(chatPlaceholder(theme))}"></iframe></section>
</main>
<nav class="fkeys" aria-label="${t('workbench.keys')}">${key('F1', t('workbench.stateTitle'), ' data-states hidden')}${key('F5', t('workbench.keyReload'), ` id="reload" disabled title="${t('workbench.page.refreshLockedTitle')}"`)}${key('F9', t('workbench.keyPause'), ' data-key="F9"')}${key('Esc', t('workbench.keyAbort'), ' data-key="Escape"', ' x')}${key('F2', t('workbench.requests'), ' data-tabkey="requests"')}${key('F3', t('workbench.console'), ' data-tabkey="console"')}${key('F4', t('workbench.steps'), ' id="fSteps"')}${key('F6', t('workbench.chat'), ' id="fChat"')}${key('F7', t('workbench.keyTheme'), ' id="fTheme" aria-pressed="false"')}${key('F8', t('workbench.solo'), ' data-solo')}${key('F10', t('workbench.still'), ` id="still" aria-pressed="${still}" title="${t('workbench.stillTitle')}"`)}</nav>
</div></div>
<div id="stateDlg" hidden role="dialog" aria-modal="true" aria-label="${t('workbench.stateTitle')}"><div class="win crt">${lg(t('workbench.stateTitle'))}
<div class="scols"><div class="scol"><div class="sec">── <b>${t('workbench.page.stateTest').toUpperCase()}</b></div><div class="sfilter"><span>/</span><input id="sq" type="search" autocomplete="off" spellcheck="false" placeholder="${t('workbench.page.stateSearch')}" aria-label="${t('workbench.page.stateSearch')}"></div><div class="slist" id="stests" role="listbox" aria-label="${t('workbench.page.stateTest')}"></div></div>
<div class="scol"><div class="sec">── <b id="sstepsHead">${t('workbench.page.stateSteps').toUpperCase()}</b></div><div class="slist" id="ssteps" role="listbox" aria-label="${t('workbench.page.stateSteps')}"></div></div></div>
<div class="sfoot"><p id="sfoot"></p><div class="acts"><button type="button" class="px-btn" id="scancel">${t('workbench.page.stateCancel')}</button><button type="button" class="px-btn px-btn--primary" id="sgo" disabled>[ ${t('workbench.page.stateGo').toUpperCase()} ]</button></div></div></div></div>
<div id="themeDlg" hidden role="dialog" aria-modal="true" aria-labelledby="tname"><div class="win crt"><span class="lg glow" id="tname"></span><div class="tbody">
<div class="tthemes" id="tthemes" role="radiogroup" aria-label="${t('workbench.page.themeList')}"></div>
<div class="trow" id="tnameRow" hidden><label for="tlabel">${t('workbench.page.themeLabel')}</label><input id="tlabel" maxlength="40" spellcheck="false"><label for="tslug">${t('workbench.page.themeName')}</label><input id="tslug" maxlength="32" spellcheck="false" size="14"><code id="tfile"></code></div>
<div class="ttabs" id="ttabs" role="tablist"></div><div class="tfields" id="tfields"></div><ul id="tproblems" hidden></ul>
<div class="tbtns"><button type="button" class="px-btn" id="tdup"></button><button type="button" class="px-btn" id="treset">${t('workbench.page.themeReset')}</button><button type="button" class="px-btn" id="tdelete"></button><button type="button" class="px-btn" id="tclose">${t('workbench.page.themeClose')}</button><span id="tmsg" role="status"></span></div>
<details id="tjsonBox"><summary id="tjsonHead"></summary><pre id="tjson"></pre></details></div></div></div>
<script>${RAVEN_SCRIPT}
${GLYPH_SCRIPT}
${APPLY_THEME_SCRIPT}
const T=${json(texts('workbench.page.'))};
// Die Labels der Pill: dieselben wie im Chat-Kopf.
const PILL=${json(Object.fromEntries(Object.entries(texts('chat.status.')).filter(([key]) => key.endsWith('.label'))))};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]??key);
const $=(id)=>document.getElementById(id);
const state={tab:null,requests:[],console:[]};
const LABELS={waiting:T['workbench.page.waiting'],running:T['workbench.page.running'],pass:T['workbench.page.pass'],fail:T['workbench.page.fail'],skipped:T['workbench.page.skipped']};
const items=()=>[...$('steps').children];
// Gezaehlt werden nur die Schritte des Tests; Vorbereitung, Abschluss und Fehler klaeren sind Phasen.
const stepItems=()=>items().filter((li)=>li.dataset.kind!=='phase');
const pointsOf=(li)=>[...li.querySelector(':scope>.pts').children];
const groupOf=(spot)=>spot.closest('#steps>li');
// Gruppe oder Punkt, auch bevor der Knoten in der Liste steht.
const isGroup=(node)=>node.querySelector(':scope>.head')!==null;
const groupTitle=(li)=>li.dataset.kind==='phase'?li.dataset.name.toUpperCase():li.dataset.id;
const duration=(ms)=>ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(1).replace('.',T['workbench.page.decimal'])+' s';
const cell=(text,cls)=>{const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;td.title=text;return td;};
const still=()=>document.body.classList.contains('still');
// Das Theme, wie es die Seite kennt (ohne css und Dateien). Zeichen nur als textContent, Farben nur als CSS-Variablen.
let TH=${json(clientTheme(theme))};
let LIST=${json(themes)};
const raven=cawRaven(document,document.body,still,TH.raven);
const str=(value,fallback)=>(typeof value==='string'&&value!==''?value:fallback);
const frames=()=>(Array.isArray(TH.spinner?.frames)&&TH.spinner.frames.length>0?TH.spinner.frames:['▖','▘','▝','▗']);
// Eine Marke: der Text des Themes, {spinner} wird ein eigenes Element, das der Takt weiterdreht.
const markInto=(el,kind)=>{const [before,after]=[...str(TH.marks?.[kind],'[      ]').split('{spinner}'),''];el.replaceChildren(before);
  if(str(TH.marks?.[kind],'').includes('{spinner}')){const s=document.createElement('span');s.className='spinf';s.replaceChildren(cawGlyph(frames()[spinAt%frames().length]));el.append(s,after);}};
let spinTimer=0,spinAt=0;
// Blockzeichen zeichnet die Seite selbst (cawGlyph), andere Frames bleiben Text.
const spin=()=>{clearInterval(spinTimer);const ms=Number.isInteger(TH.spinner?.ms)&&TH.spinner.ms>=40?TH.spinner.ms:150;
  spinTimer=setInterval(()=>{if(still())return;spinAt=(spinAt+1)%frames().length;for(const s of document.querySelectorAll('.spinf'))s.replaceChildren(cawGlyph(frames()[spinAt]));},ms);};
const ruleText=(title,width=34)=>{const format=str(TH.rule?.format,'── {title} {line}'),line=str(TH.rule?.line,'─');
  const used=[...format.replace('{title}',title).replace('{line}','')].length;return format.replace('{title}',title).replace('{line}',line.repeat(Math.max(3,width-used)));};
const legendText=(title)=>str(TH.legend,'┤ {title} ├').replace('{title}',title);
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
// Die Konsole oeffnet sich nur bei neuen Fehlern von selbst; schliessen tut sie nur der Mensch.
let seenFails=0;
for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>select(b.dataset.tab));
// Der offene Reiter bleibt nach dem Neuladen der Werkbank offen.
try{const tab=sessionStorage.getItem('caw-bench-tab');if(tab==='requests'||tab==='console')select(tab);}catch{}
for(const b of document.querySelectorAll('[data-tabkey]'))b.addEventListener('click',()=>select(b.dataset.tabkey));
$('drawerClose').addEventListener('click',()=>{if(state.tab!==null)select(state.tab);});
const setCount=(name,value,bad)=>{for(const node of document.querySelectorAll('[data-count='+name+']')){node.textContent=(bad===true?str(TH.bullets?.fail,'✖')+' ':'')+value;node.classList.toggle('bad',bad===true);}};
let aborted=false;
// Was der Chat gerade will: ask aus der Stimmung, dazu sein Zustand (showing: der Mensch fuehrt vor).
let asking=false,chatState=null;
const stepsHintText=$('stepsHint').textContent;
// Fortschritt als Balken: je Schritt gleich viele Zeichen, bestanden, laufend oder gescheitert, offen (Zeichen aus dem Theme).
const gauge=(list)=>{const box=$('gauge');if(list.length===0){box.replaceChildren();return;}
  const per=Math.max(1,Math.floor(20/list.length)),pass=list.filter((li)=>li.dataset.state==='pass').length,p=TH.progress??{};
  const parts=list.map((li)=>{const s=li.dataset.state;const span=document.createElement('span');span.className=s==='pass'?'mk-ok':s==='fail'?'mk-fail':s==='running'?'mk-run':'mk-open';
    const char=s==='pass'?str(p.done,'█'):s==='fail'||s==='running'?str(p.run,'▓'):str(p.open,'░');span.replaceChildren(...Array.from({length:per},()=>cawGlyph(char)));return span;});
  const sum=document.createElement('span');sum.className='mk-open';sum.textContent=' '+pass+'/'+list.length;box.replaceChildren(...parts,sum);};
// Baumzeichen der Unterpunkte: der letzte endet.
const trees=()=>{for(const ol of document.querySelectorAll('#steps .pts')){const all=[...ol.children];all.forEach((li,i)=>{li.querySelector(':scope>.tree').textContent=i===all.length-1?str(TH.tree?.end,'└'):str(TH.tree?.mid,'├');});}};
// Kopfzeile, Fortschritt und Zaehler folgen den Schritten: was laeuft, was gescheitert ist, wie viele bestanden sind.
const summarize=()=>{
  const list=stepItems(),n=list.length,all=items();
  $('stepsHint').hidden=all.length>0;$('stepsHint').textContent=chatState==='showing'?T['workbench.page.stepsHintShowing']:stepsHintText;
  const count=(name)=>list.filter((li)=>li.dataset.state===name).length;
  const pass=count('pass');
  $('tally').textContent=$('stripTally').textContent=n===0?'':pass+'/'+n;
  gauge(list);trees();
  const failed=all.find((li)=>li.dataset.state==='fail'),running=list.find((li)=>li.dataset.state==='running')??all.find((li)=>li.dataset.state==='running');
  const [kind,text,browser]=aborted?['fail',T['workbench.page.aborted'],T['workbench.page.aborted']]:failed?['fail',fill('workbench.page.groupFailed',{id:groupTitle(failed)}),T['workbench.page.browserFailed']]:running?['run',fill('workbench.page.groupRunning',{id:groupTitle(running)}),T['workbench.page.browserRunning']]:n>0&&pass===n?['ok',T['workbench.page.allPassed'],T['workbench.page.browserPassed']]:pass>0?(document.body.classList.contains('left-state')?['',fill('workbench.page.left',{id:list.filter((li)=>li.dataset.state==='pass').at(-1).dataset.id}),T['workbench.page.browserReloaded']]:['ok',fill('workbench.page.reached',{id:list.filter((li)=>li.dataset.state==='pass').at(-1).dataset.id}),T['workbench.page.ready']]):n>0?['',T['workbench.page.ready'],T['workbench.page.ready']]:[null,'',''];
  let [browserText,tone]=[browser,''];
  // Wartet der Chat auf den Menschen, sagt das die Leiste der Anwendung; die Pill nicht, das sagt schon der Chat.
  if(!aborted&&asking){browserText=T['workbench.page.browserYourTurn'];tone='ask';}
  if(!aborted&&chatState==='showing'){browserText=T['workbench.page.recording'];tone='rec';}
  // Die Pill oben rechts: nur die vier Labels des Chat-Kopfs (Claude arbeitet, caw-ai arbeitet, Hält an …, Pausiert), ohne Schritt.
  // Zustaende ohne Label zeigen keine Pill. Den aktuellen Schritt zeigt die Schrittliste.
  const label=aborted||chatState===null?undefined:PILL['chat.status.'+chatState+'.label'];
  const claudeWorks=chatState==='running'||chatState==='advising',cawWorks=label!==undefined&&!claudeWorks&&chatState!=='pausing'&&chatState!=='paused';
  const pill=$('state');pill.className='px-pill glow'+(label===undefined?'':' on')+(claudeWorks?' px-pill--claude':cawWorks?' px-pill--run':'');pill.dataset.state=chatState??'';
  pill.textContent=label===undefined?'':(chatState==='paused'?str(TH.bullets?.pause,'‖')+' ':'')+label;
  $('stateSpin').hidden=!(claudeWorks||cawWorks);$('stateSpin').classList.toggle('px-pill--claude',claudeWorks);
  $('browserState').textContent=browserText;$('browserState').className=tone;
  $('soloState').textContent=text;$('soloTag').hidden=!refreshOn;
};
// Aktualisieren entscheidet der Host: nach der Uebergabe die Seite ohne Cache neu laden, im laufenden Test gar nicht.
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
// Persoenliche Einstellungen: Der Host prueft Schluessel und Wert.
const pref=(key,value)=>{try{const result=window.${PREF_BINDING}?.(key,value);result?.catch?.(()=>{});}catch{}};
// Schritte und Chat lassen sich einklappen. Fragt der Chat etwas, klappt er von selbst auf, ohne die Wahl zu ueberschreiben.
const fold=(name,on,remember=true)=>{document.body.classList.toggle('fold-'+name,on);$(name+'Fold').setAttribute('aria-expanded',String(!on));$(name+'Strip').setAttribute('aria-expanded',String(!on));if(remember){pref(name,on?'closed':'open');if(name==='steps')autoSteps=false;}};
const toggleFold=(name)=>fold(name,!document.body.classList.contains('fold-'+name));
// Ohne eigene Wahl startet die Schrittliste in schmalen Fenstern eingeklappt: Der Platz gehoert der Anwendung.
let autoSteps=${prefs.steps === undefined ? 'true' : 'false'};
// Scheitert ein Schritt oder stehen die Schritte fest, klappt die Liste von selbst auf, aber nur, wenn sie auch von selbst zu war.
let stepsWanted=false;
const fitSteps=()=>{if(!autoSteps)return;const on=innerWidth<1500&&!stepsWanted;document.body.classList.toggle('fold-steps',on);$('stepsFold').setAttribute('aria-expanded',String(!on));$('stepsStrip').setAttribute('aria-expanded',String(!on));};
fitSteps();addEventListener('resize',fitSteps);
const showSteps=()=>{if(!autoSteps||stepsWanted)return;stepsWanted=true;fitSteps();};
$('stepsFold').addEventListener('click',()=>fold('steps',true));$('stepsStrip').addEventListener('click',()=>fold('steps',false));
$('chatFold').addEventListener('click',()=>fold('chat',true));$('chatStrip').addEventListener('click',()=>fold('chat',false));
$('fSteps').addEventListener('click',()=>toggleFold('steps'));$('fChat').addEventListener('click',()=>toggleFold('chat'));
// Nur Anwendung: Die Werkbank tritt zurueck, das Browserfenster bleibt, wie es ist (kein Vollbild wie F11). Der Host merkt es sich
// und stellt es nach dem Neuladen der Werkbank wieder her.
const showSolo=(on)=>{document.body.classList.toggle('solo',on);};
const solo=(on=!document.body.classList.contains('solo'))=>{showSolo(on);try{const result=window.${FULLSCREEN_BINDING}?.(on);result?.catch?.(()=>{});}catch{}};
for(const b of document.querySelectorAll('[data-solo]'))b.addEventListener('click',()=>solo());
// Animationen aus (F10): kein Blinzeln, kein Spinner, kein Cursor. Gilt auch fuer die naechsten Laeufe.
const setStill=(on)=>{document.body.classList.toggle('still',on);$('still').setAttribute('aria-pressed',String(on));pref('animations',on?'off':'on');};
$('still').addEventListener('click',()=>setStill(!still()));
// Pause und Abbrechen gehoeren dem Chat: Die Werkbank reicht die Taste nur weiter.
const chatWindow=()=>{try{return $('chat').contentWindow;}catch{return null;}};
const toChat=(key)=>{try{chatWindow()?.postMessage({caw:'key',key},'*');}catch{}};
for(const b of document.querySelectorAll('[data-key]'))b.addEventListener('click',()=>toChat(b.dataset.key));
const sendTheme=()=>{try{chatWindow()?.postMessage({caw:'theme',theme:TH},'*');}catch{}};

const KIND={waiting:'open',running:'run',pass:'ok',fail:'fail',skipped:'open'};
const BULLET={running:'run',pass:'ok',fail:'fail'};
const makeMark=(point)=>{const st=document.createElement('span');st.className='st';st.setAttribute('role','img');st.setAttribute('aria-label',LABELS.waiting);
  const tg=document.createElement('span');tg.className='tag'+(point?' pt-tag':'');st.append(tg);
  if(point){const mk=document.createElement('span');mk.className='mk';st.append(mk);}return st;};
const paint=(node)=>{const own=isGroup(node),st=node.querySelector(own?':scope>.head>.st':':scope>.st'),stateName=node.dataset.state,k=KIND[stateName]??'open';
  const tg=st.querySelector('.tag');tg.className='tag tag-'+k+(k==='fail'&&TH.failInverted!==false?' inverted':'')+(own?'':' pt-tag');markInto(tg,k);
  const mk=st.querySelector('.mk');if(mk){mk.className='mk mk-'+k;mk.textContent=BULLET[stateName]?str(TH.bullets?.[BULLET[stateName]],'▸'):'·';}};
const setState=(node,stateName,note)=>{const label=LABELS[stateName]??stateName,own=isGroup(node);node.dataset.state=stateName;node.setAttribute('aria-label',node.dataset.label+' – '+label);
  node.querySelector(own?':scope>.head [role=img]':'[role=img]').setAttribute('aria-label',label);paint(node);
  if(note!==undefined||stateName!=='fail'){const text=node.querySelector(own?':scope>.head .text':'.text');text.querySelector(':scope>.note')?.remove();
    if(note){const div=document.createElement('div');div.className='note';div.textContent=note;div.title=note;text.append(div);}}};
const showMs=(node,ms)=>{const cell=node.querySelector(isGroup(node)?':scope>.head .ms':'.ms');if(ms===undefined){cell.textContent='';delete node.dataset.ms;}else{cell.textContent=duration(ms);node.dataset.ms=String(Math.round(ms));}};
const liveText=(text)=>str(TH.bullets?.run,'▸')+' '+text;
const makePoint=(p)=>{const li=document.createElement('li');li.dataset.id=p.id;li.dataset.state='waiting';if(p.kind)li.dataset.kind=p.kind;li.dataset.label=((p.kind?p.kind+' ':'')+(p.label??'')).trim();li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const tree=document.createElement('span');tree.className='tree';tree.setAttribute('aria-hidden','true');
  const text=document.createElement('span');text.className='text';if(p.kind){const kind=document.createElement('span');kind.className='kind';kind.textContent=p.kind;text.append(kind);}
  const name=document.createElement('span');name.className='name';name.textContent=p.label??'';text.append(name);
  const ms=document.createElement('span');ms.className='ms';li.append(tree,makeMark(true),text,ms);paint(li);return li;};
const phaseName=(li)=>{li.querySelector(':scope>.head .name').textContent=ruleText(li.dataset.name.toUpperCase());};
const makeGroup=(g)=>{const li=document.createElement('li');const phase=g.kind==='phase';li.dataset.id=g.id;li.dataset.kind=phase?'phase':'step';li.dataset.name=g.name;li.dataset.state='waiting';li.dataset.label=(phase?'':g.id+' ')+g.name;li.setAttribute('aria-label',li.dataset.label+' – '+LABELS.waiting);
  const head=document.createElement('div');head.className='head';head.append(makeMark(false));
  if(!phase){const id=document.createElement('span');id.className='id';id.textContent=g.id;head.append(id);}
  const text=document.createElement('span');text.className='text';const name=document.createElement('span');name.className='name';name.textContent=g.name;text.append(name);
  const ms=document.createElement('span');ms.className='ms';head.append(text,ms);
  const pts=document.createElement('ol');pts.className='pts';li.append(head,pts);pts.append(...(g.points??[]).map(makePoint));paint(li);if(phase)phaseName(li);return li;};
// Ein anderes Theme: alle Zeichen neu, Farben als Variablen, Rabe, Legenden, Chat.
const repaint=()=>{for(const li of document.querySelectorAll('#steps li'))paint(li);for(const li of items())if(li.dataset.kind==='phase')phaseName(li);
  for(const lg of document.querySelectorAll('.lg[data-title]'))lg.textContent=legendText(lg.dataset.title);
  for(const live of document.querySelectorAll('.pts .live'))live.textContent=liveText(live.dataset.text??'');
  $('urlMark').textContent=str(TH.bullets?.ok,'■');$('stateSpin').replaceChildren(cawGlyph(frames()[0]));spin();summarize();};
const useTheme=(theme)=>{if(!theme||typeof theme!=='object')return;TH=theme;cawApplyTheme(document.documentElement,TH);raven.setRaven(TH.raven);repaint();sendTheme();};
repaint();

// Theme (F7): Themes waehlen, eigene anlegen und bearbeiten. Eingebaute bleiben, wie sie sind: Die erste Aenderung legt eine Kopie
// „mein-<base>“ an. Gespeichert wird ueber cawTheme im Host, der das Schema prueft; die Seite setzt nur Variablen und textContent.
const KEYS=${json(THEME_KEYS)},BUILTIN=${json(BUILTIN_THEMES)},LANG=${json(language())},NAME=/^[a-z0-9-]{1,32}$/;
const isObj=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const txt=(v)=>(isObj(v)?v[LANG]??v.en??Object.values(v)[0]??'':v??'');
const clone=(v)=>JSON.parse(JSON.stringify(v??{}));
const getPath=(obj,path)=>path.split('.').reduce((o,k)=>(o==null?o:o[k]),obj);
const isBuiltin=()=>BUILTIN.includes(TH.name);
const FIELDS={
  marks:[['marks'],['marks.ok','text',32],['marks.warn','text',32],['marks.fail','lang',32],['marks.run','text',32],['marks.open','text',32],['marks.ask','text',32],
    ['bullets'],['bullets.ok','text',4],['bullets.warn','text',4],['bullets.fail','text',4],['bullets.run','text',4],['bullets.pause','lang',4],
    ['lines'],['tree.mid','text',2],['tree.end','text',2],['rule.line','text',1],['legend','text',32],
    ['progress'],['progress.done','text',1],['progress.run','text',1],['progress.open','text',1],['spinner.frames','chars',12],['spinner.ms','num',60000],
    ['chat'],['prompt.claude','text',32],['prompt.human','lang',32]],
  raven:[['logo'],['raven.lines.0','text',24],['raven.lines.1','text',24],['raven.lines.2','text',24],['raven.beak','text',2],
    ['eyes'],['raven.eyes.open','text',2],['raven.eyes.shut','text',2],['raven.eyes.happy','text',2],
    ['blink'],['raven.blink.ms','num',60000],['raven.blink.pauseMs.0','num',60000],['raven.blink.pauseMs.1','num',60000],
    ['hearts'],['raven.pet.hearts.glyphs','list',24],['raven.pet.hearts.count','num',20],['raven.pet.hearts.risePx','num',400]],
  crt:[['screen'],['crt.scanlines.color','color'],['crt.scanlines.alpha','range'],['crt.vignette','range'],
    ['glow'],['crt.headingGlowPx','num',24],['crt.textGlow.px','num',8],['crt.textGlow.alpha','range']],
};
const TABS=['colors','marks','raven','crt'];
let tab='colors',confirmDelete=false,busy=false;
const msg=(text)=>{$('tmsg').textContent=text??'';};
const call=async(action,payload)=>{if(busy)return null;busy=true;
  try{const result=await window.${THEME_BINDING}?.(action,payload);
    if(result?.ok===true){if(Array.isArray(result.list))LIST=result.list;if(result.theme)useTheme(result.theme);msg('');return result;}
    msg(fill('workbench.page.themeFailed',{why:String(result?.error??'').slice(0,200)}));}
  catch{msg(fill('workbench.page.themeFailed',{why:''}));}
  finally{busy=false;renderDialog();}
  return null;};
const unique=(stem)=>{let name=stem.slice(0,32),i=2;while(LIST.some((entry)=>entry.name===name))name=(stem.slice(0,28)+'-'+(i++));return name;};
// Das eigene Paket zum Speichern: ohne css und Schriften, die kommen nur von der Platte und bleiben im Host.
const ownPkg=()=>{const pkg=clone(TH.pkg);delete pkg.css;delete pkg.fonts;delete pkg.$schema;return pkg;};
const fresh=(base,label)=>({themeApi:1,name:unique('mein-'+base),base,label:{[LANG]:label}});
const setPath=(pkg,path,value)=>{const keys=path.split('.');let o=pkg;
  keys.slice(0,-1).forEach((k,i)=>{const next=keys[i+1];if(o[k]==null)o[k]=/^\\d+$/.test(next)?clone(getPath(TH,keys.slice(0,i+1).join('.'))??[]):{};else o[k]=clone(o[k]);o=o[k];});
  o[keys.at(-1)]=value;};
const edit=(path,value)=>{const pkg=isBuiltin()?fresh(TH.name,fill('workbench.page.themeMine',{label:TH.label})):ownPkg();setPath(pkg,path,value);return call('save',pkg);};
const problems=()=>{const out=[];
  const widths=new Set(Object.values(TH.marks??{}).map((m)=>[...String(m).replace('{spinner}','x')].length));
  if(widths.size>1)out.push(T['workbench.page.themeWidth']);
  const lum=(hex)=>{const [r,g,b]=hex.slice(1).match(/../g).map((p)=>{const c=parseInt(p,16)/255;return c<=.03928?c/12.92:((c+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
  const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return (x+.05)/(y+.05);};
  for(const k of ['screen','pane']){const q=ratio(TH.colors.text,TH.colors[k]);if(q<4.5)out.push(fill('workbench.page.themeContrast',{ground:T['workbench.page.f.colors.'+k],ratio:q.toFixed(1).replace('.',T['workbench.page.decimal'])}));}
  return out;};
const input=(path,kind,max)=>{const raw=getPath(TH,path),el=document.createElement('input');el.id='f-'+path.replaceAll('.','-');el.dataset.path=path;el.dataset.kind=kind;
  if(kind==='color'){el.type='color';el.value=raw??'#000000';}
  else if(kind==='range'){el.type='range';el.min='0';el.max='1';el.step='0.01';el.value=String(raw??0);}
  else if(kind==='num'){el.type='number';el.min='0';el.max=String(max);el.value=String(raw??0);}
  else{el.type='text';el.maxLength=kind==='list'||kind==='chars'?200:max;el.value=kind==='list'?(raw??[]).join('  ').replaceAll('\\n','\\\\n'):kind==='chars'?(raw??[]).join(''):txt(raw);if(kind==='list')el.title=T['workbench.page.themeListHint'];}
  const live=kind==='color'||kind==='range';
  el.addEventListener(live?'input':'change',()=>{let v=el.value;
    if(kind==='color'&&!/^#[0-9a-f]{6}$/i.test(v))return;
    if(kind==='num'||kind==='range'){v=Number(v);if(!Number.isFinite(v)||v<0)return;if(kind==='num')v=Math.min(Math.round(v),max);}
    if(kind==='list')v=v.split(/ {2,}/).map((s)=>s.replaceAll('\\\\n','\\n')).filter(Boolean).slice(0,12);
    if(kind==='chars')v=[...v].filter((c)=>c.trim()).slice(0,12);
    if((kind==='list'||kind==='chars')&&v.length===0)return;
    if(kind==='lang')v={...(isObj(getPath(TH.pkg,path))?getPath(TH.pkg,path):{}),[LANG]:v};
    if(live){const preview=clone(TH);setPath(preview,path,v);cawApplyTheme(document.documentElement,preview);const code=el.previousElementSibling;if(code?.tagName==='CODE')code.textContent=el.value;}
    else edit(path,v);});
  if(live)el.addEventListener('change',()=>{let v=el.value;if(kind==='range')v=Number(v);edit(path,v);});
  return el;};
const label=(forId,text)=>{const l=document.createElement('label');l.htmlFor=forId;l.textContent=text;return l;};
const renderFields=()=>{
  $('ttabs').replaceChildren(...TABS.map((name)=>{const b=document.createElement('button');b.type='button';b.setAttribute('role','tab');b.setAttribute('aria-selected',String(name===tab));b.textContent=T['workbench.page.tab.'+name];b.addEventListener('click',()=>{tab=name;renderFields();});return b;}));
  const out=[];
  if(tab==='colors')for(const k of KEYS){const el=input('colors.'+k,'color');const sw=document.createElement('span');sw.className='sw';const code=document.createElement('code');code.textContent=el.value;sw.append(code,el);out.push(label(el.id,T['workbench.page.f.colors.'+k]??k),sw);}
  else for(const f of FIELDS[tab]){if(f.length===1){const g=document.createElement('div');g.className='grp';g.textContent=ruleText(T['workbench.page.g.'+f[0]].toUpperCase(),40);out.push(g);continue;}
    const el=input(f[0],f[1],f[2]);let box=el;if(f[1]==='color'){box=document.createElement('span');box.className='sw';const code=document.createElement('code');code.textContent=el.value;box.append(code,el);}
    out.push(label(el.id,T['workbench.page.f.'+f[0]]??f[0]),box);}
  $('tfields').replaceChildren(...out);};
const renderDialog=()=>{const own=!isBuiltin();
  $('tthemes').replaceChildren(...LIST.map((entry)=>{const b=document.createElement('button');b.type='button';b.setAttribute('role','radio');b.setAttribute('aria-checked',String(entry.name===TH.name));
    const i=document.createElement('i');const sample=entry.name===TH.name?TH.colors:entry.colors;if(sample){i.style.setProperty('--sw-screen',sample.screen);i.style.setProperty('--sw-accent',sample.accent);}
    const name=document.createElement('span');name.textContent=entry.label||entry.name;const small=document.createElement('small');small.textContent=entry.builtin?T['workbench.page.themeBuiltin']:fill('workbench.page.themeOwn',{base:entry.base});
    b.append(i,name,small);b.addEventListener('click',()=>{confirmDelete=false;if(entry.name!==TH.name)call('use',entry.name);});return b;}));
  $('tname').textContent=legendText('THEME '+String(TH.label||TH.name).toUpperCase());
  $('tnameRow').hidden=!own;
  if(own){if(document.activeElement!==$('tlabel'))$('tlabel').value=txt(TH.pkg?.label)||TH.name;if(document.activeElement!==$('tslug'))$('tslug').value=TH.name;$('tfile').textContent=fill('workbench.page.themeFile',{name:TH.name});}
  $('tdelete').hidden=!own;$('treset').hidden=!own;
  $('tdelete').textContent=confirmDelete?T['workbench.page.themeDeleteSure']:T['workbench.page.themeDelete'];
  $('tdup').textContent=own?T['workbench.page.themeDuplicate']:T['workbench.page.themeOwnFrom'];
  if(!$('tfields').contains(document.activeElement))renderFields();
  const warn=problems();$('tproblems').replaceChildren(...warn.map((w)=>{const li=document.createElement('li');li.textContent=str(TH.bullets?.warn,'◆')+' '+w;return li;}));$('tproblems').hidden=warn.length===0;
  $('tjsonHead').textContent=own?T['workbench.page.themeJsonOwn']:T['workbench.page.themeJsonBuiltin'];
  const shown=clone(TH.pkg);delete shown.css;$('tjson').textContent=JSON.stringify(shown,null,2);};
$('tlabel').addEventListener('change',()=>{const v=$('tlabel').value.trim().slice(0,40);if(v&&!isBuiltin())edit('label',{...(isObj(TH.pkg?.label)?TH.pkg.label:{}),[LANG]:v});});
$('tslug').addEventListener('change',()=>{const to=$('tslug').value.trim().toLowerCase();if(isBuiltin()||to===TH.name)return;
  if(!NAME.test(to)||LIST.some((entry)=>entry.name===to)){msg(T['workbench.page.themeBadName']);$('tslug').value=TH.name;return;}call('rename',{from:TH.name,to});});
$('tdup').addEventListener('click',()=>{const base=isBuiltin()?TH.name:TH.base;const copy=fill('workbench.page.themeCopy',{label:TH.label});
  if(isBuiltin()){call('save',{...fresh(base,copy),name:unique(TH.name+'-kopie')});return;}
  call('save',{...ownPkg(),name:unique(TH.name+'-kopie'),label:{[LANG]:copy}});});
$('treset').addEventListener('click',()=>{if(isBuiltin())return;const p=ownPkg();call('save',{themeApi:1,name:p.name,base:p.base,...(p.label?{label:p.label}:{})});});
$('tdelete').addEventListener('click',()=>{if(isBuiltin())return;if(!confirmDelete){confirmDelete=true;renderDialog();return;}confirmDelete=false;call('delete',TH.name);});
let themeFocus=null;
// Zustand waehlen (F1): nur nach der Uebergabe, wenn der Host Tests anbietet. Ohne Schritt laeuft der Test bis zum letzten herstellbaren.
let STATES=[],sTest=null,sStep=null;
const stateDlg=$('stateDlg');
const okSteps=(test)=>test.steps.filter((step)=>step.ok);
const sRow=(cls,mark,name,meta,selected,disabled)=>{const b=document.createElement('button');b.type='button';b.className='srow'+(cls?' '+cls:'');b.setAttribute('role','option');b.setAttribute('aria-selected',String(selected));b.disabled=disabled===true;
  const m=document.createElement('span');m.className='mk';m.textContent=mark;const n=document.createElement('span');n.className='nm';n.textContent=name;const x=document.createElement('span');x.className='meta'+(meta?.warn?' w':'');x.textContent=meta?.text??'';b.append(m,n,x);return b;};
const renderStates=()=>{
  const q=$('sq').value.trim().toLowerCase();
  const shown=STATES.filter((test)=>test.id.toLowerCase().includes(q)||test.name.toLowerCase().includes(q)||String(test.role??'').toLowerCase().includes(q));
  if(sTest!==null&&!STATES.some((test)=>test.id===sTest))sTest=null;
  $('stests').replaceChildren(...shown.map((test)=>{const row=sRow('',test.id===sTest?'▸':' ',test.id,test.mutates?{text:(test.role?test.role+' · ':'')+T['workbench.page.stateWrites'],warn:true}:{text:(test.role?test.role+' · ':'')+fill('workbench.page.stateCount',{count:test.steps.length})},test.id===sTest);
    row.addEventListener('click',()=>{sTest=test.id;sStep=null;renderStates();});return row;}));
  const test=STATES.find((entry)=>entry.id===sTest);
  $('sstepsHead').textContent=(test?T['workbench.page.stateSteps']+' · '+test.id:T['workbench.page.stateSteps']).toUpperCase();
  if(!test){$('ssteps').replaceChildren();$('sgo').disabled=true;$('sfoot').textContent=T['workbench.page.stateHint'];return;}
  const last=okSteps(test).at(-1);
  const all=sRow('all',sStep===null?'▸':' ',fill('workbench.page.stateAll',{id:last.id}),null,sStep===null);
  all.addEventListener('click',()=>{sStep=null;renderStates();});
  const rows=test.steps.map((step,i,list)=>{const row=sRow('',(i===list.length-1?'└':'├'),step.id+'  '+step.name,step.ok?null:{text:T['workbench.page.stateWhy.'+step.why]??'',warn:true},sStep===step.id,!step.ok);
    if(sStep===step.id)row.querySelector('.mk').textContent='▸';
    row.addEventListener('click',()=>{sStep=step.id;renderStates();});return row;});
  $('ssteps').replaceChildren(all,...rows);
  $('sgo').disabled=false;
  $('sfoot').textContent=fill('workbench.page.stateFoot',{test:test.id,step:sStep??last.id})+(test.role?fill('workbench.page.stateFootRole',{role:test.role}):'')+(test.mutates?T['workbench.page.stateFootWrites']:'');
};
let stateFocus=null;
const openStates=(on=stateDlg.hidden)=>{if(on&&STATES.length===0)return;if(on&&!$('themeDlg').hidden)openTheme(false);stateDlg.hidden=!on;
  if(on){stateFocus=document.activeElement;if(sTest===null&&STATES.length===1)sTest=STATES[0].id;renderStates();$('sq').focus();}else stateFocus?.focus?.();};
const goState=()=>{const test=STATES.find((entry)=>entry.id===sTest);if(!test)return;openStates(false);
  try{const result=window.${STATE_BINDING}?.(test.id,sStep);result?.catch?.(()=>{});}catch{}};
$('sq').addEventListener('input',renderStates);
$('sq').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!$('sgo').disabled){event.preventDefault();goState();}});
$('scancel').addEventListener('click',()=>openStates(false));$('sgo').addEventListener('click',goState);
stateDlg.addEventListener('click',(event)=>{if(event.target===stateDlg)openStates(false);});
for(const b of document.querySelectorAll('[data-states]'))b.addEventListener('click',()=>openStates(true));
const openTheme=(on=$('themeDlg').hidden)=>{$('themeDlg').hidden=!on;$('fTheme').setAttribute('aria-pressed',String(on));confirmDelete=false;
  if(on){themeFocus=document.activeElement;msg('');renderDialog();$('tthemes').querySelector('[aria-checked=true]')?.focus();}else themeFocus?.focus?.();};
$('fTheme').addEventListener('click',()=>openTheme());$('tclose').addEventListener('click',()=>openTheme(false));
$('themeDlg').addEventListener('click',(event)=>{if(event.target===$('themeDlg'))openTheme(false);});

// Die Tasten der Werkbank. F11 und F12 bleiben bei Chrome, F5 und Strg+R meinen Aktualisieren.
const isRefreshKey=(event)=>event.key==='F5'||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='r');
const press=(key)=>{
  if(key==='F1'){openStates();return true;}
  if(key==='F2')select('requests');else if(key==='F3')select('console');else if(key==='F4')toggleFold('steps');else if(key==='F6')toggleFold('chat');
  else if(key==='F7')openTheme();else if(key==='F8')solo();else if(key==='F10')setStill(!still());else if(key==='F9'||key==='Escape')toChat(key);else return false;
  return true;};
addEventListener('keydown',(event)=>{
  if(isRefreshKey(event)){event.preventDefault();refresh();return;}
  if(event.key==='Escape'&&!stateDlg.hidden){event.preventDefault();openStates(false);return;}
  if(event.key==='Escape'&&!$('themeDlg').hidden){event.preventDefault();openTheme(false);return;}
  if(event.key==='Escape'&&event.target?.closest?.('input,textarea,select'))return;
  if(event.ctrlKey||event.altKey||event.metaKey)return;
  if(press(event.key))event.preventDefault();});
// F5 in der Anwendung oder im Chat meldet deren Frame hierher, der Chat auch seine F-Tasten. Mehr kann eine solche Nachricht nicht ausloesen.
const CHAT_KEYS=${json(CHAT_KEYS)};
addEventListener('message',(event)=>{const fromChat=event.source===chatWindow();
  if(event.data?.caw==='refresh'&&(event.source===$('app').contentWindow||fromChat))refresh();
  if(event.data?.caw==='theme-request'&&fromChat)sendTheme();
  if(event.data?.caw==='key'&&fromChat&&CHAT_KEYS.includes(event.data.key))press(event.data.key);
  if(event.data?.caw==='key'&&event.data.key==='F1'&&event.source===$('app').contentWindow)press('F1');});

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
  // Die erste Angabe ist der Modus (Kopf: caw-ai <modus> <test>), der Test steht schon im Titel; der Rest kommt in die Fakten.
  facts:(entries)=>{const [first,...rest]=entries;$('cmd').textContent=first?String(first[1]).toLowerCase():'';
    const test=$('testName').textContent;
    $('facts').replaceChildren(...rest.filter(([,value])=>String(value)!==test).map(([label,value])=>{const li=document.createElement('li');li.title=label+': '+value;const b=document.createElement('b');b.textContent=String(value);li.append(label,b);return li;}));},
  url:(url)=>{appUrl=url;$('url').textContent=$('soloUrl').textContent=url;$('url').title=url;},
  steps:(groups)=>{aborted=false;$('steps').replaceChildren(...groups.map(makeGroup));if(groups.length>0)showSteps();summarize();},
  // Eine Gruppe dazu oder neu benannt, etwa „Fehler klären“, wenn Claude untersucht. Bestehende Punkte bleiben.
  group:(def)=>{const known=items().find((li)=>li.dataset.id===def.id);if(known){known.dataset.name=def.name;if(known.dataset.kind==='phase')phaseName(known);else known.querySelector(':scope>.head .name').textContent=def.name;for(const point of def.points??[])if(!pointsOf(known).some((li)=>li.dataset.id===point.id))known.querySelector(':scope>.pts').append(makePoint(point));}else $('steps').append(makeGroup(def));summarize();},
  step:(id,stateName,note)=>{for(const li of items()){if(li.dataset.id===id){setState(li,stateName,note);
      if(stateName==='running'){if(!li.dataset.t0)li.dataset.t0=String(performance.now());}else if((stateName==='pass'||stateName==='fail')&&li.dataset.t0){showMs(li,performance.now()-Number(li.dataset.t0));delete li.dataset.t0;}else if(stateName==='waiting'){showMs(li);delete li.dataset.t0;}
      // Der Schritt nimmt seine Punkte mit: bestanden heisst alle gelaufen, gescheitert trifft den laufenden, offen setzt alle zurueck.
      for(const point of pointsOf(li)){const s=point.dataset.state;
        if(stateName==='pass'&&s!=='pass'&&s!=='fail'){setState(point,'pass');point.querySelector('.live')?.remove();}
        else if(stateName==='fail'&&s==='running'){setState(point,'fail');point.querySelector('.live')?.remove();}
        else if(stateName==='waiting'){setState(point,'waiting');showMs(point);point.querySelector('.live')?.remove();}}}
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
    if(stateName==='running'&&opts.live){const live=document.createElement('span');live.className='live';live.dataset.text=opts.live;live.textContent=liveText(opts.live);point.querySelector('.text').append(live);}
    // Eine Phase steht so, wie ihre Punkte stehen.
    if(li.dataset.kind==='phase'){const states=pointsOf(li).map((node)=>node.dataset.state);
      setState(li,states.includes('fail')?'fail':states.length>0&&states.every((s)=>s==='pass')?'pass':states.some((s)=>s==='running'||s==='pass')?'running':'waiting');
      const sum=pointsOf(li).reduce((total,node)=>total+Number(node.dataset.ms||0),0);showMs(li,li.dataset.state==='pass'||li.dataset.state==='fail'?sum:undefined);}
    summarize();},
  panels:(data)=>{state.requests=data.requests;state.console=data.console;const fails=data.console.filter((c)=>c.severity==='fail').length;setCount('requests',data.requests.length);setCount('console',data.console.length,fails>0);const fresh=fails>seenFails;seenFails=fails;if(fresh&&state.tab===null)select('console');else render();},
  // Stimmung des Laufs: wait, fail, done, aborted, ask (der Chat fragt: Er klappt auf, wenn er zu war, ohne die Wahl zu aendern).
  mood:(value)=>{if(value==='aborted')aborted=true;else if(['wait','fail','done','ask'].includes(value))aborted=false;
    if(value==='ask'){if(!asking&&document.body.classList.contains('fold-chat'))fold('chat',false,false);asking=true;}else if(['wait','fail','done','aborted'].includes(value))asking=false;
    if(value==='fail')showSteps();summarize();},
  // Der Zustand des Chats, etwa showing: Dann zeigt die Leiste der Anwendung, dass aufgenommen wird.
  chatState:(value)=>{chatState=typeof value==='string'?value:null;summarize();},
  // Nur Anwendung, vom Host gesetzt: nach der Uebergabe von selbst, nach dem Neuladen wieder.
  solo:(on)=>showSolo(on===true),
  // Die Tests, aus denen sich hier ein Zustand herstellen laesst; leer blendet F1 aus.
  states:(list)=>{STATES=Array.isArray(list)?list.filter((test)=>Array.isArray(test?.steps)&&test.steps.some((step)=>step.ok)):[];for(const b of document.querySelectorAll('[data-states]'))b.hidden=STATES.length===0;if(!stateDlg.hidden)renderStates();},
  // Aktualisieren geht nur, wenn der Host es erlaubt; sonst ist der Knopf gesperrt.
  refreshable:(on)=>{refreshOn=on===true;$('reload').disabled=!refreshOn||refreshing;$('reload').title=refreshOn?REFRESH_TITLE:T['workbench.page.refreshLockedTitle'];summarize();},
  // Eine Nachricht vom Menschen kam an. Der Rabe fliegt nicht mehr; nichts zu tun.
  nod:()=>{},
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
        const holder = { refresh: null, rebuild: null, html: null, chat: null, fullscreen: null, state: null };
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
        // Themes: nur die Werkbank selbst. Was gespeichert wird, prueft saveTheme (Schema fuer die Seite: kein css, keine Dateien).
        await page.exposeBinding(THEME_BINDING, ({ frame }, action, payload) => {
            if (frame !== page.mainFrame()) return { ok: false, error: 'frame' };
            try {
                const theme = themeAction(action, payload);
                return { ok: true, list: themeList(), theme: clientTheme(theme) };
            } catch (error) {
                return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
            }
        });
        // Zustand waehlen (F1): nur die Werkbank selbst. Was hergestellt werden darf, prueft der Host gegen seinen Katalog.
        await page.exposeBinding(STATE_BINDING, async ({ frame }, test, step) => {
            if (frame !== page.mainFrame() || holder.state === null || typeof test !== 'string') return;
            await holder.state(test, typeof step === 'string' ? step : undefined);
        });
        // Nur Anwendung (F8): Nur die Werkbank selbst meldet es; der Host merkt es sich fuers Neuladen.
        await page.exposeBinding(FULLSCREEN_BINDING, async ({ frame }, on) => {
            if (frame !== page.mainFrame() || holder.fullscreen === null) return;
            await holder.fullscreen(on === true);
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
    const shown = { facts: null, steps: null, states: new Map(), points: new Map(), url: null, mood: null, left: null, chatState: null, solo: false, catalog: null };
    // Nur Anwendung merkt sich der Host, damit sie nach dem Neuladen der Werkbank wiederkommt. Das Browserfenster bleibt unberuehrt.
    bench.fullscreen = async (on) => {
        shown.solo = on;
    };
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
            // Nur Anwendung bleibt nach dem Neuladen, das Fenster ist ohnehin noch im Vollbild.
            if (shown.solo) await call('solo', true);
            if (shown.catalog !== null) await call('states', shown.catalog);
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
        /** Die Tests fuer F1, aus states.mjs (stateCatalog). */
        states: (catalog) => {
            shown.catalog = catalog;
            return call('states', catalog);
        },
        /** Wer einen mit F1 gewaehlten Zustand herstellt: (test, step | undefined); null: aus. */
        onState: (handler) => {
            bench.state = handler ?? null;
        },
        /** Nur Anwendung (F8) an oder aus, etwa von selbst nach der Uebergabe zum Entwickeln. Das Fenster bleibt, wie es ist. */
        solo: async (on) => {
            await bench.fullscreen(on === true);
            await call('solo', on === true);
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
