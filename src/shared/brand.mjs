// The product's name and its one-line head for the terminal: "● caw · Context-Aware Web Testing".

export const LONG_NAME = 'Context-Aware Web Testing';

const plain = (text) => String(text);

/**
 * The head line: a dot, the name and the long form.
 * @param name  e.g. "caw" or "caw init --explore-only"
 * @param paint optional { accent, bold, dim }: the dot, the name, the separator with the long form
 * @returns one line
 */
export const headLine = (name, { accent = plain, bold = plain, dim = plain } = {}) => `${accent('●')} ${bold(name)} ${dim(`· ${LONG_NAME}`)}`;
