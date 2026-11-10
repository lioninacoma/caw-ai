// Der Browser laeuft sichtbar auf dem Host, damit ein Mensch dieselbe Seite uebernehmen kann. Die Grenze
// setzen die Flags: Chrome erreicht nur die erlaubten Hosts. Ein CDP-Port wird nie geoeffnet.

import { classifyFailure, stackOrigin } from '../shared/report.mjs';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { totp } from '../shared/totp.mjs';
import { createDevlinkHost, createPlaywrightLauncher, isHardFailure, parseConfig } from './devlink-core.mjs';
import { fileVersion, routeOverlay } from './overlay.mjs';
import { DEFAULT_MESSAGE_SELECTORS, authOf, browserLaunch, isLoopback } from '../shared/config.mjs';
import { frameworkOf, waitQuiet } from './framework/index.mjs';
import { responseLine } from './effects.mjs';
import { APP_FRAME, WORKBENCH_MARK_SCRIPT, fromWorkbenchSource, interceptDocuments } from './app-view.mjs';
import { createSourceMapper } from './source-maps.mjs';
import { createNetworkLog, outcomeText, parameterNames, requestName } from './network-log.mjs';
import { PREP, openWorkbench } from './workbench.mjs';

/** Zugriff aus dem iframe auf das oberste Fenster, das in der Werkbank einen anderen Origin hat. */
export const CROSS_ORIGIN_TOP = /Blocked a frame with origin .* from accessing a cross-origin frame/;
export const EMBED_HINT = '(Die Anwendung greift auf das oberste Fenster zu. Das ist die Werkbank, und sie liegt gerade auf einer anderen Adresse als die Anwendung, etwa nach einer Weiterleitung: Der Browser blockt den Zugriff, die Aktion bricht ab. Ohne Werkbank (--no-chat) tritt das nicht auf.)';

const LOGIN_TIMEOUT_MS = 30_000;
// So lange wartet die Anmeldung hoechstens auf Netzruhe und darauf, dass das Framework die Seite uebernommen hat. Eine Anmeldeseite
// ausserhalb der App (etwa eines Identity Providers) haengt das Framework nie ein; dann geht es danach trotzdem weiter.
const LOGIN_HYDRATE_MS = 10_000;
const LOGIN_MOUNT_MS = 5_000;
// So lange darf die Anwendung fuer die Antwort auf einen Einmalcode brauchen; steht danach das Codefeld noch da, hat sie ihn abgelehnt.
const CODE_ANSWER_MS = 10_000;
// Ein TOTP-Code gilt 30 s. Der neue Code kommt kurz nach Beginn des naechsten Fensters, falls die Uhren etwas abweichen.
const TOTP_WINDOW_MS = 30_000;
const NEXT_WINDOW_MARGIN_MS = 1000;
const sleepMs = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
/** Antworten, die offen bleiben, solange die Seite lebt: Server-Sent Events und Zeilen-JSON. */
export const STREAM_TYPE = /text\/event-stream|application\/(x-)?ndjson|application\/stream\+json|application\/jsonl/i;
const PROFILE_PREFIX = 'caw-profile-';
const PROFILE_OWNER = 'caw-owner';
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

// localhost und 127.0.0.1 sind derselbe Rechner: Ein Dev-Server unter dem einen Namen oeffnet seinen HMR-Socket oft unter dem anderen
// (webpack-dev-server mit host 127.0.0.1). Beide frei zu geben erweitert die Grenze nicht, localhost zeigt ohnehin auf 127.0.0.1.
const LOOPBACK_PAIR = ['localhost', '127.0.0.1'];
const withLoopbackPair = (hosts) => (hosts.some((host) => LOOPBACK_PAIR.includes(host)) ? [...new Set([...hosts, ...LOOPBACK_PAIR])] : hosts);

/**
 * Die Netzgrenze des Browsers. `--no-proxy-server` gehoert dazu: Ueber einen Proxy loest Chrome Namen
 * nicht selbst auf, die Regeln griffen dann nicht. WebRTC ginge sonst per UDP an ihnen vorbei.
 */
export const browserArgs = (allowed) => {
    const hosts = withLoopbackPair(allowed);
    return [
        // localhost und Namen unter .localhost sind Loopback (RFC 6761); fest auf 127.0.0.1, so wie ein Dev-Server meist lauscht.
        // Mit einer Ausnahme in den Regeln fragte Chrome sonst das System, und Windows kennt .localhost nicht. Auch eine IP-Adresse trifft
        // `MAP *`: 127.0.0.1 braucht darum, wenn erlaubt, eine Ausnahme wie jeder andere Host.
        `--host-resolver-rules=${[
            ...hosts.filter((host) => isLoopback(host) && host !== '127.0.0.1').map((host) => `MAP ${host} 127.0.0.1`),
            'MAP * ~NOTFOUND',
            ...hosts.filter((host) => !isLoopback(host) || host === '127.0.0.1').map((host) => `EXCLUDE ${host}`),
        ].join(', ')}`,
        '--no-proxy-server',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ];
};

/**
 * Loescht das Profil. Unter Windows halten Chrome-Prozesse Dateien noch kurz nach dem Schliessen fest,
 * darum mehrere Versuche. Scheitert es endgueltig, darf das den Lauf nicht mehr kippen: Das Urteil steht.
 */
export const removeProfile = async (dir, { remove = rmSync, attempts = 20, delayMs = 500 } = {}) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            remove(dir, { recursive: true, force: true });
            return true;
        } catch {
            if (attempt < attempts) await new Promise((ok) => { setTimeout(ok, delayMs); });
        }
    }
    return false;
};

const isAliveProcess = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

/**
 * Raeumt Profile frueherer Laeufe weg, die nicht geloescht werden konnten, etwa nach einem Abbruch. Sie enthalten
 * Login-Cookies des Testkontos. Eine laufende Sitzung bleibt unberuehrt: Jedes Profil nennt seinen Prozess. Ohne
 * diesen Eintrag stammt es von einer aelteren Tool-Version und zaehlt erst nach einem Tag als verwaist.
 */
export const sweepStaleProfiles = ({ dir = tmpdir(), isAlive = isAliveProcess, remove = rmSync, now = Date.now } = {}) => {
    let removed = 0;
    let entries = [];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return removed;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(PROFILE_PREFIX)) {
            const path = join(dir, entry.name);
            try {
                const owner = join(path, PROFILE_OWNER);
                const stale = existsSync(owner)
                    ? !isAlive(Number(readFileSync(owner, 'utf8')))
                    : now() - statSync(path).mtimeMs > ORPHAN_AGE_MS;
                if (stale) {
                    remove(path, { recursive: true, force: true });
                    removed += 1;
                }
            } catch {
                // Noch belegt: Der naechste Lauf versucht es wieder.
            }
        }
    }
    return removed;
};

/** Schliesst ein Mensch das Fenster, koennen laufende Requests des Einspielens noch scheitern. Nur das ist harmlos. */
export const isBrowserClosedError = (reason) => /has been closed|Target closed|browser has disconnected/i.test(String(reason?.message ?? reason));

/**
 * Welche Tabs zum Test gehoeren: der Anwendungs-Tab und seine Popups. Das Fenster ist sichtbar, ein Mensch
 * kann also jederzeit eigene Tabs oeffnen. Die bekommen weder Befehle des Agenten, noch zaehlen ihre Fehler.
 */
export const trackAgentPages = (first) => {
    const owned = new Set();
    const open = [];
    // Mit Werkbank: Die Anwendung ist ein Frame darin (`view`). Werkbank und Chat gehoeren nicht zum Test.
    let workbench = null;
    let view = null;
    const add = (page) => {
        owned.add(page);
        open.push(page);
        page.on('popup', add);
        page.on('close', () => {
            const at = open.findIndex((entry) => entry === page || (page === workbench && entry === view));
            if (at !== -1) open.splice(at, 1);
        });
    };
    add(first);
    const inApp = (frame) => {
        for (let current = frame; current !== null; current = current.parentFrame()) if (current === view.frame) return true;
        return false;
    };
    return {
        current: () => open.at(-1) ?? view ?? first,
        /** Die Anwendung selbst, nie ein Popup: der erste Tab bzw. das iframe der Werkbank. */
        main: () => view ?? first,
        /** Die offenen Popups der Anwendung, neuestes zuletzt. */
        popups: () => open.filter((page) => page !== (view ?? first)),
        owns: (page) => owned.has(page),
        /** Die Anwendung laeuft ab jetzt im iframe der Werkbank `page`. */
        embed: (page, frameView) => {
            workbench = page;
            view = frameView;
            owned.add(view);
            const at = open.indexOf(page);
            if (at !== -1) open[at] = view;
        },
        /**
         * Wozu gehoert ein Frame? Die Seite, bei der Werkbank die Anwendung, oder `false` fuer Werkbank und Chat selbst.
         * Ohne Frame (Worker) null: lieber mitzaehlen als einen Fehler der Anwendung verschlucken.
         */
        pageOf: (frame) => {
            if (frame === null || frame === undefined) return null;
            const page = frame.page();
            if (workbench === null || page !== workbench) return page;
            return inApp(frame) ? view : false;
        },
    };
};

/**
 * Meldet den Browser an, falls noetig. Die Zugangsdaten bleiben auf dem Host; der Trace startet erst
 * nach der Anmeldung, und keine Meldung enthaelt sie.
 */
const ensureLoggedIn = async (context, { url, marker, login, password, totpSecret, selectors, framework }) => {
    const page = context.pages()[0];
    const broken = watchBroken(page);
    // Nur die SPA-Adapter: Ihre Anmeldeseite ist meist Teil der App. `web` und `extjs` (Portal-Anmeldung ohne Ext) bleiben wie bisher.
    const originOf = (address) => { try { return new URL(address).origin; } catch { return null; } };
    // Eine fremde Anmeldeseite (Keycloak, Entra) hat kein Framework der App: Dort zu warten kostete nur LOGIN_MOUNT_MS.
    const ready = framework?.hydrates === true ? async (current) => {
        if (originOf(current.url()) !== originOf(url)) return;
        const deadline = Date.now() + LOGIN_MOUNT_MS;
        while (Date.now() < deadline) {
            const sample = await current.evaluate(framework.probe, null).catch(() => null);
            if (sample?.appReady === true) return;
            await sleepMs(100);
        }
    } : undefined;
    try {
        await loginSteps(page, { url, marker, login, password, totpSecret, selectors, ready });
    } catch (error) {
        const seen = broken.text();
        if (seen !== '' && error instanceof CawError) error.message = `${error.message} ${seen}`;
        throw error;
    } finally {
        broken.stop();
    }
};

/**
 * Was beim Anmelden am Netz scheitert: Ohne Backend findet sonst nur „keine Anmeldemaske“ statt. Nur Methode und Pfad,
 * Parameter koennten Anmeldedaten enthalten.
 */
export const watchBroken = (page, limit = 3) => {
    const seen = [];
    const add = (entry) => { if (!seen.includes(entry)) seen.push(entry); };
    const where = (request) => {
        try {
            return `${request.method()} ${new URL(request.url()).pathname}`;
        } catch {
            return request.method();
        }
    };
    const failed = (request) => add(`${where(request)} (${request.failure()?.errorText ?? t('session.browser.requestAborted')})`);
    const answered = (response) => { if (response.status() >= 500) add(`${where(response.request())} (HTTP ${response.status()})`); };
    page.on('requestfailed', failed);
    page.on('response', answered);
    return {
        text: () => (seen.length === 0 ? '' : t('session.browser.failedRequests', { list: seen.slice(0, limit).join(', '), more: seen.length > limit ? t('session.browser.failedRequestsMore', { count: seen.length - limit }) : '' })),
        stop: () => {
            page.off('requestfailed', failed);
            page.off('response', answered);
        },
    };
};

// Verlangt die Anwendung nach dem Passwort einen Einmalcode (`codeSelector`), traegt ihn die Rolle mit ihrem TOTP-Geheimnis ein.
// Ein Code gilt nur einmal: Hat sich dasselbe Konto im selben 30-s-Fenster schon angemeldet, etwa im Test davor, lehnt die Anwendung
// ihn ab. Dann genau ein neuer Versuch mit dem Code des naechsten Fensters; scheitert auch er, meldet loginSteps die Anmeldung als gescheitert.
const secondFactor = async (page, { marker, totpSecret, selectors, now, sleep }) => {
    if (selectors.code === undefined) return;
    const next = await Promise.race([
        page.waitForSelector(marker, { timeout: LOGIN_TIMEOUT_MS }).then(() => 'signed-in'),
        page.waitForSelector(selectors.code, { timeout: LOGIN_TIMEOUT_MS }).then(() => 'code'),
    ]).catch(() => null);
    if (next !== 'code') return;
    if (totpSecret === undefined) throw new CawError('login-failed', t('session.browser.codeWithoutSecret', { selector: selectors.code }));
    const submit = async () => {
        const at = now();
        await page.fill(selectors.code, totp(totpSecret, at));
        await page.press(selectors.code, 'Enter');
        return at;
    };
    const sentAt = await submit();
    const codeStays = async () => await page.$(marker) === null && await page.isVisible(selectors.code).catch(() => false);
    const accepted = await page.waitForSelector(marker, { timeout: CODE_ANSWER_MS }).then(() => true, () => false);
    if (accepted || !await codeStays()) return;
    const nextWindow = (Math.floor(sentAt / TOTP_WINDOW_MS) + 1) * TOTP_WINDOW_MS;
    await sleep(Math.max(0, nextWindow - now()) + NEXT_WINDOW_MARGIN_MS);
    if (await codeStays()) await submit();
};

export const loginSteps = async (page, { url, marker, login, password, totpSecret, selectors, ready, now = Date.now, sleep = sleepMs }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${marker}, ${selectors.user}`, { timeout: LOGIN_TIMEOUT_MS }).catch(() => {
        throw new CawError('login-form-missing', t('session.browser.loginFormMissing', { marker, url }));
    });
    if (await page.$(marker) !== null) return;
    // Vor dem Laden ist das Formular oft zwar da, schickt aber noch nicht ab: Enter ginge ins Leere.
    await page.waitForLoadState('load', { timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
    // Serverseitig gerendert (Nuxt, Next.js, Angular SSR) steht das Formular schon da, bevor das Framework es uebernimmt. Wer
    // vorher ausfuellt, verliert die Werte bei der Hydration, oder Enter schickt das Formular nativ ab (GET, Felder in der URL).
    if (ready !== undefined) {
        await page.waitForLoadState('networkidle', { timeout: LOGIN_HYDRATE_MS }).catch(() => {});
        await ready(page);
        if (await page.$(marker) !== null) return;
    }
    await page.fill(selectors.user, login);
    await page.fill(selectors.password, password);
    if (selectors.submit === undefined) await page.press(selectors.password, 'Enter');
    else await page.click(selectors.submit);
    await secondFactor(page, { marker, totpSecret, selectors, now, sleep });
    // Ein kaltes Portal leitet weiter, rendert aber die Seite danach nicht rechtzeitig fertig: einmal neu laden, dann gilt es.
    const signedIn = await page.waitForSelector(marker, { timeout: LOGIN_TIMEOUT_MS }).then(() => true, () => false);
    if (signedIn) return;
    if (await page.$(selectors.password) === null) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForSelector(marker, { timeout: LOGIN_TIMEOUT_MS }).catch(() => {
        // Nur der Pfad: Parameter koennten Daten aus der Anmeldung enthalten.
        throw new CawError('login-failed', t('session.browser.loginFailed', { url, marker, path: new URL(page.url()).pathname }));
    });
};

/**
 * Eine gespeicherte Sitzung (`auth.type: storageState`, aufgenommen mit `caw-ai auth`): Cookies in den Kontext, localStorage und
 * sessionStorage per Skript vor jedem Laden, nur fuer die Origins aus der Datei. Danach gilt dieselbe Pruefung wie nach einer Anmeldung.
 */
const applyStorageState = async (context, path) => {
    let state;
    try {
        state = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new CawError('auth-missing', t('session.browser.authUnreadable', { path, error: error.message.split('\n')[0] }));
    }
    if (Array.isArray(state.cookies) && state.cookies.length > 0) await context.addCookies(state.cookies);
    const stores = (state.origins ?? []).filter((entry) => typeof entry?.origin === 'string' && (Array.isArray(entry.localStorage) || Array.isArray(entry.sessionStorage)));
    if (stores.length === 0) return;
    const script = `(() => { const stores = ${JSON.stringify(stores)}; const own = stores.find((entry) => entry.origin === location.origin);
        if (own === undefined) return;
        const fill = (storage, items) => { for (const { name, value } of items ?? []) { try { if (storage.getItem(name) === null) storage.setItem(name, value); } catch {} } };
        fill(localStorage, own.localStorage); fill(sessionStorage, own.sessionStorage); })();`;
    await context.addInitScript({ content: script });
};

/** Ohne Passwortmanager: Die Frage „Passwort speichern?“ stoert jeden Lauf, und das Testpasswort soll nicht im Profil landen. */
const quietProfile = (profileDir) => {
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
        credentials_enable_service: false,
        credentials_enable_autosignin: false,
        profile: { password_manager_enabled: false, password_manager_leak_detection: false },
        autofill: { profile_enabled: false, credit_card_enabled: false },
    }));
};

// Ohne Fenster gibt es kein Maximieren: Masken bekommen die Breite eines ueblichen Bildschirms.
const HEADLESS_VIEWPORT = { width: 1920, height: 1080 };

/**
 * @param headless    ohne sichtbares Fenster, im neuen Headless-Modus von Chrome: dieselbe Engine, dieselbe Host-Sperre
 * @param insecureTls Zertifikate nicht pruefen, fuer interne Umgebungen mit eigener CA (Config `insecureTls`)
 */
const launchChrome = async (profileDir, hosts, { headless = false, insecureTls = false, embed = false, httpCredentials, launch = { channel: 'chrome' } } = {}) => {
    quietProfile(profileDir);
    try {
        return await chromium.launchPersistentContext(profileDir, {
            // Chrome des Systems, oder was die Config unter browser nennt (Edge, ein fester Pfad).
            ...launch,
            headless,
            // Strg+C beendet den Lauf mit Urteil und Aufraeumen. Playwright wuerde sonst sofort mit Exit 130 aussteigen.
            handleSIGINT: false,
            viewport: headless ? HEADLESS_VIEWPORT : null,
            // Keine Emulation: Die Seite folgt dem System wie in jedem Chrome. Sonst stellte Playwright sie fest auf hell, und mit
            // den DevTools fiele das weg und alles sprang mitten im Lauf in den dunklen Modus.
            colorScheme: null,
            // Nur auf Wunsch: Interne Umgebungen nutzen oft Zertifikate, die Chrome nicht kennt; die Host-Sperre begrenzt die Ziele.
            ignoreHTTPSErrors: insecureTls,
            // Fuer die Aktion download: Playwright legt Downloads in einen eigenen Ordner, der mit dem Browser verschwindet; der Agent
            // kommt nie daran, und die Aktion loescht ihre Datei gleich nach der Pruefung.
            acceptDownloads: true,
            serviceWorkers: 'block',
            // HTTP-Basic-Anmeldung nur fuer den Origin der Umgebung, nie fuer andere Hosts.
            ...(httpCredentials === undefined ? {} : { httpCredentials }),
            // Maximiert statt Vollbild: Masken bekommen die ganze Breite, und bei der Uebergabe bleiben Tabs und Adressleiste da.
            // Mit Werkbank: Die liefert Playwright aus, Chrome haelt sie fuer oeffentlich und sperrte sonst die Anwendung im internen Netz im iframe.
            // --test-type: Ohne ihn zeigt Chrome ueber der Werkbank eine Warnleiste zu --host-resolver-rules (so macht es auch chromedriver).
            args: [...(headless ? [] : ['--start-maximized', '--test-type']), ...browserArgs(hosts), ...(embed ? ['--disable-features=LocalNetworkAccessChecks'] : [])],
        });
    } catch (error) {
        throw new CawError('browser-missing', t('session.browser.chromeFailed', { error: error.message.split('\n')[0] }));
    }
};

/**
 * Die Zwischenablage fuer den Origin der Umgebung, lesen und schreiben: So kann eine Pruefung `navigator.clipboard.readText()`
 * aufrufen, etwa nach einem Knopf „Kopieren“. Andere Origins bekommen sie nicht.
 */
export const grantClipboard = (context, url) => context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });

/** devlink verpackt jeden Fehler beim Start als „Chrome nicht startbar“. Der eigentliche Grund steht in `cause`. */
export const unwrapLaunchError = (error) => (error?.cause instanceof CawError ? error.cause : error);

const FLOATS_BINDING = '__cawFloats';
const FLOATS_MAX_LINES = 5000;

/** Laeuft im Browser. Schreibt jede Aenderung der Fenster-Reihenfolge mit: Das Letzte in der Liste liegt oben. */
export function watchFloatsInPage(binding) {
    // Nur das Dokument der Anwendung: oben, oder mit Werkbank direkt darunter. Nie die Werkbank oder ihr Chat.
    if (window.__cawFloatsOn || window.__cawWorkbench === true || location.href === 'about:srcdoc') return;
    if (window !== window.top && window.parent !== window.top) return;
    window.__cawFloatsOn = true;
    const send = (text) => { if (window.__cawWorkbench !== true) window[binding]?.(`${Math.round(performance.now())}ms ${text}`); };
    const owner = (node) => node?.closest?.('[data-componentid]')?.getAttribute('data-componentid') ?? node?.tagName ?? '?';
    for (const name of ['mousedown', 'mouseup', 'click']) addEventListener(name, ({ target }) => send(`${name} ${owner(target)}`), true);
    let last = '';
    let tries = 0;
    const start = () => {
        const root = window.Ext?.floatRoot?.dom;
        if (!root) {
            tries += 1;
            if (tries < 240) setTimeout(start, 500);
            return;
        }
        const report = () => {
            const order = [...root.children].filter((node) => getComputedStyle(node).display !== 'none').map((node) => node.id).join(' < ');
            if (order !== last) send(`reihenfolge ${order}`);
            last = order;
        };
        new MutationObserver(report).observe(root, { childList: true, attributes: true, attributeFilter: ['class', 'style'], subtree: false });
        report();
    };
    start();
}

/** Nur Komponenten-Ids und Zeiten, keine Inhalte. Die Seite kann das Binding rufen, darum wird jede Zeile begrenzt. */
const logFloats = async (context, path) => {
    let lines = 0;
    await context.exposeBinding(FLOATS_BINDING, ({ page }, text) => {
        // Leere Seiten gehoeren nicht zur Anwendung.
        if (lines >= FLOATS_MAX_LINES || page.url() === 'about:blank') return;
        lines += 1;
        appendFileSync(path, `${String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 500)}\n`);
    });
    const script = `(${watchFloatsInPage})(${JSON.stringify(FLOATS_BINDING)});`;
    await context.addInitScript({ content: script });
    await Promise.all(context.pages().map((page) => page.evaluate(script).catch(() => {})));
};

/**
 * An- und Abmelden, Sitzung und Token: Das schreibt keine Fachdaten. Ein Test „falsches Passwort“ bleibt so lesend, und der
 * Bericht nennt nur, was die Anwendung wirklich geaendert haben kann.
 */
const AUTH_PATH = /(^|[/_.-])(log-?in|log-?out|sign-?in|sign-?out|sessions?|tokens?|refresh|auth|authenticate|anmelden|abmelden|csrf)$/i;

/**
 * Was der Lauf geschrieben haben kann, fuer den Bericht: jeder Aufruf ausser GET, HEAD und OPTIONS mit Pfad, dazu jeder Aufruf
 * mit einem Parameter aus `requestKeys` (etwa `action`), denn dort sehen lesende und schreibende gleich aus. Nie Inhalte.
 */
export const writeLabel = ({ method, url }, keys = []) => {
    const parsed = new URL(url);
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const named = [...parsed.searchParams].filter(([key]) => wanted.has(key.toLowerCase()));
    if (named.length > 0) return named.map(([key, value]) => `${key} ${value}`).join(', ');
    if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return null;
    return AUTH_PATH.test(parsed.pathname.replace(/\/+$/, '')) ? null : `${method.toUpperCase()} ${parsed.pathname}`;
};

/**
 * Fuer `auth.type: storageState`: Chrome oeffnet die Anmeldung, der Mensch meldet sich an (etwa per SSO), das Tool speichert die
 * Sitzung, sobald `signedInSelector` erscheint: Cookies, localStorage und den sessionStorage der Seite, auf der die Anmeldung
 * endete (Playwright speichert ihn nicht mit). Die Datei enthaelt Anmeldedaten des Testkontos: unter Unix nur fuer den eigenen
 * Nutzer lesbar, unter Windows gelten die Rechte des Projektordners.
 * @returns true, wenn gespeichert; false, wenn der Mensch das Fenster vorher schloss
 */
export const captureSession = async ({ url, signedInSelector, hosts, insecureTls = false, file, timeoutMs = 10 * 60 * 1000, launch }) => {
    sweepStaleProfiles();
    const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    writeFileSync(join(profileDir, PROFILE_OWNER), String(process.pid));
    const context = await launchChrome(profileDir, hosts, { insecureTls, ...(launch === undefined ? {} : { launch }) });
    try {
        const page = context.pages()[0] ?? await context.newPage();
        const closed = new Promise((ok) => { page.once('close', () => ok(false)); });
        await page.goto(url);
        const signedIn = page.waitForSelector(signedInSelector, { state: 'attached', timeout: timeoutMs }).then(() => true);
        if (!await Promise.race([signedIn, closed])) return false;
        const state = await context.storageState();
        const origin = new URL(page.url()).origin;
        const sessionItems = await page.evaluate(() => Object.entries(window.sessionStorage).map(([name, value]) => ({ name, value }))).catch(() => []);
        if (sessionItems.length > 0) {
            const own = state.origins.find((entry) => entry.origin === origin);
            if (own === undefined) state.origins.push({ origin, localStorage: [], sessionStorage: sessionItems });
            else own.sessionStorage = sessionItems;
        }
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
        chmodSync(file, 0o600);
        return true;
    } catch (error) {
        if (isBrowserClosedError(error)) return false;
        if (error?.name === 'TimeoutError') throw new CawError('auth-missing', t('session.browser.signInTimeout', { minutes: Math.round(timeoutMs / 60000), selector: signedInSelector }));
        throw error;
    } finally {
        await context.close().catch(() => {});
        await removeProfile(profileDir);
    }
};

/**
 * Fuer `caw-ai explore`: ein Fenster nur fuer den Host der Adresse, ohne Anmeldung durch das Tool. Sammelt Konsolenfehler und die
 * Hosts, die eine Seite oeffnen wollte und die gesperrt blieben (etwa ein SSO-Dienst).
 */
export const exploreBrowser = async ({ url, insecureTls = false, launch }) => {
    sweepStaleProfiles();
    const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    writeFileSync(join(profileDir, PROFILE_OWNER), String(process.pid));
    const own = new URL(url).hostname;
    const context = await launchChrome(profileDir, [own], { insecureTls, ...(launch === undefined ? {} : { launch }) });
    const page = context.pages()[0] ?? await context.newPage();
    const consoleErrors = [];
    const foreignHosts = new Set();
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push(String(error?.message ?? error)));
    context.on('requestfailed', (request) => {
        if (!request.isNavigationRequest()) return;
        const host = new URL(request.url()).hostname;
        if (host !== own) foreignHosts.add(host);
    });
    return {
        page,
        consoleErrors,
        foreignHosts,
        close: async () => {
            await context.close().catch(() => {});
            await removeProfile(profileDir);
        },
    };
};

/**
 * Oeffnet Chrome, meldet an, spielt den lokalen Code ein und wartet, bis die App zur Ruhe kommt.
 * @param spec.overlay null oder das Ergebnis von prepareOverlay: dann beantwortet es die Code-Requests
 */
export const openBrowserSession = async (spec) => {
    const { config, devlinkConfig, resolved, credentials, consoleIgnore, foreignCode, hosts } = spec;
    const overlay = spec.overlay ?? null;
    const parsed = parseConfig(devlinkConfig);
    if (!parsed.ok) throw new CawError('config-invalid', t('session.browser.devlinkRejected', { issues: JSON.stringify(parsed.issues) }));

    const startUrl = `${resolved.url}${spec.startUrl}`;
    const auth = authOf(config);
    const framework = frameworkOf(config);
    sweepStaleProfiles();
    // Jeder Lauf bekommt ein frisches Profil, es enthaelt am Ende die Login-Cookies des Testnutzers.
    const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    writeFileSync(join(profileDir, PROFILE_OWNER), String(process.pid));
    let raw = null;
    let host = null;
    let traceRunning = false;
    let closedSignal;
    const closed = new Promise((ok) => { closedSignal = ok; });
    // Wie lange die Vorbereitung dauerte: Die Werkbank steht erst danach und zeigt sie als bestandene Punkte.
    const timing = { start: Date.now(), chrome: null, login: null, code: null };

    const stopTrace = async () => {
        if (!traceRunning) return;
        traceRunning = false;
        await raw.tracing.stop({ path: spec.tracePath }).catch(() => {});
    };
    const ignoreClosedBrowser = (reason) => {
        if (!isBrowserClosedError(reason)) throw reason;
    };
    process.on('unhandledRejection', ignoreClosedBrowser);
    const close = async () => {
        await stopTrace();
        await host?.stop().catch(() => {});
        await raw?.close().catch(() => {});
        if (!await removeProfile(profileDir)) {
            console.error(t('session.browser.profileNotDeleted', { dir: profileDir }));
        }
        process.removeListener('unhandledRejection', ignoreClosedBrowser);
    };

    try {
        // Der Host startet den Browser erst nach seinem Preflight. Die Anmeldung haengt deshalb am Launcher.
        const launcher = createPlaywrightLauncher(async (dir) => {
            const httpCredentials = auth.type === 'basic' ? { username: credentials.login, password: credentials.password, origin: new URL(resolved.url).origin } : undefined;
            raw = await launchChrome(dir, hosts, { headless: spec.headless === true, insecureTls: config.insecureTls === true, embed: spec.embed === true, httpCredentials, launch: browserLaunch(config) });
            raw.on('close', closedSignal);
            await grantClipboard(raw, resolved.url);
            timing.chrome = Date.now();
            // Mit Werkbank: Nur ihr Tab, nicht Popups der Anwendung (window.open, target=_blank), in denen der Mensch auch vorfuehrt.
            // Skripte des Kontexts laufen vor denen des Tabs; darum pruefen sie die Markierung erst beim Ereignis.
            if (spec.embed === true) await raw.pages()[0].addInitScript({ content: WORKBENCH_MARK_SCRIPT });
            if (auth.type === 'storageState') await applyStorageState(raw, credentials.storageState);
            // Ueber die eigene Anmeldeseite: So laedt die Anwendung nicht schon einmal vor dem Einspielen des lokalen Codes.
            if (auth.type === 'form') {
                await ensureLoggedIn(raw, {
                    url: `${resolved.url}${auth.path}`,
                    marker: auth.signedInSelector,
                    login: credentials.login,
                    password: credentials.password,
                    totpSecret: credentials.totpSecret,
                    framework,
                    selectors: {
                        user: auth.userSelector,
                        password: auth.passwordSelector,
                        ...(auth.submitSelector === undefined ? {} : { submit: auth.submitSelector }),
                        ...(auth.codeSelector === undefined ? {} : { code: auth.codeSelector }),
                    },
                });
            }
            timing.login = Date.now();
            return raw;
        });
        host = createDevlinkHost(devlinkConfig, {
            launcher,
            now: () => Date.now(),
            sleep: (ms) => new Promise((ok) => { setTimeout(ok, ms); }),
        }, {
            profileDir,
            configPath: spec.devlinkConfigPath,
            // Ein Verifikationslauf darf bei Substitutionsfehlern nicht still den deployten Code testen.
            onFailure: 'fail',
            // Ohne Merkmal (keine Anmeldung, oder Basic ohne) prueft der Host nichts.
            authMarker: auth.signedInSelector ?? '',
        });
        // Der Host prueft das Merkmal auf der Startseite der Umgebung, bevor lokaler Code eingespielt wird. Seine Meldungen sind
        // allgemein gehalten; hier werden sie zu einem Hinweis, was im Projekt zu tun ist.
        await host.start().catch((error) => {
            const message = String(error?.message ?? '');
            if (/not signed in/.test(message)) {
                const next = auth.type === 'storageState'
                    ? t('session.browser.sessionExpired')
                    : t('session.browser.checkSelector');
                throw new CawError(auth.type === 'storageState' ? 'auth-missing' : 'login-failed', t('session.browser.markerMissing', { url: resolved.url, selector: auth.signedInSelector, next }));
            }
            throw error;
        });
        // Scheitert eine Quelle mitten im Lauf (bootstrap.json kaputt, zwei Apps mit demselben Build-Namen), ist das ein Fehler des Laufs.
        const failures = [];
        if (overlay !== null) {
            await routeOverlay(raw, overlay, { onProblem: (error, url) => failures.push({ type: 'overlay', text: String(error?.message ?? error), url }) });
        }
        timing.code = Date.now();
        if (spec.floatsLogPath !== undefined && framework.floats) await logFloats(raw, spec.floatsLogPath);

        // Eigene Beobachtung statt des Gates im Host, denn nur so bleibt die URL eines fehlgeschlagenen
        // Requests erhalten und laesst sich gegen consoleIgnore pruefen.
        let drained = 0;
        const warnings = [];
        const rules = { ignored: consoleIgnore.map((pattern) => new RegExp(pattern)), foreign: (foreignCode ?? []).map((pattern) => new RegExp(pattern)), skip: framework.stackSkip };
        const pages = trackAgentPages(raw.pages()[0]);
        const addWarning = (entry) => {
            const known = warnings.find(({ type, text }) => type === entry.type && text === entry.text);
            if (known === undefined) warnings.push({ ...entry, count: 1 });
            else known.count += 1;
        };
        // Meldungen der Werkbank und des Chats: Die Konsole nennt keinen Frame, wohl aber die Datei; ihre Skripte heissen caw-werkbank.js.
        const workbenchOrigin = spec.embed === true;
        // Beim Skriptfehler zaehlt, wo er geworfen wurde: die erste Zeile des Stacks nach der Meldung.
        const thrownAt = (stack) => (typeof stack === 'string' ? stack.split('\n').find((line) => /^\s+at /.test(line)) ?? '' : '');
        const fromWorkbench = (url, stack) => workbenchOrigin && (fromWorkbenchSource(url) || fromWorkbenchSource(thrownAt(stack)));
        const observe = (page, observation, url, stack) => {
            // Ohne Seite, z. B. bei Workern: lieber mitzaehlen als einen Fehler der Anwendung verschlucken.
            if (page === false || (page !== null && !pages.owns(page)) || fromWorkbench(url, stack)) return;
            if (observation.type !== 'http' && !isHardFailure(observation)) return;
            // Eingebettet ist das oberste Fenster die Werkbank: Greift die Seite darauf zu (window.top, parent), blockt der Browser. Das
            // bricht die Aktion der Anwendung ab und ist darum ein echter Fehler; die Erklaerung sagt, dass es an der Einbettung liegt.
            if (workbenchOrigin && CROSS_ORIGIN_TOP.test(observation.text)) {
                observation = { ...observation, text: `${observation.text} ${EMBED_HINT}` };
            }
            const severity = classifyFailure(observation, { url, stack }, rules);
            if (severity === 'ignore') return;
            const entry = { type: observation.type, text: observation.text, ...(url === undefined ? {} : { url }) };
            if (severity === 'warn') {
                addWarning({ ...entry, ...(stack === undefined ? {} : { origin: stackOrigin(stack, framework.stackSkip) }) });
                return null;
            }
            failures.push(entry);
            return entry;
        };
        // Skriptfehler zeigen auf den Quellcode, wenn die Anwendung Quellkarten ausliefert. Geladen nur von Hosts der Sperre, ueber den
        // Request-Kontext des Browsers, also mit denselben Cookies und TLS-Regeln.
        // Mit Overlay bekommt Chrome Skripte aus dem Projektordner. Skript und Quellkarte muessen dann von dort kommen, sonst passt die
        // Karte des deployten Stands nicht zum Code, der den Fehler warf. Liefert ein Dev-Server den Code, holt der Request-Kontext die
        // Karte: Er laeuft nicht ueber die Route, darum fragt fetchText das Overlay selbst.
        const readLocal = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
        // Das Skript, wie Chrome es bekam (bei einem Alias unter deploytem Namen der lokale Inhalt, denn nur der wirft Fehler), und die Karte
        // neben der lokalen Datei. Eine fehlende Karte ist keine Einladung, die deployte zu nehmen.
        const localText = async (url) => {
            if (overlay === null) return undefined;
            const file = overlay.fileFor(url);
            if (file !== undefined) return readLocal(file);
            const bare = url.replace(/[?#].*$/, '');
            if (bare.endsWith('.map')) {
                const owner = overlay.fileFor(bare.slice(0, -'.map'.length));
                if (owner !== undefined) return readLocal(`${owner}.map`);
            }
            const served = await overlay.resolve(url, bare.endsWith('.map') ? 'fetch' : 'script').catch(() => null);
            return served === null ? undefined : Buffer.from(served.body).toString('utf8');
        };
        // Ein Watch baut neu, die Namen fester statics bleiben: Die Karte gilt nur, solange die lokale Datei dieselbe ist.
        const localVersion = (url) => {
            const file = overlay?.fileFor(url);
            return file === undefined ? '' : fileVersion(file);
        };
        const sourceMaps = createSourceMapper({
            version: localVersion,
            fetchText: async (url) => {
                const local = await localText(url);
                if (local !== undefined) return local;
                // undefined: keine Verbindung (Name nicht aufloesbar, Port zu); null: der Server antwortete, aber nicht mit 2xx.
                // Keiner Weiterleitung folgen: `allowed` prueft nur die erste Adresse, und eine offene Weiterleitung auf einem erlaubten
                // Host (Anmeldedienste haben oft eine) fuehrte sonst einen Request vom Host-Rechner an eine beliebige Adresse.
                const get = async (target, options = {}) => {
                    const response = await raw.request.get(target, { timeout: 5000, maxRetries: 0, maxRedirects: 0, ...options }).catch(() => undefined);
                    if (response === undefined) return undefined;
                    return response.ok() ? response.text() : null;
                };
                const first = await get(url);
                const parsed = new URL(url);
                // Ein 404 fuer eine Karte, die es nicht gibt, ist eine Antwort; nur ohne Verbindung lohnt der zweite Weg.
                if (first !== undefined || !isLoopback(parsed.hostname) || parsed.hostname === '127.0.0.1') return first ?? null;
                // Der Request-Kontext loest Namen in Node auf, nicht ueber --host-resolver-rules: Unter Windows kennt Node `.localhost`
                // nicht, und `localhost` wird oft zu ::1, wo der Server nicht lauscht. Darum wie fuer Chrome ueber 127.0.0.1, mit dem
                // Namen im Host-Header und den Cookies, die der Browser dorthin schickte.
                const host = parsed.host;
                const cookie = (await raw.cookies(url).catch(() => [])).map(({ name, value }) => `${name}=${value}`).join('; ');
                parsed.hostname = '127.0.0.1';
                // Das Zertifikat nennt den Namen, nicht 127.0.0.1: Fuer diesen Umweg auf den eigenen Rechner zaehlt es nicht.
                return (await get(parsed.href, { headers: { host, ...(cookie === '' ? {} : { cookie }) }, ignoreHTTPSErrors: true })) ?? null;
            },
            allowed: (url) => hosts.includes(new URL(url).hostname),
        });
        const pageOfRequest = (request) => {
            try {
                return pages.pageOf(request.frame());
            } catch {
                return null;
            }
        };
        // Chrome meldet gescheiterte Requests zusaetzlich als Konsolenfehler. Die erfassen `response` und `requestfailed` schon, mit URL
        // und den Regeln fuer statische Dateien; doppelt gezaehlt machte jeder 404 eines Bildes und jeder fachliche 4xx den Lauf hart.
        const networkEcho = (message) => /^Failed to load resource:/.test(message.text());
        // Frameworks fangen Fehler oft selbst und schreiben sie samt Stack in die Konsole, statt sie fliegen zu lassen: Angular ueber
        // seinen ErrorHandler ("ERROR Error: …"), Vue im Produktions-Build, React nach einer Error Boundary. Dann zeigt der Stack wie
        // beim Skriptfehler auf die Quelle.
        const stackIn = (text) => (/\n\s+at .*https?:\/\//.test(text) ? text : undefined);
        raw.on('console', (message) => {
            if (networkEcho(message)) return;
            const text = message.text();
            const stack = message.type() === 'error' ? stackIn(text) : undefined;
            const entry = observe(message.page(), { type: 'console', level: message.type(), text }, message.location().url || undefined, stack);
            if (entry !== null && entry !== undefined && stack !== undefined) {
                sourceMaps.translate(stack, { skip: framework.stackSkip }).then(({ at, stack: mapped }) => {
                    if (at !== undefined) entry.at = at;
                    if (mapped.length > 0) entry.stack = mapped;
                }, () => {});
            }
        });
        raw.on('weberror', (webError) => {
            const error = webError.error();
            // Ohne Stack steht sonst nur "Object" im Bericht, und das sagt nichts.
            const text = error?.stack ? String(error) : `Nicht abgefangener Fehler ohne Stack, oft ein abgelehnter Promise: ${String(error)}`;
            const entry = observe(webError.page(), { type: 'pageerror', text }, undefined, error?.stack || undefined);
            if (entry !== null && entry !== undefined && error?.stack) {
                sourceMaps.translate(error.stack, { skip: framework.stackSkip }).then(({ at, stack }) => {
                    if (at !== undefined) entry.at = at;
                    if (stack.length > 0) entry.stack = stack;
                }, () => {});
            }
        });
        raw.on('requestfailed', (request) => observe(pageOfRequest(request), { type: 'requestfailed', text: request.failure()?.errorText ?? '' }, request.url()));
        raw.on('response', (response) => {
            if (response.status() >= 500) observe(pageOfRequest(response.request()), { type: 'http', text: `HTTP ${response.status()}` }, response.url());
        });

        const writes = new Map();
        const hidden = [];
        // Belege fuer die Einordnung eines Fehlers: nur Anfragen der Anwendung selbst, keine Seiten, Skripte oder Bilder.
        const network = createNetworkLog();
        const asked = (request) => ['xhr', 'fetch'].includes(request.resourceType());
        const watchNavigation = (page) => {
            page.on('domcontentloaded', () => network.replaced(page));
            // Playwright meldet auch Wechsel im selben Dokument (History-API, Hash), also die Routen einer Single-Page-App. Zaehlt
            // nur der oberste Frame der Anwendung: der Hauptframe, in der Werkbank das iframe der Anwendung.
            page.on('framenavigated', (frame) => {
                const owner = pages.pageOf(frame);
                if (owner === null || owner === false) return;
                if (frame.parentFrame() === null || frame.name() === APP_FRAME) network.routed(owner);
            });
        };
        raw.pages().forEach(watchNavigation);
        raw.on('page', watchNavigation);
        raw.on('request', (request) => {
            const page = pageOfRequest(request);
            if (page === false || (page !== null && !pages.owns(page))) return;
            const label = writeLabel({ method: request.method(), url: request.url() }, config.requestKeys ?? []);
            if (label !== null) writes.set(label, (writes.get(label) ?? 0) + 1);
            // Ein Seitenwechsel beginnt mit der Anfrage des Hauptframes, vor jedem Abbruch, den er ausloest. Hash-Wechsel stellen keine.
            if (page !== null && request.isNavigationRequest() && request.frame() === page.mainFrame()) network.navigating(page);
            if (asked(request)) {
                const keys = config.requestKeys ?? [];
                const params = parameterNames({ url: request.url(), postData: request.postData(), contentType: request.headers()['content-type'] ?? '' }, keys);
                network.started(request, { name: requestName({ method: request.method(), url: request.url() }, keys), page, params });
            }
        });
        // Fertig erst mit dem Inhalt, nicht schon mit den Kopfzeilen: Sonst zaehlt das Warten einen Request als erledigt, dessen
        // Antwort die Anwendung noch gar nicht verarbeiten konnte.
        // Kopfzeilen: Ein Stream endet erst mit der Seite, und mancher Proxy meldet nie ein Ende. Danach zaehlt das Warten nur noch kurz.
        raw.on('response', (response) => {
            network.answered(response.request(), response.status(), STREAM_TYPE.test(response.headers()['content-type'] ?? ''));
        });
        raw.on('requestfinished', (request) => {
            request.response().then((response) => { if (response !== null) network.finished(request, response.status()); }, () => {});
        });

        // Spur fuer die Wirkung einer Aktion: Konsole und Form der JSON-Antworten, ohne Werte.
        const trail = [];
        raw.on('console', (message) => {
            const page = message.page();
            const url = message.location().url;
            if ((page !== null && !pages.owns(page)) || fromWorkbench(url)) return;
            // Nur Fehler, und nur, was nicht erlaubt oder fremd ist: Sonst liesse ein seltenes Log, eine zeitabhaengige Warnung von Chrome
            // oder eine erlaubte Seitenmeldung den Schritt als Fehler der Anwendung scheitern.
            if (message.type() !== 'error' || networkEcho(message)) return;
            if (rules.ignored.some((pattern) => pattern.test(message.text()) || (url && pattern.test(url)))) return;
            if (url && rules.foreign.some((pattern) => pattern.test(url))) return;
            trail.push({ kind: 'console', line: `${message.type()}: ${message.text()}` });
        });
        raw.on('response', (response) => {
            const request = response.request();
            const page = pageOfRequest(request);
            if (!asked(request) || page === false || (page !== null && !pages.owns(page))) return;
            if (!/json|javascript|text\/plain/i.test(response.headers()['content-type'] ?? '')) return;
            // Der Platz in der Spur steht sofort fest, der Inhalt kommt nach.
            const entry = { kind: 'response', line: null };
            trail.push(entry);
            response.text().then((body) => {
                entry.line = responseLine(requestName({ method: request.method(), url: request.url() }, config.requestKeys ?? []), JSON.parse(body));
            }).catch(() => {});
        });
        raw.on('requestfailed', (request) => network.failed(request, request.failure()?.errorText ?? ''));

        // Snapshots tragen die Requests samt Headern in den Trace; bei basic stuende das Passwort im Authorization-Header.
        // Mit Werkbank sitzt ein Mensch davor: Der laufende Bildmitschnitt machte die Seite spuerbar zaeh (und den Trace riesig).
        await raw.tracing.start({ screenshots: spec.embed !== true, snapshots: auth.type !== 'basic' });
        traceRunning = true;

        // host.start() bindet die Interception erst nach dem Laden der Startseite ein; erst diese
        // Navigation laedt die App also mit dem lokalen Code.
        let bench = null;
        // Mit Overlay tauscht jede Seite der Anwendung die Code-Tags der App gegen die der lokalen Seite (rewritePage), ohne integrity:
        // Lokaler Code hat andere Bytes. Der Rest der Seite bleibt der des Servers.
        const rewrite = overlay === null ? undefined : overlay.rewritePage;
        const appHosts = [new URL(resolved.url).hostname];
        if (spec.embed === true) {
            // Einbetten nur fuer Dokumente der Anwendung selbst, nicht fuer weitere erlaubte Hosts wie einen Anmeldedienst.
            bench = await openWorkbench(raw, { appUrl: startUrl, hosts: appHosts, title: spec.title ?? 'caw-ai', rewrite });
            pages.embed(bench.page, bench.view);
            bench.view.on('domcontentloaded', () => network.replaced(bench.view));
            const signIn = auth.type === 'form' || auth.type === 'basic' ? t('session.prep.signIn') : auth.type === 'storageState' ? t('session.prep.takeSession') : null;
            const points = [
                { id: 'chrome', kind: t('session.prep.chrome'), label: t('session.prep.chromeStart'), ms: (timing.chrome ?? timing.start) - timing.start },
                ...(signIn === null ? [] : [{ id: 'login', kind: signIn, label: spec.role === undefined ? '' : t('session.prep.asRole', { role: spec.role }), ms: (timing.login ?? timing.chrome) - (timing.chrome ?? timing.start) }]),
                ...(overlay !== null ? [{ id: 'code', kind: t('session.prep.code'), label: t('session.prep.codeLocal'), ms: timing.code - (timing.login ?? timing.chrome ?? timing.start) }] : []),
                { id: 'load', kind: t('session.prep.load'), label: t('session.prep.app') },
            ];
            await bench.group({ id: PREP, name: t('session.prep.group'), kind: 'phase', points: points.map(({ id, kind, label }) => ({ id, kind, label })) });
            for (const { id, ms } of points) if (ms !== undefined) await bench.point(PREP, id, 'pass', { ms: Math.max(0, ms) });
            await bench.point(PREP, 'load', 'running');
        } else {
            if (rewrite !== undefined) await interceptDocuments(raw, raw.pages()[0], appHosts, { request: raw.request, rewrite });
            await raw.pages()[0].goto(startUrl, { waitUntil: 'load' });
        }
        // Ruhe laut Framework-Adapter, beim neutralen Adapter auch ohne offene Requests der Seite.
        const waitReady = (args = {}) => waitQuiet(framework, pages.current(), { ...args, pending: (page) => network.pending(page) });
        const ready = await waitReady({ timeout: spec.readyTimeoutMs });
        await bench?.point(PREP, 'load', ready.settled && ready.lastSample?.appReady === true ? 'pass' : 'fail', ready.settled ? {} : { note: ready.reason });
        if (!ready.settled) throw new CawError('app-not-settled', t('session.browser.notSettled', { reason: ready.reason }));
        if (ready.lastSample?.appReady !== true) throw new CawError('app-not-loaded', t('session.browser.notLoaded', { url: startUrl, framework: framework.label }));

        // Die Werkbank zeigt Adresse, Requests und Konsole der Anwendung; einmal je Sekunde, solange sie offen ist.
        if (bench !== null) {
            const pump = setInterval(() => {
                if (bench.page.isClosed()) {
                    clearInterval(pump);
                    return;
                }
                const current = pages.current();
                bench.url(current.url());
                bench.panels({
                    requests: network.since(0).map((request) => ({ name: request.name, outcome: request.outcome, result: outcomeText(request), ms: request.ms })),
                    console: [...failures.map(({ type, text, url }) => ({ severity: 'fail', text: `${type}: ${text}${url ? ` (${url})` : ''}` })), ...warnings.map(({ type, text, count }) => ({ severity: 'warn', text: `${type}: ${text}${count > 1 ? ` (${count}x)` : ''}` }))],
                });
            }, bench.PANEL_MS);
            pump.unref?.();
            raw.on('close', () => clearInterval(pump));
        }

        return {
            writes: () => [...writes].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => ({ label, count })),
            // Nur fuers Mitschneiden einer Vorfuehrung, der Agent kommt ueber den Kanal nie daran.
            context: raw,
            ownsPage: (page) => pages.owns(page),
            /** Gehoert der Frame zur Anwendung? Nie Werkbank oder Chat, nie Tabs des Menschen. */
            ownsFrame: (frame) => {
                const page = pages.pageOf(frame);
                return page !== false && page !== null && pages.owns(page);
            },
            /** Die Werkbank (Schritte, Chat, Requests), wenn die Anwendung eingebettet laeuft, sonst null. */
            workbench: bench,
            /** Der Anwendungs-Tab oder sein neuestes offenes Popup, nie ein Tab des Menschen. */
            page: () => pages.current(),
            waitReady,
            /** Die aktuelle Seite neu laden wie F5 mit leerem Cache, damit geaenderter Code sicher ankommt; Fehler meldet waitReady. */
            reloadPage: async () => {
                const cdp = await raw.newCDPSession(bench?.page ?? raw.pages()[0]).catch(() => null);
                await cdp?.send('Network.clearBrowserCache').catch(() => {});
                await cdp?.detach().catch(() => {});
                await pages.current().reload({ waitUntil: 'load' });
                return waitReady({ timeout: spec.readyTimeoutMs });
            },
            /** Zurueck auf die Startseite der App, mit frischem Code, und warten, bis sie bereit ist. */
            // Die Anwendung selbst, nicht ihr neuestes Popup: Sonst luede die Startseite im Popup, ausserhalb der Werkbank. Offene Popups
            // gehoeren zum verlassenen Zustand und gehen zu.
            restart: async () => {
                for (const popup of pages.popups()) await popup.close().catch(() => {});
                await pages.main().goto(startUrl, { waitUntil: 'load' });
                return waitReady({ timeout: spec.readyTimeoutMs });
            },
            /** Der Framework-Adapter: Ziele, Seitenzustand, Bereitschaft. */
            framework,
            failures: () => failures,
            /** Was nie als Text aus dem Browser gehen darf: das Passwort der Rolle und geheim gemerkte Werte. */
            secrets: () => [...(credentials?.password === undefined ? [] : [credentials.password]), ...hidden],
            /** Ein Wert, der ab jetzt wie das Passwort geschwaerzt wird, etwa aus `remember` mit `secret: true`. */
            hide: (value) => { if (typeof value === 'string' && !hidden.includes(value)) hidden.push(value); },
            warnings: () => warnings,
            /** Das Request-Protokoll: `mark()` vor einem Schritt, `since(mark)` danach. */
            network: { mark: () => network.mark(), since: (mark, end) => network.since(mark, end) },
            /** Konsole und Antworten fuer die Wirkung einer Aktion: `mark()` davor, `since(mark)` danach. */
            trail: { mark: () => trail.length, since: (mark) => trail.slice(mark).filter(({ line }) => line !== null) },
            /** Eine Warnung, die nicht aus dem Browser kommt, etwa eine abweichende Wirkung in einem bestandenen Lauf. */
            warn: (entry) => addWarning(entry),
            /** CSS-Selektoren der Meldungen auf der Seite, aus der Config. */
            messageSelectors: config.messageSelectors ?? framework.messageSelectors ?? DEFAULT_MESSAGE_SELECTORS,
            /**
             * Nimmt die Fehler von `from` bis vor `to` zurueck: Sie gehoeren zu einem Versuch, den `retry` wiederholt. Was danach kam,
             * etwa ein Skriptfehler der neu geladenen Seite, bleibt.
             */
            retractFailures: (from, to = failures.length) => {
                const end = Math.min(Math.max(to, from), failures.length);
                failures.splice(from, end - from);
                if (drained > end) drained -= end - from;
                else if (drained > from) drained = from;
            },
            drainFailures: () => {
                const fresh = failures.slice(drained);
                drained = failures.length;
                return { failures: fresh, total: failures.length };
            },
            stopTrace,
            closed,
            close,
        };
    } catch (error) {
        await close();
        throw unwrapLaunchError(error);
    }
};
