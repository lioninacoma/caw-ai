// The Claude Code skill caw-attach: it tells the person's session when and how to attach to caw windows (caw_attach, the
// Monitor, caw_start open). `caw skill` and `caw init` write it into the project, where the team checks it in. caw only ever
// replaces a file that carries its own marker line, never one somebody wrote.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { createUi } from '../shared/ui.mjs';

const ui = createUi();

/** Where the skill lies in the project, relative and with forward slashes. */
export const SKILL_PATH = '.claude/skills/caw-attach/SKILL.md';
const MARKER = '<!-- caw-ai: `caw skill` writes and updates this file';
const TEMPLATE = new URL('../../templates/skills/caw-attach/SKILL.md', import.meta.url);

/** The skill as caw ships it. */
export const skillText = () => readFileSync(TEMPLATE, 'utf8');

/** missing, current, outdated (caw's own, older) or foreign (written by somebody else). */
export const skillState = (root) => {
    const file = join(root, SKILL_PATH);
    if (!existsSync(file)) return 'missing';
    const text = readFileSync(file, 'utf8');
    if (!text.includes(MARKER)) return 'foreign';
    return text.replaceAll('\r\n', '\n') === skillText().replaceAll('\r\n', '\n') ? 'current' : 'outdated';
};

/** Writes or updates the skill. @returns the state before: missing, outdated or current; throws for a foreign file. */
export const writeSkill = (root) => {
    const before = skillState(root);
    if (before === 'foreign') throw new CawError('skill-foreign', t('cli.skillForeign', { file: SKILL_PATH }));
    if (before !== 'current') {
        mkdirSync(dirname(join(root, SKILL_PATH)), { recursive: true });
        writeFileSync(join(root, SKILL_PATH), skillText());
    }
    return before;
};

/** `caw skill`: writes or updates the skill and says what happened. */
export const skillCommand = (root, args = []) => {
    if (args.length > 0) throw new CawError('usage', t('session.args.unexpected', { arg: args[0] }));
    const before = writeSkill(root);
    ui.success(t(before === 'missing' ? 'cli.skillCreated' : before === 'outdated' ? 'cli.skillUpdated' : 'cli.skillCurrent', { file: SKILL_PATH }));
    return 0;
};
