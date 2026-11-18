// caw export: recorded actions as Playwright code, the spec file, the support module's settings, and what is refused.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { GENERATED, actionLines, exportLocator, exportTest } from '../src/host/export.mjs';
import { stepHash } from '../src/host/test-file.mjs';

test('exportLocator: the recorded locator on page; strings and regular expressions with placeholders are filled per run', () => {
    assert.equal(exportLocator("getByRole('button', { name: 'Save', exact: true })"), 'page.getByRole("button", { name: "Save", exact: true })');
    assert.equal(exportLocator("getByRole('row').filter({ hasText: 'Ticket {{runTag}}' }).getByRole('button', { name: 'Close' })"),
        'page.getByRole("row").filter({ hasText: caw.text("Ticket {{runTag}}") }).getByRole("button", { name: "Close" })');
    assert.equal(exportLocator("getByRole('cell').filter({ hasText: /^{{id}}$/ })"), 'page.getByRole("cell").filter({ hasText: caw.regex("^{{id}}$", "") })');
    assert.equal(exportLocator("getByText(/^Total \\d+$/i)"), 'page.getByText(/^Total \\d+$/i)');
    assert.equal(exportLocator("locator('iframe[title=\"Pay\"]').contentFrame().getByRole('button', { name: 'Pay' })"), 'page.locator("iframe[title=\\"Pay\\"]").contentFrame().getByRole("button", { name: "Pay" })');
    assert.equal(exportLocator("getByRole('listitem').filter({ has: getByText('Done') })"), 'page.getByRole("listitem").filter({ has: page.getByText("Done") })');
});

test('actionLines: each kind as caw replays it; dialogs wrap the action, page changes settle, evidence and refusals are left out', () => {
    const button = "getByRole('button', { name: 'Delete', exact: true })";
    assert.deepEqual(actionLines({ action: 'click', target: button }), ['await page.getByRole("button", { name: "Delete", exact: true }).click();', 'await caw.settle();']);
    assert.deepEqual(actionLines({ action: 'click', target: button, optional: true }), ['await caw.optional(page.getByRole("button", { name: "Delete", exact: true }));', 'await caw.settle();']);
    assert.deepEqual(actionLines({ action: 'click', target: button, dialog: { type: 'confirm', accept: true, message: 'Delete #?' } }),
        ['await caw.dialog({"accept":true}, () => page.getByRole("button", { name: "Delete", exact: true }).click());', 'await caw.settle();']);
    assert.deepEqual(actionLines({ action: 'click', target: button, dialog: { type: 'prompt', accept: true, value: 'Note {{runTag}}' } })[0],
        'await caw.dialog({"accept":true,"value":"Note {{runTag}}"}, () => page.getByRole("button", { name: "Delete", exact: true }).click());');
    assert.deepEqual(actionLines({ action: 'fill', target: "getByLabel('Due')", value: '{{date+7}}' }), ['await caw.fill(page.getByLabel("Due"), caw.text("{{date+7}}"));']);
    assert.deepEqual(actionLines({ action: 'type', target: "getByLabel('Name')", value: 'Ann' }), ['await page.getByLabel("Name").pressSequentially("Ann");']);
    assert.deepEqual(actionLines({ action: 'upload', target: "getByLabel('File')", files: ['fixtures/a.pdf'] }), ['await caw.upload(page.getByLabel("File"), ["fixtures/a.pdf"]);']);
    assert.deepEqual(actionLines({ action: 'download', target: "getByRole('link', { name: 'CSV' })", file: '\\.csv$' }), ['await caw.download(page.getByRole("link", { name: "CSV" }), new RegExp("\\\\.csv$"));']);
    assert.deepEqual(actionLines({ action: 'dragTo', target: "getByText('Card 1')", to: "getByRole('list', { name: 'Done' })" }), ['await page.getByText("Card 1").dragTo(page.getByRole("list", { name: "Done" }));']);
    assert.deepEqual(actionLines({ action: 'press', key: 'Enter' }), ['await page.keyboard.press("Enter");', 'await caw.settle();']);
    assert.deepEqual(actionLines({ action: 'goto', url: '/orders/{{nr}}' }), ['await page.goto(caw.text("/orders/{{nr}}"));', 'await caw.settle();']);
    assert.match(actionLines({ action: 'goto', url: 'https://elsewhere.example/', denied: true })[0], /^\/\/ goto .* not exported\.$/);
    // A crafted recording (validation bypassed): the URL stays inside the comment, no line of it becomes code.
    for (const breakChar of ['\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
        const lines = actionLines({ action: 'goto', url: `https://x/${breakChar}process.exit(1)//`, denied: true });
        assert.equal(lines.length, 1);
        assert.doesNotMatch(lines[0], /[\r\n\u2028\u2029]/, JSON.stringify(breakChar));
        assert.match(lines[0], /^\/\/ goto "https:\/\/x\/\\(n|r|u2028|u2029)process\.exit\(1\)\/\/" was refused/);
    }
    assert.deepEqual(actionLines({ action: 'reload', dialog: { type: 'beforeunload', accept: true } }), ['await caw.dialog({"accept":true}, () => page.reload());', 'await caw.settle();']);
    assert.deepEqual(actionLines({ action: 'wait-ready', for: '#orders [role=row]', minCount: 2 }), ['await caw.waitReady({"for":"#orders [role=row]","minCount":2});']);
    assert.deepEqual(actionLines({ action: 'wait-ready' }), ['await caw.waitReady();']);
    assert.deepEqual(actionLines({ action: 'remember', name: 'nr', code: "document.title" }), ['await caw.remember("nr", "document.title");']);
    assert.deepEqual(actionLines({ action: 'screenshot', name: 'e1.png' }), []);
});

/** A project with one recorded test: role clerk, a form sign-in, environments local and ci. */
const project = (t, { recorded = true, stale = false, framework = 'web', locator = "getByRole('button', { name: 'Delete', exact: true })" } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-export-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify({
        language: 'en',
        framework,
        signIn: { type: 'form', path: '/login', userSelector: '#user', passwordSelector: '#password', signedInSelector: '#menu' },
        roles: { clerk: {} },
        environments: { local: { url: 'http://localhost:5173', claude: true, writable: true }, ci: { url: 'http://localhost:8080', writable: true } },
    }));
    mkdirSync(join(root, 'caw', 'tests'), { recursive: true });
    mkdirSync(join(root, 'caw', 'recordings'), { recursive: true });
    const step = { id: 'S1', name: 'Delete the order', do: 'Delete it.', expect: 'It is gone.' };
    writeFileSync(join(root, 'caw', 'tests', 'order.yaml'), `id: order\nrole: clerk\nwrites: true\nsteps:\n  - id: S1\n    name: ${step.name}\n    do: ${step.do}\n    expect: ${step.expect}\n`);
    if (recorded) {
        const hash = stale ? '0000000000000000' : stepHash(step);
        writeFileSync(join(root, 'caw', 'recordings', 'order.yaml'), `test: order\nsteps:\n  - id: S1\n    hash: "${hash}"\n    recordedOn: local\n    recordedAt: 2026-11-15T10:00:00.000Z\n    locale: de-DE\n    timezone: Europe/Berlin\n    viewport: {width: 1280, height: 800}\n    actions:\n      - {click: ${JSON.stringify(locator)}, dialog: {type: confirm, accept: true}}\n    check: "document.title === 'Gone'"\n`);
    }
    return root;
};

test('exportTest: spec, support and config; the support knows the environment, the variable names and the paths; the config is written once', (t) => {
    const root = project(t);
    const { env, files, kept } = exportTest(root, 'order', { env: 'ci' });
    assert.equal(env, 'ci');
    assert.deepEqual(files.map((file) => file.slice(root.length + 1).replaceAll('\\', '/')), ['caw/export/playwright/order.spec.mjs', 'caw/export/playwright/caw-support.mjs', 'caw/export/playwright/playwright.config.mjs']);
    assert.equal(kept, null);
    const dir = join(root, 'caw', 'export', 'playwright');
    const spec = readFileSync(join(dir, 'order.spec.mjs'), 'utf8');
    assert.ok(spec.startsWith(GENERATED));
    assert.match(spec, /test\.use\(contextOptions\("clerk"\)\);/);
    assert.match(spec, /await test\.step\("S1 Delete the order", async \(\) => \{\n {8}await caw\.dialog\(\{"accept":true\}, \(\) => page\.getByRole/);
    assert.match(spec, /await caw\.check\("document\.title === 'Gone'"\);/);
    const support = readFileSync(join(dir, 'caw-support.mjs'), 'utf8');
    assert.match(support, /"url": "http:\/\/localhost:8080"/);
    assert.match(support, /"user": "CAW_CLERK_USER__CI"/);
    assert.match(support, /"clerk": "\.\.\/\.\.\/\.auth\/ci\/clerk\.json"/);
    assert.match(support, /"cawDir": "\.\.\/\.\."/);
    assert.match(support, /const PROBE = function anonymous\(given/);
    assert.match(support, /const EXTJS_ENGINE = null;/);
    assert.ok(!support.includes('/* caw:'), 'every marker replaced');
    const config = readFileSync(join(dir, 'playwright.config.mjs'), 'utf8');
    assert.match(config, /baseURL: process\.env\.CAW_BASE_URL \|\| "http:\/\/localhost:8080"/);
    assert.match(config, /trace: 'off'/, 'the sign-in fills the password: no trace keeps it');
    assert.doesNotMatch(config, /retain-on-failure/);
    assert.match(config, /locale: "de-DE",\n {8}timezoneId: "Europe\/Berlin",\n {8}viewport: \{"width":1280,"height":800\}/);
    writeFileSync(join(dir, 'playwright.config.mjs'), '// mine');
    assert.equal(exportTest(root, 'order', { env: 'local' }).kept, join(dir, 'playwright.config.mjs'));
    assert.equal(readFileSync(join(dir, 'playwright.config.mjs'), 'utf8'), '// mine');
});

test('exportTest: an ExtJS locator brings the engine along', (t) => {
    const root = project(t, { locator: "locator('extjs=button[text=\"Delete\"]')" });
    exportTest(root, 'order', { env: 'local' });
    assert.match(readFileSync(join(root, 'caw', 'export', 'playwright', 'caw-support.mjs'), 'utf8'), /const EXTJS_ENGINE = "\(function extjsEngine/);
});

test('exportTest: not recorded or stale is exit 4 work for record; a file someone else wrote stays; without --env the only fitting one', (t) => {
    assert.throws(() => exportTest(project(t, { recorded: false }), 'order', { env: 'local' }), (error) => error.code === 'replay-missing' && /S1/.test(error.message));
    assert.throws(() => exportTest(project(t, { stale: true }), 'order', { env: 'local' }), (error) => error.code === 'replay-stale' && /\(S1\).*caw record order@S1/.test(error.message));
    const root = project(t);
    mkdirSync(join(root, 'caw', 'export', 'playwright'), { recursive: true });
    writeFileSync(join(root, 'caw', 'export', 'playwright', 'order.spec.mjs'), '// my own test');
    assert.throws(() => exportTest(root, 'order', { env: 'local' }), (error) => error.code === 'usage');
    assert.equal(readFileSync(join(root, 'caw', 'export', 'playwright', 'order.spec.mjs'), 'utf8'), '// my own test');
    assert.throws(() => exportTest(project(t), 'order'), (error) => error.code === 'usage', 'two writable environments: name one');
    assert.ok(!existsSync(join(root, 'caw', 'export', 'playwright', 'caw-support.mjs')), 'nothing written before the refusal');
});
