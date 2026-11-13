// The fixture site of the native e2e with real URLs (frames are pages of their own, never srcdoc). Plain HTTP: Chrome cancels a
// download from a page with a certificate error once the page has been open for a few seconds, even with ignoreHTTPSErrors.
//   node serve.mjs <port>
// /api/errands keeps added errands; /api/slow?ms=N answers after N ms (a request wait-ready has to wait for); /report.csv is a download;
// /api/cover switches the message box of ext.html. ext-data.html (N10b, N10c) and aria.html (N10d, N10e)
// need nothing from the server.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), 'site');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.argv[2] ?? 8451);
// The errands added in this server's lifetime (GET and POST /api/errands): they outlive a run, as in a real application.
const errands = [];
let cover = false;

createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/errands') {
        if (req.method === 'POST') errands.push(url.searchParams.get('text') ?? '');
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(errands));
        return;
    }
    // N10: whether ext.html shows a message box over everything; POST ?on=1 or ?on=0 switches it.
    if (url.pathname === '/api/cover') {
        if (req.method === 'POST') cover = url.searchParams.get('on') === '1';
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ on: cover }));
        return;
    }
    if (url.pathname === '/api/slow') {
        setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ value: 'loaded' }));
        }, Math.min(Number(url.searchParams.get('ms') ?? 500), 10_000));
        return;
    }
    const file = normalize(join(site, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(site) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('404');
        return;
    }
    const download = extname(file) === '.csv' ? { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' } : { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
    res.writeHead(200, { ...download, 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`native site on ${port}`));
