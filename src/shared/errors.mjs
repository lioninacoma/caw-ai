/** Exit-Codes von `run`, `open` und `finish`: 0 = pass, 1 = fail, 2 = error (Umgebung), 3 = Eingabe abgelehnt. */
export const EXIT = { pass: 0, fail: 1, error: 2, rejected: 3 };

/**
 * Ein erwarteter Fehler mit stabilem Code. Alles, was die Umgebung betrifft, endet als Status `error`:
 * die Anwendung ist dann nicht falsch, der Lauf hat nur keine Aussage.
 */
export class CawError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CawError';
        this.code = code;
    }
}
