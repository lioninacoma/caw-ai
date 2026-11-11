/**
 * Exit codes: 0 = pass, 1 = fail, 2 = error (environment), 3 = input rejected, 4 = recording needed (recording missing or
 * stale: record or fix, not a typo).
 */
export const EXIT = { pass: 0, fail: 1, error: 2, rejected: 3, needsRecording: 4 };

/** For several runs the worst outcome decides the exit code: pass < rejected < recording needed < fail < error. */
const SEVERITY = [EXIT.pass, EXIT.rejected, EXIT.needsRecording, EXIT.fail, EXIT.error];
export const worstExit = (codes) => codes.reduce((worst, code) => (SEVERITY.indexOf(code) > SEVERITY.indexOf(worst) ? code : worst), EXIT.pass);

// Error codes for which nothing ran: a call, config or test file that is not right.
const REJECTED = new Set(['usage', 'auth-missing', 'finish-rejected', 'test-invalid', 'test-missing', 'write-protected', 'target-invalid', 'config-invalid', 'config-missing', 'target-denied', 'unknown-command', 'command-invalid', 'step-limit', 'step-order', 'step-unknown', 'human-message', 'plan-required', 'plan-invalid', 'advice-invalid', 'advise-only']);
// The test needs a (new) recording first: not a bad call, but work for record or fix.
const NEEDS_RECORDING = new Set(['replay-missing', 'replay-stale']);

/** The exit code for an error code; anything that is neither input nor recording is an environment error. */
export const exitOf = (code) => {
    if (NEEDS_RECORDING.has(code)) return EXIT.needsRecording;
    return REJECTED.has(code) ? EXIT.rejected : EXIT.error;
};

/**
 * An expected error with a stable code. Anything about the environment ends with status `error`:
 * the application is not wrong, the run just has no verdict.
 */
export class CawError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CawError';
        this.code = code;
    }
}
