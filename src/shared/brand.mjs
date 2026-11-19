// The product's name and its one-line head for the terminal: "● caw · Context-Aware Web Testing · 1.0.0".

import { readFileSync } from 'node:fs';

export const LONG_NAME = 'Context-Aware Web Testing';

const plain = (text) => String(text);

let version = null;
/** The package version from package.json, or '' where there is none (a copy of src/shared alone). Read once. */
export const packageVersion = () => {
    if (version === null) {
        try {
            version = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '');
        } catch {
            version = '';
        }
    }
    return version;
};

/**
 * The head line: the dot and the name stand out, the long form and the version are dim.
 * @param name    e.g. "caw" or "caw init --explore-only"
 * @param paint   optional { accent, bold, dim }: the dot and the name in accent (the name also bold), the rest dim
 * @param version shown after the long form; '' leaves it out
 * @returns one line
 */
export const headLine = (name, { accent = plain, bold = plain, dim = plain } = {}, { version: shown = '' } = {}) => `${accent('●')} ${accent(bold(name))} ${dim(`· ${LONG_NAME}${shown === '' ? '' : ` · ${shown}`}`)}`;
