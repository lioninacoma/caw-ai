// The caw entry in the project's .mcp.json, for init and doctor. Claude Code starts the session server from it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** The name of caw's server in .mcp.json; Claude Code then names its tools mcp__caw__<tool>. */
export const MCP_NAME = 'caw';
/** Without an installed copy: npx, on native Windows through cmd /c (npx is a .cmd there). */
export const npxEntry = (platform = process.platform) => (platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', 'caw-ai', 'mcp'] } : { command: 'npx', args: ['caw-ai', 'mcp'] });
/**
 * The MCP entry for a project folder: node with the installed copy, which needs no npx and no network and keeps the version
 * of the project. In a monorepo caw-ai is often installed in a parent folder (hoisted): the path then points there, relative
 * to the project folder, where Claude Code starts the server. Without an installed copy: npx.
 */
export const mcpEntry = (root, platform = process.platform) => {
    for (let dir = resolve(root); ; dir = dirname(dir)) {
        if (existsSync(join(dir, 'node_modules', 'caw-ai', 'bin', 'caw.mjs'))) {
            const path = relative(root, join(dir, 'node_modules', 'caw-ai', 'bin', 'caw.mjs')).split(sep).join('/');
            return { command: 'node', args: [path, 'mcp'] };
        }
        if (dirname(dir) === dir) return npxEntry(platform);
    }
};
/** An entry that starts caw through npx (as `claude mcp add caw -- npx caw-ai mcp` writes it). */
export const isNpxEntry = (entry) => Array.isArray(entry?.args) && entry.args.includes('caw-ai') && /(^|[\\/])npx(\.cmd)?$|^cmd(\.exe)?$/i.test(String(entry.command ?? ''));
/**
 * The caw entry in .mcp.json: added when missing; an npx entry is pointed at the installed copy once there is one (OPEN-16).
 * @returns 'created' | 'updated' (Claude Code needs a restart) | 'present' | 'invalid' (the file is no JSON object)
 */
export const ensureMcpEntry = (root, platform = process.platform) => {
    const file = join(root, '.mcp.json');
    let mcp = { mcpServers: {} };
    try {
        if (existsSync(file)) mcp = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return 'invalid';
    }
    if (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp)) return 'invalid';
    const current = mcp.mcpServers?.[MCP_NAME];
    const wanted = mcpEntry(root, platform);
    let state = 'created';
    if (current !== undefined) {
        if (!isNpxEntry(current) || wanted.command !== 'node') return 'present';
        state = 'updated';
    }
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), [MCP_NAME]: { ...(current ?? {}), ...wanted } };
    writeFileSync(file, `${JSON.stringify(mcp, null, 2)}\n`);
    return state;
};
