// A run with --attach: which listening session answers (attach.mjs) and whether it is still there. The run binds to the named
// listener, or to the only one; it waits while none (or several, without a name) listen. When the bound session goes away the
// window stays: the link says "lost" and binds to the next session that attaches. A bound session that lives is never replaced.

import { liveListeners, listenerOf, matchListeners, sendEvent } from '../shared/attach.mjs';

/**
 * @param want     --attach's value (a key or a session id start), or true for the only listener
 * @param onState  (state, { key, agent, candidates }) on every change: waiting, connected, lost, back
 */
export const createSessionLink = ({ root, want = true, onState = () => {}, pollMs = 1000, env = process.env }) => {
    let key = null;
    let agent;
    let state = null;
    let candidates = [];
    const waiters = [];
    const set = (next, extra = {}) => {
        if (next === state && extra.candidates === undefined) return;
        state = next;
        onState(state, { key, agent, ...extra });
        if (state === 'connected' || state === 'back') for (const resolve of waiters.splice(0)) resolve(key);
    };
    const tick = () => {
        if (key !== null && listenerOf(root, key, env) !== undefined) return;
        if (key !== null && state !== 'lost') set('lost');
        const live = liveListeners(root, env);
        // Waiting: the named listener, or the only one. Lost: the newest that attached since, the session coming back.
        const named = key === null && typeof want === 'string' ? matchListeners(live, want) : live;
        const fresh = key === null ? named : named.filter((listener) => listener.key !== key);
        if (fresh.length === 1 || (key !== null && fresh.length > 0)) {
            const chosen = fresh.at(-1);
            const back = key !== null;
            key = chosen.key;
            agent = chosen.agent;
            set(back ? 'back' : 'connected');
            return;
        }
        const names = fresh.map((listener) => listener.key);
        if (key === null && names.join() !== candidates.join()) {
            candidates = names;
            set('waiting', { candidates: names });
        } else if (state === null) set('waiting', { candidates: names });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    timer.unref?.();
    return {
        /** The bound listener's key, null while waiting. */
        key: () => key,
        /** The coding agent's name the listener gave (e.g. Claude Code), if any. */
        agent: () => agent,
        state: () => state,
        /** Resolves with the key once a session is bound. */
        connected: () => (key !== null && state !== 'lost' ? Promise.resolve(key) : new Promise((resolve) => { waiters.push(resolve); })),
        /** One line for the bound session's Monitor; nothing while none is bound. */
        tell: (text) => {
            if (key !== null) sendEvent(root, key, text);
        },
        stop: () => clearInterval(timer),
    };
};
