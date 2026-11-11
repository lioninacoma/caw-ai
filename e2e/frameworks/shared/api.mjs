// Shared backend of all framework test projects: sign-in by cookie, ticket list, creating with a delay.
// Started on its own (`node api.mjs [port]`) for the dev servers, which forward /api to it; serve.mjs includes it directly.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const USER = 'tester@example.com';
const sessions = new Set();
const tickets = [{ id: 1, title: 'Printer offline' }, { id: 2, title: 'VPN slow' }];
const delay = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
};
const bodyOf = (req) => new Promise((ok) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => { try { ok(JSON.parse(text || '{}')); } catch { ok({}); } });
});
const sid = (req) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

/** true if the request belonged to the API and has been answered. */
export const handleApi = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /api/login') {
        const { email, password } = await bodyOf(req);
        await delay(150);
        if (email !== USER || !password) return send(res, 401, { error: 'sign-in failed' }), true;
        const id = Math.random().toString(36).slice(2);
        sessions.add(id);
        return send(res, 200, { user: USER }, { 'set-cookie': `sid=${id}; Path=/; HttpOnly; SameSite=Lax` }), true;
    }
    if (!sessions.has(sid(req))) return send(res, 401, { error: 'not signed in' }), true;
    if (route === 'GET /api/me') return send(res, 200, { user: USER }), true;
    if (route === 'GET /api/tickets') {
        await delay(300);
        return send(res, 200, tickets), true;
    }
    if (route === 'POST /api/tickets') {
        const { title } = await bodyOf(req);
        await delay(400);
        if (!title) return send(res, 400, { error: 'title missing' }), true;
        const ticket = { id: tickets.length + 1, title };
        tickets.push(ticket);
        return send(res, 201, ticket), true;
    }
    return send(res, 404, { error: 'unknown' }), true;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const port = Number(process.argv[2] ?? 3999);
    createServer(async (req, res) => { if (!await handleApi(req, res)) send(res, 404, { error: 'only /api' }); }).listen(port, '127.0.0.1', () => console.log(`api on ${port}`));
}
