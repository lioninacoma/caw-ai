// `caw role [list|add|remove|login]`: roles in an existing project. `add` puts the role into the config and its variable names
// into caw/.env.example; the human fills the values into caw/.env. caw never asks for, writes, prints or returns them.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, sessionPath, writeConfig } from '../shared/config.mjs';
import { credentialState, roleLinePattern } from '../shared/credentials.mjs';
import { effectiveEnvironments, usesCredentials, usesTotp } from '../shared/environments.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { ENV_FILE, TEST_DIR } from '../shared/names.mjs';
import { createUi } from '../shared/ui.mjs';
import { parseEnvFile } from './linux.mjs';
import { loadTest } from './test-file.mjs';
import { addRole } from './test-users.mjs';

/** Which tests sign in as which role; unreadable tests are left out. */
const testsByRole = (root) => {
    const dir = join(root, TEST_DIR);
    const byRole = {};
    if (!existsSync(dir)) return byRole;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort()) {
        const id = file.slice(0, -'.yaml'.length);
        try {
            const role = loadTest(root, id).role;
            if (typeof role === 'string') (byRole[role] ??= []).push(id);
        } catch {
            // validate reports broken tests.
        }
    }
    return byRole;
};

/**
 * The roles as data, per environment caw may use (never production): the state of the test user or session (never values),
 * the variable set that applies and which names are missing, and which tests use the role.
 * state: set | missing (form, basic) · session | no-session (session) · none (no sign-in)
 */
export const roleOverview = (root, { env = process.env } = {}) => {
    const config = loadConfig(root);
    const byRole = testsByRole(root);
    const names = [...new Set([...Object.keys(config.roles ?? {}), ...Object.keys(byRole)])].sort();
    const file = join(root, ENV_FILE);
    const sources = { processEnv: env, fileEnv: existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {} };
    const environments = Object.values(effectiveEnvironments(config)).filter(({ production }) => !production);
    const stateOf = (name, { name: target, signIn }) => {
        if (usesCredentials(signIn)) {
            const { set, names: variables, missing } = credentialState({ who: name, env: target, totp: usesTotp(signIn), sources });
            return { env: target, signIn: signIn.type, state: missing.length === 0 ? 'set' : 'missing', set, names: Object.values(variables), missing };
        }
        if (signIn.type === 'session') return { env: target, signIn: signIn.type, state: existsSync(join(root, sessionPath(target, name))) ? 'session' : 'no-session' };
        return { env: target, signIn: signIn.type, state: 'none' };
    };
    return {
        roles: names.map((name) => ({
            name,
            configured: config.roles?.[name] !== undefined,
            environments: config.roles?.[name] === undefined ? [] : environments.map((environment) => stateOf(name, environment)),
            tests: byRole[name] ?? [],
        })),
    };
};

/**
 * Removes a role from the config; refused while tests still sign in with it. caw/.env stays as it is: the result names the
 * role's variables found there (names only), for the human to delete.
 */
export const removeRole = (root, name) => {
    const config = loadConfig(root);
    const entry = config.roles?.[name];
    if (entry === undefined) throw new CawError('usage', t('cli.roleUnknown', { role: name, roles: Object.keys(config.roles ?? {}).join(', ') || '-' }));
    const users = testsByRole(root)[name] ?? [];
    if (users.length > 0) throw new CawError('usage', t('cli.roleInUse', { role: name, tests: users.join(', ') }));
    const written = writeConfig(root, { roles: { [name]: null } });
    if (!written.ok) throw new CawError('config-invalid', written.issues.join('\n'));
    // Every set of the role (default and per environment), by exact name: clerk never matches clerk-lead.
    const file = join(root, ENV_FILE);
    const pattern = roleLinePattern(name);
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
    return { role: name, leftInEnv: lines.filter((line) => pattern.test(line)).map((line) => line.replace(/^\s*(?:export\s+)?/, '').split('=')[0].trim()) };
};

const optionsOf = (rest) => {
    const options = { names: [] };
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === '--json') options.json = true;
        else if (arg === '--env') {
            options.target = rest[index + 1];
            if (options.target === undefined || options.target.startsWith('--')) throw new CawError('usage', t('session.args.valueMissing', { flag: '--env', example: 'dev' }));
            index += 1;
        } else if (arg.startsWith('--')) throw new CawError('usage', t('cli.roleUnknownArg', { arg }));
        else options.names.push(arg);
    }
    return options;
};

/**
 * caw role [list] [--json] | add <role> | remove <role> | login <role> --env <env>
 * @param deps.captureSession tests only: replaces Chrome for login
 */
export const roleCommand = async (root, args, { out = (text) => console.log(text), captureSession } = {}) => {
    const [sub = 'list', ...rest] = args;
    const options = optionsOf(rest);
    const ui = createUi();
    if (sub === 'login') {
        if (options.names.length !== 1) throw new CawError('usage', t('cli.authUsage'));
        const { roleLogin } = await import('./commands.mjs');
        return roleLogin(root, { role: options.names[0], target: options.target }, { capture: captureSession });
    }
    if (sub === 'list') {
        const overview = roleOverview(root);
        if (options.json) {
            out(JSON.stringify(overview));
            return EXIT.pass;
        }
        if (overview.roles.length === 0) ui.info(t('cli.roleNone'));
        const label = { set: 'cli.roleStateSet', missing: 'cli.roleStateNoUser', session: 'cli.roleStateSession', 'no-session': 'cli.roleStateNoSession', none: 'cli.roleStateNoPassword' };
        for (const role of overview.roles) {
            const state = !role.configured ? t('cli.roleStateMissing') : role.environments.map(({ env, state: each }) => `${env}: ${t(label[each])}`).join(', ');
            out(`${role.name.padEnd(16)} ${state.padEnd(40)} ${role.tests.length === 0 ? '-' : role.tests.join(', ')}`);
        }
        const unconfigured = overview.roles.find((role) => !role.configured);
        const missing = overview.roles.flatMap((role) => role.environments.filter(({ state }) => state === 'missing' || state === 'no-session').map((each) => ({ role: role.name, ...each })));
        if (unconfigured !== undefined) ui.note(t('cli.roleAddHint', { role: unconfigured.name }));
        else if (missing.length > 0) ui.note(missing[0].state === 'missing' ? t('cli.roleFillHint', { role: missing[0].role, target: missing[0].env, names: missing[0].missing.join(', ') }) : t('cli.roleLoginHint', { role: missing[0].role, target: missing[0].env }));
        return EXIT.pass;
    }
    if (sub === 'add') {
        if (options.names.length !== 1 || options.target !== undefined) throw new CawError('usage', t('cli.roleSynopsis'));
        const result = addRole(root, options.names[0]);
        ui.success(t(result.config === 'added' ? 'cli.roleAdded' : 'cli.roleKnown', { role: result.role }));
        if (result.variables.length > 0) ui.info(t('cli.roleFillIn', { names: result.variables.join(', '), file: ENV_FILE }));
        if (result.gitignore) ui.note(t('cli.roleGitignore', { file: ENV_FILE }));
        return EXIT.pass;
    }
    if (sub === 'remove') {
        if (options.names.length !== 1) throw new CawError('usage', t('cli.roleSynopsis'));
        const result = removeRole(root, options.names[0]);
        ui.success(t('cli.roleRemoved', { role: result.role }));
        if (result.leftInEnv.length > 0) ui.note(t('cli.roleLeftInEnv', { names: result.leftInEnv.join(', '), file: ENV_FILE }));
        return EXIT.pass;
    }
    throw new CawError('usage', t('cli.roleSynopsis'));
};
