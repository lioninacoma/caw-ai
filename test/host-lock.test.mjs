import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

/* global window, document -- page.evaluate callbacks run in the browser */
import { chromium } from 'playwright-core';

import { ANY_HOST, browserArgs, installHostLock, lockDecision } from '../src/host/host-lock.mjs';
import { blockedHosts, navigationHosts } from '../src/shared/environments.mjs';

test('browserArgs: production hosts unresolvable first, .localhost pinned to loopback, no proxy, no WebRTC, no CDP port', () => {
    const args = browserArgs(['prod.example', 'prod.localhost']);
    assert.equal(args[0], '--host-resolver-rules=MAP prod.example ~NOTFOUND, MAP prod.example. ~NOTFOUND, MAP prod.localhost ~NOTFOUND, MAP prod.localhost. ~NOTFOUND, '
        + 'MAP localhost 127.0.0.1, MAP *.localhost 127.0.0.1', 'a trailing dot is the same host for Chrome');
    assert.equal(browserArgs()[0], '--host-resolver-rules=MAP localhost 127.0.0.1, MAP *.localhost 127.0.0.1', 'every other host resolves: subresources may go anywhere');
    assert.ok(args.includes('--no-proxy-server'), 'through a proxy the resolver rules would not apply');
    assert.ok(args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(!args.some((arg) => arg.includes('remote-debugging')));
});

test('lockDecision: top navigations only to navigation hosts (localhost and 127.0.0.1 as one), anything else free, production never', () => {
    const lock = { navigation: ['app.example', 'localhost'], blocked: ['prod.example'] };
    const decide = (url, topNavigation) => lockDecision({ url, topNavigation }, lock);
    assert.equal(decide('https://app.example/x', true), 'allow');
    assert.equal(decide('http://127.0.0.1:5173/', true), 'allow', 'the loopback pair');
    assert.equal(decide('https://elsewhere.example/', true), 'navigation');
    assert.equal(decide('https://cdn.example/lib.js', false), 'allow', 'subresources and iframes go anywhere');
    assert.equal(decide('https://prod.example/api', false), 'production');
    assert.equal(decide('https://prod.example/', true), 'production');
    assert.equal(decide('data:text/html,x', true), 'allow');
    // explore: the person may sign in at an IdP anywhere; production stays blocked.
    const anywhere = { navigation: [ANY_HOST], blocked: ['prod.example'] };
    assert.equal(lockDecision({ url: 'https://idp.example/realms/x', topNavigation: true }, anywhere), 'allow');
    assert.equal(lockDecision({ url: 'https://prod.example/', topNavigation: true }, anywhere), 'production');
});

test('blockedHosts: production hosts of other environments; none on production itself', () => {
    const config = { environments: { local: { url: 'http://app.localhost:3000' }, prod: { url: 'https://shop.example', production: true }, live: { url: 'https://live.example', production: true } } };
    assert.deepEqual(blockedHosts(config, 'local'), ['shop.example', 'live.example']);
    assert.deepEqual(blockedHosts(config, 'prod'), []);
    assert.ok(!navigationHosts(config, 'local').includes('shop.example'));
});

let browser = null;
let server = null;
let port = 0;
before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: browserArgs(['prod.localhost']) }).catch((error) => {
        if (process.env.CAW_REQUIRE_CHROME === '1') throw error;
        return null;
    });
    server = createServer((req, res) => {
        const host = req.headers.host.split(':')[0];
        const at = (name) => `http://${name}.localhost:${port}`;
        res.setHeader('access-control-allow-origin', '*');
        if (req.url === '/redirect') {
            res.writeHead(302, { location: `${at('elsewhere')}/landed` });
            return res.end();
        }
        if (req.url === '/lib.js') {
            res.setHeader('content-type', 'text/javascript');
            return res.end('window.libLoaded = true;');
        }
        res.setHeader('content-type', 'text/html');
        if (host === 'app.localhost' && req.url === '/') {
            return res.end(`<a id="away" href="${at('elsewhere')}/">away</a><a id="popup" href="${at('elsewhere')}/" target="_blank">popup</a>
<a id="redirect" href="/redirect">redirect</a><iframe id="pay" src="${at('pay')}/widget"></iframe><script src="${at('cdn')}/lib.js"></script>`);
        }
        return res.end(`<p id="where">${host} ${req.url}</p>`);
    });
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    port = server.address().port;
});
after(async () => {
    await browser?.close();
    server?.close();
});

test('host lock in Chrome: a link and a popup to another host are blocked, third-party script and iframe load, production is unreachable, a redirect hop is reported', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const context = await browser.newContext();
    t.after(() => context.close());
    const blocked = [];
    await installHostLock(context, { navigation: ['app.localhost'], blocked: ['prod.localhost'], onBlocked: ({ host, kind }) => blocked.push(`${kind} ${host}`) });
    const page = await context.newPage();
    await page.goto(`http://app.localhost:${port}/`);
    assert.equal(await page.evaluate(() => window.libLoaded), true, 'a script from a third-party host');
    assert.match(await page.frameLocator('#pay').locator('#where').textContent(), /pay\.localhost \/widget/, 'a third-party iframe');
    const answer = await page.evaluate((url) => fetch(url).then((response) => response.status, (error) => String(error)), `http://prod.localhost:${port}/api`);
    assert.match(String(answer), /Failed to fetch/, 'production is unreachable for XHR too');

    await page.click('#away');
    await page.waitForTimeout(300);
    assert.equal(new URL(page.url()).hostname, 'app.localhost', 'the link did not leave the app');
    // Chrome does not open the tab at all when its first navigation is aborted; if it did, the tab must be empty.
    const popup = context.waitForEvent('page', { timeout: 2000 }).catch(() => null);
    await page.click('#popup');
    const opened = await popup;
    if (opened !== null) await opened.waitForLoadState().catch(() => {});
    assert.ok(opened === null || await opened.locator('#where').count() === 0, 'the popup did not load the foreign page');
    await page.click('#redirect');
    await page.waitForLoadState();
    assert.deepEqual(blocked, ['production prod.localhost', 'navigation elsewhere.localhost', 'navigation elsewhere.localhost', 'redirect elsewhere.localhost']);
});

test('lockDecision: hosts compared normalized; with Claude attached (reach) every request type outside the reach is blocked', () => {
    const lock = { navigation: ['app.example', 'localhost'], blocked: ['prod.example'] };
    assert.equal(lockDecision({ url: 'https://prod.example./api', topNavigation: false }, lock), 'production', 'a trailing dot is the same host');
    assert.equal(lockDecision({ url: 'https://PROD.example/api', topNavigation: false }, lock), 'production');
    assert.equal(lockDecision({ url: 'https://app.example./x', topNavigation: true }, lock), 'allow');
    const agent = { ...lock, reach: ['app.example', 'localhost', 'fonts.example'] };
    assert.equal(lockDecision({ url: 'https://fonts.example/a.woff2', topNavigation: false }, agent), 'allow', 'a listed third-party host');
    assert.equal(lockDecision({ url: 'https://cdn.example/lib.js', topNavigation: false }, agent), 'agent', 'an unlisted one: blocked for subresources too');
    assert.equal(lockDecision({ url: 'wss://cdn.example/socket', topNavigation: false }, agent), 'agent');
    assert.equal(lockDecision({ url: 'http://127.0.0.1:5173/', topNavigation: false }, agent), 'allow', 'the loopback pair');
    assert.equal(lockDecision({ url: 'https://elsewhere.example/', topNavigation: true }, agent), 'navigation', 'a top navigation keeps its own kind');
    assert.equal(lockDecision({ url: 'https://prod.example/', topNavigation: false }, agent), 'production');
});

test('browserArgs with reach: allowed loopback names pinned, everything else unresolvable, other allowed hosts and IPs excluded', () => {
    const [rules] = browserArgs(['prod.example'], { reach: ['app.localhost', 'localhost', 'sso.example'] });
    assert.equal(rules, '--host-resolver-rules=MAP prod.example ~NOTFOUND, MAP prod.example. ~NOTFOUND, MAP app.localhost 127.0.0.1, MAP localhost 127.0.0.1, '
        + 'MAP * ~NOTFOUND, EXCLUDE sso.example, EXCLUDE 127.0.0.1');
    assert.ok(!rules.includes('EXCLUDE prod'), 'EXCLUDE beats every MAP rule: never for a production host');
});

test('agent lock in Chrome: fetch, iframe, beacon and WebSocket reach only the reach; the resolver alone already stops them; a trailing dot does not pass production', async (t) => {
    const agentBrowser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: browserArgs(['prod.localhost'], { reach: ['app.localhost', 'cdn.localhost', 'localhost'] }) }).catch((error) => {
        if (process.env.CAW_REQUIRE_CHROME === '1') throw error;
        return null;
    });
    if (agentBrowser === null) return t.skip('no Chrome');
    t.after(() => agentBrowser.close());
    const fetchFrom = (page, url) => page.evaluate((target) => fetch(target).then((response) => response.status, (error) => String(error)), url);

    // Only the resolver rules, no route: an unlisted host does not even resolve.
    const bare = await agentBrowser.newContext();
    const plain = await bare.newPage();
    await plain.goto(`http://app.localhost:${port}/lib.js`);
    assert.equal(await fetchFrom(plain, `http://cdn.localhost:${port}/lib.js`), 200, 'a listed third-party host');
    assert.equal(await fetchFrom(plain, `http://127.0.0.1:${port}/lib.js`), 200, 'the loopback pair of localhost');
    assert.match(String(await fetchFrom(plain, `http://evil.localhost:${port}/lib.js`)), /Failed to fetch/, 'an unlisted host is unresolvable');
    assert.match(String(await fetchFrom(plain, `http://prod.localhost.:${port}/lib.js`)), /Failed to fetch/, 'production with a trailing dot');
    await bare.close();

    const context = await agentBrowser.newContext();
    t.after(() => context.close());
    const blocked = [];
    await installHostLock(context, { navigation: ['app.localhost'], blocked: ['prod.localhost'], reach: ['app.localhost', 'cdn.localhost', 'localhost'], onBlocked: ({ host, kind }) => blocked.push(`${kind} ${host}`) });
    const page = await context.newPage();
    await page.goto(`http://app.localhost:${port}/lib.js`);
    assert.equal(await fetchFrom(page, `http://cdn.localhost:${port}/lib.js`), 200);
    assert.match(String(await fetchFrom(page, `http://evil.localhost:${port}/lib.js`)), /Failed to fetch/);
    await page.evaluate((url) => {
        const frame = document.createElement('iframe');
        frame.src = url;
        document.body.append(frame);
    }, `http://evil.localhost:${port}/frame`);
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser page
    await page.evaluate((url) => navigator.sendBeacon(url, 'data'), `http://evil.localhost:${port}/beacon`);
    const socket = await page.evaluate((url) => new Promise((done) => {
        const ws = new WebSocket(url);
        ws.onopen = () => done('open');
        ws.onclose = () => done('closed');
    }), `ws://evil.localhost:${port}/socket`);
    assert.equal(socket, 'closed');
    await page.waitForTimeout(500);
    assert.deepEqual([...new Set(blocked)], ['agent evil.localhost'], 'every attempt named as blocked by the agent lock');
    assert.ok(blocked.length >= 4, `fetch, iframe, beacon and socket each reported (${blocked.join(', ')})`);
});
