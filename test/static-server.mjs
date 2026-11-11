// A stand-in for a local code server in tests: serves the files of a folder over HTTP, like the Sencha watch serves its workspace.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize, sep } from 'node:path';

/** The file below root for a URL path, or null (outside root, missing, a folder). */
const fileFor = (root, pathname) => {
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(`${normalize(root)}${sep}`)) return null;
    return existsSync(file) && statSync(file).isFile() ? file : null;
};

/**
 * Serves root on 127.0.0.1, on a free port unless one is given. `requests` lists the paths asked for.
 * @returns { url, requests, close() }
 */
export const serveFolder = async (root, { port = 0 } = {}) => {
    const requests = [];
    const server = createServer((request, response) => {
        const { pathname } = new URL(request.url, 'http://x');
        requests.push(pathname);
        const file = fileFor(root, pathname);
        if (file === null) return response.writeHead(404).end();
        return response.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/javascript' }).end(readFileSync(file));
    });
    await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}/`, requests, close: () => new Promise((resolve) => { server.close(resolve); }) };
};

/** A fetch that answers from a folder without a network, for origin; anything else fails like a server that is down. */
export const folderFetch = (root, origin) => async (url) => {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(origin).origin) throw new TypeError('fetch failed');
    const file = fileFor(root, parsed.pathname);
    return file === null ? new Response(null, { status: 404 }) : new Response(readFileSync(file), { status: 200 });
};
