// The "spa" fixture: a small ticket app. One process serves every environment; the host name decides which (app, staging,
// ci, north, south, tp, tpfault over http on the given port, gate and tls over https on 18443 and 18444 with the shared
// self-signed certificate, prod on 18081, the server-rendered notes app mpa and mpa-staging on 18000, and the third-party hosts
// cdn, stats, pay and elsewhere on 18090). Each environment has its own data and its own sign-in: a form, HTTP Basic (gate) or OIDC with the Keycloak
// of e2e/stacks/idp (ci). Accounts are fictitious. Roles: a clerk sees the list, an admin also creates tickets.
//
//   node serve.mjs <port>          (default 18080)
//   node serve.mjs <port> --only   only that port: an environment started by caw's lifecycle (life, dev2; see ctl.mjs)
//
// Test endpoints: POST /test/reset clears this environment's tickets (and re-arms cold), POST /test/abort-on and /test/abort-off
// switch abortive's page between aborting its search request and not, GET /healthz answers ok.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttps } from 'node:https';

import { readCert } from '../frameworks/shared/cert.mjs';

const PORT = Number(process.argv[2] ?? 18080);
const ONLY = process.argv.includes('--only');
// The first search on cold waits this long: longer than the e2e step timeout of 5 s, so the step's retry has to carry it.
const COLD_MS = 20000;
const GATE_PORT = 18443;
const TLS_PORT = 18444;
const PROD_PORT = 18081;
const MPA_PORT = 18000;
const THIRD_PARTY_PORT = 18090;
const thirdParty = (host) => `http://${host}.localhost:${THIRD_PARTY_PORT}`;
const IDP = 'http://idp.localhost:18180/realms/caw-e2e/protocol/openid-connect';
// The server reaches Keycloak on the loopback address; the browser uses idp.localhost.
const IDP_BACKCHANNEL = 'http://127.0.0.1:18180/realms/caw-e2e/protocol/openid-connect';
const OIDC_CLIENT = { id: 'spa-ci', secret: 'e2e-spa-secret-fictitious' };

const FORM_ACCOUNTS = { 'clerk.e2e': ['clerk-pw-e2e', 'clerk'], 'admin.e2e': ['admin-pw-e2e', 'admin'] };
/** Per environment (first label of the host name): how one signs in and with which accounts. */
const ENVIRONMENTS = {
    app: { auth: 'form', accounts: FORM_ACCOUNTS },
    staging: { auth: 'form', accounts: FORM_ACCOUNTS },
    north: { auth: 'form', accounts: FORM_ACCOUNTS },
    // Another tenant with its own accounts: the default ones do not work here.
    south: { auth: 'form', accounts: { 'south.clerk': ['south-pw-e2e', 'clerk'], 'south.admin': ['south-admin-pw-e2e', 'admin'] } },
    tls: { auth: 'form', accounts: FORM_ACCOUNTS },
    gate: { auth: 'basic', accounts: FORM_ACCOUNTS },
    // An HTTP Basic gate in front of the form sign-in (one shared gate account, as in front of a staging system).
    gateform: { auth: 'form', accounts: FORM_ACCOUNTS, gate: ['gate.e2e', 'gate-pw-e2e'] },
    // Reached by a host name that is not *.localhost (the http forwarder of scenario D6 on this machine's name).
    alias: { auth: 'form', accounts: FORM_ACCOUNTS },
    // Pages with third-party content (CDN style and script, analytics beacon, payment iframe, a foreign link and popup, a call to
    // production); on tpfault the CDN script throws.
    tp: { auth: 'form', accounts: FORM_ACCOUNTS, thirdParty: 'ok' },
    tpfault: { auth: 'form', accounts: FORM_ACCOUNTS, thirdParty: 'fault' },
    // A production stack (production: true in the config).
    prod: { auth: 'form', accounts: FORM_ACCOUNTS },
    // The server-rendered notes app: pages and form posts, no script.
    mpa: { auth: 'form', accounts: FORM_ACCOUNTS, mpa: true },
    'mpa-staging': { auth: 'form', accounts: FORM_ACCOUNTS, mpa: true },
    // Started and stopped by caw's lifecycle (P4): life detaches (ctl.mjs up/down), dev2 runs in the foreground.
    life: { auth: 'form', accounts: FORM_ACCOUNTS },
    dev2: { auth: 'form', accounts: FORM_ACCOUNTS },
    // A slow, cold or flaky backend (D3), on the search a step sends: the first search waits COLD_MS; the search is reset by the
    // peer; the page aborts its own search after 1 ms while /test/abort-on is set.
    cold: { auth: 'form', accounts: FORM_ACCOUNTS, cold: true },
    flaky: { auth: 'form', accounts: FORM_ACCOUNTS, flaky: true },
    abortive: { auth: 'form', accounts: FORM_ACCOUNTS, abortive: true },
    // Keycloak users of the realm caw-e2e; the role comes from this table.
    ci: { auth: 'oidc', roles: { 'qa.clerk': 'clerk', 'qa.admin': 'admin' } },
};

const data = new Map();
// Environments whose next search is the cold one; abortive environments whose page aborts its search.
const coldPending = new Set(['cold']);
const aborting = new Set();
const sessions = new Map();
const pendingStates = new Map();

const envOf = (req) => {
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
    const name = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' ? host.split('.')[0] : 'alias';
    if (['cdn', 'stats', 'pay', 'elsewhere'].includes(name)) return { name, external: true };
    return ENVIRONMENTS[name] === undefined ? null : { name, ...ENVIRONMENTS[name], origin: `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}` };
};
const store = (env) => {
    if (!data.has(env.name)) data.set(env.name, { tickets: [], notes: [], next: 1 });
    return data.get(env.name);
};
const readBody = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
});
const cookie = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(req.headers.cookie ?? '')?.[1];
const send = (res, status, body, type = 'text/html; charset=utf-8', headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
};
const redirect = (res, location, headers = {}) => send(res, 302, '', 'text/plain', { location, ...headers });
const escape = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

/** Who is signed in: the session cookie, or for Basic the Authorization header on every request. */
const userOf = (req, env) => {
    if (env.auth === 'basic') {
        const [, encoded] = /^Basic\s+(\S+)$/.exec(req.headers.authorization ?? '') ?? [];
        if (encoded === undefined) return null;
        const [user, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
        const account = env.accounts[user];
        return account !== undefined && account[0] === password ? { user, role: account[1] } : null;
    }
    const session = sessions.get(cookie(req, 'sid'));
    return session !== undefined && session.env === env.name ? session : null;
};
const signIn = (res, env, user, role) => {
    const sid = randomBytes(12).toString('hex');
    sessions.set(sid, { env: env.name, user, role });
    redirect(res, '/', { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
};

const loginPage = (failed) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in · Tickets</title></head>
<body class="signed-out"><main><h1>Sign in</h1>${failed ? '<p role="alert">Wrong user name or password.</p>' : ''}
<form method="post" action="/login"><label>User <input id="user" name="user" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button></form></main></body></html>`;

const thirdPartyHead = (env) => (env.thirdParty === undefined ? '' : `<link rel="stylesheet" href="${thirdParty('cdn')}/css2?family=E2E">
<script src="${thirdParty('cdn')}/lib/widget.js${env.thirdParty === 'fault' ? '?fault=1' : ''}"></script>`);
const thirdPartyBody = (env) => (env.thirdParty === undefined ? '' : `<section id="outside"><a id="away" href="${thirdParty('elsewhere')}/">Elsewhere</a>
<button id="popup" type="button">Popup</button><button id="prodcall" type="button">Call production</button>
<iframe id="pay" title="Payment" src="${thirdParty('pay')}/widget.html"></iframe></section>
<script>
navigator.sendBeacon('${thirdParty('stats')}/collect', 'view');
document.getElementById('popup').addEventListener('click', () => window.open('${thirdParty('elsewhere')}/popup'));
document.getElementById('prodcall').addEventListener('click', () => fetch('http://prod.localhost:${PROD_PORT}/api/tickets').then(() => 'reached', () => 'blocked').then((outcome) => { document.getElementById('status').textContent = 'Production ' + outcome; }));
</script>`);
const appPage = (user, env) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tickets</title>
<style>body{font-family:sans-serif}dialog::backdrop{background:#0004}</style>${thirdPartyHead(env)}</head>
<body class="signed-in"><header><span id="user-menu">${escape(user.user)}</span> <a href="/logout">Sign out</a></header>
<main><h1>Tickets</h1>${user.role === 'admin' ? '<button id="new">New ticket</button>' : ''}
<button id="gql" type="button">Load via GraphQL</button> <button id="close" type="button">Close first</button> <button id="persisted" type="button">Refresh</button>
<label>Search <input id="q"></label> <button id="search" type="button">Search</button>
<p id="status" role="status"></p><ul id="tickets"></ul></main>${thirdPartyBody(env)}
<dialog id="dialog" aria-label="New ticket"><form method="dialog"><label>Title <input id="title" name="title"></label>
<button id="save" value="save">Save</button> <button value="cancel">Cancel</button></form></dialog>
<script>
const list = document.getElementById('tickets');
const load = async () => {
    const tickets = await (await fetch('/api/tickets')).json();
    list.replaceChildren(...tickets.map((ticket) => Object.assign(document.createElement('li'), { textContent: '#' + ticket.id + ' ' + ticket.title })));
    document.body.dataset.loaded = 'true';
};
const dialog = document.getElementById('dialog');
document.getElementById('new')?.addEventListener('click', () => { document.getElementById('title').value = ''; dialog.showModal(); });
dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return;
    const response = await fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: document.getElementById('title').value }) });
    document.getElementById('status').textContent = response.ok ? 'Saved' : 'Not allowed';
    await load();
});
const graphql = (body) => fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
const say = (text) => { document.getElementById('status').textContent = text; };
document.getElementById('gql').addEventListener('click', async () => { const answer = await graphql({ query: 'query Tickets { tickets { id title } }' }); say('Loaded ' + answer.data.tickets.length); });
document.getElementById('close').addEventListener('click', async () => { await graphql({ query: 'mutation CloseTicket($id: ID) { closeTicket(id: $id) { id } }', variables: { id: 1 } }); say('Closed'); });
document.getElementById('persisted').addEventListener('click', async () => { const answer = await graphql({ operationName: 'Tickets', extensions: { persistedQuery: { version: 1, sha256Hash: 'e2e' } } }); say('Loaded ' + answer.data.tickets.length); });
document.getElementById('search').addEventListener('click', async () => {
    const abort = new AbortController();
    if (${aborting.has(env.name)}) setTimeout(() => abort.abort(), 1);
    const found = await (await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: document.getElementById('q').value }), signal: abort.signal })).json();
    say('Found ' + found.length);
});
load();
</script></body></html>`;

/** The third-party hosts: a CDN (style, script that throws with ?fault=1), analytics, a payment widget and a foreign site. */
const external = (req, res, env, url) => {
    if (env.name === 'cdn' && url.pathname === '/css2') return send(res, 200, 'body{font-family:E2E,sans-serif}', 'text/css');
    if (env.name === 'cdn' && url.pathname === '/lib/widget.js') {
        return send(res, 200, url.searchParams.get('fault') === '1' ? 'window.widgetLoaded = true; throw new Error("widget fault (third-party)");' : 'window.widgetLoaded = true;', 'text/javascript');
    }
    if (env.name === 'stats' && url.pathname === '/collect') return send(res, 204, '', 'text/plain', { 'access-control-allow-origin': '*' });
    if (env.name === 'pay' && url.pathname === '/widget.html') return send(res, 200, '<!doctype html><p id="pay">Pay with E2E</p>');
    if (env.name === 'elsewhere') return send(res, 200, '<!doctype html><h1 id="elsewhere">Elsewhere</h1>');
    return send(res, 404, 'not found', 'text/plain');
};

/** The notes app of mpa and mpa-staging: server-rendered list, a search form (POST, only reads) and a create form. */
const notesPage = (notes, status, message = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title></head>
<body class="signed-in"><header><span id="user-menu">notes</span></header><main><h1>Notes</h1><p id="message" role="status">${escape(message)}</p>
<form method="post" action="/notes/search"><label>Search <input name="q"></label><button>Search</button></form>
<form method="post" action="/notes"><label>Title <input name="title"></label><button>Add note</button></form>
<ul id="notes">${notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul></main></body></html>`;
const notes = async (req, res, env, url) => {
    const own = store(env);
    if (url.pathname === '/' || (url.pathname === '/notes' && req.method === 'GET')) return send(res, 200, notesPage(own.notes, 200));
    const form = new URLSearchParams(await readBody(req));
    if (url.pathname === '/notes/search' && req.method === 'POST') {
        const found = own.notes.filter((note) => note.includes(form.get('q') ?? ''));
        return send(res, 200, notesPage(found, 200, `Found ${found.length}`));
    }
    if (url.pathname === '/notes' && req.method === 'POST') {
        const title = String(form.get('title') ?? '').trim();
        if (title === '') return send(res, 422, notesPage(own.notes, 422, 'Title is required'));
        own.notes.unshift(title);
        return redirect(res, '/notes');
    }
    return send(res, 404, 'not found', 'text/plain');
};

const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    const env = envOf(req);
    if (env === null) return send(res, 404, `unknown environment ${escape(req.headers.host)}`, 'text/plain');
    if (env.external) return external(req, res, env, url);
    // The gate in front of the whole environment: its own account on every request, before the app's sign-in.
    if (env.gate !== undefined) {
        const [, encoded] = /^Basic\s+(\S+)$/.exec(req.headers.authorization ?? '') ?? [];
        if (encoded === undefined || Buffer.from(encoded, 'base64').toString('utf8') !== env.gate.join(':')) {
            return send(res, 401, 'Gate', 'text/plain', { 'www-authenticate': 'Basic realm="gate"' });
        }
    }
    if (url.pathname === '/test/reset' && req.method === 'POST') {
        data.delete(env.name);
        if (env.cold) coldPending.add(env.name);
        return send(res, 200, 'reset', 'text/plain');
    }
    if (url.pathname === '/test/abort-on' || url.pathname === '/test/abort-off') {
        if (url.pathname.endsWith('on')) aborting.add(env.name);
        else aborting.delete(env.name);
        return send(res, 200, 'ok', 'text/plain');
    }
    if (env.auth === 'basic' && userOf(req, env) === null) {
        return send(res, 401, 'Sign in required', 'text/plain', { 'www-authenticate': 'Basic realm="tickets"' });
    }
    if (url.pathname === '/login' && env.auth === 'form') {
        if (req.method !== 'POST') return send(res, 200, loginPage(false));
        const form = new URLSearchParams(await readBody(req));
        const account = env.accounts[form.get('user')];
        if (account === undefined || account[0] !== form.get('password')) return send(res, 200, loginPage(true));
        return signIn(res, env, form.get('user'), account[1]);
    }
    if (url.pathname === '/login' && env.auth === 'oidc') {
        const state = randomBytes(8).toString('hex');
        pendingStates.set(state, env.name);
        const query = new URLSearchParams({ client_id: OIDC_CLIENT.id, response_type: 'code', scope: 'openid', redirect_uri: `${env.origin}/callback`, state });
        return redirect(res, `${IDP}/auth?${query}`);
    }
    if (url.pathname === '/callback' && env.auth === 'oidc') {
        const state = url.searchParams.get('state');
        if (pendingStates.get(state) !== env.name) return send(res, 400, 'unknown state', 'text/plain');
        pendingStates.delete(state);
        const body = new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${env.origin}/callback`, client_id: OIDC_CLIENT.id, client_secret: OIDC_CLIENT.secret });
        const answer = await fetch(`${IDP_BACKCHANNEL}/token`, { method: 'POST', body }).then((response) => response.json()).catch(() => ({}));
        if (typeof answer.id_token !== 'string') return send(res, 502, 'token exchange failed', 'text/plain');
        const claims = JSON.parse(Buffer.from(answer.id_token.split('.')[1], 'base64url').toString('utf8'));
        const role = env.roles[claims.preferred_username];
        if (role === undefined) return send(res, 403, 'no role for this account', 'text/plain');
        return signIn(res, env, claims.preferred_username, role);
    }
    if (url.pathname === '/logout') {
        sessions.delete(cookie(req, 'sid'));
        return redirect(res, '/', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    const user = userOf(req, env);
    if (user === null) return url.pathname.startsWith('/api/') ? send(res, 401, '{}', 'application/json') : redirect(res, '/login');
    if (env.mpa) return notes(req, res, env, url);
    if (url.pathname === '/api/tickets' && req.method === 'GET') return send(res, 200, JSON.stringify(store(env).tickets), 'application/json');
    if (url.pathname === '/api/search' && req.method === 'POST' && env.flaky) {
        // reset_peer: the connection drops without an answer.
        req.socket.destroy();
        return undefined;
    }
    if (url.pathname === '/api/search' && req.method === 'POST' && coldPending.delete(env.name)) await new Promise((resolve) => { setTimeout(resolve, COLD_MS); });
    if (url.pathname === '/api/search' && req.method === 'POST') {
        const { q } = JSON.parse(await readBody(req) || '{}');
        return send(res, 200, JSON.stringify(store(env).tickets.filter((ticket) => ticket.title.includes(String(q ?? '')))), 'application/json');
    }
    if (url.pathname === '/graphql' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const one = (entry) => {
            if (/\bmutation\b/.test(String(entry.query ?? ''))) {
                const ticket = store(env).tickets.find(({ closed }) => !closed);
                if (ticket !== undefined) ticket.closed = true;
                return { data: { closeTicket: ticket === undefined ? null : { id: ticket.id } } };
            }
            return { data: { tickets: store(env).tickets.map(({ id, title }) => ({ id, title })) } };
        };
        return send(res, 200, JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), 'application/json');
    }
    if (url.pathname === '/api/tickets' && req.method === 'POST') {
        if (user.role !== 'admin') return send(res, 403, '{"error":"admins only"}', 'application/json');
        const { title } = JSON.parse(await readBody(req) || '{}');
        const own = store(env);
        const ticket = { id: own.next, title: String(title ?? '').slice(0, 200) };
        own.next += 1;
        own.tickets.unshift(ticket);
        return send(res, 201, JSON.stringify(ticket), 'application/json');
    }
    if (url.pathname === '/') return send(res, 200, appPage(user, env));
    return send(res, 404, 'not found', 'text/plain');
};

createServer(handler).listen(PORT, '127.0.0.1');
if (!ONLY) {
    const tls = readCert();
    createHttps(tls, handler).listen(GATE_PORT, '127.0.0.1');
    createHttps(tls, handler).listen(TLS_PORT, '127.0.0.1');
    createServer(handler).listen(PROD_PORT, '127.0.0.1');
    createServer(handler).listen(MPA_PORT, '127.0.0.1');
    createServer(handler).listen(THIRD_PARTY_PORT, '127.0.0.1');
}
