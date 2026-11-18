// Test users from the explore window: the human signs in once, caw-ai keeps user name and password in memory and writes them
// straight to caw/.env under the role the human names. The values never reach Claude, the explore result or a log.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeConfig } from '../shared/config.mjs';
import { credentialNames } from '../shared/credentials.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, ENV_FILE } from '../shared/names.mjs';
import { parseEnvFile } from './linux.mjs';

export const ENV_PATH = ENV_FILE;
/** Role names as `init` and the config accept them. */
export const ROLE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The role a first test user gets unless the human names another. */
export const FIRST_ROLE = 'tester';

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
    appendFileSync(ignore, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}\n# caw\n${ENV_PATH}\n`);
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
 * Which variable set a captured account goes to (SC-7), from caw/.env alone (the process environment is for CI and never written):
 * no default account yet → the default set CAW_<ROLE>_USER …, the default for every environment; the same user as the set that
 * applies to the environment → that set, updated in place; a different user → the set of this environment, CAW_<ROLE>_USER__<ENV> ….
 * @param env the environment signed in to; without one (explore before a config) always the default set
 */
export const testUserSet = (fileEnv, role, env, user) => {
    const names = credentialNames(role, env);
    const has = (name) => typeof fileEnv[name] === 'string' && fileEnv[name] !== '';
    if (!has(names.default.user) || names.env === undefined) return { set: 'default', names: names.default };
    const applying = has(names.env.user) || has(names.env.password) ? 'env' : 'default';
    if (fileEnv[names[applying].user] === user) return { set: applying, names: names[applying] };
    return { set: 'env', names: names.env };
};

/**
 * Saves a test user under a role.
 * - caw/.env gets user name and password under the names of `testUserSet`.
 * - .gitignore covers caw/.env.
 * - An existing caw.config.json gets the role (an empty object) through the validating writer; without a config `init` adds it
 *   from the explore result.
 * @param env the environment the window signed in to
 * @returns { role, set, names: [user, password], gitignore, config: 'added'|'present'|'none'|'refused' }
 */
export const saveTestUser = (root, { role, user, password, env }) => {
    if (!ROLE_NAME.test(String(role))) throw new Error(t('cli.testUserRoleBad', { role: String(role) }));
    if (typeof user !== 'string' || user === '' || typeof password !== 'string' || password === '') throw new Error(t('cli.testUserEmpty'));
    const file = join(root, ENV_PATH);
    const fileEnv = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
    const { set, names } = testUserSet(fileEnv, role, env, user);
    setEnvValues(root, { [names.user]: user, [names.password]: password });
    const gitignore = ignoreEnvFile(root);
    const roles = readConfigRoles(root);
    let config = 'none';
    if (roles !== null && existsSync(join(root, CONFIG_FILE))) {
        if (roles[role] !== undefined) config = 'present';
        else config = writeConfig(root, { roles: { [role]: {} } }).ok ? 'added' : 'refused';
    }
    return { role, set, names: [names.user, names.password], gitignore, config };
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
