// The active theme's glyphs for the terminal: boot-log style status marks, spinner, bullets, tree, rules, box, progress.
// Same as in the workbench and the explore map (themes/<name>/theme.json).

import { activeTheme } from './theme-package.mjs';

/**
 * A theme's glyphs, with safe defaults for anything missing.
 * @returns { tag(kind, frame), spinner: { frames, ms }, bullet(kind), tree, rule(title, width), box, progress, failInverted }
 */
export const glyphs = (theme = activeTheme()) => {
    const frames = Array.isArray(theme.spinner?.frames) && theme.spinner.frames.length > 0 ? theme.spinner.frames : ['▖', '▘', '▝', '▗'];
    const marks = theme.marks ?? {};
    const rule = { line: theme.rule?.line || '─', format: theme.rule?.format || '── {title} {line}' };
    return {
        /** The mark for a status: ok, warn, fail, run (with the spinner frame), open, ask. */
        tag: (kind, frame = frames[0]) => String(marks[kind] ?? marks.open ?? '[      ]').replace('{spinner}', frame),
        spinner: { frames, ms: Number.isInteger(theme.spinner?.ms) && theme.spinner.ms > 0 ? theme.spinner.ms : 150 },
        bullet: (kind) => String(theme.bullets?.[kind] ?? theme.bullets?.info ?? '▸'),
        tree: { mid: theme.tree?.mid ?? '├', end: theme.tree?.end ?? '└' },
        /** A section rule up to `width`; the title is kept as is. Returns the parts separately so they can be coloured apart. */
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
