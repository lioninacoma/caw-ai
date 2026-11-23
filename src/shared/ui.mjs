// The tool's console output in Graphite: fixed colours and plain marks (✓ ! ✕ ○ ?), sections as rules (── 1 ANMELDEN ───),
// results in a box (┌─┤ ERGEBNIS ├─┐).
// A run reads like the workbench: the head "● caw · Context-Aware Web Testing · <version>", the mode in bold, the "Run ───" rule,
// one line per step (✓ S1  name, its duration dim in a right-aligned column, "not reached" for an open step), a failure as
// "└ reason" under the step's name, the summary "Failed. 2 of 4 steps passed. 1 warning", then "report" and "next" with a dim
// label and the commands in the accent colour.
// In files and pipes it stays plain, greppable lines prefixed with [caw].

import { colorEnabled, termPainter } from './color.mjs';
import { exitOf } from './errors.mjs';
import { t } from './i18n.mjs';
import { isErrorCode, isSkipped } from './report.mjs';
import { MARKS as marks } from './marks.mjs';
import { headLine, packageVersion } from './brand.mjs';

// Error texts and reasons can come from the application; they must not control the terminal.
// eslint-disable-next-line no-control-regex -- deliberately matches control characters to neutralise them
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const safe = (text) => String(text).replace(CONTROL, '?');
const seconds = (value) => `${value.toFixed(1)}s`;
const MAX_FAILURES = 5;
// Width of rules and boxes; longer lines may extend beyond it.
const WIDTH = 56;
// eslint-disable-next-line no-control-regex -- strips ANSI colour codes to measure visible width
const ANSI = /\u001b\[[0-9;]*m/g;
const width = (text) => [...String(text).replace(ANSI, '')].length;
// The reason of a failed step in the plain output: two terminal lines at most, the rest is in report.md.
const MAX_REASON = 240;
// The step names' column in the run's result; a longer name pushes its duration further right.
const MAX_NAME = 40;
// The head is shown once per process on the console, however many parts of the tool print; an own `out` has its own.
const CONSOLE_HEAD = { shown: false };

/** Why the run failed, as "S1: <note>": the first failed step that was reached, otherwise the first hard error. */
export const failedReason = ({ results = [], failures = [] }) => {
    const failed = results.find((item) => item.status === 'fail' && !isSkipped(item, results) && item.note);
    let text;
    if (failed !== undefined) text = `${failed.id}: ${failed.note}`;
    else if (failures.length > 0) text = `${failures[0].type}: ${failures[0].text}`;
    else return undefined;
    const line = String(text).replace(/\s+/g, ' ').trim();
    return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
};

/**
 * Yes/no prompt in the terminal; Enter takes the default. Accepts j/ja/y/yes and n/nein/no.
 * @returns true or false
 */
export const askYesNo = async (question, { fallback = true, input = process.stdin, output = process.stdout } = {}) => {
    const { createInterface } = await import('node:readline/promises');
    const paint = termPainter(colorEnabled());
    const rl = createInterface({ input, output });
    const hint = paint.muted(fallback ? t('cli.yesNoDefaultYes') : t('cli.yesNoDefaultNo'));
    try {
        for (;;) {
            const answer = (await rl.question(`  ${paint.info(marks.tag('ask'))} ${paint.text(question)} ${hint} `)).trim();
            if (answer === '') return fallback;
            if (/^(j|ja|y|yes)$/i.test(answer)) return true;
            if (/^(n|nein|no)$/i.test(answer)) return false;
        }
    } finally {
        rl.close();
    }
};

// Look up console only when writing, so output also lands where a test has replaced console.log.
export const createUi = ({ fancy = colorEnabled(), out: own, err = (text) => console.error(text), full } = {}) => {
    const out = own ?? ((text) => console.log(text));
    const headed = own === undefined ? CONSOLE_HEAD : { shown: false };
    const paint = termPainter(fancy, full === undefined ? {} : { full });
    const blank = ' '.repeat(width(marks.tag('ok')));
    /** A status mark in its colour. */
    const tag = (kind, frame) => {
        const text = marks.tag(kind, frame);
        return ({ ok: paint.ok, fail: paint.fail, warn: paint.warn, run: paint.info, ask: paint.info, open: paint.faint })[kind]?.(text) ?? paint.faint(text);
    };
    const bullet = (kind) => ({ ok: paint.ok, warn: paint.warn, fail: paint.fail, run: paint.info, info: paint.info })[kind](marks.bullet(kind));
    /** Line with a mark in front; without a terminal [caw] in front. */
    const marked = (kind, text, write = out, color = paint.text) => write(fancy ? `  ${tag(kind)} ${color(safe(text))}` : `[caw] ${safe(text)}`);
    /** Line with a bullet in front, for hints and instructions. */
    const pointed = (kind, text, write = out, color = paint.muted) => write(fancy ? `  ${bullet(kind)} ${color(safe(text))}` : `[caw] ${safe(text)}`);
    /** Section: ── TITLE ─────── in faint, the title in accent. */
    const rule = (title, color = paint.accent) => {
        const { before, after, tail, line } = marks.rule(title, WIDTH);
        return `  ${paint.faint(before)}${color(title)}${paint.faint(`${after}${line}${tail}`)}`;
    };
    /** Box: ┌─┤ TITLE ├──┐, rows with │ left and right, └──┘. Overlong rows stay open on the right. */
    const box = (title, rows, color = paint.frame) => {
        const b = marks.box;
        const inner = Math.max(WIDTH - 2, ...rows.map((row) => width(row) + 2));
        const head = `${b.h}${b.titleOpen}${title}${b.titleClose}`;
        out(`  ${color(`${b.tl}${b.h}${b.titleOpen}`)}${paint.accent(title)}${color(`${b.titleClose}${b.h.repeat(Math.max(1, inner - width(head)))}${b.tr}`)}`);
        for (const row of rows) out(`  ${color(b.v)} ${row}${' '.repeat(Math.max(0, inner - width(row) - 1))}${color(b.v)}`);
        out(`  ${color(`${b.bl}${b.h.repeat(inner)}${b.br}`)}`);
    };
    const STATUS = {
        pass: { kind: 'ok', color: paint.ok },
        fail: { kind: 'fail', color: paint.fail },
        error: { kind: 'warn', color: paint.warn },
    };
    /** The commands in `text` in the accent colour, the rest in `color`. */
    const withCommands = (text, commands = [], color = paint.muted) => {
        let rest = safe(text);
        let shown = '';
        for (;;) {
            const found = commands.map((command) => [rest.indexOf(command), command]).filter(([at]) => at !== -1).sort(([a], [b]) => a - b)[0];
            if (found === undefined) return shown + (rest === '' ? '' : color(rest));
            const [at, command] = found;
            shown += (at === 0 ? '' : color(rest.slice(0, at))) + paint.accent(command);
            rest = rest.slice(at + command.length);
        }
    };
    /** "report" and "next" as a dim label column at the left edge. */
    const LABELS = () => [t('cli.uiReportLabel'), t('cli.uiNextLabel')];
    const labelled = (label, text) => `${paint.faint(label.padEnd(Math.max(...LABELS().map((item) => item.length)) + 2))}${text}`;
    const head = () => {
        if (!fancy || headed.shown) return;
        headed.shown = true;
        out(headLine('caw', { accent: paint.accent, bold: paint.bold, dim: paint.faint }, { version: packageVersion() }));
    };

    return {
        info: (text) => pointed('info', text),
        progress: (text) => marked('run', text, err, paint.muted),
        warn: (text, write = out) => marked('warn', text, write),
        success: (text) => marked('ok', text),
        note: (text) => pointed('warn', text),
        /**
         * Abort: the message first, for a usage error the command synopsis, last the code (muted) for search and docs.
         * @param synopsis e.g. "caw open <test>@<S4> [--env <umgebung>]"
         */
        fatal: (code, text, { synopsis, exit } = {}) => {
            marked('fail', text, err, paint.fail);
            if (synopsis !== undefined) err(`${fancy ? `  ${blank}` : '[caw]'} ${t('cli.usageLine', { synopsis })}`);
            const label = t('cli.errorCode', { code, exit: exit ?? '?' });
            err(fancy ? `  ${blank} ${paint.muted(label)}` : `[caw] ${label}`);
        },

        /** Command header: one line "● <title> · Context-Aware Web Testing". In pipes only the title. */
        banner: ({ title }) => {
            if (!fancy) {
                out(`[caw] ${safe(title)}`);
                return;
            }
            headed.shown = true;
            out(headLine(safe(title), { accent: paint.accent, bold: paint.bold, dim: paint.faint }));
            out('');
        },
        /** The head "● caw · Context-Aware Web Testing · <version>", once per process; in pipes nothing. */
        head,
        /**
         * What to do next, after a run: the first line labelled "next", the commands in it in the accent colour. In pipes the
         * lines as they are. A command the text does not name follows it: it is the line's point, in a CI log too.
         * @param lines [{ text, commands: ['caw run …'] }]
         */
        next: (lines) => {
            lines.forEach(({ text: given, commands = [] }, index) => {
                const text = [given, ...commands.filter((command) => !given.includes(command))].join(' ');
                if (!fancy) out(`[caw] ${safe(text)}`);
                else out(index === 0 ? labelled(t('cli.uiNextLabel'), withCommands(text, commands)) : labelled('', withCommands(text, commands)));
            });
        },
        /** A section of a guided flow. */
        section: (number, title) => {
            if (!fancy) {
                out(`[caw] ${number}. ${safe(title)}`);
                return;
            }
            out('');
            out(rule(`${number} ${safe(String(title).toUpperCase())}`));
        },
        /**
         * A box, e.g. the result of explore.
         * @param items [{ status: ok | warn | fail | run | ask | open | info | note | added | removed, text }]
         */
        box: (title, items) => {
            if (!fancy) {
                out(`[caw] ${safe(title)}`);
                for (const { text } of items) out(`[caw] ${safe(text)}`);
                return;
            }
            out('');
            box(safe(String(title).toUpperCase()), items.map(({ status = 'ok', text }) => {
                if (status === 'info') return `${bullet('info')} ${paint.text(safe(text))}`;
                if (status === 'note') return `${bullet('warn')} ${paint.muted(safe(text))}`;
                if (status === 'removed') return `  ${paint.fail('-')} ${paint.muted(safe(text))}`;
                if (status === 'added') return `  ${paint.ok('+')} ${paint.text(safe(text))}`;
                return `${tag(status)} ${paint.text(safe(text))}`;
            }));
        },
        /** A line that stays until done() ticks it off; in a terminal with the spinner in the mark. */
        pending: (text) => {
            if (!fancy || !process.stdout.isTTY) {
                out(`[caw] ${safe(text)} …`);
                return { done: (final = text) => out(`[caw] ✓ ${safe(final)}`), fail: (final = text) => out(`[caw] ✕ ${safe(final)}`) };
            }
            let frame = 0;
            const { frames, ms } = marks.spinner;
            const draw = () => process.stdout.write(`\r\u001b[2K  ${tag('run', frames[frame % frames.length])} ${paint.text(safe(text))}`);
            draw();
            const timer = setInterval(() => { frame += 1; draw(); }, ms);
            timer.unref?.();
            const finish = (kind, final, color) => {
                clearInterval(timer);
                process.stdout.write(`\r\u001b[2K  ${tag(kind)} ${color(safe(final))}\n`);
            };
            return { done: (final = text) => finish('ok', final, paint.text), fail: (final = text) => finish('fail', final, paint.fail) };
        },

        /**
         * Header of a single run: what runs where, and who drives.
         * `code` is the "Code: …" line (describeCode); it is always shown, even without a terminal.
         */
        header: ({ mode, test, target, role, source, code, maxActions, language: team }) => {
            const codeLine = t('cli.uiCode', { code: code ?? (source === 'overlay' ? t('cli.uiLocal') : t('cli.uiDeployed')) });
            if (!fancy) {
                out(`[caw] ${mode}: ${test} ${t('cli.uiOn')} ${target}${team === undefined ? '' : ` · ${t('cli.uiLanguage', { language: team })}`}`);
                out(`[caw] ${safe(codeLine)}`);
                return;
            }
            head();
            // "Replay without Claude · first-errand on local as user · team language en"
            const details = [];
            if (team !== undefined) details.push(t('cli.uiLanguage', { language: team }));
            if (maxActions !== undefined) details.push(t('cli.uiMaxActions', { count: maxActions }));
            const as = role === undefined ? '' : `${paint.faint(` ${t('cli.uiAs')}`)} ${safe(role)}`;
            out(`${paint.bold(safe(mode))} ${paint.faint(`· ${safe(test)} ${t('cli.uiOn')}`)} ${safe(target)}${as}${details.length === 0 ? '' : paint.faint(` · ${details.map(safe).join(' · ')}`)}`);
            out(paint.faint(safe(codeLine)));
            out('');
        },

        step: ({ number, total, label, elapsed }) => {
            if (!fancy) {
                out(`[+${seconds(elapsed)}] ${number}/${total} ${safe(label)}`);
                return;
            }
            const size = String(total).length;
            out(`  ${blank} ${bullet('run')} ${paint.accent(String(number).padStart(size))}${paint.faint(`/${total}`)} ${paint.text(safe(label))} ${paint.muted(`+${seconds(elapsed)}`)}`);
        },

        /**
         * A run's result: the "Run" rule, one line per step with its mark, name and duration, the reason under a failed step, hard
         * errors, the summary, the report.
         * @param names     step id -> name (otherwise the expectation's text is shown)
         * @param durations step id -> seconds
         * @param replayedTo a window that only replayed up to this step to show its design: said instead of a passed test
         */
        verdict: ({ status, reason, note, code, testId, target, expectations = [], results = [], failures = [], warnings = [], reproduce, steps = [] }, { report, reportUrl, elapsed, names = {}, durations = {}, replayedTo }) => {
            const { color } = STATUS[status];
            // An error always names its code, as when a command stops (fatal).
            const codeLabel = status === 'error' && isErrorCode(code) ? t('cli.errorCode', { code, exit: exitOf(code) }) : '';
            const why = failedReason({ results, failures });
            if (!fancy) {
                out(`[caw] ${testId} ${t('cli.uiOn')} ${target}: ${replayedTo === undefined ? status : t('cli.uiReplayedTo', { step: replayedTo })}${reason ? ` (${safe(reason)})` : ''}${codeLabel ? ` ${codeLabel}` : ''}`);
                // Without a window or in CI this is all there is: the reason belongs in the terminal, not only in report.md.
                if (status === 'fail' && why !== undefined) out(`[caw] ${safe(why)}`);
                if (warnings.length > 0) out(`[caw] ${t('cli.uiWarnings', { count: warnings.length })}`);
                if (reproduce?.reproduced !== undefined) out(`[caw] ${t(`cli.reproduceVerdict.${reproduce.reproduced}`)}`);
                out(`[caw] ${t('cli.uiReport')} ${report}`);
                return;
            }
            out('');
            const { line } = marks.rule('', WIDTH);
            out(paint.faint(`${t('cli.uiRun')} ${line.slice(width(t('cli.uiRun')) + 1)}`));
            if (reason) out(`  ${tag(STATUS[status].kind)} ${paint.text(safe(reason))}${codeLabel ? ` ${paint.muted(codeLabel)}` : ''}`);
            // Columns: mark, id, name, duration. The name starts where a failure's reason starts below it.
            const idWidth = Math.max(0, ...expectations.map(({ id }) => width(id)));
            const nameOf = ({ id, text }) => safe(names[id] ?? text);
            const nameWidth = Math.min(MAX_NAME, Math.max(0, ...expectations.map((item) => width(nameOf(item)))));
            const indent = ' '.repeat(2 + width(marks.tag('ok')) + 1 + idWidth + 2);
            const under = (text, last, paintText) => out(`${indent.slice(2)}${paint.faint(last ? marks.tree.end : marks.tree.mid)} ${paintText(safe(text))}`);
            const time = (id) => (typeof durations[id] === 'number' ? seconds(durations[id]).padStart(6) : '');
            const counts = { pass: 0, fail: 0, open: 0 };
            for (const item of expectations) {
                const { id } = item;
                const result = results.find((candidate) => candidate.id === id);
                const name = nameOf(item);
                const gap = ' '.repeat(Math.max(2, nameWidth - width(name) + 2));
                // Not reached because an earlier step failed: open, not one more failure.
                if (result === undefined || isSkipped(result, results)) {
                    counts.open += 1;
                    out(`  ${tag('open')} ${paint.faint(`${id.padEnd(idWidth)}  ${name}${gap}${t('cli.uiNotReached')}`)}`);
                    continue;
                }
                counts[result.status === 'pass' ? 'pass' : 'fail'] += 1;
                const took = time(id);
                // A passed step whose screen met its target design says so after its time.
                const met = result.status === 'pass' && steps.find((step) => step.id === id)?.design?.verdict === 'met' ? ` ${paint.ok(`· ${t('cli.uiDesignMet')}`)}` : '';
                out(`  ${tag(STATUS[result.status].kind)} ${paint.muted(id.padEnd(idWidth))}  ${paint.text(name)}${took === '' ? (met === '' ? '' : gap.slice(1)) : `${gap}${paint.faint(took)}`}${met}`);
                if (result.status !== 'pass' && result.note) under(result.note, true, paint.fail);
            }
            const shown = failures.slice(0, MAX_FAILURES);
            shown.forEach((failure, index) => under(`${failure.type}: ${failure.text}`, index === shown.length - 1 && failures.length <= MAX_FAILURES, paint.fail));
            if (failures.length > MAX_FAILURES) out(`${indent}${paint.muted(t('cli.uiMoreFailures', { count: failures.length - MAX_FAILURES }))}`);
            if (note) out(`${indent}${paint.muted(safe(note))}`);
            // "Failed. 2 of 4 steps passed. 1 warning · 8.7s"
            // A reproduction reports what it found, not whether a test passed.
            const headline = reproduce?.reproduced === undefined ? t(`cli.uiStatus.${status}`) : t(`cli.reproduceVerdict.${reproduce.reproduced}`);
            const parts = [replayedTo === undefined ? color(paint.bold(headline)) : paint.bold(paint.text(t('cli.uiReplayedTo', { step: replayedTo })))];
            if (expectations.length > 0 && replayedTo === undefined) parts.push(paint.text(t('cli.uiStepsPassed', { passed: counts.pass, total: expectations.length })));
            if (warnings.length > 0) parts.push(paint.warn(t('cli.uiWarningCount', { count: warnings.length })));
            out('');
            out(`${parts.join(' ')} ${paint.faint(`· ${seconds(elapsed)}`)}`);
            out(labelled(t('cli.uiReportLabel'), paint.text(report)));
            // Clickable in the terminal; the relative path above stays readable.
            if (reportUrl !== undefined) out(labelled('', paint.faint(reportUrl)));
        },

        /**
         * The table after several runs: one line per test with outcome, duration and reason.
         * @param rows [{ test, exit, seconds, note }]; exit as in EXIT (0 pass, 1 fail, 2 error, 3 rejected, 4 recording needed)
         */
        batch: ({ target, rows }) => {
            const LABEL = { 0: 'pass', 1: 'fail', 2: 'error', 3: 'rejected', 4: 'needsRecording' };
            const look = { pass: ['ok', paint.ok], fail: ['fail', paint.fail], error: ['warn', paint.warn], rejected: ['open', paint.muted], needsRecording: ['ask', paint.warn] };
            const titles = rows.map(({ exit }) => t(`cli.batchStatus.${LABEL[exit]}`));
            const size = Math.max(...titles.map((title) => title.length));
            const nameWidth = Math.max(...rows.map(({ test }) => test.length));
            const heading = t('cli.batchHeading', { count: rows.length, target });
            if (!fancy) out(`[caw] ${heading}`);
            else {
                out('');
                out(rule(heading.toUpperCase()));
            }
            rows.forEach(({ test, exit, seconds: took, note }, index) => {
                const [kind, color] = look[LABEL[exit]];
                const time = took === undefined ? '' : seconds(took);
                const text = `${titles[index].padEnd(size)}  ${safe(test).padEnd(nameWidth)}  ${time.padStart(7)}${note ? `  ${safe(note)}` : ''}`;
                out(fancy ? `  ${tag(kind)} ${color(titles[index].padEnd(size))}  ${paint.text(safe(test).padEnd(nameWidth))}  ${paint.muted(time.padStart(7))}${note ? `  ${paint.muted(safe(note))}` : ''}` : `[caw] ${text}`);
            });
        },

        heading: (text) => {
            if (!fancy) {
                out(`[caw] ${safe(text)}`);
                return;
            }
            out('');
            out(rule(safe(text).toUpperCase()));
        },
    };
};
