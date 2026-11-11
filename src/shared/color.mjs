// Terminal colours without dependencies. Output to files and pipes stays free of control sequences.

import { activeTheme } from './theme-package.mjs';

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

// Terminal roles and their base colour in the theme.
const ROLES = { text: 'text', muted: 'muted', frame: 'frame', accent: 'accent', ok: 'ok', warn: 'warn', fail: 'fail', info: 'info', claude: 'claude', human: 'human', heart: 'heart' };

/**
 * Colours from the active theme (the same as in the workbench), plus bold, faint (frame mixed with text) and failTag (inverted).
 * Truecolor if the terminal supports it, otherwise the nearest of the 256 colours. Without colour every function returns the text unchanged.
 */
export const themePainter = (enabled, { full = truecolor(), theme = activeTheme() } = {}) => {
    const wrap = (open, close) => (text) => (enabled ? `${open}${text}${close}` : String(text));
    const code = (hex, ground = 38) => (full ? `\u001b[${ground};2;${rgb(hex).join(';')}m` : `\u001b[${ground};5;${to256(hex)}m`);
    const colors = { ...theme.colors };
    // faint as in the workbench: 80 % frame, 20 % text.
    const [fr, fg, fb] = rgb(colors.frame);
    const [tr, tg, tb] = rgb(colors.text);
    colors.faint = `#${[fr * 0.8 + tr * 0.2, fg * 0.8 + tg * 0.2, fb * 0.8 + tb * 0.2].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
    const paint = Object.fromEntries([...Object.entries(ROLES), ['faint', 'faint']].map(([role, key]) => [role, wrap(code(colors[key]), '\u001b[39m')]));
    return {
        ...paint,
        // Names from before the redesign.
        beak: paint.accent, auto: paint.claude, dot: paint.faint,
        bold: wrap('\u001b[1m', '\u001b[22m'),
        failTag: wrap(`${code(colors.fail, 48)}${code(colors.screen)}`, '\u001b[49m\u001b[39m'),
    };
};

/** Old name. */
export const nightPainter = themePainter;
