// Files for upload come from caw/fixtures only: named relative to the caw folder, found by name, size and SHA-256.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixtureFiles, fixturePath, matchFixture } from '../src/host/fixtures.mjs';

const project = (t) => {
    const caw = mkdtempSync(join(tmpdir(), 'caw-fixtures-'));
    t.after(() => rmSync(caw, { recursive: true, force: true }));
    mkdirSync(join(caw, 'fixtures', 'briefe'), { recursive: true });
    writeFileSync(join(caw, 'fixtures', 'brief.pdf'), '%PDF-1.4 a');
    writeFileSync(join(caw, 'fixtures', 'briefe', 'antrag.pdf'), '%PDF-1.4 bb');
    writeFileSync(join(caw, 'caw.md'), 'no fixture');
    return caw;
};
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('fixturePath: only existing files inside caw/fixtures, normalized; nothing absolute or outside', (t) => {
    const caw = project(t);
    assert.equal(fixturePath(caw, 'fixtures/brief.pdf'), 'fixtures/brief.pdf');
    assert.equal(fixturePath(caw, 'fixtures/./briefe/antrag.pdf'), 'fixtures/briefe/antrag.pdf');
    assert.equal(fixturePath(caw, 'fixtures/fehlt.pdf'), null, 'missing');
    assert.equal(fixturePath(caw, 'caw.md'), null, 'in the caw folder, but not in fixtures');
    assert.equal(fixturePath(caw, 'fixtures/../caw.md'), null);
    assert.equal(fixturePath(caw, join(caw, 'fixtures', 'brief.pdf')), null, 'absolute');
    assert.equal(fixturePath(caw, 'fixtures'), null, 'the folder itself');
    assert.deepEqual(fixtureFiles(caw), ['fixtures/brief.pdf', 'fixtures/briefe/antrag.pdf']);
});

test('fixturePath: a link in fixtures that leads outside is no fixture', (t) => {
    const caw = project(t);
    try {
        symlinkSync(join(caw, 'caw.md'), join(caw, 'fixtures', 'link.md'));
    } catch {
        return t.skip('no symlinks here');
    }
    assert.equal(fixturePath(caw, 'fixtures/link.md'), null);
    assert.ok(!fixtureFiles(caw).includes('fixtures/link.md'));
    return undefined;
});

test('matchFixture: same name, size and hash; another file of the same name is not it', (t) => {
    const caw = project(t);
    assert.equal(matchFixture(caw, { name: 'antrag.pdf', size: 11, sha256: sha('%PDF-1.4 bb') }), 'fixtures/briefe/antrag.pdf');
    assert.equal(matchFixture(caw, { name: 'brief.pdf', size: 10 }), 'fixtures/brief.pdf', 'without a hash by name and size');
    assert.equal(matchFixture(caw, { name: 'brief.pdf', size: 10, sha256: sha('%PDF-1.4 x') }), null, 'same name and size, other content');
    assert.equal(matchFixture(caw, { name: 'brief.pdf', size: 11 }), null, 'other size');
    assert.equal(matchFixture(caw, { name: 'privat.pdf', size: 10 }), null, 'not in fixtures');
    assert.equal(matchFixture(caw, { name: 'brief.pdf' }), null, 'no size');
});
