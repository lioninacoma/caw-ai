// Der Rabe im Terminal: drei Zeilen ASCII, rechts daneben der Name und was er heisst. Fuer die Hilfe und die Koepfe der Befehle.

export const LONG_NAME = 'Constrained Agentic Webtester';

const plain = (text) => text;

/**
 * @param name  neben dem Schnabel, etwa "caw-ai" oder "caw-ai explore"
 * @param paint optional { bold, dim, frame, beak, eye }: Name, Langform, Koerper, Schnabel, Auge
 * @returns drei Zeilen
 */
export const ravenBanner = (name, { bold = plain, dim = plain, frame = plain, beak = plain, eye = plain } = {}) => [
    `   ${frame('__')}`,
    `  ${frame('(')} ${eye('•')} ${beak('>')}   ${bold(name)}`,
    `  ${frame('// )')}    ${dim(LONG_NAME)}`,
];
