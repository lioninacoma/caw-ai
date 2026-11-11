// The `explore` card in the browser window, styled like the workbench from the active theme: framed window with faint scan lines,
// the ASCII raven in the header (blinks, click = hearts), title, step and collapse. On the start step it shows the "Done" button,
// which replaces "Enter in the terminal".
// Lives in a closed shadow DOM: the page cannot restyle it, and surveyPage does not see it (the host element only carries data-caw).
// The phase comes from the host: after every navigation via a binding, in between via an event.

import { activeTheme } from '../shared/theme-package.mjs';
import { GLYPH_CSS, GLYPH_SCRIPT, RAVEN_CSS, RAVEN_SCRIPT, fontFaces, ravenLogo, themeStyle, themeVars } from './theme.mjs';

export const DONE_BINDING = '__cawExploreDone';
export const PHASE_BINDING = '__cawExplorePhase';
export const PHASE_EVENT = 'caw-explore-phase';
/** Saves the signed-in test user under the role typed in the card: (role) -> { ok, error? }. */
export const ROLE_BINDING = '__cawExploreRole';
/** After saving: 'more' (sign in as another test user) or 'finish'. */
export const NEXT_BINDING = '__cawExploreNext';
/** The credentials the page reads before the sign-in goes out; only the host keeps them. */
export const CREDENTIALS_BINDING = '__cawExploreCredentials';
/**
 * Card phases: wait (page loading), signin, start (with button), reading, done; role (name the test user, save) and saved
 * (another role or finish). The host sends a phase as a name or as { phase, user, role }.
 */
export const PHASES = ['wait', 'signin', 'start', 'reading', 'done', 'role', 'saved'];

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
.btn:focus-visible,.btn2:focus-visible{outline:2px dashed var(--info);outline-offset:3px}
.btn2{display:block;width:100%;font:400 20px/1 var(--font-crt);letter-spacing:.06em;border:0;border-radius:0;cursor:pointer;padding:6px 14px;color:var(--text);background:var(--screen);box-shadow:inset 0 0 0 2px var(--line)}
.btn2:hover{color:var(--accent)}
.role{display:flex;gap:8px;align-items:center;padding:6px 8px;background:var(--screen);box-shadow:inset 0 0 0 2px var(--line)}
.role b{font:400 17px/1 var(--font-crt);color:var(--muted)}
.role input{flex:1;min-width:0;font:13px/1.3 var(--font-ui);color:var(--text);background:transparent;border:0;outline:0;padding:2px 0}
.err{margin:0;color:var(--fail)}
.dots::after{content:"";animation:dots 1.2s steps(4) infinite}
@keyframes dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
@media (prefers-reduced-motion:reduce){.dots::after{animation:none}}
[hidden]{display:none!important}
${RAVEN_CSS}
${GLYPH_CSS}`;

/**
 * The script for addInitScript.
 * @param texts { title, steps: { signin, start, role }, text: { wait, signin, start, reading, done, role, saved }, page, button, saved,
 *              role: { label, save, more, finish } }; {user} and {role} in the texts are filled in
 * @param theme the resolved theme; defaults to the active one
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
        // Fonts belong in the document: @font-face does not work inside a shadow DOM.
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
            + '<div class="body"><p class="text"><span class="mk"></span><span class="say"></span></p><div class="where"><b></b><code></code></div>'
            + '<label class="role"><b></b><input type="text" spellcheck="false" autocomplete="off" maxlength="32"></label><p class="err"></p>'
            + '<button type="button" class="btn"></button><button type="button" class="btn2"></button></div></div>';
        const $ = (selector) => root.querySelector(selector);
        const card = $('.card');
        $('.title').textContent = T.title;
        $('.where b').textContent = T.page;
        const still = () => false;
        cawRaven(root, root, still, L.raven);
        // Collapse, in case the card covers something on the page. The raven is not part of it.
        $('.head').addEventListener('click', () => {
            card.classList.toggle('min');
            $('.toggle').textContent = card.classList.contains('min') ? '+' : '–';
        });
        const button = $('.btn');
        const second = $('.btn2');
        const input = $('.role input');
        const err = $('.err');
        $('.role b').textContent = T.role?.label ?? '';
        let current = 'wait';
        const label = () => '[ ' + (current === 'role' ? T.role.save : current === 'saved' ? T.role.finish : T.button) + ' ]';
        const save = async () => {
            button.disabled = true;
            err.textContent = '';
            const result = await window.${ROLE_BINDING}?.(input.value.trim().toLowerCase()).catch(() => null);
            button.disabled = false;
            if (result?.ok !== true) err.textContent = result?.error ?? '';
        };
        button.addEventListener('click', () => {
            if (current === 'role') { save(); return; }
            if (current === 'saved') { button.disabled = true; window.${NEXT_BINDING}?.('finish'); return; }
            button.disabled = true;
            button.textContent = L.ok + ' ' + T.saved;
            window.${DONE_BINDING}?.();
        });
        second.addEventListener('click', () => { second.disabled = true; window.${NEXT_BINDING}?.('more'); });
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });
        // The spinner in the marker while waiting or reading.
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
        const render = (detail) => {
            const phase = typeof detail === 'string' ? detail : detail?.phase;
            if (!${JSON.stringify(PHASES)}.includes(phase)) return;
            const fill = (text) => String(text ?? '').replaceAll('{user}', detail?.user ?? '').replaceAll('{role}', detail?.role ?? '');
            // A new round (another test user) starts with fresh buttons.
            if (phase !== current && (phase === 'role' || phase === 'saved' || phase === 'signin')) { button.disabled = false; second.disabled = false; }
            current = phase;
            card.dataset.phase = phase;
            const step = T.steps[phase] ?? (phase === 'reading' ? T.steps.start : undefined);
            $('.step').textContent = step === undefined ? '' : '[' + step + ']';
            $('.step').hidden = step === undefined;
            const say = $('.say');
            say.textContent = fill(T.text[phase]);
            say.classList.toggle('dots', phase === 'wait' || phase === 'reading');
            mark(phase === 'wait' || phase === 'reading' ? 'spin' : phase === 'done' || phase === 'saved' ? 'ok' : 'info');
            $('.where').hidden = phase !== 'start';
            $('.role').hidden = phase !== 'role';
            err.textContent = '';
            if (phase === 'role') { input.value = detail?.role ?? ''; setTimeout(() => { input.focus(); input.select(); }, 0); }
            second.hidden = phase !== 'saved';
            if (phase === 'saved') second.textContent = '[ ' + T.role.more + ' ]';
            if (phase === 'role' || phase === 'saved' || (phase === 'start' && !button.disabled)) button.textContent = label();
            button.hidden = !['start', 'role', 'saved'].includes(phase) && !(phase === 'reading' && button.disabled) && !(phase === 'done' && button.disabled);
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
