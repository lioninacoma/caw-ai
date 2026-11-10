// Die Konsolenausgabe des Tools. Im Terminal mit Farben, Symbolen und Ergebnisblock; in Dateien und Pipes bleiben es
// schlichte, greifbare Zeilen mit [caw-ai] davor.

import { colorEnabled, painter } from './color.mjs';
import { t } from './i18n.mjs';

// Fehlertexte und Begruendungen koennen aus der Anwendung stammen. Im Terminal duerfen sie nichts steuern.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const safe = (text) => String(text).replace(CONTROL, '?');
const seconds = (value) => `${value.toFixed(1)}s`;
const MAX_FAILURES = 5;

// console erst beim Schreiben nachschlagen: So landet die Ausgabe auch dort, wo ein Test console.log ersetzt hat.
export const createUi = ({ fancy = colorEnabled(), out = (text) => console.log(text), err = (text) => console.error(text) } = {}) => {
    const paint = painter(fancy);
    const line = (symbol, color, text, write = out) => write(fancy ? `${color(symbol)} ${safe(text)}` : `[caw-ai] ${safe(text)}`);
    const STATUS = {
        pass: { symbol: '✓', title: 'PASS', color: paint.green },
        fail: { symbol: '✗', title: 'FAIL', color: paint.red },
        error: { symbol: '!', title: 'ERROR', color: paint.yellow },
    };

    return {
        info: (text) => line('›', paint.cyan, text),
        progress: (text) => line('⋯', paint.cyan, text, err),
        warn: (text, write = out) => line('!', paint.yellow, text, write),
        success: (text) => line('✓', paint.green, text),
        note: (text) => line('›', paint.yellow, text),
        /**
         * Abbruch: zuerst die Meldung, bei einem Aufruffehler die Kurzform des Befehls, zuletzt blass der Code fuer Suche und Doku.
         * @param synopsis etwa "caw-ai fix <test> <S4> [--target <umgebung>]"
         */
        fatal: (code, text, { synopsis, exit } = {}) => {
            err(fancy ? `${paint.red('✗')} ${safe(text)}` : `[caw-ai] ${safe(text)}`);
            if (synopsis !== undefined) err(`${fancy ? ' ' : '[caw-ai]'} ${t('cli.usageLine', { synopsis })}`);
            const tag = t('cli.errorCode', { code, exit: exit ?? '?' });
            err(fancy ? `  ${paint.dim(tag)}` : `[caw-ai] ${tag}`);
        },

        /** Kopf eines einzelnen Laufs: Was laeuft wo, und wer steuert. */
        header: ({ mode, test, target, source, maxSteps }) => {
            if (!fancy) {
                out(`[caw-ai] ${mode}: ${test} ${t('cli.uiOn')} ${target}`);
                return;
            }
            out('');
            out(`${paint.magenta('◆')} ${paint.bold(safe(test))} ${paint.dim(t('cli.uiOn'))} ${safe(target)}`);
            const details = [mode, source === 'watch' ? t('cli.uiLocal') : t('cli.uiDeployed')];
            if (maxSteps !== undefined) details.push(t('cli.uiMaxSteps', { count: maxSteps }));
            out(`  ${paint.dim(details.map(safe).join(' · '))}`);
        },

        step: ({ number, total, label, elapsed }) => {
            if (!fancy) {
                out(`[+${seconds(elapsed)}] ${number}/${total} ${safe(label)}`);
                return;
            }
            const width = String(total).length;
            out(`  ${paint.dim(`${String(number).padStart(width)}/${total}`)} ${safe(label)} ${paint.dim(`+${seconds(elapsed)}`)}`);
        },

        /** Der Ergebnisblock. Ohne rechten Rand: Lange Texte duerfen umbrechen, ohne dass der Rahmen zerfaellt. */
        verdict: ({ status, reason, note, testId, target, expectations = [], results = [], failures = [], warnings = [] }, { report, reportUrl, elapsed }) => {
            const { symbol, title, color } = STATUS[status];
            if (!fancy) {
                out(`[caw-ai] ${testId} ${t('cli.uiOn')} ${target}: ${status}${reason ? ` (${safe(reason)})` : ''}`);
                if (warnings.length > 0) out(`[caw-ai] ${t('cli.uiWarnings', { count: warnings.length })}`);
                out(`[caw-ai] ${t('cli.uiReport')} ${report}`);
                return;
            }
            const bar = color('│');
            out('');
            out(`${color('╭─')} ${color(paint.bold(`${symbol} ${title}`))} ${paint.dim(`${safe(testId)} ${t('cli.uiOn')} ${safe(target)} · ${seconds(elapsed)}`)}`);
            if (reason) out(`${bar} ${safe(reason)}`);
            for (const { id, text } of expectations) {
                const item = results.find((candidate) => candidate.id === id);
                if (item === undefined) continue;
                const { symbol: mark, color: markColor } = STATUS[item.status];
                out(`${bar} ${markColor(mark)} ${paint.bold(id)} ${safe(text)}`);
                if (item.status !== 'pass' && item.note) out(`${bar}     ${paint.dim(safe(item.note))}`);
            }
            for (const failure of failures.slice(0, MAX_FAILURES)) out(`${bar} ${paint.red('✗')} ${safe(failure.type)}: ${safe(failure.text)}`);
            if (failures.length > MAX_FAILURES) out(`${bar} ${paint.dim(t('cli.uiMoreFailures', { count: failures.length - MAX_FAILURES }))}`);
            if (warnings.length > 0) out(`${bar} ${paint.dim(t('cli.uiWarningsShort', { count: warnings.length }))}`);
            if (note) out(`${bar} ${paint.dim(safe(note))}`);
            out(`${color('╰─')} ${paint.dim(t('cli.uiReport'))} ${report}`);
            // Zum Anklicken im Terminal; der relative Pfad darueber bleibt lesbar.
            if (reportUrl !== undefined) out(`   ${paint.dim(reportUrl)}`);
        },

        /**
         * Die Tabelle nach mehreren Laeufen: je Test eine Zeile mit Ausgang, Dauer und Grund.
         * @param rows [{ test, exit, seconds, note }]; exit wie EXIT (0 pass, 1 fail, 2 error, 3 abgelehnt, 4 Aufnahme noetig)
         */
        batch: ({ target, rows }) => {
            const LABEL = { 0: 'pass', 1: 'fail', 2: 'error', 3: 'rejected', 4: 'needsRecording' };
            const look = {
                pass: STATUS.pass,
                fail: STATUS.fail,
                error: STATUS.error,
                rejected: { symbol: '-', color: paint.dim },
                needsRecording: { symbol: '?', color: paint.yellow },
            };
            const titles = rows.map(({ exit }) => t(`cli.batchStatus.${LABEL[exit]}`));
            const width = Math.max(...titles.map((title) => title.length));
            const nameWidth = Math.max(...rows.map(({ test }) => test.length));
            if (fancy) out('');
            out(fancy ? `${paint.magenta('◆')} ${paint.bold(t('cli.batchHeading', { count: rows.length, target }))}` : `[caw-ai] ${t('cli.batchHeading', { count: rows.length, target })}`);
            rows.forEach(({ test, exit, seconds: took, note }, index) => {
                const { symbol, color } = look[LABEL[exit]];
                const time = took === undefined ? '' : seconds(took);
                const text = `${titles[index].padEnd(width)}  ${safe(test).padEnd(nameWidth)}  ${time.padStart(7)}${note ? `  ${safe(note)}` : ''}`;
                out(fancy ? `  ${color(symbol)} ${text}` : `[caw-ai] ${text}`);
            });
        },

        heading: (text) => {
            if (fancy) out('');
            out(fancy ? `${paint.magenta('◆')} ${paint.bold(safe(text))}` : `[caw-ai] ${safe(text)}`);
        },
    };
};
