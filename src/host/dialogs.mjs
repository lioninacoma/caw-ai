// Native dialogs (alert, confirm, prompt, beforeunload; Q11). A dialog blocks the page until it is answered, so every tab of the
// test has this one handler. What to answer is decided before the action that opens the dialog: on replay from the recording
// (the action's `dialog`), for Claude by `caw agent dialog accept|dismiss`, in a demonstration by the human in the chat. A dialog
// nobody decided is dismissed and reported. The decision is recorded on the action that opened the dialog, never on its own.

export const DIALOG_TYPES = ['alert', 'confirm', 'prompt', 'beforeunload'];
const MESSAGE_MAX = 200;

/** The dialog text as recorded: digits as #, so a count or an id in it does not look like a change (informational only). */
export const dialogMessage = (text) => String(text ?? '').replace(/\d/g, '#').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX);

/**
 * Is a recorded `dialog` well formed? { type, accept, value?, message? }: alert only accepted, value only on an accepted prompt.
 * @returns null or the problem as a key of the config texts
 */
export const dialogProblem = (dialog) => {
    if (typeof dialog !== 'object' || dialog === null || Array.isArray(dialog)) return 'shape';
    if (Object.keys(dialog).some((key) => !['type', 'accept', 'value', 'message'].includes(key))) return 'shape';
    if (!DIALOG_TYPES.includes(dialog.type)) return 'type';
    if (typeof dialog.accept !== 'boolean') return 'accept';
    if (dialog.type === 'alert' && dialog.accept !== true) return 'alert';
    if (dialog.value !== undefined && (typeof dialog.value !== 'string' || dialog.type !== 'prompt' || dialog.accept !== true)) return 'value';
    if (dialog.message !== undefined && typeof dialog.message !== 'string') return 'shape';
    return null;
};

/**
 * The dialog handler of one browser session.
 * @param ask   optional (demonstration): (info) => Promise<{ accept, value? } | null>, the human's answer; null dismisses
 * @returns {
 *   handle(dialog)      the listener for page.on('dialog')
 *   arm(decision)       the answer for the next dialog: { accept, value?, type? } (replay: the recorded one; Claude: dialog accept)
 *   begin() / end()     around one action: begin() returns the dialogs seen since the last end() (between actions), end() those
 *                       seen since begin(), and disarms
 *   asking(ask)         sets or clears (null) the human's answers, for the demonstration
 * }
 * Every seen dialog is { type, message (as shown), accept, value?, decided: 'armed' | 'human' | 'dismissed' }.
 */
export const createDialogs = () => {
    let armed = null;
    let ask = null;
    let seen = [];
    const answer = async (dialog, accept, value) => {
        try {
            // An alert has only OK: accepting is the only answer, and dismissing it does the same.
            if (dialog.type() === 'alert' || accept) await dialog.accept(dialog.type() === 'prompt' ? value ?? dialog.defaultValue() : undefined);
            else await dialog.dismiss();
        } catch {
            // The page went away with its dialog (navigation, closed tab).
        }
    };
    return {
        handle: async (dialog) => {
            const info = { type: dialog.type(), message: dialog.message() };
            let decision = armed;
            let decided = 'armed';
            armed = null;
            if (decision === null && ask !== null) {
                decision = await Promise.resolve(ask({ ...info, defaultValue: dialog.defaultValue() })).catch(() => null);
                decided = 'human';
            }
            if (decision === null) {
                seen.push({ ...info, accept: info.type === 'alert', decided: 'dismissed' });
                await answer(dialog, false);
                return;
            }
            const accept = info.type === 'alert' ? true : decision.accept === true;
            const value = info.type === 'prompt' && accept ? decision.value ?? dialog.defaultValue() : undefined;
            seen.push({ ...info, accept, ...(value === undefined ? {} : { value }), decided, ...(decision.type !== undefined && decision.type !== info.type ? { expected: decision.type } : {}) });
            await answer(dialog, accept, value);
        },
        arm: (decision) => { armed = decision ?? null; },
        begin: () => {
            const between = seen;
            seen = [];
            return between;
        },
        end: () => {
            const taken = seen;
            seen = [];
            armed = null;
            return taken;
        },
        asking: (given) => { ask = given ?? null; },
    };
};

/**
 * Replay: what the dialogs of one action mean for the run, as warnings. The recorded decision applied: nothing. Expected but
 * none came: dialog-missing. Another type: applied where possible, plus a warning. Any other dialog: dismissed, dialog-unexpected.
 * @param expected the action's recorded `dialog`, or undefined
 * @param seen     end() of the dialog handler for this action
 * @returns [{ type: 'dialog-missing' | 'dialog-type' | 'dialog-unexpected', dialog?, expected? }]
 */
export const dialogFindings = (expected, seen) => {
    const findings = [];
    const used = seen.find(({ decided }) => decided === 'armed');
    if (expected !== undefined && used === undefined) findings.push({ type: 'dialog-missing', expected });
    if (used?.expected !== undefined) findings.push({ type: 'dialog-type', dialog: used, expected });
    for (const dialog of seen.filter(({ decided }) => decided === 'dismissed')) findings.push({ type: 'dialog-unexpected', dialog });
    return findings;
};

/** The recorded `dialog` of an action from what was seen during it: the first decided dialog. undefined without one. */
export const recordedDialog = (seen) => {
    const first = seen.find(({ decided }) => decided !== 'dismissed');
    if (first === undefined) return undefined;
    return {
        type: first.type,
        accept: first.accept,
        ...(first.value === undefined ? {} : { value: first.value }),
        ...(first.message === '' ? {} : { message: dialogMessage(first.message) }),
    };
};
