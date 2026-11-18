import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requestName } from '../src/host/network-log.mjs';
import { classifyRequest, compileRead, compileReads, graphqlOf, graphqlOperations, parseRequestName } from '../src/shared/requests.mjs';
import { validateConfig } from '../src/shared/config.mjs';

const json = (body) => ({ postData: JSON.stringify(body), contentType: 'application/json' });
const name = (method, path, extra = {}, keys = []) => requestName({ method, url: `https://app.example${path}`, ...extra }, keys);

test('request name: method and neutral path, query keys and json.<key> with values, cut at 120 characters', () => {
    assert.equal(name('post', '/api/tickets/1234'), 'POST /api/tickets/:id');
    assert.equal(name('GET', '/c?action=load&x=1', {}, ['action']), 'GET /c action=load');
    assert.equal(name('POST', '/rpc', json({ method: 'Case.load', id: 7 }), ['json.method']), 'POST /rpc json.method=Case.load');
    assert.equal(name('POST', '/rpc', json([{ method: 'first' }, { method: 'second' }]), ['json.method']), 'POST /rpc json.method=first', 'a batch: the first entry');
    assert.equal(name('POST', '/rpc', json({ method: { nested: true } }), ['json.method']), 'POST /rpc', 'only plain values');
    assert.equal(name('POST', '/rpc?method=q', json({ method: 'b' }), ['method']), 'POST /rpc method=q', 'a plain key is a query parameter, not a body field');
    assert.equal(name('POST', '/rpc', json({ method: 'x'.repeat(200) }), ['json.method']).length, 'POST /rpc json.method='.length + 120);
    assert.equal(name('POST', '/rpc', { postData: 'not json', contentType: 'application/json' }, ['json.method']), 'POST /rpc');
});

test('GraphQL: operation type and name from the selected operation; shorthand, anonymous, persisted, batch, application/graphql', () => {
    assert.equal(name('POST', '/graphql', json({ query: 'query Tickets { tickets { id } }' })), 'POST /graphql query Tickets');
    assert.equal(name('POST', '/graphql', json({ query: 'mutation CloseTicket($id: ID!) { close(id: $id) { id } }', variables: { id: 1 } })), 'POST /graphql mutation CloseTicket');
    assert.equal(name('POST', '/graphql', json({ query: '{ tickets { id } }' })), 'POST /graphql query anonymous', 'shorthand is an anonymous query');
    assert.equal(name('POST', '/graphql', json({ query: 'subscription { changed { id } }' })), 'POST /graphql subscription anonymous');
    const two = 'query A { a } mutation B { b } fragment F on T { x }';
    assert.equal(name('POST', '/graphql', json({ query: two, operationName: 'B' })), 'POST /graphql mutation B', 'operationName selects');
    assert.equal(name('POST', '/graphql', json({ query: '# mutation X\nquery Y { f(arg: "mutation Z {") }' })), 'POST /graphql query Y', 'comments and strings do not count');
    assert.equal(name('POST', '/graphql', json({ operationName: 'Tickets', extensions: { persistedQuery: { version: 1, sha256Hash: 'ab' } } })), 'POST /graphql unknown Tickets');
    assert.equal(name('POST', '/graphql', json({ documentId: 'abc' })), 'POST /graphql unknown anonymous');
    assert.equal(name('POST', '/graphql', json([{ query: 'query First { a }' }, { query: 'mutation Second { b }' }])), 'POST /graphql mutation First', 'a batch: first name, most writing type');
    assert.equal(name('POST', '/graphql', { postData: 'mutation Close { c }', contentType: 'application/graphql' }), 'POST /graphql mutation Close');
    assert.equal(graphqlOf(JSON.stringify({ search: 'x' }), 'application/json'), null, 'JSON without query is no GraphQL');
    assert.equal(graphqlOf(null), null);
    assert.deepEqual(graphqlOperations('fragment F on T { x } query Q { y }'), [{ type: 'query', name: 'Q' }]);
});

test('names and GraphQL from structured fields: a value with spaces stays one token, a JSON body with other fields is no GraphQL', () => {
    const smuggled = name('POST', '/c?action=x%20query%20y', {}, ['action']);
    assert.equal(smuggled, 'POST /c action=x%20query%20y', 'whitespace in a key value is percent-encoded');
    assert.equal(classifyRequest(smuggled), 'write', 'so it cannot pose as a GraphQL query');
    assert.equal(classifyRequest(name('POST', '/rpc', json({ method: 'a query b' }), ['json.method'])), 'write');
    assert.equal(name('POST', '/rpc', json({ method: 'a\tquery b' }), ['json.method']), 'POST /rpc json.method=a%09query%20b');
    const mixed = name('POST', '/api/orders', json({ query: '{ a }', action: 'delete' }));
    assert.equal(mixed, 'POST /api/orders', 'a "query" field among others is no GraphQL request');
    assert.equal(classifyRequest(mixed), 'write');
    assert.equal(name('POST', '/graphql', json({ query: '{ a }', variables: {}, operationName: null, extensions: {} })), 'POST /graphql query anonymous', 'the GraphQL fields');
    assert.equal(name('POST', '/graphql', json({ operationName: 'x query y', extensions: { persistedQuery: {} } })), 'POST /graphql unknown x%20query%20y');
});

test('parseRequestName: request names and learned effect lines with a trailing status', () => {
    assert.deepEqual(parseRequestName('POST /graphql mutation CloseTicket 200'), { method: 'POST', path: '/graphql', keys: [], graphql: { type: 'mutation', name: 'CloseTicket' } });
    assert.deepEqual(parseRequestName('post /c action=save 201'), { method: 'POST', path: '/c', keys: ['action=save'], graphql: null });
});

test('reads patterns: tokens, globs, fewer tokens match, a path-only pattern never matches GraphQL', () => {
    const matches = (pattern, request) => compileRead(pattern)(request);
    assert.ok(matches('POST /api/search', 'POST /api/search'));
    assert.ok(matches('post /api/search', 'POST /api/search'), 'method is case-insensitive');
    assert.ok(!matches('POST /api/search', 'PUT /api/search'));
    assert.ok(matches('* /api/search', 'PUT /api/search'));
    assert.ok(matches('POST /api/*/query', 'POST /api/tickets/query'));
    assert.ok(!matches('POST /api/*/query', 'POST /api/a/b/query'), '* stays within a segment');
    assert.ok(matches('* /api/telemetry/**', 'POST /api/telemetry/a/b'));
    assert.ok(matches('POST /api/proxy op=load*', 'POST /api/proxy op=loadAll'));
    assert.ok(!matches('POST /api/proxy op=load*', 'POST /api/proxy op=save'));
    assert.ok(matches('POST /api/proxy', 'POST /api/proxy op=save'), 'fewer tokens than the request');
    assert.ok(!matches('POST /graphql', 'POST /graphql mutation CloseTicket'), 'POST /graphql does not make mutations reads');
    assert.ok(matches('POST /graphql mutation TrackView', 'POST /graphql mutation TrackView'));
    assert.ok(matches('POST /graphql mutation Track*', 'POST /graphql mutation TrackView 200'), 'on an effect line too');
    for (const invalid of ['', 'POST', 'POST api/search', '/api/search', 42, 'P0ST /x']) assert.equal(compileRead(invalid), null, String(invalid));
});

test('classification: GET reads, sign-in ignored (no language words), GraphQL query reads, reads patterns, everything else writes', () => {
    const reads = compileReads(['POST /api/search', 'POST /graphql mutation TrackView']);
    const table = [
        ['GET /api/tickets', 'read'], ['HEAD /x', 'read'], ['OPTIONS /x', 'read'],
        ['POST /api/login', 'ignored'], ['POST /oauth/token', 'ignored'], ['DELETE /api/sessions', 'ignored'], ['POST /auth', 'ignored'], ['POST /sign-out', 'ignored'],
        ['POST /portal/anmelden', 'write'], ['POST /api/authors', 'write'],
        ['POST /graphql query Tickets', 'read'], ['POST /graphql mutation CloseTicket', 'write'], ['POST /graphql subscription Changed', 'write'],
        ['POST /graphql unknown Tickets', 'write'], ['POST /graphql mutation TrackView', 'read'],
        ['POST /api/search', 'read'], ['POST /api/tickets', 'write'], ['GET /c action=save', 'read'],
    ];
    for (const [request, expected] of table) assert.equal(classifyRequest(request, reads), expected, request);
});

test('config: reads is a top-level list of valid patterns; per environment it is refused with the reason', () => {
    const base = { environments: { local: { url: 'http://localhost:3000' } } };
    const issues = (config) => validateConfig({ ...base, ...config }).issues;
    assert.deepEqual(issues({ reads: ['POST /api/search', '* /api/telemetry/**'] }), []);
    assert.equal(issues({ reads: 'POST /api/search' }).length, 1);
    assert.match(issues({ reads: ['POST /api/search', 'search'] }).join('\n'), /"search"/);
    assert.match(issues({ environments: { local: { url: 'http://localhost:3000', reads: ['POST /x'] } } }).join('\n'), /reads/);
    assert.deepEqual(issues({ requestKeys: ['action', 'json.method'] }), []);
    assert.equal(issues({ requestKeys: ['json.'] }).length, 1);
});
