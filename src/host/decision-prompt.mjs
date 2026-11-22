// A run without a window that reaches a decision only a person takes asks in the terminal when one is there: title, what it is
// about, the options numbered, Enter for the answer that ends it without changing anything. The session may answer the same
// decision through caw_decide meanwhile; the first answer wins and the question in the terminal goes away.

import { contextSummary, endOption } from './decisions.mjs';
import { t } from '../shared/i18n.mjs';

/**
 * The terminal to ask in: a person at a terminal (stdin and stdout are one), not CI. Started by a session, the run has no
 * terminal of its own.
 * @param interactive the command's override (tests, e2e); otherwise CI decides
 * @returns { input, output }, or undefined when nobody is there to ask
 */
export const promptTerminal = ({ interactive, env = process.env, input = process.stdin, output = process.stdout } = {}) => {
    const person = interactive ?? (env.CI === undefined || env.CI === '');
    return person && input?.isTTY === true && output?.isTTY === true ? { input, output } : undefined;
};

/** The decision as the terminal shows it, one line each: what, about what, the options numbered. */
export const promptLines = (decision) => {
    const summary = contextSummary(decision.context, { lists: true });
    return [
        t('run.decision.ask.head', { id: decision.id, title: decision.title ?? decision.id }),
        ...(summary === '' ? [] : [`  ${summary}`]),
        ...decision.options.map((option, index) => `  ${index + 1}) ${option.label ?? option.id} (${option.id}${option.gate === 'human' ? `, ${t('run.decision.ask.human')}` : ''})`),
    ];
};

/**
 * Asks a decision in the terminal (decision-desk.mjs `ask`).
 * @returns (decision, signal) -> { option, message? }, or undefined when the terminal closed or the question was withdrawn
 */
export const terminalAsk = ({ input, output }) => async (decision, signal) => {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input, output });
    const closed = new Promise((resolve) => { rl.once('close', () => resolve(undefined)); });
    const withdraw = () => rl.close();
    signal?.addEventListener('abort', withdraw, { once: true });
    const question = (text) => Promise.race([rl.question(text, signal === undefined ? {} : { signal }).catch(() => undefined), closed]);
    try {
        if (signal?.aborted) return undefined;
        output.write(`\n${promptLines(decision).join('\n')}\n`);
        // Enter: the answer that ends the decision without changing anything, if it has one.
        const end = endOption(decision);
        const fallback = end === undefined ? undefined : decision.options.findIndex(({ id }) => id === end) + 1;
        for (;;) {
            const raw = await question(`${t('run.decision.ask.prompt')}${fallback === undefined ? '' : ` [${fallback}]`}: `);
            if (raw === undefined) return undefined;
            const text = raw.trim();
            const chosen = text === '' && fallback !== undefined ? decision.options[fallback - 1]
                : (/^\d+$/.test(text) ? decision.options[Number(text) - 1] : decision.options.find(({ id }) => id === text));
            if (chosen === undefined) {
                output.write(`  ${t('run.decision.ask.invalid', { count: decision.options.length })}\n`);
                continue;
            }
            // Revising a plan needs what should change.
            if (chosen.id !== 'revise') return { option: chosen.id };
            const message = await question(`${t('run.decision.ask.message')}: `);
            if (message === undefined) return undefined;
            if (message.trim() !== '') return { option: 'revise', message: message.trim() };
        }
    } finally {
        signal?.removeEventListener('abort', withdraw);
        rl.close();
    }
};
