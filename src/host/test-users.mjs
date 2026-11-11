// Test users from the explore window: the human signs in once, caw-ai keeps user name and password in memory and writes them
// straight to caw/.env under the role the human names. The values never reach Claude, the explore result or a log.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeConfig } from '../shared/config.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, ENV_FILE } from '../shared/names.mjs';

export const ENV_PATH = ENV_FILE;
/** Role names as `init` and the config accept them. */
export const ROLE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The role a first test user gets unless the human names another. */
export const FIRST_ROLE = 'tester';

/** The variable names of a role in caw/.env, as `init` writes them into the config. */
export const roleEnvNames = (role) => {
    const name = role.toUpperCase().replaceAll('-', '_');
    return { loginEnv: `CAW_LOGIN_${name}`, passwordEnv: `CAW_PW_${name}` };
};

/** A name for the next role that is not taken yet: tester, tester2, tester3 … */
export const suggestRole = (taken = []) => {
    if (!taken.includes(FIRST_ROLE)) return FIRST_ROLE;
    for (let n = 2; ; n += 1) if (!taken.includes(`${FIRST_ROLE}${n}`)) return `${FIRST_ROLE}${n}`;
};

/**
 * A value for caw/.env that the parser reads back unchanged: plain if harmless, otherwise in a quote character the value
 * does not contain. Double quotes only without a literal \n, which the parser would turn into a line break.
 */
export const envLiteral = (value) => {
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(t('cli.testUserMultiline'));
    if (/^[A-Za-z0-9_@.+\-/:,=!?%*]*$/.test(text)) return text;
    if (!text.includes("'")) return `'${text}'`;
    if (!text.includes('"') && !text.includes('\\n')) return `"${text}"`;
    if (!text.includes('`')) return `\`${text}\``;
    throw new Error(t('cli.testUserQuotes'));
};

/** Sets the given variables in caw/.env: replaces existing lines, appends new ones, keeps everything else. Atomic. */
export const setEnvValues = (root, values) => {
    const file = join(root, ENV_PATH);
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [t('cli.envFileHead')];
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    for (const [name, value] of Object.entries(values)) {
        const line = `${name}=${envLiteral(value)}`;
        const at = lines.findIndex((entry) => new RegExp(`^\\s*(?:export\\s+)?${name}=`).test(entry));
        if (at === -1) lines.push(line);
        else lines[at] = line;
    }
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${lines.join('\n')}\n`, { mode: 0o600 });
    renameSync(temp, file);
};

/** caw/.env must never end up in git: adds it to .gitignore if missing. @returns true if .gitignore changed */
export const ignoreEnvFile = (root) => {
    const ignore = join(root, '.gitignore');
    const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    if (existing.split(/\r?\n/).some((line) => [ENV_PATH, `/${ENV_PATH}`, 'caw/', '/caw/', '.env', '*.env'].includes(line.trim()))) return false;
    appendFileSync(ignore, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}\n# caw-ai\n${ENV_PATH}\n`);
    return true;
};

const readConfigRoles = (root) => {
    try {
        return JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')).roles ?? {};
    } catch {
        return null;
    }
};

/**
 * Saves a test user under a role.
 * - caw/.env gets user name and password under the role's variable names (from the config if the role is there already).
 * - .gitignore covers caw/.env.
 * - An existing caw.config.json gets the role through the validating writer; without a config `init` adds it from the explore result.
 * @returns { role, loginEnv, passwordEnv, gitignore, config: 'added'|'present'|'none'|'refused' }
 */
export const saveTestUser = (root, { role, user, password }) => {
    if (!ROLE_NAME.test(String(role))) throw new Error(t('cli.testUserRoleBad', { role: String(role) }));
    if (typeof user !== 'string' || user === '' || typeof password !== 'string' || password === '') throw new Error(t('cli.testUserEmpty'));
    const roles = readConfigRoles(root);
    const known = roles?.[role];
    const names = known?.loginEnv !== undefined && known?.passwordEnv !== undefined ? { loginEnv: known.loginEnv, passwordEnv: known.passwordEnv } : roleEnvNames(role);
    setEnvValues(root, { [names.loginEnv]: user, [names.passwordEnv]: password });
    const gitignore = ignoreEnvFile(root);
    let config = 'none';
    if (roles !== null && existsSync(join(root, CONFIG_FILE))) {
        if (known?.loginEnv !== undefined) config = 'present';
        else config = writeConfig(root, { roles: { [role]: { ...known, ...names } } }).ok ? 'added' : 'refused';
    }
    return { role, ...names, gitignore, config };
};

/**
 * Runs in the page (every frame): before the sign-in goes out (click, Enter, submit) it reads the visible password field and the
 * user name field before it, and hands both to the host binding. Nothing is stored in the page.
 */
export const credentialsScript = (binding) => `(() => {
    const visible = (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    const read = () => {
        const password = [...document.querySelectorAll('input[type=password]')].find((el) => visible(el) && el.value !== '');
        if (password === undefined) return;
        const fields = [...document.querySelectorAll('input')].filter((el) => visible(el) && ['text', 'email', 'tel', ''].includes(el.type) && el !== password);
        const named = fields.find((el) => /username|email/i.test(el.autocomplete ?? ''));
        const before = fields.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
        const user = named ?? before.at(-1);
        if (user === undefined || user.value === '') return;
        window.${binding}?.({ user: user.value, password: password.value });
    };
    for (const type of ['pointerdown', 'submit']) document.addEventListener(type, read, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Enter') read(); }, true);
})();`;
