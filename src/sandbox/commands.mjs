// Die Befehle im Container: duenne Clients. Browser, Anmeldung und Urteil liegen auf dem Host,
// erreichbar nur ueber den Dateikanal. Hier gibt es weder Zugangsdaten noch Netz zur Anwendung.

import { spawn, spawnSync } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { existsSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { sendCommand } from '../shared/channel.mjs';
import { findSessionAgent } from '../shared/session-agent.mjs';
import { resolveClaude } from '../shared/claude-bin.mjs';
import { painter } from '../shared/color.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { colorLine, formatClaudeLine, stampLine } from './claude-log.mjs';

const CHANNEL_DIR = '.channel';
const HUMAN_TIMEOUT_MS = 60 * 60 * 1000;

/** Der Agent-Ordner: in Sandbox und lokalem Agenten aus der Umgebung, fuer die eigene Session aus der Marke des wartenden Laufs. */
const agentDir = () => {
    const dir = process.env.CAW_AGENT_DIR;
    if (process.env.CAW_SANDBOX === '1' && dir) return dir;
    const waiting = findSessionAgent(process.env.INIT_CWD ?? process.cwd());
    if (waiting !== undefined) return waiting.agentDir;
    throw new CawError('not-in-sandbox', 'Kein Lauf wartet auf einen Agenten. In deiner Session: caw-ai record <test> --target <umgebung> --agent session starten (im Hintergrund), dann diese Befehle.');
};

/** Reicht einen Befehl an den Browser auf dem Host und gibt die Antwort aus. */
export const browserCommand = async (command, options) => {
    const value = await sendCommand(join(agentDir(), CHANNEL_DIR), command, options);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return EXIT.pass;
};

export const waitReady = async (args) => {
    const result = await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'wait-ready', ...args });
    console.log(JSON.stringify(result, null, 2));
    return result.settled ? EXIT.pass : EXIT.fail;
};

/** Reicht das Urteil ein. Unvollstaendige Ergebnisse lehnt der Host ab, sodass der Agent nachbessern muss. */
export const finish = async (file) => {
    let results;
    try {
        results = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new CawError('finish-rejected', `Ergebnisdatei nicht lesbar: ${error.message}`);
    }
    const { status } = await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'finish', results });
    console.log(`Urteil angenommen: ${status}`);
    return EXIT.pass;
};

/** Legt den Ablaufplan im Chat vor und wartet auf den Menschen. Der Text steht im Befehl: Nur so sieht er genau, was der Agent einreicht. */
export const plan = async (file) => {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw new CawError('plan-invalid', `Plandatei nicht lesbar: ${error.message}`);
    }
    console.log(JSON.stringify(await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'plan', text }, { timeoutMs: HUMAN_TIMEOUT_MS }), null, 2));
    return EXIT.pass;
};

/** Reicht Empfehlungen ein. Der Mensch entscheidet je Karte, die Antwort nennt seine Entscheidungen. */
export const advise = async (file) => {
    let advice;
    try {
        advice = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new CawError('advice-invalid', `Empfehlungsdatei nicht lesbar: ${error.message}`);
    }
    console.log(JSON.stringify(await sendCommand(join(agentDir(), CHANNEL_DIR), { action: 'advise', advice }, { timeoutMs: HUMAN_TIMEOUT_MS }), null, 2));
    return EXIT.pass;
};

const canConnect = (host) => new Promise((ok) => {
    const req = httpsRequest({ host, method: 'HEAD', timeout: 6000, rejectUnauthorized: false }, (res) => { res.resume(); ok(true); });
    req.on('timeout', () => { req.destroy(); ok(false); });
    req.on('error', () => ok(false));
    req.end();
});

/** Der Agent startet nur, wenn die Sandbox nachweislich dicht ist. */
export const firewallCheck = async ({ print = (value) => console.log(JSON.stringify(value, null, 2)) } = {}) => {
    const checks = {
        anthropicReachable: await canConnect('api.anthropic.com'),
        externalBlocked: !await canConnect('example.com'),
        // Direkt an den Resolver, an /etc/hosts vorbei: Kommt eine Antwort, liessen sich Daten in DNS-Namen hinaustragen.
        dnsBlocked: await new dns.Resolver({ timeout: 3000, tries: 1 }).resolve4('example.com').then(() => false, () => true),
        sudoBlocked: spawnSync('sudo', ['-n', 'iptables', '-L'], { stdio: 'ignore' }).status !== 0,
    };
    print(checks);
    if (!Object.values(checks).every(Boolean)) throw new CawError('sandbox-open', `Die Sandbox ist nicht dicht: ${JSON.stringify(checks)}`);
    return EXIT.pass;
};

// Je Art ein eigenes Log: Das der Aufnahme bleibt, auch wenn danach noch empfohlen oder geklaert wird.
const MODES = {
    run: { log: 'claude.log', prompt: (runId) => `/caw-ai Der Lauf ${runId} ist offen. Fuehre ihn durch und reiche das Ergebnis mit finish ein.` },
    advise: { log: 'claude-empfehlung.log', prompt: (runId) => `/caw-ai Im Lauf ${runId} sind Fehler oder Warnungen aufgetreten. Lies den Auftrag mit task und reiche deine Empfehlungen mit advise ein.` },
    talk: { log: 'claude-gespraech.log', prompt: (runId) => `/caw-ai Im Lauf ${runId} ist ein Schritt gescheitert, und der Mensch fragt dich im Chat. Lies den Auftrag mit task, antworte mit say und warte mit chat auf ihn.` },
    develop: { log: 'claude-gespraech.log', prompt: (runId) => `/caw-ai Im Lauf ${runId} entwickelt der Mensch im hergestellten Zustand und fragt dich im Chat, etwa nach einem Bug. Lies den Auftrag mit task, antworte mit say und warte mit chat auf ihn.` },
};

/**
 * Umgebung fuer Claude im Container. `plan`, `ask-operator` und `chat` warten auf den Menschen, oft laenger als die
 * 2 Minuten, nach denen Claude Code einen Bash-Aufruf sonst in den Hintergrund schiebt. Danach beendet `claude -p` den Zug
 * und damit den Lauf, waehrend der Mensch noch liest. Deshalb: Bash darf so lange laufen wie der ganze Lauf, Hintergrund aus.
 */
export const claudeEnv = (timeoutMin, env = process.env) => {
    const ms = String(timeoutMin * 60 * 1000);
    return { ...env, BASH_DEFAULT_TIMEOUT_MS: ms, BASH_MAX_TIMEOUT_MS: ms, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
};

/** Aufruf von Claude im Container: alle Rechte, aber nur dort. Ohne Werkzeuge, die auf spaeter vertroesten. */
export const claudeArgs = (prompt) => ['-p', prompt, '--dangerously-skip-permissions', '--disallowedTools', 'Monitor,ScheduleWakeup', '--output-format', 'stream-json', '--verbose'];

const SKILL_FILE = fileURLToPath(new URL('../../templates/skill.md', import.meta.url));
const BIN = fileURLToPath(new URL('../../bin/caw-ai.mjs', import.meta.url));
// Lesen ja, Shell, Schreiben und Netz nie. Der Browser kommt nur ueber das Tool caw.
export const LOCAL_TOOLS = ['Read', 'Grep', 'Glob'];
// Nur im Projektordner (Arbeitsordner von Claude): Ohne Pfad duerften Read, Grep und Glob den ganzen Rechner lesen, etwa ~/.ssh.
export const LOCAL_ALLOWED = [...LOCAL_TOOLS.map((tool) => `${tool}(./**)`), 'mcp__caw__caw'];
// Dieselben Geheimnisse wie im Container verdeckt (maskArgs), hier als Leseverbot.
export const LOCAL_DENY = ['.env', '.env.*', '**/.env', '**/.env.*', '.git/**', '**/.git/**', '.claude/**', '.worktrees/**', '.caw/**', 'caw/.auth/**',
    '**/.npmrc', '**/.netrc', '**/.pgpass', '**/.git-credentials', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_dsa*', '**/id_ed25519*', '**/id_ecdsa*']
    .flatMap((pattern) => LOCAL_TOOLS.map((tool) => `${tool}(${pattern})`));
// Vorweg zum Skill: Lokal gibt es keine Shell, die Befehle laufen ueber ein Tool.
export const LOCAL_PREAMBLE = `Du laeufst lokal, nicht im Container. Du hast keine Shell und kannst keine Dateien schreiben. Jeder Befehl
\`caw-ai <befehl> ...\` aus der folgenden Anleitung ist ein Aufruf des Tools mcp__caw__caw mit args, etwa args ["snapshot"] oder
["click", "e12"]. Wo die Anleitung eine Datei schreibt und --file nennt (plan, finish, advise), gibst du ihren Inhalt in file mit.
Den Quellcode liest du mit Read, Grep und Glob. Lies keine Dateien ausserhalb des Projekts.

`;

/** Aufruf von Claude ohne Container: nur die Werkzeuge oben, alles andere lehnt Claude Code ab, ohne zu fragen. */
export const localClaudeArgs = (prompt, { mcpConfig, settings, systemPromptFile }) => [
    '-p', prompt,
    '--tools', LOCAL_TOOLS.join(','),
    '--allowedTools', LOCAL_ALLOWED.join(','),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    // Keine Einstellungen des Nutzers oder des Projekts: Deren allow-Regeln (etwa "Read" oder "Read(//**)") und additionalDirectories
    // genehmigte dontAsk sonst still, und Claude laese ~/.ssh. Was der Aufruf davon braucht, traegt writeLocalSetup herueber.
    '--setting-sources', '',
    '--settings', settings,
    '--append-system-prompt-file', systemPromptFile,
    '--output-format', 'stream-json', '--verbose',
];

// Aus den Einstellungen des Nutzers nur, was die Verbindung zu Claude braucht (Proxy, Bedrock, Schluessel-Helfer, Modell), keine Rechte.
const CONNECTION_KEYS = ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'model'];
export const connectionSettings = (env = process.env) => {
    const file = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
    try {
        const parsed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
        return Object.fromEntries(CONNECTION_KEYS.filter((key) => parsed?.[key] !== undefined).map((key) => [key, parsed[key]]));
    } catch {
        return {};
    }
};

/** Die Dateien, die der lokale Aufruf braucht: MCP-Server, Leseverbote und die Anleitung. Alles im Agent-Ordner dieses Laufs. */
export const writeLocalSetup = (dir, env = process.env) => {
    const mcpConfig = join(dir, 'mcp.json');
    const settings = join(dir, 'settings.json');
    const systemPromptFile = join(dir, 'anleitung.md');
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { caw: { command: process.execPath, args: [BIN, 'mcp-agent'], env: { CAW_SANDBOX: '1', CAW_AGENT_DIR: dir, ...(env.CAW_COLOR ? { CAW_COLOR: env.CAW_COLOR } : {}) } } } }, null, 2));
    writeFileSync(settings, JSON.stringify({ ...connectionSettings(env), permissions: { deny: LOCAL_DENY }, disableAllHooks: true }, null, 2));
    writeFileSync(systemPromptFile, `${LOCAL_PREAMBLE}${readFileSync(SKILL_FILE, 'utf8').replace(/^---[\s\S]*?---\s*/, '')}`);
    return { mcpConfig, settings, systemPromptFile };
};

/**
 * Hauptprozess des Containers: pruefen, dann Claude den offenen Lauf bearbeiten lassen.
 * @param mode run (aufnehmen, beheben), advise (nur empfehlen) oder talk (mit dem Menschen klaeren)
 */
export const sandboxRun = async ({ root, runId, timeoutMin, mode = 'run' }) => {
    const dir = agentDir();
    const local = process.env.CAW_AGENT_LOCAL === '1';
    const { log: logName, prompt: promptFor } = MODES[mode];
    let claude;
    let timer;
    if (local) {
        // Ohne Container gibt es keine Firewall zu pruefen; die Grenze ziehen die Werkzeuge. Den Skill liefert die Anleitung, nicht /caw-ai.
        const prompt = promptFor(runId).replace(/^\/caw-ai /, '');
        const env = { ...claudeEnv(timeoutMin), MCP_TOOL_TIMEOUT: String(timeoutMin * 60 * 1000) };
        const bin = resolveClaude() ?? { file: 'claude', args: [] };
        claude = spawn(bin.file, [...bin.args, ...localClaudeArgs(prompt, writeLocalSetup(dir))], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        timer = setTimeout(() => claude.kill(), timeoutMin * 60 * 1000);
    } else {
        await firewallCheck({ print: () => {} });
        claude = spawn('timeout', [String(timeoutMin * 60), 'claude', ...claudeArgs(promptFor(runId))], { cwd: root, env: claudeEnv(timeoutMin), stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const log = openSync(join(dir, logName), 'w');
    const startedAt = Date.now();
    const paint = painter(process.env.CAW_COLOR === '1');
    const write = (line) => {
        for (const text of formatClaudeLine(line)) {
            const stamped = stampLine(text, startedAt, Date.now());
            writeSync(log, stamped);
            process.stdout.write(colorLine(stamped, paint));
        }
    };
    const drained = [claude.stdout, claude.stderr].map((stream) => new Promise((ok) => {
        createInterface({ input: stream }).on('line', write).on('close', ok);
    }));
    const code = await new Promise((ok) => {
        claude.on('error', (error) => {
            if (local && error.code === 'ENOENT') process.stdout.write('Claude Code (claude) ist nicht im PATH. Installieren: https://claude.com/claude-code\n');
            ok(1);
        });
        claude.on('close', (status) => ok(status ?? 1));
    });
    clearTimeout(timer);
    await Promise.all(drained);
    return code;
};
