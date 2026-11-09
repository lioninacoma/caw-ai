// Was der Agent am Browser darf, abschliessend aufgezaehlt. Er bekommt nie CDP, denn damit liesse sich
// die Host-Sperre umgehen (z. B. ein neuer Browser-Kontext mit eigenem Proxy).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { evaluateFinish } from '../shared/report.mjs';
import { passwordValues, redactDeep } from './secrets.mjs';

const ACTION_TIMEOUT_MS = 15_000;
const NETWORK_SHOWN = 60;
// Druecken und Loslassen wie bei einem Menschen: Oberflaechen reagieren teils zeitversetzt auf das Druecken.
export const CLICK_DELAY_MS = 100;
const COMMAND_TIMEOUT_MS = 300_000;
const SCREENSHOT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.png$/;
const ARIA_REF = /^(f\d+)?e\d+$/;
const REMEMBER_NAME = /^[A-Za-z][A-Za-z0-9]{0,30}$/;
// Kurze Werte kaemen auch in fremden Texten vor und wuerden dort mit ersetzt.
const REMEMBER_MIN_LENGTH = 4;

const usage = (message) => new CawError('usage', message);

const text = (command, field) => {
    const value = command[field];
    if (typeof value !== 'string' || value === '') throw usage(t('run.agent.missing', { field }));
    return value;
};

/** Navigation nur zu den Hosts, die auch die Chrome-Sperre durchlaesst. */
export const isAllowedUrl = (url, hosts) => {
    try {
        const { protocol, hostname } = new URL(url);
        return ['http:', 'https:'].includes(protocol) && hosts.includes(hostname);
    } catch {
        return false;
    }
};

/** Referenz aus dem Snapshot oder CSS-Selektor. */
export const locatorFor = (page, target) => page.locator(ARIA_REF.test(target) ? `aria-ref=${target}` : target);

export const createAgentHandler = ({ session, run, hosts, agentDir, onVerdict, commandTimeoutMs = COMMAND_TIMEOUT_MS }) => {
    const screenshots = new Set();
    let finished = false;

    const locate = (command) => locatorFor(session.page(), text(command, 'target'));

    const commands = {
        task: () => run,
        snapshot: () => session.page().ariaSnapshot({ mode: 'ai' }),
        url: () => session.page().url(),
        click: async (command) => { await locate(command).click({ timeout: ACTION_TIMEOUT_MS, delay: CLICK_DELAY_MS }); return 'ok'; },
        // Leer ist erlaubt: So leert man ein Feld unabhaengig davon, was gerade drinsteht. Ein Klick aufs X scheitert, wenn es leer ist.
        fill: async (command) => {
            if (typeof command.value !== 'string') throw usage(t('run.agent.missing', { field: 'value' }));
            await locate(command).fill(command.value, { timeout: ACTION_TIMEOUT_MS });
            return 'ok';
        },
        type: async (command) => { await locate(command).pressSequentially(text(command, 'value'), { timeout: ACTION_TIMEOUT_MS }); return 'ok'; },
        press: async (command) => { await session.page().keyboard.press(text(command, 'key')); return 'ok'; },
        eval: (command) => session.page().evaluate(text(command, 'code')),
        // Eine Pruefung, die sich wiederholen laesst. Bestanden ist nur genau true, nicht irgendetwas Wahres.
        check: async (command) => {
            const id = text(command, 'id');
            if (!run.expectations.some((expectation) => expectation.id === id)) throw new CawError('step-unknown', t('run.agent.unknownStep', { id }));
            const value = await session.page().evaluate(text(command, 'code'));
            await session.workbench?.step(id, value === true ? 'pass' : 'running');
            return { id, pass: value === true, value };
        },
        // Ein Wert, den erst der Lauf erzeugt. Die Aufzeichnung speichert den Ausdruck statt des Werts.
        remember: async (command) => {
            const name = text(command, 'name');
            if (!REMEMBER_NAME.test(name) || name === 'runTag' || name === 'runTagLower') throw usage(t('run.agent.rememberName'));
            const raw = await session.page().evaluate(text(command, 'code'));
            const value = typeof raw === 'number' ? String(raw) : raw;
            if (typeof value !== 'string' || value.trim().length < REMEMBER_MIN_LENGTH) throw usage(t('run.agent.rememberValue', { name, min: REMEMBER_MIN_LENGTH, raw: JSON.stringify(raw) }));
            return { name, value: value.trim() };
        },
        screenshot: async (command) => {
            const name = text(command, 'name');
            if (!SCREENSHOT_NAME.test(name)) throw usage(t('run.agent.screenshotName'));
            const image = await session.page().screenshot();
            // Neu anlegen statt ueberschreiben, der Ordner gehoert dem Container.
            writeFileSync(join(agentDir, name), image, { flag: 'wx' });
            screenshots.add(name);
            return name;
        },
        goto: async (command) => {
            const url = text(command, 'url');
            if (!isAllowedUrl(url, hosts)) throw new CawError('target-denied', t('run.agent.targetDenied', { url }));
            await session.page().goto(url);
            return session.page().url();
        },
        reload: async () => { await session.page().reload(); return session.page().url(); },
        'wait-ready': (command) => session.waitReady({
            ...(typeof command.store === 'string' ? { store: command.store } : {}),
            ...(Number.isFinite(command.minCount) ? { minCount: command.minCount } : {}),
            ...(Number.isFinite(command.timeout) ? { timeout: command.timeout } : {}),
        }),
        console: () => session.drainFailures(),
        // Die letzten Requests der Anwendung mit Ausgang und Dauer, ohne Parameterwerte: Belege, ob es an der Anwendung liegt.
        network: () => (session.network === undefined ? [] : session.network.since(Math.max(0, session.network.mark() - NETWORK_SHOWN))),
        finish: (command) => {
            if (typeof command.results !== 'object' || command.results === null) throw new CawError('finish-rejected', t('run.agent.resultMissing'));
            const outcome = evaluateFinish({
                expectations: run.expectations,
                results: command.results,
                failures: session.failures(),
                // Nur was das Tool selbst aufgenommen hat, zaehlt als Screenshot.
                fileExists: (name) => screenshots.has(name),
            });
            finished = true;
            onVerdict(outcome);
            return { status: outcome.status };
        },
    };

    // Befehle, deren Antwort Text der Seite enthalten kann; die uebrigen liefern nur ok, eine Adresse oder einen Dateinamen.
    const PAGE_TEXT = new Set(['snapshot', 'eval', 'check', 'remember', 'console']);
    // Kein Passwort erreicht Claude: weder ueber den Snapshot (er enthaelt Feldwerte) noch ueber eval, check oder remember.
    const hideSecrets = async (value) => {
        const onPage = await (async () => session.page().evaluate(passwordValues))().catch(() => []);
        const secrets = [...(session.secrets?.() ?? []), ...(Array.isArray(onPage) ? onPage : [])];
        return secrets.length === 0 ? value : redactDeep(value, secrets);
    };

    return async (command) => {
        if (finished) throw new CawError('run-finished', t('run.agent.finished'));
        if (typeof command !== 'object' || command === null || !Object.hasOwn(commands, command.action)) {
            throw new CawError('unknown-command', t('run.agent.unknownCommand', { action: String(command?.action) }));
        }
        let timer;
        const limit = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new CawError('command-timeout', t('run.agent.timeout', { action: command.action }))), commandTimeoutMs);
        });
        try {
            const result = await Promise.race([commands[command.action](command), limit]);
            return PAGE_TEXT.has(command.action) ? await hideSecrets(result) : result;
        } finally {
            clearTimeout(timer);
        }
    };
};
