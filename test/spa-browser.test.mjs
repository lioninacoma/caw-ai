// The react, vue and angular adapters in Chrome (headless), with the traces the frameworks leave on the DOM in dev builds.
// Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { FRAMEWORKS, elementHint } from '../src/host/framework/index.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

const FORM = '<div id="root"><form aria-label="Bestellung"><button id="b"><span>Senden</span></button></form></div>';
// The hint for the recorded element: the locator itself stays native, the component only helps diagnosis.
const hint = async (adapter) => elementHint(adapter, await page.locator('#b').elementHandle());
const probe = (adapter) => page.evaluate(adapter.probe, null);

test('react: component from the fiber, also behind memo; readiness at the root container', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(FORM);
    assert.equal((await probe(FRAMEWORKS.react)).appReady, false, 'React not mounted');
    await page.evaluate(() => {
        function OrderForm() {}
        const memo = { $$typeof: 'memo', type: OrderForm };
        const host = { type: 'button', return: { type: memo, return: { type: function App() {}, return: null } } };
        document.getElementById('b')['__reactFiber$abc'] = host;
        document.getElementById('root')['__reactContainer$abc'] = {};
    });
    assert.deepEqual(await hint(FRAMEWORKS.react), { component: 'OrderForm' });
    assert.equal((await probe(FRAMEWORKS.react)).appReady, true);
    // React 19 dev build: owner chain. The button alone says little; the screen rendering it leads to the file.
    await page.evaluate(() => {
        function Button() {}
        function OrdersScreen() {}
        function App() {}
        const app = { type: App, _debugOwner: null };
        const screen = { type: OrdersScreen, _debugOwner: app };
        const button = { type: Button, _debugOwner: screen };
        document.getElementById('b')['__reactFiber$abc'] = { type: 'button', _debugOwner: button, return: button };
    });
    assert.equal((await hint(FRAMEWORKS.react)).component, 'App › OrdersScreen › Button');
    return undefined;
});

test('vue: component and file of the SFC; readiness via data-v-app', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(FORM);
    await page.evaluate(() => {
        document.getElementById('b').__vueParentComponent = { type: { __name: 'OrderForm', __file: 'src/components/OrderForm.vue' }, parent: null };
        document.getElementById('root').setAttribute('data-v-app', '');
    });
    assert.deepEqual(await hint(FRAMEWORKS.vue), { component: 'OrderForm', source: 'src/components/OrderForm.vue' });
    assert.equal((await probe(FRAMEWORKS.vue)).appReady, true);
    return undefined;
});

test('angular: component via ng, minified names are dropped; unstable Zone.js means loading', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(`${FORM.replace('<div id="root">', '<div id="root" ng-version="19.0.0">')}`);
    await page.evaluate(() => {
        class OrderFormComponent {}
        window.ng = { getOwningComponent: () => new OrderFormComponent(), getComponent: () => null };
        window.__stable = false;
        window.getAllAngularTestabilities = () => [{ isStable: () => window.__stable }];
    });
    assert.deepEqual(await hint(FRAMEWORKS.angular), { component: 'OrderFormComponent' });
    await page.waitForTimeout(200);
    const unstable = await probe(FRAMEWORKS.angular);
    assert.equal(unstable.appReady, true);
    assert.equal(unstable.loadingStores, 1, 'Zone.js still has tasks');
    await page.evaluate(() => { window.__stable = true; window.ng.getOwningComponent = () => new (class a {})(); });
    assert.equal((await probe(FRAMEWORKS.angular)).loadingStores, 0);
    assert.equal(await hint(FRAMEWORKS.angular), null, 'production build: no hint, no error');
    return undefined;
});

test('Production build without traces: no hint, no error; web has none at all', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(FORM);
    for (const name of ['react', 'vue', 'angular', 'web']) assert.equal(await hint(FRAMEWORKS[name]), null, name);
    return undefined;
});

test('stackSkip: framework files, not the application', () => {
    assert.ok(FRAMEWORKS.react.stackSkip.test('http://app.localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1'));
    assert.ok(FRAMEWORKS.vue.stackSkip.test('https://a.example/node_modules/@vue/runtime-core/dist/x.js'));
    assert.ok(FRAMEWORKS.angular.stackSkip.test('https://a.example/polyfills-ABC.js'));
    for (const adapter of [FRAMEWORKS.react, FRAMEWORKS.vue, FRAMEWORKS.angular]) assert.ok(!adapter.stackSkip.test('http://app.localhost:5173/src/App.tsx'), adapter.name);
    for (const adapter of [FRAMEWORKS.react, FRAMEWORKS.vue, FRAMEWORKS.angular]) assert.ok(adapter.hints.length > 0);
});

test('react: SSR with hydrateRoot(document) (Next.js App Router, React Router framework mode) counts as mounted', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(FORM);
    assert.equal((await probe(FRAMEWORKS.react)).appReady, false);
    await page.evaluate(() => { document['__reactContainer$xyz'] = {}; });
    assert.equal((await probe(FRAMEWORKS.react)).appReady, true);
    await page.evaluate(() => { delete document['__reactContainer$xyz']; });
    return undefined;
});
