// The report as a page: the chat's "open report" opens it in a new tab of the same browser, in the Graphite look and the
// personal mode. It only needs the Markdown renderReport writes: headings, paragraphs, lists, tables, `code` and **bold**.
import { language, t } from '../shared/i18n.mjs';
import { readPrefs } from '../shared/prefs.mjs';
import { FAVICON, MODE_SCRIPT, logo, modeAttr, styleSheet } from './style.mjs';

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (text) => escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
const STATUS = /^(pass|fail|error|skipped|warn)$/;
// The mark of each status.
const MARK = { pass: ['ok', '✓'], fail: ['fail', '✕'], error: ['fail', '✕'], warn: ['warn', '!'], skipped: ['open', '○'] };

/** Markdown from renderReport as HTML body. */
export const reportBody = (markdown) => {
    const mark = (status) => {
        const [kind, char] = MARK[status];
        return `<span class="st st-${status}"><span class="tag tag-${kind}">${char}</span> ${status}</span>`;
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

/** The whole page; `mode` is the personal mode pref (system, light or dark). */
export const reportPage = ({ markdown, path = '', mode = readPrefs().mode }) => {
    const title = t('workbench.report.title');
    return `<!doctype html><html lang="${language()}"${modeAttr(mode)}><head><meta charset="utf-8"><title>caw · ${escape(title)}</title><script>${MODE_SCRIPT}</script>${FAVICON}<style>
${styleSheet()}
html{background:var(--bg)}
body{margin:0;color:var(--text);font-size:13.5px;line-height:1.55}
.top{display:flex;align-items:center;gap:12px;padding:12px 24px;background:var(--nav);color:var(--nav-text);border-bottom:1px solid var(--nav-line)}
.top b{font:600 18px/1 var(--font);letter-spacing:-.04em}.top span{color:var(--nav-muted)}
.top .path{margin-left:auto;font:400 11.5px/1 var(--font-mono);overflow-wrap:anywhere;text-align:right}
main{max-width:1100px;margin:0 auto;padding:24px}
h1,h2,h3{font-family:var(--font);letter-spacing:-.01em}
h1{margin:0 0 14px;font-size:26px;font-weight:600;line-height:1.15}
h2{margin:26px 0 8px;font-size:17px;font-weight:600;line-height:1.2}
h3{margin:18px 0 6px;font-size:15px;font-weight:600;line-height:1.2}
p,ul{margin:0 0 12px}li{margin:2px 0}li::marker{color:var(--faint)}
code,pre{font:12px/1.45 var(--font-mono);background:var(--code);color:var(--code-text)}code{padding:1px 4px;border-radius:4px}pre{padding:10px 12px;overflow:auto;border:1px solid var(--line);border-radius:var(--r1)}
strong{font-weight:600;color:var(--text)}
.table{overflow:auto;margin:0 0 14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r2)}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{padding:8px 12px;text-align:left;vertical-align:top;border-top:1px solid var(--line)}
th{border-top:0;background:var(--panel2);font:600 11px/1 var(--font);letter-spacing:.05em;text-transform:uppercase;color:var(--faint)}
td{overflow-wrap:anywhere}
.st{white-space:nowrap;color:var(--muted)}.tag{font-weight:600}
.tag-ok{color:var(--pass)}.tag-fail{color:var(--fail)}.tag-warn{color:var(--warn)}.tag-open{color:var(--faint)}
@media (max-width:700px){.top{padding:12px 16px;flex-wrap:wrap}.top .path{margin-left:0;text-align:left}main{padding:16px}}
</style></head><body><header class="top">${logo({ size: 24 })}<b>caw</b><span>${escape(title)}</span>${path ? `<span class="path">${escape(path)}</span>` : ''}</header><main>${reportBody(markdown)}</main></body></html>`;
};
