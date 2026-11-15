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
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttps } from 'node:https';

import { readCert } from '../frameworks/shared/cert.mjs';
import { totp } from '../../src/shared/totp.mjs';

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
// The IdP address the browser uses: idp.localhost by default, localhost for an IdP on the app's host (another port, A2).
const IDP_PATH = '/realms/caw-e2e/protocol/openid-connect';
const IDP = `http://idp.localhost:18180${IDP_PATH}`;
// The server reaches Keycloak on the loopback address; the browser uses idp.localhost.
const IDP_BACKCHANNEL = 'http://127.0.0.1:18180/realms/caw-e2e/protocol/openid-connect';
const OIDC_CLIENT = { id: 'spa-ci', secret: 'e2e-spa-secret-fictitious' };
// The admin of totp enters a one-time code after the password (fictitious Base32 secret, the same as CAW_ADMIN_TOTP__TOTP).
const APP_TOTP_SECRET = 'KRUGS4ZANFZSAYJAMZQWWZJAONSWG4TF';

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
    // P5: the extra controls (dialogs, hover, drag, popups, responsive nav); on extrafault an unexpected alert after loading and
    // a delete without its confirm. shared: other people write look-alike tickets and the order changes. mpaus: the notes app
    // with a due date in US format.
    extra: { auth: 'form', accounts: FORM_ACCOUNTS, extras: 'ok' },
    extrafault: { auth: 'form', accounts: FORM_ACCOUNTS, extras: 'fault' },
    shared: { auth: 'form', accounts: FORM_ACCOUNTS, shared: true },
    mpaus: { auth: 'form', accounts: FORM_ACCOUNTS, mpa: true, us: true },
    // P9 (M1): the notes app with a CSRF token on every form, a flash message after post/redirect/get and pages of three notes.
    notes: { auth: 'form', accounts: FORM_ACCOUNTS, mpa: true, csrf: true, paged: true },
    // P9 (U5): server-sent events, a WebSocket ticker and a route change that aborts a slow request.
    stream: { auth: 'form', accounts: FORM_ACCOUNTS, live: true },
    // Keycloak users of the realm caw-e2e; the role comes from this table.
    ci: { auth: 'oidc', roles: { 'qa.clerk': 'clerk', 'qa.admin': 'admin' } },
    // P9: a stored session against Keycloak (sso), identifier-first (idfirst, its own client), Keycloak on the app's host
    // (localhost: app on localhost:18080, IdP on localhost:18180) and the app's own one-time code for the admin (totp).
    sso: { auth: 'oidc', roles: { 'qa.clerk': 'clerk', 'qa.admin': 'admin' } },
    idfirst: { auth: 'oidc', client: 'spa-idfirst', roles: { 'qa.clerk': 'clerk', 'qa.admin': 'admin' } },
    localhost: { auth: 'oidc', idp: `http://localhost:18180${IDP_PATH}`, roles: { 'qa.clerk': 'clerk', 'qa.admin': 'admin' } },
    totp: { auth: 'form', accounts: FORM_ACCOUNTS, totp: true },
    // The Keycloak account with a one-time code (OTP credential in the realm).
    otp: { auth: 'oidc', roles: { 'qa.otp': 'clerk' } },
};

const data = new Map();
// Environments whose next search is the cold one; abortive environments whose page aborts its search.
const coldPending = new Set(['cold']);
const aborting = new Set();
const sessions = new Map();
const pendingStates = new Map();
// totp: password checked, code outstanding (cookie pre); the last code each account used.
const codePending = new Map();
const usedCodes = new Map();
const reusedCodes = new Map();

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

const csrfField = (token) => (token === undefined ? '' : `<input type="hidden" name="csrf" value="${token}">`);
const loginPage = (failed, token) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in · Tickets</title></head>
<body class="signed-out"><main><h1>Sign in</h1>${failed ? '<p role="alert">Wrong user name or password.</p>' : ''}
<form method="post" action="/login">${csrfField(token)}<label>User <input id="user" name="user" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button></form></main></body></html>`;

const codePage = (message) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Code · Tickets</title></head>
<body class="signed-out"><main><h1>One-time code</h1>${message === '' ? '' : `<p role="alert">${message}</p>`}
<form method="post" action="/login/code"><label>Code <input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label>
<button type="submit">Verify</button></form></main></body></html>`;

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
/** The extra controls of extra and extrafault (P5). */
const extrasBody = (env) => (env.extras === undefined ? '' : `<section id="extras" aria-label="Extras">
<nav id="nav" aria-label="Main"><button id="menuToggle" type="button">Menu</button><ul id="navList"><li><a id="navTickets" href="#list">Tickets</a></li></ul></nav>
<button id="del" type="button">Delete first</button> <button id="ren" type="button">Rename first</button> <button id="ping" type="button">Ping</button>
<label>Draft <input id="draft"></label>
<div id="actions"><button id="actionsBtn" type="button">Actions</button><div id="actionsList" hidden><button id="archive" type="button">Archive</button></div></div>
<div id="board"><ul id="todo" aria-label="To do"><li id="card1" draggable="true">Card 1</li></ul><ul id="done" aria-label="Done" style="min-height:40px;min-width:120px;border:1px solid #888"></ul></div>
<a id="help" href="/help" target="_blank">Help</a> <button id="report" type="button">Report</button>
</section>
<style>@media (max-width: 700px) { #navList { display: none } #navList.open { display: block } } @media (min-width: 701px) { #menuToggle { display: none } }</style>
<script>
const note = (text) => { document.getElementById('status').textContent = text; };
document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('navList').classList.toggle('open'));
document.getElementById('navTickets').addEventListener('click', () => note('Nav Tickets'));
document.getElementById('del').addEventListener('click', () => note(${env.extras === 'fault'} || confirm('Delete the first ticket?') ? 'Deleted' : 'Kept'));
document.getElementById('ren').addEventListener('click', () => { const title = prompt('New title', 'Ticket'); note(title === null ? 'Not renamed' : 'Renamed to ' + title); });
document.getElementById('ping').addEventListener('click', () => { alert('Pong'); note('Pinged'); });
let dirty = false;
document.getElementById('draft').addEventListener('input', () => { dirty = true; });
addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
const actions = document.getElementById('actions');
actions.addEventListener('mouseenter', () => { document.getElementById('actionsList').hidden = false; });
actions.addEventListener('mouseleave', () => { document.getElementById('actionsList').hidden = true; });
document.getElementById('archive').addEventListener('click', () => note('Archived'));
document.getElementById('card1').addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'card1'));
const done = document.getElementById('done');
done.addEventListener('dragover', (event) => event.preventDefault());
done.addEventListener('drop', (event) => { event.preventDefault(); done.append(document.getElementById(event.dataTransfer.getData('text/plain'))); note('Moved'); });
document.getElementById('report').addEventListener('click', () => window.open('/report'));
if (${env.extras === 'fault'}) setTimeout(() => alert('Maintenance at 22:00'), 300);
</script>`);

/** live: a counter by server-sent events, a ticker by WebSocket, and two views switched by history.pushState. */
const liveBody = (env) => (env.live !== true ? '' : `<section id="live" aria-label="Live"><p>Events <span id="sse">0</span></p><p>Ticker <span id="ticker">-</span></p>
<a id="toDetails" href="/details">Details</a><p id="view">List</p></section>
<script>
const events = new EventSource('/events');
events.onmessage = (event) => { document.getElementById('sse').textContent = event.data; };
const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ticker');
socket.onmessage = (event) => { document.getElementById('ticker').textContent = event.data; };
// The list view loads something slow; leaving the view aborts it, as SPA routers do.
const pending = new AbortController();
fetch('/api/slow', { signal: pending.signal }).catch(() => {});
document.getElementById('toDetails').addEventListener('click', (event) => {
    event.preventDefault();
    pending.abort();
    history.pushState({}, '', '/details');
    document.getElementById('view').textContent = 'Details';
});
</script>`);

const appPage = (user, env) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tickets</title>
<style>body{font-family:sans-serif}dialog::backdrop{background:#0004}</style>${thirdPartyHead(env)}</head>
<body class="signed-in"><header><span id="user-menu">${escape(user.user)}</span> <a href="/logout">Sign out</a></header>
<main><h1>Tickets</h1>${user.role === 'admin' ? '<button id="new">New ticket</button>' : ''}
<button id="gql" type="button">Load via GraphQL</button> <button id="close" type="button">Close first</button> <button id="persisted" type="button">Refresh</button>
<label>Search <input id="q"></label> <button id="search" type="button">Search</button>
<p id="status" role="status"></p><ul id="tickets"></ul></main>${thirdPartyBody(env)}${extrasBody(env)}${liveBody(env)}
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
const PAGE_SIZE = 3;
const notesPage = (notes, status, message = '', us = false, { token, page } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title></head>
<body class="signed-in"><header><span id="user-menu">notes</span></header><main><h1>Notes</h1><p id="message" role="status">${escape(message)}</p>
<form method="post" action="/notes/search">${csrfField(token)}<label>Search <input name="q"></label><button>Search</button></form>
<form method="post" action="/notes">${csrfField(token)}<label>Title <input name="title"></label>${us ? '<label>Due <input name="due" placeholder="MM/DD/YYYY"></label>' : ''}<button>Add note</button></form>
${page === undefined ? `<ul id="notes">${notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>` : pagedList(notes, page)}</main></body></html>`;
/** One page of notes with the total and links to the neighbouring pages. */
const pagedList = (notes, page) => {
    const pages = Math.max(1, Math.ceil(notes.length / PAGE_SIZE));
    const shown = notes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return `<p id="total">${notes.length} notes</p><ul id="notes">${shown.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>
<nav aria-label="Pages">${page > 1 ? `<a href="/notes?page=${page - 1}">Previous</a> ` : ''}<span>Page ${page} of ${pages}</span>${page < pages ? ` <a href="/notes?page=${page + 1}">Next</a>` : ''}</nav>`;
};
const notes = async (req, res, env, url) => {
    const own = store(env);
    if (env.paged && own.notes.length === 0 && !own.seeded) {
        own.notes.push('Seed 4', 'Seed 3', 'Seed 2', 'Seed 1');
        own.seeded = true;
    }
    const token = env.csrf ? cookie(req, 'csrf') : undefined;
    const options = env.paged ? { token, page: Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1) } : { token };
    if (url.pathname === '/' || (url.pathname === '/notes' && req.method === 'GET')) {
        // The flash message of the post before the redirect, shown once.
        const flash = cookie(req, 'flash') === 'added' ? 'Note added' : '';
        return send(res, 200, notesPage(own.notes, 200, flash, env.us === true, options), 'text/html; charset=utf-8', flash === '' ? {} : { 'set-cookie': 'flash=; Path=/; Max-Age=0' });
    }
    const form = new URLSearchParams(await readBody(req));
    if (env.csrf && (form.get('csrf') ?? '') !== (token ?? '-')) return send(res, 403, 'CSRF check failed', 'text/plain');
    if (url.pathname === '/notes/search' && req.method === 'POST') {
        const found = own.notes.filter((note) => note.includes(form.get('q') ?? ''));
        return send(res, 200, notesPage(found, 200, `Found ${found.length}`));
    }
    if (url.pathname === '/notes' && req.method === 'POST') {
        const title = String(form.get('title') ?? '').trim();
        if (title === '') return send(res, 422, notesPage(own.notes, 422, 'Title is required', env.us === true));
        let due = '';
        if (env.us === true) {
            // A US date, today or later (the server's day): 11/23/2026.
            const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(form.get('due') ?? '').trim());
            const date = match === null ? null : new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (date === null || date.getMonth() !== Number(match[1]) - 1) return send(res, 422, notesPage(own.notes, 422, 'Due must be MM/DD/YYYY', true));
            if (date < today) return send(res, 422, notesPage(own.notes, 422, 'Due date is in the past', true));
            due = ` (due ${match[0]})`;
        }
        own.notes.unshift(`${title}${due}`);
        return redirect(res, '/notes', env.paged ? { 'set-cookie': 'flash=added; Path=/; SameSite=Lax' } : {});
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
    // How often this environment refused a code that was already used (A4).
    if (url.pathname === '/test/stats') return send(res, 200, JSON.stringify({ reusedCodes: reusedCodes.get(env.name) ?? 0 }), 'application/json');
    // The app ends every session of this environment, as when a stored session expires (A8).
    if (url.pathname === '/test/revoke' && req.method === 'POST') {
        for (const [sid, session] of sessions) if (session.env === env.name) sessions.delete(sid);
        return send(res, 200, 'revoked', 'text/plain');
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
        if (req.method !== 'POST') {
            if (!env.csrf) return send(res, 200, loginPage(false));
            const token = cookie(req, 'csrf') ?? randomBytes(12).toString('hex');
            return send(res, 200, loginPage(false, token), 'text/html; charset=utf-8', { 'set-cookie': `csrf=${token}; Path=/; HttpOnly; SameSite=Lax` });
        }
        const form = new URLSearchParams(await readBody(req));
        if (env.csrf && (form.get('csrf') ?? '') !== (cookie(req, 'csrf') ?? '-')) return send(res, 403, 'CSRF check failed', 'text/plain');
        const account = env.accounts[form.get('user')];
        if (account === undefined || account[0] !== form.get('password')) return send(res, 200, loginPage(true));
        if (env.totp && account[1] === 'admin') {
            const pre = randomBytes(12).toString('hex');
            codePending.set(pre, { env: env.name, user: form.get('user'), role: account[1] });
            return send(res, 200, codePage(''), 'text/html; charset=utf-8', { 'set-cookie': `pre=${pre}; Path=/; HttpOnly; SameSite=Lax` });
        }
        return signIn(res, env, form.get('user'), account[1]);
    }
    if (url.pathname === '/login/code' && env.totp && req.method === 'POST') {
        const pending = codePending.get(cookie(req, 'pre'));
        if (pending === undefined || pending.env !== env.name) return redirect(res, '/login');
        const code = new URLSearchParams(await readBody(req)).get('code') ?? '';
        // A code is valid once: the same account signing in again within its 30 s window is refused, as real apps do.
        if (code !== totp(APP_TOTP_SECRET)) return send(res, 200, codePage('Wrong code.'));
        if (usedCodes.get(pending.user) === code) {
            reusedCodes.set(env.name, (reusedCodes.get(env.name) ?? 0) + 1);
            return send(res, 200, codePage('This code was already used. Wait for the next one.'));
        }
        usedCodes.set(pending.user, code);
        codePending.delete(cookie(req, 'pre'));
        return signIn(res, env, pending.user, pending.role);
    }
    if (url.pathname === '/login' && env.auth === 'oidc') {
        const state = randomBytes(8).toString('hex');
        pendingStates.set(state, env.name);
        const query = new URLSearchParams({ client_id: env.client ?? OIDC_CLIENT.id, response_type: 'code', scope: 'openid', redirect_uri: `${env.origin}/callback`, state });
        return redirect(res, `${env.idp ?? IDP}/auth?${query}`);
    }
    if (url.pathname === '/callback' && env.auth === 'oidc') {
        const state = url.searchParams.get('state');
        if (pendingStates.get(state) !== env.name) return send(res, 400, 'unknown state', 'text/plain');
        pendingStates.delete(state);
        const body = new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${env.origin}/callback`, client_id: env.client ?? OIDC_CLIENT.id, client_secret: OIDC_CLIENT.secret });
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
    if (env.live && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        let count = 0;
        const timer = setInterval(() => { count += 1; res.write(`data: ${count}\n\n`); }, 300);
        req.on('close', () => clearInterval(timer));
        return undefined;
    }
    if (env.live && url.pathname === '/api/slow') {
        const timer = setTimeout(() => send(res, 200, '{}', 'application/json'), 20000);
        req.on('close', () => clearTimeout(timer));
        return undefined;
    }
    if (env.live && url.pathname === '/details') return send(res, 200, appPage(user, env));
    if (url.pathname === '/api/tickets' && req.method === 'GET' && env.shared) {
        // Someone else works here too: a look-alike without a run tag and one of another run, and the order changes every time.
        const own = store(env);
        for (const title of ['Ticket', `Ticket CAW-${String(1000 + Math.floor(Math.random() * 9000))}`]) {
            own.tickets.push({ id: own.next, title });
            own.next += 1;
        }
        const shuffled = [...own.tickets].sort(() => Math.random() - 0.5);
        return send(res, 200, JSON.stringify(shuffled), 'application/json');
    }
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
    if (url.pathname === '/help' || url.pathname === '/report') {
        const title = url.pathname === '/help' ? 'Help' : 'Report';
        return send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
    }
    return send(res, 404, 'not found', 'text/plain');
};

const ticker = (req, socket) => {
    const env = envOf(req);
    if (env?.live !== true || !req.url.startsWith('/ticker') || userOf(req, env) === null) {
        socket.destroy();
        return;
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let tick = 0;
    const timer = setInterval(() => {
        tick += 1;
        const payload = Buffer.from(`tick ${tick}`);
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    }, 300);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
    // Frames from the browser (pings, close) are not answered: closing the page ends the socket.
    socket.on('data', () => {});
};
createServer(handler).on('upgrade', ticker).listen(PORT, '127.0.0.1');
if (!ONLY) {
    const tls = readCert();
    createHttps(tls, handler).listen(GATE_PORT, '127.0.0.1');
    createHttps(tls, handler).listen(TLS_PORT, '127.0.0.1');
    createServer(handler).listen(PROD_PORT, '127.0.0.1');
    createServer(handler).listen(MPA_PORT, '127.0.0.1');
    createServer(handler).listen(THIRD_PARTY_PORT, '127.0.0.1');
}
