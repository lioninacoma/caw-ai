// `caw-ai role [list|add|remove]`: test users as roles in an existing project. `add` opens a window on the sign-in page, the
// human signs in and names the role; caw-ai writes caw/.env and the config. The values are never printed or returned.

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { authOf, environmentDefs, loadConfig, writeConfig } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { ENV_FILE, TEST_DIR } from '../shared/names.mjs';
import { createUi } from '../shared/ui.mjs';
import { captureTestUsers, hasTestUser } from './role-capture.mjs';
import { loadTest } from './test-file.mjs';
import { ROLE_NAME } from './test-users.mjs';

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

/** The roles as data: variable names, whether a test user is set (never the values) and which tests use the role. */
export const roleOverview = (root, { env = process.env } = {}) => {
    const config = loadConfig(root);
    const byRole = testsByRole(root);
    const names = [...new Set([...Object.keys(config.roles ?? {}), ...Object.keys(byRole)])].sort();
    return {
        auth: authOf(config).type,
        roles: names.map((name) => {
            const entry = config.roles?.[name];
            return {
                name,
                configured: entry !== undefined,
                ...(entry?.loginEnv === undefined ? {} : { loginEnv: entry.loginEnv, passwordEnv: entry.passwordEnv }),
                testUser: entry !== undefined && hasTestUser(root, config, name, env),
                tests: byRole[name] ?? [],
            };
        }),
    };
};

/** Removes a role from the config and its lines from caw/.env; refused while tests still sign in with it. */
export const removeRole = (root, name) => {
    const config = loadConfig(root);
    const entry = config.roles?.[name];
    if (entry === undefined) throw new CawError('usage', t('cli.roleUnknown', { role: name, roles: Object.keys(config.roles ?? {}).join(', ') || '-' }));
    const users = testsByRole(root)[name] ?? [];
    if (users.length > 0) throw new CawError('usage', t('cli.roleInUse', { role: name, tests: users.join(', ') }));
    const written = writeConfig(root, { roles: { [name]: null } });
    if (!written.ok) throw new CawError('config-invalid', written.issues.join('\n'));
    const file = join(root, ENV_FILE);
    const drop = [entry.loginEnv, entry.passwordEnv, entry.totpEnv].filter(Boolean);
    if (existsSync(file) && drop.length > 0) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => !drop.some((key) => new RegExp(`^\\s*(?:export\\s+)?${key}=`).test(line)));
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, lines.join('\n'), { mode: 0o600 });
        renameSync(temp, file);
    }
    return { role: name, removed: drop };
};

/** Where `role add` signs in: --target, else the only environment, else the only one Claude may work on. */
export const roleTarget = (config, given) => {
    const defs = environmentDefs(config);
    if (given !== undefined) {
        if (defs[given] === undefined) throw new CawError('target-invalid', t('cli.roleTargetUnknown', { target: given, environments: Object.keys(defs).join(', ') }));
        return given;
    }
    const names = Object.keys(defs).filter((name) => !defs[name].production);
    if (names.length === 1) return names[0];
    const claude = names.filter((name) => defs[name].agent);
    if (claude.length === 1) return claude[0];
    throw new CawError('usage', t('cli.roleTargetMissing', { environments: names.join(', ') }));
};

const optionsOf = (rest) => {
    const options = { names: [] };
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === '--json') options.json = true;
        else if (arg === '--target') {
            options.target = rest[index + 1];
            if (options.target === undefined || options.target.startsWith('--')) throw new CawError('usage', t('session.args.valueMissing', { flag: '--target', example: 'dev' }));
            index += 1;
        } else if (arg.startsWith('--')) throw new CawError('usage', t('cli.roleUnknownArg', { arg }));
        else options.names.push(arg);
    }
    return options;
};

/**
 * caw-ai role [list] [--json] | add [<role>] [--target <env>] | remove <role>
 * @param deps.capture tests only: replaces the sign-in window
 */
export const roleCommand = async (root, args, { out = (text) => console.log(text), capture = captureTestUsers } = {}) => {
    const [sub = 'list', ...rest] = args;
    const options = optionsOf(rest);
    const ui = createUi();
    if (sub === 'list') {
        const overview = roleOverview(root);
        if (options.json) {
            out(JSON.stringify(overview));
            return EXIT.pass;
        }
        if (overview.roles.length === 0) ui.info(t('cli.roleNone'));
        for (const role of overview.roles) {
            const state = !role.configured ? t('cli.roleStateMissing') : overview.auth === 'form' || overview.auth === 'basic' ? (role.testUser ? t('cli.roleStateSet') : t('cli.roleStateNoUser')) : t('cli.roleStateNoPassword');
            out(`${role.name.padEnd(16)} ${state.padEnd(22)} ${role.tests.length === 0 ? '-' : role.tests.join(', ')}`);
        }
        const missing = overview.roles.filter((role) => !role.configured || ((overview.auth === 'form' || overview.auth === 'basic') && !role.testUser));
        if (missing.length > 0) ui.note(t('cli.roleAddHint', { role: missing[0].name }));
        return EXIT.pass;
    }
    if (sub === 'add') {
        if (options.names.length > 1) throw new CawError('usage', t('cli.roleSynopsis'));
        const [name] = options.names;
        if (name !== undefined && !ROLE_NAME.test(name)) throw new CawError('usage', t('cli.testUserRoleBad', { role: name }));
        const config = loadConfig(root);
        const target = roleTarget(config, options.target);
        const saved = await capture(root, { target, role: name });
        if (saved.length === 0) {
            ui.warn(t('cli.roleNothingSaved'));
            return EXIT.rejected;
        }
        ui.info(t('cli.roleNext', { roles: saved.join(', ') }));
        return EXIT.pass;
    }
    if (sub === 'remove') {
        if (options.names.length !== 1) throw new CawError('usage', t('cli.roleSynopsis'));
        const result = removeRole(root, options.names[0]);
        ui.success(t('cli.roleRemoved', { role: result.role, file: ENV_FILE }));
        return EXIT.pass;
    }
    throw new CawError('usage', t('cli.roleSynopsis'));
};
