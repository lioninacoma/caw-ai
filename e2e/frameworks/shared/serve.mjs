// "Deployter" Stand: gebaute Dateien plus API, wie ein Webserver mit SPA-Fallback. Ueber HTTPS auf einem Namen unter .localhost,
// damit die Umgebung wie eine entfernte aussieht (nicht http://localhost).
//   node serve.mjs <dir> <port> [--http] [--proxy http://127.0.0.1:3000]
// Mit --proxy reicht er alles ausser /api an einen Node-Server weiter (next start, nuxt preview).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer as createHttp, request } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { extname, join, normalize } from 'node:path';

import { handleApi } from './api.mjs';
import { readCert } from './cert.mjs';

const [dir, portText, ...rest] = process.argv.slice(2);
const http = rest.includes('--http');
const proxy = rest.includes('--proxy') ? new URL(rest[rest.indexOf('--proxy') + 1]) : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const forward = (req, res) => {
    const out = request({ hostname: proxy.hostname, port: proxy.port, path: req.url, method: req.method, headers: { ...req.headers, host: `${proxy.hostname}:${proxy.port}` } }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
    });
    out.on('error', () => { res.writeHead(502); res.end('proxy'); });
    req.pipe(out);
};

const handler = async (req, res) => {
    if (await handleApi(req, res)) return;
    if (proxy !== null) return forward(req, res);
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(normalize(dir))) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
        const html = join(file, 'index.html');
        // Ordner mit index.html (vorgerenderte Seiten), sonst SPA-Fallback; Dateien mit Endung bleiben 404.
        if (existsSync(html)) file = html;
        else if (extname(path) === '') file = join(dir, 'index.html');
        else { res.writeHead(404); res.end('404'); return; }
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
};

const server = http ? createHttp(handler) : createHttps(readCert(), handler);
server.listen(Number(portText), '127.0.0.1', () => console.log(`serve ${dir} auf ${portText}${http ? '' : ' (https)'}`));
