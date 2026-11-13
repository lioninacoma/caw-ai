// Writes caw-ai project files into a framework test project: config, test plans and recordings by hand, as `record` would write
// them. So `caw run` runs against every variant without Claude and without a token.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stepHash } from '../../src/host/test-file.mjs';

const yamlString = (value) => JSON.stringify(value);
// Targets are Playwright locators as code, as `record` writes them (one string per target, scoped by dialog or navigation).
const NEW_TICKET = "getByRole('dialog', { name: 'New ticket' })";
const NAVIGATION = "getByRole('navigation', { name: 'Main navigation' })";

/**
 * @param root      project folder
 * @param framework web | react | vue | angular
 * @param url       address of the environment
 * @param build     expected text after "Build:" (dev, deployed, local)
 * @param embed     true: additionally S3 with an iframe and a web component (only react-vite has both)
 * @param overlay   the part's sources ({ build, url, start }); then overlay.environments allows the environment
 */
export const writeProject = (root, { framework, url, build, overlay, embed = false }) => {
    const config = {
        language: 'en',
        framework,
        environments: { test: { url, claude: true, writable: true, ...(url.startsWith('https:') ? { insecureTls: true } : {}) } },
        auth: { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#password', signedInSelector: '[data-testid=user-menu]' },
        apps: { web: { startUrl: '/' } },
        ...(overlay ? { overlay: { environments: ['test'], parts: { web: { dir: '.', ...overlay } } } } : {}),
        roles: { tester: { loginEnv: 'CAW_LOGIN_TESTER', passwordEnv: 'CAW_PW_TESTER' } },
    };
    writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify(config, null, 4)}\n`);
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    mkdirSync(join(root, 'caw/recordings'), { recursive: true });
    writeFileSync(join(root, 'caw/.env'), 'CAW_LOGIN_TESTER=tester@example.com\nCAW_PW_TESTER=secret\n');
    rmSync(join(root, 'caw/.auth'), { recursive: true, force: true });
    writeTest(root, 'smoke', {}, [
        {
            id: 'S1', name: 'Create ticket', do: 'Create a ticket "Monitor {{runTag}}".', expect: 'The ticket is in the list, the build is right.',
            actions: [
                { click: "getByRole('button', { name: 'New ticket', exact: true })", path: '/' },
                { fill: `${NEW_TICKET}.getByRole('textbox', { name: 'Title', exact: true })`, value: 'Monitor {{runTag}}', path: '/' },
                { click: `${NEW_TICKET}.getByRole('button', { name: 'Create', exact: true })`, path: '/' },
                { 'wait-ready': {} },
            ],
            check: `(()=>{const s=document.querySelector('[role=status]');const b=document.querySelector('[data-testid=build]');return !!s&&/^Ticket #\\d+ created$/.test(s.textContent.trim())&&b.textContent.trim()==='Build: ${build}'&&[...document.querySelectorAll('table[aria-label="Ticket list"] tbody tr')].some(r=>r.cells[1].textContent.trim()==='Monitor {{runTag}}');})()`,
        },
        {
            id: 'S2', name: 'Open info', do: 'Open Info in the navigation.', expect: 'The info page shows, with the same build.',
            actions: [
                { click: `${NAVIGATION}.getByRole('link', { name: 'Info', exact: true })`, path: '/' },
                { 'wait-ready': {} },
            ],
            // The info page is a lazy chunk: with local code it must come from the local build as well.
            check: `location.pathname==='/info'&&document.querySelector('h1')?.textContent.trim()==='Info'&&document.querySelector('[data-testid=build-info]')?.textContent.trim()==='Build: ${build}'`,
        },
        ...(embed ? [EMBED_STEP] : []),
    ]);
    writeTest(root, 'error', { mutates: false }, [
        {
            id: 'S1', name: 'Trigger error', do: 'Click "Trigger error".', expect: 'Nothing happens.',
            actions: [{ click: "getByRole('button', { name: 'Trigger error', exact: true })", path: '/' }, { 'wait-ready': {} }],
            check: 'true',
        },
    ]);
};

// A field and a button in an iframe (the locator goes through contentFrame()) and in a web component with an open shadow root.
const PAYMENT = "locator('iframe[title=\"Payment\"]').contentFrame().getByRole('form', { name: 'Card' })";
const RATING = "getByRole('group', { name: 'Rating' })";
const EMBED_STEP = {
    id: 'S3', name: 'Pay and rate', do: 'Pay 12 euros in the Payment area and rate it "Good".', expect: 'Payment and rating are confirmed.',
    actions: [
        { click: `${NAVIGATION}.getByRole('link', { name: 'Tickets', exact: true })`, path: '/info' },
        { fill: `${PAYMENT}.getByRole('textbox', { name: 'Amount', exact: true })`, value: '12', path: '/' },
        { click: `${PAYMENT}.getByRole('button', { name: 'Pay', exact: true })`, path: '/' },
        { fill: `${RATING}.getByRole('textbox', { name: 'Comment', exact: true })`, value: 'Good', path: '/' },
        { click: `${RATING}.getByRole('button', { name: 'Rate', exact: true })`, path: '/' },
        { 'wait-ready': {} },
    ],
    check: `document.querySelector('iframe[title=Payment]')?.contentDocument?.querySelector('[role=status]')?.textContent.trim()==='Payment of 12 EUR confirmed'&&document.querySelector('caw-rating')?.shadowRoot?.querySelector('[role=status]')?.textContent.trim()==='Thanks for your rating: Good'`,
};

const writeTest = (root, id, { mutates = true }, steps) => {
    const plan = [
        `id: ${id}`, 'app: web', 'role: tester', 'targets: [test]', `mutates: ${mutates}`, 'steps:',
        ...steps.flatMap((step) => [`  - id: ${step.id}`, `    name: ${yamlString(step.name)}`, `    do: ${yamlString(step.do)}`, `    expect: ${yamlString(step.expect)}`]),
    ];
    writeFileSync(join(root, 'caw/tests', `${id}.yaml`), `${plan.join('\n')}\n`);
    const recording = [
        '# Written by hand for the framework matrix.', `test: ${id}`, 'steps:',
        ...steps.flatMap((step, index) => [
            `  - id: ${step.id}`,
            `    hash: ${yamlString(stepHash(step))}`,
            ...(index === 0 ? [] : [`    after: ${steps[index - 1].id}`]),
            '    recordedOn: test',
            '    recordedAt: 2026-11-09T10:00:00.000Z',
            '    locale: en-US',
            '    timezone: Europe/Berlin',
            '    actions:',
            ...step.actions.flatMap((action) => {
                const [name, payload] = Object.entries(action)[0];
                const head = `      - ${name}: ${yamlString(payload)}`;
                return [head, ...Object.entries(action).slice(1).map(([key, value]) => `        ${key}: ${yamlString(value)}`)];
            }),
            `    check: ${yamlString(step.check)}`,
        ]),
    ];
    writeFileSync(join(root, 'caw/recordings', `${id}.yaml`), `${recording.join('\n')}\n`);
};
