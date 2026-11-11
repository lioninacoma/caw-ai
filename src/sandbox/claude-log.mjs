// Turns the events of `claude --output-format stream-json` into a readable log. It is written continuously
// so it is complete even when the host stops the container after the verdict.

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
 * One output line from Claude as log lines. Non-JSON stays unchanged, since that is how e.g. start errors
 * show up. Tool results are left out: they are in the trace and would only bloat the log.
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
        return [`API error ${event.error_status ?? ''} (${event.error ?? 'unknown'}), attempt ${event.attempt}`];
    }
    // "Claude beendet nach" is parsed by host/chat.mjs, so this line stays German.
    if (event.type === 'result') {
        const seconds = Math.round((event.duration_ms ?? 0) / 1000);
        const failure = event.is_error && event.result ? ` ${event.result}` : '';
        return [`Claude beendet nach ${seconds} s${event.is_error ? ' mit Fehler:' : '.'}${failure}`];
    }
    return [];
};

/**
 * Seconds since Claude started, to show where a run's time goes. The text may come from the application,
 * so control characters are dropped: it must not control the terminal.
 */
export const stampLine = (line, startedAt, now) => `[+${((now - startedAt) / 1000).toFixed(1)}s] ${line.replaceAll(/[^\P{Cc}\n\t]/gu, '')}\n`;

/** The same line for the terminal: time dimmed, commands, errors and the end coloured, Claude's text unchanged. */
export const colorLine = (stamped, paint) => {
    const match = /^(\[\+[\d.]+s\]) (.*)$/su.exec(stamped);
    if (match === null) return stamped;
    const [, stamp, text] = match;
    let colored = text;
    if (text.startsWith('> ')) colored = paint.cyan(text.trimEnd());
    else if (text.startsWith('API error')) colored = paint.yellow(text.trimEnd());
    else if (text.startsWith('Claude beendet')) colored = (text.includes('mit Fehler') ? paint.red : paint.dim)(text.trimEnd());
    return `${paint.dim(stamp)} ${colored.endsWith('\n') ? colored : `${colored}\n`}`;
};
