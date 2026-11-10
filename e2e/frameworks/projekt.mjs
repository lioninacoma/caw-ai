// Schreibt caw-ai-Projektdateien in ein Framework-Testprojekt: Config, Testplaene und Aufzeichnungen von Hand, wie sie `record`
// schreiben wuerde. So laeuft `caw-ai run` ohne Claude und ohne Token gegen jede Variante.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stepHash } from '../../src/host/test-file.mjs';

const yamlString = (value) => JSON.stringify(value);

/**
 * @param root      Projektordner
 * @param framework web | react | vue | angular
 * @param url       Adresse der Umgebung
 * @param build     erwarteter Text hinter "Build:" (dev, deployed, local)
 * @param embed     true: zusaetzlich S3 mit iframe und Web Component (nur react-vite hat beides)
 * @param local     { build }: lokaler Build-Ordner (`localBuild`), oder { pattern, statics }: einzelne Dateien per assetUrlPattern
 */
export const writeProject = (root, { framework, url, build, local, embed = false }) => {
    const config = {
        language: 'de',
        framework,
        environments: { test: { url, claude: true, writable: true, ...(local ? { overlay: true } : {}) } },
        auth: { type: 'form', path: '/login', userSelector: '#email', passwordSelector: '#password', signedInSelector: '[data-testid=user-menu]' },
        apps: { web: { dir: '.', startUrl: '/', ...(local?.statics ? { statics: local.statics } : {}), ...(local?.build ? { localBuild: local.build } : {}) } },
        roles: { tester: { loginEnv: 'CAW_LOGIN_TESTER', passwordEnv: 'CAW_PW_TESTER' } },
        ...(local?.pattern ? { assetUrlPattern: local.pattern } : {}),
        ...(url.startsWith('https:') ? { insecureTls: true } : {}),
    };
    writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify(config, null, 4)}\n`);
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    mkdirSync(join(root, 'caw/recordings'), { recursive: true });
    writeFileSync(join(root, 'caw/.env'), 'CAW_LOGIN_TESTER=tester@example.com\nCAW_PW_TESTER=geheim\n');
    rmSync(join(root, 'caw/.auth'), { recursive: true, force: true });
    writeTest(root, 'smoke', {}, [
        {
            id: 'S1', name: 'Ticket anlegen', do: 'Lege ein Ticket "Monitor {{runTag}}" an.', expect: 'Das Ticket steht in der Liste, Build stimmt.',
            actions: [
                { click: { role: 'button', name: 'Neues Ticket' }, path: '/' },
                { fill: { role: 'textbox', name: 'Titel', inside: { role: 'dialog', name: 'Neues Ticket' } }, value: 'Monitor {{runTag}}', path: '/' },
                { click: { role: 'button', name: 'Anlegen', inside: { role: 'dialog', name: 'Neues Ticket' } }, path: '/' },
                { 'wait-ready': {} },
            ],
            check: `(()=>{const s=document.querySelector('[role=status]');const b=document.querySelector('[data-testid=build]');return !!s&&/^Ticket #\\d+ angelegt$/.test(s.textContent.trim())&&b.textContent.trim()==='Build: ${build}'&&[...document.querySelectorAll('table[aria-label=Ticketliste] tbody tr')].some(r=>r.cells[1].textContent.trim()==='Monitor {{runTag}}');})()`,
        },
        {
            id: 'S2', name: 'Info oeffnen', do: 'Oeffne Info in der Navigation.', expect: 'Die Info-Seite ist zu sehen, mit demselben Build.',
            actions: [
                { click: { role: 'link', name: 'Info', inside: { role: 'navigation', name: 'Hauptnavigation' } }, path: '/' },
                { 'wait-ready': {} },
            ],
            // Die Info-Seite ist ein lazy Chunk: Mit lokalem Code muss auch er aus dem lokalen Build kommen.
            check: `location.pathname==='/info'&&document.querySelector('h1')?.textContent.trim()==='Info'&&document.querySelector('[data-testid=build-info]')?.textContent.trim()==='Build: ${build}'`,
        },
        ...(embed ? [EMBED_STEP] : []),
    ]);
    writeTest(root, 'fehler', { mutates: false }, [
        {
            id: 'S1', name: 'Fehler ausloesen', do: 'Klicke "Fehler auslösen".', expect: 'Nichts passiert.',
            actions: [{ click: { role: 'button', name: 'Fehler auslösen' }, path: '/' }, { 'wait-ready': {} }],
            check: 'true',
        },
    ]);
};

// Ein Feld und ein Knopf in einem iframe (Ziel mit `frame`) und in einer Web Component mit offenem Shadow Root.
const PAYMENT = { tag: 'iframe', name: 'Zahlung' };
const EMBED_STEP = {
    id: 'S3', name: 'Zahlen und bewerten', do: 'Zahle 12 Euro im Bereich Zahlung und bewerte mit "Gut".', expect: 'Zahlung und Bewertung sind bestätigt.',
    actions: [
        { click: { role: 'link', name: 'Tickets', inside: { role: 'navigation', name: 'Hauptnavigation' } }, path: '/info' },
        { fill: { role: 'textbox', name: 'Betrag', inside: { role: 'form', name: 'Karte' }, frame: PAYMENT }, value: '12', path: '/' },
        { click: { role: 'button', name: 'Bezahlen', inside: { role: 'form', name: 'Karte' }, frame: PAYMENT }, path: '/' },
        { fill: { role: 'textbox', name: 'Kommentar', inside: { role: 'group', name: 'Bewertung' } }, value: 'Gut', path: '/' },
        { click: { role: 'button', name: 'Bewerten', inside: { role: 'group', name: 'Bewertung' } }, path: '/' },
        { 'wait-ready': {} },
    ],
    check: `document.querySelector('iframe[title=Zahlung]')?.contentDocument?.querySelector('[role=status]')?.textContent.trim()==='Zahlung über 12 € bestätigt'&&document.querySelector('caw-bewertung')?.shadowRoot?.querySelector('[role=status]')?.textContent.trim()==='Danke für „Gut“'`,
};

const renderTarget = (target) => `{${Object.entries(target).map(([key, value]) => `${key}: ${typeof value === 'object' ? renderTarget(value) : yamlString(value)}`).join(', ')}}`;

const writeTest = (root, id, { mutates = true }, steps) => {
    const plan = [
        `id: ${id}`, 'app: web', 'role: tester', 'targets: [test]', `mutates: ${mutates}`, 'steps:',
        ...steps.flatMap((step) => [`  - id: ${step.id}`, `    name: ${yamlString(step.name)}`, `    do: ${yamlString(step.do)}`, `    expect: ${yamlString(step.expect)}`]),
    ];
    writeFileSync(join(root, 'caw/tests', `${id}.yaml`), `${plan.join('\n')}\n`);
    const recording = [
        '# Von Hand fuer die Framework-Matrix geschrieben.', `test: ${id}`, 'steps:',
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
