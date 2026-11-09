// Example app for caw-ai: a small helpdesk with sign-in, dashboard, ticket list, dialog and detail view. No dependencies.
// Start: node server.mjs (port 4173). Data lives in memory; every restart starts from the seed. Account: demo / demo.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4173);
const USERS = { demo: 'demo' };
const LATENCY_MS = 250;
const sessions = new Map();

const CUSTOMERS = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Stark Industries'];
const STATUSES = ['Open', 'In progress', 'Done'];
const PRIORITIES = ['Low', 'Normal', 'High'];
let nextId = 1042;
const tickets = [
    ['VPN drops every few minutes', 'Globex', 'High', 'Open'],
    ['Invoice PDF shows wrong VAT', 'Acme Corp', 'Normal', 'In progress'],
    ['New laptop for onboarding', 'Initech', 'Low', 'Open'],
    ['Password reset mail not arriving', 'Umbrella', 'High', 'In progress'],
    ['Add second monitor', 'Stark Industries', 'Low', 'Done'],
    ['CRM export times out', 'Acme Corp', 'Normal', 'Open'],
].map(([title, customer, priority, status]) => ({ id: nextId++, title, customer, priority, status, description: '' }));

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const CSS = `*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f6f9;color:#1d2330}
button,input,select,textarea{font:inherit}a{color:#2f6fde}
.login{max-width:22rem;margin:12vh auto;padding:2rem;background:#fff;border-radius:10px;box-shadow:0 2px 8px #0001}
.login form,.form{display:grid;gap:.85rem}label{display:grid;gap:.25rem;font-weight:600;font-size:.9rem}
input,select,textarea{padding:.5rem .6rem;border:1px solid #c5cad3;border-radius:6px;background:#fff}
.btn{padding:.5rem 1rem;border:0;border-radius:6px;background:#2f6fde;color:#fff;cursor:pointer;font-weight:600}
.btn:disabled{background:#a9bde6;cursor:not-allowed}.btn.ghost{background:#e8ecf3;color:#1d2330}
header{display:flex;justify-content:space-between;align-items:center;height:52px;padding:0 1.25rem;background:#1d2330;color:#fff}
header b{letter-spacing:.02em}.shell{display:grid;grid-template-columns:200px 1fr;min-height:calc(100vh - 52px)}
nav{background:#fff;border-right:1px solid #e3e6ec;padding:1rem .5rem}nav a{display:block;padding:.5rem .75rem;border-radius:6px;color:#1d2330;text-decoration:none}
nav a[aria-current=page]{background:#e8f0fe;color:#2f6fde;font-weight:600}main{padding:1.5rem 2rem}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}.card{background:#fff;border-radius:10px;padding:1rem 1.25rem;box-shadow:0 1px 3px #0001}
.card strong{display:block;font-size:2rem}.bar{display:flex;gap:.75rem;margin:1rem 0}.bar input{flex:1}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px #0001}
th,td{text-align:left;padding:.6rem .8rem;border-bottom:1px solid #eef0f4}th{font-size:.8rem;text-transform:uppercase;color:#5a6372}
tbody tr{cursor:pointer}tbody tr:hover{background:#f7f9fc}.badge{display:inline-block;padding:.1rem .55rem;border-radius:99px;font-size:.8rem;font-weight:600}
.High{background:#fde2e2;color:#a01818}.Normal{background:#e6eefc;color:#2450a8}.Low{background:#eceff3;color:#4a5260}
.Open{background:#fff2d6;color:#8a5a00}.In.progress,[data-status="In progress"]{background:#e2f0ff;color:#1b5fb8}.Done{background:#dff5e6;color:#17713a}
dialog{border:0;border-radius:12px;padding:1.5rem;width:28rem;box-shadow:0 10px 40px #0003}dialog::backdrop{background:#1d233066}
.actions{display:flex;gap:.5rem;justify-content:flex-end}.toast{position:fixed;right:1.5rem;bottom:1.5rem;background:#1d2330;color:#fff;padding:.75rem 1rem;border-radius:8px;opacity:0;transition:opacity .2s}
.toast.on{opacity:1}[aria-busy=true]{opacity:.5}.detail{background:#fff;border-radius:10px;padding:1.25rem 1.5rem;box-shadow:0 1px 3px #0001;max-width:40rem}
.meta{display:flex;gap:1.5rem;color:#5a6372;margin:.5rem 0 1rem}.row{display:flex;gap:.75rem;align-items:end}[role=alert]{color:#b00020}`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;

const loginPage = (error = '') => page('Sign in · Helpdesk', `<div class="login"><h1>Helpdesk</h1><form method="post" action="/login">
<label>User <input id="user" name="user" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password"></label>
<button class="btn" type="submit" data-testid="login">Sign in</button></form><p role="alert">${esc(error)}</p></div>`);

// The app itself: a small single-page client that talks to the JSON API below.
const APP = `
const $ = (s) => document.querySelector(s);
const api = (path, init) => fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...init }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const badge = (v) => '<span class="badge ' + v + '" data-status="' + v + '">' + v + '</span>';
const toast = (text) => { const t = $('#toast'); t.textContent = text; t.classList.add('on'); clearTimeout(t.timer); t.timer = setTimeout(() => t.classList.remove('on'), 4000); };
const main = $('main');
const busy = async (work) => { main.setAttribute('aria-busy', 'true'); try { return await work(); } finally { main.removeAttribute('aria-busy'); } };
const go = (path) => { history.pushState(null, '', path); render(); };
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });
addEventListener('popstate', render);

async function dashboard() {
  const s = await busy(() => api('/stats'));
  main.innerHTML = '<h1>Dashboard</h1><div class="cards">' + ['Open', 'In progress', 'Done'].map((k) => '<div class="card"><span>' + k + '</span><strong>' + s[k] + '</strong></div>').join('') + '</div>';
}
async function list() {
  main.innerHTML = '<h1>Tickets</h1><div class="bar"><input type="search" aria-label="Search tickets" placeholder="Search tickets" id="q"><button class="btn" id="new">New ticket</button></div><table aria-label="Tickets"><thead><tr><th>#</th><th>Title</th><th>Customer</th><th>Priority</th><th>Status</th></tr></thead><tbody></tbody></table>';
  const fill = async () => {
    const rows = await busy(() => api('/tickets?q=' + encodeURIComponent($('#q').value)));
    $('tbody').innerHTML = rows.map((t) => '<tr data-id="' + t.id + '"><td>' + t.id + '</td><td><a data-link href="/tickets/' + t.id + '">' + esc(t.title) + '</a></td><td>' + esc(t.customer) + '</td><td>' + badge(t.priority) + '</td><td>' + badge(t.status) + '</td></tr>').join('') || '<tr><td colspan="5">No tickets found.</td></tr>';
  };
  let timer; $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(fill, 300); });
  $('tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('a')) go('/tickets/' + tr.dataset.id); });
  $('#new').addEventListener('click', openDialog);
  await fill();
}
async function openDialog() {
  const customers = await api('/customers');
  const d = $('#dialog');
  d.innerHTML = '<form class="form" method="dialog"><h2>New ticket</h2><label>Title <input name="title" required></label><label>Customer <select name="customer" required><option value="">Choose…</option>' + customers.map((c) => '<option>' + esc(c) + '</option>').join('') + '</select></label><label>Priority <select name="priority"><option>Low</option><option selected>Normal</option><option>High</option></select></label><label>Description <textarea name="description" rows="3"></textarea></label><div class="actions"><button type="button" class="btn ghost" value="cancel">Cancel</button><button class="btn" id="create" disabled>Create ticket</button></div></form>';
  const f = d.querySelector('form');
  const check = () => { $('#create').disabled = !(f.title.value.trim() && f.customer.value); };
  f.addEventListener('input', check); f.addEventListener('change', check);
  d.querySelector('[value=cancel]').addEventListener('click', () => d.close());
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#create').disabled = true;
    const t = await api('/tickets', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(f))) });
    d.close();
    toast('Ticket #' + t.id + ' created');
    await list();
  });
  d.showModal();
}
async function detail(id) {
  const t = await busy(() => api('/tickets/' + id));
  main.innerHTML = '<p><a data-link href="/tickets">← All tickets</a></p><div class="detail"><h1>#' + t.id + ' ' + esc(t.title) + '</h1><div class="meta"><span>Customer: ' + esc(t.customer) + '</span><span>Priority: ' + badge(t.priority) + '</span><span>Status: <output id="status">' + badge(t.status) + '</output></span></div><div class="row"><label>Change status <select id="next">' + ['Open', 'In progress', 'Done'].map((s) => '<option' + (s === t.status ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></label><button class="btn" id="save">Save</button></div></div>';
  $('#save').addEventListener('click', async () => {
    const u = await busy(() => api('/tickets/' + id, { method: 'PATCH', body: JSON.stringify({ status: $('#next').value }) }));
    $('#status').innerHTML = badge(u.status);
    toast('Status updated');
  });
}
async function render() {
  const path = location.pathname;
  document.querySelectorAll('nav a').forEach((a) => a.toggleAttribute('aria-current', path === a.getAttribute('href') || (a.getAttribute('href') !== '/' && path.startsWith(a.getAttribute('href')))));
  document.querySelectorAll('nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
  const m = /^\\/tickets\\/(\\d+)$/.exec(path);
  if (m) return detail(m[1]);
  if (path === '/tickets') return list();
  return dashboard();
}
render();
`;

const appPage = (user) => page('Helpdesk', `<header><b>Helpdesk</b><span data-testid="user-menu">${esc(user)} · <a href="/logout" style="color:#9fc3ff">Sign out</a></span></header>
<div class="shell"><nav aria-label="Main"><a data-link href="/">Dashboard</a><a data-link href="/tickets">Tickets</a></nav><main></main></div>
<dialog id="dialog" aria-label="New ticket"></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div><script>${APP}</script>`);

const body = (req) => new Promise((ok) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => ok(raw));
});
const later = (fn) => new Promise((done) => { setTimeout(() => done(fn()), LATENCY_MS); });

createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const sid = /(?:^|; )sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const user = sessions.get(sid);
    const send = (status, text, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(text); };
    const json = (status, data) => send(status, JSON.stringify(data), { 'content-type': 'application/json' });
    if (req.method === 'POST' && url.pathname === '/login') {
        const { user: name, password } = Object.fromEntries(new URLSearchParams(await body(req)));
        if (USERS[name] !== password) return send(401, loginPage('Wrong user or password.'));
        const id = randomUUID();
        sessions.set(id, name);
        return send(303, '', { location: '/', 'set-cookie': `sid=${id}; HttpOnly; SameSite=Lax; Path=/` });
    }
    if (url.pathname === '/logout') { sessions.delete(sid); return send(303, '', { location: '/login' }); }
    if (url.pathname === '/login') return send(200, loginPage());
    if (user === undefined) return url.pathname.startsWith('/api/') ? json(401, { error: 'signed out' }) : send(303, '', { location: '/login' });

    if (url.pathname.startsWith('/api/')) {
        const path = url.pathname.slice(4);
        const one = /^\/tickets\/(\d+)$/.exec(path);
        if (req.method === 'GET' && path === '/stats') return later(() => json(200, Object.fromEntries(STATUSES.map((s) => [s, tickets.filter((t) => t.status === s).length]))));
        if (req.method === 'GET' && path === '/customers') return json(200, CUSTOMERS);
        if (req.method === 'GET' && path === '/tickets') {
            const q = (url.searchParams.get('q') ?? '').toLowerCase();
            return later(() => json(200, tickets.filter((t) => `${t.id} ${t.title} ${t.customer}`.toLowerCase().includes(q)).toReversed()));
        }
        if (req.method === 'POST' && path === '/tickets') {
            const data = JSON.parse(await body(req) || '{}');
            if (!data.title?.trim() || !CUSTOMERS.includes(data.customer)) return json(400, { error: 'title and customer required' });
            const ticket = { id: nextId++, title: data.title.trim().slice(0, 120), customer: data.customer, priority: PRIORITIES.includes(data.priority) ? data.priority : 'Normal', status: 'Open', description: String(data.description ?? '').slice(0, 2000) };
            tickets.push(ticket);
            return later(() => json(201, ticket));
        }
        const ticket = one && tickets.find((t) => t.id === Number(one[1]));
        if (one && !ticket) return json(404, { error: 'not found' });
        if (req.method === 'GET' && ticket) return later(() => json(200, ticket));
        if (req.method === 'PATCH' && ticket) {
            const data = JSON.parse(await body(req) || '{}');
            if (!STATUSES.includes(data.status)) return json(400, { error: 'unknown status' });
            ticket.status = data.status;
            return later(() => json(200, ticket));
        }
        return json(404, { error: 'not found' });
    }
    if (['/', '/tickets'].includes(url.pathname) || /^\/tickets\/\d+$/.test(url.pathname)) return send(200, appPage(user));
    return send(404, page('Not found', '<main><h1>Not found</h1></main>'));
}).listen(PORT, '127.0.0.1', () => console.log(`Helpdesk on http://localhost:${PORT}`));
