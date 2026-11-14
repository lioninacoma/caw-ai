// The internal migration script (scripts/migrate-config.mjs) on the fictitious example of the spec (§8.7): the result is a valid
// 1.0 config, tests and recordings use the new names, caw/.env gets new names with the values untouched.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { migrateConfig, migrateProject, renameEnvText, targetMap } from '../scripts/migrate-config.mjs';
import { validateConfig } from '../src/shared/config.mjs';

const OLD = {
    language: 'de',
    framework: 'extjs',
    agent: { sandbox: 'docker' },
    sites: ['north', 'south'],
    environments: {
        dev: { urls: { north: 'https://portal-dev.north.example.test', south: 'https://portal-dev.south.example.test' }, claude: true, overlay: true, writable: true },
        test: { urls: { north: 'https://portal-test.north.example.test', south: 'https://portal-test.south.example.test' }, claude: true },
        prod: { urls: { north: 'https://portal.north.example.test', south: 'https://portal.south.example.test' }, production: true },
    },
    auth: { type: 'form', path: '/signin', userSelector: '#login_user', passwordSelector: '#login_password', signedInSelector: 'body.signed-in' },
    apps: {
        orders: { dir: 'apps/orders', startUrl: '/web/guest/orders', overlay: { url: 'http://localhost:1841/', start: 'pnpm run watch', statics: [{ name: 'Fx/Static.js', path: '../../packages/model/static.js' }] } },
        admin: { dir: 'apps/admin', startUrl: '/web/guest/admin', overlay: { url: 'http://localhost:1842/', start: 'pnpm run watch' } },
    },
    roles: { clerk: { loginEnv: 'CAW_LOGIN_CLERK', passwordEnv: 'CAW_PW_CLERK' }, lead: { loginEnv: 'LEAD_NAME', passwordEnv: 'LEAD_SECRET', totpEnv: 'LEAD_CODE' } },
    requestKeys: ['op'],
    assetUrlPattern: '[?&]url=repository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)',
    extraAllowedHosts: ['sso.north.example.test'],
    insecureTls: true,
    consoleIgnore: ['favicon'],
    maxSteps: 150,
};

test('migrateConfig: the spec example becomes a valid 1.0 config', () => {
    const { config, notes } = migrateConfig(OLD);
    assert.deepEqual(validateConfig(config).issues, []);
    assert.equal(config.start, '/web/guest/orders');
    assert.deepEqual(config.agent, { mode: 'docker' });
    assert.equal(config.signIn.type, 'form');
    assert.deepEqual(config.roles, { clerk: {}, lead: {} });
    assert.equal(config.maxActions, 150);
    assert.deepEqual(Object.keys(config.environments), ['north-dev', 'south-dev', 'north-test', 'south-test', 'north-prod', 'south-prod']);
    assert.deepEqual(config.environments['north-dev'], { url: 'https://portal-dev.north.example.test', claude: true, writable: true, insecureTls: true });
    assert.deepEqual(config.environments['south-dev'], { extends: 'north-dev', url: 'https://portal-dev.south.example.test' });
    assert.deepEqual(config.environments['north-prod'], { url: 'https://portal.north.example.test', production: true }, 'production gets no insecureTls');
    assert.deepEqual(config.environments['south-prod'], { extends: 'north-prod', url: 'https://portal.south.example.test', production: true }, 'production is not inherited');
    assert.deepEqual(config.overlay.environments, ['north-dev', 'south-dev']);
    assert.deepEqual(Object.keys(config.overlay.parts), ['orders', 'admin']);
    assert.equal(config.overlay.parts.orders.dir, 'apps/orders');
    assert.deepEqual(config.allowHosts, ['sso.north.example.test']);
    for (const removed of ['sites', 'auth', 'apps', 'extraAllowedHosts', 'insecureTls', 'assetUrlPattern', 'maxSteps']) assert.equal(config[removed], undefined, removed);
    assert.ok(notes.some((note) => /allowHosts/.test(note)));
    const map = targetMap(OLD);
    assert.deepEqual(map.get('south/dev'), ['south-dev']);
    assert.deepEqual(map.get('dev'), ['north-dev', 'south-dev']);
});

test('renameEnvText: names only, values and other lines untouched', () => {
    const { text, renamed } = renameEnvText('# accounts\nCAW_LOGIN_CLERK=a=b\r\nexport LEAD_NAME="x y"\nOTHER=1\n', { CAW_LOGIN_CLERK: 'CAW_CLERK_USER', LEAD_NAME: 'CAW_LEAD_USER' });
    assert.equal(text, '# accounts\nCAW_CLERK_USER=a=b\r\nexport CAW_LEAD_USER="x y"\nOTHER=1\n');
    assert.deepEqual(renamed, ['CAW_LOGIN_CLERK → CAW_CLERK_USER', 'LEAD_NAME → CAW_LEAD_USER']);
});

test('migrateProject: config, tests, recordings, caw/.env, sessions, skill and .mcp.json; --dry-run changes nothing', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-migrate-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(OLD, null, 4));
    mkdirSync(join(root, 'caw', 'tests'), { recursive: true });
    mkdirSync(join(root, 'caw', 'recordings'), { recursive: true });
    const plan = '# close a case\nid: close-case\napp: admin\nrole: lead\ntargets: [north/dev, south/dev]\nmutates: true\nalso: [orders]\nsteps:\n  - id: S1\n    name: Open\n    do: Open it.\n    expect: It is open.\n';
    writeFileSync(join(root, 'caw', 'tests', 'close-case.yaml'), plan);
    writeFileSync(join(root, 'caw', 'recordings', 'close-case.yaml'), 'test: close-case\nsteps:\n  - id: S1\n    recording:\n      recordedOn: south/dev\n      actions:\n        - {wait-ready: {store: cases, minCount: 1}}\n');
    writeFileSync(join(root, 'caw', '.env'), 'CAW_LOGIN_CLERK=c\nCAW_PW_CLERK=p\nLEAD_CODE=k\n');
    mkdirSync(join(root, 'caw', '.auth', 'north', 'dev'), { recursive: true });
    writeFileSync(join(root, 'caw', '.auth', 'north', 'dev', 'clerk.json'), '{}');
    mkdirSync(join(root, '.claude', 'skills', 'caw-ai'), { recursive: true });
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, 'caw-ai': { command: 'npx', args: ['caw-ai', 'mcp'] } } }));

    const before = readFileSync(join(root, 'caw.config.json'), 'utf8');
    const dry = migrateProject(root, { dryRun: true });
    assert.ok(dry.length > 3);
    assert.equal(readFileSync(join(root, 'caw.config.json'), 'utf8'), before, 'dry run writes nothing');

    const report = migrateProject(root);
    assert.ok(!report.join('\n').includes('=c') && !report.join('\n').includes('=p'), 'never values');
    const testText = readFileSync(join(root, 'caw', 'tests', 'close-case.yaml'), 'utf8');
    assert.match(testText, /^# close a case/);
    assert.match(testText, /start: \/web\/guest\/admin/);
    assert.match(testText, /writes: true/);
    assert.match(testText, /environments: \[ north-dev, south-dev \]/);
    assert.doesNotMatch(testText, /app:|targets:|mutates:|also:/);
    const recording = readFileSync(join(root, 'caw', 'recordings', 'close-case.yaml'), 'utf8');
    assert.match(recording, /recordedOn: south-dev/);
    assert.match(recording, /wait-ready: \{ for: cases, minCount: 1 \}/);
    assert.equal(readFileSync(join(root, 'caw', '.env'), 'utf8'), 'CAW_CLERK_USER=c\nCAW_CLERK_PASSWORD=p\nCAW_LEAD_TOTP=k\n');
    assert.ok(existsSync(join(root, 'caw', '.auth', 'north-dev', 'clerk.json')));
    assert.ok(!existsSync(join(root, 'caw', '.auth', 'north')));
    assert.ok(!existsSync(join(root, '.claude', 'skills', 'caw-ai')));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers), ['other', 'caw']);
    assert.deepEqual(validateConfig(JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'))).issues, []);
});
