import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Schreibende Requests fuer die Pruefungen des E2E, neben diesem Skript.
const HITS = join(dirname(fileURLToPath(import.meta.url)), 'portal-hits.log');

const repo = (path) => `/o/DataProxy?url=repo:///Root/${path}`;
const loginPage = `<!doctype html><title>Login</title><body><form method=post action=/login>
<input id=login_login name=l>
<input id=login_password name=p type=password>
<button>Anmelden</button></form></body>`;
const appPage = `<!doctype html><title>Fake-Portal</title>
<script>window.DEFINES=0;window.Ext={define(){window.DEFINES+=1},require(){},onReady(){},
 data:{StoreManager:{lookup(){return null},each(){}},schema:{Schema:{}}},Ajax:{isLoading(){return false}},
 getVersion(){return{version:'6.5.3'}},apply(a,b){return Object.assign(a,b)},ns(){return{}},Loader:{setPath(){}}};</script>
<script src="${repo('Fx/Static.js')}"></script>
<script src="${repo('Fx/Model.js')}"></script>
<body class="signed-in"><h1>Fake-Portal</h1>
<button id=weiter onclick="document.getElementById('ziel').textContent='Ziel erreicht'">Weiter</button>
<button id=kaputt onclick="console.error('absichtlicher Fehler')">Kaputt</button>
<input id=anliegen aria-label=Anliegen><input id=pw type=password aria-label=Kennwort>
<button id=senden onclick="fetch('/o/DataProxy?connector=HTTP-X-Speichern&text='+encodeURIComponent(document.getElementById('anliegen').value),{method:'POST'});document.getElementById('vorgang').textContent=document.getElementById('anliegen').value">Senden</button>
<button id=spaeter onclick="fetch('/o/DataProxy?connector=HTTP-X-Abschliessen',{method:'POST'});document.getElementById('fertig').textContent='fertig'">Abschliessen</button>
<button id=laden onclick="ladePreise()">Preise laden</button>
<div id=vorgang></div><div id=fertig></div><div id=ziel></div><div id=preis></div></body>`;
// Der Code der Anwendung liegt im Projekt: Eine uebernommene Aenderung wirkt beim naechsten Laden.
const appCode = () => {
    try {
        return `<script>${readFileSync('preise.js', 'utf8')}</script>`;
    } catch {
        return '';
    }
};

createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.url !== '/login') appendFileSync(HITS, req.url + '\n');
    const authed = /auth=1/.test(req.headers.cookie ?? '');
    if (req.method === 'POST' && req.url === '/login') {
        let body = '';
        req.on('data', (c) => { body += c; }).on('end', () => {
            const ok = body.includes('l=fx-user');
            res.writeHead(302, { location: '/app', ...(ok ? { 'set-cookie': 'auth=1; Path=/' } : {}) });
            res.end();
        });
        return;
    }
    if (req.url === '/public/fremd.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end("throw new Error('fremd');");
        return;
    }
    if (/connector=HTTP-X-(Preise|Langsam)/.test(req.url)) {
        setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"betrag":42}');
        }, req.url.includes('Langsam') ? 3000 : 300);
        return;
    }
    if (req.url.startsWith('/o/DataProxy')) {
        // Der deployte Stand: Kommt das bei der App an, hat die Substitution versagt.
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end("window.STAND='DEPLOYT';");
        return;
    }
    // Wie ein echtes Portal: Einbetten verboten. Die Werkbank nimmt das nur im Testbrowser heraus.
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'; object-src 'none'" });
    res.end(authed ? appPage.replace('</body>', `${appCode()}</body>`) : loginPage);
}).listen(8443, '127.0.0.1');
