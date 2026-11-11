// The tool's console output in workbench style: colours and glyphs from the active theme, boot-log style status marks
// ([  OK  ] [ WARN ] [FEHLER]), sections as rules (── 1 ANMELDEN ───), results in a box (┌─┤ ERGEBNIS ├─┐).
// In files and pipes it stays plain, greppable lines prefixed with [caw-ai].

import { colorEnabled, themePainter } from './color.mjs';
import { exitOf } from './errors.mjs';
import { t } from './i18n.mjs';
import { isErrorCode, isSkipped } from './report.mjs';
import { glyphs } from './marks.mjs';
import { ravenBanner } from './raven.mjs';

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
    const paint = themePainter(colorEnabled());
    const marks = glyphs();
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
export const createUi = ({ fancy = colorEnabled(), out = (text) => console.log(text), err = (text) => console.error(text), full, theme } = {}) => {
    const paint = themePainter(fancy, { ...(full === undefined ? {} : { full }), ...(theme === undefined ? {} : { theme }) });
    const marks = glyphs(theme);
    const blank = ' '.repeat(width(marks.tag('ok')));
    /** A status mark in its colour; fail inverted if the theme wants it. */
    const tag = (kind, frame) => {
        const text = marks.tag(kind, frame);
        if (kind === 'fail') return marks.failInverted ? paint.failTag(text) : paint.fail(text);
        return ({ ok: paint.ok, warn: paint.warn, run: paint.info, ask: paint.info, open: paint.faint })[kind]?.(text) ?? paint.faint(text);
    };
    const bullet = (kind) => ({ ok: paint.ok, warn: paint.warn, fail: paint.fail, run: paint.info, info: paint.info })[kind](marks.bullet(kind));
    /** Line with a mark in front; without a terminal [caw-ai] in front. */
    const marked = (kind, text, write = out, color = paint.text) => write(fancy ? `  ${tag(kind)} ${color(safe(text))}` : `[caw-ai] ${safe(text)}`);
    /** Line with a bullet in front, for hints and instructions. */
    const pointed = (kind, text, write = out, color = paint.muted) => write(fancy ? `  ${bullet(kind)} ${color(safe(text))}` : `[caw-ai] ${safe(text)}`);
    /** Sub-item under a mark: tree, bullet, text. */
    const sub = (kind, text, last = true, color = paint.muted) => `  ${blank} ${paint.faint(last ? marks.tree.end : marks.tree.mid)} ${bullet(kind)} ${color(safe(text))}`;
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
    /** Progress: █ passed, ▓ running or failed, ░ open. */
    const gauge = (counts, size = 24) => {
        const total = Math.max(1, counts.pass + counts.fail + counts.open);
        const cells = (count) => Math.round((count / total) * size);
        const pass = cells(counts.pass);
        const fail = Math.min(size - pass, cells(counts.fail));
        const p = marks.progress;
        return `${paint.ok(p.done.repeat(pass))}${paint.fail(p.run.repeat(fail))}${paint.faint(p.open.repeat(Math.max(0, size - pass - fail)))}`;
    };
    const STATUS = {
        pass: { kind: 'ok', title: 'PASS', color: paint.ok },
        fail: { kind: 'fail', title: 'FAIL', color: paint.fail },
        error: { kind: 'warn', title: 'ERROR', color: paint.warn },
    };

    return {
        info: (text) => pointed('info', text),
        progress: (text) => marked('run', text, err, paint.muted),
        warn: (text, write = out) => marked('warn', text, write),
        success: (text) => marked('ok', text),
        note: (text) => pointed('warn', text),
        /**
         * Abort: the message first, for a usage error the command synopsis, last the code (muted) for search and docs.
         * @param synopsis e.g. "caw-ai fix <test> <S4> [--target <umgebung>]"
         */
        fatal: (code, text, { synopsis, exit } = {}) => {
            marked('fail', text, err, paint.fail);
            if (synopsis !== undefined) err(`${fancy ? `  ${blank}` : '[caw-ai]'} ${t('cli.usageLine', { synopsis })}`);
            const label = t('cli.errorCode', { code, exit: exit ?? '?' });
            err(fancy ? `  ${blank} ${paint.muted(label)}` : `[caw-ai] ${label}`);
        },

        /** Command header: the ASCII raven with the name and its long form. In pipes only the name. */
        banner: ({ title }) => {
            if (!fancy) {
                out(`[caw-ai] ${safe(title)}`);
                return;
            }
            for (const row of ravenBanner(safe(title), { bold: (text) => paint.bold(paint.text(text)), dim: paint.muted, frame: paint.frame, beak: paint.accent, eye: paint.text })) out(row);
            out('');
        },
        /** A section of a guided flow. */
        section: (number, title) => {
            if (!fancy) {
                out(`[caw-ai] ${number}. ${safe(title)}`);
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
                out(`[caw-ai] ${safe(title)}`);
                for (const { text } of items) out(`[caw-ai] ${safe(text)}`);
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
                out(`[caw-ai] ${safe(text)} …`);
                return { done: (final = text) => out(`[caw-ai] ✓ ${safe(final)}`), fail: (final = text) => out(`[caw-ai] ✗ ${safe(final)}`) };
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
        header: ({ mode, test, target, source, code, maxSteps }) => {
            const codeLine = t('cli.uiCode', { code: code ?? (source === 'overlay' ? t('cli.uiLocal') : t('cli.uiDeployed')) });
            if (!fancy) {
                out(`[caw-ai] ${mode}: ${test} ${t('cli.uiOn')} ${target}`);
                out(`[caw-ai] ${safe(codeLine)}`);
                return;
            }
            out('');
            out(rule(`${safe(test).toUpperCase()} ${t('cli.uiOn')} ${safe(target)}`));
            const details = [mode];
            if (maxSteps !== undefined) details.push(t('cli.uiMaxSteps', { count: maxSteps }));
            out(`  ${blank} ${paint.muted(details.map(safe).join(' · '))}`);
            out(`  ${blank} ${paint.muted(safe(codeLine))}`);
        },

        step: ({ number, total, label, elapsed }) => {
            if (!fancy) {
                out(`[+${seconds(elapsed)}] ${number}/${total} ${safe(label)}`);
                return;
            }
            const size = String(total).length;
            out(`  ${blank} ${bullet('run')} ${paint.accent(String(number).padStart(size))}${paint.faint(`/${total}`)} ${paint.text(safe(label))} ${paint.muted(`+${seconds(elapsed)}`)}`);
        },

        /** A run's result: rule with the outcome, one mark per expectation, progress, report. */
        verdict: ({ status, reason, note, code, testId, target, expectations = [], results = [], failures = [], warnings = [] }, { report, reportUrl, elapsed }) => {
            const { title, color } = STATUS[status];
            // An error always names its code, as when a command stops (fatal).
            const codeLabel = status === 'error' && isErrorCode(code) ? t('cli.errorCode', { code, exit: exitOf(code) }) : '';
            const why = failedReason({ results, failures });
            if (!fancy) {
                out(`[caw-ai] ${testId} ${t('cli.uiOn')} ${target}: ${status}${reason ? ` (${safe(reason)})` : ''}${codeLabel ? ` ${codeLabel}` : ''}`);
                // Without a window or in CI this is all there is: the reason belongs in the terminal, not only in report.md.
                if (status === 'fail' && why !== undefined) out(`[caw-ai] ${safe(why)}`);
                if (warnings.length > 0) out(`[caw-ai] ${t('cli.uiWarnings', { count: warnings.length })}`);
                out(`[caw-ai] ${t('cli.uiReport')} ${report}`);
                return;
            }
            out('');
            out(rule(`${title} · ${safe(testId)} ${t('cli.uiOn')} ${safe(target)} · ${seconds(elapsed)}`, (text) => color(paint.bold(text))));
            if (reason) out(`  ${tag(STATUS[status].kind)} ${paint.text(safe(reason))}${codeLabel ? ` ${paint.muted(codeLabel)}` : ''}`);
            const counts = { pass: 0, fail: 0, open: 0 };
            for (const { id, text } of expectations) {
                const item = results.find((candidate) => candidate.id === id);
                // Not reached because an earlier step failed: open, not one more failure.
                if (item === undefined || isSkipped(item, results)) {
                    counts.open += 1;
                    out(`  ${tag('open')} ${paint.faint(`${id} ${safe(text)}`)}`);
                    continue;
                }
                counts[item.status === 'pass' ? 'pass' : 'fail'] += 1;
                out(`  ${tag(STATUS[item.status].kind)} ${paint.muted(id)} ${paint.text(safe(text))}`);
                if (item.status !== 'pass' && item.note) out(sub('fail', item.note, true, paint.text));
            }
            const shown = failures.slice(0, MAX_FAILURES);
            shown.forEach((failure, index) => out(sub('fail', `${failure.type}: ${failure.text}`, index === shown.length - 1 && failures.length <= MAX_FAILURES, paint.fail)));
            if (failures.length > MAX_FAILURES) out(`  ${blank}   ${paint.muted(t('cli.uiMoreFailures', { count: failures.length - MAX_FAILURES }))}`);
            if (warnings.length > 0) out(`  ${tag('warn')} ${paint.muted(t('cli.uiWarningsShort', { count: warnings.length }))}`);
            if (note) out(`  ${blank} ${paint.muted(safe(note))}`);
            if (expectations.length > 0) {
                const parts = [paint.ok(t('cli.uiPassed', { count: counts.pass }))];
                if (counts.fail > 0) parts.push(paint.fail(t('cli.uiFailed', { count: counts.fail })));
                if (counts.open > 0) parts.push(paint.muted(t('cli.uiOpen', { count: counts.open })));
                out('');
                out(`  ${gauge(counts)}  ${parts.join(paint.muted(' · '))}`);
            }
            out(`  ${paint.muted(t('cli.uiReport'))} ${paint.info(report)}`);
            // Clickable in the terminal; the relative path above stays readable.
            if (reportUrl !== undefined) out(`  ${paint.muted(reportUrl)}`);
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
            if (!fancy) out(`[caw-ai] ${heading}`);
            else {
                out('');
                out(rule(heading.toUpperCase()));
            }
            rows.forEach(({ test, exit, seconds: took, note }, index) => {
                const [kind, color] = look[LABEL[exit]];
                const time = took === undefined ? '' : seconds(took);
                const text = `${titles[index].padEnd(size)}  ${safe(test).padEnd(nameWidth)}  ${time.padStart(7)}${note ? `  ${safe(note)}` : ''}`;
                out(fancy ? `  ${tag(kind)} ${color(titles[index].padEnd(size))}  ${paint.text(safe(test).padEnd(nameWidth))}  ${paint.muted(time.padStart(7))}${note ? `  ${paint.muted(safe(note))}` : ''}` : `[caw-ai] ${text}`);
            });
        },

        heading: (text) => {
            if (!fancy) {
                out(`[caw-ai] ${safe(text)}`);
                return;
            }
            out('');
            out(rule(safe(text).toUpperCase()));
        },
    };
};
