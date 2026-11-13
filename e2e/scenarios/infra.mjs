// INF…: the harness's own infrastructure, before any scenario relies on it. A compose stack through the sandbox's Docker route,
// the port preflight, the http alias on a non-loopback name, and the packed package started through npx as an MCP server.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { here, verify } from '../harness.mjs';
import { composeStack, httpAlias, installPacked, mcpClient, packTarball, preflightPorts, tarballFiles, waitPortFree } from '../infra.mjs';

const PROBE_PORT = 18099;
const ALIAS_PORT = 18098;
const group = { language: 'en' };
const scenario = (id, title, body, extra = {}) => ({ id, title, group, body, ...extra });

export const scenarios = [
    scenario('INF1', 'Compose stack through the Docker route: up with wait, reachable on 127.0.0.1, preflight, down frees the port', async () => {
        await preflightPorts([PROBE_PORT]);
        const stack = composeStack('probe', join(here, 'stacks/probe/compose.yaml'));
        await stack.up();
        try {
            const direct = await fetch(`http://127.0.0.1:${PROBE_PORT}/`).then((res) => res.status, (error) => error.message);
            verify('the stack answers on 127.0.0.1', direct === 200, String(direct));
            const preflight = await preflightPorts([PROBE_PORT]).then(() => 'free', (error) => error.message);
            verify('the preflight names a taken port', /already in use: 18099/.test(preflight), preflight);
        } finally {
            await stack.down();
        }
        // CAW_E2E_KEEP=1 leaves the stack running on purpose (node e2e/cleanup.mjs removes it).
        if (process.env.CAW_E2E_KEEP !== '1') verify('down frees the port', await waitPortFree(PROBE_PORT));
        const outside = await preflightPorts([8080]).then(() => 'accepted', (error) => error.message);
        verify('ports outside the range are refused', /outside 18000-18999/.test(outside), outside);
    }),
    scenario('INF2', 'http alias: a non-loopback name of this machine forwards to a local port', async () => {
        const { createServer } = await import('node:http');
        const target = createServer((req, res) => res.end('alias ok')).listen(18097, '127.0.0.1');
        const alias = await httpAlias(ALIAS_PORT, 18097);
        try {
            const { hostname } = new URL(alias.url);
            const { isLoopback } = await import('../../src/shared/config.mjs');
            verify('caw does not count the alias as this machine', !isLoopback(hostname), hostname);
            const body = await fetch(`${alias.url}/`).then((res) => res.text(), (error) => error.message);
            verify('the alias forwards', body === 'alias ok', body);
        } finally {
            await alias.close();
            target.close();
        }
    }, { optIn: 'CAW_E2E_LAN' }),
    scenario('INF3', 'Packed package: tarball, install as dev dependency, npx --package starts the MCP server', async () => {
        const tarball = await packTarball();
        const files = await tarballFiles(tarball);
        verify('the tarball has the package.json and the bin', files.includes('package.json') && files.some((file) => file.startsWith('bin/')), `${files.length} files`);
        verify('no tests or e2e in the tarball', !files.some((file) => /^(test|e2e|scripts)\//.test(file)));
        const dir = mkdtempSync(join(tmpdir(), 'caw-e2e-packed-'));
        try {
            const { bins } = await installPacked(dir);
            verify('the install provides a bin', bins.length > 0, bins.join(' '));
            // The stand-in for `npx caw-ai mcp` of an unpublished package; the bin name is whatever the package declares.
            const [bin] = bins.filter((name) => !/\.(cmd|ps1)$/.test(name));
            const client = mcpClient('npx', ['--yes', '--package', tarball, bin, 'mcp'], { cwd: dir });
            try {
                const init = await client.initialize();
                verify('initialize answers with serverInfo', typeof init.serverInfo?.name === 'string', JSON.stringify(init.serverInfo));
                const { tools } = await client.request('tools/list');
                verify('tools/list lists caw tools', tools.some(({ name }) => name === 'caw_doctor'), tools.map(({ name }) => name).join(' '));
            } finally {
                await client.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }),
];
