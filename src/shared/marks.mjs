// Graphite's plain marks for the terminal: status marks, spinner, bullets, tree, rules, box, progress.
// Every status mark is one character wide, so text after it lines up.

const TAGS = { ok: '✓', fail: '✕', warn: '!', open: '○', ask: '?' };
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BULLETS = { ok: '·', warn: '!', fail: '✕', run: '›', info: '›' };

export const MARKS = {
    /** The mark for a status: ok, warn, fail, run (the spinner frame), open, ask. */
    tag: (kind, frame = FRAMES[0]) => (kind === 'run' ? frame : TAGS[kind] ?? TAGS.open),
    spinner: { frames: FRAMES, ms: 80 },
    bullet: (kind) => BULLETS[kind] ?? BULLETS.info,
    tree: { mid: '├', end: '└' },
    /** A section rule "── title ───" up to `width`; returns the parts separately so they can be coloured apart. */
    rule: (title, width) => {
        const before = '── ';
        const after = ' ';
        const used = before.length + [...String(title)].length + after.length;
        return { before, after, tail: '', line: '─'.repeat(Math.max(3, width - used)) };
    },
    box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', titleOpen: '┤ ', titleClose: ' ├' },
    progress: { done: '━', run: '━', open: '─' },
};
