// Terminal help: everything at once (caw-ai --help) or one command's block (caw-ai run --help).
// Lives in shared because the agent in the sandbox calls caw-ai help agent too.

import { t } from './i18n.mjs';
import { closest } from './suggest.mjs';
import { colorEnabled, nightPainter } from './color.mjs';
import { ravenBanner } from './raven.mjs';

/** The host commands, in help order. */
export const HOST_COMMANDS = ['skill', 'explore', 'init', 'validate', 'list', 'doctor', 'overlay', 'auth', 'role', 'theme', 'mcp', 'run', 'record', 'fix', 'open'];
/** The agent commands; their help is under caw-ai help agent. */
export const AGENT_COMMANDS = ['task', 'snapshot', 'url', 'click', 'fill', 'type', 'press', 'eval', 'check', 'screenshot', 'goto', 'reload', 'wait-ready', 'console', 'network', 'plan', 'ask-operator', 'remember', 'chat', 'say', 'recording', 'finish', 'advise'];
const OTHER = ['help', '--help', '-h', '--version', '-v'];

/** A command's block; `here` names the environments Claude may work on, if the config knows them. */
const block = (command, here) => t(`cli.help.${command}`, { here: here === undefined || here === '' ? '' : t('cli.help.here', { names: here }) });

/** The raven as banner of the full help: name and long form sit next to it, replacing the intro's first line. */
const banner = (intro) => {
    const paint = nightPainter(colorEnabled());
    const raven = ravenBanner('caw-ai', { bold: (text) => paint.bold(paint.text(text)), dim: paint.muted, frame: paint.frame, beak: paint.beak, eye: paint.text });
    return [...raven, ...intro.split('\n').slice(1)].join('\n');
};

/**
 * The help. Without a command everything for the host, with a command only its block, with `agent` (or an agent command) the
 * agent commands.
 * @param here e.g. "local, dev": the environments with Claude from the config, otherwise undefined
 */
export const helpText = (command, { here } = {}) => {
    if (command === 'agent' || AGENT_COMMANDS.includes(command)) return t('cli.help.agent');
    if (HOST_COMMANDS.includes(command)) return block(command, here);
    return [banner(t('cli.help.intro')), ...HOST_COMMANDS.map((name) => block(name, here)), t('cli.help.version'), '', t('cli.help.footer')].join('\n');
};

/** Does this command have its own block? */
export const hasHelp = (command) => command === 'agent' || HOST_COMMANDS.includes(command) || AGENT_COMMANDS.includes(command);

/** The message for an unknown command, with a suggestion if one is close enough. */
export const unknownCommandText = (command) => {
    const near = closest(command, [...HOST_COMMANDS, ...AGENT_COMMANDS, ...OTHER.filter((name) => !name.startsWith('-'))]);
    return t('cli.unknownCommand', { command, suggestion: near === undefined ? '' : t('cli.didYouMean', { name: near }) });
};

/** A command's synopsis for the line below a usage error; undefined if it has none. */
export const synopsisOf = (command) => {
    const key = `cli.synopsis.${command}`;
    const text = t(key);
    return text === key ? undefined : text;
};
