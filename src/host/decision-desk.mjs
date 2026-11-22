// The decision a run waits for, in its run folder: decision.json says what waits (id, context, options with their gates) or
// what was answered last and by whom. caw_decide writes decision-answer.json for the waiting one; the run takes it if the
// decision is still the same (its `seq`), and only an answer the gate allows. The first answer wins, window or session: the
// other side then sees the decision answered. A run without a window answers the provably harmless itself (decisions.mjs).
// The session's file tools reach the run folder too: an answer counts only with its proof (decision-proof.mjs), made by an MCP
// server the run trusts. Anything else in that file is ignored and reported.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HUMAN, answerOption, autoOption, endOption, notedOf } from './decisions.mjs';
import { fingerprint, newKeyPair, verifyAnswer } from './decision-proof.mjs';

export const DECISION_FILE = 'decision.json';
export const ANSWER_FILE = 'decision-answer.json';
/**
 * Who answered: the window's button, the session (caw_decide), the person in the session (elicitation), the person in the
 * terminal of a run without a window, or caw itself.
 */
export const ANSWERED_BY = ['window', 'session', 'elicitation', 'terminal', 'auto'];
/** Who may take a `human` option: a person, in the window, confirming in the session or in the terminal. */
const PERSON = ['window', 'elicitation', 'terminal'];

const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
};
/** Written whole or not at all: a reader never sees half a file. */
const writeJson = (file, value) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${file}.tmp`, file);
};

/** The decision file of a run folder: { state: 'waiting', seq, id, context, options, gate, since } or { state: 'answered' | 'closed', … }. */
export const readDecision = (dir) => readJson(join(dir, DECISION_FILE));
/** An answer for the waiting decision: { seq, id, option, message?, picked?, by }. */
export const writeAnswer = (dir, answer) => writeJson(join(dir, ANSWER_FILE), answer);

/**
 * May this answer settle the decision? The option must be offered (a written answer only to revise a plan), and a
 * `human` option only with the person's consent: the window, or their confirmation in the session (elicitation).
 * @returns undefined when it may, otherwise why not: unknown-option, message-not-taken, needs-human
 */
export const answerRefusal = (entry, { option, message, by }) => {
    const offered = entry.options.find((candidate) => candidate.id === option);
    if (offered === undefined) return 'unknown-option';
    if (option === 'revise' && (typeof message !== 'string' || message.trim() === '')) return 'message-not-taken';
    if (offered.gate === HUMAN && !PERSON.includes(by)) return 'needs-human';
    return undefined;
};

/** An ignored answer as the report names it: only plain ids, whatever the file held. */
const ignoredOf = (answer) => {
    const plain = (value) => (typeof value === 'string' && /^[\w.@-]{1,60}$/.test(value) ? value : '?');
    return { id: plain(answer?.id), option: plain(answer?.option), by: plain(answer?.by), at: new Date().toISOString() };
};

/**
 * The run's side of its decisions.
 * @param dir       the run folder
 * @param onSettled (entry) a decision was taken: { seq, id, option, by, at }
 * @param auto      a run without a window: it answers autoOption itself and stops at anything else
 * @param waitMs    without a window: how long a person may still answer a decision it cannot take through the session (an
 *                  attached session, caw_decide with their consent); 0 stops at once
 * @param onStop    (entry) without a window, a decision stayed open: the run names it and writes nothing
 * @param onStuck   (entry) such a decision has no answer that ends it (the plan): the run ends
 * @param trusted   () => the public keys of the MCP servers whose answers count (decision-proof.mjs)
 * @param starter   the key of the MCP server that started the run, which then alone may answer; null: one started it, but no
 *                  key came, so no answer counts; undefined: the `trusted` keys
 * @param onIgnored ({ id, option, by, at }) an answer file without a valid proof was ignored
 * @param keys      the run's key pair; a new one by default
 * @param ask       without a window: (entry, signal) -> { option, message? } or undefined, asks a person in the terminal for a
 *                  decision that needs one (decision-prompt.mjs); the first answer wins, the session's too, and `signal` then
 *                  withdraws the question. Undefined (no terminal, CI, started by a session): the decision waits `waitMs`
 * @returns { open(decision, inject), settle(decision, answer, by), close() }; `inject({ option, message?, picked?, by })`
 *          answers the decision in the chat and says whether it was still waiting
 */
export const createDesk = ({ dir, onSettled = () => {}, auto = false, waitMs = 0, onStop = () => {}, onStuck = () => {}, pollMs = 250, trusted = () => [], starter, onIgnored = () => {}, keys = newKeyPair(), ask }) => {
    const file = join(dir, DECISION_FILE);
    const answerFile = join(dir, ANSWER_FILE);
    // Where caw_decide finds the run's key, and whose answers the run takes: the session that started it, or any listening one.
    let from = { from: 'listeners' };
    if (starter === null) from = { from: 'none' };
    else if (starter !== undefined) from = { from: 'starter', starter: fingerprint(starter) };
    const answers = { key: keys.publicKey, ...from };
    const trustedNow = () => {
        if (starter === null) return [];
        return starter === undefined ? trusted() : [starter];
    };
    let seq = 0;
    // The decisions waiting, innermost last: a token notice or an advice card can come in between a conversation.
    const stack = [];
    let poll = null;
    // The decision answered last: caw_decide reads who answered it, also when the next one already waits.
    let last;
    const show = () => {
        const top = stack.at(-1);
        if (top !== undefined) writeJson(file, { state: 'waiting', ...top.entry, answers, ...(last === undefined ? {} : { answered: last }) });
    };
    const take = () => {
        const top = stack.at(-1);
        if (top === undefined || !existsSync(answerFile)) return;
        const answer = readJson(answerFile);
        rmSync(answerFile, { force: true });
        // Written by anything but an MCP server the run trusts: not an answer.
        if (!verifyAnswer(keys, trustedNow(), answer)) {
            onIgnored(ignoredOf(answer));
            return;
        }
        if (answer?.seq !== top.entry.seq || answer.id !== top.entry.id || !['session', 'elicitation'].includes(answer.by)) return;
        if (answerRefusal(top.entry, answer) !== undefined) return;
        top.inject({ option: answer.option, by: answer.by, ...(answer.message === undefined ? {} : { message: answer.message }), ...(answer.picked === undefined ? {} : { picked: answer.picked }) });
    };
    /** Without a window: nobody answered what needs a person. The ending answer if there is one, otherwise the run ends. */
    const stop = (held) => {
        if (!stack.includes(held)) return;
        onStop(held.entry);
        const end = endOption(held.entry);
        if (end === undefined) onStuck(held.entry);
        else held.inject({ option: end, by: 'auto' });
    };
    return {
        open: (decision, inject) => {
            seq += 1;
            // window: a person can answer in the window; a run without one only through the session (caw_decide).
            const held = { decision, inject, entry: { seq, ...decision, window: !auto, since: new Date().toISOString() } };
            stack.push(held);
            show();
            poll ??= setInterval(take, pollMs);
            poll.unref?.();
            if (!auto) return;
            const option = autoOption(held.entry);
            // After the chat has the question up, as a click would come.
            if (option !== undefined) setImmediate(() => { if (stack.includes(held)) held.inject({ option, by: 'auto' }); });
            else if (ask !== undefined && held.entry.gate === HUMAN) {
                // A person at the terminal: asked there, while the session may still answer through caw_decide.
                const asking = new AbortController();
                held.asking = asking;
                const answered = (answer) => {
                    if (!stack.includes(held) || asking.signal.aborted) return;
                    if (answer === undefined || answerRefusal(held.entry, { ...answer, by: 'terminal' }) !== undefined) stop(held);
                    else held.inject({ ...answer, by: 'terminal' });
                };
                Promise.resolve().then(() => ask(held.entry, asking.signal)).then(answered, () => answered(undefined));
            } else if (waitMs > 0) {
                held.timer = setTimeout(() => stop(held), waitMs);
                held.timer.unref?.();
            } else setImmediate(() => stop(held));
        },
        settle: (decision, answer, by) => {
            const index = stack.findIndex((held) => held.decision === decision);
            if (index === -1) return;
            const [held] = stack.splice(index, 1);
            clearTimeout(held.timer);
            held.asking?.abort();
            const option = answerOption(answer);
            const gate = held.entry.options.find((offered) => offered.id === option)?.gate;
            const entry = { seq: held.entry.seq, id: held.entry.id, option, ...(gate === undefined ? {} : { gate }), by, at: new Date().toISOString(), ...notedOf(held.entry, option) };
            last = entry;
            if (option !== null) onSettled(entry);
            if (stack.length > 0) show();
            else {
                writeJson(file, { state: 'answered', ...entry });
                clearInterval(poll);
                poll = null;
            }
        },
        close: () => {
            clearInterval(poll);
            poll = null;
            for (const held of stack.splice(0)) {
                clearTimeout(held.timer);
                held.asking?.abort();
            }
            if (existsSync(file) && readDecision(dir)?.state === 'waiting') writeJson(file, { state: 'closed', at: new Date().toISOString() });
        },
    };
};
