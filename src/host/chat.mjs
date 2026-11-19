// The chat in the workbench, right of the application iframe: Claude asks and reports, the human answers, pauses or
// aborts. Deliberately not inside the application page: there it could cover buttons, end up in snapshots and recordings,
// and the page itself could slip instructions to Claude. The binding only exists on the chat page.
//
// The page, in Graphite (style.mjs) and the personal mode: messages with speaker, time and the picked element; caw's notices
// as quiet icon lines; Claude's actions as one collapsible mono line; "Starting Claude" with the time since; cards for plan,
// question, advice (with diff), failure, decision and the token notice. No tool row: the one main action of the state
// (Done, Approve plan, Finish demo, Hand over …) sits full width above the input (Ctrl+Enter); while Claude works it is
// "Pause F9" in the status line. A card's choices and the end card show one primary action, the others beside it or behind
// "More"; the end card's command wraps only between words and keeps its spaces. "/" at the start of the field opens the
// commands (element, checkpoint, pause, cancel, and open, requests and the like for the workbench). Those for the workbench are posted to it like a forwarded key (CHAT_KEYS): they open views there.
// Nothing from the workbench or the application decides here; only clicks and keys in this page reach the binding.

import { actionOf, actionText, foldAction } from './activity.mjs';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { AGENT_NAME, language, t, texts } from '../shared/i18n.mjs';
import { readPrefs } from '../shared/prefs.mjs';
import { sourceTag } from './app-view.mjs';
import { cancelPick, pickElement } from './demonstrate.mjs';
import { reportPage } from './report-page.mjs';
import { FAVICON, MODE_SCRIPT, icon, modeAttr, styleSheet } from './style.mjs';

const BINDING = '__cawChat';
const MAX_TEXT = 4000;
const MAX_ACTIVITY = 300;
const TAIL_MS = 500;
const LOGGED = new Set(['human', 'checkpoint', 'claude', 'question', 'notice', 'tokens', 'plan', 'advice', 'failure', 'decision']);
// The human is demonstrating: a reload is then part of the path, not a break of the run.
const SHOWING_STATES = ['showing', 'asking', 'paused'];
const PICK_STATES = ['paused', 'asking', 'showing', 'describing', 'planning', 'discussing', 'developing'];
// Conversations with open input: a message goes to the flow together with the picked element.
const TALK_KINDS = ['discussing', 'developing'];
// The human has to act here, so the window must not stay behind the application.
const NEEDS_HUMAN = ['choosing', 'planning', 'deciding', 'reviewing', 'discussing'];
// Then the workbench unfolds the chat and says it is the human's turn.
const ASKS_HUMAN = [...NEEDS_HUMAN, 'asking', 'showing', 'describing', 'developing'];
const UNNAMED_ELEMENT_NOTE = 'This is the element I mean.';

// Status line, pill and button per state. Fetched at runtime: the language is not known yet at import time.
const STATES = ['running', 'pausing', 'paused', 'asking', 'showing', 'describing', 'choosing', 'planning', 'handing', 'verifying', 'testing', 'discussing', 'preparing', 'deciding', 'advising', 'reviewing', 'developing', 'closed'];
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
    const readable = readableCommand(match[2]).replaceAll(' ⏎ ', '; ').trim();
    const text = readable.replace(/^Bash: /, '').replace(/(^|[\s;&|(])caw agent /g, '$1').trim();
    if (/^(say|chat|plan)\b/.test(text) && !/[;&|]/.test(text)) return null;
    // For people a short sentence ("Read server.mjs"); the call itself stays as raw, e.g. for a tooltip.
    const action = actionOf(readable);
    return { kind: 'activity', text: actionText(action.group, [action.item]), group: action.group, item: action.item, raw: text.slice(0, MAX_ACTIVITY) };
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
 * @param show    shows an entry: (who, text, about). who is human, checkpoint, claude, question, notice, activity or starting
 *                (about: the element label), or a card: plan, failure, decision, advice, tokens (about: the card)
 * @param status  shows the state, see STATES; plus the options when the human has to decide
 * @param onAbort the human aborts the whole run
 */
export const createChat = ({ show: shown = () => {}, status = () => {}, onAbort = () => {} } = {}) => {
    // Actions of one kind in a row fold into one line ("Read 2 files"); anything else shown in between starts a new one.
    let fold = null;
    const show = (who, ...rest) => {
        if (who !== 'activity') fold = null;
        return shown(who, ...rest);
    };
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
                    // End of the demonstration or description: nothing to click here until the next section.
                    if (capturing === 'showing' || capturing === 'describing') {
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
                // The workbench's pill too: no "Claude working" once the run is over.
                publish();
            },
        },
        say: (raw) => claudeText('claude', raw),
        /** A message from the tool that needs no action from the human. */
        notice: (text) => {
            if (!ended) show('notice', text);
        },
        /** Claude is starting: the chat shows it with the time since, until anything else arrives. */
        starting: (text) => {
            if (!ended) show('starting', text);
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
         * @param card the decision as a card (title, facts, details), or { kind: 'tokens', text } for the token notice, whose
         *             title is `question`; otherwise `question` then only goes to the log
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
                else if (card.kind === 'tokens') show('tokens', question, card);
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
            // Claude's notes to itself go with the actions as they are; actions fold by kind.
            if (entry.kind !== 'activity') {
                show('activity', entry.text);
                return;
            }
            fold = foldAction(fold, entry);
            show('activity', fold.text, { merge: fold.merged, items: fold.items.filter((item) => item !== ''), raw: fold.raws.join('\n') });
        },
        /** Before every browser command: while the human has something to say, nothing more happens in the application. */
        gate: () => {
            if (paused || unread.length > 0) throw new CawError('human-message', 'The human has written in the chat. Call caw agent chat before you continue.');
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

/** JSON for a <script>: `<` cannot end it. */
const json = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

/**
 * The slash commands: [name, id, icon, key shown, key passed to the workbench]. The page decides which are available now;
 * the workbench ones are posted like a forwarded key (CHAT_KEYS), so they open views there and never decide anything.
 */
const slashCommands = (ctrl) => [
    ['element', 'pick', 'cross', '', ''],
    ['checkpoint', 'mark', 'flag', 'Alt ↵', ''],
    ['pause', 'cmdPause', 'pause', 'F9', ''],
    ['open', 'cmdOpen', 'play', 'F1', 'F1'],
    ['requests', 'cmdRequests', 'arrows', 'F2', 'F2'],
    ['console', 'cmdConsole', 'terminal', 'F3', 'F3'],
    ['reload', 'cmdReload', 'reload', 'F5', ''],
    ['app', 'cmdApp', 'expand', 'F8', 'F8'],
    ['settings', 'cmdSettings', 'gear', `${ctrl} ,`, 'Ctrl+,'],
    ['keys', 'cmdKeys', 'keyboard', '?', '?'],
    ['cancel', 'cmdCancel', 'x', 'Esc', ''],
];

/**
 * The chat page in the current language and the personal mode; texts for the page script are in T. Exported for preview and
 * tests. The chat has its own opaque origin, so it follows the system mode by itself (MODE_SCRIPT); a mode picked in the
 * workbench's settings arrives as a message from the parent.
 */
export const chatPage = (nonce = '', mode = readPrefs().mode) => {
    const ctrl = t('workbench.page.keyCtrl');
    const slash = slashCommands(ctrl).map(([name, id, glyph, key, bench]) => `<button type="button" class="pop-i${name === 'cancel' ? ' danger' : ''}" role="option" tabindex="-1" id="${id}" data-cmd="${name}" data-name="/${name}"${bench ? ` data-key="${bench}"` : ''}${id === 'pick' ? ` title="${t('chat.page.pickTitle')}"` : ''}>${icon(glyph)}<span><span class="nm">/${name}</span><small>${t(`chat.page.cmd.${name}`)}</small></span>${key ? `<kbd>${key}</kbd>` : '<span></span>'}</button>`).join('');
    const icons = { claude: 'agent', you: 'user', cross: 'cross', flag: 'flag', info: 'info', chev: 'chev-r', chevd: 'chev-d', loader: 'loader', check: 'check', x: 'x', alert: 'alert', help: 'help', list: 'list', file: 'file', copy: 'copy', terminal: 'terminal', bug: 'bug', coins: 'coins', lock: 'lock', msg: 'msg', pause: 'pause', play: 'play', stop: 'stop', spark: 'spark', bookmark: 'bookmark', dot: 'circle' };
    const ICON = Object.fromEntries(Object.entries(icons).map(([name, glyph]) => [name, icon(glyph, { cls: name === 'loader' ? 'spin' : '' })]));
    return `<!doctype html><html lang="${language()}"${modeAttr(mode)}><head><meta charset="utf-8"><title>caw · Chat</title><script>${MODE_SCRIPT}${sourceTag}</script>${FAVICON}<style>
${styleSheet()}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--panel);color:var(--text);font:400 13px/1.5 var(--font)}
button{cursor:pointer}
main{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:16px;scrollbar-width:thin;scrollbar-color:var(--line2) var(--panel)}
/* Nothing in the list shrinks: a card is as tall as its content, the list scrolls. */
main>*{flex-shrink:0}
/* Messages: who speaks (Claude, You) with an icon and the time, the text below. */
.message{display:flex;flex-direction:column;gap:3px;min-width:0}
.who{display:inline-flex;align-items:center;gap:6px;font:500 12px/1.2 var(--font);color:var(--text)}
.who .i{width:13px;height:13px}.who.c .i{color:var(--agent)}.who.h .i{color:var(--muted)}
.who small{font:400 10.5px/1 var(--font-mono);color:var(--faint)}
.who .cp{display:inline-flex;align-items:center;gap:4px;color:var(--muted)}.who .cp .i{color:var(--accent-text)}
.txt{font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.about{display:flex;gap:5px;font:400 11px/1.35 var(--font-mono);color:var(--muted);overflow-wrap:anywhere}
.about .i{width:12px;height:12px;margin-top:1px;color:var(--accent-text)}
/* A note from caw: one quiet line with an icon. */
.message.notice{flex-direction:row;align-items:flex-start;gap:8px;font-size:12px;line-height:1.45;color:var(--muted)}
.message.notice .i{width:14px;height:14px;margin-top:1px}.message.notice .txt{font-size:12px}
/* Claude's actions: one mono line, opened the list of all. */
details.activity{font:400 11.5px/1.4 var(--font-mono);color:var(--muted)}
details.activity summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;user-select:none;min-width:0}
details.activity summary::-webkit-details-marker{display:none}
details.activity .mk{display:inline-grid;place-items:center;width:12px;flex:none}.activity .mk .i{width:12px;height:12px}
details.activity[open] .mk .chev{transform:rotate(90deg)}.activity .mk .spin{display:none}
:is([data-state=running],[data-state=advising]) details.activity.live .mk .spin{display:block}:is([data-state=running],[data-state=advising]) details.activity.live .mk .chev{display:none}
details.activity .count{flex:none}details.activity .latest{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}details.activity .latest::before{content:"· "}
details.activity ol{margin:6px 0 0 5px;padding:0 0 0 12px;border-left:1px solid var(--line2);list-style:none;display:flex;flex-direction:column;gap:2px}
details.activity li{overflow-wrap:anywhere}
/* Claude starting, and Claude working. */
.message.starting{flex-direction:row;align-items:center;gap:8px;padding:10px 12px;border-radius:var(--r2);background:var(--panel2);font-size:12.5px}
.message.starting .i{color:var(--agent)}.message.starting small{margin-left:auto;font:400 11px/1 var(--font-mono);color:var(--faint)}
.activity li small.items{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.message.starting.done{background:none;padding:0;color:var(--muted);font-size:12px}.message.starting.done .i{color:var(--pass)}.message.starting.done small{margin-left:0}
#thinking{display:none;align-items:center;gap:7px;font:500 12px/1 var(--font);color:var(--agent)}#thinking .i{width:14px;height:14px}
[data-state=running] #thinking,[data-state=advising] #thinking,body.awaiting:not([data-state=choosing]):not([data-state=planning]):not([data-state=deciding]):not([data-state=reviewing]) #thinking{display:flex}main:has(.message.starting:not(.done)) #thinking{display:none!important}
/* Cards: plan, question, advice, failure, decision and the token notice. Flat: the header line, then the parts. */
.message.card{gap:10px;padding:12px 14px 14px;border-radius:var(--r2);background:var(--panel);border:1px solid var(--line);font-size:13px;line-height:1.5}
.card>strong{display:flex;align-items:center;gap:8px;font:500 13px/1.25 var(--font);color:var(--text)}
.card>strong .i{width:16px;height:16px}.card>strong .meta{margin-left:auto;font:400 11px/1 var(--font-mono);color:var(--faint)}
.card p{margin:0}.card .txt{white-space:pre-wrap}.card .muted{color:var(--muted);font-size:12px}
.message.question{box-shadow:inset 0 2px 0 var(--run)}.question>strong .i{color:var(--run)}
.plan>strong .i{color:var(--accent-text)}.advice>strong .i{color:var(--agent)}.decision>strong .i{color:var(--pass)}.tokens>strong .i{color:var(--warn)}
.message.failure{box-shadow:inset 0 2px 0 var(--fail)}.failure>strong .i{color:var(--fail)}
.heard{display:flex;gap:8px;padding:8px 10px;border-radius:var(--r1);background:var(--panel2);font-size:12.5px}
.heard .i{width:14px;height:14px;margin-top:3px;color:var(--muted)}.heard small{display:block;color:var(--faint);font-size:11px}
.step{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;padding-top:10px;border-top:1px solid var(--line)}.step:first-of-type{border-top:0;padding-top:0}
.step .head{display:contents}.step .sid{font:500 11.5px/1.6 var(--font-mono);color:var(--accent-text)}.step .head .nm{font-weight:600}
.step:has(.changed) .sid::after{content:${JSON.stringify(t('chat.page.changed'))};font-family:var(--font);color:var(--warn)}
.step dl{grid-column:2;margin:2px 0 0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;font-size:12.5px}.step dl>div{display:contents}
.step dt,.kv dt{padding-top:2px;font:600 11px/1.4 var(--font);letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}
.step dd,.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}.before{color:var(--faint);text-decoration:line-through}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;margin:0;font-size:12.5px}
.tags{display:flex;flex-wrap:wrap;gap:6px}.tags .bdg.line{height:auto;min-height:20px;padding:3px 8px;white-space:normal;line-height:1.3;border-radius:var(--r1)}.tags .bdg.test{background:var(--accent-soft);color:var(--accent-text)}
.warnbox{display:flex;gap:8px;padding:8px 10px;border-radius:var(--r1);background:var(--warn-soft);color:var(--warn);font-size:12px;line-height:1.45}.warnbox .i{width:14px;height:14px;margin-top:2px}
.card details summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;font:600 11px/1.4 var(--font);letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}
.card details summary::-webkit-details-marker{display:none}.card details summary .i{width:12px;height:12px}.card details[open] summary .i{transform:rotate(90deg)}
.card details ul,.card>ul{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.card>ul{margin:0;font-size:12.5px;color:var(--text)}.card li{display:flex;gap:6px}.card li .i{width:13px;height:13px;margin-top:2px}
.card li.e .i{color:var(--fail)}.card li.w .i{color:var(--warn)}.card li.f .i,.card>ul li .i{color:var(--faint)}
.advice h2{margin:0;font:600 14px/1.3 var(--font)}.advice .target{font:400 11.5px/1.4 var(--font-mono);color:var(--muted);overflow-wrap:anywhere}
.diff-h{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);color:var(--muted);font:400 11px/1.3 var(--font);background:var(--panel2)}
.diff-h b{color:var(--text);font:500 11px/1.3 var(--font-mono)}.diff-h .i{width:13px;height:13px}.diff-h span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prompt{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:var(--r1);background:var(--panel2);font-size:12px;color:var(--muted)}
.prompt .ptext{white-space:pre-wrap;overflow-wrap:break-word;max-height:200px;overflow:auto}.prompt .lnk{font-size:12px;align-self:flex-start}
/* The footer: cancel question, status line, choices or the end card, then the input. */
footer{flex:none;position:relative;display:flex;flex-direction:column;gap:8px;padding:10px 14px 14px;border-top:1px solid var(--line)}
#down{position:absolute;right:14px;top:-42px;background:var(--panel);box-shadow:0 0 0 1px var(--line2);display:none}#down.on{display:inline-grid}
#down.new::after{content:"";position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--accent)}
#cancel{display:none;align-items:center;justify-content:flex-end;gap:8px}body.arming #cancel,body.stopping #cancel{display:flex}
#abort.sure{background:var(--fail);color:var(--on-accent);border-color:transparent}
#bar{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px}
#status{font-size:12px;line-height:1.45;color:var(--muted);min-width:0}#status:empty{display:none}
:is([data-state=paused],[data-state=asking],[data-state=showing],[data-state=describing],[data-state=planning]) #status{color:var(--text)}
[data-state=handing] #status::before{content:"";display:inline-block;width:10px;height:10px;margin-right:8px;border-radius:50%;border:2px solid var(--run);border-right-color:transparent;vertical-align:-1px;animation:caw-spin .9s linear infinite}
/* The one main action: a link in the status line while Claude works (Pause F9), else full width above the input. */
#toggle{display:none}#toggle.lnk{font-size:12px}#toggle.lnk kbd{margin-left:2px}
:is([data-state=running],[data-state=pausing]) #toggle{display:inline-flex}
:is([data-state=paused],[data-state=asking],[data-state=showing],[data-state=describing]) #toggle{display:flex;width:100%}
#toggle.busy .i{display:none}#toggle.busy::before{content:"";width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:caw-spin .9s linear infinite}
#choices{display:none;flex-direction:column;gap:8px}
:is([data-state=choosing],[data-state=deciding],[data-state=reviewing],[data-state=discussing],[data-state=developing],[data-state=planning]) #choices{display:flex}
.acts{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:8px}.acts>.btn,.acts>.more{flex:0 0 auto}.acts>.btn-p{flex:1 1 auto}
#choices .btn,#next .btn{white-space:normal;height:auto;min-height:36px;padding:8px 15px;line-height:1.25;text-align:center}
#choices .rest>.btn{flex:1 1 auto}
#choices button.sure{background:var(--fail);color:var(--on-accent);border-color:transparent}
#choices button:disabled{cursor:progress;opacity:.55}#choices button.busy{opacity:1}
#choices button.busy::before{content:"";width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:caw-spin .9s linear infinite}
/* More: the other options of a card, a menu that opens upwards. */
/* The menu hangs from the row, not from the button: a wrapped "More" sits at the row's left edge, where a menu aligned to
   the button would leave the chat. */
.more{position:static}.more .btn .i{width:14px;height:14px}
.more .pop{position:absolute;right:0;bottom:calc(100% + 6px);z-index:30;min-width:min(220px,100%);max-width:min(320px,100%)}
.more .pop-i{display:block;white-space:normal;line-height:1.35;font-size:12.5px}.more .pop-i:focus{outline:none;background:var(--accent-soft)}
.more .pop-i.sure{background:var(--fail);color:var(--on-accent)}
/* The end card after the run. */
#next{display:none;gap:10px;padding:12px 14px 14px;overflow:visible}[data-state=closed] #next.on{display:flex}[data-state=closed]:has(#next.on) #hint{display:none}
#stays{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;color:var(--muted)}#stays[hidden]{display:none}#stays .i{width:13px;height:13px}
#next[data-kind=pass] #nextIcon .i{color:var(--pass)}#next[data-kind=fail] #nextIcon .i{color:var(--fail)}#next[data-kind=reproduce] #nextIcon .i{color:var(--warn)}
#nextIcon{display:inline-grid}#nextIcon:empty{display:none}
#nextText{font-size:13px}#nextText:empty,#nextRepro:empty{display:none}#nextRepro{display:flex;flex-direction:column;gap:10px}
.quote{padding:8px 10px;border-radius:var(--r1);background:var(--panel2);font-size:12.5px;font-style:italic;overflow-wrap:anywhere}
.banner.ro{padding:7px 10px}.banner.ro span{font-size:12px}
.cmd{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:var(--r1);background:var(--code);color:var(--code-text);font:400 11.5px/1.45 var(--font-mono)}
.cmd>.i{width:14px;height:14px;margin-top:1px;color:var(--muted)}.cmd>span{min-width:0;flex:1}
/* A command wraps between its words; only a word longer than the line breaks inside (a long draft id). The spaces stay. */
.cmd code{white-space:normal;overflow-wrap:normal;word-break:normal}.cmd .w{display:inline-block;max-width:100%;overflow-wrap:anywhere}
.cmd small{display:block;margin-bottom:2px;font:400 11.5px/1.4 var(--font);color:var(--muted)}.cmd code{font:inherit}
.cmd .ib{width:22px;height:22px;margin:-2px -4px -2px 0}.cmd .ib .i{width:14px;height:14px}.cmd:empty{display:none}
/* The input: chip, field with the send arrow, the hint line; "/" opens the commands above it. */
form{position:relative;display:flex;flex-direction:column;gap:8px;margin:0;padding:9px 10px;border-radius:var(--r2);background:var(--panel);border:1px solid var(--line2)}
form:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}form:has(textarea:disabled){opacity:.75}
:is([data-state=handing],[data-state=choosing],[data-state=deciding],[data-state=reviewing],[data-state=verifying],[data-state=testing],[data-state=preparing],[data-state=advising]) form{display:none}
[data-state=closed] form{opacity:.7}.stopping form,.stopping #choices{opacity:.55;pointer-events:none}
.inp-row{display:flex;align-items:flex-end;gap:8px;min-width:0}
textarea{display:block;flex:1;min-width:0;width:100%;min-height:22px;max-height:160px;margin:0;padding:2px 0;resize:none;border:0;outline:0;background:none;font:400 13px/1.45 var(--font);color:var(--text);overflow-y:hidden;scrollbar-width:thin;caret-color:var(--accent)}
textarea.full{overflow-y:auto}textarea::placeholder{color:var(--faint)}textarea:focus-visible{outline:0}
#send{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--r1);background:var(--prim);color:var(--on-prim)}
#send:hover:enabled{background:var(--prim-hi)}#send:disabled{background:var(--line);color:var(--faint);cursor:default}#send .i{width:15px;height:15px;stroke-width:2.3}
#chip{display:none;align-items:center;gap:6px;align-self:flex-start;max-width:100%;height:24px;padding:0 4px 0 8px;border-radius:var(--r1);background:var(--accent-soft);color:var(--accent-text);font:500 11.5px/1 var(--font-mono)}#chip.on{display:inline-flex}
#chipText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#chipRemove{display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:none;color:inherit}#chipRemove:hover{background:var(--panel)}#chipRemove .i{width:12px;height:12px}
.inp-hint{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--faint)}.inp-hint b{font-weight:500;color:var(--muted)}.inp-hint .cp{display:none}[data-state=showing] .inp-hint .cp{display:inline}
#slash{position:absolute;left:-1px;right:-1px;bottom:calc(100% + 6px);z-index:30;max-height:min(360px,60vh);overflow:auto}
#slash .pop-i>span{min-width:0}#slash .pop-i .nm{display:block;font:500 12px/1.3 var(--font-mono)}#slash .pop-i small{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#slash .pop-i:disabled{background:none}#pick.on .nm{color:var(--accent-text)}
#slashEmpty{padding:6px 8px;color:var(--faint);font-size:12px}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body data-state="running">
<main id="messages" role="log" aria-live="polite"><div id="thinking" aria-hidden="true">${ICON.loader}<span>${t('chat.page.thinking')}</span></div></main>
<footer><button id="down" class="ib" type="button" aria-label="${t('chat.page.scrollDown')}" title="${t('chat.page.scrollDown')}">${icon('down')}</button>
<div id="cancel"><button id="abortNo" class="btn btn-s btn-sm" type="button" hidden>${t('chat.page.no')}</button><button id="abort" class="btn btn-s btn-sm" type="button" title="${t('chat.page.abortTitle')}">${t('chat.page.abort')}</button></div>
<div id="bar"><div id="status" role="status" aria-live="polite"></div><button id="toggle" type="button" class="lnk"><span class="tic"></span><span id="toggleText"></span><kbd class="key" aria-hidden="true"></kbd></button></div>
<div id="choices"></div>
<div id="next" class="card" role="region" aria-label="${t('chat.page.nextStep')}"><strong id="nextHead"><span id="nextIcon"></span><span id="nextTitle">${t('chat.page.nextStep')}</span></strong><p id="nextText"></p><div id="nextRepro"></div><div class="cmd" id="nextCmd"></div>
<div class="acts" id="nextActs"><button id="learn" type="button" class="btn btn-p" hidden>${icon('bookmark')}<span>${t('chat.page.learn')}</span></button><button id="closeWindow" type="button" class="btn btn-s" hidden></button><button id="report" type="button" class="btn btn-s">${t('chat.page.openReport')}</button></div><p id="stays" hidden>${icon('clock')}<span>${t('chat.page.stays')}</span></p></div>
<form id="form"><div id="slash" class="pop" role="listbox" aria-label="${t('chat.page.commands')}" hidden><div class="pop-h">${t('chat.page.commands')}</div>${slash}<div id="slashEmpty" hidden>${t('chat.page.noCommand')}</div></div>
<div id="chip"><span id="chipText"></span><button id="chipRemove" type="button" aria-label="${t('chat.page.removeElement')}" title="${t('chat.page.removeElement')}">${icon('x')}</button></div>
<div class="inp-row"><textarea id="input" rows="1" aria-label="${t('chat.page.inputLabel')}" aria-controls="slash" aria-autocomplete="list" placeholder="${t('chat.page.placeholder')}"></textarea><button id="send" type="submit" aria-label="${t('chat.page.send')}" title="${t('chat.page.send')} (Enter)" disabled>${icon('up')}</button></div>
<div class="inp-hint" id="hint"><span><b>/</b> ${t('chat.page.hintCommands')}</span><span><b>Enter</b> ${t('chat.page.hintSend')}</span><span><b class="mainKey"></b> ${t('chat.page.hintMain')}</span><span class="cp"><b>Alt ↵</b> ${t('chat.page.hintCheckpoint')}</span></div></form></footer>
<script>
const T=${json(texts('chat.page.'))};
const ICON=${json(ICON)};
const $=(id)=>document.getElementById(id);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=text;return node;};
// The icons are static SVG from the host, never page content.
const ic=(name,cls)=>{const box=document.createElement('template');box.innerHTML=ICON[name]??'';const svg=box.content.firstChild;if(cls)svg.classList.add(cls);return svg;};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]);
const send=(type,text,checkpoint)=>window.${BINDING}({type,text,checkpoint,nonce:${JSON.stringify(nonce)}});
const toBench=(key)=>parent.postMessage({caw:'key',key},'*');
const input=$('input'),messages=$('messages'),thinking=$('thinking'),abort=$('abort'),sendButton=$('send'),toggleButton=$('toggle'),statusBox=$('status');
const KEY=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ ↵':T['chat.page.ctrlEnter'];
document.querySelector('#hint .mainKey').textContent=KEY;
const stateNow=()=>document.body.dataset.state;
// The height follows the text, or the placeholder when empty: it wraps in a narrow chat and would be cut off otherwise.
// A scrollbar only appears at the maximum height.
const fit=()=>{input.style.height='auto';let height=input.scrollHeight;if(input.value===''&&input.placeholder){input.value=input.placeholder;height=input.scrollHeight;input.value='';}
  input.style.height=height+'px';input.classList.toggle('full',height>=160);sendButton.disabled=input.value.trim()==='';};
addEventListener('resize',fit);
// A message, or a checkpoint while demonstrating (Alt+Enter, or "/checkpoint " in front of the text).
const CHECKPOINT='/checkpoint ';
const submit=(checkpoint=false)=>{let text=input.value;if(text.startsWith(CHECKPOINT)){text=text.slice(CHECKPOINT.length);checkpoint=true;}
  if(text.trim()==='')return;send('message',text,checkpoint&&stateNow()==='showing');input.value='';fit();renderSlash();input.focus();};
$('form').addEventListener('submit',(event)=>{event.preventDefault();submit();});
toggleButton.addEventListener('click',()=>{if(toggleButton.disabled)return;toggleButton.disabled=true;toggleButton.classList.add('busy');toggleButton.setAttribute('aria-busy','true');$('toggleText').textContent=T['chat.page.wait'];send('toggle');});
// F9: like the main action, if it is currently shown.
function pauseKey(){if(toggleButton.offsetParent!==null&&!toggleButton.disabled)toggleButton.click();}
const pick=$('pick'),chip=$('chip');let statusText='';
const PICK_STATES=["paused","asking","showing","planning","discussing","developing"];
const pickAllowed=()=>PICK_STATES.includes(stateNow());
$('chipRemove').addEventListener('click',()=>{window.setChip(null);send('unpick');});
window.setPicking=(on)=>{pick.classList.toggle('on',on);statusBox.textContent=on?T['chat.page.picking']:statusText;};
window.setChip=(label)=>{chip.classList.toggle('on',label!==null);$('chipText').textContent=label??'';input.focus();};
// Cancelling is possible while something runs; deciding, talking, developing and the end have no cancel.
let sure=false,stopping=false,unsure=null;
const abortNo=$('abortNo');
const canAbort=()=>!abort.disabled&&!['deciding','discussing','developing','closed'].includes(stateNow());
const unarm=()=>{sure=false;clearTimeout(unsure);document.body.classList.remove('arming');abort.classList.remove('sure');abort.textContent=T['chat.page.abort'];abortNo.hidden=true;};
abortNo.addEventListener('click',()=>{unarm();input.focus();});
abort.addEventListener('click',()=>{
  if(stopping)return;
  if(sure){stopping=true;clearTimeout(unsure);abortNo.hidden=true;document.body.classList.remove('arming');abort.disabled=true;document.body.classList.add('stopping');abort.classList.remove('sure');abort.textContent=T['chat.page.aborting'];statusText=T['chat.page.abortingStatus'];statusBox.textContent=statusText;send('abort');return;}
  sure=true;abort.classList.add('sure');abort.textContent=T['chat.page.abortSure'];abortNo.hidden=false;document.body.classList.add('arming');unsure=setTimeout(unarm,4000);});

// "More": a menu of the other options, keyboard operable (arrows, Home, End; Esc and Tab close it).
const openMenus=()=>[...document.querySelectorAll('.more')].filter((wrap)=>!wrap.querySelector('.pop').hidden);
const closeMenus=(focus=false)=>{for(const wrap of openMenus())wrap.close(focus);};
const more=(id,items)=>{const wrap=el('div','more');const button=el('button','btn btn-s');button.type='button';button.id=id;button.append(T['chat.page.more'],ic('chevd'));
  const menu=el('div','pop');menu.id=id+'Menu';menu.setAttribute('role','menu');menu.hidden=true;button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',menu.id);
  for(const item of items){item.classList.remove('btn','btn-p','btn-s');item.classList.add('pop-i');item.setAttribute('role','menuitem');item.tabIndex=-1;menu.append(item);}
  const entries=()=>[...menu.querySelectorAll('button')].filter((b)=>!b.disabled&&!b.hidden);
  const open=()=>{closeMenus();menu.hidden=false;button.setAttribute('aria-expanded','true');entries()[0]?.focus();};
  wrap.close=(focus=true)=>{if(menu.hidden)return;menu.hidden=true;button.setAttribute('aria-expanded','false');if(focus)button.focus();};
  button.addEventListener('click',()=>{if(menu.hidden)open();else wrap.close();});
  button.addEventListener('keydown',(event)=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open();if(event.key==='ArrowUp')entries().at(-1)?.focus();}});
  menu.addEventListener('keydown',(event)=>{const list=entries(),at=list.indexOf(document.activeElement);const to=(i)=>{event.preventDefault();list[(i+list.length)%list.length]?.focus();};
    if(event.key==='ArrowDown')to(at+1);else if(event.key==='ArrowUp')to(at<0?list.length-1:at-1);else if(event.key==='Home')to(0);else if(event.key==='End')to(list.length-1);
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();wrap.close();}else if(event.key==='Tab')wrap.close(false);});
  wrap.append(button,menu);return wrap;};
addEventListener('pointerdown',(event)=>{for(const wrap of openMenus())if(!wrap.contains(event.target))wrap.close(false);},true);
// One primary action, the rest next to it: one as a button, more than one behind "More".
const arrange=(box,id,primary,rest)=>{for(const b of primary){b.classList.remove('pop-i','btn-s');b.removeAttribute('role');b.classList.add('btn','btn-p');}
  if(primary.length===1&&rest.length>1){box.replaceChildren(...primary,more(id,rest));return;}
  for(const b of rest){b.classList.remove('pop-i','btn-p');b.removeAttribute('role');b.removeAttribute('tabindex');b.classList.add('btn','btn-s');}box.replaceChildren(...primary,...rest);};

// Follow the end as long as the human has not scrolled up. Measured on scroll, not on insert:
// when a lot arrives at once, e.g. the history in a new window, a scroll would otherwise still be pending.
const down=$('down');
const atEnd=()=>messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
let follow=true;
// At the end the chat follows everything that grows: new entries, a card that changes (Next, a copy prompt), an unfolded
// list. Scrolled up by the human, it stays where it is; the button at the bottom shows that something new came.
const toEnd=()=>{messages.scrollTop=messages.scrollHeight;down.classList.toggle('on',!atEnd());};
messages.addEventListener('scroll',()=>{follow=atEnd();down.classList.toggle('on',!follow);if(follow)down.classList.remove('new');});
down.addEventListener('click',()=>{follow=true;down.classList.remove('on','new');toEnd();});
const grown=()=>{if(follow)toEnd();else down.classList.add('on','new');};
// If the footer grows or shrinks, the chat area resizes: following continues.
if(window.ResizeObserver)new ResizeObserver(()=>{if(follow)toEnd();}).observe(messages);
// Content that changes in place (a card's next item, an unfolded list) grows the chat without a new entry.
new MutationObserver(()=>grown()).observe(messages,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open','hidden','class']});
const place=(element)=>{messages.insertBefore(element,thinking);grown();};
const clock=(at)=>{if(!at)return null;const d=new Date(at);return el('small','',String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));};
const whoLine=(who,at,extra)=>{const line=el('span','who '+(who==='claude'?'c':'h'));const name=el('span','',who==='claude'?${JSON.stringify(AGENT_NAME)}:T['chat.page.you']);name.dataset.who=who;line.append(ic(who==='claude'?'claude':'you'),name);if(extra)line.append(extra);const time=clock(at);if(time)line.append(time);return line;};
const head=(glyph,title,meta)=>{const strong=el('strong');strong.append(ic(glyph),el('span','',title));if(meta)strong.append(el('span','meta',meta));return strong;};
const card=(cls)=>el('div','message card '+cls);
// "Starting Claude": a spinner and the time since, until anything else arrives.
let starting=null;
const elapsed=(row)=>{const s=Math.max(0,Math.floor((Date.now()-Number(row.dataset.t0))/1000));row.querySelector('small').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
setInterval(()=>{if(starting)elapsed(starting);},1000);
const started=()=>{if(!starting)return;elapsed(starting);starting.classList.add('done');starting.querySelector('.i').replaceWith(ic('check'));starting=null;};
let group=null;
const endGroup=()=>{group?.details.classList.remove('live');group=null;};
const list=(title,items,cls)=>{if(!items||items.length===0)return null;const details=el('details');const summary=el('summary');summary.append(ic('chev'),title+' ('+items.length+')');const ul=el('ul');
  for(const text of items){const li=el('li',cls);li.append(ic(cls==='e'?'x':cls==='w'?'alert':'dot'),el('span','',text));ul.append(li);}details.append(summary,ul);return details;};
const copyButton=(text,select)=>{const copy=el('button','lnk copy');copy.type='button';copy.append(ic('copy'),el('span','',T['chat.page.copyPrompt']));
  copy.addEventListener('click',async()=>{let done=false;try{await navigator.clipboard.writeText(text);done=true;}catch{}if(!done){const range=document.createRange();range.selectNodeContents(select);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);try{done=document.execCommand('copy');}catch{}}copy.querySelector('span').textContent=done?T['chat.page.copied']:T['chat.page.copyManual'];});return copy;};
// Over the app in App only (Ctrl+J): Esc hides the chat instead of cancelling; the workbench says when (pop).
let popped=false,solo=false;
// What the agent says or asks reaches the workbench as "new" (a dot on Chat while hidden); replayed history after a reload does not.
const UNREAD=['claude','plan','failure','decision','advice','question','tokens'];
window.addMessage=(who,text,about,at)=>{
  if(UNREAD.includes(who)&&Date.now()-(at||Date.now())<5000)parent.postMessage({caw:'unread'},'*');
  // Its start (after Continue) begins "working"; the host ends it once the agent waits for the person (setWorking).
  if(who==='starting'&&['discussing','developing','running'].includes(stateNow()))document.body.classList.add('awaiting');
  // One start at a time: preparing the sandbox and starting the agent show as one line.
  if(who==='starting'&&starting)return;
  if(who==='starting'){endGroup();started();const row=el('div','message starting');row.dataset.t0=String(at||Date.now());row.append(ic('loader'),el('span','',text),el('small'));elapsed(row);starting=row;place(row);return;}
  started();
  if(who==='activity'){
    // While demonstrating, the open list shows that every click arrives.
    if(group===null){const details=el('details','activity live');if(stateNow()==='showing')details.open=true;details.setAttribute('aria-live','off');const summary=el('summary');const mark=el('span','mk');mark.append(ic('chev','chev'),ic('loader'));const count=el('span','count');const latest=el('span','latest');summary.append(mark,count,latest);const ol=el('ol');details.append(summary,ol);group={details,count,latest,list:ol,total:0};place(details);}
    const merging=about?.merge===true&&group.list.lastElementChild!==null;const li=merging?group.list.lastElementChild:el('li');li.replaceChildren(el('span','',text));if(Array.isArray(about?.items)&&about.items.length>1)li.append(el('small','items',about.items.join(' · ')));if(typeof about?.raw==='string')li.title=about.raw;if(!merging)group.list.append(li);group.total+=1;group.count.textContent=group.total===1?T['chat.page.oneAction']:fill('chat.page.actions',{n:group.total});group.latest.textContent=text;
    if(follow)toEnd();
    return;
  }
  endGroup();
  if(who==='plan'){
    const box=card('plan');const heading=about.title||(about.repairing?T['chat.page.repairStep']:T['chat.page.plan']);const title=head('list',heading,about.steps.length===1?T['chat.page.oneStep']:fill('chat.page.steps',{n:about.steps.length}));title.dataset.heading=heading;box.append(title);
    if(about.notes)box.append(el('div','notes muted',about.notes));
    // The human's own words and what became of them: as a note, a retry, in the test's notes, or only for this recording.
    const heardText=(h)=>'"'+h.text+'" → '+T['chat.page.heardAs.'+h.as];
    for(const h of about.heard||[]){const said=el('div','heard');const words=el('span','','“'+h.text+'”');words.append(el('small','',T['chat.page.heard']+' · '+T['chat.page.heardAs.'+h.as]));said.append(ic('msg'),words);box.append(said);}
    for(const step of about.steps){const section=el('section','step');const top=el('div','head');top.append(el('span','sid',step.id),el('span','nm',step.name));const facts=el('dl');
      const fact=(label,value,changed,before)=>{const row=el('div',changed?'changed':'');const dd=el('dd');if(before){dd.append(el('span','before',before),el('br'));}dd.append(value);row.append(el('dt','',label),dd);facts.append(row);};
      if(step.do)fact(T['chat.page.do'],step.do);fact(T['chat.page.expect'],step.expect,step.previousExpect!==undefined,step.previousExpect);if(step.note)fact(T['chat.page.note'],step.note);if(step.retry)fact(T['chat.page.retry'],fill('chat.page.retryText',{times:step.retry.times,from:step.retry.from||step.id}));
      for(const h of step.heard||[]){const row=el('div','heard');row.append(el('dt','',T['chat.page.heard']),el('dd','',heardText(h)));facts.append(row);}section.append(top,facts);box.append(section);}
    place(box);return;
  }
  if(who==='failure'){
    const box=card('question failure'+(about.diagnosis?' '+about.diagnosis.side:''));box.append(head('x',fill('chat.page.failed',{id:about.id})));
    const side=about.diagnosis?.side??(about.suspect?'app':null);
    if(side){const tags=el('div','tags');tags.append(el('span','bdg '+(({app:'fail',environment:'warn',test:'test'})[side]??''),T['chat.page.side.'+side]??side));
      const why=about.diagnosis?(about.diagnosis.text.endsWith('.')?about.diagnosis.text.slice(0,-1):about.diagnosis.text):T['chat.page.suspect'];tags.append(el('span','bdg line badge '+(about.diagnosis?about.diagnosis.side+' '+about.diagnosis.strength:'app'),why));box.append(tags);}
    box.append(el('p','reason txt',about.reason));
    if(about.warn){const warn=el('div','warnbox warn');warn.append(ic('alert'),el('span','',about.warn));box.append(warn);}
    for(const part of [list(T['chat.page.findings'],about.diagnosis?about.diagnosis.findings:[],'f'),list(T['chat.page.failures'],about.failures,'e'),list(T['chat.page.warnings'],about.warnings,'w')])if(part)box.append(part);
    if(about.next)box.append(el('p','next muted',about.next));
    place(box);return;
  }
  if(who==='decision'){
    const box=card('decision');box.append(head('check',about.title));
    if(about.facts&&about.facts.length>0){const ul=el('ul');for(const fact of about.facts){const li=el('li');li.append(ic('dot'),el('span','',fact));ul.append(li);}box.append(ul);}
    if(about.warn){const warn=el('div','warnbox warn');warn.append(ic('alert'),el('span','',about.warn));box.append(warn);}
    for(const section of about.details??[]){const part=list(section.title,section.items,'w');if(part)box.append(part);}
    if(about.question)box.append(el('p','next',about.question));
    place(box);return;
  }
  if(who==='advice'){
    const box=card('advice '+about.side);box.append(head('agent',about.side==='app'?T['chat.page.adviceApp']:T['chat.page.adviceTest']));
    const intro=el('div');intro.append(el('h2','',about.title));if(about.target)intro.append(el('div','target',about.target));if(about.about)intro.append(el('div','target',fill('chat.page.about',{about:about.about})));box.append(intro);
    box.append(el('p','reason txt',about.reason));
    if(about.evidence)box.append(el('p','muted',fill('chat.page.evidence',{evidence:about.evidence})));
    if(about.contradicts){const warn=el('div','warnbox warn');warn.append(ic('alert'),el('span','',T['chat.page.contradicts']));box.append(warn);}
    // A change in the code as diff lines, numbered from the line it names.
    for(const edit of about.edits??[]){const diff=el('div','diff');const top=el('div','diff-h');top.append(ic('file'),el('b','',edit.file+(edit.line?':'+edit.line:'')));if(edit.why)top.append(el('span','',edit.why));diff.append(top);
      const lines=(text,kind)=>String(text).split(String.fromCharCode(10)).forEach((line,i)=>{const row=el('div','dl '+kind);row.append(el('span','n',edit.line?String(Number(edit.line)+i):''),el('span','sg',kind==='del'?'−':'+'),el('code','',line));diff.append(row);});
      lines(edit.find,'del');lines(edit.replace,'add');box.append(diff);}
    if(about.changes){const facts=el('dl','kv');for(const change of about.changes){const dd=el('dd');if(change.before){dd.append(el('span','before',change.before),el('br'));}dd.append(change.after);facts.append(el('dt','',change.label),dd);}box.append(facts);}
    if(about.prompt){const prompt=el('div','prompt');const words=el('div','ptext',about.prompt);prompt.append(words,copyButton(about.prompt,words));box.append(prompt);}
    place(box);return;
  }
  if(who==='tokens'){const box=card('tokens');box.append(head('coins',text));if(about?.text)box.append(el('p','muted',about.text));place(box);return;}
  if(who==='question'){const box=card('question');box.append(head('help',T['chat.page.question']),el('p','txt',text));place(box);return;}
  if(who==='notice'){const item=el('div','message notice');item.append(ic('info'),el('span','txt',text));place(item);return;}
  const item=el('div','message '+who);
  if(who==='checkpoint'){const cp=el('span','cp');cp.append(ic('flag'),T['chat.page.checkpoint']);item.append(whoLine('human',at,cp));}
  else item.append(whoLine(who==='claude'?'claude':'human',at));
  if(about){const ref=el('span','about');ref.append(ic('cross'),el('span','',about));item.append(ref);}
  item.append(el('div','txt',text));place(item);
};

const choices=$('choices');
// After a click all buttons are locked and the chosen one shows progress: no double click, no second choice.
// If no new buttons arrive (the choice was already outdated), the lock releases them after 8 s.
let unlock=0;
const lockChoices=(chosen)=>{for(const button of choices.querySelectorAll('button')){button.disabled=true;button.setAttribute('aria-disabled','true');}chosen.classList.add('busy');chosen.setAttribute('aria-busy','true');
  clearTimeout(unlock);const current=choices.firstElementChild;unlock=setTimeout(()=>{if(choices.firstElementChild!==current)return;for(const button of choices.querySelectorAll('button')){button.disabled=false;button.removeAttribute('aria-disabled');button.classList.remove('busy');button.removeAttribute('aria-busy');}},8000);};
const hint=input.placeholder;
// A choice that discards something needs a second click, like Cancel.
const confirmFirst=(choice,option)=>{if(choice.classList.contains('sure'))return false;choice.classList.add('sure');choice.textContent=option.confirm;const no=el('button',choice.classList.contains('pop-i')?'pop-i no':'btn btn-s no',T['chat.page.no']);no.type='button';if(choice.classList.contains('pop-i')){no.setAttribute('role','menuitem');no.tabIndex=-1;}
  let timer=0;const reset=()=>{clearTimeout(timer);choice.classList.remove('sure');choice.textContent=option.label;no.remove();};no.addEventListener('click',()=>{reset();choice.focus();});choice.after(no);timer=setTimeout(reset,4000);choice.disarm=()=>{clearTimeout(timer);no.remove();};return true;};

// After the run: the end card with one main action; the others next to it or behind "More".
const learn=$('learn'),closeWindow=$('closeWindow'),report=$('report');
// The main action: save baselines if offered, else close the window, else the report; beside it the report first.
const arrangeNext=()=>{const shown=[learn,closeWindow,report].filter((b)=>!b.hidden);const rest=shown.slice(1).sort((a,b)=>(a===report?-1:b===report?1:0));arrange($('nextActs'),'nextMore',shown.slice(0,1),rest);};
const KINDS={pass:['check','chat.page.endPass'],fail:['x','chat.page.endFail'],reproduce:['bug','']};
window.setNext=(info)=>{const box=$('next');box.classList.toggle('on',!!info);if(!info)return;
  if(!learn.disabled)learn.hidden=!info.learn;
  const kind=KINDS[info.kind];box.dataset.kind=info.kind??'';$('nextIcon').replaceChildren(...(kind?[ic(kind[0])]:[]));
  // A reproduction's verdict is the title itself; a run's title says passed or failed, the text counts the steps.
  const title=kind?(kind[1]?T[kind[1]]:info.text):T['chat.page.nextStep'];$('nextTitle').textContent=title;$('nextText').textContent=title===info.text?'':info.text;
  const repro=$('nextRepro');repro.replaceChildren();const r=info.reproduce;
  if(r){if(r.bug)repro.append(el('div','quote','“'+r.bug+'”'));const kv=el('dl','kv');for(const [key,value] of [['observed',r.observed],['expected',r.expected],['cause',r.cause]])if(value)kv.append(el('dt','',T['chat.page.'+key]),el('dd','',value));if(kv.childElementCount>0)repro.append(kv);
    if(r.readOnly){const banner=el('div','banner ro');banner.append(ic('lock'),el('span','',T['chat.page.readOnly']));repro.append(banner);}}
  const cmd=$('nextCmd');cmd.replaceChildren();
  // Each word unbreakable, the spaces between them plain text: it wraps only there, and a copy keeps them.
  const commandCode=(text)=>{const code=el('code');String(text).split(' ').forEach((word,index)=>{if(index>0)code.append(' ');code.append(el('span','w',word));});return code;};
  if(info.command){const words=el('span');words.append(el('small','',T[info.adopt?'chat.page.adoptDraft':'chat.page.newRun']),commandCode(info.command));const copy=el('button','ib');copy.type='button';copy.title=copy.ariaLabel=T['chat.page.copyCommand'];copy.append(ic('copy'));
    copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(info.command);copy.title=T['chat.page.copied'];}catch{const range=document.createRange();range.selectNodeContents(words.lastChild);getSelection().removeAllRanges();getSelection().addRange(range);}});
    cmd.append(ic(info.adopt?'file':'terminal'),words,copy);}
  arrangeNext();};
report.addEventListener('click',()=>{closeMenus();send('report','');});
// After the last decision the window stays open briefly: the human sees the result and closes it, otherwise it closes on timeout.
let lingerTimer=0;
learn.addEventListener('click',()=>{closeMenus();learn.disabled=true;learn.querySelector('span').textContent=T['chat.page.learning'];send('learn');});
closeWindow.addEventListener('click',()=>{closeMenus();clearInterval(lingerTimer);closeWindow.disabled=true;send('close');});
// A click into the input while the window counts down: the person stays, the countdown stops for good.
const stay=()=>{if(lingerTimer===0||closeWindow.disabled)return;clearInterval(lingerTimer);lingerTimer=0;closeWindow.textContent=T['chat.page.closeNow'];$('stays').hidden=false;send('stay');};
input.addEventListener('pointerdown',stay);input.addEventListener('focus',stay);
// Without seconds (Save baselines is on the card): nothing counts down, the window waits for a choice.
window.linger=(seconds)=>{if(seconds===null){clearInterval(lingerTimer);lingerTimer=0;closeWindow.textContent=T['chat.page.closeNow'];closeWindow.hidden=false;closeWindow.disabled=false;arrangeNext();return;}let left=seconds;const paint=()=>{closeWindow.textContent=fill('chat.page.closeIn',{n:left});};closeWindow.hidden=false;closeWindow.disabled=false;paint();arrangeNext();
  if(closeWindow.offsetParent!==null)closeWindow.focus({preventScroll:true});clearInterval(lingerTimer);lingerTimer=setInterval(()=>{left=Math.max(0,left-1);paint();if(left===0)clearInterval(lingerTimer);},1000);};

// The slash commands: "/" at the start of the field opens them; arrows, Enter and Tab pick, Esc closes. Unavailable ones
// stay visible but disabled. Commands for the workbench are posted to it like a forwarded key.
const slash=$('slash'),slashItems=[...slash.querySelectorAll('[data-cmd]')];
let slashSel=null,slashOff=false;
const available=(cmd)=>{const s=stateNow();
  if(cmd==='element')return pickAllowed();if(cmd==='checkpoint')return s==='showing';if(cmd==='pause')return ['running','pausing','paused'].includes(s)&&!toggleButton.disabled;if(cmd==='cancel')return canAbort();return true;};
const slashQuery=()=>{const value=input.value;return value.startsWith('/')&&!/[\\s]/.test(value)?value.toLowerCase():null;};
const renderSlash=()=>{const query=slashQuery();const on=query!==null&&!slashOff&&!input.disabled;slash.hidden=!on;input.setAttribute('aria-expanded',String(on));
  if(!on){slashSel=null;input.removeAttribute('aria-activedescendant');return;}
  const shown=slashItems.filter((b)=>{const hit=b.dataset.name.startsWith(query);b.hidden=!hit;b.disabled=!available(b.dataset.cmd);b.setAttribute('aria-disabled',String(b.disabled));return hit;});
  const usable=shown.filter((b)=>!b.disabled);if(!usable.includes(slashSel))slashSel=usable[0]??null;
  for(const b of slashItems){b.classList.toggle('sel',b===slashSel);b.setAttribute('aria-selected',String(b===slashSel));}
  if(slashSel)input.setAttribute('aria-activedescendant',slashSel.id);else input.removeAttribute('aria-activedescendant');$('slashEmpty').hidden=shown.length>0;};
const moveSlash=(step)=>{const usable=slashItems.filter((b)=>!b.hidden&&!b.disabled);if(usable.length===0)return;slashSel=usable[(usable.indexOf(slashSel)+step+usable.length)%usable.length];renderSlash();slashSel.scrollIntoView({block:'nearest'});};
const runSlash=(b)=>{if(!b||b.disabled)return;const cmd=b.dataset.cmd;
  if(cmd==='checkpoint'){input.value=CHECKPOINT;fit();renderSlash();input.focus();return;}
  input.value='';fit();renderSlash();
  if(cmd==='element')send('pick');else if(cmd==='pause')pauseKey();else if(cmd==='cancel')abort.click();else if(cmd==='reload')parent.postMessage({caw:'refresh'},'*');else if(b.dataset.key)toBench(b.dataset.key);};
slash.addEventListener('mousedown',(event)=>event.preventDefault());
slash.addEventListener('click',(event)=>runSlash(event.target.closest('[data-cmd]')));
input.addEventListener('input',()=>{slashOff=false;fit();renderSlash();});
input.addEventListener('keydown',(event)=>{
  if(!slash.hidden){
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();moveSlash(event.key==='ArrowDown'?1:-1);return;}
    if(event.key==='Tab'&&slashSel){event.preventDefault();input.value=slashSel.dataset.name+(slashSel.dataset.cmd==='checkpoint'?' ':'');fit();renderSlash();return;}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();slashOff=true;renderSlash();return;}
    // Enter runs the selected command; a command that is not available now runs nothing and is not sent as text either.
    if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&slashItems.some((b)=>!b.hidden)){event.preventDefault();runSlash(slashSel);return;}}
  if(event.key==='Enter'&&event.altKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();if(stateNow()==='showing')submit(true);return;}
  if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();submit();}});

const TOGGLE_ICON={running:'pause',pausing:'play',paused:'play',asking:'check',showing:'stop',describing:'chev'};
// The host knows: the agent works until it waits for the person (its chat call) or ends.
window.setWorking=(on)=>{document.body.classList.toggle('awaiting',on===true);};
window.setStatus=(state,text,label,button,options)=>{if(state==='closed')document.body.classList.remove('awaiting');document.body.dataset.state=state;toggleButton.disabled=false;toggleButton.classList.remove('busy');toggleButton.removeAttribute('aria-busy');if(!stopping){statusText=text;statusBox.textContent=pick.classList.contains('on')?T['chat.page.picking']:text;}
  // While Claude works in the application the input is locked: typing here would take the focus from the application (an open
  // list closes when its field loses the focus). Pausing unlocks it.
  const locked=state==='running';input.disabled=locked;
  // After the run nothing listens any more: the input only stays reachable to stop the close countdown.
  input.readOnly=state==='closed';input.placeholder=locked?T['chat.page.lockedPlaceholder']:state==='closed'?T['chat.page.endedPlaceholder']:state==='planning'?T['chat.page.planPlaceholder']:state==='showing'?T['chat.page.showPlaceholder']:state==='describing'?T['chat.page.describePlaceholder']:hint;fit();
  if(state==='showing'&&group)group.details.open=true;
  // The main action: a link with F9 while Claude works, else the full-width button with Ctrl+Enter.
  const asLink=state==='running'||state==='pausing';toggleButton.className=asLink?'lnk':'btn btn-p';
  toggleButton.querySelector('.tic').replaceChildren(ic(TOGGLE_ICON[state]??'play'));toggleButton.querySelector('.key').textContent=asLink?'F9':KEY;$('toggleText').textContent=button;
  closeMenus();
  const all=state==='planning'&&!(options?.length)?[{id:'approve',label:T['chat.page.approvePlan'],primary:true,big:true}]:options??[];
  const buttons=all.map((option)=>{const choice=el('button','',option.label);choice.type='button';if(option.primary)choice.classList.add('primary');if(option.big){choice.classList.add('big');choice.id='approve';const key=el('kbd','',KEY);key.setAttribute('aria-hidden','true');choice.append(key);}
    choice.addEventListener('click',()=>{if(choice.disabled)return;if(option.confirm&&confirmFirst(choice,option))return;choice.disarm?.();closeMenus();lockChoices(choice);if(option.id==='approve'&&state==='planning')send('toggle');else send('choose',option.id);});return choice;});
  const primary=buttons.filter((b)=>b.classList.contains('primary')),rest=buttons.filter((b)=>!b.classList.contains('primary'));
  const row=el('div','acts rest');arrange(row,'choicesMore',primary,rest);choices.replaceChildren(...(buttons.length>0?[row]:[]));
  // New buttons get focus so keyboard and screen reader continue there; someone typing keeps the field.
  if(buttons.length>0&&document.activeElement!==input)(choices.querySelector('.primary')??choices.querySelector('button')).focus({preventScroll:true});
  if(!pickAllowed())window.setChip(null);renderSlash();};
input.focus();
// Shortcuts: Ctrl+Enter (Cmd+Enter) triggers the main action, e.g. approve or done. Esc first closes a menu, then clears the field
// being typed in; otherwise the first Esc asks to cancel and only a second one within 4 s confirms it.
document.addEventListener('keydown',(event)=>{
  if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&input.value.trim()===''){const main=$('approve');if(main&&main.offsetParent!==null&&!main.disabled){event.preventDefault();main.click();}else if(toggleButton.offsetParent!==null&&!toggleButton.disabled){event.preventDefault();toggleButton.click();}}
  else if(event.key==='Escape'){
    if(openMenus().length>0){event.preventDefault();closeMenus(true);return;}
    if(pick.classList.contains('on'))return;
    if(document.activeElement===input&&input.value!==''){event.preventDefault();input.value='';fit();renderSlash();return;}
    if(popped){event.preventDefault();toBench('Ctrl+J');return;}
    if(canAbort()){event.preventDefault();abort.click();}}
});
// The workbench's keys apply here too: the chat passes them on (CHAT_KEYS). It handles F9 and Esc itself, F11 and F12 stay with the browser.
const PASS_KEYS=['F1','F2','F3','F4','F6','F8','F10'];
addEventListener('keydown',(event)=>{const plain=!event.ctrlKey&&!event.metaKey&&!event.altKey,ctrl=(event.ctrlKey||event.metaKey)&&!event.altKey;
  // F5 in the chat does not reload the workbench but refreshes like there: application reloaded, state restored.
  if(event.key==='F5'||(ctrl&&event.key.toLowerCase()==='r')){event.preventDefault();parent.postMessage({caw:'refresh'},'*');}
  else if(PASS_KEYS.includes(event.key)&&plain){event.preventDefault();toBench(event.key);}
  // Ctrl+, opens the workbench's settings, Ctrl+K its ⋯ menu, ? (when not typing) the keys.
  else if(ctrl&&event.key===','){event.preventDefault();toBench('Ctrl+,');}
  else if(ctrl&&event.key.toLowerCase()==='k'){event.preventDefault();toBench('Ctrl+K');}
  // Ctrl+J shows or hides the chat over the app; outside App only the workbench ignores it.
  else if(ctrl&&event.key.toLowerCase()==='j'&&solo){event.preventDefault();toBench('Ctrl+J');}
  else if(event.key==='?'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.target?.closest?.('input,textarea')){event.preventDefault();toBench('?');}
  else if(event.key==='F9'&&plain){event.preventDefault();pauseKey();}});
// A new mode from the workbench's settings: only from it, only one of the three modes.
addEventListener('message',(event)=>{const pref=event.data?.pref;if(event.source===parent&&event.data?.caw==='mode'&&['system','light','dark'].includes(pref))document.documentElement.dataset.pref=pref;});
// F9 and Esc from the workbench: only from it, only these two.
addEventListener('message',(event)=>{if(event.source!==parent)return;if(event.data?.caw==='pop')popped=event.data.on===true;if(event.data?.caw==='solo')solo=event.data.on===true;});
addEventListener('message',(event)=>{if(event.source!==parent||event.data?.caw!=='key')return;
  if(event.data.key==='F9')pauseKey();
  else if(event.data.key==='Escape'){if(openMenus().length>0)closeMenus(true);else if(!pick.classList.contains('on')&&canAbort())abort.click();}});
${sourceTag}</script></body></html>`;
};

// Runs in an isolated world of the chat frame: the page's own scripts cannot redefine window.origin or document.write there.
const WRITE_CHAT = `(html) => {
    if (window.origin !== 'null') return false;
    document.open();
    document.write(html);
    document.close();
    return true;
}`;

/**
 * Writes the chat page into the chat frame, but only into a document with an opaque origin, i.e. while the frame still has its
 * sandbox (CHAT_SANDBOX, without allow-same-origin). The application shares the workbench's origin and can remove the sandbox
 * attribute and reload the frame; the new document then has the application's origin, and the application could read the
 * token from it. Check and write happen in one script in an isolated world (CDP), so the page can neither fake the origin nor
 * step in between. Chrome runs a sandboxed iframe in a process of its own (its own CDP target); a chat frame without one has
 * lost its sandbox. Like Playwright's setContent this is document.open/write, not a navigation.
 * @returns true if written; false if the frame does not hold an opaque-origin document
 */
export const writeChat = async (context, frame, html) => {
    let cdp;
    try {
        await frame.waitForURL('about:srcdoc', { timeout: 15000 });
        cdp = await context.newCDPSession(frame);
    } catch {
        return false;
    }
    try {
        const { frameTree } = await cdp.send('Page.getFrameTree');
        const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'caw-chat-writer' });
        const { result } = await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: `(${WRITE_CHAT})(${JSON.stringify(html)})`, returnByValue: true });
        return result?.value === true;
    } catch {
        return false;
    } finally {
        await cdp.detach().catch(() => {});
    }
};

/**
 * Connects the workbench's chat frame to the conversation. There is no chat without a workbench.
 * @param logPath     transcript in the run folder, without Claude's log and actions: those are in claude.log
 * @param transcript  the history so far, carried along: demonstration, Claude and verification run are separate browsers
 * @param onOpen      tests only: receives the chat frame
 * @param onWaiting   receives a line for the terminal once the chat waits for the human: once per such state
 * @param onTampered  receives a CawError 'chat-tampered' once the page under test has replaced or reloaded the chat frame. The
 *                    chat is closed by then (every open decision ends without an answer); the run ends with that error.
 */
export const openChat = async ({ session, logPath, onAbort, onOpen, onWaiting, onTampered, transcript = [] }) => {
    // `doc()` is the chat document, the frame in the workbench (a new one after a reload); `chatWindow` is the surrounding workbench.
    const bench = session.workbench ?? null;
    if (bench === null) throw new CawError('chat-failed', t('chat.error.noWorkbench'));
    if (bench.chatOpen) throw new CawError('chat-failed', t('chat.error.alreadyOpen'));
    bench.chatOpen = true;
    const doc = () => bench.chatFrame();
    const chatWindow = bench.page;
    const quiet = (promise) => promise.catch(() => {});
    // Set once the page under test has touched the chat frame: from then on nothing is written into it or read from it.
    let tampered = null;
    // The frame the host last wrote the chat page into. Every navigation of it afterwards comes from someone else.
    let written = null;
    /** Calls a function of the chat page; after tampering nothing: the frame then holds someone else's document. */
    const inChat = (fn, arg) => (tampered === null ? doc().evaluate(fn, arg) : Promise.resolve());
    let picking = false;
    let onPicked = null;
    // Token of the chat page written last, new on every show().
    let nonce = null;
    let current = ['running', null];
    // Claude is starting: the workbench's pill says so until the next entry or state.
    let startingShown = false;
    // The state for which the terminal last reported that the window is waiting.
    let waitingFor = null;
    // The human closes the window after the run (linger).
    let closeWanted = null;
    // The human clicked into the input while it counted down: the window waits for "Close window" only.
    let stayWanted = null;
    // After the run: { report: absolute path, shown: path for humans, text, command, learn }.
    let next = null;
    let learnClicked = false;
    const openReport = async () => {
        const page = await chatWindow.context().newPage();
        await page.setContent(reportPage({ markdown: readFileSync(next.report, 'utf8'), path: next.shown ?? next.report, dir: dirname(next.report) }));
        await page.bringToFront();
    };
    const render = (state, options) => {
        current = [state, options ?? null];
        const { text, label, button } = statusTexts(state);
        return inChat((args) => window.setStatus(...args), [state, text, label, button, options ?? null]);
    };
    const chat = createChat({
        show: (who, text, about) => {
            const at = Date.now();
            if (LOGGED.has(who)) appendFileSync(logPath, `${new Date(at).toISOString()} ${who}: ${text.replaceAll('\n', ' ')}\n`);
            // With its time: the page shows it next to the speaker, also after a reload.
            transcript.push([who, text, about ?? null, at]);
            quiet(inChat((args) => window.addMessage(...args), [who, text, about ?? null, at]));
            if (who === 'starting') {
                startingShown = true;
                quiet(Promise.resolve(bench.chatState?.('starting')));
            } else if (startingShown) {
                startingShown = false;
                quiet(Promise.resolve(bench.chatState?.(current[0])));
            }
        },
        status: (state, options) => {
            quiet(render(state, options));
            // A decision has to be seen: in App only (F8) the chat is hidden, e.g. the confirmation after F1 while developing.
            if (NEEDS_HUMAN.includes(state)) {
                quiet(chatWindow.bringToFront());
                quiet(Promise.resolve(bench.showChat?.()));
            }
            // Whoever waits in the terminal sees there that the window is waiting. Repeating the same state does not count.
            if (NEEDS_HUMAN.includes(state) && state !== waitingFor) {
                waitingFor = state;
                onWaiting?.(t('chat.waiting', { status: statusTexts(state).text }));
            } else if (!NEEDS_HUMAN.includes(state)) waitingFor = null;
            quiet(Promise.resolve(bench.mood?.(ASKS_HUMAN.includes(state) ? 'ask' : 'wait')));
            startingShown = false;
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
        await inChat(() => window.setPicking(true));
        const picked = await pickElement(session).catch(() => null);
        picking = false;
        await inChat(() => window.setPicking(false));
        if (picked !== null && chat.canPick()) {
            chat.attach(picked);
            await inChat((label) => window.setChip(label), picked.label);
            onPicked?.(picked);
        }
        await chatWindow.bringToFront();
    };
    await chatWindow.exposeBinding(BINDING, (source, event) => {
        // In the workbench every frame sees the binding, including the application. It must never speak as the human.
        // The application shares the origin with the workbench and can reload the chat iframe (srcdoc, location), with or
        // without its sandbox. The frame then stays the same, and so does the binding. Only the page the host wrote last knows
        // the token, and the host writes it only into an opaque-origin document (writeChat), so the application cannot read it.
        // A chat frame that navigated after its first document never speaks again: the run ends (tamper).
        if (tampered !== null || source.frame !== written || source.frame !== doc() || event?.nonce !== nonce) return;
        if (bench.chatNavigations?.(source.frame) !== 1) return;
        if (event?.type === 'message') {
            chat.human.message(event.text, { checkpoint: event.checkpoint === true });
            quiet(inChat(() => window.setChip(null)));
        } else if (event?.type === 'pick') quiet(pick());
        else if (event?.type === 'unpick') chat.detach();
        else if (event?.type === 'toggle') chat.human.toggle();
        else if (event?.type === 'choose') chat.human.choose(event.text);
        else if (event?.type === 'abort') chat.human.abort();
        else if (event?.type === 'report' && next !== null) quiet(openReport());
        else if (event?.type === 'close') closeWanted?.();
        else if (event?.type === 'stay') stayWanted?.();
        // "Save baselines" on the end card: learning happens once the window is closed, like --learn would have done.
        else if (event?.type === 'learn' && next?.learn === true) {
            learnClicked = true;
            closeWanted?.();
        }
    });
    /** While developing: who additionally receives an element picked with the crosshair (the Claude Code session). null: nobody. */
    chat.onPicked = (handler) => { onPicked = handler ?? null; };
    /** Did the human click "Save baselines" on the end card? */
    chat.learnWanted = () => learnClicked;
    /** The page under test touched the chat: close it, nothing more goes in or out, the run ends with chat-tampered. */
    const tamper = () => {
        if (tampered !== null) return;
        tampered = new CawError('chat-tampered', t('chat.error.tampered'));
        nonce = null;
        chat.human.closed();
        onTampered?.(tampered);
    };
    // The host never navigates the chat frame after writing it (document.write is no navigation): any navigation is the page's.
    chatWindow.on('framenavigated', (frame) => {
        if (frame === written) tamper();
    });
    const show = async () => {
        if (tampered !== null) return;
        const frame = doc();
        // Set before the write: a navigation that commits during it counts as tampering, too.
        written = frame;
        nonce = randomBytes(16).toString('hex');
        // Only into the frame's first document, the placeholder from the workbench HTML: a later one was loaded by the page.
        if (bench.chatNavigations?.(frame) !== 1 || !(await writeChat(chatWindow.context(), frame, chatPage(nonce)))) {
            tamper();
            return;
        }
        if (tampered !== null) return;
        await inChat((entries) => entries.forEach((entry) => window.addMessage(...entry)), transcript);
        if (next !== null) await inChat((info) => window.setNext(info), next);
    };
    /** The run is over: the card shows the report and the command for a new run. */
    chat.finished = async (info) => {
        next = info;
        await quiet(inChat((value) => window.setNext(value), info));
    };
    /**
     * After the run, after finished and closing the conversation: the window stays open with "close window" and a countdown.
     * @returns once the human closes it or the time is up
     */
    /** Whether the agent is working: shown as "working" in a conversation. Waiting for the person ends it. */
    let working = false;
    chat.working = (on) => {
        if (on === working && on) return;
        working = on === true;
        quiet(inChat((value) => window.setWorking?.(value), working));
    };
    chat.linger = async (ms) => {
        const clicked = new Promise((resolve) => { closeWanted = () => resolve('close'); });
        const stayed = new Promise((resolve) => { stayWanted = () => resolve('stay'); });
        let timer;
        // With "Save baselines" on the card the window waits for a choice: a countdown would close it unseen behind More.
        const counting = next?.learn !== true;
        const elapsed = new Promise((resolve) => { if (counting) timer = setTimeout(() => resolve('time'), ms); });
        await quiet(render('closed'));
        // In App only the end card shows over the app, so the countdown does not run out unseen.
        await quiet(Promise.resolve(bench.showChat?.()));
        await quiet(inChat((seconds) => window.linger(seconds), counting ? Math.round(ms / 1000) : null));
        if (await Promise.race([clicked, elapsed, stayed]) === 'stay') {
            clearTimeout(timer);
            await clicked;
        }
        clearTimeout(timer);
        closeWanted = null;
        stayWanted = null;
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
