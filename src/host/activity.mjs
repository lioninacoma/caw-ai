// What the agent does, as a short sentence for people: "Read server.mjs", "Searched for "disabled"", "Clicked button "Save"".
// The agent's log names tool calls (Read: {"file_path":…}, Grep: {…}, Bash: …) and caw commands (snapshot, click …); the raw
// call stays available as a tooltip. Consecutive actions of one kind fold into one line with a count ("Read 2 files").

import { t } from '../shared/i18n.mjs';

const MAX_ITEM = 60;
const short = (text) => {
    const value = String(text ?? '').replaceAll(/\s+/g, ' ').trim();
    return value.length > MAX_ITEM ? `${value.slice(0, MAX_ITEM - 1)}…` : value;
};
/** The last two parts of a path: enough to recognise a file, without the machine's folders. */
const fileOf = (path) => short(String(path ?? '').replaceAll('\\\\', '\\').split(/[\\/]+/).filter(Boolean).slice(-2).join('/'));

/** A tool's JSON input, also when the log cut it off: the string fields that are complete or cut. */
const fieldsOf = (json) => {
    try {
        const value = JSON.parse(json);
        if (value !== null && typeof value === 'object') return value;
    } catch {
        // Truncated in the log: read the fields one by one below.
    }
    const fields = {};
    for (const [, key, value] of String(json).matchAll(/"(\w+)":"((?:[^"\\]|\\.)*)/g)) fields[key] = value.replace(/\\(.)/g, '$1');
    return fields;
};

/** Whether a target is a snapshot reference, alone or followed by what is entered. */
const isRef = (item) => new RegExp('^(f[0-9]+)?e[0-9]+( |$)').test(item);

/** caw's own commands, the agent's way of using the page. */
const CAW = {
    task: () => ['task'],
    snapshot: () => ['page'],
    url: () => ['url'],
    screenshot: () => ['screenshot'],
    console: () => ['console'],
    network: () => ['network'],
    reload: () => ['reload'],
    'wait-ready': () => ['wait'],
    eval: () => ['eval'],
    goto: (rest) => ['goto', rest],
    click: (rest) => ['click', rest],
    dblclick: (rest) => ['click', rest],
    hover: (rest) => ['hover', rest],
    drag: (rest) => ['drag', rest],
    fill: (rest) => ['fill', rest.replace(/\s+("[^"]*"|\S+)$/, '')],
    type: (rest) => ['type', rest],
    press: (rest) => ['press', rest],
    upload: (rest) => ['upload', rest],
    dialog: (rest) => ['dialog', rest],
    check: (rest) => ['check', rest],
    remember: (rest) => ['remember', rest],
    recording: () => ['submit'],
    finish: () => ['submit'],
    advise: () => ['advice'],
    'ask-operator': () => ['ask'],
};

/** Tools of the agent itself (Claude Code's names). */
const TOOLS = {
    Read: (input) => ['read', fileOf(input.file_path ?? input.path)],
    Grep: (input) => ['search', short(input.pattern)],
    Glob: (input) => ['find', short(input.pattern)],
    Edit: (input) => ['edit', fileOf(input.file_path)],
    MultiEdit: (input) => ['edit', fileOf(input.file_path)],
    Write: (input) => ['edit', fileOf(input.file_path)],
    NotebookEdit: (input) => ['edit', fileOf(input.notebook_path)],
    Bash: (input) => ['shell', short(input.command)],
    PowerShell: (input) => ['shell', short(input.command)],
    TodoWrite: () => ['todo'],
    Task: (input) => ['agent', short(input.description)],
    Agent: (input) => ['agent', short(input.description)],
    WebFetch: (input) => ['web', short(input.url)],
    WebSearch: (input) => ['web', short(input.query)],
};

/**
 * @param readable the call as the log names it, with caw's MCP prefix already removed (`snapshot`, `Read: {…}`, `Bash: ls`)
 * @returns { group, item, raw }: group is the kind of action (read, search, click …), item what it was about
 */
export const actionOf = (readable) => {
    const raw = String(readable).trim();
    const bash = /^Bash: (.*)$/s.exec(raw);
    const command = bash === null ? raw : bash[1].trim();
    // Several caw commands in one shell call (the container agent chains them): one item naming each.
    const parts = command.split(/\s*(?:;|&&|\|\|)\s*/).filter(Boolean);
    if (bash !== null && parts.length > 1 && parts.every((part) => part.startsWith('caw agent '))) {
        const said = parts.map((part) => actionOf(part)).map(({ group, item }) => actionText(group, [item]));
        return { group: 'batch', item: short(said.join(' · ')), raw };
    }
    // caw agent <command> from the container, or the bare command from the local agent's MCP call.
    const caw = /^(?:caw agent )?([a-z-]+)(?:\s+(.*))?$/s.exec(command);
    if (caw !== null && CAW[caw[1]] !== undefined && (bash === null || command.startsWith('caw agent '))) {
        const [group, item = ''] = CAW[caw[1]](short(caw[2] ?? ''));
        // A snapshot reference (e12) names nothing to a person: "Clicked" instead of "Clicked e12".
        return { group, item: isRef(item) ? '' : short(item), raw };
    }
    if (bash !== null) return { group: 'shell', item: short(command), raw };
    const tool = /^(\w+): (.*)$/s.exec(raw);
    if (tool !== null && TOOLS[tool[1]] !== undefined) {
        const [group, item = ''] = TOOLS[tool[1]](fieldsOf(tool[2]));
        return { group, item, raw };
    }
    const name = /^(\w+)/.exec(raw)?.[1] ?? raw;
    return { group: `tool:${name}`, item: '', raw };
};

/**
 * A command of an attached session as its log line would name it: the session has no log caw could read. Without what it enters.
 * @returns the line, or null for a command that is no action of its own
 */
export const sessionLine = (command) => {
    const name = command?.action === 'dragTo' ? 'drag' : command?.action;
    if (typeof name !== 'string' || !Object.hasOwn(CAW, name)) return null;
    const about = { goto: command.url, press: command.key, remember: command.name, check: command.id, dialog: command.decision, upload: Array.isArray(command.files) ? command.files.join(', ') : undefined }[name] ?? command.target;
    // A value after the target is cut off by the commands that enter one; none is passed on here.
    const item = typeof about !== 'string' ? '' : name === 'fill' ? `${about} ""` : about;
    return `[+0s] > caw agent ${name} ${item.replaceAll(/\s+/g, ' ')}`.trim();
};

/** One action, or several of one group, as a sentence. */
export const actionText = (group, items) => {
    const n = items.length;
    const item = items.at(-1) ?? '';
    if (group.startsWith('tool:')) return n === 1 ? t('chat.activity.tool', { name: group.slice(5) }) : t('chat.activity.toolMany', { name: group.slice(5), n });
    const key = `chat.activity.${group}`;
    if (n === 1) return t(item === '' ? `${key}.plain` : key, { item });
    return t(`${key}.many`, { n });
};

/** Folds actions: the same group as the previous one joins it. @returns { merged: whether it joined, text, items } */
export const foldAction = (previous, action) => {
    if (previous !== null && previous.group === action.group) {
        const items = [...previous.items, action.item];
        return { group: action.group, items, raws: [...previous.raws, action.raw], merged: true, text: actionText(action.group, items) };
    }
    return { group: action.group, items: [action.item], raws: [action.raw], merged: false, text: actionText(action.group, [action.item]) };
};
