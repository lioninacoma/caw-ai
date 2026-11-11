// The hard limit for a run with Claude: the host counts every browser action, failed ones included. Claude can
// search wherever it likes, but not forever. Reading is free.

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
                    throw new CawError('step-limit', `The budget of ${maxSteps} steps is used up. Submit the result: whatever you did not reach is a fail with a reason.`);
                }
                used += 1;
            }
            return handler(command);
        },
    };
};
