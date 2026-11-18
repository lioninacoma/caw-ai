// Terminal help: everything at once (caw --help) or one command's block (caw run --help). The agent commands have their own
// page (caw agent --help); it lives in shared because the agent in the sandbox calls it too.

import { t } from './i18n.mjs';
import { closest } from './suggest.mjs';
import { headLine } from './brand.mjs';
import { colorEnabled, termPainter } from './color.mjs';

/** The commands for people, in help order. */
export const HOST_COMMANDS = ['init', 'record', 'run', 'open', 'reproduce', 'list', 'validate', 'doctor', 'role', 'export', 'overlay'];
/** Commands that exist but are not in the human help: the session MCP server and Claude's namespace. */
const HIDDEN_COMMANDS = ['mcp', 'agent'];
/** Claude's commands, under `caw agent`; their help is `caw agent --help`. */
export const AGENT_COMMANDS = ['task', 'snapshot', 'url', 'click', 'dblclick', 'hover', 'drag', 'dialog', 'upload', 'fill', 'type', 'press', 'eval', 'check', 'screenshot', 'goto', 'reload', 'wait-ready', 'console', 'network', 'plan', 'ask-operator', 'remember', 'chat', 'say', 'recording', 'finish', 'advise'];
/** The run plumbing under `caw agent`, not in any help. */
const AGENT_PLUMBING = ['sandbox-run', 'firewall-check', 'mcp'];
const OTHER = ['help', '--help', '-h', '--version', '-v'];

/**
 * Commands that moved before 1.0: the message names where they are now. Claude's commands moved under `caw agent` as a whole.
 * Keys are what was typed at the top level.
 */
const MOVED = {
    explore: 'init --explore-only',
    auth: 'role login',
    'mcp-agent': 'agent mcp',
    'sandbox-run': 'agent sandbox-run',
    'firewall-check': 'agent firewall-check',
    ...Object.fromEntries(AGENT_COMMANDS.map((name) => [name, `agent ${name}`])),
};

/** Commands removed before 1.0: the message says what replaces them. */
const REMOVED = { skill: 'cli.removedSkill' };

/** A command's block; `here` names the environments Claude may work on, if the config knows them. */
const block = (command, here) => t(`cli.help.${command}`, { here: here === undefined || here === '' ? '' : t('cli.help.here', { names: here }) });

/** In a colour terminal the head line replaces the intro's first line; without colour the intro stays as it is. */
const banner = (intro) => {
    if (!colorEnabled()) return intro;
    const paint = termPainter(true);
    return [headLine('caw', { accent: paint.accent, bold: paint.bold, dim: paint.faint }), ...intro.split('\n').slice(1)].join('\n');
};

/** An option line of the overlay extension; its description continues on lines indented to the description column. */
const OVERLAY_OPTION = /^ {6}\[--overlay/;
const CONTINUATION = /^ {41}\S/;

/** A block without the overlay extension's options and remarks, for a project without an overlay block. */
const withoutOverlay = (text) => {
    const kept = [];
    let skipping = false;
    for (const line of text.split('\n')) {
        if (OVERLAY_OPTION.test(line)) {
            skipping = true;
            continue;
        }
        if (skipping && CONTINUATION.test(line)) continue;
        skipping = false;
        kept.push(line);
    }
    return kept.join('\n').replace(t('cli.help.overlayStartClause'), '');
};

/**
 * The help. Without a command everything for people, with a command only its block, with `agent` the agent commands.
 * @param here    e.g. "local, dev": the environments with Claude from the config, otherwise undefined
 * @param overlay the config has an overlay block: the extension's command and options are shown
 */
export const helpText = (command, { here, overlay = false } = {}) => {
    if (command === 'agent') return t('cli.help.agent');
    const shown = (name) => (overlay ? block(name, here) : withoutOverlay(block(name, here)));
    if (HOST_COMMANDS.includes(command)) return shown(command);
    const names = HOST_COMMANDS.filter((name) => overlay || name !== 'overlay');
    return [banner(t('cli.help.intro')), ...names.map(shown), t('cli.help.version'), '', t('cli.help.footer')].join('\n');
};

/** Does this command have its own block? */
export const hasHelp = (command) => command === 'agent' || HOST_COMMANDS.includes(command);

/**
 * The message for an unknown command: where a moved command is now, otherwise a suggestion if one is close enough.
 * @param agent true for `caw agent <command>`: suggestions come from the agent commands
 */
export const unknownCommandText = (command, { agent = false } = {}) => {
    if (!agent && MOVED[command] !== undefined) return t('cli.movedCommand', { command, now: MOVED[command] });
    if (!agent && REMOVED[command] !== undefined) return t(REMOVED[command]);
    const names = agent ? [...AGENT_COMMANDS, ...AGENT_PLUMBING] : [...HOST_COMMANDS, ...HIDDEN_COMMANDS, ...OTHER.filter((name) => !name.startsWith('-'))];
    const near = closest(command ?? '', names);
    return t(agent ? 'cli.unknownAgentCommand' : 'cli.unknownCommand', { command, suggestion: near === undefined ? '' : t('cli.didYouMean', { name: near }) });
};

/** A command's synopsis for the line below a usage error; undefined if it has none. */
export const synopsisOf = (command) => {
    const key = `cli.synopsis.${command}`;
    const text = t(key);
    return text === key ? undefined : text;
};
