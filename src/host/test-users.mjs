// Roles and their test users. caw never writes user names or passwords: the human puts them into caw/.env (or the process
// environment, e.g. CI secrets) under CAW_<ROLE>_USER, CAW_<ROLE>_PASSWORD and, for one-time codes, CAW_<ROLE>_TOTP. caw only
// adds the role to the config, lists the variable names in caw/.env.example and keeps caw/.env out of git.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, writeConfig } from '../shared/config.mjs';
import { credentialNames, resolveCredentials } from '../shared/credentials.mjs';
import { effectiveEnvironment, effectiveEnvironments, usesCredentials, usesTotp } from '../shared/environments.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { ENV_FILE } from '../shared/names.mjs';
import { parseEnvFile } from './linux.mjs';

export const ENV_PATH = ENV_FILE;
export const ENV_EXAMPLE_PATH = `${ENV_FILE}.example`;
/** Role names as `init` and the config accept them. */
export const ROLE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** caw/.env must never end up in git: adds it to .gitignore if missing. @returns true if .gitignore changed */
export const ignoreEnvFile = (root) => {
    const ignore = join(root, '.gitignore');
    const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    if (existing.split(/\r?\n/).some((line) => [ENV_PATH, `/${ENV_PATH}`, 'caw/', '/caw/', '.env', '*.env'].includes(line.trim()))) return false;
    appendFileSync(ignore, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}\n# caw\n${ENV_PATH}\n`);
    return true;
};

/**
 * The variables a role's test user needs, by convention (the default set, for every environment): user and password, and the
 * one-time code secret where any environment's sign-in asks for one. Empty where no environment signs in with a password.
 */
export const roleVariables = (config, role) => {
    const signIns = Object.values(effectiveEnvironments(config)).map(({ signIn }) => signIn);
    if (!signIns.some((signIn) => usesCredentials(signIn))) return [];
    const { user, password, totp } = credentialNames(role).default;
    return signIns.some((signIn) => usesTotp(signIn)) ? [user, password, totp] : [user, password];
};

/** Adds the names to caw/.env.example, without values, keeping what is there. @returns the names that were added */
const listInExample = (root, names) => {
    const file = join(root, ENV_EXAMPLE_PATH);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : `${t('cli.envExampleHead')}\n`;
    const has = (name) => existing.split(/\r?\n/).some((line) => line.replace(/^\s*(?:export\s+)?/, '').split('=')[0].trim() === name);
    const added = names.filter((name) => !has(name));
    if (added.length > 0) writeFileSync(file, `${existing}${existing.endsWith('\n') ? '' : '\n'}${added.map((name) => `${name}=`).join('\n')}\n`);
    return added;
};

/**
 * `caw role add`: the role goes into the config, its variable names into caw/.env.example, caw/.env into .gitignore. The values
 * the human fills in caw/.env; caw never asks for them.
 * @returns { role, config: 'added'|'present', variables, gitignore }
 */
export const addRole = (root, role) => {
    if (!ROLE_NAME.test(String(role))) throw new CawError('usage', t('cli.testUserRoleBad', { role: String(role) }));
    const config = loadConfig(root);
    let state = 'present';
    if (config.roles?.[role] === undefined) {
        const written = writeConfig(root, { roles: { [role]: {} } });
        if (!written.ok) throw new CawError('config-invalid', written.issues.join('\n'));
        state = 'added';
    }
    const variables = roleVariables(config, role);
    if (variables.length > 0) listInExample(root, variables);
    return { role, config: state, variables, gitignore: variables.length > 0 && ignoreEnvFile(root) };
};

/**
 * Before a run opens anything: a role that signs in with a password needs its test user (process environment or caw/.env).
 * @throws CawError credentials-missing naming exactly the variables to set
 */
export const requireTestUser = (root, config, role, target, env = process.env) => {
    if (role === undefined) return;
    const { signIn } = effectiveEnvironment(config, target);
    if (!usesCredentials(signIn)) return;
    const file = join(root, ENV_PATH);
    const sources = { processEnv: env, fileEnv: existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {} };
    resolveCredentials({ who: role, env: target, totp: usesTotp(signIn), sources });
};
