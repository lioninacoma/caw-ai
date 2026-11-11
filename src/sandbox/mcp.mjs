// Small MCP server over stdio (JSON-RPC, one message per line). Locally Claude has no shell: the commands it runs via Bash in
// the container come here as one tool `caw` with the same arguments. They run as in the container, through the file
// channel: this process knows neither the browser nor any credentials.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/caw-ai.mjs', import.meta.url));
const PROTOCOL = '2025-06-18';
const MAX_OUTPUT = 200_000;

/** What the agent may run: exactly the sandbox commands, never the host ones (run, record, init ...). */
export const AGENT_COMMANDS = new Set(['task', 'snapshot', 'url', 'click', 'fill', 'type', 'press', 'eval', 'check', 'screenshot', 'goto', 'reload',
    'wait-ready', 'console', 'network', 'plan', 'ask-operator', 'remember', 'chat', 'say', 'recording', 'finish', 'advise']);
// Commands that read a file. Locally Claude cannot write one, so the content comes in the `file` field.
const FILE_COMMANDS = new Set(['plan', 'finish', 'advise']);

export const TOOL = {
    name: 'caw',
    description: 'Controls the test run\'s browser like `caw-ai <command>` in the sandbox. args are the arguments without caw-ai, '
        + 'e.g. ["snapshot"], ["click", "e12"], ["fill", "e3", "text"], ["check", "S1", "<expression>"]. For plan, finish and advise '
        + 'the file content goes in file (YAML or JSON), without --file.',
    inputSchema: {
        type: 'object',
        properties: {
            args: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Command and arguments, without caw-ai' },
            file: { type: 'string', description: 'File content for plan, finish or advise' },
        },
        required: ['args'],
        additionalProperties: false,
    },
};

/** Validates the call and builds the CLI arguments. Throws with a message for Claude. */
export const commandLine = (input, writeFile) => {
    const args = input?.args;
    if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === 'string')) throw new Error('args must be a list of strings, e.g. ["snapshot"].');
    const [command] = args;
    if (!AGENT_COMMANDS.has(command)) throw new Error(`Unknown command: ${command}. Allowed: ${[...AGENT_COMMANDS].join(', ')}`);
    if (!FILE_COMMANDS.has(command)) {
        if (input.file !== undefined) throw new Error(`${command} takes no file.`);
        return args;
    }
    if (typeof input.file !== 'string' || input.file === '') throw new Error(`${command} needs the content in file.`);
    return [command, '--file', writeFile(input.file)];
};

const runCli = (args, env) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk) => { if (out.length < MAX_OUTPUT) out += chunk; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => resolveRun({ code: 2, out: error.message }));
    child.on('close', (code) => resolveRun({ code: code ?? 2, out }));
});

/** The caw tool as an entry for createMcpHandler. `agentDir` is fixed (local agent) or looked up per call (developer session). */
export const cawTool = ({ agentDir, env = process.env, run = runCli }) => ({
    ...TOOL,
    call: async (input) => {
        const dir = typeof agentDir === 'function' ? agentDir() : agentDir;
        const written = [];
        try {
            const args = commandLine(input, (content) => {
                const file = join(dir, `mcp-${randomBytes(6).toString('hex')}.txt`);
                writeFileSync(file, content, { flag: 'wx' });
                written.push(file);
                return file;
            });
            const { code, out } = await run(args, { ...env, CAW_SANDBOX: '1', CAW_AGENT_DIR: dir });
            return { text: `${out.trim()}${code === 0 ? '' : `
(Exit ${code})`}` || 'ok', isError: code !== 0 && code !== 1 };
        } finally {
            for (const file of written) rmSync(file, { force: true });
        }
    },
});

/**
 * Answers a JSON-RPC message; undefined for notifications.
 * @param tools entries { name, description, inputSchema, call(input) -> { text, isError } }; by default only caw with `agentDir`
 */
export const createMcpHandler = ({ agentDir, env = process.env, run = runCli, tools, name = 'caw' } = {}) => {
    const all = tools ?? [cawTool({ agentDir, env, run })];
    return async (message) => {
        const { id, method, params } = message ?? {};
        const reply = (result) => ({ jsonrpc: '2.0', id, result });
        const failure = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
        if (id === undefined || id === null) return undefined;
        switch (method) {
            case 'initialize':
                return reply({ protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name, version: '1' } });
            case 'ping': return reply({});
            case 'tools/list': return reply({ tools: all.map(({ call: _call, ...definition }) => definition) });
            case 'tools/call': {
                const tool = all.find((candidate) => candidate.name === params?.name);
                if (tool === undefined) return failure(-32602, `Unknown tool: ${params?.name}`);
                try {
                    const { text, isError = false } = await tool.call(params.arguments ?? {});
                    return reply({ content: [{ type: 'text', text }], isError });
                } catch (error) {
                    return reply({ content: [{ type: 'text', text: error.message }], isError: true });
                }
            }
            default: return failure(-32601, `Unknown method: ${method}`);
        }
    };
};

/** Reads messages from stdin, answers on stdout. Runs until Claude closes the connection. */
export const serveMcp = (handler, { input = process.stdin, output = process.stdout } = {}) => new Promise((done) => {
    const lines = createInterface({ input });
    lines.on('line', async (line) => {
        if (line.trim() === '') return;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } })}\n`);
            return;
        }
        const answer = await handler(message);
        if (answer !== undefined) output.write(`${JSON.stringify(answer)}\n`);
    });
    lines.on('close', done);
});
