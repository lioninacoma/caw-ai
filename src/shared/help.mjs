// Die Hilfe im Terminal: alles auf einmal (caw-ai --help) oder nur der Block eines Befehls (caw-ai run --help).
// Liegt in shared, denn auch der Agent in der Sandbox ruft caw-ai help agent auf.

import { t } from './i18n.mjs';
import { closest } from './suggest.mjs';
import { colorEnabled, nightPainter } from './color.mjs';
import { ravenBanner } from './raven.mjs';

/** Die Befehle auf dem Host, in der Reihenfolge der Hilfe. */
export const HOST_COMMANDS = ['skill', 'explore', 'init', 'validate', 'list', 'doctor', 'auth', 'theme', 'mcp', 'run', 'record', 'fix', 'open'];
/** Die Befehle fuer den Agenten; ihre Hilfe steht unter caw-ai help agent. */
export const AGENT_COMMANDS = ['task', 'snapshot', 'url', 'click', 'fill', 'type', 'press', 'eval', 'check', 'screenshot', 'goto', 'reload', 'wait-ready', 'console', 'network', 'plan', 'ask-operator', 'remember', 'chat', 'say', 'recording', 'finish', 'advise'];
const OTHER = ['help', '--help', '-h', '--version', '-v'];

/** Der Block eines Befehls; `here` nennt die Umgebungen, auf denen Claude arbeiten darf, wenn die Config sie kennt. */
const block = (command, here) => t(`cli.help.${command}`, { here: here === undefined || here === '' ? '' : t('cli.help.here', { names: here }) });

/** Der Rabe als Banner der ganzen Hilfe: Name und Langform stehen daneben, die erste Zeile des Intros entfaellt dafuer. */
const banner = (intro) => {
    const paint = nightPainter(colorEnabled());
    const raven = ravenBanner('caw-ai', { bold: (text) => paint.bold(paint.text(text)), dim: paint.muted, frame: paint.frame, beak: paint.beak, eye: paint.text });
    return [...raven, ...intro.split('\n').slice(1)].join('\n');
};

/**
 * Die Hilfe. Ohne Befehl alles fuer den Host, mit Befehl nur dessen Block, mit `agent` (oder einem Befehl fuer den Agenten) die
 * Befehle fuer den Agenten.
 * @param here etwa "local, dev": die Umgebungen mit Claude aus der Config, sonst undefined
 */
export const helpText = (command, { here } = {}) => {
    if (command === 'agent' || AGENT_COMMANDS.includes(command)) return t('cli.help.agent');
    if (HOST_COMMANDS.includes(command)) return block(command, here);
    return [banner(t('cli.help.intro')), ...HOST_COMMANDS.map((name) => block(name, here)), t('cli.help.version'), '', t('cli.help.footer')].join('\n');
};

/** Gibt es einen eigenen Block fuer diesen Befehl? */
export const hasHelp = (command) => command === 'agent' || HOST_COMMANDS.includes(command) || AGENT_COMMANDS.includes(command);

/** Die Meldung zu einem unbekannten Befehl, mit Vorschlag, wenn einer nah genug ist. */
export const unknownCommandText = (command) => {
    const near = closest(command, [...HOST_COMMANDS, ...AGENT_COMMANDS, ...OTHER.filter((name) => !name.startsWith('-'))]);
    return t('cli.unknownCommand', { command, suggestion: near === undefined ? '' : t('cli.didYouMean', { name: near }) });
};

/** Die Kurzform eines Befehls fuer die Zeile unter einem Aufruffehler, undefined ohne eigene Kurzform. */
export const synopsisOf = (command) => {
    const key = `cli.synopsis.${command}`;
    const text = t(key);
    return text === key ? undefined : text;
};
