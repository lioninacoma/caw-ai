// Die Zeichen des aktiven Themes fuer das Terminal: Statusmarken im Stil eines Start-Logs, Spinner, Punkte, Baum, Linien,
// Kasten, Fortschritt. Gleich wie in Werkbank und Explore-Karte (themes/<name>/theme.json).

import { activeTheme } from './theme-package.mjs';

/**
 * Die Zeichen eines Themes, mit sicheren Vorgaben fuer alles, was fehlt.
 * @returns { tag(kind, frame), spinner: { frames, ms }, bullet(kind), tree, rule(title, width), box, progress, failInverted }
 */
export const glyphs = (theme = activeTheme()) => {
    const frames = Array.isArray(theme.spinner?.frames) && theme.spinner.frames.length > 0 ? theme.spinner.frames : ['▖', '▘', '▝', '▗'];
    const marks = theme.marks ?? {};
    const rule = { line: theme.rule?.line || '─', format: theme.rule?.format || '── {title} {line}' };
    return {
        /** Die Marke eines Status: ok, warn, fail, run (mit dem Bild des Spinners), open, ask. */
        tag: (kind, frame = frames[0]) => String(marks[kind] ?? marks.open ?? '[      ]').replace('{spinner}', frame),
        spinner: { frames, ms: Number.isInteger(theme.spinner?.ms) && theme.spinner.ms > 0 ? theme.spinner.ms : 150 },
        bullet: (kind) => String(theme.bullets?.[kind] ?? theme.bullets?.info ?? '▸'),
        tree: { mid: theme.tree?.mid ?? '├', end: theme.tree?.end ?? '└' },
        /** Eine Abschnittslinie bis zur Breite `width`; der Titel bleibt, wie er ist. Gibt { head, line } fuer getrenntes Faerben. */
        rule: (title, width) => {
            const [head, tail = ''] = rule.format.replace('{title}', '\u0000').split('{line}');
            const [before, after = ''] = head.split('\u0000');
            const used = [...before].length + [...String(title)].length + [...after].length + [...tail].length;
            return { before, after, tail, line: rule.line.repeat(Math.max(3, width - used)) };
        },
        box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', titleOpen: '┤ ', titleClose: ' ├', ...theme.box },
        progress: { done: '█', run: '▓', open: '░', ...theme.progress },
        failInverted: theme.failInverted !== false,
    };
};
