import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

/* global window -- page.evaluate callbacks run in the browser */
import { chromium } from 'playwright-core';

import { browserArgs, installHostLock, lockDecision } from '../src/host/host-lock.mjs';
import { blockedHosts, navigationHosts } from '../src/shared/environments.mjs';

test('browserArgs: production hosts unresolvable first, .localhost pinned to loopback, no proxy, no WebRTC, no CDP port', () => {
    const args = browserArgs(['prod.example', 'prod.localhost']);
    assert.equal(args[0], '--host-resolver-rules=MAP prod.example ~NOTFOUND, MAP prod.localhost ~NOTFOUND, MAP localhost 127.0.0.1, MAP *.localhost 127.0.0.1');
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
