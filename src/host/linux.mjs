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

const CLAUDE_OPTIONS = ['--target', '--timeout', '--max-steps', '--step-timeout', '--agent', '--overlay', '--start'];
const COMMAND_OPTIONS = {
    // --timeout and --max-steps apply to Claude when clarifying, advising and fixing; playback itself is limited by --step-timeout.
    run: ['--target', '--until', '--handover', '--advise', '--headless', '--no-chat', '--no-learn', '--all', '--report', '--step-timeout', '--timeout', '--max-steps', '--agent', '--overlay', '--start'],
    record: [...CLAUDE_OPTIONS, '--role', '--app', '--also', '--read-only'],
    fix: CLAUDE_OPTIONS,
    open: ['--target', '--role', '--app', '--overlay', '--start', '--agent', '--timeout', '--max-steps'],
};
// --start: caw may run overlay.start itself when the local code server is not ready (CI); otherwise it only names the command.
const SWITCHES = new Set(['--handover', '--advise', '--headless', '--no-chat', '--no-learn', '--all', '--read-only', '--start']);
/** One example value per option, for the message when the value is missing. */
const VALUE_EXAMPLES = {
    '--target': 'local', '--until': 'S4', '--role': 'admin', '--app': 'web', '--also': 'admin', '--agent': 'local', '--timeout': '60',
    '--max-steps': '100', '--step-timeout': '30', '--report': 'junit=caw-junit.xml', '--url': 'http://localhost:5173', '--from': 'caw/.explore.json',
};
/** Where Claude works: started locally, in Docker or as the developer's Claude Code session. */
export const AGENT_CHOICES = ['local', 'docker', 'session'];
/** Where the overlay comes from: local build or dev server (Sencha: the watch). Without a value the one configured source. */
export const OVERLAY_CHOICES = ['build', 'dev'];
/** A value of --overlay: build, dev or the address of a dev server. */
const overlayValue = (value) => OVERLAY_CHOICES.includes(value) || /^https?:\/\/[^\s/]+/i.test(value ?? '');
// The human is at the chat, which takes longer than a run without them.
export const CLAUDE_TIMEOUT_MIN = 60;
const STEP_ID = /^S[1-9]\d*$/;

/** A missing option value, or the next option in its place (--target --headless), is a usage error with an example. */
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
 * Each command only knows its own options. --target may be omitted: then the command picks the only matching target.
 * run also takes several tests or --all; they then run one after another without chat, with a table at the end.
 * @param command run, record, fix or open
 */
export const parseRunArgs = (command, args) => {
    const allowed = COMMAND_OPTIONS[command];
    const options = { stepTimeoutSec: 30, ...(command === 'run' ? { handover: false, advise: false, headless: false, noChat: false, learn: true, all: false, tests: [] } : { timeoutMin: CLAUDE_TIMEOUT_MIN }), ...(command === 'record' ? { also: [] } : {}) };
    const rest = [...args];
    while (rest.length > 0) {
        const arg = rest.shift();
        if (!arg.startsWith('--')) {
            if (command === 'open') throw new CawError('usage', t('session.args.unexpected', { arg }));
            if (command === 'run') options.tests.push(arg);
            if (options.test === undefined) options.test = arg;
            else if (command === 'fix' && options.step === undefined) options.step = arg;
            else if (command !== 'run') throw new CawError('usage', t('session.args.unexpected', { arg }));
            continue;
        }
        const [flag, inline] = arg.split(/=(.*)/s);
        if (!allowed.includes(flag)) throw new CawError('usage', t('session.args.unknownOption', { command, flag, allowed: allowed.join(', ') }));
        // --overlay may stand without a value: --overlay, --overlay build, --overlay=dev, --overlay http://localhost:5174. A test
        // named build needs --overlay=…
        if (flag === '--overlay') {
            const value = inline ?? (overlayValue(rest[0]) ? rest.shift() : undefined);
            if (value !== undefined && !overlayValue(value)) throw new CawError('usage', t('session.args.overlayChoice', { choices: OVERLAY_CHOICES.join(', ') }));
            options.overlay = value ?? true;
            continue;
        }
        const value = SWITCHES.has(flag) ? true : requireValue(flag, inline ?? rest.shift());
        if (flag === '--target') options.target = value;
        else if (flag === '--handover') options.handover = true;
        else if (flag === '--advise') options.advise = true;
        else if (flag === '--headless') options.headless = true;
        else if (flag === '--no-chat') options.noChat = true;
        else if (flag === '--no-learn') options.learn = false;
        else if (flag === '--all') options.all = true;
        else if (flag === '--read-only') options.readOnly = true;
        else if (flag === '--start') options.start = true;
        else if (flag === '--max-steps') options.maxSteps = Number(value);
        else if (flag === '--until') options.until = value;
        else if (flag === '--role') options.role = value;
        else if (flag === '--app') options.app = value;
        else if (flag === '--also') options.also.push(value);
        else if (flag === '--step-timeout') options.stepTimeoutSec = Number(value);
        else if (flag === '--report') {
            const match = /^junit=(.+)$/.exec(value);
            if (match === null) throw new CawError('usage', t('session.args.report'));
            options.junit = match[1];
        }
        else if (flag === '--agent') {
            if (!AGENT_CHOICES.includes(value)) throw new CawError('usage', t('session.args.agentChoice', { choices: AGENT_CHOICES.join(', ') }));
            options.agent = value;
        }
        else options.timeoutMin = Number(value);
    }
    if (options.all && options.test !== undefined) throw new CawError('usage', t('session.args.allWithTests'));
    if (options.start && options.overlay === undefined) throw new CawError('usage', t('session.args.startWithoutOverlay'));
    if (command !== 'open' && options.test === undefined && !options.all) throw new CawError('usage', t('session.args.testMissing'));
    for (const test of command === 'run' ? options.tests : command === 'open' ? [] : [options.test]) checkTestId(test);
    if (command === 'fix' && !STEP_ID.test(options.step ?? '')) throw new CawError('usage', t('session.args.fixStep'));
    if (options.timeoutMin !== undefined && (!Number.isFinite(options.timeoutMin) || options.timeoutMin <= 0)) throw new CawError('usage', t('session.args.timeout'));
    if (!Number.isFinite(options.stepTimeoutSec) || options.stepTimeoutSec <= 0) throw new CawError('usage', t('session.args.stepTimeout'));
    if (options.maxSteps !== undefined && (!Number.isInteger(options.maxSteps) || options.maxSteps <= 0)) throw new CawError('usage', t('session.args.maxSteps'));
    if (options.until !== undefined && !STEP_ID.test(options.until)) throw new CawError('usage', t('session.args.until'));
    // Several tests are meant for CI: no chat and no handover, otherwise every test would wait for a human.
    if (command === 'run' && (options.all || options.tests.length > 1)) {
        const clash = [['--advise', options.advise], ['--handover', options.handover], ['--until', options.until !== undefined]].find(([, set]) => set);
        if (clash !== undefined) throw new CawError('usage', t('session.args.batchClash', { other: clash[0] }));
        options.batch = true;
        options.noChat = true;
    }
    // Without a window there is nothing to hand over, without chat nothing to fix.
    if (options.headless) options.noChat = true;
    const without = options.headless ? '--headless' : '--no-chat';
    if (options.noChat) {
        const clash = [['--advise', options.advise], ['--handover', options.handover], ['--until', options.until !== undefined]].find(([, set]) => set);
        if (clash !== undefined) throw new CawError('usage', t('session.args.clash', { without, other: clash[0] }));
    }
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

