import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHAT_KEYS, workbenchHtml } from '../src/host/workbench.mjs';
import { badgeOf, benchFacts, benchSettings, titleOf } from '../src/host/run.mjs';
import { languageSource } from '../src/shared/i18n.mjs';

test('workbench: without an own choice the step list collapses in narrow windows, a choice always wins', () => {
    const free = workbenchHtml({ appUrl: 'about:blank', title: 't' });
    assert.match(free, /let autoSteps=true;/);
    assert.match(free, /innerWidth<1500/);
    assert.match(free, /@media \(max-width:999px\)/, 'stacked only below 1000px');
    for (const steps of ['open', 'closed']) assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps } }), /let autoSteps=false;/);
    assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps: 'closed' } }), /<body class="[^"]*fold-steps/);
});

test('workbench: the chip at the top right (REC, PLAY, PAUSE) is there but off without a run; recording pulses only without F10', () => {
    const html = workbenchHtml({ appUrl: 'about:blank', title: 't' });
    assert.match(html, /<span id="state" class="pill" role="status"><\/span><span id="transport" class="tp" role="img"><i><\/i><span><\/span><\/span><button type="button" class="ib" id="more"/, 'right of the pill, before ⋯');
    assert.match(html, /#transport\{display:none\}/, 'no chip without a run');
    assert.match(html, /chip\.className='tp'\+\(mode===null\?'':' on '\+\(\{record:'rec',play:'play',pause:'pause'\}\)\[mode\]\)/);
    assert.match(html, /\.still \*,\.still \*::before,\.still \*::after\{animation:none!important/, 'F10 also stops the recording pulse');
});

test('workbench: Graphite in the personal mode, no theme machinery, and a title cannot end a <script>', () => {
    const html = workbenchHtml({ appUrl: 'about:blank', title: '</script><b>', prefs: { mode: 'dark' } });
    assert.match(html, /^<!doctype html><html lang="\w+" data-pref="dark" data-mode="dark"><head>/);
    assert.match(html, /<script>function cawMode\(root\)/, 'the mode script comes first');
    assert.match(html, /font-family:"Geist"/);
    assert.match(html, /<svg class="logo"/);
    assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't' }), /data-pref="system"/);
    assert.doesNotMatch(html.replace(/base64,[A-Za-z0-9+/=]+/g, ''), /theme|cawRaven|cawGlyph|<b>F7<|'F7'|font-crt/i);
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.doesNotMatch(script.slice(0, script.indexOf('</script>')), /<\/script><b>/);
    assert.ok(!CHAT_KEYS.includes('F5') && !CHAT_KEYS.includes('Escape'), 'the chat triggers neither reload nor abort in the workbench');
    assert.ok(!CHAT_KEYS.includes('F7'));
});

test('workbench header: the title is a sentence with the test; chips only where the project offers a choice', () => {
    const spec = { id: 'morning-errand', role: 'user' };
    const one = { environments: { local: {} }, roles: { user: {} } };
    const local = { name: 'local', production: false, source: 'deployed' };
    assert.equal(titleOf(spec, 'record'), 'Claude Code nimmt morning-errand auf');
    assert.equal(titleOf(spec, 'repair', { id: 'S2' }), 'Claude Code behebt S2 von morning-errand');
    // One environment, one role, no overlay: the title alone.
    assert.deepEqual(benchFacts(one, spec, local, 'T'), [['', 'T']]);
    // Several environments and roles: both chips.
    const many = { environments: { local: {}, staging: {} }, roles: { user: {}, admin: {} } };
    assert.deepEqual(benchFacts(many, spec, { ...local, name: 'staging' }, 'T'), [['', 'T'], ['Umgebung', 'staging'], ['Rolle', 'user']]);
    // Production is always named, even as the only environment; the code only under an overlay.
    assert.deepEqual(benchFacts(one, spec, { name: 'prod', production: true, source: 'overlay' }, 'T'), [['', 'T'], ['Umgebung', 'prod'], ['Code', 'lokaler Build']]);
    // The badge carries the mode only: the breadcrumb names the test.
    assert.deepEqual(benchFacts(one, spec, local, 'T', badgeOf('record')), [['', 'T', 'Claude Code nimmt auf']]);
    assert.equal(badgeOf('repair', { id: 'S2' }), 'Claude Code behebt S2');
    assert.equal(badgeOf('reproduce'), 'Claude Code stellt nach');
});

test('workbench: no toolbars; one ⋯ menu lists every function with its key, the keys stay', () => {
    const html = workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { animations: 'off' } });
    assert.doesNotMatch(html, /class="fkeys"|class="fk[ "]|solo-btn/, 'no F-key bar, no button row');
    const menu = html.slice(html.indexOf('<div id="menu"'), html.indexOf('<main class="panes">'));
    const keys = [...menu.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map(([, key]) => key);
    assert.deepEqual(keys, ['F9', 'F5', 'Esc', 'F1', 'F2', 'F3', 'F4', 'F6', 'F8', 'F10', 'Strg ,', '?']);
    assert.match(menu, /id="reload" data-press="F5" disabled/, 'reload locked until the hand-over');
    assert.match(menu, /data-states data-press="F1" hidden/, 'Open… only when offered');
    assert.match(menu, /role="menuitemcheckbox" tabindex="-1" id="still" aria-checked="true"/);
    assert.match(html, /id="more" aria-haspopup="menu" aria-expanded="false" aria-controls="menu"/);
    // The chat forwards these keys and posts them for its slash commands: views and menus only, never a decision.
    assert.deepEqual(CHAT_KEYS, ['F1', 'F2', 'F3', 'F4', 'F6', 'F8', 'F10', 'Ctrl+,', 'Ctrl+K', '?']);
});

test('workbench: the chat placeholder takes a new mode only from its parent and only one of the three', () => {
    const html = workbenchHtml({ appUrl: 'about:blank', title: 't' });
    const srcdoc = html.slice(html.indexOf('srcdoc="'));
    assert.match(srcdoc.slice(0, srcdoc.indexOf('</iframe>')), /event\.source===parent&amp;&amp;event\.data\?\.caw==='mode'&amp;&amp;\[&quot;system&quot;,&quot;light&quot;,&quot;dark&quot;\]\.includes\(p\)\)document\.documentElement\.dataset\.pref=p/);
});

test('settings data: names, flags and line counts; home as ~, never the content of a note; the language with its source', () => {
    const home = mkdtempSync(join(tmpdir(), 'caw-set-'));
    const root = join(home, 'errand');
    mkdirSync(join(root, 'caw'), { recursive: true });
    writeFileSync(join(root, 'caw', 'caw.md'), 'secret one\nsecret two\n');
    writeFileSync(join(home, 'caw.md'), 'personal secret');
    writeFileSync(join(home, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' }));
    try {
        const env = { ...process.env, CAW_AI_HOME: home };
        const data = benchSettings({ root, config: {}, spec: { id: 't', role: 'user' }, checked: { name: 'local', url: 'http://localhost:4173', agent: true, writable: false, production: false, source: 'deployed' }, agent: 'Docker', env });
        assert.equal(data.project, 'errand');
        assert.deepEqual(data.env, { name: 'local', url: 'http://localhost:4173', agent: true, writable: false, production: false });
        assert.equal(data.role, 'user');
        assert.equal(data.agent, 'Docker');
        assert.equal(data.tokenNotice, 'off');
        assert.deepEqual(data.projectNotes, { path: 'caw/caw.md', lines: 2 });
        assert.equal(data.personal.lines, 1);
        assert.deepEqual(data.language, { value: 'de', source: 'env' }, 'the tests run with CAW_LANG=de');
        assert.match(data.version, /^caw \S+ · Node \d+$/);
        assert.doesNotMatch(JSON.stringify(data), /secret/, 'never the content');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
    assert.equal(languageSource({ env: {}, prefs: () => ({ language: 'en' }) }), 'prefs');
    assert.equal(languageSource({ env: {}, prefs: () => ({}), team: 'de' }), 'project');
    assert.equal(languageSource({ env: {}, prefs: () => ({}), team: 'fr' }), 'system');
});
