// The chat in the workbench, left of the application iframe: Claude asks and reports, the human answers, pauses or
// aborts. Deliberately not inside the application page: there it could cover buttons, end up in snapshots and recordings,
// and the page itself could slip instructions to Claude. The binding only exists on the chat page.

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

import { CawError } from '../shared/errors.mjs';
import { language, t, texts } from '../shared/i18n.mjs';
import { activeTheme } from '../shared/theme-package.mjs';
import { sourceTag } from './app-view.mjs';
import { cancelPick, pickElement } from './demonstrate.mjs';
import { reportPage } from './report-page.mjs';
import { APPLY_THEME_SCRIPT, CONSOLE_CSS, FAVICON, GLYPH_SCRIPT, clientTheme, themeAttr, themeCss, themeStyle } from './theme.mjs';

const BINDING = '__cawChat';
const MAX_TEXT = 4000;
const MAX_ACTIVITY = 300;
const TAIL_MS = 500;
const LOGGED = new Set(['human', 'checkpoint', 'claude', 'question', 'plan', 'advice', 'failure', 'decision']);
// The human is demonstrating: a reload is then part of the path, not a break of the run.
const SHOWING_STATES = ['showing', 'asking', 'paused'];
const PICK_STATES = ['paused', 'asking', 'showing', 'planning', 'discussing', 'developing'];
// Conversations with open input: a message goes to the flow together with the picked element.
const TALK_KINDS = ['discussing', 'developing'];
// The human has to act here, so the window must not stay behind the application.
const NEEDS_HUMAN = ['choosing', 'planning', 'deciding', 'reviewing', 'discussing'];
// Then the workbench's raven turns to the chat.
const RAVEN_ASKS = [...NEEDS_HUMAN, 'asking', 'showing', 'developing'];
const UNNAMED_ELEMENT_NOTE = 'This is the element I mean.';

// Status line, pill and button per state. Fetched at runtime: the language is not known yet at import time.
const STATES = ['running', 'pausing', 'paused', 'asking', 'showing', 'choosing', 'planning', 'handing', 'verifying', 'testing', 'discussing', 'preparing', 'deciding', 'advising', 'reviewing', 'developing', 'closed'];
const statusTexts = (state) => {
    const part = (name) => {
        const key = `chat.status.${state}.${name}`;
        const text = t(key);
        return text === key ? '' : text;
    };
    return STATES.includes(state) ? { text: part('text'), label: part('label'), button: part('button') } : undefined;
};

/**
 * A line from claude.log: text becomes a message, commands become actions. What makes up the conversation itself is
 * already in the chat and is dropped here.
 * @returns { kind: 'text' | 'activity', text } or null
 */
export const parseClaudeLog = (line) => {
    const match = /^\[\+[\d.]+s\] (> )?(.*)$/.exec(line);
    if (match === null || match[2].trim() === '') return null;
    // The tool reports the end itself, with the result instead of the duration.
    if (match[1] === undefined && match[2].startsWith('Claude finished after')) return null;
    // Free text is Claude's notes to itself. It addresses the human only via say.
    if (match[1] === undefined) return { kind: 'text', text: match[2].replaceAll(' ⏎ ', ' ').slice(0, MAX_ACTIVITY) };
    const text = readableCommand(match[2]).replace(/^Bash: /, '').replace(/(^|[\s;&|(])caw-ai /g, '$1').replaceAll(' ⏎ ', '; ').trim();
    if (/^(say|chat|plan)\b/.test(text) && !/[;&|]/.test(text)) return null;
    return { kind: 'activity', text: text.slice(0, MAX_ACTIVITY) };
};

/**
 * The local agent calls caw via MCP; the log then reads `mcp__caw__caw: {"args":["click","button \"Senden\""]}`. The human
 * should read the same command as with the agent in Docker: `click button "Senden"`. Other tools without their internal prefix.
 */
const readableCommand = (text) => {
    const call = /^mcp__[\w-]+__caw: (\{.*)$/.exec(text);
    if (call === null) return text.replace(/^mcp__[\w-]+__(\w+): /, '$1: ');
    const shown = (args) => args.map(String).map((arg) => (arg === '' || (/\s/.test(arg) && !/["']/.test(arg)) ? `"${arg}"` : arg)).join(' ');
    try {
        const { args } = JSON.parse(call[1]);
        if (Array.isArray(args)) return shown(args);
    } catch {
        // Truncated in the log: read the complete texts, the last one ends with "…".
    }
    const body = call[1].replace(/^\{"args":\[/, '');
    const parts = [...body.matchAll(/"((?:[^"\\]|\\.)*)("|$)/g)].map(([, value, end]) => {
        const plain = value.replace(/\\(.)/g, '$1');
        return end === '"' ? plain : `${plain}…`;
    });
    return parts.length === 0 ? text.replace(/^mcp__[\w-]+__(\w+): /, '$1: ') : shown(parts);
};

/**
 * Reads new complete lines of a growing file.
 * @param read returns the whole text, empty while the file does not exist
 * @returns stop: reads one last time and stops following
 */
export const tailLines = (read, onLine, intervalMs = TAIL_MS) => {
    let done = 0;
    const poll = () => {
        const text = read();
        const end = text.lastIndexOf('\n') + 1;
        if (end <= done) return;
        text.slice(done, end).split('\n').filter(Boolean).forEach(onLine);
        done = end;
    };
    const timer = setInterval(poll, intervalMs);
    timer.unref?.();
    return () => {
        clearInterval(timer);
        poll();
    };
};

/**
 * The conversation state, without a browser.
 * @param show    shows an entry: ('human' | 'checkpoint' | 'claude' | 'question' | 'activity', text, element label)
 * @param status  shows the state, see STATES; plus the options when the human has to decide
 * @param onAbort the human aborts the whole run
 */
export const createChat = ({ show = () => {}, status = () => {}, onAbort = () => {} } = {}) => {
    const unread = [];
    const lines = [];
    let paused = false;
    let capturing = null;
    let waiter = null;
    let ended = false;
    let endAfterText = false;
    let finishing = false;
    let element = null;
    let planAnswer = null;
    let choice = null;
    // A conversation that must wait until an open question (e.g. the token notice) is answered.
    let queued = null;
    // Claude is idle but the run is not: verifying or preparing.
    let background = null;

    const state = () => {
        if (ended) return 'closed';
        if (choice !== null) return choice.kind;
        if (planAnswer !== null) return 'planning';
        if (capturing !== null) return capturing;
        if (background !== null) return background;
        return paused ? 'pausing' : 'running';
    };
    const publish = () => status(state(), choice?.options);
    /** Ends a wait for the human. */
    const answerPlan = (answer) => {
        const resolve = planAnswer;
        planAnswer = null;
        element = null;
        resolve?.(answer);
    };
    const answerChoice = (id) => {
        const resolve = choice?.resolve;
        choice = null;
        resolve?.(id);
        if (choice === null && queued !== null && !ended) {
            choice = queued;
            queued = null;
            publish();
        }
    };
    /** Opens a conversation; if another question is open, it goes first and the conversation follows. */
    const offer = (next) => {
        if (choice !== null && !TALK_KINDS.includes(choice.kind)) queued = next;
        else choice = next;
    };
    const deliver = (line) => {
        if (waiter === null) {
            lines.push(line);
            return;
        }
        const resolve = waiter;
        waiter = null;
        resolve(line);
    };
    const claudeText = (who, raw) => {
        const text = String(raw ?? '').trim().slice(0, MAX_TEXT);
        if (text === '') throw new CawError('usage', 'The text is missing.');
        if (!ended) show(who, text);
        return 'ok';
    };

    return {
        human: {
            /** A checkpoint only arises while demonstrating and only on explicit request; everything else is context. */
            message: (raw, { checkpoint = false } = {}) => {
                const text = String(raw ?? '').trim().slice(0, MAX_TEXT);
                if (text === '' || ended) return;
                const isCheckpoint = checkpoint && capturing === 'showing';
                show(isCheckpoint ? 'checkpoint' : 'human', text, element?.label);
                const about = element === null ? {} : { element };
                element = null;
                if (planAnswer !== null) {
                    answerPlan({ approved: false, feedback: text, ...about });
                    publish();
                } else if (TALK_KINDS.includes(choice?.kind)) {
                    answerChoice({ message: text, ...about });
                    publish();
                } else if (capturing === null) unread.push(text);
                else deliver(isCheckpoint ? { checkpoint: text, ...about } : { note: text, ...about });
            },
            /** The toggle button: pauses, resumes, or hands back to Claude after input. */
            toggle: () => {
                // An ignored click also gets a state back: the button stays locked until then.
                if (ended || choice !== null || (background !== null && capturing === null)) {
                    publish();
                    return;
                }
                if (planAnswer !== null) {
                    show('human', t('chat.planApproved'));
                    answerPlan({ approved: true });
                } else if (capturing !== null) {
                    // A picked element without text must not get lost.
                    if (element !== null) deliver({ note: UNNAMED_ELEMENT_NOTE, element });
                    element = null;
                    // End of the demonstration: nothing to click here until the next section.
                    if (capturing === 'showing') {
                        capturing = null;
                        background = 'handing';
                    }
                    deliver('');
                } else paused = !paused;
                publish();
            },
            /** One of the offered options. Unknown values are ignored. */
            choose: (id) => {
                const option = choice?.options.find((candidate) => candidate.id === id);
                if (option === undefined) return;
                show('human', option.label);
                answerChoice(id);
                publish();
            },
            abort: () => {
                answerChoice(null);
                answerPlan({ approved: false, feedback: null });
                onAbort();
            },
            closed: () => {
                ended = true;
                paused = false;
                unread.length = 0;
                if (capturing !== null) deliver(null);
                answerChoice(null);
                answerPlan({ approved: false, feedback: null });
            },
        },
        say: (raw) => claudeText('claude', raw),
        /** A message from the tool that needs no action from the human. */
        notice: (text) => {
            if (!ended) show('question', text);
        },
        ask: (raw) => claudeText('question', raw),
        /**
         * Presents the plan and waits: { approved: true } or { approved: false, feedback }.
         * @param view { repairing, notes, steps } from planView; logged as text
         */
        plan: (view) => {
            if (ended) return Promise.resolve({ approved: false, feedback: null });
            return new Promise((resolve) => {
                planAnswer = resolve;
                show('plan', view.steps.map(({ id, name, expect }) => `${id} ${name}: ${expect}`).join(' | '), view);
                publish();
            });
        },
        /**
         * The human picks by button.
         * @param kind choosing or deciding
         * @param card the decision as a card (title, facts, details); `question` then only goes to the log
         * @returns the option id, null if the window closes or the human aborts
         */
        choose: (kind, question, options, card) => {
            if (ended) return Promise.resolve(null);
            // In the middle of a conversation (e.g. the token notice before Claude answers): the conversation reopens afterwards.
            const parked = TALK_KINDS.includes(choice?.kind) ? choice : null;
            return new Promise((resolve) => {
                choice = {
                    kind,
                    options,
                    resolve: parked === null ? resolve : (id) => {
                        if (!ended) choice = parked;
                        resolve(id);
                        publish();
                    },
                };
                if (card === undefined) show('question', question);
                else show('decision', question, card);
                publish();
            });
        },
        /**
         * An advice as a card; the human decides by button.
         * @param view from adviceView; logged as its title
         * @returns the option id, null if the window closes
         */
        advice: (view, options) => {
            if (ended) return Promise.resolve(null);
            // In the middle of a conversation: the card comes in between, then the conversation reopens.
            const parked = TALK_KINDS.includes(choice?.kind) ? choice : null;
            return new Promise((resolve) => {
                choice = {
                    kind: 'reviewing',
                    options,
                    resolve: (id) => {
                        if (parked !== null && !ended) choice = parked;
                        resolve(id);
                        publish();
                    },
                };
                show('advice', `${view.side === 'app' ? 'Application' : 'Test'}: ${view.title}`, view);
                publish();
            });
        },
        /**
         * After a failure: the human writes or picks. Stays open while Claude answers.
         * @param question if omitted, no new question appears and the conversation continues
         * @param card     the failure as a card; `question` then only goes to the log
         * @returns { choice } with the id, { message } with the text, null if the window closes
         */
        discuss: (question, options, card) => {
            if (ended) return Promise.resolve(null);
            return new Promise((resolve) => {
                offer({ kind: 'discussing', options, resolve: (answer) => resolve(typeof answer === 'string' ? { choice: answer } : answer) });
                // The test run is over: between two answers the chat no longer shows it as running.
                if (background === 'testing') background = null;
                if (question !== undefined) show(card === undefined ? 'question' : 'failure', question, card);
                publish();
            });
        },
        /**
         * After the hand-over: the human develops in the prepared state. Like discuss, but without a failure and without a focus change.
         * @returns { choice } with the id, { message, element? } with the text, null if the window closes
         */
        develop: (question, options) => {
            if (ended) return Promise.resolve(null);
            return new Promise((resolve) => {
                offer({ kind: 'developing', options, resolve: (answer) => resolve(typeof answer === 'string' ? { choice: answer } : answer) });
                background = null;
                if (question !== undefined) show('question', question);
                publish();
            });
        },
        /** The picked element without a message, e.g. for the human's own Claude Code session. Cleared afterwards. */
        takeElement: () => {
            const picked = element;
            element = null;
            return picked;
        },
        /** The test runs without Claude; the chat only watches. */
        testing: () => {
            background = 'testing';
            publish();
        },
        /** Claude investigates in the run's browser. false: done. */
        advising: (active = true) => {
            background = active ? 'advising' : null;
            publish();
        },
        /** From now on the verification run goes without Claude. */
        verifying: () => {
            background = 'verifying';
            publish();
        },
        /** The steps before the one to fix run without Claude. false hands over to Claude. */
        preparing: (active = true) => {
            background = active ? 'preparing' : null;
            publish();
        },
        progress: (text) => {
            if (!ended) show('activity', text);
        },
        /** A line from Claude's log: for reading along only, it does not change the conversation. */
        logLine: (line) => {
            const entry = parseClaudeLog(line);
            if (entry === null || ended) return;
            show('activity', entry.text);
        },
        /** Before every browser command: while the human has something to say, nothing more happens in the application. */
        gate: () => {
            if (paused || unread.length > 0) throw new CawError('human-message', 'The human has written in the chat. Call caw-ai chat before you continue.');
        },
        canPick: () => !ended && (capturing !== null || planAnswer !== null || TALK_KINDS.includes(choice?.kind)),
        attach: (picked) => { element = picked; },
        detach: () => { element = null; },
        takeUnread: () => unread.splice(0),
        paused: () => paused,
        available: () => !ended,
        /** From here on clicks in the application count: Claude is waiting, so its own clicks are not included. */
        enter: (kind) => {
            capturing = kind;
            if (background === 'handing') background = null;
            endAfterText = kind === 'asking';
            finishing = false;
            lines.length = 0;
            publish();
        },
        leave: () => {
            capturing = null;
            element = null;
            paused = false;
            publish();
        },
        /** For demonstrate: text is a checkpoint, { note } a hint, empty means done. An answer to a question ends the wait at once. */
        operator: {
            available: () => !ended,
            nextLine: ({ signal } = {}) => {
                if (finishing) return Promise.resolve('');
                const remember = (line) => {
                    if (endAfterText && line !== '' && line !== null) finishing = true;
                    return line;
                };
                if (lines.length > 0) return Promise.resolve(remember(lines.shift()));
                if (ended) return Promise.resolve(null);
                return new Promise((resolve) => {
                    waiter = (line) => resolve(remember(line));
                    signal?.addEventListener('abort', () => {
                        waiter = null;
                        resolve(null);
                    }, { once: true });
                });
            },
        },
    };
};

/** The chat page in the current language; texts for the page script are in T. Exported for preview and tests. */
export const chatPage = (nonce = '', theme = activeTheme()) => `<!doctype html><html lang="${language()}"${themeAttr(theme)}><head><meta charset="utf-8"><title>caw-ai · Chat</title><script>(()=>{${APPLY_THEME_SCRIPT}
// The theme comes from the workbench: the chat is isolated in its own origin. Colours only via cawApplyTheme (validates
// itself), glyphs and prompts only as text (cawThemeText below).
addEventListener('message',(event)=>{if(event.source!==parent||event.data?.caw!=='theme')return;cawApplyTheme(document.documentElement,event.data.theme);window.cawThemeText?.(event.data.theme);});try{parent.postMessage({caw:'theme-request'},'*');}catch{}})();${sourceTag}</script>${FAVICON}<style>
${themeCss(theme)}${CONSOLE_CSS}
*,*::before,*::after{box-sizing:border-box}html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--pane);color:var(--text);font:var(--fs-body)/1.5 var(--font-body)}
header{display:flex;align-items:center;gap:10px;padding:8px 12px 7px;border-bottom:2px solid var(--line)}
h1{margin:0;flex:1;min-width:0;display:flex;gap:.5ch;overflow:hidden;font:400 19px/1 var(--font-crt);color:var(--faint);white-space:nowrap}h1 .name{color:var(--claude)}h1 .dot{color:var(--faint)}h1 [data-fill]{flex:1;min-width:0;overflow:hidden}#abort,#abortNo{flex:none}
/* Narrow chat: abort takes precedence over the name. The state (Claude working …) is shown only by the pill in the workbench header. */
@media (max-width:440px){h1 .name,h1 .dot{display:none}}
[data-state=discussing] #toggle,[data-state=developing] #toggle{display:none}[data-state=deciding] #abort,[data-state=discussing] #abort,[data-state=developing] #abort,[data-state=closed] #abort{display:none}
#abortNo,#abort{white-space:nowrap;border:0;background:none;padding:3px 7px;font:400 19px/1 var(--font-crt);color:var(--muted)}
#abortNo{color:var(--text)}#abortNo:hover,#abort:hover{background:var(--pane-2);color:var(--text)}#abortNo[hidden]{display:none}
#abort.sure{background:var(--fail);color:var(--ink)}#abort:disabled{color:var(--muted);cursor:default;background:none}
main{flex:1;overflow-y:auto;padding:12px 12px 8px;display:flex;flex-direction:column;gap:12px;scrollbar-color:var(--line) var(--pane)}
footer{position:relative}#down{display:none;position:absolute;right:12px;top:6px;width:32px;height:32px;place-items:center;padding:0;background:var(--screen);border:0;box-shadow:inset 0 0 0 2px var(--frame);color:var(--text)}#down.on{display:grid}footer:has(#down.on) #status{min-height:44px;padding-right:44px}#down:hover{background:var(--pane-2)}#down svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:square;stroke-linejoin:miter}#down.new::after{content:"";position:absolute;top:3px;right:3px;width:6px;height:6px;background:var(--info)}
.message{white-space:pre-wrap;overflow-wrap:anywhere}
/* The speaker is shown in front like in a console: claude> and du>. */
/* Prompts, marks and glyphs are set by the page script as text from the theme (data-who, data-mark, data-bullet, data-tree). */
.who{display:block;font:400 19px/1.1 var(--font-crt);white-space:pre}.who.c{color:var(--claude)}.who.h{color:var(--human)}.who .cp{color:var(--muted);margin-left:8px}
.about{display:block;font:11.5px/1.4 var(--font-mono);color:var(--muted);margin-bottom:2px;overflow-wrap:anywhere}
.about .tr,.bl{color:var(--faint);margin-right:6px}.bl{color:var(--ok)}
.mk{font:400 18px/1 var(--font-crt);white-space:pre;margin-right:8px}
/* Cards: windows within the window, the header line in VT323 with the mark in front. */
.question,.plan,.advice,.failure,.decision{padding:10px 12px 11px;background:var(--pane-2);border:2px solid var(--line);white-space:normal}
.question{border-color:var(--info)}.question>.who .mk{color:var(--info)}
.plan strong,.advice strong,.failure strong,.decision strong{display:block;font:400 20px/1.1 var(--font-crt);color:var(--accent);margin-bottom:6px;text-shadow:0 0 8px var(--glow);white-space:pre-wrap}
.plan{border-color:var(--frame)}
.plan .notes{color:var(--muted);font-size:13px;margin-bottom:6px}.step{padding:8px 0;border-top:2px dashed var(--line)}.step:first-of-type{border-top:0}.step .head{display:flex;gap:8px;align-items:baseline;font-weight:500}.step .sid{flex:none;font:400 18px/1 var(--font-crt);color:var(--info)}.step dl{margin:4px 0 0;display:grid;gap:4px}.step dt{font:400 17px/1 var(--font-crt);color:var(--muted)}.step dd{margin:0}.step .changed{box-shadow:inset 3px 0 0 var(--warn);padding-left:9px}.step .changed dt::after{content:${JSON.stringify(t('chat.page.changed'))};color:var(--warn)}.step .before{color:var(--muted);text-decoration:line-through}
.failure{border-color:var(--fail);background:var(--fail-tint)}.failure strong{color:var(--text);text-shadow:none}.failure strong .mk{color:var(--fail)}.fail-inv .failure strong .mk{background:var(--fail);color:var(--ink)}
.failure .reason{margin:0 0 9px;font-size:15px;line-height:1.4;overflow-wrap:anywhere}
.failure .badge{display:inline-block;margin:0 0 9px;padding:2px 8px;font:400 18px/1.1 var(--font-crt);color:var(--muted);box-shadow:inset 0 0 0 2px currentColor}.failure .badge.app{color:var(--fail)}.failure .badge.environment{color:var(--warn)}.failure .badge.test{color:var(--info)}
.decision{border-color:var(--ok)}.decision strong{color:var(--text);text-shadow:none}.decision strong .mk{color:var(--ok)}
.decision ul{margin:0 0 8px;padding-left:18px;display:grid;gap:4px;font-size:13.5px;overflow-wrap:anywhere}.decision details{margin:0 0 6px}.decision summary{cursor:pointer;font-size:13.5px;font-weight:500}.decision details ul{margin:4px 0 0;color:var(--muted)}.decision .next{margin:6px 0 0;font-size:13.5px;font-weight:500}
.failure .warn,.advice .warn,.decision .warn{margin:0 0 9px;padding:6px 9px;font-size:13px;color:var(--warn);background:var(--screen);box-shadow:inset 3px 0 0 var(--warn)}
.failure details{margin:0 0 6px}.failure summary{cursor:pointer;font-size:13.5px;font-weight:500}.failure ul{margin:4px 0 0;padding-left:18px;display:grid;gap:4px;font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}.failure .next{margin:6px 0 0;font-size:13px;color:var(--muted)}
.advice{border-color:var(--frame)}.advice.app{border-color:var(--info)}.advice strong{color:var(--muted);text-shadow:none}.advice.app strong{color:var(--info)}.advice strong .bl{color:inherit}
.advice h2{margin:0 0 4px;font-size:15px;font-weight:500}.advice .target{font:12px var(--font-mono);color:var(--muted);margin-bottom:6px;overflow-wrap:anywhere}.advice .reason{margin:0 0 8px}.advice dl{margin:0;display:grid;gap:6px}.advice dt{font:400 17px/1 var(--font-crt);color:var(--muted)}.advice dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.advice .before{color:var(--muted);text-decoration:line-through}
.advice pre{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--screen);padding:8px 10px;font:12px/1.45 var(--font-mono);box-shadow:inset 0 0 0 2px var(--line)}.advice pre.del{text-decoration:line-through;color:var(--muted);margin-bottom:6px}
.advice .copy{margin-top:8px;padding:5px 10px;font:400 18px/1 var(--font-crt);color:var(--text);background:var(--pane);border:0;box-shadow:inset 0 0 0 2px var(--frame)}.advice .copy:hover{background:var(--line)}
/* Actions muted: ■ click … */
details.activity{font-size:12.5px;color:var(--muted)}
details.activity summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;padding:1px 0;user-select:none;font:12.5px var(--font-mono)}
details.activity summary::-webkit-details-marker{display:none}
details.activity summary::before{content:"▸";flex:none;color:var(--faint)}
details.activity[open] summary::before{content:"▾"}
details.activity .latest{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
details.activity ol{list-style:none;margin:6px 0 2px 2px;padding:0 0 0 12px;box-shadow:inset 2px 0 0 var(--line);display:flex;flex-direction:column;gap:2px}
details.activity li{font:12px/1.45 var(--font-mono);overflow-wrap:anywhere}
#thinking{display:none;gap:8px;align-items:baseline;font:400 19px/1 var(--font-crt)}[data-state=running] #thinking,[data-state=advising] #thinking{display:flex}
#thinking .who{display:inline}#thinking i{font-style:normal;color:var(--info)}
footer{padding:0 10px 10px}
#status{padding:6px 2px;font-size:12.5px;line-height:1.45;color:var(--muted)}
[data-state=paused] #status,[data-state=asking] #status,[data-state=showing] #status,[data-state=planning] #status{color:var(--text)}
#choices{display:none;flex-direction:column;gap:10px;padding:4px 4px 12px 2px}[data-state=choosing] #choices,[data-state=deciding] #choices,[data-state=reviewing] #choices,[data-state=discussing] #choices,[data-state=developing] #choices,[data-state=planning] #choices{display:flex}
#choices button.big{min-height:46px;font-size:24px}[data-state=planning] #toggle{display:none}
/* For failure, decision and advice the card needs the space: compact buttons, secondary ones side by side. */
#choices .rest{display:flex;flex-wrap:wrap;gap:10px}#choices .rest button{flex:1 1 auto;min-width:96px}
:is([data-state=discussing],[data-state=deciding],[data-state=reviewing]) #choices{gap:6px;padding-bottom:10px}:is([data-state=discussing],[data-state=deciding],[data-state=reviewing]) #choices .rest{gap:6px}
:is([data-state=discussing],[data-state=deciding],[data-state=reviewing]) #choices button{min-height:32px;padding:5px 10px}
#choices button.sure{background:var(--fail);color:var(--ink);box-shadow:none}#choices .no{flex:0 0 auto;min-width:0}
kbd{display:inline-block;margin-left:8px;padding:0 4px;font:400 15px/1.1 var(--font-crt);opacity:.8;box-shadow:inset 0 0 0 1px currentColor}
#next{display:none;margin:2px 2px 12px;padding:10px 12px;background:var(--pane-2);border:2px solid var(--frame)}[data-state=closed] #next.on{display:block}[data-state=closed]:has(#next.on) #form{display:none}
#next strong{display:block;font:400 20px/1.1 var(--font-crt);color:var(--accent);margin-bottom:4px;text-shadow:0 0 8px var(--glow)}#next p{margin:0 0 10px;font-size:13px;color:var(--muted)}#next code{font:12px var(--font-mono);color:var(--info);overflow-wrap:anywhere}#next .cmd{margin:12px 0 0}
#next .acts{display:flex;flex-wrap:wrap;gap:10px}
#report,#closeWindow{min-height:36px;padding:6px 14px;font:400 20px/1 var(--font-crt);border:0;background:var(--accent);color:var(--ink);box-shadow:4px 4px 0 var(--drop-shadow)}#report:hover,#closeWindow:hover{filter:brightness(1.08)}#report:active,#closeWindow:active{transform:translate(2px,2px);box-shadow:none}
#closeWindow[hidden]{display:none}#next:has(#closeWindow:not([hidden])) #report{background:var(--pane);color:var(--text);box-shadow:inset 0 0 0 2px var(--frame)}
#choices button{min-height:38px;padding:7px 12px;font:400 20px/1.1 var(--font-crt);text-align:center;color:var(--text);background:var(--pane);border:0;box-shadow:inset 0 0 0 2px var(--frame)}
#choices button:hover{background:var(--line)}#choices button:active{transform:translate(1px,1px)}
#choices button.primary{background:var(--accent);color:var(--ink);box-shadow:4px 4px 0 var(--drop-shadow)}#choices button.primary:hover{filter:brightness(1.08)}
#choices button:disabled{cursor:progress;opacity:.55;transform:none}#choices button.busy{opacity:1}
[data-state=handing] form,[data-state=choosing] form,[data-state=deciding] form,[data-state=reviewing] form,[data-state=verifying] form,[data-state=testing] form,[data-state=preparing] form,[data-state=advising] form{display:none}
/* The input as a prompt: du> with a blinking block, only while the field has focus and is empty. Without focus no cursor and a
   muted du>: otherwise it looks as if typing goes to the chat while the keys land in the application. */
form{margin:2px;padding:8px 10px;background:var(--screen);box-shadow:inset 0 0 0 2px var(--line)}
form:focus-within{box-shadow:inset 0 0 0 2px var(--human)}
.prompt{display:flex;align-items:flex-start;gap:8px}.prompt .p{flex:none;font:400 20px/1.15 var(--font-crt);color:var(--muted)}
form:focus-within .prompt .p{color:var(--human)}
.cursor{flex:none;display:none;width:.55em;height:1.1em;margin-top:2px;background:var(--human);animation:caw-cursor var(--cursor-ms,1000ms) steps(1) infinite}
form:focus-within:has(textarea:placeholder-shown) .cursor{display:block}
textarea:placeholder-shown:focus{caret-color:transparent}
@keyframes caw-cursor{50%{opacity:0}}
#chip{display:none;align-items:center;gap:6px;max-width:100%;margin-bottom:8px;padding:2px 4px 2px 8px;background:var(--pane);color:var(--info);font:12px var(--font-mono);box-shadow:inset 0 0 0 2px var(--info)}#chip.on{display:inline-flex}#chipText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#chipRemove{border:0;background:none;padding:0 4px;font-size:14px;line-height:1;color:inherit}
.small{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;font:400 18px/1 var(--font-crt);color:var(--text);background:var(--pane-2);border:0;box-shadow:inset 0 0 0 2px var(--line)}
.small:hover:enabled{box-shadow:inset 0 0 0 2px var(--accent)}.small:disabled{opacity:.45;cursor:default}.small svg{width:12px;height:12px}
#pick svg{fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:square}#pick.on{color:var(--info);box-shadow:inset 0 0 0 2px var(--info)}
.left{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;min-width:0}
textarea{display:block;flex:1;min-width:0;width:100%;min-height:22px;max-height:160px;resize:none;border:0;outline:0;padding:0 2px;font:inherit;color:inherit;background:transparent;overflow-y:hidden;scrollbar-width:thin;caret-color:var(--human)}textarea.full{overflow-y:auto}
textarea::placeholder{color:var(--muted)}
.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
button{font:inherit;cursor:pointer;color:inherit;border-radius:0}
[data-state=paused] #toggle,[data-state=asking] #toggle,[data-state=showing] #toggle,[data-state=planning] #toggle{background:var(--accent);color:var(--ink);box-shadow:none}
#toggle{white-space:nowrap}#toggle svg{fill:currentColor}#toggle .play{display:none}
[data-state=paused] #toggle .play,[data-state=asking] #toggle .play,[data-state=showing] #toggle .play,[data-state=planning] #toggle .play{display:block}
[data-state=paused] #toggle .pause,[data-state=asking] #toggle .pause,[data-state=showing] #toggle .pause,[data-state=planning] #toggle .pause{display:none}
/* The demonstration ends with stop like a recording, not with continue. */
#toggle .stop{display:none}[data-state=showing] #toggle .stop{display:block}[data-state=showing] #toggle .play{display:none}
.actions{display:flex;align-items:center;gap:10px}#mark{display:none}[data-state=showing] #mark{display:inline-flex}
#send{width:30px;padding:0;justify-content:center;background:var(--human);color:var(--ink);box-shadow:none}#send:hover:enabled{filter:brightness(1.08);box-shadow:none}#send svg{fill:none;stroke:currentColor;stroke-width:2.8;stroke-linecap:square;stroke-linejoin:miter}
textarea:focus-visible{outline:0}
[data-state=closed] form,.stopping form,.stopping #choices{opacity:.55;pointer-events:none}
/* The theme's spinner: the page script writes the current frame to data-f, CSS shows it only as text. Block characters are
   drawn via data-q instead (GLYPH_CSS), without a fallback font. */
.loader,[data-state=handing] #status::before,#toggle.busy::before,#choices button.busy::before{content:attr(data-f);display:inline-block;flex:none;margin-right:8px;color:var(--info)}
[data-state=handing] #status.qbp[data-q]::before,#toggle.busy.qbp[data-q]::before,#choices button.busy.qbp[data-q]::before{content:"";width:1ch;height:1em;vertical-align:-.15em}
#toggle.busy svg{display:none!important}#toggle.busy{cursor:progress}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>${themeStyle(theme)}</head><body data-state="running">
<header><h1><span data-rule></span><span>CHAT</span><span class="dot">·</span><span class="name">CLAUDE</span><span data-fill aria-hidden="true"></span></h1><button id="abortNo" type="button" hidden>${t('chat.page.no')}</button><button id="abort" type="button" title="${t('chat.page.abortTitle')}">${t('chat.page.abort')}</button></header>
<main id="messages" class="readable" role="log" aria-live="polite"><div id="thinking" aria-hidden="true"><span class="who c" data-who="claude"></span><i data-spin></i></div></main>
<footer><button id="down" type="button" aria-label="${t('chat.page.scrollDown')}" title="${t('chat.page.scrollDown')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg></button><div id="status" role="status" aria-live="polite"></div><div id="choices"></div><div id="next" role="region" aria-label="${t('chat.page.nextStep')}"><strong>${t('chat.page.nextStep')}</strong><p id="nextText"></p><div class="acts"><button id="closeWindow" type="button" hidden></button><button id="report" type="button">${t('chat.page.openReport')}</button></div><p class="cmd" id="nextCmd"></p></div><form id="form"><div id="chip"><span id="chipText"></span><button id="chipRemove" type="button" aria-label="${t('chat.page.removeElement')}">×</button></div><div class="prompt"><span class="p" aria-hidden="true" data-who="human"></span><span class="cursor" aria-hidden="true"></span><textarea id="input" rows="1" aria-label="${t('chat.page.inputLabel')}" placeholder="${t('chat.page.placeholder')}"></textarea></div>
<div class="row"><div class="left"><button id="toggle" class="small" type="button"><svg class="pause" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1" width="3" height="10"/><rect x="7" y="1" width="3" height="10"/></svg><svg class="play" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1h2v1h2v1h2v1h2v4H9v1H7v1H5v1H3z"/></svg><svg class="stop" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8"/></svg><span id="toggleText"></span><kbd class="key" aria-hidden="true"></kbd></button><button id="pick" class="small" type="button" disabled title="${t('chat.page.pickDisabled')}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>${t('chat.page.element')}</button></div>
<div class="actions"><button id="mark" class="small" type="button" disabled title="${t('chat.page.markCheckpointTitle')}">${t('chat.page.markCheckpoint')}</button><button id="send" class="small" type="submit" aria-label="${t('chat.page.send')}" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></div></div></form></footer>
<script>
${GLYPH_SCRIPT}
const T=${JSON.stringify(texts('chat.page.'))};
// The theme's glyphs and prompts. Text only: set via textContent, never as HTML or CSS. New ones arrive with the workbench's message.
let TH=${JSON.stringify(clientTheme(theme)).replaceAll('<', '\\u003c')};
const glyph=(value,fallback)=>typeof value==='string'&&value.length>0&&value.length<=64?value:fallback;
const frames=()=>{const list=TH?.spinner?.frames;return Array.isArray(list)&&list.length>0?list.slice(0,16).map((frame)=>glyph(frame,'▖')):['▖','▘','▝','▗'];};
const prompt=(who)=>glyph(TH?.prompt?.[who],who==='claude'?'claude>':'>');
const markOf=(kind,frame)=>glyph(TH?.marks?.[kind],'['+kind+']').split('{spinner}').join(frame??frames()[0]);
const bulletOf=(kind)=>glyph(TH?.bullets?.[kind],'▸');
const treeOf=(kind)=>glyph(TH?.tree?.[kind],kind==='end'?'└':'├');
const ruleTitle=(title)=>{const line=glyph(TH?.rule?.line,'─');return glyph(TH?.rule?.format,'{line}{line} {title}').split('{title}').join(title).split('{line}').join(line).replace(/\\s*$/,'');};
const marker=(cls,text,data)=>{const span=document.createElement('span');span.className=cls;span.textContent=text;for(const [key,value] of Object.entries(data??{}))span.dataset[key]=value;return span;};
const whoLine=(who,extra)=>{const line=marker('who '+(who==='claude'?'c':'h'),'');line.append(marker('',prompt(who),{who}));if(extra)line.append(extra);return line;};
// Rewrite everything that comes from the theme: after a new message from the workbench.
const paintTheme=()=>{
  for(const node of document.querySelectorAll('[data-who]'))node.textContent=prompt(node.dataset.who);
  for(const node of document.querySelectorAll('[data-mark]'))node.textContent=markOf(node.dataset.mark);
  for(const node of document.querySelectorAll('[data-bullet]'))node.textContent=bulletOf(node.dataset.bullet);
  for(const node of document.querySelectorAll('[data-tree]'))node.textContent=treeOf(node.dataset.tree);
  for(const node of document.querySelectorAll('[data-rule]'))node.textContent=glyph(TH?.rule?.line,'─').repeat(2);
  // The rule runs on to the buttons: the header line has no gap where the state pill used to be.
  for(const node of document.querySelectorAll('[data-fill]'))node.textContent=glyph(TH?.rule?.line,'─').repeat(160);
  for(const node of document.querySelectorAll('[data-heading]'))node.textContent=ruleTitle(node.dataset.heading);
  document.body.classList.toggle('fail-inv',TH?.failInverted!==false);
  const cursor=Number(TH?.prompt?.cursorMs);document.documentElement.style.setProperty('--cursor-ms',(Number.isFinite(cursor)&&cursor>=200&&cursor<=5000?Math.round(cursor):1000)+'ms');
  spin();
};
// Spinner: one clock for all; with reduced motion the first frame stays.
let spinTimer=0,spinIndex=0;
const spinFrame=()=>{const list=frames(),frame=list[spinIndex%list.length],q=cawGlyphQ(frame);for(const node of document.querySelectorAll('[data-spin]'))node.replaceChildren(cawGlyph(frame));
  for(const node of document.querySelectorAll('#status,#toggle,#choices button')){node.classList.toggle('qbp',q!==null);if(q===null){delete node.dataset.q;node.dataset.f=frame;}else{node.dataset.q=q;node.dataset.f='';}}};
const spin=()=>{clearInterval(spinTimer);spinIndex=0;spinFrame();const ms=Number(TH?.spinner?.ms);if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;spinTimer=setInterval(()=>{spinIndex+=1;spinFrame();},Number.isFinite(ms)&&ms>=50&&ms<=2000?ms:150);};
window.cawThemeText=(theme)=>{if(theme&&typeof theme==='object'){TH=theme;paintTheme();}};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]);
const send=(type,text,checkpoint)=>window.${BINDING}({type,text,checkpoint,nonce:${JSON.stringify(nonce)}});
const input=document.getElementById('input'),messages=document.getElementById('messages'),thinking=document.getElementById('thinking'),abort=document.getElementById('abort'),sendButton=document.getElementById('send'),mark=document.getElementById('mark');
// The height follows the text, or the placeholder when empty: it wraps in a narrow chat and would be cut off otherwise.
// A scrollbar only appears at the maximum height.
const fit=()=>{input.style.height='auto';let height=input.scrollHeight;if(input.value===''&&input.placeholder){input.value=input.placeholder;height=input.scrollHeight;input.value='';}
  input.style.height=height+'px';input.classList.toggle('full',height>=160);sendButton.disabled=mark.disabled=input.value.trim()==='';};
addEventListener('resize',fit);
const submit=(checkpoint=false)=>{if(input.value.trim()==='')return;send('message',input.value,checkpoint);input.value='';fit();input.focus();};
mark.addEventListener('click',()=>submit(true));
input.addEventListener('input',fit);
document.getElementById('form').addEventListener('submit',(event)=>{event.preventDefault();submit();});
input.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit();}});
const toggleButton=document.getElementById('toggle');
const PASS_KEYS=['F1','F2','F3','F4','F6','F7','F8','F10'];
toggleButton.addEventListener('click',()=>{if(toggleButton.disabled)return;toggleButton.disabled=true;toggleButton.classList.add('busy');toggleButton.setAttribute('aria-busy','true');document.getElementById('toggleText').textContent=T['chat.page.wait'];send('toggle');});
// F5 in the chat does not reload the workbench but refreshes like there: application reloaded, state restored.
addEventListener('keydown',(event)=>{if(event.key==='F5'||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='r')){event.preventDefault();parent.postMessage({caw:'refresh'},'*');}
  // The workbench's F keys apply here too: the chat passes them on. It handles F9 and Esc itself, F11 and F12 stay with the browser.
  else if(PASS_KEYS.includes(event.key)&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();parent.postMessage({caw:'key',key:event.key},'*');}
  else if(event.key==='F9'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();pauseKey();}});
const pick=document.getElementById('pick'),chip=document.getElementById('chip'),statusBox=document.getElementById('status');let statusText='';
pick.addEventListener('click',()=>send('pick'));document.getElementById('chipRemove').addEventListener('click',()=>{window.setChip(null);send('unpick');});
window.setPicking=(on)=>{pick.classList.toggle('on',on);statusBox.textContent=on?T['chat.page.picking']:statusText;};
window.setChip=(label)=>{chip.classList.toggle('on',label!==null);document.getElementById('chipText').textContent=label??'';input.focus();};
let sure=false,stopping=false,unsure=null;
const abortNo=document.getElementById('abortNo');
const unarm=()=>{sure=false;clearTimeout(unsure);document.body.classList.remove('arming');abort.classList.remove('sure');abort.textContent=T['chat.page.abort'];abortNo.hidden=true;};
abortNo.addEventListener('click',()=>{unarm();abort.focus();});
abort.addEventListener('click',()=>{
  if(stopping)return;
  if(sure){stopping=true;clearTimeout(unsure);abortNo.hidden=true;document.body.classList.remove('arming');abort.disabled=true;document.body.classList.add('stopping');abort.classList.remove('sure');abort.textContent=T['chat.page.aborting'];statusText=T['chat.page.abortingStatus'];statusBox.textContent=statusText;send('abort');return;}
  sure=true;abort.classList.add('sure');abort.textContent=T['chat.page.abortSure'];abortNo.hidden=false;document.body.classList.add('arming');unsure=setTimeout(unarm,4000);});
// Follow the end as long as the human has not scrolled up. Measured on scroll, not on insert:
// when a lot arrives at once, e.g. the history in a new window, a scroll would otherwise still be pending.
const down=document.getElementById('down');
const atEnd=()=>messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
let follow=true;
// A card (failure, decision, advice, plan) that would not fit at the end shows its start, not its end:
// otherwise only its lower part would be visible once the buttons appear below. The start stays on top until a new message arrives.
let anchor=null;
const offsetOf=(element)=>element.getBoundingClientRect().top-messages.getBoundingClientRect().top;
const tall=()=>anchor!==null&&anchor.isConnected&&offsetOf(anchor)+messages.scrollTop-8<messages.scrollHeight-messages.clientHeight-1;
const pinned=()=>tall()&&Math.abs(offsetOf(anchor)-8)<16;
const toEnd=()=>{if(tall())messages.scrollTop+=offsetOf(anchor)-8;else messages.scrollTop=messages.scrollHeight;down.classList.toggle('on',!atEnd());};
messages.addEventListener('scroll',()=>{follow=atEnd()||pinned();down.classList.toggle('on',!atEnd());if(follow)down.classList.remove('new');});
down.addEventListener('click',()=>{follow=true;anchor=null;down.classList.remove('on','new');toEnd();});
const grown=()=>{if(follow)toEnd();else down.classList.add('on','new');};
// If the buttons below grow or shrink, the chat area resizes: following continues.
if(window.ResizeObserver)new ResizeObserver(()=>{if(follow)toEnd();}).observe(messages);
// A new card needs a decision: it scrolls into view even if the human is reading further up.
const place=(element,top=false)=>{messages.insertBefore(element,thinking);anchor=top?element:null;if(top){follow=true;down.classList.remove('new');}grown();};
let group=null;
window.addMessage=(who,text,about)=>{
  if(who==='activity'){
    // While demonstrating, the open list shows that every click arrives.
    if(group===null){const details=document.createElement('details');details.className='activity';if(document.body.dataset.state==='showing')details.open=true;details.setAttribute('aria-live','off');const summary=document.createElement('summary');const count=document.createElement('span');const latest=document.createElement('span');latest.className='latest';summary.append(count,latest);const list=document.createElement('ol');details.append(summary,list);group={details,count,latest,list,total:0};place(details);}
    const item=document.createElement('li');item.append(marker('bl',bulletOf('ok'),{bullet:'ok'}),text);group.list.append(item);group.total+=1;group.count.textContent=group.total===1?T['chat.page.oneAction']:fill('chat.page.actions',{n:group.total});group.latest.replaceChildren(marker('bl',bulletOf('ok'),{bullet:'ok'}),text);
    if(follow)toEnd();
    return;
  }
  if(who==='plan'){
    group=null;const card=document.createElement('div');card.className='message plan';const part=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;node.textContent=value;return node;};
    const heading=about.title||(about.repairing?T['chat.page.repairStep']:T['chat.page.plan']);const title=part('strong','',ruleTitle(heading));title.dataset.heading=heading;card.append(title);if(about.notes)card.append(part('div','notes',about.notes));
    for(const step of about.steps){const box=document.createElement('section');box.className='step';const head=document.createElement('div');head.className='head';head.append(part('span','sid',step.id),part('span','',step.name));const facts=document.createElement('dl');
      const fact=(label,value,changed,before)=>{const row=document.createElement('div');if(changed)row.className='changed';row.append(part('dt','',label));if(before)row.append(part('dd','before',before));row.append(part('dd','',value));facts.append(row);};
      if(step.do)fact(T['chat.page.do'],step.do);fact(T['chat.page.expect'],step.expect,step.previousExpect!==undefined,step.previousExpect);if(step.note)fact(T['chat.page.note'],step.note);if(step.retry)fact(T['chat.page.retry'],fill('chat.page.retryText',{times:step.retry.times,from:step.retry.from||step.id}));box.append(head,facts);card.append(box);}
    place(card,true);return;
  }
  if(who==='failure'){
    group=null;const card=document.createElement('div');card.className='message question failure'+(about.diagnosis?' '+about.diagnosis.side:'');const part=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;node.textContent=value;return node;};
    const title=part('strong','',fill('chat.page.failed',{id:about.id}));title.prepend(marker('mk',markOf('fail'),{mark:'fail'}));card.append(title,part('p','reason',about.reason));
    if(about.diagnosis){const badge=part('div','badge '+about.diagnosis.side+' '+about.diagnosis.strength,(about.diagnosis.text.endsWith('.')?about.diagnosis.text.slice(0,-1):about.diagnosis.text));card.append(badge);}
    else if(about.suspect)card.append(part('div','badge app',T['chat.page.suspect']));
    if(about.warn)card.append(part('div','warn',about.warn));
    const list=(title,items,open)=>{if(!items||items.length===0)return;const details=document.createElement('details');if(open)details.open=true;details.append(part('summary','',title+' ('+items.length+')'));const ul=document.createElement('ul');for(const text of items)ul.append(part('li','',text));details.append(ul);card.append(details);};
    list(T['chat.page.findings'],about.diagnosis?about.diagnosis.findings:[],false);list(T['chat.page.failures'],about.failures,false);list(T['chat.page.warnings'],about.warnings,false);
    if(about.next)card.append(part('p','next',about.next));
    place(card,true);return;
  }
  if(who==='decision'){
    group=null;const card=document.createElement('div');card.className='message decision';const part=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;node.textContent=value;return node;};
    const title=part('strong','',about.title);title.prepend(marker('mk',markOf('ok'),{mark:'ok'}));card.append(title);
    if(about.facts&&about.facts.length>0){const ul=document.createElement('ul');for(const text of about.facts)ul.append(part('li','',text));card.append(ul);}
    if(about.warn)card.append(part('div','warn',about.warn));
    for(const section of about.details??[]){if(!section.items||section.items.length===0)continue;const details=document.createElement('details');details.append(part('summary','',section.title+' ('+section.items.length+')'));const ul=document.createElement('ul');for(const text of section.items)ul.append(part('li','',text));details.append(ul);card.append(details);}
    if(about.question)card.append(part('p','next',about.question));
    place(card,true);return;
  }
  if(who==='advice'){
    group=null;const card=document.createElement('div');card.className='message advice '+about.side;const part=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;node.textContent=value;return node;};
    const title=part('strong','',about.side==='app'?T['chat.page.adviceApp']:T['chat.page.adviceTest']);title.prepend(marker('bl',bulletOf('info'),{bullet:'info'}));card.append(title,part('h2','',about.title));if(about.target)card.append(part('div','target',about.target));if(about.about)card.append(part('div','target',fill('chat.page.about',{about:about.about})));card.append(part('p','reason',about.reason));
    if(about.evidence)card.append(part('div','target',fill('chat.page.evidence',{evidence:about.evidence})));
    if(about.contradicts)card.append(part('div','warn',T['chat.page.contradicts']));
    if(about.edits){const facts=document.createElement('dl');for(const edit of about.edits){facts.append(part('dt','',edit.file+(edit.line?':'+edit.line:'')+(edit.why?' · '+edit.why:'')),part('dd','',''));const last=facts.lastChild;last.append(part('pre','del',edit.find),part('pre','',edit.replace));}card.append(facts);}
    if(about.changes){const facts=document.createElement('dl');for(const change of about.changes){facts.append(part('dt','',change.label));if(change.before)facts.append(part('dd','before',change.before));facts.append(part('dd','',change.after));}card.append(facts);}
    if(about.prompt){const pre=part('pre','',about.prompt);const copy=part('button','copy',T['chat.page.copyPrompt']);copy.type='button';
      copy.addEventListener('click',async()=>{let done=false;try{await navigator.clipboard.writeText(about.prompt);done=true;}catch{}if(!done){const range=document.createRange();range.selectNodeContents(pre);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);try{done=document.execCommand('copy');}catch{}}copy.textContent=done?T['chat.page.copied']:T['chat.page.copyManual'];});
      card.append(pre,copy);}
    place(card,true);return;
  }
  group=null;const item=document.createElement('div');item.className='message '+who;
  if(who==='claude'||who==='human')item.append(whoLine(who));
  else if(who==='checkpoint')item.append(whoLine('human',marker('cp',T['chat.page.checkpoint'])));
  else if(who==='question'){const line=whoLine('claude');line.prepend(marker('mk',markOf('ask'),{mark:'ask'}));item.append(line);}
  if(about){const ref=document.createElement('span');ref.className='about';ref.append(marker('tr',treeOf('end'),{tree:'end'}),about);item.append(ref);}item.append(text);place(item);
};
const choices=document.getElementById('choices');
// After a click all buttons are locked and the chosen one shows progress: no double click, no second choice.
// If no new buttons arrive (the choice was already outdated), the lock releases them after 8 s.
let unlock=0;
const lockChoices=(chosen)=>{for(const button of choices.querySelectorAll('button')){button.disabled=true;button.setAttribute('aria-disabled','true');}chosen.classList.add('busy');chosen.setAttribute('aria-busy','true');
  clearTimeout(unlock);const current=choices.firstElementChild;unlock=setTimeout(()=>{if(choices.firstElementChild!==current)return;for(const button of choices.querySelectorAll('button')){button.disabled=false;button.removeAttribute('aria-disabled');button.classList.remove('busy');button.removeAttribute('aria-busy');}},8000);};const hint=input.placeholder;
// The button that Ctrl+Enter triggers shows it too.
const KEY=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘↵':T['chat.page.ctrlEnter'];toggleButton.querySelector('.key').textContent=KEY;
// After the run: report and what comes next.
window.setNext=(info)=>{const box=document.getElementById('next');box.classList.toggle('on',!!info);if(!info)return;document.getElementById('nextText').textContent=info.text;const cmd=document.getElementById('nextCmd');cmd.replaceChildren();if(info.command){const code=document.createElement('code');code.textContent=info.command;cmd.append(T['chat.page.newRun'],code);}};
document.getElementById('report').addEventListener('click',()=>send('report',''));
// After the last decision the window stays open briefly: the human sees the result and closes it, otherwise it closes on timeout.
const closeWindow=document.getElementById('closeWindow');let lingerTimer=0;
closeWindow.addEventListener('click',()=>{clearInterval(lingerTimer);closeWindow.disabled=true;send('close');});
window.linger=(seconds)=>{let left=seconds;const paint=()=>{closeWindow.textContent=fill('chat.page.closeIn',{n:left});};closeWindow.hidden=false;closeWindow.disabled=false;paint();closeWindow.focus({preventScroll:true});clearInterval(lingerTimer);lingerTimer=setInterval(()=>{left=Math.max(0,left-1);paint();if(left===0)clearInterval(lingerTimer);},1000);};
// A choice that discards something needs a second click, like abort in the header.
const confirmFirst=(choice,option)=>{if(choice.classList.contains('sure'))return false;choice.classList.add('sure');choice.textContent=option.confirm;const no=document.createElement('button');no.type='button';no.className='no';no.textContent=T['chat.page.no'];
  let timer=0;const reset=()=>{clearTimeout(timer);choice.classList.remove('sure');choice.textContent=option.label;no.remove();};no.addEventListener('click',()=>{reset();choice.focus();});choice.after(no);timer=setTimeout(reset,4000);choice.disarm=()=>{clearTimeout(timer);no.remove();};return true;};
const COMPACT=['discussing','deciding','reviewing'];
window.setStatus=(state,text,label,button,options)=>{document.body.dataset.state=state;toggleButton.disabled=false;toggleButton.classList.remove('busy');toggleButton.removeAttribute('aria-busy');if(!stopping){statusText=text;statusBox.textContent=text;}input.placeholder=state==='planning'?T['chat.page.planPlaceholder']:state==='showing'?T['chat.page.showPlaceholder']:hint;fit();
if(state==='showing'&&group)group.details.open=true;
const list=state==='planning'&&!(options?.length)?[{id:'approve',label:T['chat.page.approvePlan'],primary:true,big:true}]:options??[];
const buttons=list.map((option)=>{const choice=document.createElement('button');choice.type='button';choice.textContent=option.label;if(option.primary)choice.className=option.big?'primary big':'primary';if(option.big){choice.id='approve';const key=document.createElement('kbd');key.setAttribute('aria-hidden','true');key.textContent=KEY;choice.append(key);}
  choice.addEventListener('click',()=>{if(choice.disabled)return;if(option.confirm&&confirmFirst(choice,option))return;choice.disarm?.();lockChoices(choice);if(option.id==='approve'&&state==='planning')send('toggle');else send('choose',option.id);});return choice;});
// Compact: the main choice on top, all others side by side in one row.
const primary=buttons.filter((choice)=>choice.classList.contains('primary')),rest=buttons.filter((choice)=>!choice.classList.contains('primary'));
if(COMPACT.includes(state)&&rest.length>1){const row=document.createElement('div');row.className='rest';row.append(...rest);choices.replaceChildren(...primary,row);}else choices.replaceChildren(...buttons);
// New buttons get focus so keyboard and screen reader continue there; someone typing keeps the field.
if(buttons.length>0&&document.activeElement!==input)(choices.querySelector('.primary')??choices.querySelector('button')).focus({preventScroll:true});
const allowed=["paused","asking","showing","planning","discussing","developing"].includes(state);pick.disabled=!allowed;pick.title=allowed?T['chat.page.pickTitle']:T['chat.page.pickDisabled'];if(!allowed)window.setChip(null);document.getElementById('toggleText').textContent=button;};
input.focus();
// Shortcuts: Ctrl+Enter (Cmd+Enter) triggers the main button, e.g. approve or done. Esc first clears the field being typed in;
// otherwise the first Esc asks to abort and only a second one within 4 s confirms it.
document.addEventListener('keydown',(event)=>{
  if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&input.value.trim()===''){const main=document.getElementById('approve');if(main&&main.offsetParent!==null&&!main.disabled){event.preventDefault();main.click();}else if(toggleButton.offsetParent!==null&&!toggleButton.disabled){event.preventDefault();toggleButton.click();}}
  else if(event.key==='Escape'&&!pick.classList.contains('on')){
    if(document.activeElement===input&&input.value!==''){event.preventDefault();input.value='';fit();return;}
    if(abort.offsetParent!==null&&!abort.disabled){event.preventDefault();abort.click();}}
});
// Pause via F9: like the button, if it is currently shown.
function pauseKey(){if(toggleButton.offsetParent!==null&&!toggleButton.disabled)toggleButton.click();}
// F9 and Esc from the workbench: only from it, only these two.
addEventListener('message',(event)=>{if(event.source!==parent||event.data?.caw!=='key')return;
  if(event.data.key==='F9')pauseKey();
  else if(event.data.key==='Escape'&&!pick.classList.contains('on')&&abort.offsetParent!==null&&!abort.disabled)abort.click();});
paintTheme();
${sourceTag}</script></body></html>`;

/**
 * Connects the workbench's chat frame to the conversation. There is no chat without a workbench.
 * @param logPath     transcript in the run folder, without Claude's log and actions: those are in claude.log
 * @param transcript  the history so far, carried along: demonstration, Claude and verification run are separate browsers
 * @param onOpen      tests only: receives the chat frame
 * @param onWaiting   receives a line for the terminal once the chat waits for the human: once per such state
 */
export const openChat = async ({ session, logPath, onAbort, onOpen, onWaiting, transcript = [] }) => {
    // `doc()` is the chat document, the frame in the workbench (a new one after a reload); `chatWindow` is the surrounding workbench.
    const bench = session.workbench ?? null;
    if (bench === null) throw new CawError('chat-failed', t('chat.error.noWorkbench'));
    if (bench.chatOpen) throw new CawError('chat-failed', t('chat.error.alreadyOpen'));
    bench.chatOpen = true;
    const doc = () => bench.chatFrame();
    const chatWindow = bench.page;
    const quiet = (promise) => promise.catch(() => {});
    let picking = false;
    let onPicked = null;
    // Token of the chat page written last, new on every show().
    let nonce = null;
    let current = ['running', null];
    // The state for which the terminal last reported that the window is waiting.
    let waitingFor = null;
    // The human closes the window after the run (linger).
    let closeWanted = null;
    // After the run: { report: absolute path, shown: path for humans, text, command }.
    let next = null;
    const openReport = async () => {
        const page = await chatWindow.context().newPage();
        await page.setContent(reportPage({ markdown: readFileSync(next.report, 'utf8'), path: next.shown ?? next.report }));
        await page.bringToFront();
    };
    const render = (state, options) => {
        current = [state, options ?? null];
        const { text, label, button } = statusTexts(state);
        return doc().evaluate((args) => window.setStatus(...args), [state, text, label, button, options ?? null]);
    };
    const chat = createChat({
        show: (who, text, about) => {
            if (LOGGED.has(who)) appendFileSync(logPath, `${new Date().toISOString()} ${who}: ${text.replaceAll('\n', ' ')}\n`);
            transcript.push([who, text, about ?? null]);
            quiet(doc().evaluate((args) => window.addMessage(...args), [who, text, about ?? null]));
        },
        status: (state, options) => {
            quiet(render(state, options));
            if (NEEDS_HUMAN.includes(state)) quiet(chatWindow.bringToFront());
            // Whoever waits in the terminal sees there that the window is waiting. Repeating the same state does not count.
            if (NEEDS_HUMAN.includes(state) && state !== waitingFor) {
                waitingFor = state;
                onWaiting?.(t('chat.waiting', { status: statusTexts(state).text }));
            } else if (!NEEDS_HUMAN.includes(state)) waitingFor = null;
            quiet(Promise.resolve(bench.mood?.(RAVEN_ASKS.includes(state) ? 'ask' : 'wait')));
            quiet(Promise.resolve(bench.chatState?.(state)));
            if (picking && !PICK_STATES.includes(state)) quiet(cancelPick(session));
        },
        onAbort,
    });
    const pick = async () => {
        if (picking) {
            await cancelPick(session);
            return;
        }
        if (!chat.canPick()) return;
        picking = true;
        await doc().evaluate(() => window.setPicking(true));
        const picked = await pickElement(session).catch(() => null);
        picking = false;
        await doc().evaluate(() => window.setPicking(false));
        if (picked !== null && chat.canPick()) {
            chat.attach(picked);
            await doc().evaluate((label) => window.setChip(label), picked.label);
            onPicked?.(picked);
        }
        await chatWindow.bringToFront();
    };
    await chatWindow.exposeBinding(BINDING, (source, event) => {
        // In the workbench every frame sees the binding, including the application. It must never speak as the human.
        // The application shares the origin with the workbench and can reload the chat iframe (srcdoc, location). The frame
        // then stays the same, and so does the binding. Only the page the host wrote last knows the token; the chat has an
        // opaque origin, so the application cannot read it.
        if (bench !== null && (source.frame !== doc() || event?.nonce !== nonce)) return;
        if (event?.type === 'message') {
            chat.human.message(event.text, { checkpoint: event.checkpoint === true });
            // The raven nods: received.
            if (String(event.text ?? '').trim() !== '') bench.nod?.().catch?.(() => {});
            quiet(doc().evaluate(() => window.setChip(null)));
        } else if (event?.type === 'pick') quiet(pick());
        else if (event?.type === 'unpick') chat.detach();
        else if (event?.type === 'toggle') chat.human.toggle();
        else if (event?.type === 'choose') chat.human.choose(event.text);
        else if (event?.type === 'abort') chat.human.abort();
        else if (event?.type === 'report' && next !== null) quiet(openReport());
        else if (event?.type === 'close') closeWanted?.();
    });
    /** While developing: who additionally receives an element picked with the crosshair (the Claude Code session). null: nobody. */
    chat.onPicked = (handler) => { onPicked = handler ?? null; };
    const show = async () => {
        nonce = randomBytes(16).toString('hex');
        await doc().setContent(chatPage(nonce));
        await doc().evaluate((entries) => entries.forEach((entry) => window.addMessage(...entry)), transcript);
        if (next !== null) await doc().evaluate((info) => window.setNext(info), next);
    };
    /** The run is over: the card shows the report and the command for a new run. */
    chat.finished = async (info) => {
        next = info;
        await quiet(doc().evaluate((value) => window.setNext(value), info));
    };
    /**
     * After the run, after finished and closing the conversation: the window stays open with "close window" and a countdown.
     * @returns once the human closes it or the time is up
     */
    chat.linger = async (ms) => {
        const clicked = new Promise((resolve) => { closeWanted = resolve; });
        let timer;
        const elapsed = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
        await quiet(render('closed'));
        await quiet(doc().evaluate((seconds) => window.linger(seconds), Math.round(ms / 1000)));
        await Promise.race([clicked, elapsed]);
        clearTimeout(timer);
        closeWanted = null;
    };
    await show();
    await render('running');
    // The workbench was reloaded: history and state come back. If the test was running, it is no longer reliable.
    // While demonstrating, the reload is part of the shown path and ends up as a hint in the recording.
    bench.onReload?.(async ({ human = true } = {}) => {
        if (!chat.available()) return;
        await show();
        await render(...current);
        // The application navigated the top window itself: that is its behaviour, the run continues.
        if (!human || current[0] === 'developing') return;
        if (SHOWING_STATES.includes(current[0])) {
            chat.notice(t('chat.reload.showing'));
            return;
        }
        chat.notice(t('chat.reload.testing'));
        chat.human.abort();
    });
    // Without the chat there is no approval and no decision. Closing it aborts.
    chatWindow.on('close', () => {
        if (!chat.available()) return;
        chat.human.closed();
        onAbort?.();
    });
    await onOpen?.(doc());
    return chat;
};
