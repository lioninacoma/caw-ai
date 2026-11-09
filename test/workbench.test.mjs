import assert from 'node:assert/strict';
import { test } from 'node:test';

import { workbenchHtml } from '../src/host/workbench.mjs';

test('Werkbank: Ohne eigene Wahl klappt die Schrittliste in schmalen Fenstern ein, eine Wahl gilt immer', () => {
    const free = workbenchHtml({ appUrl: 'about:blank', title: 't' });
    assert.match(free, /let autoSteps=true;/);
    assert.match(free, /innerWidth<1500/);
    assert.match(free, /@media \(max-width:999px\)/, 'gestapelt erst unter 1000px');
    for (const steps of ['open', 'closed']) assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps } }), /let autoSteps=false;/);
    assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps: 'closed' } }), /<body class="[^"]*fold-steps/);
});
