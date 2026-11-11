// `caw-ai explore --url <address>`: opens the application once, the human signs in, and the tool derives what the config needs:
// framework, sign-in form, how to recognise "signed in", start page, message containers and console noise. It only writes
// suggestions to caw/.explore.json, never the config; `init --from` or the skill (after asking) takes them over.
// No Claude, no tokens. The browser only reaches the host of the address.

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
 * Runs in the page: fields, buttons, stable selectors and message containers, without field values. Only CSS selectors that
 * match exactly one element and do not look like generated ids.
 */
export const surveyPage = (maxMarkers) => {
    // Generated ids change with every render or build: React useId (:r1:, «r1», _r_1_), Radix, Headless UI, MUI, ExtJS, Ember …
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
        // The user name field comes before the password, usually right before it or with autocomplete=username.
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
            // A real submit button in the password's form: Enter in the password field submits, a selector would only be a source of errors.
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
        // Buttons and links that only open or count messages are not messages themselves.
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

    // Classes on html and body: many applications put the state there (signed-in, logged-in, authenticated), the same for every account.
    const stateClasses = [document.documentElement, document.body].flatMap((el) => (el === null ? [] : [...el.classList]
        .filter((cls) => !generated(cls))
        .map((cls) => `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`)));

    return { url: location.href, title: document.title, login, markers, stateClasses, messages: [...messages], framework: probe };
};

/**
 * Only what survived two loads of the same page: ids that the server or framework invents on every render (e.g. a random
 * suffix) look stable on their own but differ on the next load.
 */
export const keepStable = (first, second) => {
    if (first === null || first === undefined || second === null || second === undefined) return first;
    const seen = new Set([
        ...(second.markers ?? []).map(({ selector }) => selector),
        ...Object.entries(second.login ?? {}).filter(([key]) => key.endsWith('Selector')).map(([, value]) => value),
    ]);
    const login = first.login === null || first.login === undefined ? first.login : Object.fromEntries(Object.entries(first.login)
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

/** How to recognise "signed in": elements that only exist after sign-in, best first. */
export const suggestSignedIn = (before, after) => {
    const known = new Set((before?.markers ?? []).map(({ selector }) => selector));
    const fresh = (after?.markers ?? []).filter(({ selector }) => !known.has(selector));
    // A named navigation or header is the most robust marker: it is on every page of the signed-in application.
    const landmark = ({ tag = '', role = '' }) => /^(nav|header|aside)$/.test(tag) || /^(navigation|banner|complementary)$/.test(role);
    const score = ({ selector, text, ...marker }) => (LOGOUT.test(text) || LOGOUT.test(selector) ? 8 : 0)
        + (ACCOUNT.test(selector) ? 4 : 0)
        + (landmark(marker) && selector.includes('aria-label') ? 5 : 0)
        // Breadcrumbs are often missing on the start page, the main navigation never is.
        + (/aria-label="[^"]*(haupt|main|primary|global)/i.test(selector) ? 2 : 0)
        - (/brotkrume|breadcrumb/i.test(selector) ? 3 : 0)
        + (/^\[data-(testid|test|cy|qa)=/.test(selector) ? 2 : 0)
        + (selector.startsWith('#') ? 1 : 0)
        - (text.length > 25 ? 1 : 0);
    // A state class on html/body does not depend on permissions or page content: it holds for every account and every page.
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
 * A pattern for consoleIgnore (regular expression, searched anywhere in the message): the start of the first line up to the first
 * address, cut at a word boundary, special characters escaped, numbers as \d+ because they change from run to run.
 */
const ignorePattern = (text) => {
    let head = String(text).split(/\r?\n/)[0].split(/https?:\/\//)[0].replace(/\s+/g, ' ');
    if (head.length > MAX_IGNORE) head = head.slice(0, MAX_IGNORE).replace(/\s+\S*$/, '');
    head = head.replace(/[^\p{L}\p{N}]+$/u, '').trim();
    return head.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\d+/g, '\\d+');
};

/**
 * Chrome reports every HTTP response from 400 up like this; a pattern for it would hide all HTTP errors of the application. Before
 * sign-in they are expected (401), so never suggest one.
 */
const HTTP_NOISE = /^Failed to load resource/i;

/** Console errors that occur without any interaction: candidates for consoleIgnore, each a valid regex that matches its message. */
export const suggestConsoleIgnore = (errors) => [...new Set(errors.filter((error) => !HTTP_NOISE.test(String(error).trim())).map(ignorePattern)
    .filter((pattern) => pattern.replace(/\\d\+/g, '0').length >= 8))].slice(0, 8);

const pathOf = (address) => new URL(address).pathname + new URL(address).search;

/**
 * Where tests start: the page the human chose at the end. If that still shows a sign-in form (nobody signed in, e.g. with
 * --yes), it is no start page: then the given address, unless that is the sign-in page itself, else "/".
 */
export const startUrlOf = (url, after) => {
    if (after.login === null || after.login === undefined) return pathOf(after.url);
    const given = pathOf(url);
    return given === pathOf(after.url) ? '/' : given;
};

/**
 * Combines everything into suggestions for the config.
 * @param seen     { before, loginPage, after }: the page at the start, the page with the sign-in form (if any) and at the end
 * @param detected framework from package.json
 */
export const buildSuggestions = ({ url, seen, consoleErrors = [], foreignHosts = [], detected = 'web' }) => {
    const { before, loginPage, after } = seen;
    const parsed = new URL(url);
    const notes = [];
    // The config only allows http on the local machine; the address stays as the human knows it.
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
    } else if (loginPage?.login !== null && loginPage?.login !== undefined) {
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
    if (after !== undefined && after !== null) suggestion.startUrl = startUrlOf(url, after);
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

/** A browser window for this host only, recording console errors and blocked foreign pages. */
const openExploreBrowser = async ({ url, insecureTls, launch }) => {
    const { exploreBrowser } = await import('./browser-session.mjs');
    return exploreBrowser({ url, insecureTls, launch });
};

/** The texts of the card in the window; step numbers as in the terminal. */
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

/** Is a visible password field present, and has the page finished loading? */
const formState = () => ({
    form: [...document.querySelectorAll('input[type=password]')].some((el) => el.getBoundingClientRect().width > 0),
    loaded: document.readyState === 'complete',
});

const POLL_MS = 500;
const HUMAN_MS = 30 * 60 * 1000;

/**
 * @param open for tests only: replaces the browser ({ page, consoleErrors, foreignHosts, close })
 * @param wait for tests only: replaces waiting for the "Done" button in the window
 * @param ask  for tests only: replaces the terminal question whether the application has a sign-in
 */
export const explore = async (root, args, { open = openExploreBrowser, wait, ask = askYesNo, detect, next = true } = {}) => {
    const url = optionValue(args, '--url');
    if (url === undefined || !/^https?:\/\//.test(url)) throw new CawError('usage', t('cli.exploreUsage'));
    // --yes: without a human, e.g. for applications without sign-in; then only the page is looked at.
    const unattended = args.includes('--yes') && wait === undefined;
    // The terminal is only needed for the sign-in question; "Done" comes from the window.
    const asks = !unattended && ask === askYesNo && !args.includes('--login') && !args.includes('--no-login');
    if (asks && !process.stdin.isTTY) throw new CawError('usage', t('cli.exploreNeedsTty'));
    const { detectFramework } = await import('./commands.mjs');
    const { reachable } = await import('./run.mjs');
    ui.banner({ title: 'caw-ai explore' });
    if (!await reachable(url)) throw new CawError('target-unreachable', t('cli.exploreUnreachable', { url }));

    // No guessing: the human knows whether there is a sign-in. --login/--no-login for scripts; without a human the page decides.
    let withLogin = args.includes('--login') ? true : args.includes('--no-login') ? false : null;
    if (withLogin === null && !unattended) withLogin = await ask(t('cli.exploreAskLogin'));

    const host = new URL(url).host;
    const opening = ui.pending(t('cli.exploreOpening', { host }));
    const browser = await open({ url, insecureTls: args.includes('--insecure-tls') });
    const survey = (page = browser.page) => page.evaluate(surveyPage, MAX_MARKERS).catch(() => null);
    const settle = (page = browser.page) => page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    // Load the same page again and keep only what was the same both times.
    const surveyTwice = async () => {
        const first = await survey();
        if (browser.page.reload === undefined) return first;
        await browser.page.reload({ waitUntil: 'load' }).catch(() => {});
        await settle();
        return keepStable(first, await survey());
    };
    // A sign-in page the human navigated to: load it a second time in another tab of the same session, their tab stays.
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

    // The card in the window shows the step; "Done" there replaces Enter in the terminal, closing the window aborts.
    let pressDone;
    const done = new Promise((ok) => { pressDone = ok; });
    const closed = new Promise((ok) => { browser.page.on?.('close', () => ok('closed')); });
    let phase = 'wait';
    const setPhase = async (value) => {
        phase = value;
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser page, not in Node
        await browser.page.evaluate(([name, detail]) => window.dispatchEvent(new CustomEvent(name, { detail })), [PHASE_EVENT, value]).catch(() => {});
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
        if (before?.login !== null && before?.login !== undefined) loginPage = before;
        // Without a human: the page decides whether there is a sign-in.
        if (withLogin === null) withLogin = loginPage !== null;
        // A sign-in form may only appear after clicking "Sign in": look at every new page once.
        browser.page.on('load', () => {
            pending = pending.then(async () => {
                const seen = await survey();
                if (seen?.login !== null && seen?.login !== undefined && seen.url !== loginPage?.url) loginPage = await confirmInSecondTab(seen);
            });
        });

        if (!unattended) {
            await setPhase(withLogin ? 'signin' : 'start');
            if (withLogin) {
                ui.section(1, t('cli.exploreStepSignIn'));
                ui.info(t('cli.exploreSignIn'));
                const signingIn = ui.pending(t('cli.exploreWaitingSignIn'));
                // Signed in: a password field was there and is gone, the page has finished loading. No Enter needed.
                let sawForm = before?.login !== null && before?.login !== undefined;
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
        // Uncertain findings (likely) as a warning in the box, certain ones as checked.
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

/** What explore found, one line per item. */
export const summaryLines = (suggestion) => [
    t('cli.exploreFoundFramework', { framework: suggestion.framework.value }),
    suggestion.auth.type === 'none' ? t('cli.exploreFoundNoLogin') : t('cli.exploreFoundLogin', { type: suggestion.auth.type }),
    ...(suggestion.signedIn === undefined ? [] : [t('cli.exploreFoundSignedIn', { selector: suggestion.signedIn.selector, why: suggestion.signedIn.why })]),
    ...(suggestion.startUrl === undefined ? [] : [t('cli.exploreFoundStart', { path: suggestion.startUrl })]),
    t('cli.exploreSavedTo', { file: EXPLORE_FILE }),
];
