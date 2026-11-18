// The explore window waits for the human to sign in: a password field was there and is gone, the page has loaded. caw never
// reads what the human types: test users go into caw/.env by hand (test-users.mjs).

import { PHASE_EVENT } from './explore-card.mjs';

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

/** Sends a card phase to the page. */
export const sendPhase = (page, phase) =>
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser page, not in Node
    page.evaluate(([name, value]) => window.dispatchEvent(new CustomEvent(name, { detail: value })), [PHASE_EVENT, phase]).catch(() => {});
