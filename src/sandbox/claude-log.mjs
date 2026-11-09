// Macht aus den Ereignissen von `claude --output-format stream-json` ein lesbares Log. Es wird laufend
// geschrieben, damit es auch dann vollstaendig ist, wenn der Host den Container nach dem Urteil beendet.

const MAX_INPUT_CHARS = 500;

const shorten = (text) => {
    const line = String(text).replaceAll(/\s*\n\s*/g, ' ⏎ ');
    return line.length > MAX_INPUT_CHARS ? `${line.slice(0, MAX_INPUT_CHARS)} ...` : line;
};

const toolCall = ({ name, input }) => `> ${name}: ${shorten(input?.command ?? JSON.stringify(input ?? {}))}`;

const assistantLines = (message) => (message?.content ?? []).flatMap((block) => {
    if (block.type === 'text' && block.text.trim() !== '') return [block.text.trim()];
    if (block.type === 'tool_use') return [toolCall(block)];
    return [];
});

/**
 * Eine Ausgabezeile von Claude als Log-Zeilen. Was kein JSON ist, bleibt unveraendert, denn so melden sich
 * z. B. Startfehler. Toolergebnisse bleiben draussen: Sie stehen im Trace und wuerden das Log nur aufblaehen.
 */
export const formatClaudeLine = (line) => {
    if (line.trim() === '') return [];
    let event;
    try {
        event = JSON.parse(line);
    } catch {
        return [line];
    }
    if (event.type === 'assistant') return assistantLines(event.message);
    if (event.type === 'system' && event.subtype === 'api_retry') {
        return [`API-Fehler ${event.error_status ?? ''} (${event.error ?? 'unbekannt'}), Versuch ${event.attempt}`];
    }
    if (event.type === 'result') {
        const seconds = Math.round((event.duration_ms ?? 0) / 1000);
        const failure = event.is_error && event.result ? ` ${event.result}` : '';
        return [`Claude beendet nach ${seconds} s${event.is_error ? ' mit Fehler:' : '.'}${failure}`];
    }
    return [];
};

/**
 * Sekunden seit dem Start von Claude: So sieht man, wo die Zeit eines Laufs bleibt. Der Text kann aus der Anwendung
 * stammen, darum fallen Steuerzeichen weg: Er darf das Terminal nicht steuern.
 */
export const stampLine = (line, startedAt, now) => `[+${((now - startedAt) / 1000).toFixed(1)}s] ${line.replaceAll(/[^\P{Cc}\n\t]/gu, '')}\n`;

/** Dieselbe Zeile fuers Terminal: Zeit gedimmt, Befehle, Fehler und Abschluss farbig, Claudes Text unveraendert. */
export const colorLine = (stamped, paint) => {
    const match = /^(\[\+[\d.]+s\]) (.*)$/su.exec(stamped);
    if (match === null) return stamped;
    const [, stamp, text] = match;
    let colored = text;
    if (text.startsWith('> ')) colored = paint.cyan(text.trimEnd());
    else if (text.startsWith('API-Fehler')) colored = paint.yellow(text.trimEnd());
    else if (text.startsWith('Claude beendet')) colored = (text.includes('mit Fehler') ? paint.red : paint.dim)(text.trimEnd());
    return `${paint.dim(stamp)} ${colored.endsWith('\n') ? colored : `${colored}\n`}`;
};
