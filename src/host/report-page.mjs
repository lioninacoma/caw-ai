// The report as a page: the chat's "open report" opens it in a new tab of the same browser, in the Graphite look and the
// personal mode. It renders the Markdown renderReport and renderReproduceReport write (headings, paragraphs, lists, tables,
// quotes, code, `code`, **bold** and links) and adds only structure it can read off that Markdown reliably:
// - a top bar with the logo, "Report" and the path;
// - the title with a status badge (pass, fail, error, or a reproduction's verdict) and the lines under it as a meta line;
// - summary tiles (passed, failed, not reached, write requests) and the steps as rows with badges, from the results table;
// - hard errors and warnings as lists with icons, write requests in mono, a reproduction's result as label and value, other
//   tables with uppercase headers, diffs as diff lines;
// - screenshots the report links (agent/*.png next to report.md) as thumbnails, inlined from `dir`.
// The headings and fixed lines are recognised in German and English, the languages report.md is written in; the page's own
// words (tiles, badges) follow the report's language, the top bar the reader's.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, isAbsolute } from 'node:path';

import { LANGUAGES, inLanguage, language, t } from '../shared/i18n.mjs';
import { readPrefs } from '../shared/prefs.mjs';
import { FAVICON, MODE_SCRIPT, icon, logo, modeAttr, styleSheet } from './style.mjs';

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescape = (text) => String(text).replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
// Table cells: renderReport escapes | inside a cell as \|.
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
const STATUS = /^(pass|fail|error|skipped|warn)$/;
const BADGE = { pass: ['pass', 'check'], fail: ['fail', 'x'], error: ['warn', 'alert'], warn: ['warn', 'alert'], skipped: ['line', ''] };
const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
// A screenshot bigger than this stays a link: the page is written in one piece.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The fixed texts of report.md in each language it is written in, plus the page's own words in that language. */
let known = null;
const reportTexts = () => {
    known ??= Object.fromEntries(LANGUAGES.map((lang) => [lang, inLanguage(lang, () => ({
        results: cells(t('config.report.results.header')).join('|'),
        failures: t('config.report.failures'),
        warnings: t('config.report.warnings'),
        writes: t('config.report.writes'),
        result: t('config.report.reproduce.result'),
        screenshots: t('config.report.reproduce.screenshots'),
        reason: t('config.report.reason', { reason: '' }),
        note: t('config.report.note', { note: '' }),
        readOnly: t('config.report.reproduce.readOnly'),
        reproduce: t('config.report.reproduce.title', { target: '\u0000', verdict: '\u0000' }).replace(/^# /, '').split('\u0000')[0],
        verdicts: Object.fromEntries(['yes', 'no', 'unclear', 'none'].map((key) => [t(`config.report.reproduce.verdict.${key}`), key])),
        status: Object.fromEntries(Object.keys(BADGE).map((key) => [key, t(`workbench.report.status.${key}`)])),
        tiles: { pass: t('workbench.report.tilePassed'), fail: t('workbench.report.tileFailed'), skipped: t('workbench.report.tileSkipped'), writes: t('workbench.report.tileWrites') },
        steps: t('workbench.report.steps'),
    }))]));
    return known;
};

/** Markdown inline: `code`, **bold** and [text](link); a link to a screenshot that `image` resolves becomes a thumbnail. */
const inlineWith = (image) => (text) => escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
        const src = image(unescape(href));
        if (src === null) return `<code>${label}</code>`;
        return `<button type="button" class="shot" data-full="${escape(src)}" aria-label="${label}"><img src="${escape(src)}" alt="${label}"><span>${label}</span></button>`;
    });

/** The Markdown as blocks: h, table, ul, ol, quote, code, p. */
const blocksOf = (markdown) => {
    const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    const take = (test, strip) => {
        const items = [];
        while (i < lines.length && test.test(lines[i])) {
            items.push(lines[i].replace(strip, ''));
            i += 1;
        }
        return items;
    };
    while (i < lines.length) {
        const line = lines[i];
        const heading = /^(#{1,3}) (.*)$/.exec(line);
        if (heading) {
            blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
            i += 1;
        } else if (/^\s*\|/.test(line) && /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1] ?? '')) {
            const head = cells(line);
            i += 2;
            blocks.push({ type: 'table', head, rows: take(/^\s*\|/, /$^/).map(cells) });
        } else if (/^\s*[-*] /.test(line)) {
            blocks.push({ type: 'ul', items: take(/^\s*[-*] /, /^\s*[-*] /) });
        } else if (/^\d+\. /.test(line)) {
            blocks.push({ type: 'ol', items: take(/^\d+\. /, /^\d+\. /) });
        } else if (/^> ?/.test(line)) {
            blocks.push({ type: 'quote', lines: take(/^> ?/, /^> ?/) });
        } else if (/^```/.test(line)) {
            const lang = line.slice(3).trim();
            i += 1;
            const code = [];
            while (i < lines.length && !/^```/.test(lines[i])) {
                code.push(lines[i]);
                i += 1;
            }
            i += 1;
            blocks.push({ type: 'code', lang, lines: code });
        } else if (line.trim() === '') {
            i += 1;
        } else {
            const paragraph = [];
            while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3} |\s*\||\s*[-*] |\d+\. |> ?|```)/.test(lines[i])) {
                paragraph.push(lines[i]);
                i += 1;
            }
            blocks.push({ type: 'p', lines: paragraph });
        }
    }
    return blocks;
};

/** The language report.md is written in: from the results table, the reproduction title or the title's "on". */
const languageOf = (blocks) => {
    const texts = reportTexts();
    const table = blocks.find((block) => block.type === 'table');
    const title = blocks.find((block) => block.type === 'h' && block.level === 1)?.text ?? '';
    return LANGUAGES.find((lang) => table !== undefined && table.head.join('|') === texts[lang].results)
        ?? LANGUAGES.find((lang) => title.startsWith(texts[lang].reproduce))
        ?? LANGUAGES.find((lang) => title.includes(` ${inLanguage(lang, () => t('cli.uiOn'))} `))
        ?? language();
};

const badge = (status, texts) => {
    const [kind, glyph] = BADGE[status];
    return `<span class="bdg ${kind}" data-status="${status}">${glyph ? icon(glyph) : ''}${escape(texts.status[status])}</span>`;
};

/**
 * Markdown from renderReport or renderReproduceReport as the page's body.
 * @param image (href) => data URL of a linked screenshot, or null to show the link as text
 */
export const reportBody = (markdown, { image = () => null } = {}) => {
    const inline = inlineWith(image);
    const blocks = blocksOf(markdown);
    const lang = languageOf(blocks);
    const texts = reportTexts()[lang] ?? reportTexts().en;
    const out = [];
    let section = null;
    // The heading of the section the block is in, to tell hard errors, warnings, write requests and screenshots apart.
    let heading = '';
    let afterTitle = false;
    const close = () => {
        if (section !== null) out.push('</section>');
        section = null;
    };
    const results = blocks.find((block) => block.type === 'table' && block.head.join('|') === texts.results);
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block.type === 'h' && block.level === 1) {
            close();
            // "<test> on <target>: <status>", or a reproduction's verdict.
            const match = /^(.*): ([^:]+)$/.exec(block.text);
            const status = match === null ? undefined : STATUS.test(match[2]) ? match[2] : undefined;
            const verdict = match === null ? undefined : texts.verdicts[match[2]];
            let mark = '';
            if (status !== undefined) mark = badge(status, texts);
            else if (verdict !== undefined) mark = `<span class="bdg warn" data-verdict="${verdict}">${icon('bug')}${escape(match[2])}</span>`;
            out.push(`<div class="rp-title"><h1>${inline(block.text)}</h1>${mark}</div>`);
            afterTitle = true;
            continue;
        }
        if (afterTitle && block.type === 'p') {
            // The lines under the title: "Label: value" each, the read-only line as its banner.
            const items = block.lines.map((line) => {
                if (line === texts.readOnly) return { banner: line };
                const at = line.indexOf(': ');
                return at === -1 ? { text: line } : { label: line.slice(0, at), value: line.slice(at + 2) };
            });
            out.push(`<div class="rp-meta">${items.filter((item) => item.banner === undefined).map((item) => (item.label === undefined ? `<span>${inline(item.text)}</span>` : `<span>${inline(item.label)} <b>${inline(item.value)}</b></span>`)).join('')}</div>`);
            for (const { banner } of items.filter((item) => item.banner !== undefined)) out.push(`<div class="banner ro">${icon('lock')}<span><p>${inline(banner)}</p></span></div>`);
            afterTitle = false;
            continue;
        }
        if (block.type === 'p' && section === null && (block.lines[0].startsWith(texts.reason) || block.lines[0].startsWith(texts.note))) {
            const reason = block.lines[0].startsWith(texts.reason);
            out.push(`<div class="banner ${reason ? 'fail' : 'info'}">${icon(reason ? 'alert' : 'info')}<span><p>${inline(block.lines.join(' '))}</p></span></div>`);
            continue;
        }
        afterTitle = false;
        if (block === results) {
            close();
            out.push(summary(block, blocks, texts));
            out.push(`<section class="rp-sec"><h2>${escape(texts.steps)}</h2><div class="rp-steps">${block.rows.map((row) => stepRow(row, texts, inline)).join('')}</div></section>`);
            continue;
        }
        if (block.type === 'h' && block.level === 2) {
            close();
            heading = block.text;
            out.push(`<section class="rp-sec"><h2>${inline(block.text)}</h2>`);
            section = heading;
            // The paragraph right after a section heading introduces it.
            if (blocks[index + 1]?.type === 'p' && blocks[index + 2] !== undefined && blocks[index + 2].type !== 'p') {
                out.push(`<p class="intro">${inline(blocks[index + 1].lines.join(' '))}</p>`);
                index += 1;
            }
            continue;
        }
        out.push(render(block, { heading, texts, inline }));
    }
    close();
    return out.join('\n');
};

/** The tiles: passed, failed, not reached (from the results table), write requests (from their section). */
const summary = (results, blocks, texts) => {
    const counts = { pass: 0, fail: 0, skipped: 0 };
    for (const row of results.rows) {
        const status = row[2];
        if (status === 'pass') counts.pass += 1;
        else if (status === 'fail' || status === 'error') counts.fail += 1;
        else counts.skipped += 1;
    }
    const at = blocks.findIndex((block) => block.type === 'h' && block.text === texts.writes);
    const list = at === -1 ? undefined : blocks.slice(at + 1).find((block) => block.type === 'ul' || block.type === 'h');
    const writes = list?.type === 'ul' ? list.items.reduce((sum, item) => sum + Number(/\((\d+)x\)$/.exec(item)?.[1] ?? 1), 0) : 0;
    const tile = (kind, count, label) => `<div class="rp-n ${kind}" data-tile="${kind}"><b>${count}</b><span>${escape(label)}</span></div>`;
    return `<div class="rp-sum">${tile('pass', counts.pass, texts.tiles.pass)}${tile('fail', counts.fail, texts.tiles.fail)}${tile('skip', counts.skipped, texts.tiles.skipped)}${tile('writes', writes, texts.tiles.writes)}</div>`;
};

/** A row of the results table: id, expectation with evidence and note, badge, screenshot. */
const stepRow = ([id = '', expectation = '', status = '-', evidence = '', note = ''], texts, inline) => {
    const state = STATUS.test(status) ? status : 'skipped';
    const shot = /^screenshot: /.test(evidence) ? inline(evidence.replace(/^screenshot: /, '')) : '';
    const thumb = shot.startsWith('<button') ? shot : '';
    const proof = /^(-|:?\s*)$/.test(evidence) || thumb !== '' ? '' : `<p class="ev">${inline(evidence)}</p>`;
    const remark = note === '' ? '' : `<p class="nt${state === 'fail' || state === 'error' ? ' bad' : ''}">${inline(note)}</p>`;
    return `<div class="rp-step" data-status="${state}"><span class="sid">${escape(id)}</span><div class="rp-what"><b>${inline(expectation)}</b>${remark}${proof}</div><div>${badge(state, texts)}</div><div class="rp-shot">${thumb}</div></div>`;
};

const render = (block, { heading, texts, inline }) => {
    switch (block.type) {
        case 'h':
            return `<h3>${inline(block.text)}</h3>`;
        case 'table': {
            const td = (cell) => (STATUS.test(cell) ? `<td>${badge(cell, texts)}</td>` : `<td>${inline(cell)}</td>`);
            return `<div class="rp-tab"><table><thead><tr>${block.head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map(td).join('')}</tr>`).join('')}</tbody></table></div>`;
        }
        case 'ul': {
            // Screenshots: a row of thumbnails.
            const shots = block.items.map(inline);
            if (shots.every((html) => /^<button type="button" class="shot"[^]*<\/button>$/.test(html))) return `<div class="shots">${shots.join('')}</div>`;
            const kind = heading === texts.failures ? ['e', 'x'] : heading === texts.warnings ? ['w', 'alert'] : null;
            if (kind !== null) return `<ul class="rp-list">${shots.map((html) => `<li class="${kind[0]}">${icon(kind[1])}<span>${html}</span></li>`).join('')}</ul>`;
            if (heading === texts.writes) return `<ul class="rp-list mono">${shots.map((html) => `<li>${html}</li>`).join('')}</ul>`;
            // A reproduction's result: observed, expected, cause.
            if (heading === texts.result) {
                return `<dl class="kv">${block.items.map((item) => {
                    const at = item.indexOf(': ');
                    return at === -1 ? `<dd>${inline(item)}</dd>` : `<dt>${inline(item.slice(0, at))}</dt><dd>${inline(item.slice(at + 2))}</dd>`;
                }).join('')}</dl>`;
            }
            return `<ul>${shots.map((html) => `<li>${html}</li>`).join('')}</ul>`;
        }
        case 'ol':
            return `<ol>${block.items.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`;
        case 'quote':
            return `<blockquote>${block.lines.map(inline).join('<br>')}</blockquote>`;
        case 'code':
            if (block.lang === 'diff') {
                return `<div class="diff">${block.lines.map((line) => {
                    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
                    return `<div class="dl ${kind}"><span class="n"></span><span class="sg">${escape(kind === '' ? ' ' : line[0])}</span><code>${escape(kind === '' ? line : line.slice(2))}</code></div>`;
                }).join('')}</div>`;
            }
            return `<pre>${escape(block.lines.join('\n'))}</pre>`;
        default:
            return `<p>${inline(block.lines.join(' '))}</p>`;
    }
};

/**
 * The screenshots a report links, as data URLs: only image files inside `dir` (the run folder), up to MAX_IMAGE_BYTES.
 * @returns (href) => data URL or null
 */
export const imagesIn = (dir) => (href) => {
    if (typeof dir !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    let path;
    try {
        path = join(dir, decodeURI(href));
    } catch {
        return null;
    }
    const type = IMAGE[extname(path).toLowerCase()];
    if (type === undefined || !existsSync(path)) return null;
    try {
        // Also through links: what is read must lie in the run folder.
        const inside = relative(realpathSync(dir), realpathSync(path));
        if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
        if (!statSync(path).isFile() || statSync(path).size > MAX_IMAGE_BYTES) return null;
        return `data:${type};base64,${readFileSync(path).toString('base64')}`;
    } catch {
        return null;
    }
};

// A click on a thumbnail shows the screenshot large; Esc or a click closes it.
const VIEWER = `document.addEventListener('click',(event)=>{const shot=event.target.closest('.shot');const view=document.getElementById('view');
if(shot){view.querySelector('img').src=shot.dataset.full;view.showModal();}else if(event.target.closest('#view'))view.close();});`;

/**
 * The whole page.
 * @param mode the personal mode pref (system, light or dark)
 * @param dir  the run folder: screenshots the report links are shown from there
 */
export const reportPage = ({ markdown, path = '', mode = readPrefs().mode, dir }) => {
    const title = t('workbench.report.title');
    return `<!doctype html><html lang="${language()}"${modeAttr(mode)}><head><meta charset="utf-8"><title>caw · ${escape(title)}</title><script>${MODE_SCRIPT}</script>${FAVICON}<style>
${styleSheet()}
html{background:var(--bg)}
body{margin:0;color:var(--text);font-size:13.5px;line-height:1.55}
.top{display:flex;align-items:center;gap:12px;padding:12px 24px;background:var(--nav);color:var(--nav-text);border-bottom:1px solid var(--nav-line)}
.top b{font:600 18px/1 var(--font);letter-spacing:-.04em}.top .what{color:var(--nav-muted)}
.top .path{margin-left:auto;font:400 11.5px/1.3 var(--font-mono);color:var(--nav-muted);overflow-wrap:break-word;text-align:right;min-width:0}
main{max-width:1100px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:20px}
h1,h2,h3{font-family:var(--font);letter-spacing:-.01em;margin:0}
h1{font-size:26px;font-weight:600;line-height:1.15;overflow-wrap:anywhere}
h2{font-size:15px;font-weight:600;line-height:1.2}
h3{font-size:13.5px;font-weight:600;line-height:1.3;margin-top:6px}
p,ul,ol{margin:0}ul,ol{padding-left:20px;display:flex;flex-direction:column;gap:3px}li::marker{color:var(--faint)}
code,pre{font:12px/1.45 var(--font-mono);background:var(--code);color:var(--code-text)}code{padding:1px 4px;border-radius:4px;overflow-wrap:break-word}
pre{margin:0;padding:10px 12px;overflow:auto;border:1px solid var(--line);border-radius:var(--r1);white-space:pre-wrap;overflow-wrap:break-word}
strong{font-weight:600;color:var(--text)}
blockquote{margin:0;padding:8px 12px;border-radius:var(--r1);background:var(--panel2);font-style:italic;overflow-wrap:break-word}
.rp-title{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.rp-meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:var(--muted);margin-top:-8px}
.rp-meta b{color:var(--text);font-weight:500}.rp-meta code{font-size:11.5px}
.rp-sum{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.rp-n{padding:12px 14px;border-radius:var(--r2);background:var(--panel);border:1px solid var(--line)}
.rp-n b{display:block;font:600 24px/1 var(--font);font-variant-numeric:tabular-nums;margin-bottom:6px}
.rp-n span{font-size:12px;color:var(--muted)}
.rp-n.pass b{color:var(--pass)}.rp-n.fail b{color:var(--fail)}.rp-n.skip b{color:var(--faint)}
.rp-sec{display:flex;flex-direction:column;gap:10px;min-width:0}
.rp-sec .intro{font-size:12.5px;color:var(--muted);max-width:90ch}
.rp-steps{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);overflow:hidden}
.rp-step{display:grid;grid-template-columns:44px minmax(0,1fr) 112px 150px;gap:16px;align-items:start;padding:12px 14px;border-top:1px solid var(--line)}
.rp-step:first-child{border-top:0}
.rp-step .sid{padding-top:2px;font:500 11.5px/1.4 var(--font-mono);color:var(--faint)}
.rp-what{display:flex;flex-direction:column;gap:3px;min-width:0}.rp-what b{font-weight:500}
.rp-what .nt{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}.rp-what .nt.bad{color:var(--fail)}
.rp-what .ev{font:400 11px/1.45 var(--font-mono);color:var(--faint);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.rp-what .ev code{background:none;padding:0;color:inherit;font:inherit}
.rp-step[data-status=skipped] .rp-what b{color:var(--muted)}
.shot{display:flex;flex-direction:column;gap:4px;width:150px;padding:0;border:0;background:none;cursor:zoom-in;text-align:left;color:var(--muted);font:500 10.5px/1.2 var(--font-mono)}
.shot img{display:block;width:150px;height:84px;object-fit:cover;object-position:top;border-radius:var(--r1);border:1px solid var(--line);background:var(--panel2)}
.shot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-step[data-status=fail] .shot img{box-shadow:0 0 0 2px var(--fail);border-color:transparent}
.shots{display:flex;flex-wrap:wrap;gap:12px}
#view{border:0;padding:0;background:none;max-width:92vw;max-height:92vh}#view::backdrop{background:var(--overlay)}
#view img{display:block;max-width:92vw;max-height:92vh;border-radius:var(--r2);box-shadow:var(--shadow-lg);cursor:zoom-out}
.rp-tab{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--r2)}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{text-align:left;font:600 11px/1 var(--font);letter-spacing:.05em;text-transform:uppercase;color:var(--faint);padding:9px 12px;background:var(--panel2);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 12px;text-align:left;vertical-align:top;border-top:1px solid var(--line);font:400 11.5px/1.45 var(--font-mono);overflow-wrap:break-word}
tr:first-child td{border-top:0}td code{background:none;padding:0}
.rp-list{list-style:none;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.rp-list li{display:flex;gap:8px;padding:8px 12px;border-radius:var(--r1);background:var(--panel);border:1px solid var(--line);overflow-wrap:anywhere;min-width:0}
.rp-list li>span{min-width:0}.rp-list .i{width:14px;height:14px;margin-top:2px}
.rp-list .e .i{color:var(--fail)}.rp-list .w .i{color:var(--warn)}.rp-list.mono li{font:400 11.5px/1.45 var(--font-mono)}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:break-word}
.banner p{overflow-wrap:break-word}
@media (max-width:760px){.top{padding:12px 16px;flex-wrap:wrap}.top .path{margin-left:0;text-align:left;flex-basis:100%}main{padding:16px}
.rp-sum{grid-template-columns:repeat(2,minmax(0,1fr))}.rp-step{grid-template-columns:36px minmax(0,1fr);gap:8px 12px}.rp-step>div:nth-child(3),.rp-step>.rp-shot{grid-column:2}}
</style></head><body><header class="top">${logo({ size: 24 })}<b>caw</b><span class="what">${escape(title)}</span>${path ? `<span class="path">${escape(path)}</span>` : ''}</header>
<main>${reportBody(markdown, { image: imagesIn(dir) })}</main><dialog id="view"><img alt=""></dialog><script>${VIEWER}</script></body></html>`;
};
