// Adapter react, vue und angular in Chrome (headless), mit den Spuren, die die Frameworks im Dev-Build am DOM hinterlassen.
// Ohne Chrome uebersprungen.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { FRAMEWORKS, targetLabel } from '../src/host/framework/index.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

const FORM = '<div id="root"><form aria-label="Bestellung"><button id="b"><span>Senden</span></button></form></div>';
const describe = (adapter) => page.locator('#b span').evaluate(adapter.targets, { mode: 'describe' });
const probe = (adapter) => page.evaluate(adapter.probe, null);

test('react: Komponente aus der Fiber, auch hinter memo; Bereitschaft am Root-Container', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(FORM);
    assert.equal((await probe(FRAMEWORKS.react)).appReady, false, 'React nicht eingehaengt');
    await page.evaluate(() => {
        function OrderForm() {}
        const memo = { $$typeof: 'memo', type: OrderForm };
        const host = { type: 'button', return: { type: memo, return: { type: function App() {}, return: null } } };
        document.getElementById('b')['__reactFiber$abc'] = host;
        document.getElementById('root')['__reactContainer$abc'] = {};
    });
    const described = await describe(FRAMEWORKS.react);
    assert.deepEqual(described, { role: 'button', name: 'Senden', inside: { role: 'form', name: 'Bestellung' }, component: 'OrderForm' });
    assert.equal(targetLabel(described), 'button "Senden" in <OrderForm>');
    const found = await page.evaluateHandle(`(${FRAMEWORKS.react.targets})(null, ${JSON.stringify({ mode: 'find', target: { ...described, component: 'Umbenannt' } })})`);
    assert.ok(found.asElement() !== null, 'component ist nur ein Hinweis, find wertet ihn nicht aus');
    assert.equal((await probe(FRAMEWORKS.react)).appReady, true);
    // Dev-Build von React 19: Besitzerkette. Der Knopf allein sagt wenig, der Bildschirm, der ihn rendert, fuehrt zur Datei.
    await page.evaluate(() => {
        function Button() {}
        function OrdersScreen() {}
        function App() {}
        const app = { type: App, _debugOwner: null };
        const screen = { type: OrdersScreen, _debugOwner: app };
        const button = { type: Button, _debugOwner: screen };
        document.getElementById('b')['__reactFiber$abc'] = { type: 'button', _debugOwner: button, return: button };
    });
    assert.equal((await describe(FRAMEWORKS.react)).component, 'App › OrdersScreen › Button');
    return undefined;
});

test('vue: Komponente und Datei der SFC; Bereitschaft an data-v-app', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(FORM);
    await page.evaluate(() => {
        document.getElementById('b').__vueParentComponent = { type: { __name: 'OrderForm', __file: 'src/components/OrderForm.vue' }, parent: null };
        document.getElementById('root').setAttribute('data-v-app', '');
    });
    assert.deepEqual(await describe(FRAMEWORKS.vue), { role: 'button', name: 'Senden', inside: { role: 'form', name: 'Bestellung' }, component: 'OrderForm', source: 'src/components/OrderForm.vue' });
    assert.equal((await probe(FRAMEWORKS.vue)).appReady, true);
    return undefined;
});

test('angular: Komponente über ng, minifizierte Namen fallen weg; Zone.js instabil heißt lädt', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(`${FORM.replace('<div id="root">', '<div id="root" ng-version="19.0.0">')}`);
    await page.evaluate(() => {
        class OrderFormComponent {}
        window.ng = { getOwningComponent: () => new OrderFormComponent(), getComponent: () => null };
        window.__stable = false;
        window.getAllAngularTestabilities = () => [{ isStable: () => window.__stable }];
    });
    assert.equal((await describe(FRAMEWORKS.angular)).component, 'OrderFormComponent');
    await page.waitForTimeout(200);
    const unstable = await probe(FRAMEWORKS.angular);
    assert.equal(unstable.appReady, true);
    assert.equal(unstable.loadingStores, 1, 'Zone.js hat noch Aufgaben');
    await page.evaluate(() => { window.__stable = true; window.ng.getOwningComponent = () => new (class t {})(); });
    assert.equal((await probe(FRAMEWORKS.angular)).loadingStores, 0);
    assert.equal((await describe(FRAMEWORKS.angular)).component, undefined, 'Produktions-Build: kein Hinweis, kein Fehler');
    return undefined;
});

test('Produktions-Build ohne Spuren: Beschreiben wie web, kein Fehler', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(FORM);
    for (const name of ['react', 'vue', 'angular']) assert.deepEqual(await describe(FRAMEWORKS[name]), await describe(FRAMEWORKS.web), name);
    return undefined;
});

test('stackSkip: Framework-Dateien, nicht die Anwendung', () => {
    assert.ok(FRAMEWORKS.react.stackSkip.test('http://app.localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1'));
    assert.ok(FRAMEWORKS.vue.stackSkip.test('https://a.example/node_modules/@vue/runtime-core/dist/x.js'));
    assert.ok(FRAMEWORKS.angular.stackSkip.test('https://a.example/polyfills-ABC.js'));
    for (const adapter of [FRAMEWORKS.react, FRAMEWORKS.vue, FRAMEWORKS.angular]) assert.ok(!adapter.stackSkip.test('http://app.localhost:5173/src/App.tsx'), adapter.name);
    for (const adapter of [FRAMEWORKS.react, FRAMEWORKS.vue, FRAMEWORKS.angular]) assert.ok(adapter.hints.length > 0);
});

test('react: SSR mit hydrateRoot(document) (Next.js App Router, React Router Framework-Modus) gilt als eingehaengt', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(FORM);
    assert.equal((await probe(FRAMEWORKS.react)).appReady, false);
    await page.evaluate(() => { document['__reactContainer$xyz'] = {}; });
    assert.equal((await probe(FRAMEWORKS.react)).appReady, true);
    await page.evaluate(() => { delete document['__reactContainer$xyz']; });
    return undefined;
});
