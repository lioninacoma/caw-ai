// The `explore` card in the browser window, in the Graphite look and the personal mode: the header holds the logo, "caw explore",
// the step as a badge ("2 · Start page") and collapse; the body the instruction with its mark, on the start step the page in a
// mono box ("PAGE /todos") and the primary "Done", which replaces "Enter in the terminal". Tokens sit on the shadow host.
// Lives in a closed shadow DOM: the page cannot restyle it, and surveyPage does not see it (the host element only carries data-caw).
// The phase comes from the host: after every navigation via a binding, in between via an event.

import { readPrefs } from '../shared/prefs.mjs';
import { BASE_CSS, MODE_FUNCTION, fontFaces, icon, logo, modeOf, tokenCss } from './style.mjs';

export const DONE_BINDING = '__cawExploreDone';
export const PHASE_BINDING = '__cawExplorePhase';
export const PHASE_EVENT = 'caw-explore-phase';
/** Card phases: wait (page loading), signin, start (with button), reading, done. The host sends the phase by name. */
export const PHASES = ['wait', 'signin', 'start', 'reading', 'done'];

const CSS = `${tokenCss({ root: ':host', dark: ':host([data-mode=dark])' })}
:host{all:initial}
${BASE_CSS}
.card{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:320px;color:var(--text);font:400 13px/1.45 var(--font);
 border-color:var(--line2);border-radius:var(--r3);box-shadow:var(--shadow-lg)}
.head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none}
.head .logo{color:var(--text);--logo-eye:var(--panel)}
.toggle{width:22px;height:22px;margin-left:2px}.toggle .i{width:14px;height:14px}
.title{font:600 13px/1 var(--font);white-space:nowrap}
.step{margin-left:auto}
.body{padding:12px;display:flex;flex-direction:column;gap:10px}
.card.min .body{display:none}.card.min .head{border-bottom:0}
.text{margin:0;display:flex;gap:8px;align-items:baseline}
.mk{flex:none;display:inline-grid;place-items:center;width:14px;color:var(--run)}.mk.ok{color:var(--pass)}.mk .i{width:14px;height:14px}
.where{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:var(--r1);background:var(--sunk)}
.where b{font:600 10px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.where code{font:400 11.5px/1.3 var(--font-mono);color:var(--accent-text);overflow:hidden;white-space:nowrap;flex:1;min-width:0}
.btn{width:100%}.btn .i{width:14px;height:14px}
.btn:disabled{opacity:1;cursor:default;background:var(--pass-soft);color:var(--pass)}
.dots::after{content:"";animation:dots 1.2s steps(4) infinite}
@keyframes dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
[hidden]{display:none!important}`;

/**
 * The script for addInitScript.
 * @param texts { title, steps: { signin, start }, text: { wait, signin, start, reading, done }, page, button, saved }
 * @param mode  the personal mode pref: system, light or dark
 */
export const exploreCardScript = (texts, mode = readPrefs().mode) => {
    const look = { mode: modeOf(mode), ok: icon('check'), info: icon('chev-r'), min: icon('plus'), open: icon('dash') };
    return `(() => {
    if (window.top !== window) return;
    const T = ${JSON.stringify(texts)};
    const L = ${JSON.stringify(look)};
    ${MODE_FUNCTION}
    const mount = () => {
        if (document.querySelector('[data-caw=explore]') !== null) return;
        // Fonts belong in the document: @font-face does not work inside a shadow DOM.
        if (document.querySelector('style[data-caw-font]') === null) {
            const fonts = document.createElement('style');
            fonts.setAttribute('data-caw-font', '');
            fonts.textContent = ${JSON.stringify(fontFaces())};
            (document.head ?? document.documentElement).appendChild(fonts);
        }
        const host = document.createElement('div');
        host.setAttribute('data-caw', 'explore');
        host.dataset.pref = L.mode;
        cawMode(host);
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = '<style>' + ${JSON.stringify(CSS)} + '</style>'
            + '<div class="card" data-phase="wait"><div class="head">' + ${JSON.stringify(logo({ size: 22 }))} + '<span class="title"></span><span class="step bdg acc"></span><span class="toggle ib"></span></div>'
            + '<div class="body"><p class="text"><span class="mk"></span><span class="say"></span></p><div class="where"><b></b><code></code></div>'
            + '<button type="button" class="btn btn-p"></button></div></div>';
        const $ = (selector) => root.querySelector(selector);
        const card = $('.card');
        $('.title').textContent = T.title;
        $('.where b').textContent = T.page;
        $('.toggle').innerHTML = L.open;
        // Collapse, in case the card covers something on the page.
        $('.head').addEventListener('click', () => {
            card.classList.toggle('min');
            $('.toggle').innerHTML = card.classList.contains('min') ? L.min : L.open;
        });
        const button = $('.btn');
        button.addEventListener('click', () => {
            button.disabled = true;
            button.innerHTML = L.ok;
            button.append(T.saved);
            window.${DONE_BINDING}?.();
        });
        // The mark: a spinner while waiting or reading.
        const mark = (kind) => {
            const mk = $('.mk');
            mk.className = 'mk' + (kind === 'ok' ? ' ok' : '');
            if (kind === 'spin') {
                const spinner = document.createElement('span');
                spinner.className = 'spinner';
                mk.replaceChildren(spinner);
            } else mk.innerHTML = kind === 'ok' ? L.ok : L.info;
        };
        const render = (phase) => {
            if (!${JSON.stringify(PHASES)}.includes(phase)) return;
            card.dataset.phase = phase;
            const step = T.steps[phase] ?? (phase === 'reading' ? T.steps.start : undefined);
            $('.step').textContent = step ?? '';
            $('.step').hidden = step === undefined;
            const say = $('.say');
            say.textContent = T.text[phase] ?? '';
            say.classList.toggle('dots', phase === 'wait' || phase === 'reading');
            mark(phase === 'wait' || phase === 'reading' ? 'spin' : phase === 'done' ? 'ok' : 'info');
            $('.where').hidden = phase !== 'start';
            if (phase === 'start' && !button.disabled) button.textContent = T.button;
            button.hidden = phase !== 'start' && !(phase === 'reading' && button.disabled) && !(phase === 'done' && button.disabled);
        };
        // Shorten long paths at the front: the end tells where you are.
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
