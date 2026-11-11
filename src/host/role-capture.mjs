// Test users in the window: the human signs in, the card asks for the role name, caw-ai writes caw/.env (test-users.mjs).
// "+ Another role" signs out and starts again with the next account. Used by explore, `caw-ai role add` and by record, run and
// open when a test's role has no test user yet. Claude never sees the values: they go from the page to this process to the file.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { authOf, environmentDefs, loadConfig } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { createUi } from '../shared/ui.mjs';
import { CREDENTIALS_BINDING, DONE_BINDING, NEXT_BINDING, PHASE_BINDING, PHASE_EVENT, ROLE_BINDING, exploreCardScript } from './explore-card.mjs';
import { parseEnvFile } from './linux.mjs';
import { ENV_PATH, ROLE_NAME, credentialsScript, saveTestUser, suggestRole } from './test-users.mjs';

const ui = createUi();
const POLL_MS = 500;
export const HUMAN_MS = 30 * 60 * 1000;

/** Is a visible password field present, and has the page finished loading? Runs in the page. */
export const formState = () => ({
    form: [...document.querySelectorAll('input[type=password]')].some((el) => el.getBoundingClientRect().width > 0),
    loaded: document.readyState === 'complete',
});

/**
 * Waits until the human has signed in: a password field was there and is gone, the page has finished loading.
 * @returns 'signed-in', 'closed' or 'timeout'; `stop()` on the returned handle ends the wait early with 'stopped'
 */
export const waitForSignIn = (page, { sawForm = false, until = HUMAN_MS } = {}) => {
    let stop = false;
    const result = (async () => {
        let seen = sawForm;
        const start = Date.now();
        while (!stop && Date.now() - start < until) {
            const state = await page.evaluate(formState).catch(() => null);
            if (state === null && page.isClosed?.()) return 'closed';
            if (state?.form) seen = true;
            else if (seen && state?.loaded) return 'signed-in';
            await new Promise((ok) => { setTimeout(ok, POLL_MS); });
        }
        return stop ? 'stopped' : 'timeout';
    })();
    return { result, stop: () => { stop = true; } };
};

/** The texts of the role steps on the card. */
export const roleTexts = () => ({
    label: t('cli.roleCardLabel'),
    save: t('cli.roleCardSave').toUpperCase(),
    more: t('cli.roleCardMore').toUpperCase(),
    finish: t('cli.roleCardFinish').toUpperCase(),
});

/**
 * Bindings and page scripts for capturing test users; call before the first navigation.
 * @returns the capture state: `credentials` (last seen in the page, only in this process), `onRole`, `onNext`
 */
export const installCapture = async (context) => {
    const state = { credentials: null, onRole: null, onNext: null };
    await context.exposeBinding(CREDENTIALS_BINDING, (_source, value) => {
        if (typeof value?.user === 'string' && typeof value?.password === 'string' && value.user !== '' && value.password !== '') state.credentials = { user: value.user, password: value.password };
    });
    await context.exposeBinding(ROLE_BINDING, async (_source, role) => (state.onRole === null ? { ok: false } : state.onRole(role)));
    await context.exposeBinding(NEXT_BINDING, (_source, choice) => { state.onNext?.(choice); });
    await context.addInitScript({ content: credentialsScript(CREDENTIALS_BINDING) });
    return state;
};

/** Sends a card phase to the page, as a name or with details ({ phase, user, role }). */
export const sendPhase = (page, detail) =>
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser page, not in Node
    page.evaluate(([name, value]) => window.dispatchEvent(new CustomEvent(name, { detail: value })), [PHASE_EVENT, detail]).catch(() => {});

/**
 * The role rounds after a sign-in: name the role, save, then another test user or finish.
 * @param page       the window's page
 * @param capture    from installCapture
 * @param setPhase   (detail) => shows the phase on the card and answers the phase binding
 * @param signOut    async () => fresh session on the sign-in page for the next account
 * @param fixedRole  this role is needed (record, run): prefilled, and after saving the run goes on
 * @param closed     a promise that settles when the window closes
 * @returns the saved role names
 */
export const roleRounds = async ({ root, page, capture, setPhase, signOut, fixedRole, taken = [], closed }) => {
    const saved = [];
    for (;;) {
        const credentials = capture.credentials;
        if (credentials === null) return saved;
        const suggestion = fixedRole ?? suggestRole([...taken, ...saved]);
        const named = new Promise((done) => {
            capture.onRole = async (role) => {
                if (!ROLE_NAME.test(String(role))) return { ok: false, error: t('cli.testUserRoleBad', { role: String(role) }) };
                if (fixedRole !== undefined && role !== fixedRole) return { ok: false, error: t('cli.roleCardFixed', { role: fixedRole }) };
                try {
                    const result = saveTestUser(root, { role, ...credentials });
                    done(result);
                    return { ok: true };
                } catch (error) {
                    return { ok: false, error: error.message };
                }
            };
        });
        await setPhase({ phase: 'role', user: credentials.user, role: suggestion });
        const result = await Promise.race([named, closed.then(() => null)]);
        capture.onRole = null;
        if (result === null) return saved;
        saved.push(result.role);
        ui.success(t('cli.roleSaved', { role: result.role, file: ENV_PATH, names: `${result.loginEnv}, ${result.passwordEnv}` }));
        if (result.gitignore) ui.note(t('cli.roleGitignore', { file: ENV_PATH }));
        // A needed role: saved, the run goes on in its own window.
        if (fixedRole !== undefined) {
            await setPhase({ phase: 'done', role: result.role });
            return saved;
        }
        await setPhase({ phase: 'saved', role: result.role });
        const next = await Promise.race([new Promise((done) => { capture.onNext = done; }), closed.then(() => 'finish')]);
        capture.onNext = null;
        if (next !== 'more') return saved;
        capture.credentials = null;
        await signOut();
        await setPhase('signin');
        const signedIn = waitForSignIn(page, { sawForm: true });
        const first = await Promise.race([signedIn.result, closed.then(() => 'closed')]);
        signedIn.stop();
        if (first !== 'signed-in') return saved;
    }
};

/** Signs the browser out for the next account: no cookies or storage, then the sign-in page. */
export const freshSession = (page, url) => async () => {
    await page.context().clearCookies().catch(() => {});
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser page, not in Node
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage may be blocked */ } }).catch(() => {});
    await page.goto(url, { waitUntil: 'load' }).catch(() => {});
};

/** Has this role a test user (login and password) in the environment or in caw/.env? Without form or basic sign-in: true. */
export const hasTestUser = (root, config, role, env = process.env) => {
    const auth = authOf(config);
    if (auth.type !== 'form' && auth.type !== 'basic') return true;
    const entry = config.roles?.[role];
    if (entry === undefined) return false;
    const file = join(root, ENV_PATH);
    const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
    return [entry.loginEnv, entry.passwordEnv].every((name) => name !== undefined && (env[name] || fromFile[name]));
};

/** Where the window signs in: the environment's address plus the sign-in path of the config. */
const signInUrl = (config, target) => {
    const urls = environmentDefs(config)[target]?.urls ?? {};
    const base = urls[''] ?? Object.values(urls)[0];
    if (base === undefined) throw new CawError('target-invalid', t('cli.roleTargetUnknown', { target, environments: Object.keys(config.environments ?? {}).join(', ') }));
    return new URL(authOf(config).path ?? '/', base).href;
};

const openWindow = async ({ url, insecureTls }) => {
    const { exploreBrowser } = await import('./browser-session.mjs');
    return exploreBrowser({ url, insecureTls });
};

/**
 * Opens a window on the sign-in page and saves test users under roles. Used by `caw-ai role add` and when a test needs a role
 * without a test user.
 * @param role      prefilled name; with `needed` the only name accepted
 * @param reason    the first card text, e.g. which test needs the role
 * @returns the saved role names (empty if the window was closed)
 */
export const captureTestUsers = async (root, { target, role, needed = false, reason, open = openWindow } = {}) => {
    const config = loadConfig(root);
    const auth = authOf(config);
    if (auth.type !== 'form' && auth.type !== 'basic') throw new CawError('usage', t('cli.roleAuthType', { type: auth.type }));
    const url = signInUrl(config, target);
    const browser = await open({ url, insecureTls: config.insecureTls === true });
    const { page } = browser;
    const context = page.context();
    let phase = 'wait';
    const closed = new Promise((done) => { page.on('close', () => done('closed')); });
    try {
        await context.exposeBinding(PHASE_BINDING, () => phase);
        await context.exposeBinding(DONE_BINDING, () => {});
        const capture = await installCapture(context);
        await context.addInitScript({
            content: exploreCardScript({
                title: 'CAW-AI',
                steps: { signin: `1 ${t('cli.exploreStepSignIn')}`.toUpperCase(), role: `2 ${t('cli.roleStep')}`.toUpperCase() },
                text: {
                    wait: t('cli.exploreCardWait'),
                    signin: reason ?? t('cli.roleCardSignIn'),
                    role: t('cli.roleCardRole'),
                    saved: t('cli.roleCardSaved'),
                    done: needed ? t('cli.roleCardContinue') : t('cli.roleCardSaved'),
                },
                page: t('cli.exploreCardPage'),
                button: t('cli.exploreDoneButton').toUpperCase(),
                saved: t('cli.exploreCardSaved'),
                role: roleTexts(),
            }),
        });
        const setPhase = async (detail) => {
            phase = detail;
            await sendPhase(page, detail);
        };
        await page.goto(url, { waitUntil: 'load' });
        await setPhase('signin');
        ui.info(reason ?? t('cli.roleSignIn', { target }));
        const pending = ui.pending(t('cli.exploreWaitingSignIn'));
        const signedIn = waitForSignIn(page);
        const first = await Promise.race([signedIn.result, closed]);
        signedIn.stop();
        if (first !== 'signed-in') {
            pending.fail(t('cli.exploreClosed'));
            return [];
        }
        pending.done(t('cli.exploreSignedInDone'));
        if (capture.credentials === null) {
            ui.warn(t('cli.roleNoCredentials'));
            return [];
        }
        const saved = await roleRounds({
            root,
            page,
            capture,
            setPhase,
            signOut: freshSession(page, url),
            fixedRole: needed ? role : undefined,
            taken: Object.keys(config.roles ?? {}).filter((name) => name !== role),
            closed,
        });
        // The card shows the result for a moment before the window closes.
        if (saved.length > 0) await new Promise((done) => { setTimeout(done, 1200); });
        return saved;
    } finally {
        await browser.close();
    }
};

/**
 * Before record, run or open: if the test's role has no test user, the human signs in once in a window and the run goes on.
 * Without a person (CI, --headless, no window) nothing happens and the run reports credentials-missing as before.
 * @returns true if a test user was saved
 */
export const ensureTestUser = async (root, config, { role, target, test, interactive, capture = captureTestUsers }) => {
    if (!interactive || role === undefined || hasTestUser(root, config, role)) return false;
    if (!ROLE_NAME.test(String(role))) return false;
    const reason = t('cli.roleNeeded', { role, test });
    const saved = await capture(root, { target, role, needed: true, reason });
    if (!saved.includes(role)) throw new CawError('credentials-missing', t('cli.roleNotSaved', { role }));
    return true;
};
