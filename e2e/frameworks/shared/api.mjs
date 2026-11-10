// Gemeinsames Backend aller Framework-Testprojekte: Anmeldung per Cookie, Ticketliste, Anlegen mit Verzoegerung.
// Allein gestartet (`node api.mjs [port]`) fuer die Dev-Server, die /api dorthin weiterreichen; serve.mjs bindet es direkt ein.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const USER = 'tester@example.com';
const sessions = new Set();
const tickets = [{ nr: 1, title: 'Drucker offline' }, { nr: 2, title: 'VPN langsam' }];
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

/** true, wenn die Anfrage zur API gehoerte und beantwortet ist. */
export const handleApi = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /api/login') {
        const { email, password } = await bodyOf(req);
        await delay(150);
        if (email !== USER || !password) return send(res, 401, { error: 'Anmeldung fehlgeschlagen' }), true;
        const id = Math.random().toString(36).slice(2);
        sessions.add(id);
        return send(res, 200, { user: USER }, { 'set-cookie': `sid=${id}; Path=/; HttpOnly; SameSite=Lax` }), true;
    }
    if (!sessions.has(sid(req))) return send(res, 401, { error: 'nicht angemeldet' }), true;
    if (route === 'GET /api/me') return send(res, 200, { user: USER }), true;
    if (route === 'GET /api/tickets') {
        await delay(300);
        return send(res, 200, tickets), true;
    }
    if (route === 'POST /api/tickets') {
        const { title } = await bodyOf(req);
        await delay(400);
        if (!title) return send(res, 400, { error: 'Titel fehlt' }), true;
        const ticket = { nr: tickets.length + 1, title };
        tickets.push(ticket);
        return send(res, 201, ticket), true;
    }
    return send(res, 404, { error: 'unbekannt' }), true;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const port = Number(process.argv[2] ?? 3999);
    createServer(async (req, res) => { if (!await handleApi(req, res)) send(res, 404, { error: 'nur /api' }); }).listen(port, '127.0.0.1', () => console.log(`api auf ${port}`));
}
