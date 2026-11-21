// The guide topics (templates/guide/): every topic exists and is clean of old names; the index follows the active
// extensions; run agents get the run topics; the session instructions stay short.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { language, setLanguage } from '../src/shared/i18n.mjs';
import { GUIDE_TOPICS, SESSION_INSTRUCTIONS, agentGuide, guideIndex, guideTopic, listedTopics, runTopics } from '../src/host/guide.mjs';
import { sessionTools } from '../src/host/session-mcp.mjs';

const DIR = fileURLToPath(new URL('../templates/guide/', import.meta.url));

test('guide: one file per topic and no file without a topic; none names old commands, keys or skill paths', () => {
    assert.deepEqual(readdirSync(DIR).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort(), GUIDE_TOPICS.map(({ name }) => name).sort());
    for (const { name } of GUIDE_TOPICS) {
        const text = guideTopic(name);
        assert.match(text, /^# caw: /, name);
        for (const old of ['caw-ai ', '--target', 'mutates', 'targets', 'caw_explore', 'SKILL.md', '/caw-ai', '$CAW_AGENT_DIR', '/tmp/', '{{today']) {
            assert.ok(!text.includes(old), `${name} contains ${old}`);
        }
    }
    assert.throws(() => guideTopic('skill'), /Unknown topic: skill/);
});

test('guide index: overlay and extjs only while active', () => {
    const names = (config) => listedTopics(config).map(({ name }) => name);
    assert.ok(!names({ framework: 'web' }).includes('overlay'));
    assert.ok(!names({ framework: 'web' }).includes('extjs'));
    assert.ok(names({ overlay: { environments: ['dev'] } }).includes('overlay'));
    assert.ok(names({ framework: 'extjs' }).includes('extjs'));
    assert.match(guideIndex(undefined), /^- overview: /);
    assert.doesNotMatch(guideIndex(undefined), /overlay|extjs/);
});

test('run topics: per mode, record or repair by creating; extjs added when the app uses it', () => {
    assert.deepEqual(runTopics('run', { creating: true }), ['agent', 'plan', 'record', 'chat', 'rules']);
    assert.deepEqual(runTopics('run'), ['agent', 'plan', 'fix', 'cause', 'chat', 'rules']);
    assert.deepEqual(runTopics('advise'), ['advise', 'cause', 'rules']);
    assert.deepEqual(runTopics('talk', { config: { framework: 'extjs' } }), ['talk', 'cause', 'rules', 'extjs']);
    const guide = agentGuide({ framework: 'web' });
    assert.match(guide, /# caw: the flow of a run/);
    assert.match(guide, /# caw: rules/);
    assert.doesNotMatch(guide, /# caw: set up a project|# caw: ExtJS/);
    assert.match(agentGuide({ framework: 'extjs' }), /# caw: ExtJS applications/);
});

test('session instructions: at most 12 lines, name caw_guide and the four entry topics', () => {
    assert.ok(SESSION_INSTRUCTIONS.split('\n').length <= 12);
    for (const word of ['caw_guide', '"setup"', '"tests"', '"run"', '"session"', 'caw/.env']) assert.ok(SESSION_INSTRUCTIONS.includes(word), word);
});

test('guide: the overview starts with the principle, names every tool and every session topic; rules carry both rules', () => {
    const overview = guideTopic('overview');
    assert.match(overview.split('\n').slice(0, 6).join('\n'), /\*\*The principle:\*\*.*check stays/s);
    for (const { name } of sessionTools({ root: '.' })) assert.ok(overview.includes(`\`${name}\``), `overview names ${name}`);
    for (const topic of ['setup', 'tests', 'run', 'reproduce', 'session', 'attach', 'design']) assert.ok(overview.includes(`\`${topic}\``), topic);
    const rules = guideTopic('rules');
    assert.match(rules, /An unchanged expectation keeps its check/);
    assert.match(rules, /When the assessment points to the app, find the cause before any change/);
    assert.match(guideTopic('attach'), /Never edit `caw\/tests` or recordings to make a run pass/);
    assert.match(SESSION_INSTRUCTIONS, /An unchanged expectation keeps its check/);
});

test('guide: caw buttons appear as the person sees them, in the UI language, and no placeholder stays', () => {
    const saved = language();
    try {
        setLanguage('de');
        assert.match(guideTopic('run'), /"Schritt beheben"/);
        assert.match(guideTopic('session'), /"Neu öffnen" in the chat/);
        setLanguage('en');
        assert.match(guideTopic('run'), /"Fix step"/);
        for (const { name } of GUIDE_TOPICS) assert.doesNotMatch(guideTopic(name), /\{\{label:/, name);
    } finally {
        setLanguage(saved);
    }
});
