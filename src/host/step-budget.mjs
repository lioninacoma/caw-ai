// Die harte Grenze fuer einen Lauf mit Claude: Der Host zaehlt jede Aktion am Browser, auch gescheiterte. So kann
// Claude suchen, wo es will, aber nicht endlos. Lesen kostet nichts.

import { CawError } from '../shared/errors.mjs';

export const DEFAULT_MAX_STEPS = 100;

const STEPS = new Set(['click', 'fill', 'type', 'press', 'goto', 'reload']);

export const withStepBudget = (handler, maxSteps) => {
    let used = 0;
    return {
        used: () => used,
        handler: async (command) => {
            if (STEPS.has(command?.action)) {
                if (used >= maxSteps) {
                    throw new CawError('step-limit', `Das Budget von ${maxSteps} Schritten ist aufgebraucht. Reiche das Ergebnis ein: Was du nicht erreicht hast, ist ein fail mit Begründung.`);
                }
                used += 1;
            }
            return handler(command);
        },
    };
};
