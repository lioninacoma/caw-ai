// Terminal colours without dependencies. Output to files and pipes stays free of control sequences.

const CODES = { red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36, dim: 2, bold: 1 };

/** NO_COLOR always wins, FORCE_COLOR forces colour, otherwise the terminal decides. */
export const colorEnabled = ({ env = process.env, isTTY = process.stdout.isTTY } = {}) => {
    if (env.NO_COLOR) return false;
    return Boolean(env.FORCE_COLOR) || Boolean(isTTY);
};

export const painter = (enabled) => Object.fromEntries(Object.entries(CODES).map(([name, code]) => [
    name,
    (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text)),
]));

/** Does the terminal support 24-bit colour? Windows Terminal, VS Code, iTerm and anything with COLORTERM=truecolor. */
export const truecolor = (env = process.env) => /truecolor|24bit/i.test(env.COLORTERM ?? '') || env.WT_SESSION !== undefined
    || /vscode|iTerm|WezTerm|ghostty/i.test(env.TERM_PROGRAM ?? '');

const rgb = (hex) => hex.slice(1).match(/../g).map((part) => parseInt(part, 16));

/** The nearest colour of the 256-colour palette (6x6x6 cube or grey ramp). */
export const to256 = (hex) => {
    const [r, g, b] = rgb(hex);
    const level = (value) => (value < 48 ? 0 : value < 115 ? 1 : Math.floor((value - 35) / 40));
    const steps = [0, 95, 135, 175, 215, 255];
    const [cr, cg, cb] = [level(r), level(g), level(b)];
    const cube = 16 + 36 * cr + 6 * cg + cb;
    const gray = Math.min(23, Math.max(0, Math.round((r + g + b) / 3 - 8) / 10));
    const grayValue = 8 + gray * 10;
    const distance = (x, y, z) => (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2;
    return distance(grayValue, grayValue, grayValue) < distance(steps[cr], steps[cg], steps[cb]) ? 232 + Math.round(gray) : cube;
};

/** Graphite's terminal palette (dark): the terminal's own background is unknown, and light colours vanish on a dark one. */
export const TERM_COLORS = {
    accent: '#5EE0F2',
    ok: '#3DD68C',
    fail: '#FF6B70',
    warn: '#F5B83D',
    muted: '#9AA3A6',
    faint: '#677174',
    agent: '#22D3EE',
};

/**
 * Graphite's colours for the terminal roles: text (the terminal's own foreground), muted, faint, frame, accent, info,
 * ok, warn, fail, agent, plus bold. Truecolor if the terminal supports it, otherwise the nearest of the 256 colours.
 * Without colour every function returns the text unchanged.
 */
export const termPainter = (enabled, { full = truecolor() } = {}) => {
    const wrap = (open, close) => (text) => (enabled ? `${open}${text}${close}` : String(text));
    const color = (hex) => wrap(full ? `\u001b[38;2;${rgb(hex).join(';')}m` : `\u001b[38;5;${to256(hex)}m`, '\u001b[39m');
    const { accent, ok, fail, warn, muted, faint, agent } = TERM_COLORS;
    return {
        text: (text) => String(text),
        muted: color(muted),
        faint: color(faint),
        frame: color(faint),
        accent: color(accent),
        info: color(accent),
        ok: color(ok),
        warn: color(warn),
        fail: color(fail),
        agent: color(agent),
        bold: wrap('\u001b[1m', '\u001b[22m'),
    };
};
