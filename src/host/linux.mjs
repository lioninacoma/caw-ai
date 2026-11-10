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

/**
 * Ein Wert wie bei dotenv: in Anfuehrungszeichen genau der Inhalt (danach darf ein Kommentar stehen, in "…" wird \n zum Umbruch),
 * sonst bis zu einem Kommentar nach Leerraum (" # Testkonto") und ohne Leerraum aussen. Ein # ohne Leerraum davor gehoert zum Wert,
 * Passwoerter enthalten es.
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

const CLAUDE_OPTIONS = ['--target', '--timeout', '--max-steps', '--step-timeout', '--agent', '--overlay'];
const COMMAND_OPTIONS = {
    // --timeout und --max-steps gelten fuer Claude beim Klaeren, Empfehlen und Beheben; das Abspielen selbst begrenzt --step-timeout.
    run: ['--target', '--until', '--handover', '--advise', '--headless', '--no-chat', '--no-learn', '--all', '--report', '--step-timeout', '--timeout', '--max-steps', '--agent', '--overlay'],
    record: [...CLAUDE_OPTIONS, '--role', '--app', '--also', '--read-only'],
    fix: CLAUDE_OPTIONS,
    open: ['--target', '--role', '--app', '--overlay', '--agent', '--timeout', '--max-steps'],
};
const SWITCHES = new Set(['--handover', '--advise', '--headless', '--no-chat', '--no-learn', '--all', '--read-only']);
/** Ein Beispielwert je Option, fuer die Meldung, wenn der Wert fehlt. */
const VALUE_EXAMPLES = {
    '--target': 'local', '--until': 'S4', '--role': 'admin', '--app': 'web', '--also': 'admin', '--agent': 'local', '--timeout': '60',
    '--max-steps': '100', '--step-timeout': '30', '--report': 'junit=caw-junit.xml', '--url': 'http://localhost:5173', '--from': 'caw/.explore.json',
};
/** Wo Claude arbeitet: lokal gestartet, in Docker oder als die Claude-Code-Session des Entwicklers. */
export const AGENT_CHOICES = ['local', 'docker', 'session'];
/** Woher das Overlay kommt: lokaler Build oder Dev-Server (Sencha: der Watch). Ohne Wert die eine konfigurierte Quelle. */
export const OVERLAY_CHOICES = ['build', 'dev'];
/** Ein Wert von --overlay: build, dev oder die Adresse eines Dev-Servers. */
const overlayValue = (value) => OVERLAY_CHOICES.includes(value) || /^https?:\/\/[^\s/]+/i.test(value ?? '');
// Der Mensch sitzt am Chat, das dauert laenger als ein Lauf ohne ihn.
export const CLAUDE_TIMEOUT_MIN = 60;
const STEP_ID = /^S[1-9]\d*$/;

/** Fehlt der Wert einer Option oder steht dort schon die naechste (--target --headless), ist das ein Aufruffehler mit Beispiel. */
const requireValue = (flag, value) => {
    if (value === undefined || value === '' || value.startsWith('--')) throw new CawError('usage', t('session.args.valueMissing', { flag, example: VALUE_EXAMPLES[flag] ?? '…' }));
    return value;
};

/** Der Wert einer Option in einfachen Aufrufen (init, explore, doctor, auth): undefined ohne die Option, Aufruffehler ohne Wert. */
export const optionValue = (args, name) => {
    const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (index === -1) return undefined;
    const arg = args[index];
    return requireValue(name, arg === name ? args[index + 1] : arg.slice(name.length + 1));
};

/**
 * Ein Dateiname in caw/tests, flach: Ein Pfad wie team/login scheiterte erst nach der ganzen Aufnahme beim Schreiben, ../x schriebe
 * ausserhalb von caw/tests. Buchstaben jeder Sprache (kündigung), keine Trenner und keine Steuerzeichen.
 */
const checkTestId = (test) => {
    if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$/u.test(test) || test.endsWith('.') || test.length > 100) throw new CawError('usage', t('session.args.testId', { test }));
};

/**
 * Jeder Befehl kennt nur seine eigenen Optionen. --target darf fehlen: Dann waehlt der Befehl das einzige passende Ziel.
 * run nimmt auch mehrere Tests oder --all; dann laeuft es nacheinander ohne Chat und zeigt am Ende eine Tabelle.
 * @param command run, record oder fix
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
        // --overlay darf ohne Wert stehen: --overlay, --overlay build, --overlay=dev, --overlay http://localhost:5174. Ein Test, der
        // build heisst, braucht --overlay=…
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
    if (command !== 'open' && options.test === undefined && !options.all) throw new CawError('usage', t('session.args.testMissing'));
    for (const test of command === 'run' ? options.tests : command === 'open' ? [] : [options.test]) checkTestId(test);
    if (command === 'fix' && !STEP_ID.test(options.step ?? '')) throw new CawError('usage', t('session.args.fixStep'));
    if (options.timeoutMin !== undefined && (!Number.isFinite(options.timeoutMin) || options.timeoutMin <= 0)) throw new CawError('usage', t('session.args.timeout'));
    if (!Number.isFinite(options.stepTimeoutSec) || options.stepTimeoutSec <= 0) throw new CawError('usage', t('session.args.stepTimeout'));
    if (options.maxSteps !== undefined && (!Number.isInteger(options.maxSteps) || options.maxSteps <= 0)) throw new CawError('usage', t('session.args.maxSteps'));
    if (options.until !== undefined && !STEP_ID.test(options.until)) throw new CawError('usage', t('session.args.until'));
    // Mehrere Tests sind fuer CI gedacht: ohne Chat und ohne Uebergabe, sonst wartete jeder Test auf einen Menschen.
    if (command === 'run' && (options.all || options.tests.length > 1)) {
        const clash = [['--advise', options.advise], ['--handover', options.handover], ['--until', options.until !== undefined]].find(([, set]) => set);
        if (clash !== undefined) throw new CawError('usage', t('session.args.batchClash', { other: clash[0] }));
        options.batch = true;
        options.noChat = true;
    }
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

