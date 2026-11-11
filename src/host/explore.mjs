// `caw-ai explore --url <adresse>`: oeffnet die Anwendung einmal, der Mensch meldet sich an, und das Tool leitet ab, was die Config
// braucht: Framework, Anmeldeformular, woran man „angemeldet“ erkennt, Startseite, Meldungen und Rauschen in der Konsole. Es schreibt
// nur Vorschlaege nach caw/.explore.json, nie die Config; die uebernimmt `init --from` oder der Skill nach Rueckfragen.
// Ohne Claude und ohne Token. Der Browser erreicht nur den Host der Adresse.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { askYesNo, createUi } from '../shared/ui.mjs';
import { DONE_BINDING, PHASE_BINDING, PHASE_EVENT, exploreCardScript } from './explore-card.mjs';
import { isLoopback } from '../shared/config.mjs';
import { optionValue } from './linux.mjs';

export const EXPLORE_FILE = 'caw/.explore.json';
const MAX_MARKERS = 600;
const SETTLE_MS = 10_000;
const ui = createUi();

/**
 * Laeuft in der Seite: Felder, Knoepfe, stabile Selektoren und Meldungscontainer, ohne Werte von Feldern. Nur CSS-Selektoren, die
 * genau ein Element treffen und nicht nach erzeugten Kennungen aussehen.
 */
export const surveyPage = (maxMarkers) => {
    // Erzeugte Kennungen wechseln mit jedem Rendern oder Build: React useId (:r1:, «r1», _r_1_), Radix, Headless UI, MUI, ExtJS, Ember …
    const generated = (value) => /\d{3,}|:r[\w]*:|«r\w*»|^_r_\w*_$|^ext-|^ember|^[a-f0-9-]{8,}$|^mat-|^cdk-|^ng-|^react-|^radix-|^headlessui-|^mui-\d|^v-\d/i.test(value);
    const unique = (selector) => {
        try {
            return document.querySelectorAll(selector).length === 1;
        } catch {
            return false;
        }
    };
    const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    const selectorOf = (el) => {
        const tag = el.tagName.toLowerCase();
        for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
            const value = el.getAttribute(attr);
            if (value && unique(`[${attr}=${quote(value)}]`)) return `[${attr}=${quote(value)}]`;
        }
        if (el.id && !generated(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
        const name = el.getAttribute('name');
        if (name && !generated(name) && unique(`${tag}[name=${quote(name)}]`)) return `${tag}[name=${quote(name)}]`;
        const aria = el.getAttribute('aria-label');
        if (aria && unique(`${tag}[aria-label=${quote(aria)}]`)) return `${tag}[aria-label=${quote(aria)}]`;
        return null;
    };
    const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (el) => (el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

    const passwords = [...document.querySelectorAll('input[type=password]')].filter(visible);
    let login = null;
    if (passwords.length > 0) {
        const password = passwords[0];
        const fields = [...document.querySelectorAll('input')].filter((el) => visible(el) && ['text', 'email', 'tel', ''].includes(el.type) && el !== password);
        // Das Feld fuer den Namen steht vor dem Passwort, meist direkt davor oder mit autocomplete=username.
        const before = fields.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
        const user = before.find((el) => el.autocomplete === 'username') ?? before.at(-1) ?? null;
        const scope = password.form ?? document;
        const submit = [...scope.querySelectorAll('button, input[type=submit]')].filter(visible)
            .find((el) => el.type === 'submit' || /anmelden|einloggen|login|log in|sign in|weiter|continue/i.test(textOf(el))) ?? null;
        login = {
            userSelector: user === null ? null : selectorOf(user),
            passwordSelector: selectorOf(password),
            submitSelector: submit === null ? null : selectorOf(submit),
            submitText: submit === null ? null : textOf(submit),
            // Ein echter Absendeknopf im Formular des Passworts: Enter im Passwortfeld sendet, ein Selektor waere nur eine Fehlerquelle.
            submitsWithEnter: password.form !== null && submit !== null && submit.type === 'submit' && submit.form === password.form,
        };
    }

    const markers = [];
    for (const el of document.querySelectorAll('body *')) {
        if (markers.length >= maxMarkers) break;
        if (['SCRIPT', 'STYLE', 'TEMPLATE', 'svg', 'path'].includes(el.tagName) || !visible(el)) continue;
        const selector = selectorOf(el);
        if (selector !== null) markers.push({ selector, tag: el.tagName.toLowerCase(), text: textOf(el), role: el.getAttribute('role') ?? '' });
    }

    const messages = new Set();
    for (const el of document.querySelectorAll('[role=alert], [role=alertdialog], [role=status], [aria-live]')) {
        const role = el.getAttribute('role');
        messages.add(role === null ? `[aria-live=${quote(el.getAttribute('aria-live'))}]` : `[role=${role}]`);
    }
    for (const el of document.querySelectorAll('[class*=toast], [class*=snackbar], [class*=notification], [class*=Toastify]')) {
        // Knoepfe und Links, die Meldungen nur oeffnen oder zaehlen, sind selbst keine Meldung.
        if (el.matches('button, a, input, [role=button], [role=link]')) continue;
        const name = [...el.classList].find((cls) => /toast|snackbar|notification/i.test(cls) && !/toggle|btn|button|trigger|icon|badge|count/i.test(cls) && !generated(cls));
        if (name !== undefined) messages.add(`.${CSS.escape(name)}`);
    }

    const probe = (() => {
        if (window.Ext?.getVersion !== undefined) return 'extjs';
        if (document.querySelector('[ng-version]') !== null || window.getAllAngularTestabilities !== undefined) return 'angular';
        if (window.__VUE__ !== undefined || document.querySelector('[data-v-app]') !== null) return 'vue';
        const reactRoot = [...document.querySelectorAll('body > *, #root, #app')].some((el) => Object.keys(el).some((key) => key.startsWith('__reactContainer$') || key === '_reactRootContainer'));
        return reactRoot ? 'react' : null;
    })();

    // Klassen an html und body: Viele Anwendungen setzen dort den Zustand (signed-in, logged-in, authenticated), fuer jedes Konto gleich.
    const stateClasses = [document.documentElement, document.body].flatMap((el) => (el === null ? [] : [...el.classList]
        .filter((cls) => !generated(cls))
        .map((cls) => `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`)));

    return { url: location.href, title: document.title, login, markers, stateClasses, messages: [...messages], framework: probe };
};

/**
 * Nur, was zwei Ladevorgaenge derselben Seite ueberstanden hat: Kennungen, die der Server oder das Framework bei jedem Rendern neu
 * erfindet (etwa ein zufaelliges Kuerzel am Ende), sehen einzeln stabil aus, unterscheiden sich aber beim naechsten Laden.
 */
export const keepStable = (first, second) => {
    if (first == null || second == null) return first;
    const seen = new Set([
        ...(second.markers ?? []).map(({ selector }) => selector),
        ...Object.entries(second.login ?? {}).filter(([key]) => key.endsWith('Selector')).map(([, value]) => value),
    ]);
    const login = first.login == null ? first.login : Object.fromEntries(Object.entries(first.login)
        .map(([key, value]) => [key, key.endsWith('Selector') && value !== null && !seen.has(value) ? null : value]));
    const states = new Set(second.stateClasses ?? []);
    return {
        ...first,
        login,
        markers: (first.markers ?? []).filter(({ selector }) => seen.has(selector)),
        stateClasses: (first.stateClasses ?? []).filter((selector) => states.has(selector)),
    };
};

const LOGOUT = /abmelden|ausloggen|logout|log out|sign ?out|signout/i;
const ACCOUNT = /user|avatar|profil|profile|account|konto|benutzer|mein|my-|menu/i;
const SIGNED_IN_STATE = /signed-?in|logged-?in|log-?in|authenticated|authed|angemeldet|eingeloggt/i;

/** Woran man „angemeldet“ erkennt: Elemente, die es erst nach der Anmeldung gibt, das beste zuerst. */
export const suggestSignedIn = (before, after) => {
    const known = new Set((before?.markers ?? []).map(({ selector }) => selector));
    const fresh = (after?.markers ?? []).filter(({ selector }) => !known.has(selector));
    // Eine benannte Navigation oder Kopfzeile ist die robusteste Marke: Sie steht auf jeder Seite der angemeldeten Anwendung.
    const landmark = ({ tag = '', role = '' }) => /^(nav|header|aside)$/.test(tag) || /^(navigation|banner|complementary)$/.test(role);
    const score = ({ selector, text, ...marker }) => (LOGOUT.test(text) || LOGOUT.test(selector) ? 8 : 0)
        + (ACCOUNT.test(selector) ? 4 : 0)
        + (landmark(marker) && selector.includes('aria-label') ? 5 : 0)
        // Brotkrumen fehlen oft auf der Startseite, die Hauptnavigation nie.
        + (/aria-label="[^"]*(haupt|main|primary|global)/i.test(selector) ? 2 : 0)
        - (/brotkrume|breadcrumb/i.test(selector) ? 3 : 0)
        + (/^\[data-(testid|test|cy|qa)=/.test(selector) ? 2 : 0)
        + (selector.startsWith('#') ? 1 : 0)
        - (text.length > 25 ? 1 : 0);
    // Eine Zustandsklasse an html/body haengt nicht an Rechten oder Inhalt der Seite: Sie gilt fuer jedes Konto und jede Seite.
    const knownStates = new Set(before?.stateClasses ?? []);
    const states = (after?.stateClasses ?? []).filter((selector) => !knownStates.has(selector) && SIGNED_IN_STATE.test(selector))
        .map((selector) => ({ selector, text: '', tag: selector.split('.')[0], state: true, score: 10 }));
    const ranked = [...states, ...fresh.map((marker) => ({ ...marker, score: score(marker) }))].sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return null;
    const why = (marker) => {
        if (marker.state) return t('cli.exploreWhyState');
        if (LOGOUT.test(marker.text) || LOGOUT.test(marker.selector)) return t('cli.exploreWhyLogout');
        if (ACCOUNT.test(marker.selector)) return t('cli.exploreWhyAccount');
        if (landmark(marker) && marker.selector.includes('aria-label')) return t('cli.exploreWhyLandmark');
        return t('cli.exploreWhyFresh');
    };
    return {
        selector: ranked[0].selector,
        why: why(ranked[0]),
        confidence: ranked[0].score >= 4 ? 'certain' : 'likely',
        alternatives: ranked.slice(1, 4).map(({ selector, text }) => ({ selector, text })),
    };
};

const MAX_IGNORE = 60;
/**
 * Ein Muster fuer consoleIgnore (regulaerer Ausdruck, gesucht irgendwo in der Meldung): der Anfang der ersten Zeile bis vor die
 * erste Adresse, an einer Wortgrenze gekuerzt, Sonderzeichen maskiert, Zahlen als \d+, weil sie sich von Lauf zu Lauf aendern.
 */
const ignorePattern = (text) => {
    let head = String(text).split(/\r?\n/)[0].split(/https?:\/\//)[0].replace(/\s+/g, ' ');
    if (head.length > MAX_IGNORE) head = head.slice(0, MAX_IGNORE).replace(/\s+\S*$/, '');
    head = head.replace(/[^\p{L}\p{N}]+$/u, '').trim();
    return head.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\d+/g, '\\d+');
};

/**
 * Chrome meldet jede HTTP-Antwort ab 400 so; ein Muster darauf verdeckte alle HTTP-Fehler der Anwendung. Vor der Anmeldung sind sie
 * erwartbar (401), darum nie ein Vorschlag.
 */
const HTTP_NOISE = /^Failed to load resource/i;

/** Konsolenfehler, die schon ohne Zutun auftreten: Kandidaten fuer consoleIgnore, jeder ein gueltiger Ausdruck, der seine Meldung trifft. */
export const suggestConsoleIgnore = (errors) => [...new Set(errors.filter((error) => !HTTP_NOISE.test(String(error).trim())).map(ignorePattern)
    .filter((pattern) => pattern.replace(/\\d\+/g, '0').length >= 8))].slice(0, 8);

/**
 * Fasst alles zu Vorschlaegen fuer die Config zusammen.
 * @param seen     { before, loginPage, after }: die Seite am Anfang, die Seite mit dem Anmeldeformular (falls es eine gab) und am Ende
 * @param detected Framework aus der package.json
 */
export const buildSuggestions = ({ url, seen, consoleErrors = [], foreignHosts = [], detected = 'web' }) => {
    const { before, loginPage, after } = seen;
    const parsed = new URL(url);
    const notes = [];
    // http erlaubt die Config nur auf dem eigenen Rechner; die Adresse bleibt, wie der Mensch sie kennt.
    const origin = parsed.origin;
    if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
        notes.push(t('cli.exploreHttp', { host: parsed.hostname }));
    }
    const framework = after?.framework ?? before?.framework ?? null;
    const suggestion = {
        url: origin,
        framework: framework !== null
            ? { value: framework, confidence: 'certain', why: t('cli.exploreWhyRuntime') }
            : { value: detected, confidence: detected === 'web' ? 'likely' : 'certain', why: detected === 'web' ? t('cli.exploreWhyNeutral') : t('cli.exploreWhyPackage') },
    };
    if (framework !== null && detected !== 'web' && framework !== detected) notes.push(t('cli.exploreMismatch', { runtime: framework, detected }));

    const signedIn = suggestSignedIn(loginPage ?? before, after);
    if (foreignHosts.length > 0) {
        suggestion.auth = { type: 'storageState', confidence: 'likely', ...(signedIn === null ? {} : { signedInSelector: signedIn.selector }) };
        notes.push(t('cli.exploreForeign', { hosts: foreignHosts.join(', ') }));
    } else if (loginPage?.login != null) {
        const { userSelector, passwordSelector, submitsWithEnter } = loginPage.login;
        const submitSelector = submitsWithEnter === true ? null : loginPage.login.submitSelector;
        const path = new URL(loginPage.url).pathname;
        suggestion.auth = {
            type: 'form',
            path,
            ...(userSelector === null ? {} : { userSelector }),
            ...(passwordSelector === null ? {} : { passwordSelector }),
            ...(submitSelector === null ? {} : { submitSelector }),
            ...(signedIn === null ? {} : { signedInSelector: signedIn.selector }),
            confidence: userSelector !== null && passwordSelector !== null && signedIn !== null ? 'certain' : 'likely',
        };
        if (userSelector === null || passwordSelector === null) notes.push(t('cli.exploreNoFieldSelector'));
        if (signedIn === null) notes.push(t('cli.exploreNoSignedIn'));
    } else {
        suggestion.auth = { type: 'none', confidence: 'likely' };
        notes.push(t('cli.exploreNoLogin'));
    }
    if (signedIn !== null) suggestion.signedIn = signedIn;
    if (after !== undefined && after !== null) suggestion.startUrl = new URL(after.url).pathname + new URL(after.url).search;
    const messages = [...new Set([...(before?.messages ?? []), ...(after?.messages ?? [])])];
    if (messages.length > 0) suggestion.messageSelectors = messages;
    const ignore = suggestConsoleIgnore(consoleErrors);
    if (ignore.length > 0) {
        suggestion.consoleIgnore = ignore;
        notes.push(t('cli.exploreConsole'));
    }
    suggestion.notes = notes;
    return suggestion;
};

/** Ein Browserfenster nur fuer diesen Host, mit Mitschnitt von Konsolenfehlern und abgewiesenen fremden Seiten. */
const openExploreBrowser = async ({ url, insecureTls, launch }) => {
    const { exploreBrowser } = await import('./browser-session.mjs');
    return exploreBrowser({ url, insecureTls, launch });
};

/** Die Texte der Karte im Fenster; die Nummern der Schritte wie im Terminal. */
const cardTexts = (withLogin) => ({
    title: 'CAW-AI EXPLORE',
    steps: { signin: `1 ${t('cli.exploreStepSignIn')}`.toUpperCase(), start: `${withLogin ? 2 : 1} ${t('cli.exploreStepStart')}`.toUpperCase() },
    text: {
        wait: t('cli.exploreCardWait'),
        signin: t('cli.exploreCardSignIn'),
        start: t('cli.exploreCardStart'),
        reading: t('cli.exploreCardReading'),
        done: t('cli.exploreCardDone'),
    },
    page: t('cli.exploreCardPage'),
    button: t('cli.exploreDoneButton').toUpperCase(),
    saved: t('cli.exploreCardSaved'),
});

/** Steht gerade ein sichtbares Passwortfeld da, und ist die Seite fertig geladen? */
const formState = () => ({
    form: [...document.querySelectorAll('input[type=password]')].some((el) => el.getBoundingClientRect().width > 0),
    loaded: document.readyState === 'complete',
});

const POLL_MS = 500;
const HUMAN_MS = 30 * 60 * 1000;

/**
 * @param open nur fuer Tests: ersetzt den Browser ({ page, consoleErrors, foreignHosts, close })
 * @param wait nur fuer Tests: ersetzt das Warten auf den Knopf „Fertig“ im Fenster
 * @param ask  nur fuer Tests: ersetzt die Frage im Terminal, ob die Anwendung eine Anmeldung hat
 */
export const explore = async (root, args, { open = openExploreBrowser, wait, ask = askYesNo, detect, next = true } = {}) => {
    const url = optionValue(args, '--url');
    if (url === undefined || !/^https?:\/\//.test(url)) throw new CawError('usage', t('cli.exploreUsage'));
    // --yes: ohne Mensch, etwa fuer Anwendungen ohne Anmeldung; dann wird nur die Seite angesehen.
    const unattended = args.includes('--yes') && wait === undefined;
    // Ein Terminal braucht nur die Frage nach der Anmeldung; „Fertig“ kommt aus dem Fenster.
    const asks = !unattended && ask === askYesNo && !args.includes('--login') && !args.includes('--no-login');
    if (asks && !process.stdin.isTTY) throw new CawError('usage', t('cli.exploreNeedsTty'));
    const { detectFramework } = await import('./commands.mjs');
    const { reachable } = await import('./run.mjs');
    ui.banner({ title: 'caw-ai explore' });
    if (!await reachable(url)) throw new CawError('target-unreachable', t('cli.exploreUnreachable', { url }));

    // Nicht raten: Ob es eine Anmeldung gibt, weiss der Mensch. --login/--no-login fuer Skripte; ohne Mensch entscheidet die Seite.
    let withLogin = args.includes('--login') ? true : args.includes('--no-login') ? false : null;
    if (withLogin === null && !unattended) withLogin = await ask(t('cli.exploreAskLogin'));

    const host = new URL(url).host;
    const opening = ui.pending(t('cli.exploreOpening', { host }));
    const browser = await open({ url, insecureTls: args.includes('--insecure-tls') });
    const survey = (page = browser.page) => page.evaluate(surveyPage, MAX_MARKERS).catch(() => null);
    const settle = (page = browser.page) => page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    // Dieselbe Seite noch einmal laden und nur behalten, was beide Male gleich war.
    const surveyTwice = async () => {
        const first = await survey();
        if (browser.page.reload === undefined) return first;
        await browser.page.reload({ waitUntil: 'load' }).catch(() => {});
        await settle();
        return keepStable(first, await survey());
    };
    // Eine Anmeldeseite, zu der der Mensch erst navigiert: in einem zweiten Tab derselben Sitzung ein zweites Mal laden, sein Tab bleibt.
    const confirmInSecondTab = async (seen) => {
        const context = browser.page.context?.();
        if (context === undefined) return seen;
        const other = await context.newPage().catch(() => null);
        if (other === null) return seen;
        try {
            await other.goto(seen.url, { waitUntil: 'load' });
            await settle(other);
            return keepStable(seen, await survey(other));
        } catch {
            return seen;
        } finally {
            await other.close().catch(() => {});
            await browser.page.bringToFront?.().catch(() => {});
        }
    };

    // Die Karte im Fenster zeigt den Schritt; „Fertig“ dort ersetzt Enter im Terminal, das Fenster schliessen bricht ab.
    let pressDone;
    const done = new Promise((ok) => { pressDone = ok; });
    const closed = new Promise((ok) => { browser.page.on?.('close', () => ok('closed')); });
    let phase = 'wait';
    const setPhase = async (next) => {
        phase = next;
        await browser.page.evaluate(([name, value]) => window.dispatchEvent(new CustomEvent(name, { detail: value })), [PHASE_EVENT, next]).catch(() => {});
    };
    if (!unattended && wait === undefined) {
        const context = browser.page.context?.();
        await context?.exposeBinding(DONE_BINDING, () => pressDone('done')).catch(() => {});
        await context?.exposeBinding(PHASE_BINDING, () => phase).catch(() => {});
        await context?.addInitScript({ content: exploreCardScript(cardTexts(withLogin === true)) }).catch(() => {});
    }
    const human = wait === undefined ? Promise.race([done, closed]) : wait().then(() => 'done');

    let loginPage = null;
    let pending = Promise.resolve();
    try {
        await browser.page.goto(url, { waitUntil: 'load' });
        await settle();
        const before = await surveyTwice();
        opening.done(t('cli.exploreOpened', { host }));
        if (before?.login != null) loginPage = before;
        // Ohne Mensch: Die Seite entscheidet, ob es eine Anmeldung gibt.
        if (withLogin === null) withLogin = loginPage !== null;
        // Ein Anmeldeformular kann auch erst nach einem Klick auf „Anmelden“ kommen: jede neue Seite einmal ansehen.
        browser.page.on('load', () => {
            pending = pending.then(async () => {
                const seen = await survey();
                if (seen?.login != null && seen.url !== loginPage?.url) loginPage = await confirmInSecondTab(seen);
            });
        });

        if (!unattended) {
            await setPhase(withLogin ? 'signin' : 'start');
            if (withLogin) {
                ui.section(1, t('cli.exploreStepSignIn'));
                ui.info(t('cli.exploreSignIn'));
                const signingIn = ui.pending(t('cli.exploreWaitingSignIn'));
                // Angemeldet: Ein Passwortfeld war da und ist weg, die Seite fertig geladen. Kein Enter noetig.
                let sawForm = before?.login != null;
                let stop = false;
                const signedIn = (async () => {
                    const start = Date.now();
                    while (!stop && Date.now() - start < HUMAN_MS) {
                        const state = await browser.page.evaluate(formState).catch(() => null);
                        if (state === null && browser.page.isClosed?.()) return 'closed';
                        if (state?.form) sawForm = true;
                        else if (sawForm && state?.loaded) return 'signed-in';
                        await new Promise((ok) => { setTimeout(ok, POLL_MS); });
                    }
                    return 'timeout';
                })();
                const first = await Promise.race([signedIn, human]);
                stop = true;
                if (first === 'closed') {
                    signingIn.fail(t('cli.exploreClosed'));
                    return EXIT.rejected;
                }
                signingIn.done(first === 'signed-in' ? t('cli.exploreSignedInDone') : t('cli.exploreSignInSkipped'));
            }
            await setPhase('start');
            ui.section(withLogin ? 2 : 1, t('cli.exploreStepStart'));
            ui.info(t('cli.exploreGoStart'));
            const choosing = ui.pending(t('cli.exploreWaitingDone'));
            if (await human === 'closed') {
                choosing.fail(t('cli.exploreClosed'));
                return EXIT.rejected;
            }
            choosing.done(t('cli.exploreStartChosen'));
            await setPhase('reading');
        }
        await pending;
        await settle();
        const reading = ui.pending(t('cli.exploreReading'));
        const after = await surveyTwice();
        reading.done(t('cli.exploreRead'));
        await setPhase('done');
        const suggestion = buildSuggestions({
            url,
            seen: { before, loginPage: withLogin ? loginPage : null, after },
            consoleErrors: browser.consoleErrors,
            foreignHosts: withLogin ? [...browser.foreignHosts] : [],
            detected: (detect ?? detectFramework)(root),
        });
        if (withLogin && loginPage === null && browser.foreignHosts.size === 0) suggestion.notes.unshift(t('cli.exploreLoginNotFound'));
        mkdirSync(join(root, 'caw'), { recursive: true });
        writeFileSync(join(root, EXPLORE_FILE), `${JSON.stringify(suggestion, null, 2)}\n`);
        // Unsichere Funde (likely) als Warnung im Block, sichere als abgehakt.
        const sure = (confidence) => (confidence === 'likely' ? 'warn' : 'ok');
        ui.box(t('cli.exploreStepResult'), summaryLines(suggestion).map((text, index) => ({
            text,
            status: index === 0 ? sure(suggestion.framework.confidence) : index === 1 ? sure(suggestion.auth.confidence) : 'ok',
        })));
        for (const note of suggestion.notes) ui.note(note);
        if (next) ui.info(t('cli.exploreNext', { file: EXPLORE_FILE }));
        return EXIT.pass;
    } finally {
        await browser.close();
    }
};

/** Was explore fand, je Punkt eine Zeile. */
export const summaryLines = (suggestion) => [
    t('cli.exploreFoundFramework', { framework: suggestion.framework.value }),
    suggestion.auth.type === 'none' ? t('cli.exploreFoundNoLogin') : t('cli.exploreFoundLogin', { type: suggestion.auth.type }),
    ...(suggestion.signedIn === undefined ? [] : [t('cli.exploreFoundSignedIn', { selector: suggestion.signedIn.selector, why: suggestion.signedIn.why })]),
    ...(suggestion.startUrl === undefined ? [] : [t('cli.exploreFoundStart', { path: suggestion.startUrl })]),
    t('cli.exploreSavedTo', { file: EXPLORE_FILE }),
];
