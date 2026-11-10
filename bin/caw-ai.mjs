#!/usr/bin/env node
import { CawError, EXIT } from '../src/shared/errors.mjs';
import { detectLanguage, setLanguage, t } from '../src/shared/i18n.mjs';

const usage = () => t('cli.usage');

const option = (args, name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
};

const main = async ([command, ...args]) => {
    const root = process.env.INIT_CWD ?? process.cwd();
    setLanguage(detectLanguage({ root }));
    const host = () => import('../src/host/commands.mjs');
    const sandbox = () => import('../src/sandbox/commands.mjs');
    const browser = async (payload) => (await sandbox()).browserCommand(payload);
    switch (command) {
        case 'init': {
            const commands = await host();
            // init sieht sich die Anwendung erst an (explore); im Terminal fragt es nach Adresse und Rollen, --yes oder CI nicht.
            const ask = process.stdin.isTTY && !args.includes('--yes') && !process.env.CI;
            const prepared = await commands.initAnswers(root, args, { interactive: ask });
            if (prepared.code !== undefined) return prepared.code;
            return commands.init(root, prepared.answers);
        }
        case 'explore': return (await import('../src/host/explore.mjs')).explore(root, args);
        case 'skill': return (await host()).installSkill(root);
        case 'validate': return (await host()).validate(root);
        case 'auth': return (await host()).auth(root, args);
        case 'doctor': {
            const [{ doctor }, { createUi }] = await Promise.all([import('../src/host/doctor.mjs'), import('../src/shared/ui.mjs')]);
            const unknown = args.filter((arg, index) => arg !== '--agent' && args[index - 1] !== '--agent');
            if (unknown.length > 0) throw new CawError('usage', t('cli.doctorUnknownArg', { arg: unknown[0] }));
            const agent = option(args, '--agent');
            if (args.includes('--agent') && !['local', 'docker', 'session'].includes(agent)) throw new CawError('usage', t('cli.doctorAgentValue'));
            return doctor(root, { ui: createUi(), agent });
        }
        case 'run': return (await host()).run(root, args);
        case 'record': return (await host()).record(root, args);
        case 'fix': return (await host()).fix(root, args);
        case 'plan': return (await sandbox()).plan(option(args, '--file'));
        case 'sandbox-run': return (await sandbox()).sandboxRun({ root, runId: option(args, '--run-id'), timeoutMin: Number(option(args, '--timeout')), mode: args.includes('--develop') ? 'develop' : args.includes('--talk') ? 'talk' : args.includes('--advise') ? 'advise' : 'run' });
        case 'advise': return (await sandbox()).advise(option(args, '--file'));
        case 'firewall-check': return (await sandbox()).firewallCheck();
        // Werkzeuge fuer die Claude-Code-Session des Entwicklers, eingetragen in .mcp.json.
        case 'mcp': {
            const [{ serveMcp }, { sessionMcpHandler }] = await Promise.all([import('../src/sandbox/mcp.mjs'), import('../src/host/session-mcp.mjs')]);
            await serveMcp(sessionMcpHandler({ root }));
            return EXIT.pass;
        }
        // Intern: Werkzeug-Server fuer Claude ohne Container, gestartet von Claude Code selbst.
        case 'mcp-agent': {
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
        // Der Mensch braucht Zeit: Der Kanal wartet hier laenger als bei Browser-Befehlen.
        case 'ask-operator': return (await sandbox()).browserCommand({ action: command, question: args[0] }, { timeoutMs: 60 * 60 * 1000 });
        case 'chat': return (await sandbox()).browserCommand({ action: command }, { timeoutMs: 60 * 60 * 1000 });
        case 'say': return browser({ action: command, text: args[0] });
        case 'click': return browser({ action: command, target: args[0] });
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
            const minCount = option(args, '--min-count');
            const timeout = option(args, '--timeout');
            return (await sandbox()).waitReady({
                store: option(args, '--store'),
                ...(minCount === undefined ? {} : { minCount: Number(minCount) }),
                ...(timeout === undefined ? {} : { timeout: Number(timeout) }),
            });
        }
        case 'finish': return (await sandbox()).finish(option(args, '--file'));
        case '--version':
        case '-v': {
            const { readFileSync } = await import('node:fs');
            console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
            return EXIT.pass;
        }
        case undefined:
        case 'help':
        case '--help':
            console.log(usage());
            return EXIT.pass;
        default:
            console.error(`${t('cli.unknownCommand', { command })}\n\n${usage()}`);
            return EXIT.rejected;
    }
};

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    // Ein unerwarteter Fehler (Datei, Playwright, ein Fehler im Tool) ist kein Urteil ueber die Anwendung: Exit 2, nicht 1, damit CI ihn
    // nicht als gescheiterten Test zaehlt. Der Stack bleibt fuer die Fehlersuche.
    if (!(error instanceof CawError)) {
        process.exitCode = EXIT.error;
        // Beenden wie ein ungefangener Fehler (offene Browser halten den Prozess sonst), aber erst, wenn der Stack geschrieben ist.
        process.stderr.write(`${error?.stack ?? String(error)}\n`, () => process.exit());
        await new Promise(() => {});
    }
    const [{ colorEnabled }, { createUi }] = await Promise.all([import('../src/shared/color.mjs'), import('../src/shared/ui.mjs')]);
    createUi({ fancy: colorEnabled({ isTTY: process.stderr.isTTY }) }).fatal(error.code, error.message);
    const rejected = ['usage', 'auth-missing', 'finish-rejected', 'test-invalid', 'test-missing', 'write-protected', 'target-invalid', 'config-invalid', 'config-missing', 'target-denied', 'unknown-command', 'command-invalid', 'replay-missing', 'replay-stale', 'step-limit', 'step-order', 'step-unknown', 'human-message', 'plan-required', 'plan-invalid', 'advice-invalid', 'advise-only'];
    process.exitCode = rejected.includes(error.code) ? EXIT.rejected : EXIT.error;
}
