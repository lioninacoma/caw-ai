// Requests as caw names and classifies them, one rule for the report's write requests, promotion at adoption, the stop of
// `open <test>@S<n>`, the production write block and the assessment. A request name is
//   <METHOD> <neutral path>[ <key>=<value>]…[ <graphql-type> <OperationName>]
// and a request is a read, a write or ignored (caw's sign-in machinery).

const GRAPHQL_TYPES = ['query', 'mutation', 'subscription'];
// How much a GraphQL type writes, for naming a batch by its most writing operation.
const WRITE_RANK = { query: 0, unknown: 1, subscription: 2, mutation: 3 };

/** The operations of a GraphQL document: type and name of each, in order; fragments left out. No dependency, no validation. */
export const graphqlOperations = (text) => {
    const source = String(text).replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/g, ' ');
    const operations = [];
    let depth = 0;
    let parens = 0;
    let pending = null;
    for (const [token] of source.matchAll(/[{}()]|[_A-Za-z][_0-9A-Za-z]*/g)) {
        if (token === '(') parens += 1;
        else if (token === ')') parens -= 1;
        else if (token === '{') {
            if (depth === 0 && parens === 0) {
                if (pending === null) operations.push({ type: 'query', name: null });
                else if (pending.type !== 'fragment') operations.push(pending);
                pending = null;
            }
            depth += 1;
        } else if (token === '}') depth -= 1;
        else if (depth === 0 && parens === 0) {
            if (pending === null && [...GRAPHQL_TYPES, 'fragment'].includes(token)) pending = { type: token, name: null };
            else if (pending !== null && pending.name === null) pending.name = token;
        }
    }
    return operations;
};

/** One GraphQL request object ({query, operationName} or a persisted query without text): type and name, or null. */
const operationOf = (entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const wanted = typeof entry.operationName === 'string' && entry.operationName !== '' ? entry.operationName : null;
    if (typeof entry.query !== 'string') {
        const persisted = (entry.extensions !== null && typeof entry.extensions === 'object' && entry.extensions.persistedQuery !== undefined)
            || typeof entry.documentId === 'string';
        return persisted ? { type: 'unknown', name: wanted ?? 'anonymous' } : null;
    }
    const operations = graphqlOperations(entry.query);
    const chosen = operations.find(({ name }) => wanted !== null && name === wanted) ?? operations[0];
    return chosen === undefined ? null : { type: chosen.type, name: chosen.name ?? wanted ?? 'anonymous' };
};

/**
 * The GraphQL operation of a request body, or null when it is no GraphQL request: a JSON object with a string `query` (or a
 * persisted query), a batch array of them (named by the first, typed by the most writing), or `application/graphql`.
 */
export const graphqlOf = (postData, contentType = '') => {
    if (typeof postData !== 'string' || postData === '') return null;
    if (/application\/graphql/i.test(contentType)) {
        const [first] = graphqlOperations(postData);
        return first === undefined ? null : { type: first.type, name: first.name ?? 'anonymous' };
    }
    let body;
    try {
        body = JSON.parse(postData);
    } catch {
        return null;
    }
    if (!Array.isArray(body)) return operationOf(body);
    const operations = body.map(operationOf);
    if (operations.length === 0 || operations.some((operation) => operation === null)) return null;
    const type = operations.reduce((most, { type: current }) => (WRITE_RANK[current] > WRITE_RANK[most] ? current : most), 'query');
    return { type, name: operations[0].name };
};

/** The top-level JSON body fields named by `json.<key>` request keys, as `json.<key>=<value>` parts. */
export const jsonKeyParts = (postData, keys) => {
    const wanted = keys.filter((key) => /^json\./i.test(key)).map((key) => key.slice('json.'.length));
    if (wanted.length === 0 || typeof postData !== 'string') return [];
    let body;
    try {
        body = JSON.parse(postData);
    } catch {
        return [];
    }
    const shape = Array.isArray(body) ? body[0] : body;
    if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) return [];
    return wanted.filter((key) => ['string', 'number', 'boolean'].includes(typeof shape[key])).map((key) => `json.${key}=${String(shape[key]).slice(0, 120)}`);
};

/** Splits a request name (or a learned effect line `<name> <status>`) into method, path, key parts and the GraphQL suffix. */
export const parseRequestName = (name) => {
    const tokens = String(name).trim().split(/\s+/);
    const [method = '', path = ''] = tokens;
    let rest = tokens.slice(2);
    // An effect line ends with the status (a number or an outcome word); key parts have "=", a GraphQL suffix a type.
    const graphqlAt = rest.findIndex((token, index) => [...GRAPHQL_TYPES, 'unknown'].includes(token) && rest[index + 1] !== undefined && !rest[index + 1].includes('='));
    const graphql = graphqlAt < 0 ? null : { type: rest[graphqlAt], name: rest[graphqlAt + 1] };
    if (graphqlAt >= 0) rest = rest.slice(0, graphqlAt);
    return { method: method.toUpperCase(), path, keys: rest.filter((token) => token.includes('=')), graphql };
};

/**
 * Sign-in and sign-out, sessions and tokens write no business data: a "wrong password" test stays read-only. Words of one
 * language do not belong here; a project adds them as `reads` patterns.
 */
export const SIGN_IN_PATH = /(^|[/_.-])(log-?in|log-?out|sign-?in|sign-?out|sessions?|tokens?|refresh|auth|authenticate|csrf)$/i;

const globPart = (text, segment) => new RegExp(`^${text.split(/(\*\*|\*)/).map((part) => {
    if (part === '**') return '.*';
    if (part === '*') return segment ? '[^/]*' : '.*';
    return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}).join('')}$`, 'i');

/**
 * A `reads` pattern as a matcher on request names, or null when the text is no pattern. Tokens are matched one by one: the
 * method (case-insensitive, `*` any), the path (`*` within a segment, `**` anything), then key and GraphQL tokens (`*` any
 * characters). A pattern may have fewer tokens than the request; one that ends in its path never matches a GraphQL request.
 */
export const compileRead = (pattern) => {
    if (typeof pattern !== 'string') return null;
    const tokens = pattern.trim().split(/\s+/);
    if (tokens.length < 2 || !/^(\*|[A-Za-z]+)$/.test(tokens[0]) || !tokens[1].startsWith('/')) return null;
    const [method, path, ...more] = tokens;
    const pathPattern = globPart(path, true);
    const morePatterns = more.map((token) => globPart(token, false));
    return (name) => {
        const request = parseRequestName(name);
        if (method !== '*' && method.toUpperCase() !== request.method) return false;
        if (!pathPattern.test(request.path)) return false;
        const requestTokens = [...request.keys, ...(request.graphql === null ? [] : [request.graphql.type, request.graphql.name])];
        if (more.length === 0) return request.graphql === null;
        return morePatterns.every((part, index) => requestTokens[index] !== undefined && part.test(requestTokens[index]));
    };
};

/** The matchers of the config's `reads` list; invalid entries are left out (validate names them). */
export const compileReads = (patterns = []) => (Array.isArray(patterns) ? patterns.map(compileRead).filter((matcher) => matcher !== null) : []);

/**
 * read, write or ignored: GET/HEAD/OPTIONS read; caw's sign-in machinery ignored; a GraphQL query read; a `reads` pattern
 * read (also for a GraphQL mutation named in the pattern, e.g. "POST /graphql mutation TrackView"); anything else a write.
 * @param name  the request name (or a learned effect line)
 * @param reads matchers from compileReads
 */
export const classifyRequest = (name, reads = []) => {
    const request = parseRequestName(name);
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return 'read';
    if (SIGN_IN_PATH.test(request.path.replace(/\/+$/, ''))) return 'ignored';
    if (request.graphql?.type === 'query') return 'read';
    return reads.some((matches) => matches(name)) ? 'read' : 'write';
};
