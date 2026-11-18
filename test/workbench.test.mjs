import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHAT_KEYS, workbenchHtml } from '../src/host/workbench.mjs';
import { benchFacts, titleOf } from '../src/host/run.mjs';

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
    assert.match(html, /<span id="transport" class="tp" role="img"><i><\/i><span><\/span><\/span><\/div><\/header>/, 'right of the pill');
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
    assert.equal(titleOf(spec, 'record'), 'Claude nimmt morning-errand auf');
    assert.equal(titleOf(spec, 'repair', { id: 'S2' }), 'Claude behebt S2 von morning-errand');
    // One environment, one role, no overlay: the title alone.
    assert.deepEqual(benchFacts(one, spec, local, 'T'), [['', 'T']]);
    // Several environments and roles: both chips.
    const many = { environments: { local: {}, staging: {} }, roles: { user: {}, admin: {} } };
    assert.deepEqual(benchFacts(many, spec, { ...local, name: 'staging' }, 'T'), [['', 'T'], ['Umgebung', 'staging'], ['Rolle', 'user']]);
    // Production is always named, even as the only environment; the code only under an overlay.
    assert.deepEqual(benchFacts(one, spec, { name: 'prod', production: true, source: 'overlay' }, 'T'), [['', 'T'], ['Umgebung', 'prod'], ['Code', 'lokaler Build']]);
});
