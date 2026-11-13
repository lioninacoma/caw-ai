// Test users by naming convention, never in the config: CAW_<ROLE>_USER, CAW_<ROLE>_PASSWORD and CAW_<ROLE>_TOTP in caw/.env or
// the process environment (CI secrets), optionally for one environment with the suffix __<ENV> (CAW_CLERK_USER__STAGING).
// An account is taken as a set, never mixed: if the environment's set has a user or password, the whole set comes from there.
// A Basic gate in front of an environment uses CAW_GATE_USER / CAW_GATE_PASSWORD the same way, so no role may be called "gate".

import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';

/** The role name that would collide with the gate's variables. */
export const RESERVED_ROLES = ['gate'];

/** A name as it appears in a variable: upper case, - becomes _ (staging-south → STAGING_SOUTH). */
export const variablePart = (name) => String(name).toUpperCase().replaceAll('-', '_');

/**
 * The variable names of an account: the default set for every environment and the set for one environment.
 * @param who a role name, or 'gate'
 */
export const credentialNames = (who, env) => {
    const base = `CAW_${variablePart(who)}`;
    const suffix = env === undefined ? undefined : `__${variablePart(env)}`;
    const set = (end = '') => ({ user: `${base}_USER${end}`, password: `${base}_PASSWORD${end}`, totp: `${base}_TOTP${end}` });
    return { default: set(), ...(suffix === undefined ? {} : { env: set(suffix) }) };
};

/** Every variable name caw may read for these roles (and the gate), for doctor's check of unknown CAW_* names. */
export const knownCredentialPattern = (roles) => new RegExp(`^CAW_(${[...roles, ...RESERVED_ROLES].map((name) => variablePart(name).replace(/[^A-Z0-9_]/g, '')).join('|')})_(USER|PASSWORD|TOTP)(__[A-Z0-9_]+)?$`);

const present = (value) => typeof value === 'string' && value !== '';

/**
 * The account of a role (or the gate) on an environment. The process environment wins over the file for the same name.
 * @param sources { processEnv, fileEnv } name → value
 * @param totp whether the sign-in needs a one-time code secret
 * @returns { set: 'env' | 'default', names, user, password, totp? }
 * @throws CawError credentials-missing naming exactly the missing variables
 */
export const resolveCredentials = ({ who, env, totp = false, sources }) => {
    const read = (name) => (present(sources.processEnv?.[name]) ? sources.processEnv[name] : present(sources.fileEnv?.[name]) ? sources.fileEnv[name] : undefined);
    const names = credentialNames(who, env);
    const useEnv = names.env !== undefined && (read(names.env.user) !== undefined || read(names.env.password) !== undefined);
    const chosen = useEnv ? names.env : names.default;
    const wanted = totp ? ['user', 'password', 'totp'] : ['user', 'password'];
    const missing = wanted.filter((field) => read(chosen[field]) === undefined).map((field) => chosen[field]);
    if (missing.length > 0) {
        throw new CawError('credentials-missing', t(useEnv ? 'config.credentials.missingEnv' : 'config.credentials.missing', { who, env: String(env ?? ''), names: missing.join(', ') }));
    }
    return {
        set: useEnv ? 'env' : 'default',
        names: Object.fromEntries(wanted.map((field) => [field, chosen[field]])),
        user: read(chosen.user),
        password: read(chosen.password),
        ...(totp ? { totp: read(chosen.totp) } : {}),
    };
};

/**
 * Which set applies, without reading values: for doctor and `role list`, which never show values.
 * @returns { set: 'env' | 'default' | null, names, missing }
 */
export const credentialState = ({ who, env, totp = false, sources }) => {
    try {
        const { set, names } = resolveCredentials({ who, env, totp, sources });
        return { set, names, missing: [] };
    } catch (error) {
        if (error.code !== 'credentials-missing') throw error;
        const names = credentialNames(who, env);
        const has = (name) => present(sources.processEnv?.[name]) || present(sources.fileEnv?.[name]);
        const useEnv = names.env !== undefined && (has(names.env.user) || has(names.env.password));
        const chosen = useEnv ? names.env : names.default;
        const wanted = totp ? ['user', 'password', 'totp'] : ['user', 'password'];
        const missing = wanted.map((field) => chosen[field]).filter((name) => !has(name));
        return { set: useEnv ? 'env' : missing.length === wanted.length ? null : 'default', names: Object.fromEntries(wanted.map((field) => [field, chosen[field]])), missing };
    }
};

/** Matches every line of a role's variables in caw/.env (both sets), by exact name: role clerk never matches clerk-lead. */
export const roleLinePattern = (role) => new RegExp(`^\\s*(?:export\\s+)?CAW_${variablePart(role)}_(?:USER|PASSWORD|TOTP)(?:__[A-Z0-9_]+)?\\s*=`);
