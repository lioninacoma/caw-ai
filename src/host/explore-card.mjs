// Die Karte von `explore` im Browserfenster, im Stil der Werkbank aus dem aktiven Theme: Fenster mit Rahmen und leichten
// Rasterzeilen, im Kopf der ASCII-Rabe (blinzelt, Klick = Herzen), Titel, Schritt und Einklappen. Auf der Startseite der Knopf
// „Fertig“, der „Enter im Terminal“ ersetzt.
// Im geschlossenen Shadow DOM: Die Seite gestaltet sie nicht um, und surveyPage sieht sie nicht (der Wirt traegt nur data-caw).
// Die Phase kommt vom Host, nach jedem Seitenwechsel neu ueber eine Bindung, dazwischen per Ereignis.

import { activeTheme } from '../shared/theme-package.mjs';
import { GLYPH_CSS, GLYPH_SCRIPT, RAVEN_CSS, RAVEN_SCRIPT, fontFaces, ravenLogo, themeStyle, themeVars } from './theme.mjs';

export const DONE_BINDING = '__cawExploreDone';
export const PHASE_BINDING = '__cawExplorePhase';
export const PHASE_EVENT = 'caw-explore-phase';
/** Phasen der Karte: wait (Seite laedt), signin, start (mit Knopf), reading, done. */
export const PHASES = ['wait', 'signin', 'start', 'reading', 'done'];

const css = (theme) => `:host{all:initial;${themeVars(theme)}}
.card{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:350px;background:var(--pane);color:var(--text);
 font:13px/1.45 var(--font-ui);border:2px solid var(--frame);box-shadow:5px 5px 0 rgba(0,0,0,.55);overflow:hidden;isolation:isolate}
.card::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:-1;background:repeating-linear-gradient(0deg,var(--scan) 0 1px,transparent 1px 3px)}
.head{display:flex;align-items:center;gap:10px;padding:6px 10px 6px 4px;background:var(--screen);border-bottom:2px solid var(--line);cursor:pointer;user-select:none}
.raven{font-size:16px}
.title{font:400 22px/1 var(--font-crt);color:var(--accent);text-shadow:0 0 var(--heading-glow) color-mix(in srgb,var(--accent) 40%,transparent);white-space:nowrap}
.step{margin-left:auto;font:400 18px/1 var(--font-crt);color:var(--info);white-space:nowrap}
.toggle{font:400 20px/1 var(--font-crt);color:var(--muted);padding:0 2px}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:10px;text-shadow:0 0 var(--text-glow) var(--text-shine)}
.card.min .body{display:none}
.text{margin:0;display:flex;gap:8px}
.mk{flex:none;display:inline-block;width:1ch;text-align:center;font:400 18px/1.2 var(--font-crt);color:var(--info)}.mk.ok{color:var(--ok)}
.where{display:flex;gap:8px;align-items:baseline;padding:6px 8px;background:var(--screen);box-shadow:inset 0 0 0 2px var(--line)}
.where b{font:400 17px/1 var(--font-crt);color:var(--muted)}
.where code{font:12px/1.3 var(--font-ui);color:var(--info);overflow:hidden;white-space:nowrap;flex:1;min-width:0}
.btn{display:block;width:100%;font:400 24px/1 var(--font-crt);letter-spacing:.06em;border:0;border-radius:0;cursor:pointer;padding:8px 14px;color:var(--ink);background:var(--accent);box-shadow:4px 4px 0 rgba(0,0,0,.5)}
.btn:hover:enabled{filter:brightness(1.08)}.btn:active:enabled{transform:translate(2px,2px);box-shadow:none}
.btn:disabled{cursor:default;background:var(--ok)}
.btn:focus-visible{outline:2px dashed var(--info);outline-offset:3px}
.dots::after{content:"";animation:dots 1.2s steps(4) infinite}
@keyframes dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
@media (prefers-reduced-motion:reduce){.dots::after{animation:none}}
[hidden]{display:none!important}
${RAVEN_CSS}
${GLYPH_CSS}`;

/**
 * Das Skript fuer addInitScript.
 * @param texts { title, steps: { signin, start }, text: { wait, signin, start, reading, done }, page, button, saved }
 * @param theme das aufgeloeste Theme; ohne: das aktive
 */
export const exploreCardScript = (texts, theme = activeTheme()) => {
    const frames = Array.isArray(theme.spinner?.frames) && theme.spinner.frames.length > 0 ? theme.spinner.frames : ['▖'];
    const look = {
        frames,
        ms: Number.isInteger(theme.spinner?.ms) && theme.spinner.ms > 0 ? theme.spinner.ms : 150,
        info: theme.bullets?.info ?? '▸',
        ok: theme.bullets?.ok ?? '■',
        raven: theme.raven,
    };
    return `(() => {
    if (window.top !== window) return;
    const T = ${JSON.stringify(texts)};
    const L = ${JSON.stringify(look)};
    ${RAVEN_SCRIPT}
    ${GLYPH_SCRIPT}
    const mount = () => {
        if (document.querySelector('[data-caw=explore]') !== null) return;
        // Schriften gehoeren ins Dokument: Im Shadow DOM greift @font-face nicht.
        if (document.querySelector('style[data-caw-font]') === null) {
            const fonts = document.createElement('style');
            fonts.setAttribute('data-caw-font', '');
            fonts.textContent = ${JSON.stringify(fontFaces(theme))};
            (document.head ?? document.documentElement).appendChild(fonts);
        }
        const host = document.createElement('div');
        host.setAttribute('data-caw', 'explore');
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = '<style>' + ${JSON.stringify(css(theme))} + '</style>' + ${JSON.stringify(themeStyle(theme))}
            + '<div class="card" data-phase="wait"><div class="head">' + ${JSON.stringify(ravenLogo(theme, { size: 16 }))} + '<span class="title"></span><span class="step"></span><span class="toggle">–</span></div>'
            + '<div class="body"><p class="text"><span class="mk"></span><span class="say"></span></p><div class="where"><b></b><code></code></div><button type="button" class="btn"></button></div></div>';
        const $ = (selector) => root.querySelector(selector);
        const card = $('.card');
        $('.title').textContent = T.title;
        $('.where b').textContent = T.page;
        const still = () => false;
        cawRaven(root, root, still, L.raven);
        // Einklappen, falls die Karte etwas auf der Seite verdeckt. Der Rabe gehoert nicht dazu.
        $('.head').addEventListener('click', () => {
            card.classList.toggle('min');
            $('.toggle').textContent = card.classList.contains('min') ? '+' : '–';
        });
        const button = $('.btn');
        button.textContent = '[ ' + T.button + ' ]';
        button.addEventListener('click', () => {
            button.disabled = true;
            button.textContent = L.ok + ' ' + T.saved;
            window.${DONE_BINDING}?.();
        });
        // Der Spinner in der Marke, solange gewartet oder gelesen wird.
        let spin = 0, frame = 0;
        const mark = (kind) => {
            clearInterval(spin);
            const mk = $('.mk');
            mk.className = 'mk' + (kind === 'ok' ? ' ok' : '');
            if (kind !== 'spin') { mk.textContent = kind === 'ok' ? L.ok : L.info; return; }
            const draw = () => { mk.replaceChildren(cawGlyph(L.frames[frame % L.frames.length])); frame += 1; };
            draw();
            if (!matchMedia('(prefers-reduced-motion: reduce)').matches) spin = setInterval(draw, L.ms);
        };
        const render = (phase) => {
            if (!${JSON.stringify(PHASES)}.includes(phase)) return;
            card.dataset.phase = phase;
            const step = T.steps[phase] ?? (phase === 'reading' ? T.steps.start : undefined);
            $('.step').textContent = step === undefined ? '' : '[' + step + ']';
            $('.step').hidden = step === undefined;
            const say = $('.say');
            say.textContent = T.text[phase];
            say.classList.toggle('dots', phase === 'wait' || phase === 'reading');
            mark(phase === 'wait' || phase === 'reading' ? 'spin' : phase === 'done' ? 'ok' : 'info');
            $('.where').hidden = phase !== 'start';
            button.hidden = phase !== 'start' && !button.disabled;
        };
        // Lange Pfade vorn kuerzen: Das Ende sagt, wo man ist.
        const path = () => {
            const full = location.pathname + location.search.replace(/[?&](token|code|session)[^&]*/gi, '') + location.hash;
            $('.where code').textContent = full.length > 36 ? '…' + full.slice(-35) : full;
        };
        path();
        setInterval(path, 500);
        window.addEventListener(${JSON.stringify(PHASE_EVENT)}, (event) => render(event.detail));
        render('wait');
        window.${PHASE_BINDING}?.().then(render, () => {});
        document.body.appendChild(host);
    };
    if (document.body !== null) mount();
    else document.addEventListener('DOMContentLoaded', mount);
})();`;
};
