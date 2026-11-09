// `caw-ai explore --url <adresse>`: oeffnet die Anwendung einmal, der Mensch meldet sich an, und das Tool leitet ab, was die Config
// braucht: Framework, Anmeldeformular, woran man „angemeldet“ erkennt, Startseite, Meldungen und Rauschen in der Konsole. Es schreibt
// nur Vorschlaege nach caw/.explore.json, nie die Config; die uebernimmt `init --from` oder der Skill nach Rueckfragen.
// Ohne Claude und ohne Token. Der Browser erreicht nur den Host der Adresse.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { createUi } from '../shared/ui.mjs';
import { isLoopback } from '../shared/config.mjs';

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
        const name = [...el.classList].find((cls) => /toast|snackbar|notification/i.test(cls) && !generated(cls));
        if (name !== undefined) messages.add(`.${CSS.escape(name)}`);
    }

    const probe = (() => {
        if (window.Ext?.getVersion !== undefined) return 'extjs';
        if (document.querySelector('[ng-version]') !== null || window.getAllAngularTestabilities !== undefined) return 'angular';
        if (window.__VUE__ !== undefined || document.querySelector('[data-v-app]') !== null) return 'vue';
        const reactRoot = [...document.querySelectorAll('body > *, #root, #app')].some((el) => Object.keys(el).some((key) => key.startsWith('__reactContainer$') || key === '_reactRootContainer'));
        return reactRoot ? 'react' : null;
    })();

    return { url: location.href, title: document.title, login, markers, messages: [...messages], framework: probe };
};

const LOGOUT = /abmelden|ausloggen|logout|log out|sign ?out|signout/i;
const ACCOUNT = /user|avatar|profil|profile|account|konto|benutzer|mein|my-|menu/i;

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
    const ranked = fresh.map((marker) => ({ ...marker, score: score(marker) })).sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return null;
    const why = (marker) => {
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
        const { userSelector, passwordSelector, submitSelector } = loginPage.login;
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

const askEnter = async (text) => {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        await rl.question(text);
    } finally {
        rl.close();
    }
};

/**
 * @param open nur fuer Tests: ersetzt den Browser ({ page, consoleErrors, foreignHosts, close })
 * @param wait nur fuer Tests: ersetzt das Warten auf den Menschen
 */
export const explore = async (root, args, { open = openExploreBrowser, wait = askEnter, detect, next = true } = {}) => {
    const index = args.indexOf('--url');
    const url = index === -1 ? undefined : args[index + 1];
    if (url === undefined || !/^https?:\/\//.test(url)) throw new CawError('usage', t('cli.exploreUsage'));
    // --yes: ohne Mensch, etwa fuer Anwendungen ohne Anmeldung; dann wird nur die Seite angesehen.
    const unattended = args.includes('--yes') && wait === askEnter;
    if (!args.includes('--yes') && !process.stdin.isTTY && wait === askEnter) throw new CawError('usage', t('cli.exploreNeedsTty'));
    const { detectFramework } = await import('./commands.mjs');
    const { reachable } = await import('./run.mjs');
    if (!await reachable(url)) throw new CawError('target-unreachable', t('cli.exploreUnreachable', { url }));
    const browser = await open({ url, insecureTls: args.includes('--insecure-tls') });
    const survey = () => browser.page.evaluate(surveyPage, MAX_MARKERS).catch(() => null);
    let loginPage = null;
    try {
        await browser.page.goto(url, { waitUntil: 'load' });
        await browser.page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
        const before = await survey();
        if (before?.login != null) loginPage = before;
        // Ein Anmeldeformular kann auch erst nach einem Klick auf „Anmelden“ kommen: jede neue Seite einmal ansehen.
        browser.page.on('load', () => {
            survey().then((seen) => { if (seen?.login != null) loginPage = seen; });
        });
        if (!unattended) {
            ui.info(t('cli.exploreSignIn'));
            await wait(t('cli.explorePressEnter'));
        }
        await browser.page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
        const after = await survey();
        const suggestion = buildSuggestions({
            url,
            seen: { before, loginPage, after },
            consoleErrors: browser.consoleErrors,
            foreignHosts: [...browser.foreignHosts],
            detected: (detect ?? detectFramework)(root),
        });
        mkdirSync(join(root, 'caw'), { recursive: true });
        writeFileSync(join(root, EXPLORE_FILE), `${JSON.stringify(suggestion, null, 2)}\n`);
        ui.success(t('cli.exploreSaved', { file: EXPLORE_FILE, framework: suggestion.framework.value, auth: suggestion.auth.type, signedIn: suggestion.signedIn === undefined ? '' : t('cli.exploreSignedIn', { selector: suggestion.signedIn.selector }) }));
        for (const note of suggestion.notes) ui.note(note);
        if (next) ui.info(t('cli.exploreNext', { file: EXPLORE_FILE }));
        return EXIT.pass;
    } finally {
        await browser.close();
    }
};
