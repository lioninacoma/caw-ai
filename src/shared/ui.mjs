// Die Konsolenausgabe des Tools. Im Terminal mit Farben, Symbolen und Ergebnisblock; in Dateien und Pipes bleiben es
// schlichte, greifbare Zeilen mit [caw-ai] davor.

import { colorEnabled, painter } from './color.mjs';
import { t } from './i18n.mjs';

// Fehlertexte und Begruendungen koennen aus der Anwendung stammen. Im Terminal duerfen sie nichts steuern.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const safe = (text) => String(text).replace(CONTROL, '?');
const seconds = (value) => `${value.toFixed(1)}s`;
const MAX_FAILURES = 5;

export const createUi = ({ fancy = colorEnabled(), out = console.log, err = console.error } = {}) => {
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
        fatal: (code, text) => err(fancy ? `${paint.red(`✗ ${code}:`)} ${safe(text)}` : `[caw-ai] ${code}: ${safe(text)}`),

        /** Kopf eines einzelnen Laufs: Was laeuft wo, und wer steuert. */
        /** `code` ist die Zeile "Code: …" (describeCode); sie steht immer da, auch ohne Terminal. */
        header: ({ mode, test, target, source, code, maxSteps }) => {
            const codeLine = t('cli.uiCode', { code: code ?? (source === 'watch' ? t('cli.uiLocal') : t('cli.uiDeployed')) });
            if (!fancy) {
                out(`[caw-ai] ${mode}: ${test} ${t('cli.uiOn')} ${target}`);
                out(`[caw-ai] ${safe(codeLine)}`);
                return;
            }
            out('');
            out(`${paint.magenta('◆')} ${paint.bold(safe(test))} ${paint.dim(t('cli.uiOn'))} ${safe(target)}`);
            const details = [mode];
            if (maxSteps !== undefined) details.push(t('cli.uiMaxSteps', { count: maxSteps }));
            out(`  ${paint.dim(details.map(safe).join(' · '))}`);
            out(`  ${paint.dim(safe(codeLine))}`);
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
        verdict: ({ status, reason, note, testId, target, expectations = [], results = [], failures = [], warnings = [] }, { report, elapsed }) => {
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
        },

        heading: (text) => {
            if (fancy) out('');
            out(fancy ? `${paint.magenta('◆')} ${paint.bold(safe(text))}` : `[caw-ai] ${safe(text)}`);
        },
    };
};
