// Before Claude works, the chat says once per run that this costs tokens. "Don't ask again" stores that in the
// personal settings (prefs.json, never in the project): tokenNotice off.

import { t } from '../shared/i18n.mjs';
import { readPrefs, writePref } from '../shared/prefs.mjs';

/**
 * @param chat  () => the current chat or null; without a chat (CI, --no-chat) there is nothing to ask
 * @returns async ({ decline }) => true if Claude may start. `decline` labels the refusal button with what it does
 *          (continue without Claude, or cancel the run).
 */
export const createTokenGate = ({ chat, prefs = readPrefs, save = (value) => writePref('tokenNotice', value) }) => {
    let agreed = false;
    return async ({ decline = t('run.tokens.withoutClaude') } = {}) => {
        const current = chat();
        if (agreed || current === null || current === undefined || !current.available() || prefs().tokenNotice === 'off') return true;
        const choice = await current.choose('choosing', t('run.tokens.question'), [
            { id: 'go', label: t('run.tokens.go'), primary: true },
            { id: 'always', label: t('run.tokens.always') },
            { id: 'stop', label: decline },
        ]);
        if (choice === 'always') {
            save('off');
            current.progress?.(t('run.tokens.remembered'));
        }
        agreed = choice === 'go' || choice === 'always';
        return agreed;
    };
};

/** Stands in for Claude when the human declines: never ends on its own, stops nothing. */
export const IDLE_AGENT = { ended: new Promise(() => {}), stopTail: () => {}, stop: async () => {}, log: () => '' };
