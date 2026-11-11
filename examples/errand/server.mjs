// Example app for caw-ai: Errand, a small todo list. Mobile first, no dependencies.
// Sign-in, list with progress ring, filters and search, a "New todo" dialog with selects, a detail page with a change.
// Start: node server.mjs (port 4174). Data lives in memory; every restart starts from the seed. Account: demo / demo.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4174);
const USERS = { demo: 'demo' };
const LATENCY_MS = 220;
const sessions = new Map();

const TAGS = ['work', 'home', 'vibes'];
const WHEN = ['Today', 'Tomorrow', 'Someday'];
let nextId = 1041;
const todos = [
    ['Pick a gradient', 'vibes', 'Today', true],
    ['Rename the app (again)', 'work', 'Someday', false],
    ['Book the dentist', 'home', 'Tomorrow', false],
    ['Water the monstera', 'home', 'Today', false],
].map(([title, tag, when, done]) => ({ id: nextId++, title, tag, when, done }));

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const CSS = `
@property --p{syntax:'<number>';inherits:false;initial-value:0}
:root{--paper:#f5ede0;--card:#fffaf2;--ink:#231c17;--muted:#8a7d70;--line:#e6dacb;--tomato:#e5533a;--tomato-soft:#fbe1d9;
--sage:#5f8f6b;--sage-soft:#dcebdc;--sun:#e8b33c;--sun-soft:#f9ecc8;--plum:#7b5ea7;--plum-soft:#e9e1f4;--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
--sans:ui-rounded,"SF Pro Rounded","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}html{background:var(--paper)}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.45 var(--sans);
background:radial-gradient(circle at 110% -10%,#f7c9b9 0,transparent 42%),radial-gradient(circle at -20% 30%,#f3e2b8 0,transparent 38%),var(--paper)}
button,input,select{font:inherit;color:inherit}a{color:inherit}
.app{max-width:30rem;margin:0 auto;padding:1.1rem 1.1rem 2rem}
.me{display:flex;justify-content:flex-end;gap:.5rem;align-items:center;font-size:.8rem;color:var(--muted)}
.me b{display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--ink);color:var(--paper);font-size:.75rem}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
h1{font:600 2.6rem/1 var(--serif);letter-spacing:-.02em;margin:.2rem 0 .1rem}
h1 sup{font:700 .72rem/1 var(--sans);letter-spacing:.06em;vertical-align:top;margin-left:.3rem;padding:.3rem .45rem;border-radius:.4rem;background:var(--ink);color:var(--paper);display:inline-block;transform:rotate(-6deg) translateY(-.2rem)}
.sub{margin:0;color:var(--muted);font:italic 1rem/1.35 var(--serif)}
.ring{--p:0;flex:none;width:3.6rem;height:3.6rem;border-radius:50%;display:grid;place-items:center;
background:conic-gradient(var(--tomato) calc(var(--p)*1%),var(--line) 0);transition:--p .4s}
.ring span{width:2.8rem;height:2.8rem;border-radius:50%;background:var(--card);display:grid;place-items:center;font:700 .8rem var(--sans)}
.bar{display:flex;gap:.5rem;margin:1.3rem 0 .9rem;padding:.35rem .35rem .35rem 1rem;background:var(--card);border:1.5px solid var(--ink);border-radius:999px;box-shadow:3px 3px 0 var(--ink)}
.bar input{flex:1;min-width:0;border:0;background:none;outline:none;padding:.45rem 0}
.bar input::placeholder{color:var(--muted)}
.plus{flex:none;width:2.5rem;height:2.5rem;border:0;border-radius:50%;background:var(--tomato);color:#fff;font-size:1.5rem;line-height:1;cursor:pointer;transition:transform .15s}
.plus:active{transform:scale(.92)}
.tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:.25rem;padding:.25rem;border-radius:.9rem;background:#ebe0d0;margin-bottom:.9rem}
.tabs button{border:0;border-radius:.7rem;padding:.45rem 0;background:none;font-weight:600;color:var(--muted);cursor:pointer}
.tabs button[aria-selected=true]{background:var(--card);color:var(--ink);box-shadow:0 1px 3px #0001}
.tabs b{font-weight:600;opacity:.6;margin-left:.25rem}
ul{list-style:none;margin:0;padding:0;display:grid;gap:.55rem}
li{display:flex;align-items:center;gap:.8rem;padding:.8rem .9rem;background:var(--card);border-radius:1rem;box-shadow:0 1px 0 var(--line),0 6px 16px -12px #5a3a2066;animation:in .3s ease-out}
@keyframes in{from{opacity:0;transform:translateY(-6px)}}
.check{flex:none;width:1.6rem;height:1.6rem;border-radius:50%;border:2px solid var(--ink);background:none;cursor:pointer;display:grid;place-items:center;transition:background .2s}
.check::after{content:"";width:.45rem;height:.8rem;border:solid #fff;border-width:0 2.5px 2.5px 0;transform:rotate(45deg) translate(-1px,-1px) scale(0);transition:transform .2s}
li.done .check{background:var(--tomato);border-color:var(--tomato)}li.done .check::after{transform:rotate(45deg) translate(-1px,-1px) scale(1)}
.title{flex:1;min-width:0;overflow-wrap:anywhere;text-decoration:none}.title span{background:linear-gradient(var(--ink),var(--ink)) 0 55%/0 1.5px no-repeat;transition:background-size .35s,color .35s}
li.done .title span{background-size:100% 1.5px;color:var(--muted)}
.when{flex:none;font-size:.72rem;color:var(--muted)}
.t-work{--c:var(--plum);--s:var(--plum-soft)}.t-home{--c:var(--sage);--s:var(--sage-soft)}.t-vibes{--c:var(--sun);--s:var(--sun-soft)}
.chip{flex:none;border-radius:999px;padding:.15rem .55rem;font-size:.72rem;font-weight:700;background:var(--s);color:var(--c)}
.empty{text-align:center;color:var(--muted);font:italic 1rem var(--serif);padding:2rem 0}
dialog{border:0;border-radius:1.4rem;padding:1.4rem;width:min(26rem,calc(100vw - 2rem));background:var(--card);color:var(--ink);box-shadow:0 20px 60px -20px #5a3a2088}
dialog::backdrop{background:#231c1755;backdrop-filter:blur(2px)}
dialog h2{font:600 1.6rem/1 var(--serif);margin:0 0 1rem}
.form{display:grid;gap:.8rem}label{display:grid;gap:.3rem;font-weight:600;font-size:.85rem}
.form input,.form select,.row select{padding:.55rem .75rem;border:1.5px solid var(--line);border-radius:.8rem;background:#fff}
.actions{display:flex;gap:.5rem;justify-content:flex-end;margin-top:.3rem}
.btn{border:0;border-radius:999px;padding:.55rem 1.1rem;font-weight:700;cursor:pointer;background:var(--tomato);color:#fff}
.btn:disabled{background:var(--line);color:var(--muted);cursor:default}.btn.ghost{background:none;color:var(--muted)}
.back{display:inline-block;margin:1rem 0;color:var(--muted);text-decoration:none;font-weight:600}
.detail{background:var(--card);border-radius:1.2rem;padding:1.3rem;box-shadow:0 6px 16px -12px #5a3a2066}
.detail h2{font:600 1.8rem/1.1 var(--serif);margin:0 0 .6rem}.meta{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;color:var(--muted);margin-bottom:1.1rem}
.row{display:flex;gap:.6rem;align-items:end}
.toast{position:fixed;left:50%;bottom:1.2rem;translate:-50% 1rem;opacity:0;padding:.55rem 1rem;border-radius:999px;background:var(--ink);color:var(--paper);font-size:.85rem;transition:.25s;white-space:nowrap}
.toast.on{opacity:1;translate:-50% 0}[aria-busy=true]{opacity:.6}
.login{max-width:22rem;margin:14vh auto;padding:1.8rem;background:var(--card);border-radius:1.4rem;box-shadow:0 20px 60px -24px #5a3a2088}
.login h1{margin-bottom:1.2rem}[role=alert]{color:var(--tomato);min-height:1em}
`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;

const loginPage = (error = '') => page('Sign in · Errand', `<div class="login"><h1>Errand<sup>beta</sup></h1><form class="form" method="post" action="/login">
<label>User <input id="user" name="user" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password"></label>
<button class="btn" type="submit" data-testid="login">Sign in</button></form><p role="alert">${esc(error)}</p></div>`);

// The app itself: a small single-page client that talks to the JSON API below.
const APP = `
const $ = (s) => document.querySelector(s);
const api = (path, init) => fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...init }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const main = $('main');
const busy = async (work) => { main.setAttribute('aria-busy', 'true'); try { return await work(); } finally { main.removeAttribute('aria-busy'); } };
const go = (path) => { history.pushState(null, '', path); render(); };
const toast = (text) => { const t = $('#toast'); t.textContent = text; t.classList.add('on'); clearTimeout(t.timer); t.timer = setTimeout(() => t.classList.remove('on'), 2500); };
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });
addEventListener('popstate', render);
let todos = [], filter = 'all';

async function list() {
  main.innerHTML = '<div class="top"><div><h1>Errand<sup>beta</sup></h1><p class="sub">Small things, done nicely.</p></div><div class="ring" role="img" aria-label="Progress"><span id="progress">0/0</span></div></div>'
    + '<div class="bar"><input type="search" id="q" aria-label="Search todos" placeholder="Search todos" autocomplete="off"><button class="plus" id="new" aria-label="New todo">+</button></div>'
    + '<div class="tabs" role="tablist">' + ['all', 'open', 'done'].map((f) => '<button role="tab" data-filter="' + f + '" aria-label="' + f[0].toUpperCase() + f.slice(1) + '">' + f[0].toUpperCase() + f.slice(1) + '<b></b></button>').join('') + '</div>'
    + '<ul id="list" aria-label="Todos"></ul>';
  const fill = async () => { todos = await busy(() => api('/todos?q=' + encodeURIComponent($('#q').value))); draw(); };
  let timer; $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(fill, 300); });
  $('#new').addEventListener('click', openDialog);
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; draw(); }));
  $('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('.check'); if (!b) return;
    const id = Number(b.closest('li').dataset.id), t = todos.find((x) => x.id === id);
    Object.assign(t, await busy(() => api('/todos/' + id, { method: 'PATCH', body: JSON.stringify({ done: !t.done }) })));
    draw();
    if (t.done) toast('Nice.');
  });
  await fill();
}
function draw() {
  const done = todos.filter((t) => t.done).length;
  $('.ring').style.setProperty('--p', todos.length ? Math.round(done / todos.length * 100) : 0);
  $('#progress').textContent = done + '/' + todos.length;
  const counts = { all: todos.length, open: todos.length - done, done };
  document.querySelectorAll('.tabs button').forEach((b) => { b.setAttribute('aria-selected', b.dataset.filter === filter); b.querySelector('b').textContent = counts[b.dataset.filter]; });
  const shown = todos.filter((t) => filter === 'all' || (filter === 'done') === t.done);
  $('#list').innerHTML = shown.length ? shown.map((t) => '<li data-id="' + t.id + '" class="' + (t.done ? 'done' : '') + '"><button class="check" aria-label="' + (t.done ? 'Reopen ' : 'Complete ') + esc(t.title) + '" aria-pressed="' + t.done + '"></button><a class="title" data-link href="/todos/' + t.id + '"><span>' + esc(t.title) + '</span></a><span class="when">' + t.when + '</span><span class="chip t-' + t.tag + '">#' + t.tag + '</span></li>').join('')
    : '<p class="empty">' + (filter === 'done' ? 'Nothing done yet.' : 'All clear.') + '</p>';
}
function openDialog() {
  const d = $('#dialog');
  d.innerHTML = '<form class="form" method="dialog"><h2>New todo</h2><label>Title <input name="title" required autocomplete="off"></label><label>Tag <select name="tag"><option value="">Choose…</option>' + ${JSON.stringify(TAGS)}.map((t) => '<option value="' + t + '">#' + t + '</option>').join('') + '</select></label><label>When <select name="when">' + ${JSON.stringify(WHEN)}.map((w) => '<option>' + w + '</option>').join('') + '</select></label><div class="actions"><button type="button" class="btn ghost" value="cancel">Cancel</button><button class="btn" id="create" disabled>Add todo</button></div></form>';
  const f = d.querySelector('form');
  const check = () => { $('#create').disabled = !(f.title.value.trim() && f.tag.value); };
  f.addEventListener('input', check); f.addEventListener('change', check);
  d.querySelector('[value=cancel]').addEventListener('click', () => d.close());
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#create').disabled = true;
    const t = await api('/todos', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(f))) });
    d.close();
    toast('Added #' + t.id);
    todos.unshift(t);
    draw();
  });
  d.showModal();
}
async function detail(id) {
  const t = await busy(() => api('/todos/' + id));
  main.innerHTML = '<a class="back" data-link href="/">← All todos</a><div class="detail"><h2>#' + t.id + ' ' + esc(t.title) + '</h2><div class="meta"><span class="chip t-' + t.tag + '">#' + t.tag + '</span><span>' + (t.done ? 'Done' : 'Open') + '</span><span>When: <output id="when">' + t.when + '</output></span></div>'
    + '<div class="row"><label>Move to <select id="next">' + ${JSON.stringify(WHEN)}.map((w) => '<option' + (w === t.when ? ' selected' : '') + '>' + w + '</option>').join('') + '</select></label><button class="btn" id="save">Save</button></div></div>';
  $('#save').addEventListener('click', async () => {
    const u = await busy(() => api('/todos/' + id, { method: 'PATCH', body: JSON.stringify({ when: $('#next').value }) }));
    $('#when').textContent = u.when;
    toast('Moved to ' + u.when);
  });
}
async function render() {
  const m = /^\\/todos\\/(\\d+)$/.exec(location.pathname);
  if (m) return detail(m[1]);
  return list();
}
render();
`;

const appPage = (user) => page('Errand', `<div class="app"><div class="me" data-testid="user-menu"><b>${esc(user[0].toUpperCase())}</b>${esc(user)} · <a href="/logout">Sign out</a></div><main></main></div>
<dialog id="dialog" aria-label="New todo"></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div><script>${APP}</script>`);

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
        if (req.method === 'GET' && path === '/todos') {
            const q = (url.searchParams.get('q') ?? '').toLowerCase();
            return later(() => json(200, todos.filter((t) => t.title.toLowerCase().includes(q)).toReversed()));
        }
        if (req.method === 'POST' && path === '/todos') {
            const data = JSON.parse(await body(req) || '{}');
            if (!data.title?.trim() || !TAGS.includes(data.tag)) return json(400, { error: 'title and tag required' });
            const todo = { id: nextId++, title: data.title.trim().slice(0, 120), tag: data.tag, when: WHEN.includes(data.when) ? data.when : 'Today', done: false };
            todos.push(todo);
            return later(() => json(201, todo));
        }
        const one = /^\/todos\/(\d+)$/.exec(path);
        const todo = one && todos.find((t) => t.id === Number(one[1]));
        if (one && !todo) return json(404, { error: 'not found' });
        if (req.method === 'GET' && todo) return later(() => json(200, todo));
        if (req.method === 'PATCH' && todo) {
            const data = JSON.parse(await body(req) || '{}');
            if ('done' in data) todo.done = Boolean(data.done);
            if ('when' in data) {
                if (!WHEN.includes(data.when)) return json(400, { error: 'unknown when' });
                todo.when = data.when;
            }
            return later(() => json(200, todo));
        }
        return json(404, { error: 'not found' });
    }
    if (url.pathname === '/' || /^\/todos\/\d+$/.test(url.pathname)) return send(200, appPage(user));
    return send(404, page('Not found', '<main><h1>Not found</h1></main>'));
}).listen(PORT, '127.0.0.1', () => console.log(`Errand on http://localhost:${PORT}`));
