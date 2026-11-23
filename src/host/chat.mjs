// The chat in the workbench, right of the application iframe: Claude asks and reports, the human answers, pauses or
// aborts. Deliberately not inside the application page: there it could cover buttons, end up in snapshots and recordings,
// and the page itself could slip instructions to Claude. The binding only exists on the chat page.
//
// The page, in Graphite (style.mjs) and the personal mode, is the panel "Now": the card that waits with its buttons (one main
// action, the others beside it or behind "More"), or while caw or the agent works a calm block with what runs and the last
// lines. The phase bar of a guided fix stands once at the top. Everything else (answered cards as one line, actions, notices,
// earlier windows) is in the history behind the button at the bottom. The one main action of a state without a card (Done,
// Finish demo, Hand over …) sits full width (Ctrl+Enter); while the agent works it is "Pause F9". The end card's command wraps
// only between words and keeps its spaces. "/" at the start of the field opens the commands (element, checkpoint, pause,
// cancel, and open, requests and the like for the workbench). Those for the workbench are posted to it like a forwarded key (CHAT_KEYS): they open views there.
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
const LOGGED = new Set(['human', 'checkpoint', 'claude', 'question', 'result', 'intro', 'notice', 'tokens', 'plan', 'advice', 'failure', 'decision']);
// The human is demonstrating: a reload is then part of the path, not a break of the run.
const SHOWING_STATES = ['showing', 'asking', 'paused'];
const PICK_STATES = ['paused', 'asking', 'showing', 'describing', 'planning', 'discussing', 'developing'];
// Conversations with open input: a message goes to the flow together with the picked element.
const TALK_KINDS = ['discussing', 'developing'];
/**
 * A result card: what happened as its title, details and consequence below, and its tone (fail, warn, next, info, ask) as
 * icon and colour; optionally rows ([{ label, text, code }] as a key/value list) and the bug fix phase it belongs to (phase:
 * reproduced, red, fix, green or promoted, shown as a bar over the card), with phases: 'design' a design draft's (draft, red,
 * build, green or adopted). As one line for the log and the waiting line:
 * "<title>: <text> <muted>".
 */
export const resultText = ({ title, text, muted }) => [`${title}${/[.?!:]$/.test(title) || (!text && !muted) ? '' : ':'}`, text, muted].filter(Boolean).join(' ');
const waitingText = (question, card) => {
    if (card === undefined || card.kind === 'tokens') return question;
    return card.kind === 'result' ? resultText(card) : card.question;
};
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
 *                (about: the element label), or a card: plan, failure, decision, advice, tokens (about: the card). A button's
 *                answer is a human entry with about { answer: true }; an answer from outside the window a notice with about
 *                { answer: label, by }
 * @param status  shows the state, see STATES; plus the options when the human has to decide
 * @param onAbort the human aborts the whole run
 * @param desk    the run's decisions (decision-desk.mjs): each decision a card waits for is opened there and settled with who
 *                answered; the desk may answer it itself (the session through caw_decide, a run without a window)
 */
export const createChat = ({ show: shown = () => {}, status = () => {}, onAbort = () => {}, desk } = {}) => {
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
    // The question of a waiting card goes along: the terminal names it instead of a general status.
    const publish = () => status(state(), choice?.options, choice?.question);
    // The decision of the plan card, and who answered the decision being settled when it was not the window.
    let planDecision = null;
    let answeredBy = null;
    /** A decision waits: the desk knows it, and may answer it from outside the window. */
    const opened = (decision) => {
        if (decision !== undefined && decision !== null) desk?.open(decision, (answer) => external(decision, answer));
    };
    const settled = (decision, answer) => {
        const by = answeredBy ?? 'window';
        answeredBy = null;
        if (decision !== undefined && decision !== null) desk?.settle(decision, answer, by);
    };
    /** Ends a wait for the human. */
    const answerPlan = (answer) => {
        const resolve = planAnswer;
        const decision = planDecision;
        planAnswer = null;
        planDecision = null;
        element = null;
        if (resolve !== null) settled(decision, answer);
        resolve?.(answer);
    };
    const answerChoice = (id) => {
        const resolve = choice?.resolve;
        const decision = choice?.decision;
        choice = null;
        if (resolve !== undefined) settled(decision, id);
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
    /**
     * Waits for a button under a card (choose, choosePicks).
     * @param picks the ids of the card's checkboxes: the answer is then { choice, picked }
     * @param decision the decision as data (decisions.mjs), for the desk
     */
    const ask = (kind, question, options, card, picks, decision) => {
        if (ended) return Promise.resolve(null);
        // In the middle of a conversation (e.g. the token notice before Claude answers): the conversation reopens afterwards.
        const parked = TALK_KINDS.includes(choice?.kind) ? choice : null;
        return new Promise((resolve) => {
            choice = {
                kind,
                options,
                decision,
                ...(picks === undefined ? {} : { picks }),
                // What the human sees: a decision card asks its own question, a result card says what happened; `question`
                // is then only for the log.
                question: waitingText(question, card),
                resolve: parked === null ? resolve : (id) => {
                    if (!ended) choice = parked;
                    resolve(id);
                    publish();
                },
            };
            if (card === undefined) show('result', question, { kind: 'result', tone: 'ask', title: question });
            else if (card.kind === 'result') show('result', resultText(card), card);
            else if (card.kind === 'tokens') show('tokens', question, card);
            else show('decision', question, card);
            publish();
            opened(decision);
        });
    };
    /**
     * Answers the waiting decision from outside the window: the session through caw_decide, or caw in a run without a window.
     * The chat shows who answered; the window's buttons give way to what comes next.
     * @returns whether `decision` was still the one waiting and the answer fits it
     */
    const external = (decision, { option, message, picked, by }) => {
        if (ended) return false;
        // The card waiting for it closes with this answer: in the window one line in the history, with who answered.
        const said = (label) => show('notice', t({ elicitation: 'chat.answeredInSession', auto: 'chat.answeredAuto', terminal: 'chat.answeredInTerminal', stopped: 'chat.stoppedOpen' }[by] ?? 'chat.answeredBySession', { label }), { answer: label, by: ['elicitation', 'auto', 'terminal', 'stopped'].includes(by) ? by : 'session' });
        if (choice === null && planAnswer !== null && planDecision === decision) {
            if (option === 'approve') {
                said(t('chat.page.approvePlan'));
                answeredBy = by;
                answerPlan({ approved: true });
            } else if (option === 'revise' && typeof message === 'string') {
                said(t('chat.decision.revise'));
                show('human', message.trim().slice(0, MAX_TEXT));
                answeredBy = by;
                answerPlan({ approved: false, feedback: message.trim().slice(0, MAX_TEXT) });
            } else return false;
            publish();
            return true;
        }
        if (choice === null || choice.decision !== decision) return false;
        const offered = choice.options.find((candidate) => candidate.id === option);
        if (offered === undefined) return false;
        said(offered.label);
        answeredBy = by;
        if (choice.picks === undefined) answerChoice(option);
        else {
            const ticked = new Set(Array.isArray(picked) ? picked : []);
            answerChoice({ choice: option, picked: choice.picks.filter((pick) => ticked.has(pick)) });
        }
        publish();
        return true;
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
                    show('human', t('chat.planApproved'), { answer: true });
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
            /**
             * One of the offered options. Unknown values are ignored. A card with checkboxes (choosePicks) also gets the ticked
             * ones; anything the card did not offer is dropped.
             */
            choose: (id, picked) => {
                const option = choice?.options.find((candidate) => candidate.id === id);
                if (option === undefined) return;
                if (choice.picks === undefined) {
                    show('human', option.label, { answer: true });
                    answerChoice(id);
                } else {
                    const ticked = new Set(Array.isArray(picked) ? picked : []);
                    const kept = choice.picks.filter((pick) => ticked.has(pick));
                    show('human', kept.length === 0 ? option.label : `${option.label}: ${kept.join(', ')}`, { answer: true });
                    answerChoice({ choice: id, picked: kept });
                }
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
        /** A result card that waits for nothing (the guided fix's last phase). */
        result: (card) => {
            if (!ended) show('result', resultText(card), card);
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
        plan: (view, decision) => {
            if (ended) return Promise.resolve({ approved: false, feedback: null });
            return new Promise((resolve) => {
                planAnswer = resolve;
                planDecision = decision ?? null;
                show('plan', view.steps.map(({ id, name, expect }) => `${id} ${name}: ${expect}`).join(' | '), view);
                publish();
                opened(decision);
            });
        },
        /**
         * The human picks by button.
         * @param kind choosing or deciding
         * @param card the decision as a card (title, facts, details), or { kind: 'tokens', text } for the token notice, whose
         *             title is `question`; otherwise `question` then only goes to the log
         * @returns the option id, null if the window closes or the human aborts
         */
        choose: (kind, question, options, card, decision) => ask(kind, question, options, card, undefined, decision),
        /**
         * Like choose, with checkboxes in a decision card: `card.picks` { title, text, items: [{ id, label }] }, none ticked.
         * @returns { choice, picked: [id] } in the card's order; choice null if the window closes or the human aborts
         */
        choosePicks: async (kind, question, options, card, decision) => {
            const answer = await ask(kind, question, options, card, card.picks.items.map(({ id }) => id), decision);
            return answer !== null && typeof answer === 'object' ? answer : { choice: answer ?? null, picked: [] };
        },
        /**
         * An advice as a card; the human decides by button.
         * @param view from adviceView; logged as its title
         * @returns the option id, null if the window closes
         */
        advice: (view, options, decision) => {
            if (ended) return Promise.resolve(null);
            // In the middle of a conversation: the card comes in between, then the conversation reopens.
            const parked = TALK_KINDS.includes(choice?.kind) ? choice : null;
            return new Promise((resolve) => {
                choice = {
                    kind: 'reviewing',
                    options,
                    decision,
                    resolve: (id) => {
                        if (parked !== null && !ended) choice = parked;
                        resolve(id);
                        publish();
                    },
                };
                show('advice', `${({ app: 'Application', outside: 'Outside' })[view.side] ?? 'Test'}: ${view.title}`, view);
                publish();
                opened(decision);
            });
        },
        /**
         * After a failure: the human writes or picks. Stays open while Claude answers.
         * @param question if omitted, no new question appears and the conversation continues
         * @param card     the failure as a card; `question` then only goes to the log
         * @returns { choice } with the id, { message } with the text, null if the window closes
         */
        discuss: (question, options, card, decision) => {
            if (ended) return Promise.resolve(null);
            return new Promise((resolve) => {
                offer({ kind: 'discussing', options, decision, resolve: (answer) => resolve(typeof answer === 'string' ? { choice: answer } : answer) });
                // The test run is over: between two answers the chat no longer shows it as running.
                if (background === 'testing') background = null;
                if (question !== undefined) show(card === undefined ? 'result' : 'failure', question, card ?? { kind: 'result', tone: 'ask', title: question });
                publish();
                opened(decision);
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
                // An explanation of what the window offers now, not a question: its own card.
                if (question !== undefined) show('intro', question);
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
 *
 * The page is the panel "Now": only the current thing, large. A card that waits (with its buttons), or while caw or the agent
 * works a calm block: what runs now and the last few lines. The phase bar of a guided fix stands once at the top. Everything
 * else is in the history (Verlauf, a button at the bottom with the counts): an answered card as one line with the answer, the
 * actions, caw's notices, and the entries of earlier windows of the same run, which never come back into the panel itself.
 */
export const chatPage = (nonce = '', mode = readPrefs().mode) => {
    const ctrl = t('workbench.page.keyCtrl');
    const slash = slashCommands(ctrl).map(([name, id, glyph, key, bench]) => `<button type="button" class="pop-i${name === 'cancel' ? ' danger' : ''}" role="option" tabindex="-1" id="${id}" data-cmd="${name}" data-name="/${name}"${bench ? ` data-key="${bench}"` : ''}${id === 'pick' ? ` title="${t('chat.page.pickTitle')}"` : ''}>${icon(glyph)}<span><span class="nm">/${name}</span><small>${t(`chat.page.cmd.${name}`)}</small></span>${key ? `<kbd>${key}</kbd>` : '<span></span>'}</button>`).join('');
    const icons = { agent: 'agent', you: 'user', cross: 'cross', flag: 'flag', info: 'info', chev: 'chev-r', chevd: 'chev-d', loader: 'loader', check: 'check', x: 'x', alert: 'alert', help: 'help', list: 'list', file: 'file', copy: 'copy', terminal: 'terminal', bug: 'bug', coins: 'coins', lock: 'lock', msg: 'msg', pause: 'pause', play: 'play', stop: 'stop', bookmark: 'bookmark', dot: 'circle', dash: 'dash' };
    const ICON = Object.fromEntries(Object.entries(icons).map(([name, glyph]) => [name, icon(glyph, { cls: name === 'loader' ? 'spin' : '' })]));
    return `<!doctype html><html lang="${language()}"${modeAttr(mode)}><head><meta charset="utf-8"><title>caw · Chat</title><script>${MODE_SCRIPT}${sourceTag}</script>${FAVICON}<style>
${styleSheet()}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--panel);color:var(--text);font:400 13px/1.5 var(--font)}
button{cursor:pointer}
/* The phases of a guided bug fix or target design: once at the top, one segment per phase with its name. */
#phases{flex:none;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:4px;margin:0;padding:16px 18px 0;list-style:none}
#phases li{display:flex;flex-direction:column;gap:5px;min-width:0;font:500 10.5px/1.2 var(--font);color:var(--faint)}
#phases li::before{content:"";height:4px;border-radius:2px;background:var(--line)}
#phases li.done{color:var(--muted)}#phases li.done::before{background:var(--pass)}
#phases li[aria-current]{color:var(--accent-text);font-weight:600}#phases li[aria-current]::before{background:var(--accent)}
/* Only the current phase is named under its segment; the others are named for screen readers and as tooltip. */
#phases span{white-space:nowrap}#phases li:last-child{align-items:flex-end}#phases li:not([aria-current]) span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
/* Now: the card that waits, the conversation about it, or the block while something runs. */
#now{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:18px;scrollbar-width:thin;scrollbar-color:var(--line2) var(--panel)}
#now>*{flex-shrink:0}
#card:empty,#thread:empty{display:none}
#thread{display:flex;flex-direction:column;gap:12px}
/* Messages: who speaks (the agent, You) with an icon and the time, the text below. */
.message{display:flex;flex-direction:column;gap:3px;min-width:0}
.who{display:inline-flex;align-items:center;gap:6px;font:500 12px/1.2 var(--font);color:var(--text)}
.who .i{width:13px;height:13px}.who.c .i{color:var(--agent)}.who.h .i{color:var(--muted)}
.who small{font:400 10.5px/1 var(--font-mono);color:var(--faint)}
.who .cp{display:inline-flex;align-items:center;gap:4px;color:var(--muted)}.who .cp .i{color:var(--accent-text)}
.txt{font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.about{display:flex;gap:5px;font:400 11px/1.35 var(--font-mono);color:var(--muted);overflow-wrap:anywhere}
.about .i{width:12px;height:12px;margin-top:1px;color:var(--accent-text)}
/* The agent working on an answer while a card stays: one line under the conversation. */
#thinking{display:none;align-items:center;gap:7px;font:500 12px/1 var(--font);color:var(--agent)}#thinking .i{width:14px;height:14px}
body.awaiting:has(#card:not(:empty)):is([data-state=discussing],[data-state=developing]) #thinking{display:flex}
/* The block while caw or the agent works, or the person demonstrates: what runs, a short fact, the last lines. */
#work{display:flex;flex-direction:column;gap:10px}
body:has(#card:not(:empty)) #work,[data-state=closed] #work{display:none}
#workLabel{display:flex;align-items:center;gap:9px;margin:0;font:600 17px/1.3 var(--font);letter-spacing:-.01em}#workLabel:empty{display:none}
:is([data-state=running],[data-state=advising],[data-state=testing],[data-state=verifying],[data-state=preparing],[data-state=handing]) #workLabel::before{content:"";flex:none;width:11px;height:11px;border-radius:50%;border:2px solid var(--run);border-right-color:transparent;animation:caw-spin .9s linear infinite}
#status{margin:0;font-size:13px;line-height:1.55;color:var(--muted)}#status:empty{display:none}
#lines{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px;line-height:1.4;color:var(--muted)}
#lines li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:8px;align-items:baseline;min-width:0}
#lines li>span{overflow-wrap:anywhere}#lines .mk .i{width:12px;height:12px;color:var(--pass)}#lines small{font:400 11px/1 var(--font-mono);color:var(--faint)}
#lines li:last-child{color:var(--text)}
:is([data-state=running],[data-state=advising],[data-state=testing],[data-state=verifying],[data-state=preparing],[data-state=handing]) #lines li:last-child .mk .i{display:none}
:is([data-state=running],[data-state=advising],[data-state=testing],[data-state=verifying],[data-state=preparing],[data-state=handing]) #lines li:last-child .mk::before{content:"";display:block;width:8px;height:8px;margin-top:2px;border-radius:50%;border:2px solid var(--run);border-right-color:transparent;animation:caw-spin .9s linear infinite}
[data-state=showing] #lines .mk .i{color:var(--fail)}
/* Cards: plan, question, advice, failure, decision, the token notice and results. In the panel large and flat. */
.message.card{gap:12px;font-size:13px;line-height:1.55;overflow:visible}
#card>.card,#next{padding:0;border:0;border-radius:0;background:none}
.kick{font:600 11px/1.2 var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.card>strong{display:flex;align-items:flex-start;gap:9px;font:600 18px/1.3 var(--font);letter-spacing:-.01em;color:var(--text)}
.card>strong .i{flex:none;width:18px;height:18px;margin-top:3px}.card>strong .meta{margin-left:auto;padding-top:5px;font:400 11px/1 var(--font-mono);color:var(--faint)}
.card p{margin:0}.card .txt{white-space:pre-wrap;color:var(--muted)}.card .muted{color:var(--muted);font-size:12px}
.question>strong .i{color:var(--agent)}
:is(.r-ask,.r-next,.r-info)>strong .i{color:var(--run)}.r-fail>strong .i{color:var(--fail)}.r-warn>strong .i{color:var(--warn)}
.plan>strong .i{color:var(--accent-text)}.advice>strong .i{color:var(--agent)}.decision>strong .i{color:var(--pass)}.tokens>strong .i{color:var(--warn)}
.failure>strong .i{color:var(--fail)}
.kv code{font:400 11.5px/1.5 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
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
/* Checkboxes in a card (choosePicks): one row per item, locked after the choice. */
.picks{margin:0;padding:8px 10px 10px;border:1px solid var(--line);border-radius:var(--r1);display:flex;flex-direction:column;gap:6px;min-width:0}
.picks legend{padding:0 4px;font:600 11px/1.4 var(--font);letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}
.picks .pick{display:flex;align-items:baseline;gap:8px;font-size:12.5px;cursor:pointer;overflow-wrap:anywhere}
.picks .pick input{margin:0;flex:none;accent-color:var(--accent);transform:translateY(2px)}.picks .pick input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.picks .sid{font:500 11.5px/1.6 var(--font-mono);color:var(--accent-text)}
.picks:disabled .pick{cursor:default;opacity:.6}
.advice h2{margin:0;font:600 14px/1.3 var(--font)}.advice .target{font:400 11.5px/1.4 var(--font-mono);color:var(--muted);overflow-wrap:anywhere}
.diff-h{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);color:var(--muted);font:400 11px/1.3 var(--font);background:var(--panel2)}
.diff-h b{color:var(--text);font:500 11px/1.3 var(--font-mono)}.diff-h .i{width:13px;height:13px}.diff-h span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prompt{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:var(--r1);background:var(--panel2);font-size:12px;color:var(--muted)}
.prompt .ptext{white-space:pre-wrap;overflow-wrap:break-word;max-height:200px;overflow:auto}.prompt .lnk{font-size:12px;align-self:flex-start}
/* The buttons of the waiting card: one main action, the rest beside it or behind "More". */
#cancel{display:none;align-items:center;gap:8px}body.arming #cancel,body.stopping #cancel{display:flex}
body:not(:has(#card:not(:empty))):is([data-state=running],[data-state=pausing],[data-state=paused],[data-state=asking],[data-state=showing],[data-state=describing],[data-state=handing],[data-state=verifying],[data-state=testing],[data-state=preparing],[data-state=advising]) #cancel{display:flex}
#abort.sure{background:var(--fail);color:var(--on-accent);border-color:transparent}
#toggle{display:none}#toggle.lnk{font-size:12px;align-self:flex-start}#toggle.lnk kbd{margin-left:2px}
:is([data-state=running],[data-state=pausing]) #toggle{display:inline-flex}
:is([data-state=paused],[data-state=asking],[data-state=showing],[data-state=describing]) #toggle{display:flex;width:100%}
#toggle.busy .i{display:none}#toggle.busy::before{content:"";width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:caw-spin .9s linear infinite}
#choices{display:none;flex-direction:column;gap:8px}
:is([data-state=choosing],[data-state=deciding],[data-state=reviewing],[data-state=discussing],[data-state=developing],[data-state=planning]) #choices{display:flex}
.acts{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:8px}.acts>.btn,.acts>.more{flex:0 0 auto}.acts>.btn-p{flex:1 1 100%}
#choices .btn,#next .btn{white-space:normal;height:auto;min-height:36px;padding:9px 15px;line-height:1.25;text-align:center}
#choices .rest>.btn{flex:1 1 auto}#choices .rest>.btn-p{flex:1 1 100%;font-size:14px}
#choices button.sure{background:var(--fail);color:var(--on-accent);border-color:transparent}
#choices button:disabled{cursor:progress;opacity:.55}#choices button.busy{opacity:1}
#choices button.busy::before{content:"";width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:caw-spin .9s linear infinite}
/* More: the other options of a card, a menu under the row. */
.more{position:static}.more .btn .i{width:14px;height:14px}
.more .pop{position:absolute;right:0;top:calc(100% + 6px);z-index:30;min-width:min(220px,100%);max-width:min(320px,100%)}
.more .pop-i{display:block;white-space:normal;line-height:1.35;font-size:12.5px}.more .pop-i:focus{outline:none;background:var(--accent-soft)}
.more .pop-i.sure{background:var(--fail);color:var(--on-accent)}
#nextActs .more .pop{top:auto;bottom:calc(100% + 6px)}
/* The end card after the run; with a final card above it, only its command and buttons. */
#next{display:none;flex-direction:column;gap:12px;overflow:visible}[data-state=closed] #next.on{display:flex}
#next.merged #nextHead,#next.merged #nextText{display:none}
#stays{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;color:var(--muted)}#stays[hidden]{display:none}#stays .i{width:13px;height:13px}
#next[data-kind=pass] #nextIcon .i{color:var(--pass)}#next[data-kind=fail] #nextIcon .i{color:var(--fail)}#next[data-kind=reproduce] #nextIcon .i{color:var(--warn)}
#nextIcon{display:inline-grid}#nextIcon:empty{display:none}
#nextText{color:var(--muted)}#nextText:empty,#nextRepro:empty{display:none}#nextRepro{display:flex;flex-direction:column;gap:10px}
.quote{padding:8px 10px;border-radius:var(--r1);background:var(--panel2);font-size:12.5px;font-style:italic;overflow-wrap:anywhere}
.banner.ro{padding:7px 10px}.banner.ro span{font-size:12px}
.cmd{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:var(--r1);background:var(--code);color:var(--code-text);font:400 11.5px/1.45 var(--font-mono)}
.cmd>.i{width:14px;height:14px;margin-top:1px;color:var(--muted)}.cmd>span{min-width:0;flex:1}
/* A command wraps between its words; only a word longer than the line breaks inside (a long draft id). The spaces stay. */
.cmd code{white-space:normal;overflow-wrap:normal;word-break:normal}.cmd .w{display:inline-block;max-width:100%;overflow-wrap:anywhere}
.cmd small{display:block;margin-bottom:2px;font:400 11.5px/1.4 var(--font);color:var(--muted)}.cmd code{font:inherit}
.cmd .ib{width:22px;height:22px;margin:-2px -4px -2px 0}.cmd .ib .i{width:14px;height:14px}.cmd:empty{display:none}
/* At the bottom: the history with its counts, then the input with its label. */
footer{flex:none;position:relative;display:flex;flex-direction:column;gap:10px;padding:10px 18px 16px}
#histBtn{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:var(--r2);background:var(--bg);color:var(--muted);font:500 12.5px/1.3 var(--font);text-align:left}
#histBtn:hover{color:var(--text);border-color:var(--line2)}#histBtn .hb{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#histBtn .i{width:14px;height:14px}
#histCount{font-weight:400;color:var(--faint)}#histCount:empty{display:none}
#pickNote{margin:0;font-size:12px;color:var(--accent-text)}
#ask{display:flex;flex-direction:column;gap:5px}
#inputLabel{font-size:12px;color:var(--muted)}
form{position:relative;display:flex;flex-direction:column;gap:8px;margin:0;padding:8px 10px;border-radius:var(--r2);background:var(--panel);border:1px solid var(--line2)}
form:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}form:has(textarea:disabled){opacity:.75}
:is([data-state=handing],[data-state=choosing],[data-state=deciding],[data-state=reviewing],[data-state=verifying],[data-state=testing],[data-state=preparing],[data-state=advising]) #ask{display:none}
[data-state=closed] #ask{opacity:.7}.stopping #ask,.stopping #choices{opacity:.55;pointer-events:none}
.inp-row{display:flex;align-items:flex-end;gap:8px;min-width:0}
textarea{display:block;flex:1;min-width:0;width:100%;min-height:22px;max-height:160px;margin:0;padding:2px 0;resize:none;border:0;outline:0;background:none;font:400 13px/1.45 var(--font);color:var(--text);overflow-y:hidden;scrollbar-width:thin;caret-color:var(--accent)}
textarea.full{overflow-y:auto}textarea::placeholder{color:var(--faint)}textarea:focus-visible{outline:0}
#send{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--r1);background:var(--prim);color:var(--on-prim)}
#send:hover:enabled{background:var(--prim-hi)}#send:disabled{background:var(--line);color:var(--faint);cursor:default}#send .i{width:15px;height:15px;stroke-width:2.3}
#chip{display:none;align-items:center;gap:6px;align-self:flex-start;max-width:100%;height:24px;padding:0 4px 0 8px;border-radius:var(--r1);background:var(--accent-soft);color:var(--accent-text);font:500 11.5px/1 var(--font-mono)}#chip.on{display:inline-flex}
#chipText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#chipRemove{display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:none;color:inherit}#chipRemove:hover{background:var(--panel)}#chipRemove .i{width:12px;height:12px}
#slash{position:absolute;left:-1px;right:-1px;bottom:calc(100% + 6px);z-index:30;max-height:min(360px,60vh);overflow:auto}
#slash .pop-i>span{min-width:0}#slash .pop-i .nm{display:block;font:500 12px/1.3 var(--font-mono)}#slash .pop-i small{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#slash .pop-i:disabled{background:none}#pick.on .nm{color:var(--accent-text)}
#slashEmpty{padding:6px 8px;color:var(--faint);font-size:12px}
/* The history: over the whole panel, every entry in order, the cards as one line that opens the card. */
#history{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;background:var(--panel)}
.h-top{flex:none;display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--line)}
.h-top h2{margin:0;font:600 15px/1.2 var(--font);outline:0}.h-top .lnk{margin-left:auto;font-size:12px}
#hist{flex:1;min-height:0;overflow:auto;margin:0;padding:12px 18px 18px;list-style:none;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin}
#hist>li{min-width:0}
.h-sep{display:flex;align-items:center;gap:8px;margin-top:6px;font:600 10.5px/1.2 var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}.h-sep::after{content:"";flex:1;height:1px;background:var(--line)}
.h-line{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:1.45;color:var(--muted)}.h-line>.i{flex:none;width:14px;height:14px;margin-top:2px}
.h-line .txt{font-size:12.5px}
.h-card details{flex:1;min-width:0}.h-card summary{display:flex;align-items:baseline;gap:8px;cursor:pointer;list-style:none;color:var(--text)}.h-card summary::-webkit-details-marker{display:none}
.h-card .mk{flex:none;width:14px;text-align:center;font-weight:600}.h-card .ok{color:var(--pass)}.h-card .open{color:var(--accent-text)}.h-card .off{color:var(--faint)}
.h-card summary .tx{min-width:0;overflow-wrap:anywhere}.h-card summary small{color:var(--faint);font-size:12px}.h-card summary small:not(:empty)::before{content:" · "}
.h-card details>.card{margin:8px 0 4px 22px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r2)}
.h-card details>.card>strong{font-size:14px}.h-card details>.card>strong .i{width:15px;height:15px;margin-top:1px}
.h-msg{display:flex;flex-direction:column;gap:3px}
details.activity{font:400 11.5px/1.4 var(--font-mono);color:var(--muted)}
details.activity summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;user-select:none;min-width:0}
details.activity summary::-webkit-details-marker{display:none}
details.activity .mk{display:inline-grid;place-items:center;width:12px;flex:none}.activity .mk .i{width:12px;height:12px}
details.activity[open] .mk .chev{transform:rotate(90deg)}
details.activity .count{flex:none}details.activity .latest{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}details.activity .latest::before{content:"· "}
details.activity ol{margin:6px 0 0 5px;padding:0 0 0 12px;border-left:1px solid var(--line2);list-style:none;display:flex;flex-direction:column;gap:2px}
details.activity li{overflow-wrap:anywhere}
.activity li small.items{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body data-state="running">
<ol id="phases" hidden></ol>
<main id="now" aria-live="polite"><div id="card"></div><div id="thread"></div><div id="thinking" aria-hidden="true">${ICON.loader}<span>${t('chat.page.thinking')}</span></div>
<section id="work" aria-labelledby="workLabel"><h2 id="workLabel"></h2><p id="status" role="status" aria-live="polite"></p><ol id="lines"></ol></section>
<div id="choices"></div>
<button id="toggle" type="button" class="lnk"><span class="tic"></span><span id="toggleText"></span><kbd class="key" aria-hidden="true"></kbd></button>
<div id="cancel"><button id="abort" class="btn btn-s btn-sm" type="button" title="${t('chat.page.abortTitle')}">${t('chat.page.abort')}</button><button id="abortNo" class="btn btn-s btn-sm" type="button" hidden>${t('chat.page.no')}</button></div>
<div id="next" class="card" role="region" aria-label="${t('chat.page.nextStep')}"><strong id="nextHead"><span id="nextIcon"></span><span id="nextTitle">${t('chat.page.nextStep')}</span></strong><p id="nextText"></p><div id="nextRepro"></div><div class="cmd" id="nextCmd"></div>
<div class="acts" id="nextActs"><button id="closeWindow" type="button" class="btn btn-s" hidden></button><button id="report" type="button" class="btn btn-s">${t('chat.page.openReport')}</button></div><p id="stays" hidden>${icon('clock')}<span>${t('chat.page.stays')}</span></p></div></main>
<footer><p id="pickNote" hidden>${t('chat.page.picking')}</p>
<button id="histBtn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="history"><span class="hb">${t('chat.page.history')} <span id="histCount"></span></span>${icon('chev-r')}</button>
<div id="ask"><label id="inputLabel" for="input"></label><form id="form"><div id="slash" class="pop" role="listbox" aria-label="${t('chat.page.commands')}" hidden><div class="pop-h">${t('chat.page.commands')}</div>${slash}<div id="slashEmpty" hidden>${t('chat.page.noCommand')}</div></div>
<div id="chip"><span id="chipText"></span><button id="chipRemove" type="button" aria-label="${t('chat.page.removeElement')}" title="${t('chat.page.removeElement')}">${icon('x')}</button></div>
<div class="inp-row"><textarea id="input" rows="1" aria-controls="slash" aria-autocomplete="list" placeholder="${t('chat.page.placeholder')}"></textarea><button id="send" type="submit" aria-label="${t('chat.page.send')}" title="${t('chat.page.send')} (Enter)" disabled>${icon('up')}</button></div></form></div></footer>
<section id="history" role="dialog" aria-modal="true" aria-labelledby="histTitle" hidden><header class="h-top"><h2 id="histTitle" tabindex="-1">${t('chat.page.history')}</h2><button id="histClose" type="button" class="lnk">${t('chat.page.historyClose')}<kbd>Esc</kbd></button></header><ol id="hist"></ol></section>
<script>
const T=${json(texts('chat.page.'))};
const ICON=${json(ICON)};
const AGENT=${JSON.stringify(AGENT_NAME)};
const $=(id)=>document.getElementById(id);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=text;return node;};
// The icons are static SVG from the host, never page content.
const ic=(name,cls)=>{const box=document.createElement('template');box.innerHTML=ICON[name]??'';const svg=box.content.firstChild;if(cls)svg.classList.add(cls);return svg;};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]);
const send=(type,text,checkpoint,picked)=>window.${BINDING}({type,text,checkpoint,picked,nonce:${JSON.stringify(nonce)}});
// The checkboxes of the card that waits for a button; after the choice they are locked.
let openPicks=null;
const takePicks=()=>{if(openPicks===null)return undefined;const ticked=[...openPicks.querySelectorAll('input:checked')].map((box)=>box.value);openPicks.disabled=true;openPicks=null;return ticked;};
const toBench=(key)=>parent.postMessage({caw:'key',key},'*');
const input=$('input'),now=$('now'),abort=$('abort'),sendButton=$('send'),toggleButton=$('toggle'),statusBox=$('status');
const KEY=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ ↵':T['chat.page.ctrlEnter'];
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
const pick=$('pick'),chip=$('chip');
const PICK_STATES=["paused","asking","showing","planning","discussing","developing"];
const pickAllowed=()=>PICK_STATES.includes(stateNow());
$('chipRemove').addEventListener('click',()=>{window.setChip(null);send('unpick');});
window.setPicking=(on)=>{pick.classList.toggle('on',on);$('pickNote').hidden=!on;};
window.setChip=(label)=>{chip.classList.toggle('on',label!==null);$('chipText').textContent=label??'';input.focus();};
// Cancelling is possible while something runs; deciding, talking, developing and the end have no cancel.
let sure=false,stopping=false,unsure=null;
const abortNo=$('abortNo');
const canAbort=()=>!abort.disabled&&!['deciding','discussing','developing','closed'].includes(stateNow());
const unarm=()=>{sure=false;clearTimeout(unsure);document.body.classList.remove('arming');abort.classList.remove('sure');abort.textContent=T['chat.page.abort'];abortNo.hidden=true;};
abortNo.addEventListener('click',()=>{unarm();input.focus();});
abort.addEventListener('click',()=>{
  if(stopping)return;
  if(sure){stopping=true;clearTimeout(unsure);abortNo.hidden=true;document.body.classList.remove('arming');abort.disabled=true;document.body.classList.add('stopping');abort.classList.remove('sure');abort.textContent=T['chat.page.aborting'];statusBox.textContent=T['chat.page.abortingStatus'];send('abort');return;}
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

const clock=(at)=>{if(!at)return null;const d=new Date(at);return el('small','',String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));};
const whoLine=(who,at,extra)=>{const line=el('span','who '+(who==='claude'?'c':'h'));const name=el('span','',who==='claude'?AGENT:T['chat.page.you']);name.dataset.who=who;line.append(ic(who==='claude'?'agent':'you'),name);if(extra)line.append(extra);const time=clock(at);if(time)line.append(time);return line;};
const head=(glyph,title,meta)=>{const strong=el('strong');strong.append(ic(glyph),el('span','',title));if(meta)strong.append(el('span','meta',meta));return strong;};
const card=(cls)=>el('div','message card '+cls);
// The phases of the guided bug fix, or of a design draft (phases: 'design'): once at the top, where the person stands.
const PHASES={fix:['reproduced','red','fix','green','promoted'],design:['draft','red','build','green','adopted']};
const phaseName=(name,flow)=>T['chat.page.phase.'+(flow==='design'&&name==='green'?'met':name)];
const setPhase=(phase,flow)=>{const names=flow==='design'?PHASES.design:PHASES.fix;const at=names.indexOf(phase);if(at<0)return;const bar=$('phases');bar.className='phases';bar.setAttribute('aria-label',T[flow==='design'?'chat.page.phasesDesign':'chat.page.phases']);
  bar.replaceChildren(...names.map((name,i)=>{const li=el('li',i<at?'done':i>at?'later':'now');li.title=phaseName(name,flow);li.append(el('span','',phaseName(name,flow)));if(i===at)li.setAttribute('aria-current','step');return li;}));bar.hidden=false;};
const list=(title,items,cls)=>{if(!items||items.length===0)return null;const details=el('details');const summary=el('summary');summary.append(ic('chev'),title+' ('+items.length+')');const ul=el('ul');
  for(const text of items){const li=el('li',cls);li.append(ic(cls==='e'?'x':cls==='w'?'alert':'dot'),el('span','',text));ul.append(li);}details.append(summary,ul);return details;};
const copyButton=(text,select)=>{const copy=el('button','lnk copy');copy.type='button';copy.append(ic('copy'),el('span','',T['chat.page.copyPrompt']));
  copy.addEventListener('click',async()=>{let done=false;try{await navigator.clipboard.writeText(text);done=true;}catch{}if(!done){const range=document.createRange();range.selectNodeContents(select);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);try{done=document.execCommand('copy');}catch{}}copy.querySelector('span').textContent=done?T['chat.page.copied']:T['chat.page.copyManual'];});return copy;};

// A card as an element: in the panel while it waits, a copy in the history when its line opens (copy: its checkboxes locked).
const CARDS=['plan','failure','decision','advice','tokens','question','result','intro'];
const build=(who,text,about,copy)=>{
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
    return box;
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
    return box;
  }
  if(who==='decision'){
    const box=card('decision');box.append(head('check',about.title));
    if(about.facts&&about.facts.length>0){const ul=el('ul');for(const fact of about.facts){const li=el('li');li.append(ic('dot'),el('span','',fact));ul.append(li);}box.append(ul);}
    if(about.warn){const warn=el('div','warnbox warn');warn.append(ic('alert'),el('span','',about.warn));box.append(warn);}
    for(const section of about.details??[]){const part=list(section.title,section.items,'w');if(part)box.append(part);}
    // Checkboxes the human ticks before choosing, none ticked: they go along with the button they click (choosePicks).
    if(about.picks){const set=el('fieldset','picks');set.append(el('legend','',about.picks.title));if(about.picks.text)set.append(el('p','muted',about.picks.text));
      for(const item of about.picks.items){const label=el('label','pick');const tick=el('input');tick.type='checkbox';tick.value=item.id;label.append(tick,el('span','sid',item.id),el('span','nm',item.label));set.append(label);}
      box.append(set);if(copy)set.disabled=true;else openPicks=set;}
    if(about.question)box.append(el('p','next',about.question));
    return box;
  }
  if(who==='advice'){
    const box=card('advice '+about.side);box.append(el('span','kick',T[({app:'chat.page.adviceApp',outside:'chat.page.adviceOutside'})[about.side]??'chat.page.adviceTest']),head('agent',about.title));
    if(about.target)box.append(el('div','target',about.target));if(about.about)box.append(el('div','target',fill('chat.page.about',{about:about.about})));
    box.append(el('p','reason txt',about.reason));
    if(about.evidence)box.append(el('p','muted',fill('chat.page.evidence',{evidence:about.evidence})));
    if(about.contradicts){const warn=el('div','warnbox warn');warn.append(ic('alert'),el('span','',T['chat.page.contradicts']));box.append(warn);}
    // A change in the code as diff lines, numbered from the line it names.
    for(const edit of about.edits??[]){const diff=el('div','diff');const top=el('div','diff-h');top.append(ic('file'),el('b','',edit.file+(edit.line?':'+edit.line:'')));if(edit.why)top.append(el('span','',edit.why));diff.append(top);
      const lines=(text,kind)=>String(text).split(String.fromCharCode(10)).forEach((line,i)=>{const row=el('div','dl '+kind);row.append(el('span','n',edit.line?String(Number(edit.line)+i):''),el('span','sg',kind==='del'?'−':'+'),el('code','',line));diff.append(row);});
      lines(edit.find,'del');lines(edit.replace,'add');box.append(diff);}
    if(about.changes){const facts=el('dl','kv');for(const change of about.changes){const dd=el('dd');if(change.before){dd.append(el('span','before',change.before),el('br'));}dd.append(change.after);facts.append(el('dt','',change.label),dd);}box.append(facts);}
    if(about.prompt){const prompt=el('div','prompt');const words=el('div','ptext',about.prompt);prompt.append(words,copyButton(about.prompt,words));box.append(prompt);}
    return box;
  }
  if(who==='tokens'){const box=card('tokens');box.append(head('coins',text));if(about?.text)box.append(el('p','muted',about.text));return box;}
  // The agent's own question (ask-operator): the kicker says who asks.
  if(who==='question'){const box=card('question');box.append(el('span','kick',fill('chat.page.agentAsks',{agent:AGENT})),head('agent',text));return box;}
  // What happened and waits for a button: the head says what, the tone gives icon and colour, the phase is the kicker.
  if(who==='result'){const glyph={fail:'x',warn:'alert',next:'play',info:'info',ask:'help'}[about.tone]??'info';const box=card('result r-'+(about.tone??'info'));
    box.append(head(glyph,about.title));if(about.text)box.append(el('p','txt',about.text));
    if(about.rows){const kv=el('dl','kv');for(const row of about.rows){const dd=el('dd');dd.append(row.code?el('code','',row.text):row.text);kv.append(el('dt','',row.label),dd);}box.append(kv);}if(about.muted)box.append(el('p','muted',about.muted));return box;}
  const box=card('intro');box.append(head('info',T['chat.page.intro']),el('p','txt',text));return box;
};
// The one line a card leaves in the history.
const cardTitle=(who,text,about)=>who==='plan'?(about.title||(about.repairing?T['chat.page.repairStep']:T['chat.page.plan']))+' · '+(about.steps.length===1?T['chat.page.oneStep']:fill('chat.page.steps',{n:about.steps.length}))
  :who==='failure'?fill('chat.page.failed',{id:about.id}):who==='intro'?T['chat.page.intro']:who==='tokens'||who==='question'?text:about?.title??text;

// The history: every entry in order. Counted: answered cards and all entries.
const hist=$('hist');let done=0,total=0,windows=0,group=null;
const count=()=>{$('histCount').textContent=total===0?'':(done>0?fill('chat.page.historyDone',{n:done})+' · ':'')+(total===1?T['chat.page.historyOne']:fill('chat.page.historyAll',{n:total}));};
const toHist=(node)=>{hist.append(node);if(!$('history').hidden)hist.scrollTop=hist.scrollHeight;};
const histLine=(who,glyph,content)=>{const li=el('li','h-line');li.dataset.who=who;li.append(ic(glyph));if(typeof content==='string')li.append(el('span','txt',content));else li.append(content);return li;};
const histCard=(who,text,about)=>{const li=el('li','h-line h-card');li.dataset.who=who;const details=el('details');const summary=el('summary');const mark=el('span','mk open','●');const what=el('span','t',cardTitle(who,text,about));const by=el('small');const tx=el('span','tx');tx.append(what,by);summary.append(mark,tx);details.append(summary);
  // The card itself only when the line opens.
  details.addEventListener('toggle',()=>{if(details.open&&details.childElementCount===1)details.append(build(who,text,about,true));});li.append(details);li.mark=mark;li.what=what;li.by=by;return li;};
const endGroup=()=>{group?.details.classList.remove('live');group=null;};

// The panel: the card that waits (current), the messages after it, the block with the last lines while something runs.
let current=null;
const thread=$('thread'),lines=$('lines'),MAX_LINES=4,MAX_THREAD=6;
const clearNow=()=>{$('card').replaceChildren();thread.replaceChildren();current=null;openPicks=null;};
const answer=(label,by)=>{const line=current?.line??[...hist.querySelectorAll('.h-card')].at(-1);
  if(line&&!line.answered){line.answered=true;line.mark.className='mk '+(by==='stopped'?'off':'ok');line.mark.textContent=by==='stopped'?'○':'✓';line.by.textContent=[by?T['chat.page.by.'+by]:'',line.what.textContent].filter(Boolean).join(' · ');line.what.textContent=label;done+=1;}else{toHist(histLine('answer','check',[label,by?T['chat.page.by.'+by]:''].filter(Boolean).join(' · ')));total+=1;}count();
  if(current)clearNow();};
// A line in the block while something runs: the newest one is what runs now, the ones before it are done.
let starting=null;
const elapsed=(row)=>{const s=Math.max(0,Math.floor((Date.now()-Number(row.dataset.t0))/1000));row.querySelector('small').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
setInterval(()=>{if(starting)elapsed(starting);},1000);
const started=()=>{if(!starting)return;elapsed(starting);starting=null;};
const workLine=(text,merge,t0)=>{let li=merge?lines.lastElementChild:null;if(!li){li=el('li');const mk=el('span','mk');mk.append(ic('check'));li.append(mk,el('span'),el('small'));lines.append(li);}
  li.children[1].textContent=text;if(t0){li.dataset.t0=String(t0);elapsed(li);starting=li;}while(lines.childElementCount>MAX_LINES)lines.firstElementChild.remove();};
const toThread=(node)=>{thread.append(node);while(thread.childElementCount>MAX_THREAD)thread.firstElementChild.remove();now.scrollTop=now.scrollHeight;};
const bubble=(who,text,about,at)=>{const item=el('div','message '+who);
  if(who==='checkpoint'){const cp=el('span','cp');cp.append(ic('flag'),T['chat.page.checkpoint']);item.append(whoLine('human',at,cp));}
  else item.append(whoLine(who==='claude'?'claude':'human',at));
  if(typeof about==='string'){const ref=el('span','about');ref.append(ic('cross'),el('span','',about));item.append(ref);}
  item.append(el('div','txt',text));return item;};

// Over the app in App only (Ctrl+J): Esc hides the chat instead of cancelling; the workbench says when (pop).
let popped=false,solo=false;
// What the agent says or asks reaches the workbench as "new" (a dot on Chat while hidden); replayed history after a reload does not.
const UNREAD=['claude','plan','failure','decision','advice','question','result','intro','tokens'];
/**
 * One entry. past: from an earlier window of the same run, only for the history. A window marker ('window') starts the entries
 * of the next window. A button answer comes as a human entry with { answer: true }, an answer from elsewhere as a notice with
 * { answer: label, by }: both close the card that waits.
 */
window.addMessage=(who,text,about,at,past)=>{
  if(who==='window'){windows+=1;endGroup();if(windows>1||past)toHist(el('li','h-sep',fill('chat.page.window',{n:windows})));return;}
  if(!past&&UNREAD.includes(who)&&Date.now()-(at||Date.now())<5000)parent.postMessage({caw:'unread'},'*');
  if(about?.phase)setPhase(about.phase,about.phases);
  // An answer: the card becomes one line in the history, with the answer.
  if((who==='human'&&about?.answer===true)||(who==='notice'&&typeof about?.answer==='string')){endGroup();answer(who==='human'?text:about.answer,who==='human'?'':about.by);count();return;}
  // Its start (after Continue) begins "working"; the host ends it once the agent waits for the person (setWorking).
  if(!past&&who==='starting'&&['discussing','developing','running'].includes(stateNow()))document.body.classList.add('awaiting');
  // One start at a time: preparing the sandbox and starting the agent show as one line.
  if(who==='starting'&&starting&&!past)return;
  total+=1;
  if(who==='activity'){
    if(group===null){const li=el('li','h-act');const details=el('details','activity live');details.setAttribute('aria-live','off');const summary=el('summary');const mark=el('span','mk');mark.append(ic('chev','chev'));const count=el('span','count');const latest=el('span','latest');summary.append(mark,count,latest);const ol=el('ol');details.append(summary,ol);li.append(details);group={details,count,latest,list:ol,total:0};toHist(li);}
    const merging=about?.merge===true&&group.list.lastElementChild!==null;const li=merging?group.list.lastElementChild:el('li');li.replaceChildren(el('span','',text));if(Array.isArray(about?.items)&&about.items.length>1)li.append(el('small','items',about.items.join(' · ')));if(typeof about?.raw==='string')li.title=about.raw;if(!merging)group.list.append(li);else total-=1;group.total+=1;group.count.textContent=group.total===1?T['chat.page.oneAction']:fill('chat.page.actions',{n:group.total});group.latest.textContent=text;
    if(!past){started();workLine(text,merging);}count();return;}
  endGroup();
  if(who==='starting'){toHist(histLine('starting','loader',text));if(!past){started();workLine(text,false,at||Date.now());}count();return;}
  if(!past)started();
  if(who==='notice'){toHist(histLine('notice','info',text));if(!past)workLine(text,false);count();return;}
  if(CARDS.includes(who)){const line=histCard(who,text,about);toHist(line);
    if(!past){if(current&&!current.line.answered){current.line.mark.className='mk off';current.line.mark.textContent='–';}clearNow();$('card').append(build(who,text,about,false));current={who,line};now.scrollTop=0;}
    else{line.mark.className='mk off';line.mark.textContent='–';}
    count();return;}
  // Messages: in the history, and in the panel under the card they are about.
  const li=el('li','h-msg');li.dataset.who=who;li.append(bubble(who,text,about,at));toHist(li);
  if(!past)toThread(bubble(who,text,about,at));count();
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
const closeWindow=$('closeWindow'),report=$('report');
// The main action: close the window, else the report.
const arrangeNext=()=>{const shown=[closeWindow,report].filter((b)=>!b.hidden);const rest=shown.slice(1).sort((a,b)=>(a===report?-1:b===report?1:0));arrange($('nextActs'),'nextMore',shown.slice(0,1),rest);};
// A final card above (the guided fix adopted) says it already: the end card keeps only its command and buttons.
const merge=()=>{$('next').classList.toggle('merged',current?.who==='result'&&choices.childElementCount===0);};
const KINDS={pass:['check','chat.page.endPass'],fail:['x','chat.page.endFail'],reproduce:['bug','']};
window.setNext=(info)=>{const box=$('next');box.classList.toggle('on',!!info);if(!info)return;
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
  merge();arrangeNext();};
report.addEventListener('click',()=>{closeMenus();send('report','');});
// After the last decision the window stays open briefly: the human sees the result and closes it, otherwise it closes on timeout.
let lingerTimer=0;
closeWindow.addEventListener('click',()=>{closeMenus();clearInterval(lingerTimer);closeWindow.disabled=true;send('close');});
// A click into the input while the window counts down: the person stays, the countdown stops for good.
const stay=()=>{if(lingerTimer===0||closeWindow.disabled)return;clearInterval(lingerTimer);lingerTimer=0;closeWindow.textContent=T['chat.page.closeNow'];$('stays').hidden=false;send('stay');};
input.addEventListener('pointerdown',stay);input.addEventListener('focus',stay);
window.linger=(seconds)=>{let left=seconds;const paint=()=>{closeWindow.textContent=fill('chat.page.closeIn',{n:left});};closeWindow.hidden=false;closeWindow.disabled=false;paint();arrangeNext();
  if(closeWindow.offsetParent!==null)closeWindow.focus({preventScroll:true});clearInterval(lingerTimer);lingerTimer=setInterval(()=>{left=Math.max(0,left-1);paint();if(left===0)clearInterval(lingerTimer);},1000);};

// The history over the panel: the button at the bottom opens it, Esc or its own button closes it.
const histBtn=$('histBtn'),historyBox=$('history');
const showHistory=(on)=>{if(on===!historyBox.hidden)return;historyBox.hidden=!on;histBtn.setAttribute('aria-expanded',String(on));if(on){hist.scrollTop=hist.scrollHeight;$('histTitle').focus({preventScroll:true});}else histBtn.focus();};
histBtn.addEventListener('click',()=>showHistory(true));$('histClose').addEventListener('click',()=>showHistory(false));

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
// The input's label: a hint while something runs or the person shows, a question otherwise.
const HINT_STATES=['running','pausing','paused','asking','showing','describing'];
// The host knows: the agent works until it waits for the person (its chat call) or ends.
window.setWorking=(on)=>{document.body.classList.toggle('awaiting',on===true);};
window.setStatus=(state,text,label,button,options)=>{if(state==='closed')document.body.classList.remove('awaiting');document.body.dataset.state=state;toggleButton.disabled=false;toggleButton.classList.remove('busy');toggleButton.removeAttribute('aria-busy');
  if(!stopping){statusBox.textContent=text;$('workLabel').textContent=label;}
  $('inputLabel').textContent=fill(HINT_STATES.includes(state)?'chat.page.hintLabel':'chat.page.askLabel',{agent:AGENT});
  // While the agent works in the application the input is locked: typing here would take the focus from the application (an open
  // list closes when its field loses the focus). Pausing unlocks it.
  const locked=state==='running';input.disabled=locked;
  // After the run nothing listens any more: the input only stays reachable to stop the close countdown.
  input.readOnly=state==='closed';input.placeholder=locked?T['chat.page.lockedPlaceholder']:state==='closed'?T['chat.page.endedPlaceholder']:state==='planning'?T['chat.page.planPlaceholder']:state==='showing'?T['chat.page.showPlaceholder']:state==='describing'?T['chat.page.describePlaceholder']:hint;fit();
  // The main action: a link with F9 while the agent works, else the full-width button with Ctrl+Enter.
  const asLink=state==='running'||state==='pausing';toggleButton.className=asLink?'lnk':'btn btn-p';
  toggleButton.querySelector('.tic').replaceChildren(ic(TOGGLE_ICON[state]??'play'));toggleButton.querySelector('.key').textContent=asLink?'F9':KEY;$('toggleText').textContent=button;
  closeMenus();
  const all=state==='planning'&&!(options?.length)?[{id:'approve',label:T['chat.page.approvePlan'],primary:true,big:true}]:options??[];
  const buttons=all.map((option)=>{const choice=el('button','',option.label);choice.type='button';if(option.primary)choice.classList.add('primary');if(option.big){choice.classList.add('big');choice.id='approve';const key=el('kbd','',KEY);key.setAttribute('aria-hidden','true');choice.append(key);}
    choice.addEventListener('click',()=>{if(choice.disabled)return;if(option.confirm&&confirmFirst(choice,option))return;choice.disarm?.();closeMenus();lockChoices(choice);if(option.id==='approve'&&state==='planning')send('toggle');else send('choose',option.id,undefined,takePicks());});return choice;});
  // No button waits any more: the checkboxes of an earlier card stay as they were.
  if(all.length===0&&openPicks!==null){openPicks.disabled=true;openPicks=null;}
  const primary=buttons.filter((b)=>b.classList.contains('primary')),rest=buttons.filter((b)=>!b.classList.contains('primary'));
  const row=el('div','acts rest');arrange(row,'choicesMore',primary,rest);choices.replaceChildren(...(buttons.length>0?[row]:[]));
  // New buttons get focus so keyboard and screen reader continue there; someone typing keeps the field.
  if(buttons.length>0&&document.activeElement!==input)(choices.querySelector('.primary')??choices.querySelector('button')).focus({preventScroll:true});
  if(state==='closed')merge();
  if(!pickAllowed())window.setChip(null);renderSlash();};
input.focus();
// Shortcuts: Ctrl+Enter (Cmd+Enter) triggers the main action, e.g. approve or done. Esc first closes a menu or the history, then
// clears the field being typed in; otherwise the first Esc asks to cancel and only a second one within 4 s confirms it.
document.addEventListener('keydown',(event)=>{
  if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&input.value.trim()===''){const main=$('approve');if(main&&main.offsetParent!==null&&!main.disabled){event.preventDefault();main.click();}else if(toggleButton.offsetParent!==null&&!toggleButton.disabled){event.preventDefault();toggleButton.click();}}
  else if(event.key==='Escape'){
    if(openMenus().length>0){event.preventDefault();closeMenus(true);return;}
    if(!historyBox.hidden){event.preventDefault();showHistory(false);return;}
    if(pick.classList.contains('on'))return;
    if(document.activeElement===input&&input.value!==''){event.preventDefault();input.value='';fit();renderSlash();return;}
    if(popped){event.preventDefault();toBench('Ctrl+J');return;}
    if(canAbort()){event.preventDefault();abort.click();}}
});
// The workbench's keys apply here too: the chat passes them on (CHAT_KEYS). It handles F9 and Esc itself, F11 and F12 stay with the browser.
const PASS_KEYS=['F1','F2','F3','F4','F6','F7','F8','F10'];
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
addEventListener('message',(event)=>{if(event.source!==parent)return;if(event.data?.caw==='pop')popped=event.data.on===true;if(event.data?.caw==='focus')input.focus();if(event.data?.caw==='solo')solo=event.data.on===true;});
addEventListener('message',(event)=>{if(event.source!==parent||event.data?.caw!=='key')return;
  if(event.data.key==='F9')pauseKey();
  else if(event.data.key==='Escape'){if(openMenus().length>0)closeMenus(true);else if(!historyBox.hidden)showHistory(false);else if(!pick.classList.contains('on')&&canAbort())abort.click();}});
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
 * @param desk        the run's decisions (decision-desk.mjs)
 */
export const openChat = async ({ session, logPath, onAbort, onOpen, onWaiting, onTampered, transcript = [], desk }) => {
    // `doc()` is the chat document, the frame in the workbench (a new one after a reload); `chatWindow` is the surrounding workbench.
    const bench = session.workbench ?? null;
    if (bench === null) throw new CawError('chat-failed', t('chat.error.noWorkbench'));
    if (bench.chatOpen) throw new CawError('chat-failed', t('chat.error.alreadyOpen'));
    bench.chatOpen = true;
    const doc = () => bench.chatFrame();
    const chatWindow = bench.page;
    // What came before belongs to earlier windows of the same run: only in this window's history, never in its panel. A marker
    // starts this window's entries.
    const earlier = transcript.length;
    transcript.push(['window', '', null, Date.now()]);
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
    const openReport = async () => {
        const page = await chatWindow.context().newPage();
        await page.setContent(reportPage({ markdown: readFileSync(next.report, 'utf8'), path: next.shown ?? next.report, dir: dirname(next.report) }));
        await page.bringToFront();
    };
    const render = (state, options) => {
        current = [state, options ?? null];
        const { text, label: plain, button } = statusTexts(state);
        // While the agent records (or fixes) the working block says so; the header has no chip of its own.
        const label = state === 'running' && bench?.transportNow?.() === 'record' ? t('chat.status.running.recordLabel') : plain;
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
        status: (state, options, question) => {
            quiet(render(state, options));
            // A decision has to be seen: in App only (F8) the chat is hidden, e.g. the confirmation after F1 while developing.
            if (NEEDS_HUMAN.includes(state)) {
                quiet(chatWindow.bringToFront());
                quiet(Promise.resolve(bench.showChat?.()));
            }
            // Whoever waits in the terminal sees there that the window is waiting. Repeating the same state does not count.
            if (NEEDS_HUMAN.includes(state) && state !== waitingFor) {
                waitingFor = state;
                onWaiting?.(t('chat.waiting', { status: question ?? statusTexts(state).text }));
            } else if (!NEEDS_HUMAN.includes(state)) waitingFor = null;
            quiet(Promise.resolve(bench.mood?.(ASKS_HUMAN.includes(state) ? 'ask' : 'wait')));
            startingShown = false;
            quiet(Promise.resolve(bench.chatState?.(state)));
            if (picking && !PICK_STATES.includes(state)) quiet(cancelPick(session));
        },
        onAbort,
        desk,
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
    // Playwright hands an exception of a binding back to the page, where nobody sees it: the click would just do nothing
    // further (the human bubble shown, the next step never started). Diagnosis only: the exception goes to stderr and chat.log
    // and is thrown on as before.
    const answered = (handler) => (source, event) => {
        try {
            return handler(source, event);
        } catch (error) {
            const line = t('chat.error.answer', { type: String(event?.type ?? '?'), message: error?.message ?? String(error) });
            console.error(`caw: ${line}${error?.stack === undefined ? '' : `\n${error.stack}`}`);
            try {
                appendFileSync(logPath, `${new Date().toISOString()} error: ${line.replaceAll('\n', ' ')}\n`);
            } catch {
                // The log itself failed: stderr has it.
            }
            throw error;
        }
    };
    await chatWindow.exposeBinding(BINDING, answered((source, event) => {
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
        else if (event?.type === 'choose') chat.human.choose(event.text, event.picked);
        else if (event?.type === 'abort') chat.human.abort();
        else if (event?.type === 'report' && next !== null) quiet(openReport());
        else if (event?.type === 'close') closeWanted?.();
        else if (event?.type === 'stay') stayWanted?.();
    }));
    /** While developing: who additionally receives an element picked with the crosshair (the Claude Code session). null: nobody. */
    chat.onPicked = (handler) => { onPicked = handler ?? null; };
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
        await inChat(([entries, past]) => entries.forEach((entry, index) => window.addMessage(...entry, index < past)), [transcript, earlier]);
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
        const elapsed = new Promise((resolve) => { timer = setTimeout(() => resolve('time'), ms); });
        await quiet(render('closed'));
        // In App only the end card shows over the app, so the countdown does not run out unseen.
        await quiet(Promise.resolve(bench.showChat?.()));
        await quiet(inChat((seconds) => window.linger(seconds), Math.round(ms / 1000)));
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
    // Recording starts or ends while the agent works: the working block follows.
    bench.watchTransport?.(() => {
        if (current[0] === 'running' && chat.available()) quiet(render(...current));
    });
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

/**
 * The conversation of a run without a window (record --headless): the same decisions and cards, in the transcript only. Nobody
 * clicks: the desk answers what is provably harmless and stops at what needs a person; nobody writes either, so the agent finds
 * no messages and cannot ask anyone to show something.
 */
export const createHeadlessChat = ({ logPath, desk, transcript = [] }) => {
    const chat = createChat({
        show: (who, text, about) => {
            const at = Date.now();
            if (LOGGED.has(who)) appendFileSync(logPath, `${new Date(at).toISOString()} ${who}: ${String(text).replaceAll('\n', ' ')}\n`);
            transcript.push([who, text, about ?? null, at]);
        },
        desk,
    });
    chat.headless = true;
    chat.working = () => {};
    return chat;
};
