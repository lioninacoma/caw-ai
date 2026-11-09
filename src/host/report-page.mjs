// Der Bericht als Seite im Pixel-Theme: Aus dem Chat öffnet „Bericht öffnen“ ihn in einem neuen Reiter desselben Browsers.
// Es reicht das Markdown, das renderReport schreibt: Überschriften, Absätze, Listen, Tabellen, `Code` und **fett**.
import { language, t } from '../shared/i18n.mjs';
import { FAVICON, FONT_FACES, PAGE_BG, PIXEL_CSS, TOKENS, ring } from './theme.mjs';

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (text) => escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
const STATUS = /^(pass|fail|error|skipped|warn)$/;

/** Markdown aus renderReport als HTML-Körper. */
export const reportBody = (markdown) => {
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
            const td = (cell) => (STATUS.test(cell) ? `<td><span class="st st-${cell}">${cell}</span></td>` : `<td>${inline(cell)}</td>`);
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
            const text = [];
            while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3} |\s*\||\s*[-*] |```)/.test(lines[i])) {
                text.push(lines[i]);
                i += 1;
            }
            out.push(`<p>${inline(text.join(' '))}</p>`);
        }
    }
    return out.join('\n');
};

/** Die ganze Seite. theme: 'light' | 'dark' | '' (System). */
export const reportPage = ({ markdown, path = '', theme = '' }) => `<!doctype html><html lang="${language()}"${theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><title>caw-ai · ${t('workbench.report.title')}</title>${FAVICON}<style>
${FONT_FACES}${TOKENS}${PIXEL_CSS}
*{box-sizing:border-box}
body{margin:0;${PAGE_BG};color:var(--text);font:var(--fs-body)/1.5 var(--font-body)}
main{max-width:1100px;margin:24px auto;padding:24px 28px;background:var(--surface);box-shadow:${ring('3px', 'var(--frame)')},6px 6px 0 var(--shadow)}
.path{margin:0 0 6px;font:var(--fs-meta) var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);overflow-wrap:anywhere}
h1{margin:0 0 12px;font:400 22px/1.3 var(--font-deco)}h2{margin:28px 0 8px;font:500 15px var(--font-ui);letter-spacing:.06em;text-transform:uppercase}h3{margin:20px 0 6px;font-size:15px}
p,ul{margin:0 0 12px}li{margin:2px 0}
code,pre{font:13px/1.45 var(--font-mono);background:var(--surface-2)}code{padding:1px 4px}pre{padding:10px 12px;overflow:auto;box-shadow:${ring('2px', 'var(--line)')}}
.table{overflow:auto;margin:0 0 14px;box-shadow:${ring('2px', 'var(--frame)')}}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 10px;text-align:left;vertical-align:top;border-top:2px solid var(--line)}
th{border-top:0;background:var(--surface-2);font:500 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
td{overflow-wrap:anywhere}
.st{display:inline-block;padding:1px 6px;font:500 11px var(--font-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--icon-ink)}
.st-pass{background:var(--ok)}.st-fail,.st-error{background:var(--fail)}.st-warn{background:var(--warn)}.st-skipped{background:var(--pending)}
@media (max-width:700px){main{margin:0;padding:16px}}
</style></head><body><main>${path ? `<p class="path">${escape(path)}</p>` : ''}${reportBody(markdown)}</main></body></html>`;
