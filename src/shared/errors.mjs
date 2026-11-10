/**
 * Exit-Codes: 0 = pass, 1 = fail, 2 = error (Umgebung), 3 = Eingabe abgelehnt, 4 = Aufnahme noetig (Aufzeichnung fehlt oder ist
 * veraltet: record bzw. fix, kein Tippfehler).
 */
export const EXIT = { pass: 0, fail: 1, error: 2, rejected: 3, needsRecording: 4 };

/** Fuer mehrere Laeufe: Der schlimmste Ausgang bestimmt den Exit-Code. pass < abgelehnt < Aufnahme noetig < fail < error. */
const SEVERITY = [EXIT.pass, EXIT.rejected, EXIT.needsRecording, EXIT.fail, EXIT.error];
export const worstExit = (codes) => codes.reduce((worst, code) => (SEVERITY.indexOf(code) > SEVERITY.indexOf(worst) ? code : worst), EXIT.pass);

// Fehlercodes, die nichts haben laufen lassen: ein Aufruf, eine Config oder eine Testdatei, die nicht stimmt.
const REJECTED = new Set(['usage', 'auth-missing', 'finish-rejected', 'test-invalid', 'test-missing', 'write-protected', 'target-invalid', 'config-invalid', 'config-missing', 'target-denied', 'unknown-command', 'command-invalid', 'step-limit', 'step-order', 'step-unknown', 'human-message', 'plan-required', 'plan-invalid', 'advice-invalid', 'advise-only']);
// Der Test braucht erst eine (neue) Aufnahme: kein Fehler im Aufruf, sondern Arbeit mit record oder fix.
const NEEDS_RECORDING = new Set(['replay-missing', 'replay-stale']);

/** Der Exit-Code zu einem Fehlercode; was nicht als Eingabe oder Aufnahme gilt, ist ein Fehler der Umgebung. */
export const exitOf = (code) => {
    if (NEEDS_RECORDING.has(code)) return EXIT.needsRecording;
    return REJECTED.has(code) ? EXIT.rejected : EXIT.error;
};

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
