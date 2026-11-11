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

const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 850 → "850", 85_400 → "85k", 1_250_000 → "1.3M". */
const tokens = (count) => {
    if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
    if (count >= 1000) return `${Math.round(count / 1000)}k`;
    return String(count);
};

/**
 * What the run cost, from the result event, e.g. " · 12 turns · 85k tokens in / 6k out · $0.31". Only what the event
 * carries. Tokens in include cache reads and writes: Claude read them too, only cheaper.
 */
const usageText = (event) => {
    const parts = [];
    if (isCount(event.num_turns)) parts.push(`${event.num_turns} turn${event.num_turns === 1 ? '' : 's'}`);
    const usage = event.usage ?? {};
    const inKeys = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].filter((key) => isCount(usage[key]));
    const inTokens = inKeys.length > 0 ? tokens(inKeys.reduce((sum, key) => sum + usage[key], 0)) : null;
    const outTokens = isCount(usage.output_tokens) ? tokens(usage.output_tokens) : null;
    if (inTokens !== null && outTokens !== null) parts.push(`${inTokens} tokens in / ${outTokens} out`);
    else if (inTokens !== null) parts.push(`${inTokens} tokens in`);
    else if (outTokens !== null) parts.push(`${outTokens} tokens out`);
    if (isCount(event.total_cost_usd)) parts.push(`$${event.total_cost_usd.toFixed(2)}`);
    return parts.map((part) => ` · ${part}`).join('');
};

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
    // host/chat.mjs recognises this line by "Claude finished after".
    if (event.type === 'result') {
        const seconds = Math.round((event.duration_ms ?? 0) / 1000);
        const failure = event.is_error && event.result ? ` ${event.result}` : '';
        return [`Claude finished after ${seconds} s${usageText(event)}${event.is_error ? ' with an error:' : '.'}${failure}`];
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
    else if (text.startsWith('Claude finished')) colored = (text.includes('with an error') ? paint.red : paint.dim)(text.trimEnd());
    return `${paint.dim(stamp)} ${colored.endsWith('\n') ? colored : `${colored}\n`}`;
};
