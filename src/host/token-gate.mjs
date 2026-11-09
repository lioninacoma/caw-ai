// Bevor Claude arbeitet, sagt der Chat einmal je Lauf, dass das Token kostet. „Nicht mehr fragen“ merkt sich das in den
// persoenlichen Einstellungen (prefs.json, nie im Projekt): tokenNotice off.

import { t } from '../shared/i18n.mjs';
import { readPrefs, writePref } from '../shared/prefs.mjs';

/**
 * @param chat  () => der aktuelle Chat oder null; ohne Chat (CI, --no-chat) gibt es nichts zu fragen
 * @returns async () => true, wenn Claude starten darf
 */
export const createTokenGate = ({ chat, prefs = readPrefs, save = (value) => writePref('tokenNotice', value) }) => {
    let agreed = false;
    return async () => {
        const current = chat();
        if (agreed || current === null || current === undefined || !current.available() || prefs().tokenNotice === 'off') return true;
        const choice = await current.choose('choosing', t('run.tokens.question'), [
            { id: 'go', label: t('run.tokens.go'), primary: true },
            { id: 'always', label: t('run.tokens.always') },
            { id: 'stop', label: t('run.tokens.stop') },
        ]);
        if (choice === 'always') {
            save('off');
            current.progress?.(t('run.tokens.remembered'));
        }
        agreed = choice === 'go' || choice === 'always';
        return agreed;
    };
};

/** Statt Claude, wenn der Mensch ablehnt: endet nie von selbst, haelt nichts an. */
export const IDLE_AGENT = { ended: new Promise(() => {}), stopTail: () => {}, stop: async () => {}, log: () => '' };
