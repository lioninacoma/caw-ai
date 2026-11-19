// Durations on the command line always carry their unit (30s, 60m, 500ms, 1.5h): a bare number would leave open whether
// seconds or minutes are meant, and the flags used to differ in that.

import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';

const UNIT_MS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/** The flags with durations: allowed range and an example for messages. */
export const DURATION_FLAGS = {
    '--step-timeout': { min: '1s', max: '10m', example: '30s' },
    '--agent-timeout': { min: '1m', max: '24h', example: '60m' },
    '--timeout': { min: '100ms', max: '10m', example: '20s' },
};

/** "30s" → 30000; undefined for anything else (bare numbers, unknown units, spaces). */
export const durationMs = (text) => {
    const match = DURATION.exec(String(text).trim());
    return match === null ? undefined : Number(match[1]) * UNIT_MS[match[2]];
};

/**
 * A duration flag's value in milliseconds, or a usage error naming the unit and the allowed range.
 * @param flag one of DURATION_FLAGS
 */
export const parseDuration = (flag, value) => {
    const { min, max, example } = DURATION_FLAGS[flag];
    const ms = durationMs(value);
    if (ms === undefined) {
        const bare = /^\d+(?:\.\d+)?$/.test(String(value).trim());
        throw new CawError('usage', t(bare ? 'session.args.durationUnit' : 'session.args.durationForm', { flag, value, example }));
    }
    if (ms < durationMs(min) || ms > durationMs(max)) throw new CawError('usage', t('session.args.durationRange', { flag, min, max }));
    return ms;
};
