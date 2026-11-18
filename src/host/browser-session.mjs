// The browser runs visibly on the host so a human can take over the same page. The flags set the boundary:
// Chrome only reaches the allowed hosts. A CDP port is never opened.

import { classifyFailure, stackOrigin } from '../shared/report.mjs';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { totp } from '../shared/totp.mjs';
import { createDialogs } from './dialogs.mjs';
import { createDevlinkHost, createPlaywrightLauncher, isHardFailure, parseConfig } from './devlink-core.mjs';
import { fileVersion, incompleteText, routeOverlay } from '../ext/overlay/overlay.mjs';
import { DEFAULT_MESSAGE_SELECTORS, browserLaunch, isLoopback, isViewport } from '../shared/config.mjs';
import { frameworkOf, waitQuiet } from './framework/index.mjs';
import { registerEngines } from '../ext/extjs/extjs-engine.mjs';
import { responseLine } from './effects.mjs';
import { APP_FRAME, WORKBENCH_MARK_SCRIPT, fromWorkbenchSource, interceptDocuments } from './app-view.mjs';
import { createSourceMapper } from './source-maps.mjs';
import { basicAuthToken, scrubTrace } from './trace-scrub.mjs';
import { ANY_HOST, browserArgs, installHostLock, isTopNavigation, withLoopbackPair } from './host-lock.mjs';
import { classifyRequest, compileReads } from '../shared/requests.mjs';
import { appHosts as appHostsOf, blockedHosts, normalizeHost } from '../shared/environments.mjs';
import { createNetworkLog, outcomeText, parameterNames, requestName } from './network-log.mjs';
import { PREP, openWorkbench } from './workbench.mjs';

/** Access from the iframe to the top window, which has a different origin in the workbench. */
export const CROSS_ORIGIN_TOP = /Blocked a frame with origin .* from accessing a cross-origin frame/;
export const EMBED_HINT = '(The application accesses the top window. That is the workbench, and it is currently on a different address than the application, e.g. after a redirect: the browser blocks the access and the action aborts. This does not happen without the workbench (--no-chat).)';

const LOGIN_TIMEOUT_MS = 30_000;
// Upper bound for sign-in to wait for network idle and for the framework to take over the page. A sign-in page outside the app
// (e.g. an identity provider) never mounts the framework; sign-in carries on after this anyway.
const LOGIN_HYDRATE_MS = 10_000;
const LOGIN_MOUNT_MS = 5_000;
// How long the application may take to answer a one-time code; if the code field is still there afterwards, it was rejected.
const CODE_ANSWER_MS = 10_000;
// A TOTP code is valid for 30 s. The new code is sent shortly after the next window starts, in case the clocks differ slightly.
const TOTP_WINDOW_MS = 30_000;
const NEXT_WINDOW_MARGIN_MS = 1000;
// After submitting: if the form sits there quietly this long (page loaded, no request open), the application rejected the sign-in.
const LOGIN_REJECT_QUIET_MS = 3000;
// Form gone, page done and quiet, but the marker is missing: grace period for late-rendering pages before the marker counts as wrong.
const LOGIN_MARKER_QUIET_MS = 5000;
// After loading: how long a form may still appear (rendered by the framework) before the selector counts as wrong.
const LOGIN_FORM_MS = 8000;
// Sign-in steps (signIn.steps): how long a step waits for its element, an optional one only briefly ("Stay signed in?").
const STEP_TIMEOUT_MS = 30_000;
const OPTIONAL_STEP_MS = 3000;
const LOGIN_POLL_MS = 250;
// A request open longer than this no longer counts as sign-in work (long polling, streams).
const LOGIN_STALE_REQUEST_MS = 10_000;
const sleepMs = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
/** Responses that stay open as long as the page lives: server-sent events and line-delimited JSON. */
export const STREAM_TYPE = /text\/event-stream|application\/(x-)?ndjson|application\/stream\+json|application\/jsonl/i;
const PROFILE_PREFIX = 'caw-profile-';
const PROFILE_OWNER = 'caw-owner';
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes the profile. On Windows, Chrome processes keep files locked briefly after closing, hence several attempts.
 * If it fails for good, that must not change the run's outcome: the verdict stands.
 */
export const removeProfile = async (dir, { remove = rmSync, attempts = 20, delayMs = 500 } = {}) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            remove(dir, { recursive: true, force: true });
            return true;
        } catch {
            if (attempt < attempts) await sleepMs(delayMs);
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
 * Cleans up profiles of earlier runs that could not be deleted, e.g. after an abort. They contain the test account's
 * login cookies. A running session is left alone: every profile names its process. A profile without that entry (e.g. one
 * whose entry was not written yet) only counts as orphaned after a day.
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
                // Still locked: the next run tries again.
            }
        }
    }
    return removed;
};

/** When a human closes the window, pending overlay requests may still fail. Only that is harmless. */
export const isBrowserClosedError = (reason) => /has been closed|Target closed|browser has disconnected/i.test(String(reason?.message ?? reason));

/**
 * Which tabs belong to the test: the application tab and its popups. The window is visible, so a human can open
 * their own tabs at any time. Those get no agent commands, and their errors do not count.
 */
export const trackAgentPages = (first, { onDialog } = {}) => {
    const owned = new Set();
    const open = [];
    // With the workbench: the application is a frame inside it (`view`). Workbench and chat are not part of the test.
    let workbench = null;
    let view = null;
    const add = (page) => {
        owned.add(page);
        open.push(page);
        page.on('popup', add);
        // A dialog blocks its page until answered: every tab of the test answers through the one handler (dialogs.mjs).
        if (onDialog !== undefined) page.on('dialog', onDialog);
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
        /** The application itself, never a popup: the first tab or the workbench iframe. */
        main: () => view ?? first,
        /** The application's open popups, newest last. */
        popups: () => open.filter((page) => page !== (view ?? first)),
        owns: (page) => owned.has(page),
        /** From now on the application runs in the iframe of workbench `page`. */
        embed: (page, frameView) => {
            workbench = page;
            view = frameView;
            owned.add(view);
            const at = open.indexOf(page);
            if (at !== -1) open[at] = view;
        },
        /**
         * What does a frame belong to? The page, with the workbench the application, or `false` for workbench and chat themselves.
         * Without a frame (workers) null: better to count it than to swallow an application error.
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
 * Signs the browser in if needed. Credentials stay on the host; the trace only starts after sign-in, and no message
 * contains them.
 * @param on the page to sign in on; defaults to the first tab (before the workbench), when signing in again the application frame
 */
const ensureLoggedIn = async (context, { url, marker, login, password, totpSecret, selectors, steps, onCode, framework, on }) => {
    const page = on ?? context.pages()[0];
    const broken = watchBroken(page);
    // Only the SPA adapters: their sign-in page is usually part of the app. `web` and `extjs` (portal sign-in without Ext) skip this.
    const originOf = (address) => { try { return new URL(address).origin; } catch { return null; } };
    // A foreign sign-in page (Keycloak, Entra) has no app framework: waiting there would just cost LOGIN_MOUNT_MS.
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
        if (steps === undefined) await loginSteps(page, { url, marker, login, password, totpSecret, selectors, ready, onCode });
        else await stepSignIn(page, { url, marker, steps, login, password, totpSecret, ready, onCode });
    } catch (error) {
        const seen = broken.text();
        if (seen !== '' && error instanceof CawError) error.message = `${error.message} ${seen}`;
        if (error instanceof CawError) error.evidence = await loginEvidence(page, { marker, ...selectors });
        throw error;
    } finally {
        broken.stop();
    }
};

// What a session leaves in the browser besides cookies (those go for all origins with clearCookies).
const SITE_DATA = 'local_storage,indexeddb,cache_storage,service_workers,websql,file_systems';

/**
 * A new session in the same window, like a new run with a fresh profile: cookies of all origins, plus localStorage, IndexedDB,
 * Cache Storage and service workers of the origins the application shows, and its sessionStorage. Only the workbench keys
 * (`caw-`) stay: the workbench shares the origin with the application, not its data.
 * @param context the browser context
 * @param view    the application (page or workbench frame)
 * @param base    the environment address; its origin is always cleared
 */
export const freshSession = async (context, view, base) => {
    await context.clearCookies();
    // Chrome also clears sessionStorage along with the storage: save the workbench keys first, write them back afterwards.
    /* eslint-disable n/no-unsupported-features/node-builtins -- sessionStorage here is the browser's, inside page.evaluate */
    const kept = await view.evaluate(() => {
        try {
            const own = Object.keys(sessionStorage).filter((key) => key.startsWith('caw-')).map((key) => [key, sessionStorage.getItem(key)]);
            sessionStorage.clear();
            return own;
        } catch {
            return [];
        }
    }).catch(() => []);
    /* eslint-enable n/no-unsupported-features/node-builtins */
    const origins = new Set([new URL(base).origin]);
    for (const address of [view.url(), ...(view.frames?.() ?? []).map((frame) => frame.url())]) {
        try {
            const { origin, protocol } = new URL(address);
            if (protocol === 'http:' || protocol === 'https:') origins.add(origin);
        } catch {
            // not an address
        }
    }
    const cdp = await context.newCDPSession(view.workbench ?? context.pages()[0]).catch(() => null);
    try {
        for (const origin of origins) await cdp?.send('Storage.clearDataForOrigin', { origin, storageTypes: SITE_DATA }).catch(() => {});
    } finally {
        await cdp?.detach().catch(() => {});
    }
    await view.evaluate((own) => {
        try {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser page
            for (const [key, value] of own) sessionStorage.setItem(key, value);
        } catch {
            // no access
        }
    }, kept).catch(() => {});
    return [...origins];
};

/**
 * What fails on the network during sign-in: without a backend the only symptom would otherwise be "no sign-in form". Method and
 * path only, parameters could contain credentials.
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

// If the application asks for a one-time code after the password (`codeSelector`), the role enters it from its TOTP secret.
/**
 * Fills a sign-in field (user, password, code, a step's value). Playwright names the filled text in its error message and call
 * log (`- fill("…")`) when the element is found but cannot take it, and run and CLI print that message: the failure says which
 * field it was, never the value, and keeps nothing of Playwright's error.
 * @param field the config key and selector or the step, for the message
 */
export const fillSecret = async (fill, field) => {
    try {
        await fill();
    } catch {
        throw new CawError('login-failed', t('session.browser.fillFailed', { field }));
    }
};

// A code is only valid once: if the same account already signed in within the same 30 s window, e.g. in the previous test, the
// application rejects it. Then exactly one retry with the next window's code; if that fails too, loginSteps reports the sign-in as failed.
const secondFactor = async (page, { marker, totpSecret, selectors, now, sleep, onCode = () => {} }) => {
    if (selectors.code === undefined) return;
    const next = await Promise.race([
        page.waitForSelector(marker, { timeout: LOGIN_TIMEOUT_MS }).then(() => 'signed-in'),
        page.waitForSelector(selectors.code, { timeout: LOGIN_TIMEOUT_MS }).then(() => 'code'),
    ]).catch(() => null);
    if (next !== 'code') return;
    if (totpSecret === undefined) throw new CawError('login-failed', t('session.browser.codeWithoutSecret', { selector: selectors.code }));
    const submit = async () => {
        const at = now();
        const code = totp(totpSecret, at);
        onCode(code);
        await fillSecret(() => page.fill(selectors.code, code), `codeSelector "${selectors.code}"`);
        await page.press(selectors.code, 'Enter');
        return at;
    };
    const sentAt = await submit();
    const codeStays = async () => (await page.$(marker)) === null && page.isVisible(selectors.code).catch(() => false);
    const accepted = await page.waitForSelector(marker, { timeout: CODE_ANSWER_MS }).then(() => true, () => false);
    if (accepted || !await codeStays()) return;
    const nextWindow = (Math.floor(sentAt / TOTP_WINDOW_MS) + 1) * TOTP_WINDOW_MS;
    await sleep(Math.max(0, nextWindow - now()) + NEXT_WINDOW_MARGIN_MS);
    if (await codeStays()) await submit();
};

/** Open requests of the page (documents, XHR, fetch), so "quiet" does not apply in the middle of a slow response. */
const trackRequests = (page, now) => {
    if (typeof page.on !== 'function') return { open: () => 0, stop: () => {} };
    const open = new Map();
    const relevant = (request) => ['document', 'xhr', 'fetch'].includes(request.resourceType?.());
    const start = (request) => { if (relevant(request)) open.set(request, now()); };
    const end = (request) => { open.delete(request); };
    page.on('request', start);
    page.on('requestfinished', end);
    page.on('requestfailed', end);
    return {
        open: () => [...open.values()].filter((since) => now() - since < LOGIN_STALE_REQUEST_MS).length,
        stop: () => {
            page.off?.('request', start);
            page.off?.('requestfinished', end);
            page.off?.('requestfailed', end);
        },
    };
};

/**
 * Waits for the outcome after submitting without sitting out the full timeout: marker present, form quietly back (rejected),
 * or page done and quiet with neither form nor marker (wrong marker). Quiet means: address, load state and form unchanged,
 * no request open.
 * @returns 'signed-in' | 'form' | 'no-marker' | 'timeout'
 */
export const waitForLoginOutcome = async (page, { marker, selectors, now = Date.now, sleep = sleepMs, requests = { open: () => 0 } }) => {
    const start = now();
    let state = null;
    let since = start;
    while (now() - start < LOGIN_TIMEOUT_MS) {
        if (await page.$(marker).catch(() => null) !== null) return 'signed-in';
        const loaded = typeof page.evaluate === 'function' ? await page.evaluate(() => document.readyState).catch(() => 'loading') : 'complete';
        const form = await page.isVisible(selectors.password).catch(() => false);
        const next = `${page.url()}|${loaded}|${form}`;
        if (next !== state || requests.open() > 0) {
            state = next;
            since = now();
        }
        const quiet = now() - since;
        if (loaded === 'complete' && form && quiet >= LOGIN_REJECT_QUIET_MS) return 'form';
        if (loaded === 'complete' && !form && quiet >= LOGIN_MARKER_QUIET_MS) return 'no-marker';
        await sleep(LOGIN_POLL_MS);
    }
    return 'timeout';
};

/**
 * What was on the page when sign-in failed: how often each config selector matches, and what explore would consider stable there
 * (fields, buttons, classes on html/body). No field values, no address parameters. The basis for Claude's proposal.
 */
export const loginEvidence = async (page, selectors) => {
    try {
        const { surveyPage } = await import('./explore.mjs');
        const hits = {};
        for (const [key, selector] of Object.entries(selectors)) {
            if (typeof selector === 'string') hits[key] = { selector, count: await page.locator(selector).count().catch(() => -1) };
        }
        const survey = await page.evaluate(surveyPage, 200).catch(() => null);
        const address = new URL(page.url());
        return {
            path: address.pathname,
            title: survey?.title ?? '',
            hits,
            login: survey?.login ?? null,
            stateClasses: survey?.stateClasses ?? [],
            // No texts: a user menu often shows the account name.
            markers: (survey?.markers ?? []).slice(0, 120).map(({ selector, tag, role }) => ({ selector, tag, role })),
        };
    } catch {
        return null;
    }
};

export const loginSteps = async (page, { url, marker, login, password, totpSecret, selectors, ready, onCode, now = Date.now, sleep = sleepMs }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Load the page fully first, then only wait briefly for a form rendered by the framework: a wrong selector shows up
    // after seconds, not after the full timeout.
    await page.waitForLoadState('load', { timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
    await page.waitForSelector(`${marker}, ${selectors.user}`, { timeout: LOGIN_FORM_MS }).catch(() => {
        throw new CawError('login-form-missing', t('session.browser.loginFormMissing', { marker, url }));
    });
    if (await page.$(marker) !== null) return;
    // Before load the form is often there but does not submit yet: Enter would go nowhere.
    await page.waitForLoadState('load', { timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
    // Server-side rendered (Nuxt, Next.js, Angular SSR), the form is there before the framework takes over. Filling it earlier
    // loses the values on hydration, or Enter submits the form natively (GET, fields in the URL).
    if (ready !== undefined) {
        await page.waitForLoadState('networkidle', { timeout: LOGIN_HYDRATE_MS }).catch(() => {});
        await ready(page);
        if (await page.$(marker) !== null) return;
    }
    if (await page.$(selectors.password) === null) {
        throw new CawError('login-failed', t('session.browser.selectorMissing', { key: 'passwordSelector', selector: selectors.password }));
    }
    // A missing button would otherwise hang until the click timeout.
    if (selectors.submit !== undefined && await page.$(selectors.submit) === null) {
        throw new CawError('login-failed', t('session.browser.selectorMissing', { key: 'submitSelector', selector: selectors.submit }));
    }
    await fillSecret(() => page.fill(selectors.user, login), `userSelector "${selectors.user}"`);
    await fillSecret(() => page.fill(selectors.password, password), `passwordSelector "${selectors.password}"`);
    const requests = trackRequests(page, now);
    try {
        if (selectors.submit === undefined) await page.press(selectors.password, 'Enter');
        else await page.click(selectors.submit);
        await secondFactor(page, { marker, totpSecret, selectors, now, sleep, onCode });
        let outcome = await waitForLoginOutcome(page, { marker, selectors, now, sleep, requests });
        // A cold portal redirects but does not finish rendering the next page in time: reload once, then the result counts.
        if (outcome === 'no-marker' || outcome === 'timeout') {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            outcome = await waitForLoginOutcome(page, { marker, selectors, now, sleep, requests });
        }
        if (outcome === 'signed-in') return;
        // Path only: parameters could contain sign-in data.
        const path = new URL(page.url()).pathname;
        if (outcome === 'form') throw new CawError('login-failed', t('session.browser.loginRejected', { url, path }));
        throw new CawError('login-failed', t('session.browser.loginFailed', { url, marker, path }));
    } finally {
        requests.stop();
    }
};

/** A step as the person wrote it, for messages: its verb and selector or key, never a value. */
const stepLabel = (step, index) => {
    const verb = ['fill', 'click', 'press', 'waitFor'].find((key) => step[key] !== undefined);
    return `${index + 1} (${verb} ${step[verb]}${step.with === undefined ? '' : ` with ${step.with}`})`;
};

/**
 * Sign-in by `signIn.steps` (multi-page, identifier first, an IdP, extra prompts): in order, from `<env url><path>`, on whatever
 * page is current; a host outside the navigation lock fails the step. `fill` with `user`, `password` or `totp` takes the
 * role's account (a fresh code each time), `value` a fixed text. An optional step is skipped when its element is not visible
 * within 3 s. Afterwards signedInSelector must appear. A refused code (the account signed in within the same 30 s window) is
 * sent once more with the next window's code, from the `with: totp` step on.
 * @param onCode receives every code sent, so the session masks it like the password
 */
export const stepSignIn = async (page, { url, marker, steps, login, password, totpSecret, ready, onCode = () => {}, now = Date.now, sleep = sleepMs }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load', { timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
    if (ready !== undefined) await ready(page);
    if (await page.$(marker) !== null) return;
    let codeAt;
    const valueOf = (step) => {
        if (step.value !== undefined) return step.value;
        if (step.with === 'user') return login;
        if (step.with === 'password') return password;
        if (totpSecret === undefined) throw new CawError('login-failed', t('session.browser.codeWithoutSecret', { selector: step.fill }));
        codeAt = now();
        const code = totp(totpSecret, codeAt);
        onCode(code);
        return code;
    };
    const run = async (from) => {
        for (let index = from; index < steps.length; index += 1) {
            const step = steps[index];
            const timeout = step.optional === true ? OPTIONAL_STEP_MS : step.timeoutMs ?? STEP_TIMEOUT_MS;
            const selector = step.fill ?? step.click ?? step.waitFor ?? step.on;
            if (selector !== undefined) {
                const visible = await page.locator(selector).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
                if (!visible) {
                    if (step.optional === true) continue;
                    // Path only: parameters could contain sign-in data.
                    throw new CawError('login-failed', t('session.browser.stepMissing', { step: stepLabel(step, index), path: new URL(page.url()).pathname }));
                }
            }
            if (step.fill !== undefined) {
                const value = valueOf(step);
                await fillSecret(() => page.locator(step.fill).first().fill(value), `signIn.steps ${stepLabel(step, index)}`);
            }
            else if (step.click !== undefined) await page.locator(step.click).first().click({ timeout });
            else if (step.press !== undefined && step.on !== undefined) await page.locator(step.on).first().press(step.press);
            else if (step.press !== undefined) await page.keyboard.press(step.press);
        }
    };
    await run(0);
    const codeStep = steps.findIndex((step) => step.with === 'totp');
    const signedIn = (timeout) => page.waitForSelector(marker, { timeout }).then(() => true, () => false);
    if (codeStep >= 0 && codeAt !== undefined && !await signedIn(CODE_ANSWER_MS)) {
        const codeStays = await page.isVisible(steps[codeStep].fill).catch(() => false);
        if (codeStays) {
            const nextWindow = (Math.floor(codeAt / TOTP_WINDOW_MS) + 1) * TOTP_WINDOW_MS;
            await sleep(Math.max(0, nextWindow - now()) + NEXT_WINDOW_MARGIN_MS);
            await run(codeStep);
        }
    }
    if (await signedIn(LOGIN_TIMEOUT_MS)) return;
    throw new CawError('login-failed', t('session.browser.loginFailed', { url, marker, path: new URL(page.url()).pathname }));
};

/**
 * A saved session (`signIn.type: session`, recorded with `caw role login`): cookies into the context, localStorage and
 * sessionStorage via a script before every load, only for the origins in the file. Then the same check applies as after a sign-in.
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

/** No password manager: the "Save password?" prompt disturbs every run, and the test password must not end up in the profile. */
const quietProfile = (profileDir) => {
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
        credentials_enable_service: false,
        credentials_enable_autosignin: false,
        profile: { password_manager_enabled: false, password_manager_leak_detection: false },
        autofill: { profile_enabled: false, credit_card_enabled: false },
        // No "Translate this page?" offer: the app's language is the project's, not Chrome's.
        translate: { enabled: false },
    }));
};

const validLocale = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;
    try {
        return Intl.getCanonicalLocales(value).length === 1;
    } catch {
        return false;
    }
};
const validTimezone = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
        return true;
    } catch {
        return false;
    }
};

/**
 * Language, time zone and viewport of the browser: from the config (`browser.locale`, `browser.timezone`, `browser.viewport`),
 * else as recorded, else the host's (no viewport: a headless browser gets the default size). Recording on de-DE/Europe/Berlin and
 * replaying on an en-US/UTC runner would otherwise change dates, numbers and texts; a narrower window changes the layout.
 * An invalid value is skipped in favour of the next source.
 * @param recorded { locale, timezone, viewport } stored with the recording (recordedBrowser), {} while nothing is recorded
 */
export const browserRegion = (config, recorded = {}, host = Intl.DateTimeFormat().resolvedOptions()) => {
    const browser = config?.browser !== null && typeof config?.browser === 'object' ? config.browser : {};
    return {
        locale: [browser.locale, recorded?.locale, host.locale, 'en-US'].find(validLocale),
        timezone: [browser.timezone, recorded?.timezone, host.timeZone, 'UTC'].find(validTimezone),
        ...[browser.viewport, recorded?.viewport].filter(isViewport).slice(0, 1).map((viewport) => ({ viewport }))[0],
    };
};

/** CSS selectors of areas that never count for readiness (config `readyIgnore`), ignoring anything that is not a selector text. */
export const readyIgnoreOf = (config) => (Array.isArray(config?.readyIgnore) ? config.readyIgnore.filter((selector) => typeof selector === 'string' && selector.trim() !== '') : []);

/**
 * The trace of a run, in parts if needed: `pause` stops it around a sign-in and starts a new one afterwards. What came before is
 * saved as trace-1.zip, trace-2.zip and so on next to trace.zip, which holds the last part. Playwright records network entries
 * across chunks, so only a full stop keeps the typed password, the field values and the POST body of a sign-in out of every part.
 * Every saved part is scrubbed of the session's secrets: Playwright writes the context options, a Basic password among them.
 * @param options for tracing.start
 * @param secrets the values to mask, read at each stop
 */
export const createTrace = (context, { path, options, secrets = () => [] }) => {
    let running = false;
    let parts = 0;
    const partPath = () => (path.endsWith('.zip') ? `${path.slice(0, -'.zip'.length)}-${parts}.zip` : `${path}-${parts}`);
    return {
        start: async () => {
            await context.tracing.start(options);
            running = true;
        },
        stop: async () => {
            if (!running) return;
            running = false;
            await context.tracing.stop({ path }).catch(() => {});
            scrubTrace(path, secrets());
        },
        /** Runs `work` without tracing. */
        pause: async (work) => {
            if (!running) return work();
            running = false;
            parts += 1;
            await context.tracing.stop({ path: partPath() }).catch(() => {});
            scrubTrace(partPath(), secrets());
            try {
                return await work();
            } finally {
                await context.tracing.start(options).then(() => { running = true; }, () => {});
            }
        },
        /** How many earlier parts were saved. */
        parts: () => parts,
    };
};

// Chrome's messages when its sandbox cannot start: as root on Linux, or in a container without user namespaces.
export const SANDBOX_FAILURE = /No usable sandbox|without --no-sandbox|setuid sandbox|namespace sandbox/i;

// Without a window there is no maximising: forms get the width of a typical screen.
const HEADLESS_VIEWPORT = { width: 1920, height: 1080 };

/**
 * @param lock        { navigation, blocked, reach, onBlocked } for the host lock (host-lock.mjs), installed before any page loads;
 *                    `reach` (Claude attached) also goes into the resolver rules, which only a launch can set
 * @param headless    no visible window, in Chrome's new headless mode: same engine, same host lock
 * @param insecureTls skip certificate checks, for internal environments with their own CA (config `insecureTls`)
 * @param launch      from browserLaunch: channel or executablePath, chromiumSandbox
 */
const launchChrome = async (profileDir, lock, { headless = false, insecureTls = false, httpCredentials, launch = { channel: 'chrome', chromiumSandbox: true }, region, ownSignals = false } = {}) => {
    quietProfile(profileDir);
    // Before every launch: recordings may use the extjs= selector engine (a no-op without Ext).
    await registerEngines();
    let context;
    try {
        context = await chromium.launchPersistentContext(profileDir, {
            // The system Chrome, or whatever the config names under browser (Edge, a fixed path). Always in Chrome's sandbox unless
            // the config says browser.noSandbox (browserLaunch); Playwright's own default would be without.
            chromiumSandbox: true,
            ...launch,
            headless,
            // Ctrl+C ends the run with a verdict and cleanup. Playwright would otherwise exit immediately with code 130.
            handleSIGINT: false,
            // A run handles SIGTERM and SIGHUP like Ctrl+C itself (run.mjs); Playwright would close the browser behind its back.
            ...(ownSignals ? { handleSIGTERM: false, handleSIGHUP: false } : {}),
            // Language and time zone of the recording, so dates, numbers and translations look the same on every machine.
            ...(region?.locale === undefined ? {} : { locale: region.locale }),
            ...(region?.timezone === undefined ? {} : { timezoneId: region.timezone }),
            // Headless: the recorded (or configured) size. A window keeps its own size; the workbench scales the app frame (OPEN-15).
            viewport: headless ? region?.viewport ?? HEADLESS_VIEWPORT : null,
            // No emulation: the page follows the system like in any Chrome. Otherwise Playwright pins it to light, and opening the
            // DevTools would drop that and switch everything to dark mode mid-run.
            colorScheme: null,
            // Opt-in only: internal environments often use certificates Chrome does not know; the host lock limits navigation.
            ignoreHTTPSErrors: insecureTls,
            // For the download action: Playwright stores downloads in its own folder that disappears with the browser; the agent
            // never gets to it, and the action deletes its file right after the check.
            acceptDownloads: true,
            serviceWorkers: 'block',
            // HTTP basic auth only for the environment's origin, never for other hosts.
            ...(httpCredentials === undefined ? {} : { httpCredentials }),
            // Maximised instead of fullscreen: forms get the full width, and on handover tabs and address bar stay visible.
            // --test-type: without it Chrome shows a warning bar about --host-resolver-rules (production hosts, .localhost) above the
            // workbench (chromedriver does the same). It is not there for --no-sandbox: with the sandbox on, that flag is not passed.
            // No "Translate this page?" bubble at the address bar when the app's language differs from Chrome's. Chrome only honours
            // the last --disable-features, so all features go into one flag.
            args: [...(headless ? [] : ['--start-maximized', '--test-type']), ...browserArgs(lock.blocked ?? [], { reach: lock.reach }), '--disable-features=Translate,TranslateUI'],
        });
    } catch (error) {
        const first = error.message.split('\n')[0];
        // No silent fallback without the sandbox: the person turns it off knowingly, in the config.
        if (launch.chromiumSandbox !== false && SANDBOX_FAILURE.test(error.message)) throw new CawError('browser-sandbox', t('session.browser.sandboxFailed', { error: first }));
        throw new CawError('browser-missing', t('session.browser.chromeFailed', { error: first }));
    }
    await installHostLock(context, lock);
    return context;
};

// Per browser context: the environment's origin and how many evaluations currently read the clipboard.
const clipboards = new WeakMap();

/**
 * Clipboard write for the environment's origin for the whole run, e.g. for a "Copy" button. Reading only while a check runs
 * (withClipboardRead): with the permission for the whole run the page under test could read the person's clipboard any time.
 * Other origins get neither.
 */
export const grantClipboard = async (context, url) => {
    const origin = new URL(url).origin;
    clipboards.set(context, { origin, readers: 0 });
    await context.grantPermissions(['clipboard-write'], { origin });
};

/**
 * Runs `read` (a check, remember or eval) with clipboard-read for the environment's origin, so it can call
 * `navigator.clipboard.readText()`, e.g. after a "Copy" button; afterwards only write again. Without grantClipboard on this
 * context it just runs `read`.
 */
export const withClipboardRead = async (context, read) => {
    const clipboard = context === undefined ? undefined : clipboards.get(context);
    if (clipboard === undefined) return read();
    clipboard.readers += 1;
    try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: clipboard.origin });
        return await read();
    } finally {
        clipboard.readers -= 1;
        // Playwright only adds permissions: clear them all and grant write again. The context gets no other permissions.
        if (clipboard.readers === 0) {
            await context.clearPermissions().catch(() => {});
            // Another reader may have started meanwhile: it keeps reading.
            await context.grantPermissions(clipboard.readers === 0 ? ['clipboard-write'] : ['clipboard-read', 'clipboard-write'], { origin: clipboard.origin }).catch(() => {});
        }
    }
};

const FLOATS_BINDING = '__cawFloats';
const FLOATS_MAX_LINES = 5000;

/** Runs in the browser. Logs every change in the order of floating windows: the last in the list is on top. */
export function watchFloatsInPage(binding) {
    // Only the application's document: the top one, or with the workbench directly below it. Never the workbench or its chat.
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
            if (order !== last) send(`order ${order}`);
            last = order;
        };
        new MutationObserver(report).observe(root, { childList: true, attributes: true, attributeFilter: ['class', 'style'], subtree: false });
        report();
    };
    start();
}

/** Only component ids and times, no content. The page can call the binding, so every line is limited. */
const logFloats = async (context, path) => {
    let lines = 0;
    await context.exposeBinding(FLOATS_BINDING, ({ page }, text) => {
        // Blank pages do not belong to the application.
        if (lines >= FLOATS_MAX_LINES || page.url() === 'about:blank') return;
        lines += 1;
        appendFileSync(path, `${String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 500)}\n`);
    });
    const script = `(${watchFloatsInPage})(${JSON.stringify(FLOATS_BINDING)});`;
    await context.addInitScript({ content: script });
    await Promise.all(context.pages().map((page) => page.evaluate(script).catch(() => {})));
};

/**
 * For `signIn.type: session`: Chrome opens the sign-in, the human signs in (e.g. via SSO), and the tool saves the session as
 * soon as `signedInSelector` appears: cookies, localStorage and the sessionStorage of the page where sign-in ended (Playwright
 * does not save that). The file contains the test account's credentials: on Unix readable only by the own user, on Windows the
 * project folder's permissions apply.
 * @returns true if saved; false if the human closed the window first
 */
export const captureSession = async ({ url, signedInSelector, hosts, blocked = [], insecureTls = false, file, timeoutMs = 10 * 60 * 1000, launch }) => {
    sweepStaleProfiles();
    const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    writeFileSync(join(profileDir, PROFILE_OWNER), String(process.pid));
    const context = await launchChrome(profileDir, { navigation: hosts, blocked }, { insecureTls, ...(launch === undefined ? {} : { launch }) });
    try {
        const page = context.pages()[0] ?? await context.newPage();
        const closed = new Promise((ok) => { page.once('close', () => ok(false)); });
        await page.goto(url);
        const signedIn = page.waitForSelector(signedInSelector, { state: 'attached', timeout: timeoutMs }).then(() => true);
        if (!await Promise.race([signedIn, closed])) return false;
        const state = await context.storageState();
        const origin = new URL(page.url()).origin;
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser page
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
 * For `caw init --explore-only`: a window without sign-in by the tool, in which the person may also sign in at an IdP on another
 * host. Collects console errors, the other hosts top-level pages went to (e.g. an SSO service) and the app path the sign-in left
 * from (`signInFrom`, the first app page whose navigation or redirect led there).
 */
export const exploreBrowser = async ({ url, insecureTls = false, launch, headless = false }) => {
    sweepStaleProfiles();
    const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    writeFileSync(join(profileDir, PROFILE_OWNER), String(process.pid));
    const own = new URL(url).hostname;
    const ownHosts = withLoopbackPair([own]);
    const foreignHosts = new Set();
    let signInFrom = null;
    const context = await launchChrome(profileDir, { navigation: [ANY_HOST] }, { insecureTls, headless, ...(launch === undefined ? {} : { launch }) });
    const page = context.pages()[0] ?? await context.newPage();
    const consoleErrors = [];
    // Write requests to the address's host while the person signs in and clicks: candidates for reads, never applied by themselves.
    const writes = new Set();
    context.on('request', (request) => {
        const host = new URL(request.url()).hostname;
        if (!ownHosts.includes(host) && /^https?:$/.test(new URL(request.url()).protocol) && isTopNavigation(request)) {
            foreignHosts.add(host);
            if (signInFrom === null) {
                // A redirect chain (/login → IdP) starts on the app; a link or form post leaves from the current app page.
                let first = request;
                while (first.redirectedFrom() !== null) first = first.redirectedFrom();
                const from = first !== request ? first.url() : request.frame().url();
                try {
                    if (ownHosts.includes(new URL(from).hostname)) signInFrom = new URL(from).pathname;
                } catch { /* about:blank */ }
            }
        }
        if (host !== own) return;
        const name = requestName({ method: request.method(), url: request.url(), postData: request.postData(), contentType: request.headers()['content-type'] ?? '' });
        if (classifyRequest(name) === 'write') writes.add(name);
    });
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push(String(error?.message ?? error)));
    return {
        page,
        consoleErrors,
        foreignHosts,
        signInFrom: () => signInFrom,
        writes,
        close: async () => {
            await context.close().catch(() => {});
            await removeProfile(profileDir);
        },
    };
};

/**
 * The production write block's rule: the name of a request that must not go out on production, or null. Any host counts, not
 * only the app's; reads are GET, HEAD, OPTIONS and what classifyRequest calls a read (a GraphQL query, a `reads` pattern).
 * Sign-in requests (classifyRequest's 'ignored') pass only while caw itself signs in, and only to the sign-in hosts.
 * @param described   { method, url, postData, contentType }
 * @param signInHosts the navigation hosts: the environment and its sign-in services
 */
export const productionWriteName = (described, { reads = [], requestKeys = [], signingIn = false, signInHosts = new Set() } = {}) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(described.method).toUpperCase())) return null;
    let host = '';
    try {
        host = normalizeHost(new URL(described.url).hostname);
    } catch {
        // An unreadable address counts like any other host.
    }
    const name = requestName(described, requestKeys);
    if (classifyRequest(name, reads) === 'read' || (signingIn && signInHosts.has(host))) return null;
    return name;
};

/**
 * Opens Chrome, signs in, injects the local code and waits until the app settles.
 * @param spec.overlay null or the result of prepareOverlay, which then answers the code requests
 */
export const openBrowserSession = async (spec) => {
    const { config, devlinkConfig, resolved, credentials, consoleIgnore, foreignCode, hosts } = spec;
    const overlay = spec.overlay ?? null;
    const checkedDevlink = parseConfig(devlinkConfig);
    if (!checkedDevlink.ok) throw new CawError('config-invalid', t('session.browser.devlinkRejected', { issues: JSON.stringify(checkedDevlink.issues) }));

    const startUrl = `${resolved.url}${spec.startUrl}`;
    // The environment's own sign-in: it may differ per environment (e.g. none on local, form with an IdP on staging).
    const auth = resolved.signIn ?? { type: 'none' };
    const framework = frameworkOf(config);
    sweepStaleProfiles();
    // Every run gets a fresh profile; at the end it contains the test user's login cookies.
    const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    writeFileSync(join(profileDir, PROFILE_OWNER), String(process.pid));
    let raw = null;
    let devlinkHost = null;
    let trace = null;
    // Language and time zone: config, else as recorded, else the host's.
    const region = browserRegion(config, spec.recordedBrowser);
    let closedSignal;
    const closed = new Promise((ok) => { closedSignal = ok; });
    // How long preparation took: the workbench only appears afterwards and shows it as passed points.
    const timing = { start: Date.now(), chrome: null, login: null, code: null };

    const stopTrace = async () => {
        await trace?.stop();
    };
    const ignoreClosedBrowser = (reason) => {
        if (!isBrowserClosedError(reason)) throw reason;
    };
    process.on('unhandledRejection', ignoreClosedBrowser);
    const close = async () => {
        await stopTrace();
        await devlinkHost?.stop().catch(() => {});
        await raw?.close().catch(() => {});
        if (!await removeProfile(profileDir)) {
            console.error(t('session.browser.profileNotDeleted', { dir: profileDir }));
        }
        process.removeListener('unhandledRejection', ignoreClosedBrowser);
    };

    // Who is signed in right now: restoring a state from a test of another role switches the account.
    let signedInAs = credentials;
    // All passwords of this session stay redacted, even after switching accounts.
    const passwords = [credentials?.password, credentials?.gate?.password].filter((value) => value !== undefined);
    // One-time codes sent during sign-in are masked like the password.
    const codes = [];
    const formLogin = (on) => ensureLoggedIn(raw, {
        url: `${resolved.url}${auth.path}`,
        marker: auth.signedInSelector,
        login: signedInAs.login,
        password: signedInAs.password,
        totpSecret: signedInAs.totpSecret,
        framework,
        onCode: (code) => codes.push(code),
        ...(auth.steps === undefined ? {} : { steps: auth.steps }),
        selectors: auth.steps !== undefined ? {} : {
            user: auth.userSelector,
            password: auth.passwordSelector,
            ...(auth.submitSelector === undefined ? {} : { submit: auth.submitSelector }),
            ...(auth.codeSelector === undefined ? {} : { code: auth.codeSelector }),
        },
        ...(on === undefined ? {} : { on }),
    });
    try {
        // The devlink host only starts the browser after its preflight. That is why sign-in hangs off the launcher.
        // The lock reports from the first page on; until the failure list exists the events wait here.
        const blockedEarly = [];
        let blockedSink = (event) => blockedEarly.push(event);
        const launcher = createPlaywrightLauncher(async (dir) => {
            // HTTP Basic only to the environment's own origin: the basic sign-in, or the gate in front of the environment.
            const origin = new URL(resolved.url).origin;
            const httpCredentials = auth.type === 'basic' ? { username: credentials.login, password: credentials.password, origin }
                : credentials?.gate === undefined ? undefined : { ...credentials.gate, origin };
            // With Claude attached (spec.reach), the browser reaches only those hosts, plus the overlay's dev servers.
            const reach = spec.reach === undefined ? undefined : [...spec.reach, ...(overlay?.devServers ?? []).map((server) => new URL(server).hostname)];
            raw = await launchChrome(dir, { navigation: hosts, blocked: blockedHosts(config, resolved.name), reach, onBlocked: (event) => blockedSink(event) }, { headless: spec.headless === true, insecureTls: resolved.insecureTls === true, httpCredentials, launch: browserLaunch(config), region, ownSignals: true });
            raw.on('close', closedSignal);
            // Chrome runs: whatever fails from here (sign-in, a session file) is not a launch problem and keeps its own message.
            try {
                await prepareSignedIn();
            } catch (error) {
                if (error !== null && typeof error === 'object') error.afterLaunch = true;
                throw error;
            }
            return raw;
        });
        async function prepareSignedIn() {
            await grantClipboard(raw, resolved.url);
            // With the workbench: Playwright serves it, so Chrome counts it as a public page, and Local Network Access would block
            // the application's requests from it to an intranet or loopback host. The permission goes to the application's origin
            // only, instead of turning the check off for every origin (measured: a request from such a page to another loopback
            // origin fails without it and passes with it).
            if (spec.embed === true) await raw.grantPermissions(['local-network-access'], { origin: new URL(resolved.url).origin });
            timing.chrome = Date.now();
            // With the workbench: only its tab, not the application's popups (window.open, target=_blank), where the human demonstrates too.
            // Context scripts run before tab scripts; that is why they check the mark only when the event fires.
            if (spec.embed === true) await raw.pages()[0].addInitScript({ content: WORKBENCH_MARK_SCRIPT });
            if (auth.type === 'session') await applyStorageState(raw, credentials.storageState);
            // Via the app's own sign-in page, so the application does not load once before the local code is injected.
            if (auth.type === 'form') await formLogin();
            timing.login = Date.now();
        }
        devlinkHost = createDevlinkHost(devlinkConfig, {
            launcher,
            now: () => Date.now(),
            sleep: sleepMs,
        }, {
            profileDir,
            configPath: spec.devlinkConfigPath,
            // A verification run must not silently test the deployed code on substitution errors.
            onFailure: 'fail',
            // Without a marker (no sign-in, or basic auth without one) the host checks nothing.
            authMarker: auth.signedInSelector ?? '',
        });
        // The host checks the marker on the environment's start page before local code is injected. Its messages are generic;
        // here they become a hint about what to do in the project.
        await devlinkHost.start().catch(async (error) => {
            const message = String(error?.message ?? '');
            if (/not signed in/.test(message)) {
                const next = auth.type === 'session'
                    ? t('session.browser.sessionExpired', { role: spec.role ?? '<role>', env: resolved.name })
                    : t('session.browser.checkSelector');
                const failure = new CawError(auth.type === 'session' ? 'auth-missing' : 'login-failed', t('session.browser.markerMissing', { url: resolved.url, selector: auth.signedInSelector, next }));
                const page = raw?.pages()[0];
                if (page !== undefined) failure.evidence = await loginEvidence(page, { marker: auth.signedInSelector });
                throw failure;
            }
            throw error;
        });
        // If a source fails mid-run (broken bootstrap.json, two apps with the same build name), that is a failure of the run.
        const failures = [];
        if (overlay !== null) {
            await routeOverlay(raw, overlay, { onProblem: (error, url) => failures.push({ type: 'overlay', text: String(error?.message ?? error), url }) });
        }
        timing.code = Date.now();
        if (spec.floatsLogPath !== undefined && framework.floats) await logFloats(raw, spec.floatsLogPath);

        // Own observation instead of the host's gate: only this way the URL of a failed request is kept and can be
        // checked against consoleIgnore.
        let drained = 0;
        const warnings = [];
        // Hosts outside the navigation hosts (third-party): counted for the report, their errors only warnings (OPEN-9).
        const navigation = new Set(withLoopbackPair(hosts));
        const thirdPartyHosts = new Map();
        const isThirdParty = (url) => {
            try {
                const { protocol, hostname } = new URL(url);
                return /^(https?|wss?):$/.test(protocol) && !navigation.has(normalizeHost(hostname));
            } catch {
                return false;
            }
        };
        const rules = { ignored: consoleIgnore.map((pattern) => new RegExp(pattern)), foreign: (foreignCode ?? []).map((pattern) => new RegExp(pattern)), skip: framework.stackSkip, thirdParty: isThirdParty };
        const dialogs = createDialogs();
        const pages = trackAgentPages(raw.pages()[0], { onDialog: dialogs.handle });
        const addWarning = (entry) => {
            const known = warnings.find(({ type, text }) => type === entry.type && text === entry.text);
            if (known === undefined) warnings.push({ ...entry, count: 1 });
            else known.count += 1;
        };
        // Messages from workbench and chat: the console names no frame but the file; their scripts are called caw-workbench.js.
        const workbenchOrigin = spec.embed === true;
        // For a script error, what counts is where it was thrown: the first stack line after the message.
        const thrownAt = (stack) => (typeof stack === 'string' ? stack.split('\n').find((line) => /^\s+at /.test(line)) ?? '' : '');
        const fromWorkbench = (url, stack) => workbenchOrigin && (fromWorkbenchSource(url) || fromWorkbenchSource(thrownAt(stack)));
        const observe = (page, observation, url, stack) => {
            // No page, e.g. for workers: better to count it than to swallow an application error.
            if (page === false || (page !== null && !pages.owns(page)) || fromWorkbench(url, stack)) return;
            if (observation.type !== 'http' && !isHardFailure(observation)) return;
            // When embedded, the top window is the workbench: if the page accesses it (window.top, parent), the browser blocks it. That
            // aborts the application's action and is therefore a real failure; the hint explains that embedding is the cause.
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
        // Script errors point to the source code if the application serves source maps. Loaded only from allowed hosts, via the
        // browser's request context, i.e. with the same cookies and TLS rules.
        // With an overlay, Chrome gets scripts from the project folder. Script and source map must then come from there, otherwise the
        // deployed map does not match the code that threw. If a dev server serves the code, the request context fetches the map:
        // it does not go through the route, so fetchText asks the overlay itself.
        const readLocal = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
        // The script as Chrome received it (for an alias under a deployed name the local content, since only that throws), and the map
        // next to the local file. A missing map is no invitation to take the deployed one.
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
        // A watch rebuilds while names of fixed statics stay: the map is only valid as long as the local file is unchanged.
        const localVersion = (url) => {
            const file = overlay?.fileFor(url);
            return file === undefined ? '' : fileVersion(file);
        };
        const sourceMaps = createSourceMapper({
            version: localVersion,
            fetchText: async (url) => {
                const local = await localText(url);
                if (local !== undefined) return local;
                // undefined: no connection (name not resolvable, port closed); null: the server answered, but not with 2xx.
                // Follow no redirects: `allowed` only checks the first address, and an open redirect on an allowed host (sign-in
                // services often have one) would otherwise send a request from the host machine to an arbitrary address.
                const get = async (target, options = {}) => {
                    const response = await raw.request.get(target, { timeout: 5000, maxRetries: 0, maxRedirects: 0, ...options }).catch(() => undefined);
                    if (response === undefined) return undefined;
                    return response.ok() ? response.text() : null;
                };
                const first = await get(url);
                const target = new URL(url);
                // A 404 for a map that does not exist is an answer; the second route is only worth it without a connection.
                if (first !== undefined || !isLoopback(target.hostname) || target.hostname === '127.0.0.1') return first ?? null;
                // The request context resolves names in Node, not via --host-resolver-rules: on Windows Node does not know `.localhost`,
                // and `localhost` often becomes ::1, where the server does not listen. So, as for Chrome, go via 127.0.0.1, with the
                // name in the Host header and the cookies the browser sent there.
                const hostHeader = target.host;
                const cookie = (await raw.cookies(url).catch(() => [])).map(({ name, value }) => `${name}=${value}`).join('; ');
                target.hostname = '127.0.0.1';
                // The certificate names the host name, not 127.0.0.1: it does not count for this detour to the local machine.
                return (await get(target.href, { headers: { host: hostHeader, ...(cookie === '' ? {} : { cookie }) }, ignoreHTTPSErrors: true })) ?? null;
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
        // Chrome also reports failed requests as console errors. `response` and `requestfailed` already capture them, with URL and
        // the rules for static files; counted twice, every 404 of an image and every business 4xx would fail the run hard.
        const networkEcho = (message) => /^Failed to load resource:/.test(message.text());
        // Frameworks often catch errors themselves and log them with stack to the console instead of throwing: Angular via its
        // ErrorHandler ("ERROR Error: …"), Vue in production builds, React after an error boundary. Then the stack points to the
        // source just like for a script error.
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
            // Without a stack the report would just say "Object", which tells nothing.
            const text = error?.stack ? String(error) : t('session.browser.errorWithoutStack', { error: String(error) });
            const entry = observe(webError.page(), { type: 'pageerror', text }, undefined, error?.stack || undefined);
            if (entry !== null && entry !== undefined && error?.stack) {
                sourceMaps.translate(error.stack, { skip: framework.stackSkip }).then(({ at, stack }) => {
                    if (at !== undefined) entry.at = at;
                    if (stack.length > 0) entry.stack = stack;
                }, () => {});
            }
        });
        // A navigation or production request the lock stopped: one failure naming the host, not also a failed request.
        const blockedUrls = new Set();
        blockedSink = ({ host, url, kind, request }) => {
            blockedUrls.add(url);
            let page = null;
            try {
                page = pageOfRequest(request);
            } catch {
                page = null;
            }
            if (page === false || (page !== null && !pages.owns(page))) return;
            // With Claude attached, a host outside the reach: a warning that names it and how to allow it, like any third-party
            // host's error (a blocked analytics script is no failed step).
            if (kind === 'agent') {
                addWarning({ type: 'host-blocked', text: t('session.browser.agentBlocked', { host }) });
                return;
            }
            failures.push({ type: 'host-blocked', text: t(kind === 'production' ? 'session.browser.productionBlocked' : 'session.browser.hostBlocked', { host }), url });
        };
        for (const event of blockedEarly.splice(0)) blockedSink(event);
        const tallyOf = (request) => {
            if (!isThirdParty(request.url())) return null;
            const host = new URL(request.url()).hostname;
            if (!thirdPartyHosts.has(host)) thirdPartyHosts.set(host, { host, requests: 0, types: new Set(), failed: 0 });
            return thirdPartyHosts.get(host);
        };
        raw.on('requestfailed', (request) => {
            const tally = tallyOf(request);
            if (tally !== null) tally.failed += 1;
            if (blockedUrls.has(request.url())) return;
            observe(pageOfRequest(request), { type: 'requestfailed', text: request.failure()?.errorText ?? '' }, request.url());
        });
        raw.on('response', (response) => {
            if (response.status() >= 500) observe(pageOfRequest(response.request()), { type: 'http', text: `HTTP ${response.status()}` }, response.url());
        });

        // What the run may have written, for the report and promotion: the app's write requests by name (src/shared/requests.mjs),
        // never those to IdPs or third-party hosts and never caw's own sign-in.
        const writes = new Map();
        const ownHosts = new Set(appHostsOf(config));
        const reads = compileReads(config.reads);
        let signingIn = false;
        const hidden = [];
        // Evidence for classifying a failure: only the application's own requests, no pages, scripts or images.
        const network = createNetworkLog();
        const asked = (request) => ['xhr', 'fetch'].includes(request.resourceType()) && ownHosts.has(hostOfRequest(request));
        // What naming needs of a request; postData is null for a body Playwright cannot read as text.
        const hostOfRequest = (request) => {
            try {
                return normalizeHost(new URL(request.url()).hostname);
            } catch {
                return '';
            }
        };
        const describedRequest = (request) => ({ method: request.method(), url: request.url(), postData: request.postData(), contentType: request.headers()['content-type'] ?? '' });
        // On production nothing writes, to any host: a request that is no read by the report's classifier (GET, HEAD, OPTIONS, a
        // GraphQL query, a `reads` pattern) is aborted and fails the step, whether it goes to the app or elsewhere. Sign-in
        // requests are exempt only while caw itself signs in, and only to the navigation hosts (the environment, its sign-in
        // services); a token refresh the app sends by itself later is a write unless `reads` names it. Registered after the first
        // sign-in; a later one (signInAgain) sets signingIn.
        // Not covered: messages an open WebSocket sends. Reading apps send them too (socket.io pings, a GraphQL subscription's
        // connection_init and subscribe), so blocking them would break reading; production WebSockets stay a documented gap.
        const signInHosts = new Set(withLoopbackPair(hosts));
        // The same block on a run that must not write elsewhere: caw reproduce on an environment without writable.
        const blocksWrites = resolved.production === true || resolved.blockWrites === true;
        const refuseWrite = (described, url) => {
            if (!blocksWrites) return false;
            const name = productionWriteName(described, { reads, requestKeys: config.requestKeys ?? [], signingIn, signInHosts });
            if (name === null) return false;
            blockedUrls.add(url);
            failures.push({ type: 'write-blocked', text: t('session.browser.writeBlocked', { name, env: resolved.name }), url });
            return true;
        };
        if (blocksWrites) {
            await raw.route((url) => /^https?:$/.test(url.protocol), async (route) => {
                const request = route.request();
                if (!refuseWrite(describedRequest(request), request.url())) {
                    await route.fallback();
                    return;
                }
                await route.abort('blockedbyclient').catch(() => {});
            });
        }
        // A form POST into the workbench's top window is sent by caw itself (interceptDocuments), past the routes: the same check.
        const refuseTopWrite = ({ method, url, headers, postData }) => refuseWrite({
            method,
            url,
            postData,
            contentType: Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '',
        }, url);
        const watchNavigation = (page) => {
            page.on('domcontentloaded', () => network.replaced(page));
            // Playwright also reports same-document changes (History API, hash), i.e. single-page app routes. Only the application's
            // top frame counts: the main frame, or in the workbench the application iframe.
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
            const tally = tallyOf(request);
            if (tally !== null) {
                tally.requests += 1;
                tally.types.add(request.resourceType());
            }
            if (!signingIn && ownHosts.has(hostOfRequest(request))) {
                const label = requestName(describedRequest(request), config.requestKeys ?? []);
                if (classifyRequest(label, reads) === 'write') writes.set(label, (writes.get(label) ?? 0) + 1);
            }
            // A navigation starts with the main frame's request, before any abort it causes. Hash changes make no request.
            if (page !== null && request.isNavigationRequest() && request.frame() === page.mainFrame()) network.navigating(page);
            if (asked(request)) {
                const keys = config.requestKeys ?? [];
                const described = describedRequest(request);
                network.started(request, { name: requestName(described, keys), page, params: parameterNames(described, keys) });
            }
        });
        // Done only with the body, not with the headers: otherwise waiting would count a request as finished whose response the
        // application could not process yet.
        // Headers: a stream only ends with the page, and some proxies never report an end. After them, waiting only counts briefly.
        raw.on('response', (response) => {
            network.answered(response.request(), response.status(), STREAM_TYPE.test(response.headers()['content-type'] ?? ''));
        });
        raw.on('requestfinished', (request) => {
            request.response().then((response) => { if (response !== null) network.finished(request, response.status()); }, () => {});
        });
        raw.on('response', (response) => {
            const request = response.request();
            if (response.status() < 400 || !isTopNavigation(request) || !ownHosts.has(hostOfRequest(request))) return;
            const page = pageOfRequest(request);
            if (page === false || page === null || !pages.owns(page)) return;
            network.document(page, requestName(describedRequest(request), config.requestKeys ?? []), response.status());
        });

        // Trail for an action's effect: console and shape of JSON responses, without values.
        const trail = [];
        raw.on('console', (message) => {
            const page = message.page();
            const url = message.location().url;
            if ((page !== null && !pages.owns(page)) || fromWorkbench(url)) return;
            // Only errors, and only those not ignored or foreign: otherwise a rare log, a timing-dependent Chrome warning or an
            // allowed page message would fail the step as an application error.
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
            // The position in the trail is fixed right away, the content follows.
            const entry = { kind: 'response', line: null };
            trail.push(entry);
            response.text().then((body) => {
                entry.line = responseLine(requestName(describedRequest(request), config.requestKeys ?? []), JSON.parse(body));
            }).catch(() => {});
        });
        raw.on('requestfailed', (request) => network.failed(request, request.failure()?.errorText ?? ''));

        // Snapshots put requests including headers into the trace; with basic auth the password would be in the Authorization header.
        // With the workbench a human is watching: continuous screenshots made the page noticeably sluggish (and the trace huge).
        // Every later sign-in (signInAgain) pauses it.
        // A gate's credentials travel as `Authorization: Basic base64(user:password)` in every request, and the snapshots keep the
        // headers: the scrub also masks that encoded form, so the trace keeps its snapshots.
        const gateToken = credentials?.gate === undefined ? [] : [basicAuthToken(credentials.gate.username, credentials.gate.password)];
        trace = createTrace(raw, { path: spec.tracePath, options: { screenshots: spec.embed !== true, snapshots: auth.type !== 'basic' }, secrets: () => [...passwords, ...codes, ...hidden, ...gateToken] });
        await trace.start();

        // devlinkHost.start() only hooks in the interception after loading the start page; so this navigation is the first
        // to load the app with the local code.
        let bench = null;
        // With an overlay, every application page swaps the app's code tags for those of the local page (rewritePage), without
        // integrity: local code has different bytes. The rest of the page stays the server's.
        const rewrite = overlay === null ? undefined : overlay.rewritePage;
        const appHosts = [new URL(resolved.url).hostname];
        if (spec.embed === true) {
            // Embed only documents of the application itself, not further allowed hosts such as a sign-in service.
            bench = await openWorkbench(raw, { appUrl: startUrl, hosts: appHosts, title: spec.title ?? 'caw', rewrite, refuse: refuseTopWrite });
            pages.embed(bench.page, bench.view);
            // A recorded (or configured) viewport pins the app frame to that size, as headless replay uses it (OPEN-15).
            if (region?.viewport !== undefined) await bench.viewport(region.viewport);
            bench.view.on('domcontentloaded', () => network.replaced(bench.view));
            const signIn = auth.type === 'form' || auth.type === 'basic' ? t('session.prep.signIn') : auth.type === 'session' ? t('session.prep.takeSession') : null;
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
        // Quiet according to the framework adapter; for the neutral adapter also no open requests of the page.
        const ignore = readyIgnoreOf(config);
        const waitReady = (args = {}) => waitQuiet(framework, pages.current(), { ...args, ignore, pending: (page) => network.pending(page) });
        const ready = await waitReady({ timeout: spec.readyTimeoutMs, untilApp: true });
        await bench?.point(PREP, 'load', ready.settled && ready.lastSample?.appReady === true ? 'pass' : 'fail', ready.settled ? {} : { note: ready.reason });
        // overlayStrict false (caw overlay check): report instead of throwing, the check reads the diagnosis itself. A broken
        // app is often just what a mixed state causes.
        const strict = spec.overlayStrict !== false;
        let loadProblem = null;
        if (!ready.settled) loadProblem = new CawError('app-not-settled', t('session.browser.notSettled', { reason: ready.reason }));
        else if (ready.lastSample?.appReady !== true) loadProblem = new CawError('app-not-loaded', t('session.browser.notLoaded', { url: startUrl, framework: framework.label() }));
        if (loadProblem !== null && (strict || overlay === null)) throw loadProblem;
        // With an overlay, never silently test the deployed version: SSR cannot be swapped, and if nothing came from the local code the
        // test ran against the server. Expected parts (app, packages) from the server: a mixed state, the run ends. Single scripts
        // from the local asset folder served by the server: a mixed state, as a warning.
        let overlaySummary = null;
        if (overlay !== null) {
            const seen = overlay.diagnose();
            if (seen.ssr !== null) throw new CawError('overlay-ssr', t('session.overlay.ssr', { framework: seen.ssr }));
            // Missed expected parts first: that message names the parts and the pattern that catches them.
            if (strict && seen.missed.length > 0) throw new CawError('overlay-incomplete', incompleteText(seen));
            if (strict && seen.local === 0) throw new CawError('overlay-unused', t('session.overlay.unused', { source: seen.label, url: startUrl }));
            if (seen.localBase) addWarning({ type: 'note', text: t('session.overlay.localBase') });
            if (seen.mixed.length > 0) addWarning({ type: 'note', text: t('session.overlay.mixed', { count: seen.mixed.length, examples: seen.mixed.slice(0, 3).join(', ') }) });
            if (seen.notLoaded.length > 0) addWarning({ type: 'note', text: t('session.overlay.notLoaded', { parts: seen.notLoaded.join(', ') }) });
            overlaySummary = { label: seen.label, local: seen.local, server: seen.server, swapped: seen.swapped, missed: seen.missed, notLoaded: seen.notLoaded, ...(loadProblem === null ? {} : { loadProblem: loadProblem.message }) };
        }

        // The workbench shows the application's address, requests and console; once per second while it is open.
        if (bench !== null) {
            const pump = setInterval(() => {
                if (bench.page.isClosed()) {
                    clearInterval(pump);
                    return;
                }
                bench.url(pages.current().url());
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
            /** Hosts outside the navigation hosts the pages contacted: request count, resource types, failed requests. */
            thirdParty: () => [...thirdPartyHosts.values()].sort((a, b) => a.host.localeCompare(b.host)).map(({ types, ...rest }) => ({ ...rest, types: [...types].sort() })),
            // Only for recording a demonstration; the agent never gets at it through the channel.
            context: raw,
            ownsPage: (page) => pages.owns(page),
            /** Does the frame belong to the application? Never workbench or chat, never the human's tabs. */
            ownsFrame: (frame) => {
                const page = pages.pageOf(frame);
                return page !== false && page !== null && pages.owns(page);
            },
            /** The workbench (steps, chat, requests) if the application runs embedded, otherwise null. */
            workbench: bench,
            /** The application tab or its newest open popup, never a tab of the human. */
            page: () => pages.current(),
            waitReady,
            /** Reloads the current page like F5 with an empty cache so changed code surely arrives; waitReady reports errors. */
            reloadPage: async () => {
                const cdp = await raw.newCDPSession(bench?.page ?? raw.pages()[0]).catch(() => null);
                await cdp?.send('Network.clearBrowserCache').catch(() => {});
                await cdp?.detach().catch(() => {});
                await pages.current().reload({ waitUntil: 'load' });
                return waitReady({ timeout: spec.readyTimeoutMs });
            },
            /** Back to the app's start page with fresh code, and wait until it is ready. */
            // The application itself, not its newest popup: otherwise the start page would load in the popup, outside the workbench.
            // Open popups belong to the abandoned state and get closed.
            restart: async () => {
                for (const popup of pages.popups()) await popup.close().catch(() => {});
                await pages.main().goto(startUrl, { waitUntil: 'load' });
                return waitReady({ timeout: spec.readyTimeoutMs });
            },
            /**
             * Like restart, but in a new session (freshSession: cookies, storage, service workers gone), signed in again, then the
             * start page. So restoring a state begins like a new run, not in the session the last state left behind. Sign-in runs in
             * the application frame, the workbench stays.
             * @param as     credentials of another role (from readCredentials); defaults to the same account
             * @param start  start path of another app; defaults to this session's app
             */
            signInAgain: async ({ as, start } = {}) => {
                if (as !== undefined && as !== null) {
                    signedInAs = as;
                    if (as.password !== undefined && !passwords.includes(as.password)) passwords.push(as.password);
                }
                for (const popup of pages.popups()) await popup.close().catch(() => {});
                const signIn = async () => {
                    await freshSession(raw, pages.main(), resolved.url);
                    if (auth.type === 'session') await applyStorageState(raw, signedInAs.storageState);
                    if (auth.type === 'form') await formLogin(pages.main());
                };
                // The first sign-in happens before the trace starts; this one must not end up in it either.
                signingIn = true;
                try {
                    if (auth.type === 'form') await trace.pause(signIn);
                    else await signIn();
                } finally {
                    signingIn = false;
                }
                await pages.main().goto(start === undefined ? startUrl : `${resolved.url}${start}`, { waitUntil: 'load' });
                return waitReady({ timeout: spec.readyTimeoutMs });
            },
            /** The framework adapter: targets, page state, readiness. */
            framework,
            /** Native dialogs: arm the answer before an action, begin()/end() around it (dialogs.mjs). */
            dialogs,
            /** { locale, timezone } the browser runs with; stored with a recording. */
            browser: region,
            /** The CSS size of the application view right now (the app frame in the workbench); stored with a recording. */
            viewportSize: () => pages.main().evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null),
            failures: () => failures,
            /** What must never leave the browser as text: the role's password and values remembered as secret. */
            secrets: () => [...passwords, ...codes, ...hidden],
            /** A value redacted like the password from now on, e.g. from `remember` with `secret: true`. */
            hide: (value) => { if (typeof value === 'string' && !hidden.includes(value)) hidden.push(value); },
            warnings: () => warnings,
            /** With an overlay: what came from the local code after the first load (for the report), otherwise null. */
            overlay: () => overlaySummary,
            /** The request log: `mark()` before a step, `since(mark)` after it. */
            network: { mark: () => network.mark(), since: (mark, end) => network.since(mark, end) },
            /** Console and responses for an action's effect: `mark()` before, `since(mark)` after. */
            trail: { mark: () => trail.length, since: (mark) => trail.slice(mark).filter(({ line }) => line !== null) },
            /** A warning that does not come from the browser, e.g. a deviating effect in a passed run. */
            warn: (entry) => addWarning(entry),
            /** CSS selectors of messages on the page, from the config. */
            messageSelectors: config.messageSelectors ?? framework.messageSelectors ?? DEFAULT_MESSAGE_SELECTORS,
            /**
             * Retracts the failures from `from` up to before `to`: they belong to an attempt that `retry` repeats. What came after,
             * e.g. a script error of the reloaded page, stays.
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
        throw error;
    }
};
