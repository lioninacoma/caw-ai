// What a run is about, from outside caw: --ref (an id of another tool, kept opaque), --delta (the commits under test, checked
// against the checked-out code) and --file (the description a new test is planned from). caw reads no ticket and no diff text.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { isLoopback } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { PROJECT_DIR } from '../shared/names.mjs';
import { deltaOf } from './git.mjs';

/** As long as a bug report (reproduce): a page, not a document. */
export const MAX_DESCRIPTION = 8000;
const SHOWN = 5;

const usage = (key, vars) => new CawError('usage', t(key, vars));

/** The description as record takes it: plain text without control characters. */
export const checkDescription = (given) => {
    const text = typeof given === 'string' ? given.replaceAll('\r\n', '\n').trim() : '';
    if (text === '') throw usage('cli.descriptionMissing');
    if (text.length > MAX_DESCRIPTION) throw usage('cli.descriptionLong', { max: MAX_DESCRIPTION });
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw usage('cli.descriptionControl');
    return text;
};

/** record --file: a regular text file, relative to the project or absolute. */
export const readDescription = (root, file) => {
    const path = isAbsolute(file) ? file : resolve(root, file);
    if (!existsSync(path) || !statSync(path).isFile()) throw usage('cli.reproduceFileMissing', { file });
    if (statSync(path).size > MAX_DESCRIPTION * 4) throw usage('cli.descriptionLong', { max: MAX_DESCRIPTION });
    return checkDescription(readFileSync(path, 'utf8'));
};

/**
 * The description as demonstration items, like a test described in the chat: every list entry and every paragraph is one note,
 * so the plan has to say for each what became of it (`heard`). A heading belongs to the note after it; a line that starts no
 * entry belongs to the one before it.
 */
export const descriptionItems = (text) => {
    const notes = [];
    let current = [];
    let heading = [];
    const close = () => {
        if (current.length === 0) return;
        notes.push([...heading, ...current].join('\n'));
        heading = [];
        current = [];
    };
    for (const line of text.split('\n')) {
        if (line.trim() === '') close();
        else if (/^#{1,6} /.test(line)) {
            close();
            heading.push(line.trim());
        } else {
            if (/^([-*+]|[0-9]+[.)]) /.test(line)) close();
            current.push(line.trim());
        }
    }
    close();
    if (heading.length > 0) notes.push(heading.join('\n'));
    return notes.map((note) => ({ action: 'note', text: note }));
};

const listed = (files) => (files.length > SHOWN ? `${files.slice(0, SHOWN).join(', ')} … (${files.length})` : files.join(', '));

/** The checked-out code is the delta's head, or the reason why not (CawError git-ref, git-missing, delta-mismatch). */
export const checkDelta = (root, delta) => {
    const { base, head, files, contained, differing, dirty } = deltaOf(root, delta);
    if (!contained) throw new CawError('delta-mismatch', t('cli.delta.notCheckedOut', { delta, head }));
    if (differing.length > 0) throw new CawError('delta-mismatch', t('cli.delta.differs', { files: listed(differing), head }));
    return { range: delta, base, head, files: files.filter((file) => !file.startsWith(`${PROJECT_DIR}/`)), dirty };
};

/**
 * What the run is about, for the agent's task, result.json and report.md. With --delta the checked-out code must be the delta's
 * head: HEAD contains it and the delta's files are as it left them, also uncommitted. Other local changes are listed, not refused.
 * @param checked the run's environment: only a server on this machine or local code (overlay) can be the checked-out code
 * @returns { ref?, delta?: { range, base, head, files, dirty } }
 */
export const aboutRun = (root, { ref, delta }, checked) => {
    const about = ref === undefined ? {} : { ref };
    if (delta === undefined) return about;
    const local = checked.source === 'overlay' || (checked.production !== true && checked.url !== undefined && isLoopback(new URL(checked.url).hostname));
    if (!local) throw new CawError('delta-mismatch', t('cli.delta.notLocal', { env: checked.name }));
    return { ...about, delta: checkDelta(root, delta) };
};
