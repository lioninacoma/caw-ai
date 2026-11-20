// The spike's todo app (derived from examples/errand/server.mjs): one process serves two environments by host name, plus a
// third-party host. a.localhost is the recording environment (empty list, no third-party script); b.localhost is a shared
// environment (foreign rows from other users, a third-party widget, twice the latency); cdn.localhost serves the widget.
// Not shipped: it exists to produce realistic noise and injected regressions for the baseline-learning spike.
//
//   node e2e/spike/app.mjs [port]      (default 18320)
//
// Test endpoints per environment (no sign-in needed):
//   POST /test/profile  JSON {seed, latency{base,jitter,spikeP,spikeMs,creepPct}, foreignRows{p,n}, flicker{p},
//                       thirdPartyError{p}, regression, reset}: replaces the noise profile and reseeds the random generator.
//                       `reset: true` clears the list first; foreign rows are added now with probability foreignRows.p.
//   GET  /test/rows     the titles of every row: the oracle for the spike's view filter V (methods.mjs rowlessView).
//   GET  /healthz       ok
// Account: demo / demo (fictitious).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const SPIKE_PORT = 18320;
export const REGRESSIONS = ['control-disabled', 'control-removed', 'console-error', 'request-missing', 'response-shape', 'view-text', 'slow4x', 'app500', 'gateway503', 'reset'];
/** Which side an injected fault belongs to: the ground truth of the diagnosis confusion matrix. */
export const REGRESSION_SIDE = {
    'control-disabled': 'app', 'control-removed': 'app', 'console-error': 'app', 'request-missing': 'app', 'response-shape': 'app', 'view-text': 'app', app500: 'app',
    slow4x: 'environment', gateway503: 'environment', reset: 'environment',
};
/** The step of the spike test where each fault shows (project.mjs); null: everywhere (slow4x slows every request). */
export const REGRESSION_STEP = {
    'control-disabled': 'S1', 'control-removed': 'S1', 'request-missing': 'S1', 'console-error': 'S3',
    'response-shape': 'S4', 'view-text': 'S4', app500: 'S4', gateway503: 'S4', reset: 'S4', slow4x: null,
};
const ENVIRONMENTS = {
    a: { latencyFactor: 1, thirdParty: false },
    b: { latencyFactor: 2, thirdParty: true },
};
const USERS = { demo: 'demo' };
const TAGS = ['work', 'home', 'vibes'];
const WHEN = ['Today', 'Tomorrow', 'Someday'];
// Foreign rows are titles other people on a shared environment create; they change what the list shows from run to run.
const FOREIGN = ['Call the plumber', 'Return library books', 'Plan the offsite', 'Buy oat milk', 'Fix the bike light', 'Renew the passport',
    'Sort the receipts', 'Water the ferns', 'Draft the newsletter', 'Clean the gutters', 'Order printer ink', 'Prune the roses'];
// The list shows the newest rows only: older titles drop out as the list grows, as in real paged lists.
const LIST_LIMIT = 8;

export const DEFAULT_PROFILE = Object.freeze({
    seed: 1,
    latency: { base: 120, jitter: 80, spikeP: 0, spikeMs: 0, creepPct: 0 },
    foreignRows: { p: 0, n: 0 },
    flicker: { p: 0 },
    thirdPartyError: { p: 0 },
    regression: null,
});

/** A small seeded generator (mulberry32): the same profile seed gives the same noise. */
export const seeded = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const CSS = `body{margin:0;font:15px/1.45 system-ui,sans-serif;background:#f5ede0;color:#231c17}.app{max-width:30rem;margin:0 auto;padding:1rem}
.bar{display:flex;gap:.5rem;margin:1rem 0}.bar input{flex:1}ul{list-style:none;margin:0;padding:0;display:grid;gap:.4rem}
li{display:flex;gap:.6rem;align-items:center;padding:.5rem;background:#fffaf2;border-radius:.6rem}li.done .title{text-decoration:line-through}
.check{width:1.4rem;height:1.4rem;border-radius:50%;border:2px solid #231c17;background:none}li.done .check{background:#e5533a}
.toast{position:fixed;left:50%;bottom:1rem;translate:-50% 0;padding:.4rem .8rem;border-radius:999px;background:#231c17;color:#f5ede0;opacity:0}
.toast.on{opacity:1}.sync{padding:.3rem .6rem;background:#f9ecc8;border-radius:.5rem;margin-bottom:.5rem}
#widget{position:fixed;right:1rem;bottom:1rem}`;
const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<title>${title}</title><style>${CSS}</style>${head}</head><body>${body}</body></html>`;

const loginPage = (error = '') => page('Sign in · Errand', `<div class="app"><h1>Errand</h1><form method="post" action="/login">
<label>User <input id="user" name="user" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password"></label>
<button type="submit" data-testid="login">Sign in</button></form><p role="alert">${esc(error)}</p></div>`);

// The client. `R` is the injected regression (or null), decided by the server per page load.
const client = (regression) => `
const R = ${JSON.stringify(regression)};
const $ = (s) => document.querySelector(s);
let sync = false;
const api = (path, init) => fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...init }).then((r) => {
  if (path.startsWith('/todos?')) sync = r.headers.get('x-sync') === '1';
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
});
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const main = $('main');
const go = (path) => { history.pushState(null, '', path); render(); };
const toast = (text) => { const t = $('#toast'); t.textContent = text; t.classList.add('on'); clearTimeout(t.timer); t.timer = setTimeout(() => t.classList.remove('on'), 2500); };
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });
addEventListener('popstate', render);
let todos = [];
async function list() {
  main.innerHTML = '<h1>Errand</h1><p>Progress <span id="progress">0/0</span></p><div id="sync"></div>'
    + '<div class="bar"><input type="search" id="q" aria-label="Search todos" placeholder="Search todos" autocomplete="off"><button id="new" aria-label="New todo">+</button></div>'
    + '<ul id="list" aria-label="Todos"></ul>';
  const fill = async () => { todos = await api('/todos?q=' + encodeURIComponent($('#q').value)); draw(); };
  let timer; $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(fill, 300); });
  $('#new').addEventListener('click', openDialog);
  $('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('.check'); if (!b) return;
    const id = Number(b.closest('li').dataset.id), t = todos.find((x) => x.id === id);
    Object.assign(t, await api('/todos/' + id, { method: 'PATCH', body: JSON.stringify({ done: !t.done }) }));
    draw();
    if (R === 'console-error') console.error('Progress sync failed for todo ' + id);
    if (t.done) toast('Nice.');
  });
  await fill();
}
function draw() {
  const done = todos.filter((t) => t.done).length;
  $('#progress').textContent = done + '/' + todos.length;
  // Flicker: a sync notice with its own control comes and goes with the server's mood.
  $('#sync').innerHTML = sync ? '<aside class="sync" aria-label="Sync status">Syncing… <button id="dismiss">Dismiss</button></aside>' : '';
  $('#list').innerHTML = todos.length ? todos.map((t) => '<li data-id="' + t.id + '" class="' + (t.done ? 'done' : '') + '"><button class="check" aria-label="' + (t.done ? 'Reopen ' : 'Complete ') + esc(t.title) + '" aria-pressed="' + t.done + '"></button><a class="title" data-link href="/todos/' + t.id + '">' + esc(t.title) + '</a><span class="when">' + t.when + '</span><span class="chip">#' + t.tag + '</span></li>').join('')
    : '<p class="empty">All clear.</p>';
}
function openDialog() {
  const d = $('#dialog');
  const when = '<label>When <select name="when"' + (R === 'control-disabled' ? ' disabled' : '') + '>' + ${JSON.stringify(WHEN)}.map((w) => '<option>' + w + '</option>').join('') + '</select></label>';
  const cancel = R === 'control-removed' ? '' : '<button type="button" value="cancel">Cancel</button>';
  d.innerHTML = '<form method="dialog"><h2>New todo</h2><label>Title <input name="title" required autocomplete="off"></label><label>Tag <select name="tag"><option value="">Choose…</option>' + ${JSON.stringify(TAGS)}.map((t) => '<option value="' + t + '">#' + t + '</option>').join('') + '</select></label>' + when + '<div>' + cancel + '<button id="create" disabled>Add todo</button></div></form>';
  const f = d.querySelector('form');
  const check = () => { $('#create').disabled = !(f.title.value.trim() && f.tag.value); };
  f.addEventListener('input', check); f.addEventListener('change', check);
  d.querySelector('[value=cancel]')?.addEventListener('click', () => d.close());
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#create').disabled = true;
    const t = await api('/todos', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(f))) });
    // The app's own activity log: a second write per new todo, the one request-missing drops.
    if (R !== 'request-missing') await api('/activity', { method: 'POST', body: JSON.stringify({ todo: t.id, what: 'created' }) });
    d.close();
    toast('Added #' + t.id);
    todos.unshift(t);
    draw();
  });
  d.showModal();
}
async function detail(id) {
  const t = await api('/todos/' + id);
  const state = t.done ? 'Done' : R === 'view-text' ? 'Pending' : 'Open';
  main.innerHTML = '<a class="back" data-link href="/">← All todos</a><h2>#' + t.id + ' ' + esc(t.title) + '</h2><p>#' + t.tag + ' · ' + state + ' · When: <output id="when">' + t.when + '</output></p>'
    + '<label>Move to <select id="next">' + ${JSON.stringify(WHEN)}.map((w) => '<option' + (w === t.when ? ' selected' : '') + '>' + w + '</option>').join('') + '</select></label><button id="save">Save</button>';
  $('#save').addEventListener('click', async () => {
    // A failed save is caught and shown, as a well-behaved app does: the request outcome is the evidence, not a script error.
    try {
      const u = await api('/todos/' + id, { method: 'PATCH', body: JSON.stringify({ when: $('#next').value }) });
      $('#when').textContent = u.when;
      toast('Moved to ' + u.when);
    } catch {
      toast('Could not save');
    }
  });
}
async function render() {
  const m = /^\\/todos\\/(\\d+)$/.exec(location.pathname);
  if (m) return detail(m[1]);
  return list();
}
render();
`;

// The third-party widget: a visible chat button, and sometimes a console error and an uncaught error of its own.
const widget = (failing) => `(() => {
  const box = document.createElement('div'); box.id = 'widget'; box.innerHTML = '<button aria-label="Chat with us">Chat</button>';
  document.body.appendChild(box);
  ${failing ? "console.error('widget: quota exceeded'); setTimeout(() => { throw new Error('widget failed to connect'); }, 50);" : ''}
})();`;

const body = (req) => new Promise((ok) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => ok(raw));
});

const freshEnvironment = (name) => ({ name, ...ENVIRONMENTS[name], todos: [], nextId: 1041, sessions: new Map(), profile: structuredClone(DEFAULT_PROFILE), random: seeded(1) });

/** Merges a posted profile onto the defaults; unknown regressions are refused, so a typo cannot pass as a healthy run. */
export const profileOf = (posted = {}) => {
    const profile = structuredClone(DEFAULT_PROFILE);
    for (const key of ['latency', 'foreignRows', 'flicker', 'thirdPartyError']) profile[key] = { ...profile[key], ...(posted[key] ?? {}) };
    if (posted.seed !== undefined) profile.seed = Number(posted.seed);
    if (posted.regression !== undefined && posted.regression !== null && !REGRESSIONS.includes(posted.regression)) throw new Error(`unknown regression ${posted.regression}`);
    profile.regression = posted.regression ?? null;
    return profile;
};

/**
 * Starts the app. Returns { port, close }. Port 0 picks a free port (unit tests).
 */
export const startApp = ({ port = SPIKE_PORT } = {}) => {
    const environments = Object.fromEntries(Object.keys(ENVIRONMENTS).map((name) => [name, freshEnvironment(name)]));
    const delayOf = (env) => {
        const { base, jitter, spikeP, spikeMs, creepPct } = env.profile.latency;
        const spike = env.random() < spikeP ? spikeMs : 0;
        const slow = env.profile.regression === 'slow4x' ? 4 : 1;
        return (base + env.random() * jitter + spike) * env.latencyFactor * slow * (1 + creepPct / 100);
    };
    const later = (env, fn) => new Promise((done) => { setTimeout(() => done(fn()), delayOf(env)); });
    const addTodo = (env, title, tag, when) => {
        const todo = { id: env.nextId++, title, tag, when, done: false, created: new Date().toISOString() };
        env.todos.push(todo);
        return todo;
    };
    const applyProfile = (env, posted) => {
        env.profile = profileOf(posted);
        env.random = seeded(env.profile.seed);
        if (posted.reset === true) env.todos = [];
        if (env.random() < env.profile.foreignRows.p) {
            for (let index = 0; index < env.profile.foreignRows.n; index += 1) {
                addTodo(env, FOREIGN[Math.floor(env.random() * FOREIGN.length)], TAGS[Math.floor(env.random() * TAGS.length)], WHEN[Math.floor(env.random() * WHEN.length)]);
            }
        }
    };
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
        const label = host.split('.')[0];
        const send = (status, text, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(text); };
        const json = (status, data, headers = {}) => send(status, JSON.stringify(data), { 'content-type': 'application/json', ...headers });
        if (label === 'cdn') {
            if (url.pathname === '/widget.js') return send(200, widget(url.searchParams.get('e') === '1'), { 'content-type': 'text/javascript' });
            return send(404, 'not found', { 'content-type': 'text/plain' });
        }
        const env = environments[label];
        if (env === undefined) return send(404, 'unknown environment', { 'content-type': 'text/plain' });
        if (url.pathname === '/healthz') return send(200, 'ok', { 'content-type': 'text/plain' });
        if (req.method === 'POST' && url.pathname === '/test/profile') {
            try {
                applyProfile(env, JSON.parse(await body(req) || '{}'));
            } catch (error) {
                return json(400, { error: String(error.message) });
            }
            return json(200, { profile: env.profile, rows: env.todos.length });
        }
        // Titles only: they are what changes from run to run. Tags and "when" are a fixed vocabulary that also appears outside
        // the list (the detail page), where dropping it would hide a real change.
        if (url.pathname === '/test/rows') return json(200, [...new Set(env.todos.map(({ title }) => title))]);

        const sid = /(?:^|; )sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
        const user = env.sessions.get(sid);
        if (req.method === 'POST' && url.pathname === '/login') {
            const { user: name, password } = Object.fromEntries(new URLSearchParams(await body(req)));
            if (USERS[name] === undefined || USERS[name] !== password) return send(401, loginPage('Wrong user or password.'));
            const id = randomUUID();
            env.sessions.set(id, name);
            return send(303, '', { location: '/', 'set-cookie': `sid=${id}; HttpOnly; SameSite=Lax; Path=/` });
        }
        if (url.pathname === '/logout') { env.sessions.delete(sid); return send(303, '', { location: '/login' }); }
        if (url.pathname === '/login') return send(200, loginPage());
        if (user === undefined) return url.pathname.startsWith('/api/') ? json(401, { error: 'signed out' }) : send(303, '', { location: '/login' });

        const { regression } = env.profile;
        if (url.pathname.startsWith('/api/')) {
            const path = url.pathname.slice(4);
            if (req.method === 'GET' && path === '/todos') {
                const q = (url.searchParams.get('q') ?? '').toLowerCase();
                const flicker = env.random() < env.profile.flicker.p ? '1' : '0';
                return later(env, () => json(200, env.todos.filter((t) => t.title.toLowerCase().includes(q)).toReversed().slice(0, LIST_LIMIT), { 'x-sync': flicker }));
            }
            if (req.method === 'POST' && path === '/todos') {
                const data = JSON.parse(await body(req) || '{}');
                if (!data.title?.trim() || !TAGS.includes(data.tag)) return json(400, { error: 'title and tag required' });
                const todo = addTodo(env, data.title.trim().slice(0, 120), data.tag, WHEN.includes(data.when) ? data.when : 'Today');
                return later(env, () => json(201, todo));
            }
            if (req.method === 'POST' && path === '/activity') {
                await body(req);
                return later(env, () => json(201, { ok: true }));
            }
            const one = /^\/todos\/(\d+)$/.exec(path);
            const todo = one && env.todos.find((t) => t.id === Number(one[1]));
            if (one && !todo) return json(404, { error: 'not found' });
            if (req.method === 'GET' && todo) {
                // response-shape: a field renamed in the API, which the UI does not read: only the response's shape tells.
                const shaped = regression === 'response-shape' ? (({ created, ...rest }) => ({ ...rest, createdAt: created }))(todo) : todo;
                return later(env, () => json(200, shaped));
            }
            if (req.method === 'PATCH' && todo) {
                const data = JSON.parse(await body(req) || '{}');
                if ('when' in data) {
                    // The save of the detail page is where the server-side faults hit.
                    if (regression === 'app500') return later(env, () => json(500, { error: 'NullPointerException in TodoService.move' }));
                    if (regression === 'gateway503') return later(env, () => send(503, '<h1>503 Service Unavailable</h1>'));
                    if (regression === 'reset') return later(env, () => req.socket.destroy());
                    if (!WHEN.includes(data.when)) return json(400, { error: 'unknown when' });
                    todo.when = data.when;
                }
                if ('done' in data) todo.done = Boolean(data.done);
                return later(env, () => json(200, todo));
            }
            return json(404, { error: 'not found' });
        }
        if (url.pathname === '/' || /^\/todos\/\d+$/.test(url.pathname)) {
            const failing = env.thirdParty && env.random() < env.profile.thirdPartyError.p;
            const portPart = req.headers.host?.includes(':') ? `:${req.headers.host.split(':')[1]}` : '';
            const head = env.thirdParty ? `<script src="http://cdn.localhost${portPart}/widget.js?e=${failing ? 1 : 0}" defer></script>` : '';
            return send(200, page('Errand', `<div class="app"><div data-testid="user-menu">${esc(user)} · <a href="/logout">Sign out</a></div><main></main></div>
<dialog id="dialog" aria-label="New todo"></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div><script>${client(regression)}</script>`, head));
        }
        return send(404, page('Not found', '<main><h1>Not found</h1></main>'));
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({
            port: server.address().port,
            close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
        }));
    });
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { port } = await startApp({ port: Number(process.argv[2] ?? SPIKE_PORT) });
    console.log(`Spike app on http://a.localhost:${port} (recording) and http://b.localhost:${port} (shared)`);
}
