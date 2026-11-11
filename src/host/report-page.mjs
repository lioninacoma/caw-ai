// Der Bericht als Seite im Konsolen-Stil: Aus dem Chat öffnet „Bericht öffnen“ ihn in einem neuen Reiter desselben Browsers.
// Es reicht das Markdown, das renderReport schreibt: Überschriften, Absätze, Listen, Tabellen, `Code` und **fett**.
// Lesetext bleibt scharf in der Textschrift; nur Überschriften, Marken und Legende tragen Anzeigeschrift und Leuchten.
import { language, t } from '../shared/i18n.mjs';
import { activeTheme } from '../shared/theme-package.mjs';
import { CONSOLE_CSS, FAVICON, themeAttr, themeCss, themeStyle } from './theme.mjs';

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (text) => escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
const STATUS = /^(pass|fail|error|skipped|warn)$/;
// Welche Marke des Themes zu welchem Status gehoert.
const MARK = { pass: 'ok', fail: 'fail', error: 'fail', warn: 'warn', skipped: 'open' };
const FALLBACK = { ok: '[  OK  ]', fail: '[ FAIL ]', warn: '[ WARN ]', open: '[      ]' };
const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback);

/**
 * Markdown aus renderReport als HTML-Körper.
 * @param marks        die Statusmarken des Themes ({ ok, fail, warn, open }); ohne: schlichte Vorgaben
 * @param failInverted Fehler invertiert (Hintergrund fail)
 */
export const reportBody = (markdown, { marks = {}, failInverted = true } = {}) => {
    const mark = (status) => {
        const kind = MARK[status];
        const inverted = kind === 'fail' && failInverted ? ' inverted' : '';
        return `<span class="st st-${status}"><span class="tag tag-${kind}${inverted}">${escape(text(marks[kind], FALLBACK[kind]))}</span> ${status}</span>`;
    };
    const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const heading = /^(#{1,3}) (.*)$/.exec(line);
        if (heading) {
            out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
            i += 1;
        } else if (/^\s*\|/.test(line) && /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1] ?? '')) {
            const head = cells(line);
            i += 2;
            const rows = [];
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
                rows.push(cells(lines[i]));
                i += 1;
            }
            const td = (cell) => (STATUS.test(cell) ? `<td>${mark(cell)}</td>` : `<td>${inline(cell)}</td>`);
            out.push(`<div class="table"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map(td).join('')}</tr>`).join('')}</tbody></table></div>`);
        } else if (/^\s*[-*] /.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*[-*] /.test(lines[i])) {
                items.push(`<li>${inline(lines[i].replace(/^\s*[-*] /, ''))}</li>`);
                i += 1;
            }
            out.push(`<ul>${items.join('')}</ul>`);
        } else if (/^```/.test(line)) {
            const code = [];
            i += 1;
            while (i < lines.length && !/^```/.test(lines[i])) {
                code.push(lines[i]);
                i += 1;
            }
            i += 1;
            out.push(`<pre>${escape(code.join('\n'))}</pre>`);
        } else if (line.trim() === '') {
            i += 1;
        } else {
            const paragraph = [];
            while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3} |\s*\||\s*[-*] |```)/.test(lines[i])) {
                paragraph.push(lines[i]);
                i += 1;
            }
            out.push(`<p>${inline(paragraph.join(' '))}</p>`);
        }
    }
    return out.join('\n');
};

/** Die ganze Seite im aktiven Theme. */
export const reportPage = ({ markdown, path = '', theme = activeTheme() }) => {
    const title = t('workbench.report.title');
    const legend = text(theme.legend, '┤ {title} ├').split('{title}').join(title.toUpperCase());
    return `<!doctype html><html lang="${language()}"${themeAttr(theme)}><head><meta charset="utf-8"><title>caw-ai · ${escape(title)}</title>${FAVICON}<style>
${themeCss(theme)}${CONSOLE_CSS}
*{box-sizing:border-box}
html{background:var(--page)}
body{margin:0;padding:28px 16px;color:var(--text);font:var(--fs-body,14px)/1.55 var(--font-body)}
.case{max-width:1100px;margin:0 auto;padding:14px}
.screen{padding:22px 16px 16px}
main{padding:22px 24px 18px}
.path{margin:0 0 10px;font:12px var(--font-ui);color:var(--muted);overflow-wrap:anywhere}
h1,h2,h3{font-family:var(--font-crt);font-weight:400;text-shadow:0 0 8px var(--glow)}
h1{margin:0 0 14px;font-size:30px;line-height:1.1;color:var(--accent)}
h2{margin:26px 0 8px;font-size:24px;line-height:1.1;color:var(--accent)}
h3{margin:18px 0 6px;font-size:21px;line-height:1.1;color:var(--text)}
p,ul{margin:0 0 12px}li{margin:2px 0}li::marker{color:var(--faint)}
code,pre{font:13px/1.45 var(--font-mono);background:var(--screen)}code{padding:1px 4px;color:var(--info)}pre{padding:10px 12px;overflow:auto;box-shadow:inset 0 0 0 2px var(--line)}
strong{font-weight:500;color:var(--text)}
.table{overflow:auto;margin:0 0 14px;border:2px solid var(--frame)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 10px;text-align:left;vertical-align:top;border-top:2px solid var(--line)}
th{border-top:0;background:var(--pane-2);font:400 18px/1.1 var(--font-crt);color:var(--muted)}
td{overflow-wrap:anywhere}
.st{white-space:nowrap;color:var(--muted)}.st .tag{font-size:18px}
@media (max-width:700px){body{padding:0}.case{padding:6px}main{padding:16px 12px}}
</style>${themeStyle(theme)}</head><body><div class="case crt-case"><div class="screen crt"><main class="win readable"><span class="lg glow">${escape(legend)}</span>${path ? `<p class="path">${escape(path)}</p>` : ''}${reportBody(markdown, { marks: theme.marks, failInverted: theme.failInverted !== false })}</main></div></div></body></html>`;
};
