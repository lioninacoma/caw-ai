// Writes caw-ai project files into a framework test project: config, test plans and recordings by hand, as `record` would write
// them. So `caw-ai run` runs against every variant without Claude and without a token.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stepHash } from '../../src/host/test-file.mjs';

const yamlString = (value) => JSON.stringify(value);

/**
 * @param root      project folder
 * @param framework web | react | vue | angular
 * @param url       address of the environment
 * @param build     expected text after "Build:" (dev, deployed, local)
 * @param embed     true: additionally S3 with an iframe and a web component (only react-vite has both)
 * @param overlay   app config for the overlay ({ build, dev, buildCommand, devCommand }); the environment then allows it
 */
export const writeProject = (root, { framework, url, build, overlay, embed = false }) => {
    const config = {
        language: 'en',
        framework,
        environments: { test: { url, claude: true, writable: true, ...(overlay ? { overlay: true } : {}) } },
        auth: { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#password', signedInSelector: '[data-testid=user-menu]' },
        apps: { web: { dir: '.', startUrl: '/', ...(overlay ? { overlay } : {}) } },
        roles: { tester: { loginEnv: 'CAW_LOGIN_TESTER', passwordEnv: 'CAW_PW_TESTER' } },
        ...(url.startsWith('https:') ? { insecureTls: true } : {}),
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
                { click: { role: 'button', name: 'New ticket' }, path: '/' },
                { fill: { role: 'textbox', name: 'Title', inside: { role: 'dialog', name: 'New ticket' } }, value: 'Monitor {{runTag}}', path: '/' },
                { click: { role: 'button', name: 'Create', inside: { role: 'dialog', name: 'New ticket' } }, path: '/' },
                { 'wait-ready': {} },
            ],
            check: `(()=>{const s=document.querySelector('[role=status]');const b=document.querySelector('[data-testid=build]');return !!s&&/^Ticket #\\d+ created$/.test(s.textContent.trim())&&b.textContent.trim()==='Build: ${build}'&&[...document.querySelectorAll('table[aria-label="Ticket list"] tbody tr')].some(r=>r.cells[1].textContent.trim()==='Monitor {{runTag}}');})()`,
        },
        {
            id: 'S2', name: 'Open info', do: 'Open Info in the navigation.', expect: 'The info page shows, with the same build.',
            actions: [
                { click: { role: 'link', name: 'Info', inside: { role: 'navigation', name: 'Main navigation' } }, path: '/' },
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
            actions: [{ click: { role: 'button', name: 'Trigger error' }, path: '/' }, { 'wait-ready': {} }],
            check: 'true',
        },
    ]);
};

// A field and a button in an iframe (target with `frame`) and in a web component with an open shadow root.
const PAYMENT = { tag: 'iframe', name: 'Payment' };
const EMBED_STEP = {
    id: 'S3', name: 'Pay and rate', do: 'Pay 12 euros in the Payment area and rate it "Good".', expect: 'Payment and rating are confirmed.',
    actions: [
        { click: { role: 'link', name: 'Tickets', inside: { role: 'navigation', name: 'Main navigation' } }, path: '/info' },
        { fill: { role: 'textbox', name: 'Amount', inside: { role: 'form', name: 'Card' }, frame: PAYMENT }, value: '12', path: '/' },
        { click: { role: 'button', name: 'Pay', inside: { role: 'form', name: 'Card' }, frame: PAYMENT }, path: '/' },
        { fill: { role: 'textbox', name: 'Comment', inside: { role: 'group', name: 'Rating' } }, value: 'Good', path: '/' },
        { click: { role: 'button', name: 'Rate', inside: { role: 'group', name: 'Rating' } }, path: '/' },
        { 'wait-ready': {} },
    ],
    check: `document.querySelector('iframe[title=Payment]')?.contentDocument?.querySelector('[role=status]')?.textContent.trim()==='Payment of 12 EUR confirmed'&&document.querySelector('caw-rating')?.shadowRoot?.querySelector('[role=status]')?.textContent.trim()==='Thanks for your rating: Good'`,
};

const renderTarget = (target) => `{${Object.entries(target).map(([key, value]) => `${key}: ${typeof value === 'object' ? renderTarget(value) : yamlString(value)}`).join(', ')}}`;

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
            `    hash: ${stepHash(step)}`,
            ...(index === 0 ? [] : [`    after: ${steps[index - 1].id}`]),
            '    recordedOn: test',
            '    recordedAt: 2026-11-09T10:00:00.000Z',
            '    actions:',
            ...step.actions.flatMap((action) => {
                const [name, payload] = Object.entries(action)[0];
                const head = `      - ${name}: ${renderTarget(payload)}`;
                return [head, ...Object.entries(action).slice(1).map(([key, value]) => `        ${key}: ${yamlString(value)}`)];
            }),
            `    check: ${yamlString(step.check)}`,
        ]),
    ];
    writeFileSync(join(root, 'caw/recordings', `${id}.yaml`), `${recording.join('\n')}\n`);
};
