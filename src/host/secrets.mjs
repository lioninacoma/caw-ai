// Passwoerter verlassen den Browser nie als Text. Playwrights ARIA-Snapshot schreibt den Wert jedes Felds hinein, auch eines
// Passwortfelds; ohne diese Schwaerzung staende das Passwort der Rolle im Snapshot fuer Claude und in der Wirkung einer Aufnahme.

export const MASK = '••••';
const MIN_SECRET = 4;

/** Laeuft im Browser: die Werte aller Passwortfelder, auch in offenen Shadow Roots und aufgedeckten Feldern mit autocomplete. */
export function passwordValues() {
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of root.querySelectorAll('*')) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    // Ein aufgedecktes Passwort ist ein Textfeld; autocomplete verraet es trotzdem.
    return deepAll('input[type=password], input[autocomplete=current-password], input[autocomplete=new-password]').map((input) => input.value).filter((value) => value !== '');
}

/** Ersetzt jedes Geheimnis im Text durch die Maske. Zu kurze Werte bleiben, sie wuerden beliebige Woerter treffen. */
export const redact = (text, secrets) => {
    if (typeof text !== 'string') return text;
    const wanted = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);
    return wanted.reduce((current, secret) => current.split(secret).join(MASK), text);
};

/** Wie `redact`, fuer jeden Text in Listen und einfachen Objekten, etwa ein Ergebnis fuer den Bericht. */
export const redactDeep = (value, secrets) => {
    if (typeof value === 'string') return redact(value, secrets);
    if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]));
    return value;
};

/**
 * Schwaerzt einen Text mit den bekannten Geheimnissen (Passwort der Rolle) und den Passwortfeldern der Seite.
 * @param page Seite oder Frame mit `evaluate`
 */
export const redactFor = async (page, text, known = []) => {
    const values = await (async () => page.evaluate(passwordValues))().catch(() => []);
    return redact(text, [...known, ...(Array.isArray(values) ? values : [])]);
};
