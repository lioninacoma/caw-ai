import { isAttachValue } from '../shared/attach.mjs';
import { parseDuration } from '../shared/duration.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';

/**
 * Windows path to Linux path, including \\wsl.localhost\<distro>\... Leaves Linux paths unchanged. Also yields the
 * project path inside the container, so it looks the same on every Docker way.
 */
export const toWslPath = (path) => {
    const share = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/][^\\/]+[\\/](.*)$/i.exec(path);
    if (share !== null) return `/${share[1].replaceAll('\\', '/')}`;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
    if (match === null) return path;
    return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
};

export const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
export const shellJoin = (args) => args.map(shellQuote).join(' ');

/**
 * A value as in dotenv: quoted means exactly the content (a comment may follow, in "…" \n becomes a newline),
 * otherwise up to a comment after whitespace (" # test account"), trimmed. A # without whitespace before it belongs to the value,
 * passwords contain it.
 */
const envValue = (raw) => {
    const value = raw.trim();
    const quoted = /^(["'`])([\s\S]*?)\1\s*(#.*)?$/.exec(value);
    if (quoted !== null) return quoted[1] === '"' ? quoted[2].replaceAll('\\n', '\n') : quoted[2];
    return value.replace(/\s+#.*$/, '').trim();
};

export const parseEnvFile = (text) => {
    const env = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (match === null) continue;
        env[match[1]] = envValue(match[2]);
    }
    return env;
};

const CLAUDE_OPTIONS = ['--env', '--agent-timeout', '--max-actions', '--step-timeout', '--agent', '--attach', '--overlay', '--start', '--reset'];
const COMMAND_OPTIONS = {
    // --agent-timeout and --max-actions apply to Claude when clarifying, explaining and fixing; playback itself is limited by
    // --step-timeout.
    run: ['--env', '--explain', '--headless', '--no-chat', '--learn', '--strict', '--promote', '--all', '--report', '--retry-env', '--step-timeout', '--agent-timeout', '--max-actions', '--agent', '--attach', '--overlay', '--start', '--reset', '--no-reset'],
    // --headless: no window, for a test that has a plan; caw takes only what changes nothing the test checks.
    record: [...CLAUDE_OPTIONS, '--role', '--read-only', '--headless'],
    open: ['--env', '--role', '--overlay', '--start', '--reset', '--agent', '--attach', '--agent-timeout', '--max-actions', '--step-timeout', '--design'],
    // bisect always runs headless, without chat and learning, and always starts the environment: nothing to switch.
    bisect: ['--env', '--tests-from', '--step-timeout'],
    // design snapshot: headless to the entry of a step like open, then the screen as a design page.
    design: ['--env', '--name', '--overlay', '--start', '--step-timeout', '--json'],
};
// --start: start the environment (its start command) and, with --overlay, the parts' local code servers if they do not answer, and
// stop at the end what caw started. --reset runs the environment's reset before the first test, --no-reset never.
const SWITCHES = new Set(['--json', '--explain', '--headless', '--no-chat', '--learn', '--strict', '--promote', '--all', '--read-only', '--start', '--reset', '--no-reset', '--design']);
/** One example value per option, for the message when the value is missing. */
const VALUE_EXAMPLES = {
    '--env': 'local', '--role': 'admin', '--agent': 'local', '--agent-timeout': '60m',
    '--max-actions': '100', '--step-timeout': '30s', '--report': 'junit=caw-junit.xml', '--retry-env': '1', '--url': 'http://localhost:5173', '--from': 'caw/.explore.json',
    '--tests-from': 'refs/bisect/bad', '--name': 'order-form',
};
/** Where Claude works: started locally, in Docker or as the developer's Claude Code session. */
/** Where caw starts its own agent; the person's own session answers with --attach instead. */
export const AGENT_CHOICES = ['local', 'docker'];
/** A value of --overlay after a space: build, dev or the address of a dev server. Parts only with =, see parseArgs. */
const overlayValue = (value) => ['build', 'dev'].includes(value) || /^https?:\/\/[^\s/]+/i.test(value ?? '');
// The human is at the chat, which takes longer than a run without them.
export const CLAUDE_TIMEOUT_MIN = 60;
const STEP_ID = /^S[1-9]\d*$/;
// More attempts than this hide an environment that is down rather than one that hiccups.
const MAX_RETRY_ENV = 5;

/** A missing option value, or the next option in its place (--env --headless), is a usage error with an example. */
const requireValue = (flag, value) => {
    if (value === undefined || value === '' || value.startsWith('--')) throw new CawError('usage', t('session.args.valueMissing', { flag, example: VALUE_EXAMPLES[flag] ?? '…' }));
    return value;
};

/** An option's value in simple commands (init, explore, doctor, auth): undefined without the option, usage error without a value. */
export const optionValue = (args, name) => {
    const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (index === -1) return undefined;
    const arg = args[index];
    return requireValue(name, arg === name ? args[index + 1] : arg.slice(name.length + 1));
};

/**
 * A flat file name in caw/tests: a path like team/login would only fail when writing after the whole recording, ../x would write
 * outside caw/tests. Letters of any language (kündigung), no separators and no control characters.
 */
const checkTestId = (test) => {
    if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$/u.test(test) || test.endsWith('.') || test.length > 100) throw new CawError('usage', t('session.args.testId', { test }));
};

/**
 * `<test>` or `<test>@S<n>` for record and open. Test ids cannot contain @ (checkTestId), so the first @ separates the step.
 * @returns { test, step }; step undefined without @
 */
export const splitStep = (arg) => {
    const at = arg.indexOf('@');
    if (at === -1) return { test: arg };
    const test = arg.slice(0, at);
    const step = arg.slice(at + 1);
    if (test === '' || !STEP_ID.test(step)) throw new CawError('usage', t('session.args.stepForm', { arg }));
    return { test, step };
};

/**
 * Each command only knows its own options. --env may be omitted: then the command picks the only matching environment.
 * run also takes several tests or --all; they then run one after another without chat, with a table at the end.
 * record and open take one test, optionally with a step: `<test>@S<n>`.
 * @param command run, record, open or bisect
 */
export const parseRunArgs = (command, args) => {
    const allowed = COMMAND_OPTIONS[command];
    const options = { stepTimeoutSec: 30, ...(command === 'run' ? { advise: false, headless: false, noChat: false, learn: false, strict: false, all: false, tests: [] } : { timeoutMin: CLAUDE_TIMEOUT_MIN }) };
    const rest = [...args];
    while (rest.length > 0) {
        const arg = rest.shift();
        if (!arg.startsWith('--')) {
            if (command === 'run') {
                options.tests.push(arg);
                options.test ??= arg;
                continue;
            }
            if (options.test !== undefined) throw new CawError('usage', t('session.args.unexpected', { arg }));
            const { test, step } = splitStep(arg);
            options.test = test;
            if (step !== undefined) options.step = step;
            continue;
        }
        const [flag, inline] = arg.split(/=(.*)/s);
        if (!allowed.includes(flag)) throw new CawError('usage', t('session.args.unknownOption', { command, flag, allowed: allowed.join(', ') }));
        // --overlay may stand without a value: --overlay, --overlay build, --overlay=dev, --overlay http://localhost:5174. Parts
        // only with =: --overlay=orders,admin:dev, since --overlay orders reads the test orders. checkTest validates the items.
        // --attach may stand without a value (the only listening session) or name one: its key (k7f2) or the start of its id.
        if (flag === '--attach') {
            const value = inline ?? (isAttachValue(rest[0]) ? rest.shift() : undefined);
            if (value === '') throw new CawError('usage', t('session.args.attachValue'));
            options.attach = value ?? true;
            continue;
        }
        if (flag === '--overlay') {
            const value = inline ?? (overlayValue(rest[0]) ? rest.shift() : undefined);
            if (value === '') throw new CawError('usage', t('session.args.overlayChoice'));
            options.overlay = value ?? true;
            continue;
        }
        const value = SWITCHES.has(flag) ? true : requireValue(flag, inline ?? rest.shift());
        if (flag === '--env') options.target = value;
        else if (flag === '--explain') options.advise = true;
        else if (flag === '--headless') options.headless = true;
        else if (flag === '--no-chat') options.noChat = true;
        else if (flag === '--learn') options.learn = true;
        else if (flag === '--strict') options.strict = true;
        else if (flag === '--promote') options.promote = true;
        else if (flag === '--reset') options.reset = options.reset === 'off' ? 'clash' : 'force';
        else if (flag === '--no-reset') options.reset = options.reset === 'force' ? 'clash' : 'off';
        else if (flag === '--all') options.all = true;
        else if (flag === '--read-only') options.readOnly = true;
        else if (flag === '--start') options.start = true;
        else if (flag === '--design') options.design = true;
        else if (flag === '--max-actions') options.maxActions = Number(value);
        else if (flag === '--role') options.role = value;
        else if (flag === '--tests-from') options.testsFrom = value;
        else if (flag === '--name') options.name = value;
        else if (flag === '--json') options.json = true;
        else if (flag === '--step-timeout') options.stepTimeoutSec = parseDuration(flag, value) / 1000;
        else if (flag === '--report') {
            const match = /^(junit|summary|json)=(.+)$/.exec(value);
            if (match === null) throw new CawError('usage', t('session.args.report'));
            options.reports ??= {};
            if (options.reports[match[1]] !== undefined) throw new CawError('usage', t('session.args.reportTwice', { kind: match[1] }));
            options.reports[match[1]] = match[2];
        }
        else if (flag === '--retry-env') {
            options.retryEnv = Number(value);
            if (!Number.isInteger(options.retryEnv) || options.retryEnv < 1 || options.retryEnv > MAX_RETRY_ENV) throw new CawError('usage', t('session.args.retryEnv', { max: MAX_RETRY_ENV }));
        }
        else if (flag === '--agent') {
            if (!AGENT_CHOICES.includes(value)) throw new CawError('usage', t('session.args.agentChoice', { choices: AGENT_CHOICES.join(', ') }));
            options.agent = value;
        }
        else options.timeoutMin = parseDuration(flag, value) / 60000;
    }
    if (options.all && options.test !== undefined) throw new CawError('usage', t('session.args.allWithTests'));
    // --promote takes exactly one draft; it runs the other tests itself, and its proof is the fix report, not a CI file.
    if (options.promote && (options.all || options.tests.length > 1 || options.reports !== undefined || options.retryEnv !== undefined)) throw new CawError('usage', t('session.args.promoteOne'));
    if (options.reset === 'clash') throw new CawError('usage', t('session.args.clash', { without: '--reset', other: '--no-reset' }));
    if (options.attach !== undefined && options.agent !== undefined) throw new CawError('usage', t('session.args.clash', { without: '--attach', other: '--agent' }));
    if (command !== 'open' && options.test === undefined && !options.all) throw new CawError('usage', t('session.args.testMissing'));
    for (const test of command === 'run' ? options.tests : options.test === undefined ? [] : [options.test]) checkTestId(test);
    // bisect plays the whole test: a step would need the steps before it from the same commit anyway.
    if (command === 'bisect' && options.step !== undefined) throw new CawError('usage', t('session.args.unexpected', { arg: `${options.test}@${options.step}` }));
    // A test brings its role; with a step it also exists already, so its metadata stays as it is.
    if (command === 'open' && options.test !== undefined) {
        const clash = [['--role', options.role]].find(([, value]) => value !== undefined);
        if (clash !== undefined) throw new CawError('usage', t('session.args.openWithTest', { flag: clash[0] }));
    }
    if (command === 'record' && options.step !== undefined) {
        const clash = [['--role', options.role], ['--read-only', options.readOnly]].find(([, value]) => value !== undefined);
        if (clash !== undefined) throw new CawError('usage', t('session.args.recordStepMeta', { flag: clash[0] }));
    }
    if (options.maxActions !== undefined && (!Number.isInteger(options.maxActions) || options.maxActions <= 0)) throw new CawError('usage', t('session.args.maxActions'));
    // Several tests are meant for CI: no chat, otherwise every test would wait for a human.
    if (command === 'run' && (options.all || options.tests.length > 1)) {
        if (options.advise) throw new CawError('usage', t('session.args.batchClash', { other: '--explain' }));
        options.batch = true;
        options.noChat = true;
    }
    // Without a window there is nothing to advise on in the chat.
    if (options.headless) options.noChat = true;
    const without = options.headless ? '--headless' : '--no-chat';
    if (options.noChat && options.advise) throw new CawError('usage', t('session.args.clash', { without, other: '--explain' }));
    return options;
};

/** Why Claude delivered no run, phrased so the report names the remedy. */
export const claudeFailureReason = (code, log) => {
    if (/\b401\b|Invalid bearer token|Failed to authenticate/.test(log)) {
        return t('session.claude.tokenInvalid');
    }
    if (code === 124) return t('session.claude.timeout');
    return t('session.claude.exit', { code });
};

