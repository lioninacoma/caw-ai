// Farben fuer das Terminal, ohne Abhaengigkeit. In Dateien und Pipes bleibt die Ausgabe ohne Steuerzeichen.

const CODES = { red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36, dim: 2, bold: 1 };

/** NO_COLOR gewinnt immer, FORCE_COLOR erzwingt Farbe, sonst entscheidet das Terminal. */
export const colorEnabled = ({ env = process.env, isTTY = process.stdout.isTTY } = {}) => {
    if (env.NO_COLOR) return false;
    return Boolean(env.FORCE_COLOR) || Boolean(isTTY);
};

export const painter = (enabled) => Object.fromEntries(Object.entries(CODES).map(([name, code]) => [
    name,
    (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text)),
]));
