// Environments: where the one application of a project runs (local, staging, ci, prod …). Everything that differs by place lives
// here: address, whether Claude may work there, whether tests may write, sign-in, extra hosts, TLS. Tenants are environments too:
// `south-dev` extends `north-dev` and only changes its url.
//
//   "environments": { "local": { "url": "http://localhost:5173", "claude": true, "writable": true },
//                     "staging": { "url": "https://staging.example.com", "claude": true },
//                     "staging-south": { "extends": "staging", "url": "https://south.staging.example.com" },
//                     "prod": { "url": "https://www.example.com", "production": true } }

import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';
import { didYouMean } from './suggest.mjs';

/** Names of environments, roles and overlay parts: they map 1:1 to the suffix of credential variables (CAW_CLERK_USER__STAGING). */
export const NAME = /^[a-z][a-z0-9-]{0,31}$/;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The environment names in declaration order. */
export const environmentNames = (config) => Object.keys(isObject(config?.environments) ? config.environments : {});

/**
 * An environment's keys after `extends`: the parent's effective keys with the child's on top. Values replace, never merge (arrays,
 * signIn and ready as a whole). `production` is never inherited: every environment states it itself.
 * @returns the merged raw keys without `extends`
 */
const mergedKeys = (config, name, seen) => {
    const raw = config?.environments?.[name];
    if (!isObject(raw)) {
        const names = environmentNames(config);
        throw new CawError('env-invalid', t('config.env.unknownName', { name: String(name), names: names.join(', '), hint: hintFor(name, names) }));
    }
    if (seen.includes(name)) throw new CawError('config-invalid', t('config.env.extendsCycle', { chain: [...seen, name].join(' → ') }));
    const own = { ...raw };
    delete own.extends;
    if (raw.extends === undefined) return own;
    const parent = mergedKeys(config, raw.extends, [...seen, name]);
    delete parent.production;
    return { ...parent, ...own };
};

const hintFor = (key, allowed) => {
    const name = didYouMean(String(key), allowed);
    return name === undefined ? '' : t('config.didYouMean', { name });
};

/**
 * The environment as runs use it: `extends` resolved, defaults filled in.
 * @returns { name, url, claude, writable, production, signIn, allowHosts, insecureTls, allowHttp, gate }
 */
export const effectiveEnvironment = (config, name) => {
    const keys = mergedKeys(config, name, []);
    return {
        name,
        url: keys.url,
        claude: keys.claude === true,
        writable: keys.writable === true,
        production: keys.production === true,
        signIn: isObject(keys.signIn) ? keys.signIn : isObject(config?.signIn) ? config.signIn : { type: 'none' },
        allowHosts: Array.isArray(keys.allowHosts) ? keys.allowHosts : [],
        insecureTls: keys.insecureTls === true,
        allowHttp: keys.allowHttp === true,
        ...(isObject(keys.gate) ? { gate: keys.gate } : {}),
    };
};

/** All effective environments by name; an environment that does not resolve (cycle, unknown parent) is left out. */
export const effectiveEnvironments = (config) => Object.fromEntries(environmentNames(config).flatMap((name) => {
    try {
        return [[name, effectiveEnvironment(config, name)]];
    } catch {
        return [];
    }
}));

/** Environments with an ability (claude, writable, production), for messages like "only on dev". */
export const environmentsWith = (config, ability) => Object.values(effectiveEnvironments(config)).filter((env) => env[ability] === true).map(({ name }) => name);

/** The sign-in on an environment (its own, inherited, else the top-level one, else none). */
export const signInOf = (config, env) => effectiveEnvironment(config, env).signIn;
/** Whether a sign-in needs a test user's name and password. */
export const usesCredentials = (signIn) => signIn?.type === 'form' || signIn?.type === 'basic';
/** Whether a sign-in also needs the secret for one-time codes. */
export const usesTotp = (signIn) => signIn?.type === 'form' && (signIn.codeSelector !== undefined || (Array.isArray(signIn.steps) && signIn.steps.some((step) => step?.with === 'totp')));
/** The sign-in types of all environments, without duplicates. */
export const signInTypes = (config) => [...new Set(Object.values(effectiveEnvironments(config)).map(({ signIn }) => signIn.type))];
/** Whether any environment signs in, so tests need roles. */
export const needsRoles = (config) => signInTypes(config).some((type) => type !== 'none');

/** The start path of a test: its own `start`, else the project's, else "/". */
export const startPath = (config, spec) => spec?.start ?? config?.start ?? '/';

/**
 * Where a test may run. Explicit `environments` as given (validation checks them); otherwise every non-production environment,
 * and only writable ones when the test writes. Never production by default: a prod smoke test names it.
 */
export const testEnvironments = (config, spec) => {
    if (Array.isArray(spec?.environments)) return spec.environments;
    return Object.values(effectiveEnvironments(config)).filter((env) => !env.production && (spec?.writes !== true || env.writable)).map(({ name }) => name);
};

/**
 * The environments a command may pick from without --env.
 * @param command 'run' | 'record' | 'open'
 * @param specs the tests of the call (run: one or more; record and open: none for a new test or open without a test)
 * @param writes for record of a new test: whether it may write (not --read-only)
 */
export const environmentCandidates = (config, { command, specs = [], writes = true }) => {
    const all = effectiveEnvironments(config);
    const claude = (name) => all[name]?.claude === true;
    if (command === 'open' && specs.length === 0) return Object.keys(all).filter(claude);
    if (command === 'record' && specs.length === 0) return Object.keys(all).filter((name) => claude(name) && (!writes || all[name].writable));
    const union = [...new Set(specs.flatMap((spec) => testEnvironments(config, spec)))];
    if (command === 'record') return union.filter((name) => claude(name) && (specs[0]?.writes !== true || all[name]?.writable === true));
    return union;
};

/**
 * The environment for a call without --env, or the given one. Production is never picked by itself: a run on production names
 * it. Then: exactly one candidate; for `run` outside CI exactly one with Claude (the developer's own); otherwise a usage error
 * listing the candidates.
 * @returns { name, why } why: 'given' | 'only' | 'onlyClaude'
 */
export const chooseEnvironment = (config, { given, candidates, command, ci = false }) => {
    if (given !== undefined) {
        effectiveEnvironment(config, given);
        return { name: given, why: 'given' };
    }
    const all = effectiveEnvironments(config);
    const open = candidates.filter((name) => all[name] !== undefined && !all[name].production);
    if (open.length === 1) return { name: open[0], why: 'only' };
    const claude = open.filter((name) => all[name].claude);
    if (command === 'run' && !ci && claude.length === 1) return { name: claude[0], why: 'onlyClaude' };
    throw new CawError('usage', open.length === 0 ? t('session.args.envNone', { command }) : t('session.args.targetMissing', { choices: open.join(', ') }));
};

const hostOfUrl = (url) => {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
};

/**
 * The hosts pages may navigate to during a run on `envName`: every non-production environment, the run's own environment, and
 * `allowHosts` (top level and the environment's). Never a production host unless the run is on production: otherwise a run on
 * dev could reach production via goto, eval or a link, possibly with a shared sign-in.
 */
export const navigationHosts = (config, envName) => {
    const all = Object.values(effectiveEnvironments(config));
    const own = envName === undefined ? undefined : effectiveEnvironment(config, envName);
    const production = new Set(all.filter((env) => env.production).map((env) => hostOfUrl(env.url)).filter(Boolean));
    const hosts = all.filter((env) => !env.production).map((env) => hostOfUrl(env.url)).filter(Boolean);
    const extra = [...(Array.isArray(config?.allowHosts) ? config.allowHosts : []), ...(own?.allowHosts ?? [])]
        .filter((host) => own?.production === true || !production.has(host));
    return [...new Set([...(own === undefined ? [] : [hostOfUrl(own.url)].filter(Boolean)), ...hosts, ...extra])];
};
