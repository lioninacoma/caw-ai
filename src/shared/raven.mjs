// The raven in the terminal: three lines of ASCII with the name and its long form to the right. For the help and command headers.

export const LONG_NAME = 'Constrained Agentic Webtester';

const plain = (text) => text;

/**
 * @param name  shown next to the beak, e.g. "caw-ai" or "caw-ai explore"
 * @param paint optional { bold, dim, frame, beak, eye }: name, long form, body, beak, eye
 * @returns three lines
 */
export const ravenBanner = (name, { bold = plain, dim = plain, frame = plain, beak = plain, eye = plain } = {}) => [
    `   ${frame('__')}`,
    `  ${frame('(')} ${eye('•')} ${beak('>')}   ${bold(name)}`,
    `  ${frame('// )')}    ${dim(LONG_NAME)}`,
];
