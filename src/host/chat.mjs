// Der Chat in der Werkbank, links neben der Anwendung im iframe: Claude fragt und berichtet, der Mensch antwortet, pausiert oder
// bricht ab. Bewusst nicht in der Seite der Anwendung: Dort koennte es Schaltflaechen ueberdecken, in Snapshots und Aufzeichnung
// geraten, und die Seite selbst koennte Claude Anweisungen unterschieben. Das Binding gibt es nur auf der Chat-Seite.

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

import { CawError } from '../shared/errors.mjs';
import { language, t, texts } from '../shared/i18n.mjs';
import { sourceTag } from './app-view.mjs';
import { cancelPick, pickElement } from './demonstrate.mjs';
import { reportPage } from './report-page.mjs';
import { FAVICON, FONT_FACES, PIXEL_CSS, TOKENS, ring } from './theme.mjs';

const BINDING = '__cawChat';
const MAX_TEXT = 4000;
const MAX_ACTIVITY = 300;
const TAIL_MS = 500;
const LOGGED = new Set(['human', 'checkpoint', 'claude', 'question', 'plan', 'advice', 'failure', 'decision']);
// Der Mensch fuehrt vor: Neuladen ist dann Teil des Wegs, kein Bruch des Laufs.
const SHOWING_STATES = ['showing', 'asking', 'paused'];
const PICK_STATES = ['paused', 'asking', 'showing', 'planning', 'discussing', 'developing'];
// Gespraeche mit offener Eingabe: Eine Nachricht geht samt gewaehltem Element an den Ablauf.
const TALK_KINDS = ['discussing', 'developing'];
// Hier muss der Mensch etwas tun, das Fenster darf also nicht hinter der Anwendung liegen.
const NEEDS_HUMAN = ['choosing', 'planning', 'deciding', 'reviewing', 'discussing'];
// Dann fliegt der Rabe der Werkbank zum Chat.
const RAVEN_ASKS = [...NEEDS_HUMAN, 'asking', 'showing', 'developing'];
const UNNAMED_ELEMENT_NOTE = 'Dieses Element meine ich.';

// Zustandszeile, Pill und Knopf je Zustand. Zur Laufzeit geholt: Beim Import steht die Sprache noch nicht fest.
const STATES = ['running', 'pausing', 'paused', 'asking', 'showing', 'choosing', 'planning', 'handing', 'verifying', 'testing', 'discussing', 'preparing', 'deciding', 'advising', 'reviewing', 'developing', 'closed'];
const status = (state) => {
    const part = (name) => {
        const key = `chat.status.${state}.${name}`;
        const text = t(key);
        return text === key ? '' : text;
    };
    return STATES.includes(state) ? { text: part('text'), label: part('label'), button: part('button') } : undefined;
};

/**
 * Eine Zeile aus claude.log: Text wird zur Nachricht, Befehle werden zu Aktionen. Was das Gespraech selbst ausmacht, steht
 * schon im Chat und faellt hier weg.
 * @returns { kind: 'text' | 'activity', text } oder null
 */
export const parseClaudeLog = (line) => {
    const match = /^\[\+[\d.]+s\] (> )?(.*)$/.exec(line);
    if (match === null || match[2].trim() === '') return null;
    // Das Ende meldet das Tool selbst, mit Ergebnis statt Dauer.
    if (match[1] === undefined && match[2].startsWith('Claude beendet nach')) return null;
    // Freier Text sind Claudes Notizen an sich selbst. An den Menschen richtet es sich nur mit say.
    if (match[1] === undefined) return { kind: 'text', text: match[2].replaceAll(' ⏎ ', ' ').slice(0, MAX_ACTIVITY) };
    const text = readableCommand(match[2]).replace(/^Bash: /, '').replace(/(^|[\s;&|(])caw-ai /g, '$1').replaceAll(' ⏎ ', '; ').trim();
    if (/^(say|chat|plan)\b/.test(text) && !/[;&|]/.test(text)) return null;
    return { kind: 'activity', text: text.slice(0, MAX_ACTIVITY) };
};

/**
 * Der lokale Agent ruft caw ueber MCP auf; im Log steht dann `mcp__caw__caw: {"args":["click","button \"Senden\""]}`. Der Mensch
 * soll denselben Befehl lesen wie beim Agenten in Docker: `click button "Senden"`. Andere Werkzeuge ohne ihre interne Vorsilbe.
 */
const readableCommand = (text) => {
    const call = /^mcp__[\w-]+__caw: (\{.*)$/.exec(text);
    if (call === null) return text.replace(/^mcp__[\w-]+__(\w+): /, '$1: ');
    const shown = (args) => args.map(String).map((arg) => (arg === '' || (/\s/.test(arg) && !/["']/.test(arg)) ? `"${arg}"` : arg)).join(' ');
    try {
        const { args } = JSON.parse(call[1]);
        if (Array.isArray(args)) return shown(args);
    } catch {
        // Im Log abgeschnitten: die vollstaendigen Texte lesen, der letzte endet mit „…“.
    }
    const body = call[1].replace(/^\{"args":\[/, '');
    const parts = [...body.matchAll(/"((?:[^"\\]|\\.)*)("|$)/g)].map(([, value, end]) => {
        const plain = value.replace(/\\(.)/g, '$1');
        return end === '"' ? plain : `${plain}…`;
    });
    return parts.length === 0 ? text.replace(/^mcp__[\w-]+__(\w+): /, '$1: ') : shown(parts);
};

/**
 * Liest neue vollstaendige Zeilen einer wachsenden Datei.
 * @param read Liefert den ganzen Text, leer solange es die Datei nicht gibt
 * @returns stop: liest ein letztes Mal und beendet das Mitlesen
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
 * Der Zustand des Gespraechs, ohne Browser.
 * @param show    zeigt einen Eintrag an: ('human' | 'checkpoint' | 'claude' | 'question' | 'activity', text, Beschriftung des Elements)
 * @param status  zeigt den Zustand an, siehe STATUS; dazu die Wahlmoeglichkeiten, wenn der Mensch entscheiden soll
 * @param onAbort der Mensch bricht den ganzen Lauf ab
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
    // Gespraech, das warten muss, bis eine offene Frage (etwa der Hinweis auf Token) beantwortet ist.
    let queued = null;
    // Claude arbeitet gerade nicht, der Lauf aber schon: verifying oder preparing.
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
    /** Beendet ein Warten auf den Menschen. */
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
    /** Ein Gespraech oeffnen; steht gerade eine andere Frage offen, geht sie vor und das Gespraech kommt danach. */
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
        if (text === '') throw new CawError('usage', 'Der Text fehlt.');
        if (!ended) show(who, text);
        return 'ok';
    };

    return {
        human: {
            /** Ein Pruefpunkt entsteht nur beim Vorfuehren und nur auf ausdruecklichen Wunsch, alles andere ist Kontext. */
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
            /** Die Schaltflaeche: haelt an, hebt die Anfrage auf oder gibt nach der Eingabe an Claude zurueck. */
            toggle: () => {
                // Auch ein ignorierter Klick bekommt einen Zustand zurueck: Der Knopf ist bis dahin gesperrt.
                if (ended || choice !== null || (background !== null && capturing === null)) {
                    publish();
                    return;
                }
                if (planAnswer !== null) {
                    show('human', t('chat.planApproved'));
                    answerPlan({ approved: true });
                } else if (capturing !== null) {
                    // Ein markiertes Element ohne Text darf nicht verloren gehen.
                    if (element !== null) deliver({ note: UNNAMED_ELEMENT_NOTE, element });
                    element = null;
                    // Ende der Vorfuehrung: Bis zum naechsten Abschnitt gibt es hier nichts mehr zu klicken.
                    if (capturing === 'showing') {
                        capturing = null;
                        background = 'handing';
                    }
                    deliver('');
                } else paused = !paused;
                publish();
            },
            /** Eine der angebotenen Moeglichkeiten. Fremde Werte zaehlen nicht. */
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
        /** Eine Mitteilung des Tools, ohne dass der Mensch etwas tun muss. */
        notice: (text) => {
            if (!ended) show('question', text);
        },
        ask: (raw) => claudeText('question', raw),
        /**
         * Legt den Plan vor und wartet: { approved: true } oder { approved: false, feedback }.
         * @param view { repairing, notes, steps } aus planView; im Protokoll steht er als Text
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
         * Der Mensch waehlt per Knopf.
         * @param kind choosing oder deciding
         * @param card die Entscheidung als Karte (title, facts, details); `question` steht dann nur im Protokoll
         * @returns die id der Moeglichkeit, null wenn das Fenster zugeht oder er abbricht
         */
        choose: (kind, question, options, card) => {
            if (ended) return Promise.resolve(null);
            // Mitten im Gespraech (etwa der Hinweis auf Token, bevor Claude antwortet): danach steht das Gespraech wieder offen.
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
         * Eine Empfehlung als Karte, der Mensch entscheidet per Knopf.
         * @param view aus adviceView; im Protokoll steht sie als Titel
         * @returns die id der Moeglichkeit, null wenn das Fenster zugeht
         */
        advice: (view, options) => {
            if (ended) return Promise.resolve(null);
            // Mitten im Gespraech: Die Karte kommt dazwischen, danach steht das Gespraech wieder offen.
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
                show('advice', `${view.side === 'app' ? 'Anwendung' : 'Test'}: ${view.title}`, view);
                publish();
            });
        },
        /**
         * Nach einem Fehler: Der Mensch schreibt oder waehlt. Bleibt offen, waehrend Claude antwortet.
         * @param question ohne Angabe erscheint keine neue Frage, das Gespraech geht weiter
         * @param card     der Fehler als Karte; `question` steht dann nur im Protokoll
         * @returns { choice } mit der id, { message } mit seinem Text, null wenn das Fenster zugeht
         */
        discuss: (question, options, card) => {
            if (ended) return Promise.resolve(null);
            return new Promise((resolve) => {
                offer({ kind: 'discussing', options, resolve: (answer) => resolve(typeof answer === 'string' ? { choice: answer } : answer) });
                // Der Testlauf ist vorbei: Zwischen zwei Antworten zeigt der Chat nicht mehr, dass er laeuft.
                if (background === 'testing') background = null;
                if (question !== undefined) show(card === undefined ? 'question' : 'failure', question, card);
                publish();
            });
        },
        /**
         * Nach der Uebergabe: Der Mensch entwickelt im hergestellten Zustand. Wie discuss, nur ohne Fehler und ohne Fokuswechsel.
         * @returns { choice } mit der id, { message, element? } mit seinem Text, null wenn das Fenster zugeht
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
        /** Das gewaehlte Element, ohne Nachricht, etwa fuer die eigene Claude-Code-Session. Danach ist es weg. */
        takeElement: () => {
            const picked = element;
            element = null;
            return picked;
        },
        /** Der Test laeuft ohne Claude, der Chat schaut nur zu. */
        testing: () => {
            background = 'testing';
            publish();
        },
        /** Claude untersucht im Browser des Laufs. false: fertig. */
        advising: (active = true) => {
            background = active ? 'advising' : null;
            publish();
        },
        /** Ab jetzt laeuft der Pruefdurchlauf ohne Claude. */
        verifying: () => {
            background = 'verifying';
            publish();
        },
        /** Die Schritte vor dem zu behebenden laufen ohne Claude. false gibt an ihn ab. */
        preparing: (active = true) => {
            background = active ? 'preparing' : null;
            publish();
        },
        progress: (text) => {
            if (!ended) show('activity', text);
        },
        /** Eine Zeile aus Claudes Log: Nur zum Mitlesen, sie aendert am Gespraech nichts. */
        logLine: (line) => {
            const entry = parseClaudeLog(line);
            if (entry === null || ended) return;
            show('activity', entry.text);
        },
        /** Vor jedem Browserbefehl: Solange der Mensch etwas zu sagen hat, passiert nichts mehr in der Anwendung. */
        gate: () => {
            if (paused || unread.length > 0) throw new CawError('human-message', 'Der Mensch hat sich im Chat gemeldet. Rufe caw-ai chat auf, bevor du weitermachst.');
        },
        canPick: () => !ended && (capturing !== null || planAnswer !== null || TALK_KINDS.includes(choice?.kind)),
        attach: (picked) => { element = picked; },
        detach: () => { element = null; },
        takeUnread: () => unread.splice(0),
        paused: () => paused,
        available: () => !ended,
        /** Ab hier zaehlen Klicks in der Anwendung: Claude wartet, seine Klicks sind also nicht dabei. */
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
        /** Fuer demonstrate: Text ist ein Pruefpunkt, { note } ein Hinweis, leer heisst fertig. Eine Antwort auf eine Frage beendet das Warten gleich. */
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

/** Die Chat-Seite in der aktuellen Sprache. Texte fuer das Seiten-JS stehen in T. */
const chatPage = (nonce = '') => `<!doctype html><html lang="${language()}"><head><meta charset="utf-8"><title>caw-ai · Chat</title><script>(()=>{addEventListener('message',(event)=>{if(event.source!==parent||event.data?.caw!=='theme')return;const theme=event.data.theme;if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme;else delete document.documentElement.dataset.theme;});try{parent.postMessage({caw:'theme-request'},'*');}catch{}
// Wo die Linie unter dem Kopf liegt und wo darauf Platz ist, gleich hinter dem Titel, in schmalen Spalten mittig vor der Pill: Die Werkbank setzt den Raben dorthin. Der Kopf kann umbrechen, darum bei jeder Groessenaenderung.
addEventListener('DOMContentLoaded',()=>{const head=document.querySelector('header');if(!head)return;const perch=()=>{try{const title=head.querySelector('h1'),text=document.createRange();if(title)text.selectNodeContents(title);const end=title?text.getBoundingClientRect().right:0,next=[...head.children].find((el)=>el!==title&&el.offsetWidth>0&&el.getBoundingClientRect().left>end);parent.postMessage({caw:'perch',y:head.offsetTop+head.clientHeight,x:title?Math.min(end+28,next?(end+next.getBoundingClientRect().left)/2:Infinity):null},'*');}catch{}};new ResizeObserver(perch).observe(head);new MutationObserver(perch).observe(head,{subtree:true,childList:true,characterData:true,attributes:true});perch();});})();${sourceTag}</script>${FAVICON}<style>
${FONT_FACES}${TOKENS}${PIXEL_CSS}
*,*::before,*::after{box-sizing:border-box}html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--surface);color:var(--text);font:var(--fs-body)/1.45 var(--font-body)}
header{display:flex;align-items:center;gap:10px;padding:13px 16px 11px 56px;border-bottom:var(--frame-w) solid var(--frame)}
h1{margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font:500 12px var(--font-ui);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}#pill,#abort,#abortNo{flex:none}
/* Schmaler Chat: Pill und Abbrechen haben Vorrang vor dem Namen. */
@media (max-width:440px){h1 .who{display:none}}
/* Eine Pill nur, solange jemand arbeitet und der Chat still sein kann. Sie ist ein Status, kein Knopf: ohne Rahmen. */
#pill{display:inline-flex;align-items:center;gap:7px;padding:3px 8px 3px 6px;font:500 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--primary-text);white-space:nowrap;cursor:default;user-select:none}
#pill:has(#label:empty),.arming #pill{display:none}
#dot{flex:none;width:4px;height:4px;margin-right:12px;background:currentColor;box-shadow:6px 0 color-mix(in srgb,currentColor 30%,transparent),12px 0 color-mix(in srgb,currentColor 30%,transparent);animation:pxload .9s steps(1,end) infinite}
[data-state=handing] #pill,[data-state=verifying] #pill,[data-state=testing] #pill,[data-state=preparing] #pill{color:var(--muted)}
[data-state=pausing] #pill,[data-state=paused] #pill{color:var(--muted);background:var(--surface-2)}
[data-state=paused] #dot{width:8px;height:9px;margin-right:0;box-shadow:none;animation:none;background:linear-gradient(90deg,currentColor 0 3px,transparent 3px 5px,currentColor 5px 8px)}
[data-state=discussing] #toggle,[data-state=developing] #toggle{display:none}[data-state=deciding] #abort,[data-state=discussing] #abort,[data-state=developing] #abort,[data-state=closed] #abort{display:none}
#abortNo{border:0;background:none;padding:4px 6px;font:500 11px var(--font-ui);letter-spacing:.04em;text-transform:uppercase;color:var(--text)}#abortNo:hover{background:var(--surface-2)}#abortNo[hidden]{display:none}
#abort{white-space:nowrap;border:0;background:none;padding:4px 6px;font:500 11px var(--font-ui);letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}#abort:hover{background:var(--surface-2);color:var(--text)}#abort.sure{color:var(--fail-text);box-shadow:${ring('2px', 'var(--fail)')}}#abort:disabled{color:var(--muted);cursor:default;background:none;box-shadow:none}
main{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px}
footer{position:relative}#down{display:none;position:absolute;right:16px;top:6px;width:34px;height:34px;place-items:center;padding:0;background:var(--surface);border:0;box-shadow:${ring('2px', 'var(--frame)')},3px 3px 0 var(--shadow);color:var(--text)}#down.on{display:grid}footer:has(#down.on) #status{min-height:46px;padding-right:46px}#down:hover{background:var(--surface-2)}#down svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:square;stroke-linejoin:miter}#down.new::after{content:"";position:absolute;top:3px;right:3px;width:6px;height:6px;background:var(--primary)}
.message{white-space:pre-wrap;overflow-wrap:anywhere}
.about{display:block;font:11px/1.4 var(--font-mono);color:var(--muted);margin-bottom:2px;overflow-wrap:anywhere}
.human,.checkpoint{align-self:flex-end;max-width:88%;background:var(--surface-2);padding:8px 12px;box-shadow:${ring('2px', 'var(--shadow)')}}
.checkpoint::before{content:${JSON.stringify(t('chat.page.checkpoint'))};display:block;font:500 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--primary-text)}
.claude{padding:0 2px}
.question{background:var(--surface-2);padding:11px 13px;box-shadow:0 -3px 0 var(--primary),0 2px 0 var(--shadow),-2px 0 0 var(--shadow),2px 0 0 var(--shadow)}
.plan,.advice{padding:12px 14px 13px;background:var(--surface);box-shadow:0 -4px 0 var(--primary),0 2px 0 var(--frame),-2px 0 0 var(--frame),2px 0 0 var(--frame),4px 4px 0 var(--shadow)}
.plan strong,.advice strong,.failure strong{display:block;font:500 12px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--primary-text);margin-bottom:6px}
.plan .notes{color:var(--muted);font-size:14px;margin-bottom:6px}.step{padding:9px 0;border-top:2px dashed var(--line)}.step:first-of-type{border-top:0}.step .head{display:flex;gap:8px;align-items:baseline;font-weight:600}.step .sid{flex:none;font:500 11px var(--font-ui);color:var(--primary-text)}.step dl{margin:4px 0 0;display:grid;gap:4px}.step dt{font:500 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.step dd{margin:0}.step .changed{box-shadow:inset 3px 0 0 var(--pending);padding-left:9px}.step .changed dt::after{content:${JSON.stringify(t('chat.page.changed'))};color:var(--fail-text)}.step .before{color:var(--muted);text-decoration:line-through}
.failure{padding:12px 14px 13px;background:var(--fail-tint);box-shadow:0 -4px 0 var(--fail),0 2px 0 var(--fail-line),-2px 0 0 var(--fail-line),2px 0 0 var(--fail-line)}.failure strong{color:var(--fail-text)}.failure .reason{margin:0 0 9px;font-size:16px;line-height:1.4;overflow-wrap:anywhere}
.failure .badge{display:inline-block;margin:0 0 9px;padding:3px 9px;font-size:14px;background:var(--surface);color:var(--muted);box-shadow:${ring('2px', 'currentColor')}}.failure .badge.app{color:var(--fail-text)}.failure .badge.environment{color:var(--warn)}.failure .badge.test{color:var(--primary-text)}
.decision{padding:12px 14px 13px;background:var(--surface);box-shadow:0 -4px 0 var(--ok),0 2px 0 var(--frame),-2px 0 0 var(--frame),2px 0 0 var(--frame),4px 4px 0 var(--shadow)}.decision strong{display:block;font:500 12px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--ok-text);margin-bottom:6px}
.decision ul{margin:0 0 8px;padding-left:18px;display:grid;gap:4px;font-size:14px;overflow-wrap:anywhere}.decision details{margin:0 0 6px}.decision summary{cursor:pointer;font-size:14px;font-weight:600}.decision details ul{margin:4px 0 0;color:var(--muted)}.decision .next{margin:6px 0 0;font-size:14px;font-weight:600}
.failure .warn,.advice .warn,.decision .warn{margin:0 0 9px;padding:6px 9px;font-size:13.5px;color:var(--fail-text);background:var(--surface);box-shadow:inset 3px 0 0 var(--fail)}
.failure details{margin:0 0 6px}.failure summary{cursor:pointer;font-size:14px;font-weight:600}.failure ul{margin:4px 0 0;padding-left:18px;display:grid;gap:4px;font-size:14px;color:var(--muted);overflow-wrap:anywhere}.failure .next{margin:6px 0 0;font-size:13px;color:var(--subtle)}
.advice{box-shadow:0 -4px 0 var(--pending),0 2px 0 var(--frame),-2px 0 0 var(--frame),2px 0 0 var(--frame),4px 4px 0 var(--shadow)}.advice.app{box-shadow:0 -4px 0 var(--primary),0 2px 0 var(--frame),-2px 0 0 var(--frame),2px 0 0 var(--frame),4px 4px 0 var(--shadow)}.advice strong{color:var(--muted)}.advice.app strong{color:var(--primary-text)}
.advice h2{margin:0 0 4px;font-size:16px;font-weight:600}.advice .target{font:12px var(--font-mono);color:var(--muted);margin-bottom:6px;overflow-wrap:anywhere}.advice .reason{margin:0 0 8px}.advice dl{margin:0;display:grid;gap:6px}.advice dt{font:500 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.advice dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.advice .before{color:var(--muted);text-decoration:line-through}
.advice pre{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-2);padding:8px 10px;font:12px/1.45 var(--font-mono);box-shadow:${ring('2px', 'var(--shadow)')}}.advice pre.del{text-decoration:line-through;color:var(--muted);margin-bottom:6px}
.advice .copy{margin-top:8px;padding:6px 10px;font:500 11px var(--font-ui);letter-spacing:.04em;background:var(--surface);border:0;box-shadow:${ring('2px', 'var(--frame)')}}.advice .copy:hover{background:var(--surface-2)}
details.activity{font-size:13px;color:var(--muted)}
details.activity summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;padding:2px 0;user-select:none;font:12px var(--font-mono)}
details.activity summary::-webkit-details-marker{display:none}
details.activity summary::before{content:"";flex:none;width:6px;height:8px;background:currentColor;clip-path:polygon(0 0,100% 50%,0 100%)}
details.activity[open] summary::before{width:8px;height:6px;clip-path:polygon(0 0,100% 0,50% 100%)}
details.activity .latest{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
details.activity ol{list-style:none;margin:8px 0 2px 2px;padding:0 0 0 12px;box-shadow:inset 2px 0 0 var(--line);display:flex;flex-direction:column;gap:3px}
details.activity li{font:12px/1.45 var(--font-mono);overflow-wrap:anywhere}
#thinking{display:none;gap:5px;padding:2px 0}[data-state=running] #thinking,[data-state=advising] #thinking{display:flex}
#thinking i{width:6px;height:6px;background:var(--primary-text);animation:blink 1.2s steps(1,end) infinite}#thinking i:nth-child(2){animation-delay:.2s}#thinking i:nth-child(3){animation-delay:.4s}
footer{padding:0 16px 16px}
#status{padding:8px 2px;font-size:13px;line-height:1.45;color:var(--subtle)}
[data-state=paused] #status,[data-state=asking] #status,[data-state=showing] #status,[data-state=planning] #status{color:var(--text)}
#choices{display:none;flex-direction:column;gap:12px;padding:4px 4px 14px 2px}[data-state=choosing] #choices,[data-state=deciding] #choices,[data-state=reviewing] #choices,[data-state=discussing] #choices,[data-state=developing] #choices,[data-state=planning] #choices{display:flex}
#choices button.big{min-height:58px;font-size:14px;letter-spacing:.06em;text-transform:uppercase}[data-state=planning] #toggle{display:none}
/* Beim Fehler, bei Entscheidung und Empfehlung braucht die Karte den Platz: Knoepfe kompakt, die nachrangigen nebeneinander. */
#choices .rest{display:flex;flex-wrap:wrap;gap:12px}#choices .rest button{flex:1 1 auto;min-width:96px}
:is([data-state=discussing],[data-state=deciding],[data-state=reviewing]) #choices{gap:6px;padding-bottom:10px}:is([data-state=discussing],[data-state=deciding],[data-state=reviewing]) #choices .rest{gap:6px}
:is([data-state=discussing],[data-state=deciding],[data-state=reviewing]) #choices button{min-height:34px;padding:7px 10px}
#choices button.sure{color:var(--fail-text);box-shadow:${ring('2px', 'var(--fail)')},4px 4px 0 var(--shadow)}#choices .no{flex:0 0 auto;min-width:0}
kbd{display:inline-block;margin-left:6px;padding:0 4px;font:500 10px/16px var(--font-ui);letter-spacing:0;text-transform:none;opacity:.75;box-shadow:inset 0 0 0 1px currentColor}
#next{display:none;margin:2px 2px 14px;padding:12px 14px;background:var(--surface-2);box-shadow:${ring('2px', 'var(--frame)')}}[data-state=closed] #next.on{display:block}[data-state=closed]:has(#next.on) #form{display:none}
#next strong{display:block;font:500 12px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}#next p{margin:0 0 10px;font-size:13px;color:var(--muted)}#next code{font:12px var(--font-mono);overflow-wrap:anywhere}#next .cmd{margin:12px 0 0}
#next .acts{display:flex;flex-wrap:wrap;gap:10px}
#report,#closeWindow{min-height:40px;padding:9px 14px;font:500 12px var(--font-ui);letter-spacing:.04em;text-transform:uppercase;border:0;background:var(--primary);color:var(--primary-ink);box-shadow:${ring('2px', 'var(--frame)')},4px 4px 0 var(--shadow)}#report:hover,#closeWindow:hover{background:var(--primary-hover)}#report:active,#closeWindow:active{transform:translate(2px,2px);box-shadow:${ring('2px', 'var(--frame)')}}
#closeWindow[hidden]{display:none}#next:has(#closeWindow:not([hidden])) #report{background:var(--surface);color:var(--text)}#next:has(#closeWindow:not([hidden])) #report:hover{background:var(--surface-2)}
#choices button{min-height:44px;padding:11px 14px;font:500 12px/1.3 var(--font-ui);letter-spacing:.04em;text-align:center;color:var(--text);background:var(--surface);border:0;box-shadow:${ring('2px', 'var(--frame)')},4px 4px 0 var(--shadow)}
#choices button:hover{background:var(--surface-2)}#choices button:active{transform:translate(2px,2px);box-shadow:${ring('2px', 'var(--frame)')}}
#choices button.primary{background:var(--primary);color:var(--primary-ink)}#choices button.primary:hover{background:var(--primary-hover)}
#choices button:disabled{cursor:progress;opacity:.55;transform:none}#choices button.busy{opacity:1}#choices button.busy::before{margin-right:22px}
[data-state=handing] form,[data-state=choosing] form,[data-state=deciding] form,[data-state=reviewing] form,[data-state=verifying] form,[data-state=testing] form,[data-state=preparing] form,[data-state=advising] form{display:none}
form{margin:2px;padding:10px;background:var(--surface-2);box-shadow:${ring('2px', 'var(--shadow)')}}
form:focus-within{box-shadow:${ring('2px', 'var(--primary-text)')}}
#chip{display:none;align-items:center;gap:6px;max-width:100%;margin-bottom:8px;padding:3px 4px 3px 8px;background:var(--surface);color:var(--primary-text);font:12px var(--font-mono);box-shadow:${ring('2px', 'var(--primary-text)')}}#chip.on{display:inline-flex}#chipText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#chipRemove{border:0;background:none;padding:0 4px;font-size:14px;line-height:1;color:inherit}
.small{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;font:500 11px var(--font-ui);letter-spacing:.04em;background:var(--surface);border:0;box-shadow:${ring('2px', 'var(--frame)')}}
.small:hover:enabled{background:var(--surface-2)}.small:disabled{opacity:.45;cursor:default}.small svg{width:14px;height:14px}
#pick svg{fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:square}#pick.on{color:var(--primary-text);box-shadow:${ring('2px', 'var(--primary-text)')}}
.left{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;min-width:0}
textarea{display:block;width:100%;min-height:24px;max-height:160px;resize:none;border:0;outline:0;padding:0 2px;font:inherit;color:inherit;background:transparent;overflow-y:hidden;scrollbar-width:thin}textarea.full{overflow-y:auto}
textarea::placeholder{color:var(--muted)}
.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
button{font:inherit;cursor:pointer;color:inherit;border-radius:0}
[data-state=paused] #toggle,[data-state=asking] #toggle,[data-state=showing] #toggle,[data-state=planning] #toggle{background:var(--primary);color:var(--primary-ink)}
#toggle{white-space:nowrap}#toggle svg{width:12px;height:12px;fill:currentColor}#toggle .play{display:none}
[data-state=paused] #toggle .play,[data-state=asking] #toggle .play,[data-state=showing] #toggle .play,[data-state=planning] #toggle .play{display:block}
[data-state=paused] #toggle .pause,[data-state=asking] #toggle .pause,[data-state=showing] #toggle .pause,[data-state=planning] #toggle .pause{display:none}
/* Die Vorfuehrung endet mit Stopp wie eine Aufnahme, nicht mit Weiter. */
#toggle .stop{display:none}[data-state=showing] #toggle .stop{display:block}[data-state=showing] #toggle .play{display:none}
.actions{display:flex;align-items:center;gap:10px}#mark{display:none}[data-state=showing] #mark{display:inline-flex}
#send{width:30px;padding:0;justify-content:center;background:var(--primary);color:var(--primary-ink)}#send:hover:enabled{background:var(--primary-hover)}#send svg{fill:none;stroke:currentColor;stroke-width:2.8;stroke-linecap:square;stroke-linejoin:miter}
:focus-visible{outline:3px dashed var(--primary-text);outline-offset:3px}textarea:focus-visible{outline:0}
[data-state=closed] form,.stopping form,.stopping #choices{opacity:.55;pointer-events:none}
@keyframes blink{50%{opacity:.25}}
@keyframes pxload{0%{background:var(--primary);box-shadow:6px 0 var(--muted),12px 0 var(--muted)}33%{background:var(--muted);box-shadow:6px 0 var(--primary),12px 0 var(--muted)}66%{background:var(--muted);box-shadow:6px 0 var(--muted),12px 0 var(--primary)}}
.loader,[data-state=handing] #status::before,#toggle.busy::before,#choices button.busy::before{content:"";display:inline-block;flex:none;width:4px;height:4px;margin-right:20px;vertical-align:middle;background:var(--primary);box-shadow:6px 0 var(--muted),12px 0 var(--muted);animation:pxload .9s steps(1,end) infinite}
#toggle.busy svg{display:none!important}#toggle.busy{cursor:progress}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style></head><body data-state="running">
<header><h1>Chat<span class="who"> · Claude</span></h1><span id="pill"><span id="dot"></span><span id="label"></span></span><button id="abortNo" type="button" hidden>${t('chat.page.no')}</button><button id="abort" type="button" title="${t('chat.page.abortTitle')}">${t('chat.page.abort')}</button></header>
<main id="messages" role="log" aria-live="polite"><div id="thinking" aria-hidden="true"><i></i><i></i><i></i></div></main>
<footer><button id="down" type="button" aria-label="${t('chat.page.scrollDown')}" title="${t('chat.page.scrollDown')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg></button><div id="status" role="status" aria-live="polite"></div><div id="choices"></div><div id="next" role="region" aria-label="${t('chat.page.nextStep')}"><strong>${t('chat.page.nextStep')}</strong><p id="nextText"></p><div class="acts"><button id="closeWindow" type="button" hidden></button><button id="report" type="button">${t('chat.page.openReport')}</button></div><p class="cmd" id="nextCmd"></p></div><form id="form"><div id="chip"><span id="chipText"></span><button id="chipRemove" type="button" aria-label="${t('chat.page.removeElement')}">×</button></div><textarea id="input" rows="1" aria-label="${t('chat.page.inputLabel')}" placeholder="${t('chat.page.placeholder')}"></textarea>
<div class="row"><div class="left"><button id="toggle" class="small" type="button"><svg class="pause" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1" width="3" height="10"/><rect x="7" y="1" width="3" height="10"/></svg><svg class="play" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1h2v1h2v1h2v1h2v4H9v1H7v1H5v1H3z"/></svg><svg class="stop" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8"/></svg><span id="toggleText"></span><kbd class="key" aria-hidden="true"></kbd></button><button id="pick" class="small" type="button" disabled title="${t('chat.page.pickDisabled')}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>${t('chat.page.element')}</button></div>
<div class="actions"><button id="mark" class="small" type="button" disabled title="${t('chat.page.markCheckpointTitle')}">${t('chat.page.markCheckpoint')}</button><button id="send" class="small" type="submit" aria-label="${t('chat.page.send')}" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></div></div></form></footer>
<script>
const T=${JSON.stringify(texts('chat.page.'))};
const fill=(key,vars)=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),T[key]);
const send=(type,text,checkpoint)=>window.${BINDING}({type,text,checkpoint,nonce:${JSON.stringify(nonce)}});
const input=document.getElementById('input'),messages=document.getElementById('messages'),thinking=document.getElementById('thinking'),abort=document.getElementById('abort'),sendButton=document.getElementById('send'),mark=document.getElementById('mark');
// Die Hoehe folgt dem Text, leer dem Platzhalter: Der bricht in einem schmalen Chat um und waere sonst abgeschnitten.
// Eine Scrollleiste gibt es erst ab der Hoechsthoehe.
const fit=()=>{input.style.height='auto';let height=input.scrollHeight;if(input.value===''&&input.placeholder){input.value=input.placeholder;height=input.scrollHeight;input.value='';}
  input.style.height=height+'px';input.classList.toggle('full',height>=160);sendButton.disabled=mark.disabled=input.value.trim()==='';};
addEventListener('resize',fit);
const submit=(checkpoint=false)=>{if(input.value.trim()==='')return;send('message',input.value,checkpoint);input.value='';fit();input.focus();};
mark.addEventListener('click',()=>submit(true));
input.addEventListener('input',fit);
document.getElementById('form').addEventListener('submit',(event)=>{event.preventDefault();submit();});
input.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit();}});
const toggleButton=document.getElementById('toggle');
toggleButton.addEventListener('click',()=>{if(toggleButton.disabled)return;toggleButton.disabled=true;toggleButton.classList.add('busy');toggleButton.setAttribute('aria-busy','true');document.getElementById('toggleText').textContent=T['chat.page.wait'];send('toggle');});
// F5 im Chat laedt nicht die Werkbank neu, sondern aktualisiert wie dort: Anwendung neu, Zustand wieder hergestellt.
addEventListener('keydown',(event)=>{if(event.key==='F5'||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='r')){event.preventDefault();parent.postMessage({caw:'refresh'},'*');}});
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
// Mitscrollen, solange der Mensch nicht selbst nach oben gescrollt hat. Gemessen wird beim Scrollen, nicht beim Einfuegen:
// Kommt viel auf einmal, etwa der Verlauf in einem neuen Fenster, stuende ein Scrollen sonst noch aus.
const down=document.getElementById('down');
const atEnd=()=>messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
let follow=true;
// Eine Karte (Fehler, Entscheidung, Empfehlung, Plan), die am Ende nicht ganz im Bild waere, zeigt ihren Anfang, nicht ihr Ende:
// Sonst stuende nur der untere Teil im Bild, sobald darunter die Knoepfe erscheinen. Der Anfang bleibt oben, bis eine neue Nachricht kommt.
let anchor=null;
const offsetOf=(element)=>element.getBoundingClientRect().top-messages.getBoundingClientRect().top;
const tall=()=>anchor!==null&&anchor.isConnected&&offsetOf(anchor)+messages.scrollTop-8<messages.scrollHeight-messages.clientHeight-1;
const pinned=()=>tall()&&Math.abs(offsetOf(anchor)-8)<16;
const toEnd=()=>{if(tall())messages.scrollTop+=offsetOf(anchor)-8;else messages.scrollTop=messages.scrollHeight;down.classList.toggle('on',!atEnd());};
messages.addEventListener('scroll',()=>{follow=atEnd()||pinned();down.classList.toggle('on',!atEnd());if(follow)down.classList.remove('new');});
down.addEventListener('click',()=>{follow=true;anchor=null;down.classList.remove('on','new');toEnd();});
const grown=()=>{if(follow)toEnd();else down.classList.add('on','new');};
// Werden die Knoepfe darunter groesser oder kleiner, schrumpft der Chat: Mitscrollen gilt dann weiter.
if(window.ResizeObserver)new ResizeObserver(()=>{if(follow)toEnd();}).observe(messages);
// Eine neue Karte will entschieden werden: Sie kommt ins Bild, auch wenn der Mensch gerade weiter oben liest.
const place=(element,top=false)=>{messages.insertBefore(element,thinking);anchor=top?element:null;if(top){follow=true;down.classList.remove('new');}grown();};
let group=null;
window.addMessage=(who,text,about)=>{
  if(who==='activity'){
    // Beim Vorfuehren zeigt die offene Liste, dass jeder Klick ankommt.
    if(group===null){const details=document.createElement('details');details.className='activity';if(document.body.dataset.state==='showing')details.open=true;details.setAttribute('aria-live','off');const summary=document.createElement('summary');const count=document.createElement('span');const latest=document.createElement('span');latest.className='latest';summary.append(count,latest);const list=document.createElement('ol');details.append(summary,list);group={details,count,latest,list,total:0};place(details);}
    const item=document.createElement('li');item.textContent=text;group.list.append(item);group.total+=1;group.count.textContent=group.total===1?T['chat.page.oneAction']:fill('chat.page.actions',{n:group.total});group.latest.textContent=text;
    if(follow)toEnd();
    return;
  }
  if(who==='plan'){
    group=null;const card=document.createElement('div');card.className='message plan';const part=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;node.textContent=value;return node;};
    card.append(part('strong','',about.title||(about.repairing?T['chat.page.repairStep']:T['chat.page.plan'])));if(about.notes)card.append(part('div','notes',about.notes));
    for(const step of about.steps){const box=document.createElement('section');box.className='step';const head=document.createElement('div');head.className='head';head.append(part('span','sid',step.id),part('span','',step.name));const facts=document.createElement('dl');
      const fact=(label,value,changed,before)=>{const row=document.createElement('div');if(changed)row.className='changed';row.append(part('dt','',label));if(before)row.append(part('dd','before',before));row.append(part('dd','',value));facts.append(row);};
      if(step.do)fact(T['chat.page.do'],step.do);fact(T['chat.page.expect'],step.expect,step.previousExpect!==undefined,step.previousExpect);if(step.note)fact(T['chat.page.note'],step.note);if(step.retry)fact(T['chat.page.retry'],fill('chat.page.retryText',{times:step.retry.times,from:step.retry.from||step.id}));box.append(head,facts);card.append(box);}
    place(card,true);return;
  }
  if(who==='failure'){
    group=null;const card=document.createElement('div');card.className='message question failure'+(about.diagnosis?' '+about.diagnosis.side:'');const part=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;node.textContent=value;return node;};
    card.append(part('strong','',fill('chat.page.failed',{id:about.id})),part('p','reason',about.reason));
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
    card.append(part('strong','',about.title));
    if(about.facts&&about.facts.length>0){const ul=document.createElement('ul');for(const text of about.facts)ul.append(part('li','',text));card.append(ul);}
    if(about.warn)card.append(part('div','warn',about.warn));
    for(const section of about.details??[]){if(!section.items||section.items.length===0)continue;const details=document.createElement('details');details.append(part('summary','',section.title+' ('+section.items.length+')'));const ul=document.createElement('ul');for(const text of section.items)ul.append(part('li','',text));details.append(ul);card.append(details);}
    if(about.question)card.append(part('p','next',about.question));
    place(card,true);return;
  }
  if(who==='advice'){
    group=null;const card=document.createElement('div');card.className='message advice '+about.side;const part=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;node.textContent=value;return node;};
    card.append(part('strong','',about.side==='app'?T['chat.page.adviceApp']:T['chat.page.adviceTest']),part('h2','',about.title));if(about.target)card.append(part('div','target',about.target));if(about.about)card.append(part('div','target',fill('chat.page.about',{about:about.about})));card.append(part('p','reason',about.reason));
    if(about.evidence)card.append(part('div','target',fill('chat.page.evidence',{evidence:about.evidence})));
    if(about.contradicts)card.append(part('div','warn',T['chat.page.contradicts']));
    if(about.edits){const facts=document.createElement('dl');for(const edit of about.edits){facts.append(part('dt','',edit.file+(edit.line?':'+edit.line:'')+(edit.why?' · '+edit.why:'')),part('dd','',''));const last=facts.lastChild;last.append(part('pre','del',edit.find),part('pre','',edit.replace));}card.append(facts);}
    if(about.changes){const facts=document.createElement('dl');for(const change of about.changes){facts.append(part('dt','',change.label));if(change.before)facts.append(part('dd','before',change.before));facts.append(part('dd','',change.after));}card.append(facts);}
    if(about.prompt){const pre=part('pre','',about.prompt);const copy=part('button','copy',T['chat.page.copyPrompt']);copy.type='button';
      copy.addEventListener('click',async()=>{let done=false;try{await navigator.clipboard.writeText(about.prompt);done=true;}catch{}if(!done){const range=document.createRange();range.selectNodeContents(pre);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);try{done=document.execCommand('copy');}catch{}}copy.textContent=done?T['chat.page.copied']:T['chat.page.copyManual'];});
      card.append(pre,copy);}
    place(card,true);return;
  }
  group=null;const item=document.createElement('div');item.className='message '+who;if(about){const ref=document.createElement('span');ref.className='about';ref.textContent=about;item.append(ref);}item.append(text);place(item);
};
const choices=document.getElementById('choices');
// Nach einem Klick sind alle Knoepfe gesperrt, der gewaehlte zeigt, dass es weitergeht: kein Doppelklick, keine zweite Wahl.
// Kommen keine neuen Knoepfe (die Wahl war schon ueberholt), gibt die Sperre sie nach 8 s wieder frei.
let unlock=0;
const lockChoices=(chosen)=>{for(const button of choices.querySelectorAll('button')){button.disabled=true;button.setAttribute('aria-disabled','true');}chosen.classList.add('busy');chosen.setAttribute('aria-busy','true');
  clearTimeout(unlock);const current=choices.firstElementChild;unlock=setTimeout(()=>{if(choices.firstElementChild!==current)return;for(const button of choices.querySelectorAll('button')){button.disabled=false;button.removeAttribute('aria-disabled');button.classList.remove('busy');button.removeAttribute('aria-busy');}},8000);};const hint=input.placeholder;
// Der Knopf, den Strg+Enter ausloest, zeigt das auch.
const KEY=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘↵':T['chat.page.ctrlEnter'];toggleButton.querySelector('.key').textContent=KEY;
// Nach dem Lauf: Bericht und wie es weitergeht.
window.setNext=(info)=>{const box=document.getElementById('next');box.classList.toggle('on',!!info);if(!info)return;document.getElementById('nextText').textContent=info.text;const cmd=document.getElementById('nextCmd');cmd.replaceChildren();if(info.command){const code=document.createElement('code');code.textContent=info.command;cmd.append(T['chat.page.newRun'],code);}};
document.getElementById('report').addEventListener('click',()=>send('report',document.documentElement.dataset.theme??''));
// Nach der letzten Entscheidung bleibt das Fenster kurz offen: Der Mensch sieht das Ergebnis und schliesst selbst, sonst nach Ablauf.
const closeWindow=document.getElementById('closeWindow');let lingerTimer=0;
closeWindow.addEventListener('click',()=>{clearInterval(lingerTimer);closeWindow.disabled=true;send('close');});
window.linger=(seconds)=>{let left=seconds;const paint=()=>{closeWindow.textContent=fill('chat.page.closeIn',{n:left});};closeWindow.hidden=false;closeWindow.disabled=false;paint();closeWindow.focus({preventScroll:true});clearInterval(lingerTimer);lingerTimer=setInterval(()=>{left=Math.max(0,left-1);paint();if(left===0)clearInterval(lingerTimer);},1000);};
// Eine Wahl, die etwas verwirft, will ein zweites Mal geklickt werden, wie Abbrechen im Kopf.
const confirmFirst=(choice,option)=>{if(choice.classList.contains('sure'))return false;choice.classList.add('sure');choice.textContent=option.confirm;const no=document.createElement('button');no.type='button';no.className='no';no.textContent=T['chat.page.no'];
  let timer=0;const reset=()=>{clearTimeout(timer);choice.classList.remove('sure');choice.textContent=option.label;no.remove();};no.addEventListener('click',()=>{reset();choice.focus();});choice.after(no);timer=setTimeout(reset,4000);choice.disarm=()=>{clearTimeout(timer);no.remove();};return true;};
const COMPACT=['discussing','deciding','reviewing'];
window.setStatus=(state,text,label,button,options)=>{document.body.dataset.state=state;toggleButton.disabled=false;toggleButton.classList.remove('busy');toggleButton.removeAttribute('aria-busy');if(!stopping){statusText=text;statusBox.textContent=text;}input.placeholder=state==='planning'?T['chat.page.planPlaceholder']:state==='showing'?T['chat.page.showPlaceholder']:hint;fit();
if(state==='showing'&&group)group.details.open=true;
const list=state==='planning'&&!(options?.length)?[{id:'approve',label:T['chat.page.approvePlan'],primary:true,big:true}]:options??[];
const buttons=list.map((option)=>{const choice=document.createElement('button');choice.type='button';choice.textContent=option.label;if(option.primary)choice.className=option.big?'primary big':'primary';if(option.big){choice.id='approve';const key=document.createElement('kbd');key.setAttribute('aria-hidden','true');key.textContent=KEY;choice.append(key);}
  choice.addEventListener('click',()=>{if(choice.disabled)return;if(option.confirm&&confirmFirst(choice,option))return;choice.disarm?.();lockChoices(choice);if(option.id==='approve'&&state==='planning')send('toggle');else send('choose',option.id);});return choice;});
// Kompakt: die Hauptwahl oben, alle anderen nebeneinander in einer Zeile.
const primary=buttons.filter((choice)=>choice.classList.contains('primary')),rest=buttons.filter((choice)=>!choice.classList.contains('primary'));
if(COMPACT.includes(state)&&rest.length>1){const row=document.createElement('div');row.className='rest';row.append(...rest);choices.replaceChildren(...primary,row);}else choices.replaceChildren(...buttons);
// Neue Knoepfe bekommen den Fokus, damit Tastatur und Screenreader dort weitermachen; wer gerade tippt, behaelt das Feld.
if(buttons.length>0&&document.activeElement!==input)(choices.querySelector('.primary')??choices.querySelector('button')).focus({preventScroll:true});
const allowed=["paused","asking","showing","planning","discussing","developing"].includes(state);pick.disabled=!allowed;pick.title=allowed?T['chat.page.pickTitle']:T['chat.page.pickDisabled'];if(!allowed)window.setChip(null);document.getElementById('label').textContent=label;document.getElementById('toggleText').textContent=button;};
input.focus();
// Kurzbefehle: Strg+Enter (Cmd+Enter) loest den Hauptknopf aus, etwa Freigeben oder Fertig. Esc leert zuerst das Feld, in dem
// getippt wird; sonst fragt das erste Esc den Abbruch an, erst ein zweites innerhalb von 4 s bestaetigt ihn.
document.addEventListener('keydown',(event)=>{
  if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&input.value.trim()===''){const main=document.getElementById('approve');if(main&&main.offsetParent!==null&&!main.disabled){event.preventDefault();main.click();}else if(toggleButton.offsetParent!==null&&!toggleButton.disabled){event.preventDefault();toggleButton.click();}}
  else if(event.key==='Escape'&&!pick.classList.contains('on')){
    if(document.activeElement===input&&input.value!==''){event.preventDefault();input.value='';fit();return;}
    if(abort.offsetParent!==null&&!abort.disabled){event.preventDefault();abort.click();}}
});
${sourceTag}</script></body></html>`;

/**
 * Verbindet den Chat-Frame der Werkbank mit dem Gespraech. Einen Chat ohne Werkbank gibt es nicht.
 * @param logPath     Mitschrift im Lauf-Ordner, ohne Claudes Log und Aktionen: Die stehen in claude.log
 * @param transcript  Der bisherige Verlauf, wandert mit: Vorfuehrung, Claude und Pruefdurchlauf sind getrennte Browser
 * @param onOpen      Nur fuer Tests: bekommt den Chat-Frame
 * @param onWaiting   bekommt eine Zeile fuers Terminal, sobald der Chat auf den Menschen wartet: einmal je solchem Zustand
 */
export const openChat = async ({ session, logPath, onAbort, onOpen, onWaiting, transcript = [] }) => {
    // `doc()` ist das Dokument des Chats, der Frame in der Werkbank (nach einem Neuladen ein neuer); `chatWindow` die Werkbank drumherum.
    const bench = session.workbench ?? null;
    if (bench === null) throw new CawError('chat-failed', t('chat.error.noWorkbench'));
    if (bench.chatOpen) throw new CawError('chat-failed', t('chat.error.alreadyOpen'));
    bench.chatOpen = true;
    const doc = () => bench.chatFrame();
    const chatWindow = bench.page;
    const quiet = (promise) => promise.catch(() => {});
    let picking = false;
    let onPicked = null;
    // Kennung der zuletzt geschriebenen Chat-Seite, neu bei jedem show().
    let nonce = null;
    let current = ['running', null];
    // Der Zustand, fuer den das Terminal zuletzt gemeldet hat, dass das Fenster wartet.
    let waitingFor = null;
    // Der Mensch schliesst das Fenster nach dem Lauf selbst (linger).
    let closeWanted = null;
    // Nach dem Lauf: { report: absoluter Pfad, shown: Pfad fuer Menschen, text, command }.
    let next = null;
    const openReport = async (theme) => {
        const page = await chatWindow.context().newPage();
        await page.setContent(reportPage({ markdown: readFileSync(next.report, 'utf8'), path: next.shown ?? next.report, theme }));
        await page.bringToFront();
    };
    const render = (state, options) => {
        current = [state, options ?? null];
        const { text, label, button } = status(state);
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
            // Wer im Terminal wartet, sieht dort, dass das Fenster auf ihn wartet. Erneutes Melden desselben Zustands zaehlt nicht.
            if (NEEDS_HUMAN.includes(state) && state !== waitingFor) {
                waitingFor = state;
                onWaiting?.(t('chat.waiting', { status: status(state).text }));
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
        // In der Werkbank sieht jeder Frame das Binding, auch die Anwendung. Sie darf nie als Mensch sprechen.
        // Die Anwendung teilt sich den Ursprung mit der Werkbank und kann das iframe des Chats neu laden (srcdoc, location). Der Frame bleibt
        // dann derselbe, das Binding auch. Nur die Seite, die der Host zuletzt geschrieben hat, kennt die Kennung; der Chat hat einen
        // undurchsichtigen Ursprung, die Anwendung kann sie nicht lesen.
        if (bench !== null && (source.frame !== doc() || event?.nonce !== nonce)) return;
        if (event?.type === 'message') {
            chat.human.message(event.text, { checkpoint: event.checkpoint === true });
            // Der Rabe nickt: angekommen.
            if (String(event.text ?? '').trim() !== '') bench.nod?.().catch?.(() => {});
            quiet(doc().evaluate(() => window.setChip(null)));
        } else if (event?.type === 'pick') quiet(pick());
        else if (event?.type === 'unpick') chat.detach();
        else if (event?.type === 'toggle') chat.human.toggle();
        else if (event?.type === 'choose') chat.human.choose(event.text);
        else if (event?.type === 'abort') chat.human.abort();
        else if (event?.type === 'report' && next !== null) quiet(openReport(event.text));
        else if (event?.type === 'close') closeWanted?.();
    });
    /** Beim Entwickeln: Wer ein mit dem Fadenkreuz gewaehltes Element zusaetzlich bekommt (die Claude-Code-Sitzung). null: niemand. */
    chat.onPicked = (handler) => { onPicked = handler ?? null; };
    const show = async () => {
        nonce = randomBytes(16).toString('hex');
        await doc().setContent(chatPage(nonce));
        await doc().evaluate((entries) => entries.forEach((entry) => window.addMessage(...entry)), transcript);
        if (next !== null) await doc().evaluate((info) => window.setNext(info), next);
    };
    /** Der Lauf ist vorbei: Die Karte zeigt den Bericht und den Befehl fuer einen neuen Lauf. */
    chat.finished = async (info) => {
        next = info;
        await quiet(doc().evaluate((value) => window.setNext(value), info));
    };
    /**
     * Nach dem Lauf, nach finished und dem Schliessen des Gespraechs: Das Fenster bleibt mit „Fenster schließen“ und Countdown offen.
     * @returns sobald der Mensch schliesst oder die Zeit um ist
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
    // Die Werkbank wurde neu geladen: Verlauf und Stand kommen zurueck. Lief gerade der Test, ist er nicht mehr verlaesslich.
    // Beim Vorfuehren gehoert das Neuladen zum gezeigten Weg und landet als Hinweis in der Aufnahme.
    bench.onReload?.(async ({ human = true } = {}) => {
        if (!chat.available()) return;
        await show();
        await render(...current);
        // Die Anwendung hat das oberste Fenster selbst navigiert: Das ist ihr Verhalten, der Lauf geht weiter.
        if (!human || current[0] === 'developing') return;
        if (SHOWING_STATES.includes(current[0])) {
            chat.notice(t('chat.reload.showing'));
            return;
        }
        chat.notice(t('chat.reload.testing'));
        chat.human.abort();
    });
    // Ohne den Chat gibt es keine Freigabe und keine Entscheidung mehr. Wer ihn schliesst, bricht ab.
    chatWindow.on('close', () => {
        if (!chat.available()) return;
        chat.human.closed();
        onAbort?.();
    });
    await onOpen?.(doc());
    return chat;
};
