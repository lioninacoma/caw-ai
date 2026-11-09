// Kleiner MCP-Server ueber stdio (JSON-RPC, eine Nachricht je Zeile). Lokal hat Claude keine Shell: Die Befehle, die er im
// Container per Bash ruft, bekommt er hier als ein Tool `caw` mit denselben Argumenten. Ausgefuehrt wird wie im Container,
// ueber den Dateikanal: Dieser Prozess kennt weder Browser noch Zugangsdaten.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/caw-ai.mjs', import.meta.url));
const PROTOCOL = '2025-06-18';
const MAX_OUTPUT = 200_000;

/** Was der Agent darf: genau die Befehle der Sandbox, nie die des Hosts (run, record, init ...). */
export const AGENT_COMMANDS = new Set(['task', 'snapshot', 'url', 'click', 'fill', 'type', 'press', 'eval', 'check', 'screenshot', 'goto', 'reload',
    'wait-ready', 'console', 'network', 'plan', 'ask-operator', 'remember', 'chat', 'say', 'recording', 'finish', 'advise']);
// Befehle, die eine Datei lesen. Lokal kann Claude keine schreiben, der Inhalt kommt im Feld `file`.
const FILE_COMMANDS = new Set(['plan', 'finish', 'advise']);

export const TOOL = {
    name: 'caw',
    description: 'Steuert den Browser des Testlaufs wie `caw-ai <befehl>` in der Sandbox. args sind die Argumente ohne caw-ai, '
        + 'etwa ["snapshot"], ["click", "e12"], ["fill", "e3", "Text"], ["check", "S1", "<ausdruck>"]. Fuer plan, finish und advise '
        + 'steht der Inhalt der Datei in file (YAML bzw. JSON), --file entfaellt.',
    inputSchema: {
        type: 'object',
        properties: {
            args: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Befehl und Argumente, ohne caw-ai' },
            file: { type: 'string', description: 'Inhalt der Datei fuer plan, finish oder advise' },
        },
        required: ['args'],
        additionalProperties: false,
    },
};

/** Prueft den Aufruf und baut die Argumente fuer die CLI. Wirft mit einer Meldung fuer Claude. */
export const commandLine = (input, writeFile) => {
    const args = input?.args;
    if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === 'string')) throw new Error('args muss eine Liste von Texten sein, etwa ["snapshot"].');
    const [command, ...rest] = args;
    if (!AGENT_COMMANDS.has(command)) throw new Error(`Unbekannter Befehl: ${command}. Erlaubt: ${[...AGENT_COMMANDS].join(', ')}`);
    if (!FILE_COMMANDS.has(command)) {
        if (input.file !== undefined) throw new Error(`${command} nimmt kein file.`);
        return args;
    }
    if (typeof input.file !== 'string' || input.file === '') throw new Error(`${command} braucht den Inhalt in file.`);
    return [command, '--file', writeFile(input.file)];
};

const runCli = (args, env) => new Promise((ok) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk) => { if (out.length < MAX_OUTPUT) out += chunk; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => ok({ code: 2, out: error.message }));
    child.on('close', (code) => ok({ code: code ?? 2, out }));
});

/** Das Tool caw als Eintrag fuer createMcpHandler. `agentDir` ist fest (lokaler Agent) oder wird je Aufruf gesucht (eigene Session). */
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
 * Beantwortet eine JSON-RPC-Nachricht; undefined bei Benachrichtigungen.
 * @param tools Eintraege { name, description, inputSchema, call(input) -> { text, isError } }; ohne Angabe nur caw mit `agentDir`
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
            case 'tools/list': return reply({ tools: all.map(({ call, ...definition }) => definition) });
            case 'tools/call': {
                const tool = all.find((candidate) => candidate.name === params?.name);
                if (tool === undefined) return failure(-32602, `Unbekanntes Tool: ${params?.name}`);
                try {
                    const { text, isError = false } = await tool.call(params.arguments ?? {});
                    return reply({ content: [{ type: 'text', text }], isError });
                } catch (error) {
                    return reply({ content: [{ type: 'text', text: error.message }], isError: true });
                }
            }
            default: return failure(-32601, `Unbekannte Methode: ${method}`);
        }
    };
};

/** Liest Nachrichten von stdin, antwortet auf stdout. Laeuft, bis Claude die Verbindung schliesst. */
export const serveMcp = (handler, { input = process.stdin, output = process.stdout } = {}) => new Promise((done) => {
    const lines = createInterface({ input });
    lines.on('line', async (line) => {
        if (line.trim() === '') return;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Kein gültiges JSON.' } })}\n`);
            return;
        }
        const answer = await handler(message);
        if (answer !== undefined) output.write(`${JSON.stringify(answer)}\n`);
    });
    lines.on('close', done);
});
