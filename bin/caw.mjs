#!/usr/bin/env node
import { CawError, EXIT, exitOf } from '../src/shared/errors.mjs';
import { AGENT_COMMANDS, HOST_COMMANDS, helpText, synopsisOf, unknownCommandText } from '../src/shared/help.mjs';
import { detectLanguage, setLanguage, t } from '../src/shared/i18n.mjs';

const HELP = new Set(['-h', '--help']);

/** The environments Claude may work on, for the help text; undefined without a readable config. */
const claudeEnvironments = async (root) => {
    try {
        const { environmentsWith, loadConfig } = await import('../src/shared/config.mjs');
        return environmentsWith(loadConfig(root), 'claude').join(', ') || undefined;
    } catch {
        return undefined;
    }
};

/**
 * -h and --help work everywhere: alone for everything, after a command for its block. `caw agent --help` shows the agent
 * commands; they take arbitrary text, so there --help counts only right after `agent` or the agent command.
 */
const helpFor = async (root, command, args) => {
    if (command === undefined || HELP.has(command)) return helpText(undefined, { here: await claudeEnvironments(root) });
    if (command === 'help') {
        const [topic] = args;
        if (topic === 'agent') throw new CawError('unknown-command', t('cli.movedCommand', { command: 'help agent', now: 'agent --help' }));
        if (topic !== undefined && !HOST_COMMANDS.includes(topic)) throw new CawError('unknown-command', unknownCommandText(topic));
        return helpText(topic, { here: await claudeEnvironments(root) });
    }
    if (command === 'agent') return args.length === 0 || HELP.has(args[0]) || (AGENT_COMMANDS.includes(args[0]) && HELP.has(args[1])) ? helpText('agent') : undefined;
    if (HOST_COMMANDS.includes(command) && args.some((arg) => HELP.has(arg))) return helpText(command, { here: await claudeEnvironments(root) });
    return undefined;
};

const option = (args, name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
};

/** `caw agent <command>`: what Claude calls during a run (sandbox, local or the developer's session), and the run plumbing. */
const agentCommand = async (root, [command, ...args]) => {
    const sandbox = () => import('../src/sandbox/commands.mjs');
    const browser = async (payload) => (await sandbox()).browserCommand(payload);
    switch (command) {
        case 'plan': return (await sandbox()).plan(option(args, '--file'));
        case 'advise': return (await sandbox()).advise(option(args, '--file'));
        case 'finish': return (await sandbox()).finish(option(args, '--file'));
        // Plumbing: the agent's process in the container (or locally), the firewall probe and the local agent's MCP server.
        case 'sandbox-run': return (await sandbox()).sandboxRun({ root, runId: option(args, '--run-id'), timeoutMin: Number(option(args, '--timeout')), mode: args.includes('--develop') ? 'develop' : args.includes('--talk') ? 'talk' : args.includes('--advise') ? 'advise' : 'run' });
        case 'firewall-check': return (await sandbox()).firewallCheck();
        // Tool server for Claude without a container, started by Claude Code itself.
        case 'mcp': {
            const { createMcpHandler, serveMcp } = await import('../src/sandbox/mcp.mjs');
            if (process.env.CAW_SANDBOX !== '1' || !process.env.CAW_AGENT_DIR) throw new CawError('not-in-sandbox', t('cli.mcpAgentOnly'));
            await serveMcp(createMcpHandler({ agentDir: process.env.CAW_AGENT_DIR }));
            return EXIT.pass;
        }
        case 'task':
        case 'snapshot':
        case 'url':
        case 'reload':
        case 'console':
        case 'network':
        case 'recording':
            return browser({ action: command });
        // The human needs time: the channel waits longer here than for browser commands.
        case 'ask-operator': return (await sandbox()).browserCommand({ action: command, question: args[0] }, { timeoutMs: 60 * 60 * 1000 });
        case 'chat': return (await sandbox()).browserCommand({ action: command }, { timeoutMs: 60 * 60 * 1000 });
        case 'say': return browser({ action: command, text: args[0] });
        case 'click': return browser({ action: command, target: args.find((arg) => !arg.startsWith('--')), ...(args.includes('--optional') ? { optional: true } : {}) });
        case 'dblclick': return browser({ action: command, target: args[0] });
        case 'upload': return browser({ action: command, target: args[0], files: args.slice(1) });
        case 'fill':
        case 'type':
            return browser({ action: command, target: args[0], value: args[1] });
        case 'press': return browser({ action: command, key: args[0] });
        case 'eval': return browser({ action: command, code: args[0] });
        case 'check': return browser({ action: command, id: args[0], code: args[1] });
        case 'remember': return browser({ action: command, name: args[0], code: args[1] });
        case 'screenshot': return browser({ action: command, name: args[0] });
        case 'goto': return browser({ action: command, url: args[0] });
        case 'wait-ready': {
            if (args.some((arg) => arg === '--store' || arg.startsWith('--store='))) throw new CawError('usage', t('session.args.renamedOption', { flag: '--store', now: '--for' }));
            const minCount = option(args, '--min-count');
            const timeout = option(args, '--timeout');
            const { parseDuration } = await import('../src/shared/duration.mjs');
            return (await sandbox()).waitReady({
                for: option(args, '--for'),
                ...(minCount === undefined ? {} : { minCount: Number(minCount) }),
                ...(timeout === undefined ? {} : { timeout: parseDuration('--timeout', timeout) }),
            });
        }
        default:
            throw new CawError('unknown-command', unknownCommandText(command, { agent: true }));
    }
};

const main = async ([command, ...args]) => {
    const root = process.env.INIT_CWD ?? process.cwd();
    setLanguage(detectLanguage());
    const help = await helpFor(root, command, args);
    if (help !== undefined) {
        console.log(help);
        return EXIT.pass;
    }
    const host = () => import('../src/host/commands.mjs');
    switch (command) {
        case 'init': {
            // --explore-only: look at the app and write only caw/.explore.json (and caw/.env via the role card), no config.
            if (args.includes('--explore-only')) return (await import('../src/host/explore.mjs')).explore(root, args.filter((arg) => arg !== '--explore-only'));
            const commands = await host();
            // init explores the application first; in a terminal it asks for address and roles, not with --yes or in CI.
            const ask = process.stdin.isTTY && !args.includes('--yes') && !process.env.CI;
            const prepared = await commands.initAnswers(root, args, { interactive: ask });
            if (prepared.code !== undefined) return prepared.code;
            return commands.init(root, prepared.answers);
        }
        case 'skill': return (await host()).installSkill(root);
        case 'validate': return (await host()).validate(root);
        case 'list': return (await host()).list(root, args);
        case 'theme': return (await import('../src/host/theme-command.mjs')).themeCommand(root, args);
        case 'doctor': {
            const [{ doctor }, { createUi }, { optionValue }] = await Promise.all([import('../src/host/doctor.mjs'), import('../src/shared/ui.mjs'), import('../src/host/linux.mjs')]);
            const valued = ['--agent', '--env'];
            const unknown = args.filter((arg, index) => !valued.some((flag) => arg === flag || arg.startsWith(`${flag}=`)) && !valued.includes(args[index - 1]));
            if (unknown.length > 0) throw new CawError('usage', t('cli.doctorUnknownArg', { arg: unknown[0] }));
            const agent = optionValue(args, '--agent');
            if (agent !== undefined && !['local', 'docker', 'session'].includes(agent)) throw new CawError('usage', t('cli.doctorAgentValue'));
            return doctor(root, { ui: createUi(), agent, environment: optionValue(args, '--env') });
        }
        case 'overlay': return (await import('../src/host/overlay-check.mjs')).overlayCommand(root, args);
        case 'role': return (await import('../src/host/role-command.mjs')).roleCommand(root, args);
        case 'run': return (await host()).run(root, args);
        case 'record': return (await host()).record(root, args);
        case 'open': return (await host()).open(root, args);
        // Tools for the developer's Claude Code session, registered in .mcp.json. Not in the human help.
        case 'mcp': {
            const [{ serveMcp }, { sessionMcpHandler }] = await Promise.all([import('../src/sandbox/mcp.mjs'), import('../src/host/session-mcp.mjs')]);
            await serveMcp(sessionMcpHandler({ root }));
            return EXIT.pass;
        }
        // Claude's browser commands and the run plumbing: `caw agent <command>`, see agentCommand.
        case 'agent': return agentCommand(root, args);
        case '--version':
        case '-v': {
            const { readFileSync } = await import('node:fs');
            console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
            return EXIT.pass;
        }
        default:
            throw new CawError('unknown-command', unknownCommandText(command));
    }
};

const argv = process.argv.slice(2);
try {
    process.exitCode = await main(argv);
} catch (error) {
    // An unexpected error (file, Playwright, a bug in the tool) is no verdict on the application: exit 2, not 1, so CI does not
    // count it as a failed test. The stack stays for debugging.
    if (!(error instanceof CawError)) {
        process.exitCode = EXIT.error;
        // Exit like an uncaught error (open browsers would keep the process alive), but only once the stack is written.
        process.stderr.write(`${error?.stack ?? String(error)}\n`, () => process.exit());
        await new Promise(() => {});
    }
    const [{ colorEnabled }, { createUi }] = await Promise.all([import('../src/shared/color.mjs'), import('../src/shared/ui.mjs')]);
    // First the message, for a usage error the command synopsis, then code and exit. result.json is not affected.
    const exit = exitOf(error.code);
    const synopsis = error.code === 'usage' ? synopsisOf(argv[0]) : undefined;
    createUi({ fancy: colorEnabled({ isTTY: process.stderr.isTTY }) }).fatal(error.code, error.message, { synopsis, exit });
    process.exitCode = exit;
}
