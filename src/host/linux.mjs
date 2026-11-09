import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';

/**
 * Windows-Pfad zu Linux-Pfad, auch \\wsl.localhost\<distro>\... Laesst Linux-Pfade unveraendert. Ergibt auch den
 * Pfad des Projekts im Container, damit er auf jedem Docker-Weg gleich aussieht.
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

export const parseEnvFile = (text) => {
    const env = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (match === null) continue;
        env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    return env;
};

const CLAUDE_OPTIONS = ['--target', '--timeout', '--max-steps', '--step-timeout', '--agent'];
const COMMAND_OPTIONS = {
    // --timeout und --max-steps gelten fuer Claude beim Klaeren, Empfehlen und Beheben; das Abspielen selbst begrenzt --step-timeout.
    run: ['--target', '--until', '--handover', '--advise', '--headless', '--no-chat', '--step-timeout', '--timeout', '--max-steps', '--agent'],
    record: [...CLAUDE_OPTIONS, '--role', '--app', '--also', '--read-only'],
    fix: CLAUDE_OPTIONS,
};
const SWITCHES = new Set(['--handover', '--advise', '--headless', '--no-chat', '--read-only']);
/** Wo Claude arbeitet: lokal gestartet, in Docker oder als die Claude-Code-Session des Entwicklers. */
export const AGENT_CHOICES = ['local', 'docker', 'session'];
// Der Mensch sitzt am Chat, das dauert laenger als ein Lauf ohne ihn.
export const CLAUDE_TIMEOUT_MIN = 60;
const STEP_ID = /^S[1-9]\d*$/;

/**
 * Jeder Befehl kennt nur seine eigenen Optionen.
 * @param command run, record oder fix
 */
export const parseRunArgs = (command, args) => {
    const allowed = COMMAND_OPTIONS[command];
    const options = { stepTimeoutSec: 30, ...(command === 'run' ? { handover: false, advise: false, headless: false, noChat: false } : { timeoutMin: CLAUDE_TIMEOUT_MIN }), ...(command === 'record' ? { also: [] } : {}) };
    const rest = [...args];
    while (rest.length > 0) {
        const arg = rest.shift();
        if (!arg.startsWith('--')) {
            if (options.test === undefined) options.test = arg;
            else if (command === 'fix' && options.step === undefined) options.step = arg;
            else throw new CawError('usage', t('session.args.unexpected', { arg }));
            continue;
        }
        const [flag, inline] = arg.split(/=(.*)/s);
        if (!allowed.includes(flag)) throw new CawError('usage', t('session.args.unknownOption', { command, flag, allowed: allowed.join(', ') }));
        const value = SWITCHES.has(flag) ? true : inline ?? rest.shift();
        if (flag === '--target') options.target = value;
        else if (flag === '--handover') options.handover = true;
        else if (flag === '--advise') options.advise = true;
        else if (flag === '--headless') options.headless = true;
        else if (flag === '--no-chat') options.noChat = true;
        else if (flag === '--read-only') options.readOnly = true;
        else if (flag === '--max-steps') options.maxSteps = Number(value);
        else if (flag === '--until') options.until = value;
        else if (flag === '--role') options.role = value;
        else if (flag === '--app') options.app = value;
        else if (flag === '--also') options.also.push(value);
        else if (flag === '--step-timeout') options.stepTimeoutSec = Number(value);
        else if (flag === '--agent') {
            if (!AGENT_CHOICES.includes(value)) throw new CawError('usage', t('session.args.agentChoice', { choices: AGENT_CHOICES.join(', ') }));
            options.agent = value;
        }
        else options.timeoutMin = Number(value);
    }
    if (options.test === undefined) throw new CawError('usage', t('session.args.testMissing'));
    if (command === 'fix' && !STEP_ID.test(options.step ?? '')) throw new CawError('usage', t('session.args.fixStep'));
    if (options.target === undefined) throw new CawError('usage', t('session.args.targetMissing'));
    if (options.timeoutMin !== undefined && (!Number.isFinite(options.timeoutMin) || options.timeoutMin <= 0)) throw new CawError('usage', t('session.args.timeout'));
    if (!Number.isFinite(options.stepTimeoutSec) || options.stepTimeoutSec <= 0) throw new CawError('usage', t('session.args.stepTimeout'));
    if (options.maxSteps !== undefined && (!Number.isInteger(options.maxSteps) || options.maxSteps <= 0)) throw new CawError('usage', t('session.args.maxSteps'));
    if (options.until !== undefined && !STEP_ID.test(options.until)) throw new CawError('usage', t('session.args.until'));
    // Ohne Fenster gibt es nichts zu uebergeben, ohne Chat nichts zu beheben.
    if (options.headless) options.noChat = true;
    const without = options.headless ? '--headless' : '--no-chat';
    if (options.noChat) {
        const clash = [['--advise', options.advise], ['--handover', options.handover], ['--until', options.until !== undefined]].find(([, set]) => set);
        if (clash !== undefined) throw new CawError('usage', t('session.args.clash', { without, other: clash[0] }));
    }
    return options;
};

/** Warum Claude keinen Lauf geliefert hat, so benannt, dass der Bericht die Abhilfe nennt. */
export const claudeFailureReason = (code, log) => {
    if (/\b401\b|Invalid bearer token|Failed to authenticate/.test(log)) {
        return t('session.claude.tokenInvalid');
    }
    if (code === 124) return t('session.claude.timeout');
    return t('session.claude.exit', { code });
};

