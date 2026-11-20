// Locators as code: a recording stores one Playwright locator per target, written the way Playwright's Locator.toString() prints
// it, without `page.`, frames included:
//   getByRole('button', { name: 'Save', exact: true })
//   getByRole('listitem').filter({ hasText: 'Feed the raven' }).getByRole('button', { name: 'Complete' })
//   locator('iframe[title="Payment"]').contentFrame().getByRole('textbox', { name: 'Amount' })
//   locator('extjs=button[text="Abbrechen"]')
// The code is never evaluated: a small tokenizer and parser accept only the methods and options below and build the locator
// through the public Playwright API.
//
// AST: a chain is an array of calls { method, args }. An argument is a string, a RegExp, a number, a boolean, an options object
// (plain object) or a nested locator { chain }. parseLocator returns the canonical form, the one toString() prints: options in
// Playwright's order, multi-key filters split, nth(0) as first(), and so on. printLocator(parseLocator(code)) === code for every
// string Locator.toString() produces.

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';

const TEXT = ['string', 'regex'];
const ROLE_OPTIONS = {
    name: TEXT, description: TEXT, exact: ['bool'], checked: ['bool'], disabled: ['bool'], selected: ['bool'], expanded: ['bool'],
    includeHidden: ['bool'], level: ['number'], pressed: ['bool'],
};
const EXACT_OPTIONS = { exact: ['bool'] };
const LOCATOR_OPTIONS = { hasText: TEXT, hasNotText: TEXT, has: ['chain'], hasNot: ['chain'] };
const FILTER_OPTIONS = { ...LOCATOR_OPTIONS, visible: ['bool'] };

// Per method: the allowed argument kinds per position (`options` names an option set); `scope` methods find elements and may
// follow contentFrame().
const METHODS = {
    locator: { scope: true, args: [['string', 'chain'], LOCATOR_OPTIONS], required: 1 },
    getByRole: { scope: true, args: [['string'], ROLE_OPTIONS], required: 1 },
    getByText: { scope: true, args: [TEXT, EXACT_OPTIONS], required: 1 },
    getByLabel: { scope: true, args: [TEXT, EXACT_OPTIONS], required: 1 },
    getByPlaceholder: { scope: true, args: [TEXT, EXACT_OPTIONS], required: 1 },
    getByAltText: { scope: true, args: [TEXT, EXACT_OPTIONS], required: 1 },
    getByTitle: { scope: true, args: [TEXT, EXACT_OPTIONS], required: 1 },
    getByTestId: { scope: true, args: [TEXT], required: 1 },
    frameLocator: { scope: true, args: [['string']], required: 1 },
    filter: { args: [FILTER_OPTIONS], required: 0 },
    and: { args: [['chain']], required: 1 },
    or: { args: [['chain']], required: 1 },
    nth: { args: [['number']], required: 1 },
    first: { args: [], required: 0 },
    last: { args: [], required: 0 },
    visible: { args: [], required: 0 },
    contentFrame: { args: [], required: 0 },
};
const ROLE_ORDER = ['checked', 'disabled', 'selected', 'expanded', 'includeHidden', 'level', 'pressed'];
const FILTER_ORDER = ['hasText', 'hasNotText', 'has', 'hasNot', 'visible'];
const POSITION = new Set(['nth', 'first', 'last']);

/** A locator that can't be parsed or used; `reason` is 'syntax' or a reject reason (see rejectReason). */
const invalid = (code, problem, reason = 'syntax') => {
    const error = new CawError('target-invalid', t('config.locator.invalid', { code, problem }));
    error.reason = reason;
    return error;
};

const isRegExp = (value) => value instanceof RegExp;
const isChain = (value) => typeof value === 'object' && value !== null && Array.isArray(value.chain);
const isOptions = (value) => typeof value === 'object' && value !== null && !isRegExp(value) && !isChain(value) && !Array.isArray(value);
const kindOf = (value) => {
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'bool';
    if (isRegExp(value)) return 'regex';
    if (isChain(value)) return 'chain';
    return 'options';
};

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

const tokenize = (code) => {
    const tokens = [];
    let at = 0;
    const fail = (problem) => { throw invalid(code, problem); };
    while (at < code.length) {
        const char = code[at];
        if (/\s/.test(char)) { at += 1; continue; }
        if ('.(){},:'.includes(char)) { tokens.push({ type: char, at }); at += 1; continue; }
        if (char === "'" || char === '"' || char === '`') {
            const start = at;
            let value = '';
            at += 1;
            for (;;) {
                if (at >= code.length) fail(t('config.locator.problem.unterminated', { at: start }));
                const next = code[at];
                if (next === char) { at += 1; break; }
                if (char === '`' && next === '$' && code[at + 1] === '{') fail(t('config.locator.problem.template'));
                if (next !== '\\') { value += next; at += 1; continue; }
                const escaped = code[at + 1];
                let hex = null;
                if (escaped === 'u' && code[at + 2] === '{') {
                    const end = code.indexOf('}', at + 3);
                    hex = end < 0 ? '' : code.slice(at + 3, end);
                    at = end + 1;
                } else if (escaped === 'u' || escaped === 'x') {
                    const length = escaped === 'u' ? 4 : 2;
                    hex = code.slice(at + 2, at + 2 + length);
                    if (hex.length !== length) hex = '';
                    at += 2 + length;
                } else {
                    value += SIMPLE_ESCAPES[escaped] ?? escaped ?? '';
                    at += 2;
                }
                if (hex !== null) {
                    if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) fail(t('config.locator.problem.escape', { at: start }));
                    value += String.fromCodePoint(parseInt(hex, 16));
                }
            }
            tokens.push({ type: 'string', value, at: start });
            continue;
        }
        // A regular expression can only stand where a value is expected: after ( , or :
        if (char === '/' && ['(', ',', ':'].includes(tokens.at(-1)?.type)) {
            const start = at;
            let body = '';
            let inClass = false;
            at += 1;
            for (;;) {
                if (at >= code.length || code[at] === '\n') fail(t('config.locator.problem.unterminated', { at: start }));
                const next = code[at];
                if (next === '\\') { body += next + (code[at + 1] ?? ''); at += 2; continue; }
                if (next === '[') inClass = true;
                else if (next === ']') inClass = false;
                else if (next === '/' && !inClass) { at += 1; break; }
                body += next;
                at += 1;
            }
            const flags = /^[dgimsuyv]*/.exec(code.slice(at))[0];
            at += flags.length;
            let value;
            try {
                value = new RegExp(body, flags);
            } catch {
                fail(t('config.locator.problem.regex', { regex: code.slice(start, at) }));
            }
            tokens.push({ type: 'regex', value, at: start });
            continue;
        }
        const number = /^-?\d+/.exec(code.slice(at));
        if (number) { tokens.push({ type: 'number', value: Number(number[0]), at }); at += number[0].length; continue; }
        const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(at));
        if (word) {
            const value = word[0];
            tokens.push(value === 'true' || value === 'false' ? { type: 'bool', value: value === 'true', at } : { type: 'ident', value, at });
            at += value.length;
            continue;
        }
        fail(t('config.locator.problem.unexpected', { token: char, at }));
    }
    return tokens;
};

/** Canonical form of one call, as a list of calls (a call can become several, e.g. a filter with two options). */
const canonicalCall = ({ method, args }) => {
    const nested = (value) => (isChain(value) ? { chain: canonical(value.chain) } : value);
    const filters = (options = {}) => {
        const calls = [];
        for (const key of FILTER_ORDER) {
            if (options[key] === undefined) continue;
            if (key === 'visible') calls.push(options.visible ? { method: 'visible', args: [] } : { method: 'filter', args: [{ visible: false }] });
            else calls.push({ method: 'filter', args: [{ [key]: nested(options[key]) }] });
        }
        return calls;
    };
    switch (method) {
        case 'frameLocator': return [{ method: 'locator', args: [args[0]] }, { method: 'contentFrame', args: [] }];
        case 'locator': return [{ method, args: [nested(args[0])] }, ...filters(args[1])];
        case 'filter': return filters(args[0]);
        case 'and':
        case 'or': return [{ method, args: [nested(args[0])] }];
        case 'nth':
            if (args[0] === 0) return [{ method: 'first', args: [] }];
            if (args[0] === -1) return [{ method: 'last', args: [] }];
            return [{ method, args: [args[0]] }];
        case 'getByRole': {
            const options = args[1] ?? {};
            const out = {};
            if (options.name !== undefined) out.name = options.name;
            if (options.description !== undefined) out.description = options.description;
            if (options.exact === true && (typeof options.name === 'string' || typeof options.description === 'string')) out.exact = true;
            for (const key of ROLE_ORDER) if (options[key] !== undefined) out[key] = options[key];
            return [{ method, args: Object.keys(out).length === 0 ? [args[0]] : [args[0], out] }];
        }
        case 'getByText':
        case 'getByLabel':
        case 'getByPlaceholder':
        case 'getByAltText':
        case 'getByTitle':
            return [{ method, args: typeof args[0] === 'string' && args[1]?.exact === true ? [args[0], { exact: true }] : [args[0]] }];
        default: return [{ method, args: [...args] }];
    }
};

const canonical = (chain) => chain.flatMap(canonicalCall);

/**
 * Parses locator code (Playwright's JavaScript notation, without `page.`) into the canonical AST. Throws CawError
 * 'target-invalid' (with `reason` 'syntax' or 'describe') for anything outside the allow-list.
 */
export const parseLocator = (code) => {
    if (typeof code !== 'string' || code.trim() === '') throw invalid(String(code ?? ''), t('config.locator.problem.empty'));
    const tokens = tokenize(code);
    let index = 0;
    const peek = () => tokens[index];
    const describe = (token) => (token === undefined ? t('config.locator.problem.end') : (token.value ?? token.type));
    const unexpected = (token) => invalid(code, t('config.locator.problem.unexpected', { token: describe(token), at: token?.at ?? code.length }));
    const take = (type) => {
        const token = tokens[index];
        if (token?.type !== type) throw unexpected(token);
        index += 1;
        return token;
    };
    const comma = (closing) => {
        if (peek()?.type === ',') take(',');
        else if (peek()?.type !== closing) throw unexpected(peek());
    };
    const object = (method, allowed) => {
        take('{');
        const result = {};
        while (peek()?.type !== '}') {
            const key = take('ident');
            if (!Object.hasOwn(allowed, key.value) || Object.hasOwn(result, key.value)) {
                throw invalid(code, t('config.locator.problem.option', { method, option: key.value, allowed: Object.keys(allowed).join(', ') }));
            }
            take(':');
            const inner = value(method);
            if (!allowed[key.value].includes(kindOf(inner))) throw invalid(code, t('config.locator.problem.argument', { method }));
            result[key.value] = inner;
            comma('}');
        }
        take('}');
        return result;
    };
    const value = (method, allowed) => {
        const token = peek();
        if (['string', 'regex', 'number', 'bool'].includes(token?.type)) { index += 1; return token.value; }
        if (token?.type === '{' && allowed !== undefined) return object(method, allowed);
        if (token?.type === 'ident') return { chain: chain() };
        throw unexpected(token);
    };
    const call = () => {
        const name = take('ident');
        const method = name.value;
        if (method === 'describe') throw invalid(code, t('config.locator.problem.describe'), 'describe');
        const spec = Object.hasOwn(METHODS, method) ? METHODS[method] : null;
        if (spec === null) throw invalid(code, t('config.locator.problem.method', { method, allowed: Object.keys(METHODS).join(', ') }));
        take('(');
        const args = [];
        while (peek()?.type !== ')') {
            const expected = spec.args[args.length];
            if (expected === undefined) throw invalid(code, t('config.locator.problem.argument', { method }));
            const options = Array.isArray(expected) ? undefined : expected;
            const argument = value(method, options);
            if (!(options === undefined ? expected.includes(kindOf(argument)) : kindOf(argument) === 'options')) {
                throw invalid(code, t('config.locator.problem.argument', { method }));
            }
            if (method === 'nth' && !Number.isSafeInteger(argument)) throw invalid(code, t('config.locator.problem.argument', { method }));
            args.push(argument);
            comma(')');
        }
        take(')');
        if (args.length < spec.required) throw invalid(code, t('config.locator.problem.argument', { method }));
        return { method, args, at: name.at };
    };
    const chain = () => {
        const calls = [call()];
        while (peek()?.type === '.') { take('.'); calls.push(call()); }
        // Order: the chain starts at an element-finding method, and after contentFrame() only those may follow.
        calls.forEach(({ method, at }, position) => {
            const after = position === 0 ? 'contentFrame' : calls[position - 1].method;
            if ((after === 'contentFrame' || after === 'frameLocator') && !METHODS[method].scope) {
                throw invalid(code, t('config.locator.problem.order', { method, at }));
            }
        });
        if (['contentFrame', 'frameLocator'].includes(calls.at(-1).method)) throw invalid(code, t('config.locator.problem.frameEnd'));
        for (const entry of calls) delete entry.at;
        return calls;
    };
    const result = chain();
    if (index !== tokens.length) throw invalid(code, t('config.locator.problem.trailing', { at: tokens[index].at }));
    return canonical(result);
};

const escapeWithQuotes = (text) => {
    const json = JSON.stringify(text);
    return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
};
const regexSource = (regex) => String(regex).replace(/(^|[^\\])(\\\\)*\\(['"`])/g, '$1$2$3');

const printValue = (value) => {
    if (typeof value === 'string') return escapeWithQuotes(value);
    if (isRegExp(value)) return regexSource(value);
    if (isChain(value)) return printChain(value.chain);
    if (isOptions(value)) {
        const entries = Object.entries(value).map(([key, inner]) => `${key}: ${printValue(inner)}`);
        return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
    }
    return String(value);
};

const printChain = (chain) => chain.map(({ method, args }) => `${method}(${args.map(printValue).join(', ')})`).join('.');

/** Code for the AST, exactly as Playwright's Locator.toString() prints the same locator. */
export const printLocator = (ast) => printChain(canonical(ast));

/** The Playwright locator for the AST on root (a Page or Frame). Nested locators (has, and, or) start at root as well. */
export const buildLocator = (root, ast) => {
    const resolve = (argument) => {
        if (isChain(argument)) return buildLocator(root, argument.chain);
        if (isOptions(argument)) return Object.fromEntries(Object.entries(argument).map(([key, inner]) => [key, resolve(inner)]));
        return argument;
    };
    let current = root;
    for (const { method, args } of ast) {
        if (!Object.hasOwn(METHODS, method)) throw invalid(printChain(ast), t('config.locator.problem.method', { method, allowed: Object.keys(METHODS).join(', ') }));
        if (typeof current?.[method] !== 'function') throw invalid(printChain(ast), t('config.locator.problem.unavailable', { method }));
        current = current[method](...args.map(resolve));
    }
    return current;
};

/** Escapes text for use inside a regular expression. */
export const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * A new AST with fn applied to every string argument: fn(value, kind, escape) returns the new value. kind is 'string' (texts:
 * names, getByText, hasText, test ids), 'selector' (the selector of locator()) or 'regex' (value is the expression's source;
 * escape is escapeRegex, so whatever fn inserts must go through escape). For 'string' and 'selector' escape returns its input.
 * A placeholder filler thus writes `value.replace(/\{\{(\w+)\}\}/g, (_, name) => escape(lookup(name)))` and stays safe.
 */
export const mapStrings = (ast, fn) => {
    const same = (text) => String(text);
    const mapValue = (value, kind) => {
        if (typeof value === 'string') return String(fn(value, kind, same));
        if (isRegExp(value)) {
            const source = String(fn(value.source, 'regex', escapeRegex));
            if (source === value.source) return new RegExp(value.source, value.flags);
            try {
                return new RegExp(source, value.flags);
            } catch {
                throw invalid(source, t('config.locator.problem.regex', { regex: `/${source}/${value.flags}` }));
            }
        }
        if (isChain(value)) return { chain: mapChain(value.chain) };
        if (isOptions(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapValue(inner, 'string')]));
        return value;
    };
    const mapChain = (chain) => chain.map(({ method, args }) => ({
        method,
        args: args.map((argument, position) => mapValue(argument, position === 0 && (method === 'locator' || method === 'frameLocator') ? 'selector' : 'string')),
    }));
    return mapChain(ast);
};

/** Every selector string in the AST (locator() arguments, nested ones included). */
const selectorsOf = (ast) => {
    const found = [];
    const visit = (value) => {
        if (isChain(value)) walk(value.chain);
        else if (isOptions(value)) Object.values(value).forEach(visit);
    };
    const walk = (chain) => {
        for (const { method, args } of chain) {
            if ((method === 'locator' || method === 'frameLocator') && typeof args[0] === 'string') found.push(args[0]);
            args.forEach(visit);
        }
    };
    walk(ast);
    return found;
};

/**
 * An id ExtJS generated: ext-…-N, ext-genN, <xtype>-<digits>(-part). Only ExtJS apps are checked: elsewhere an id like
 * step-2 is usually written by hand and stable.
 */
export const isGeneratedId = (id, framework = 'web') => framework === 'extjs' && (/^ext-.*\d/.test(id) || /^[A-Za-z][\w]*(?:-[A-Za-z][\w]*)*-\d+(?:-[\w-]*)?$/.test(id));

const generatedIdIn = (selector, framework) => {
    const unquoted = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const ids = [
        ...[...unquoted.matchAll(/#((?:[\w-]|\\.)+)/g)].map(([, id]) => id.replace(/\\(.)/g, '$1')),
        ...[...selector.matchAll(/\[\s*@?id\s*[~|^$*]?=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]\s]+))/g)].map(([, a, b, c]) => a ?? b ?? c),
    ];
    return ids.find((id) => isGeneratedId(id, framework)) ?? null;
};

/**
 * Why a locator must not go into a recording, or null: 'syntax' (not parseable), 'describe' (.describe() hides the locator),
 * 'aria-ref' (snapshot reference, only valid for one snapshot), 'generated-id' (ExtJS only: #ext-…-N, #button-1023) or
 * 'nth-child' (position in the DOM).
 * @param framework the app's framework from the config; generated ids are only recognized for 'extjs'
 */
export const rejectReason = (code, { framework = 'web' } = {}) => {
    let ast;
    try {
        ast = parseLocator(code);
    } catch (error) {
        return error.reason ?? 'syntax';
    }
    const selectors = selectorsOf(ast);
    if (selectors.some((selector) => /(^|>>\s*)aria-ref\s*=/.test(selector))) return 'aria-ref';
    if (selectors.some((selector) => generatedIdIn(selector, framework) !== null)) return 'generated-id';
    if (selectors.some((selector) => /:nth-(last-)?(child|of-type)\s*\(/.test(selector))) return 'nth-child';
    return null;
};

/** Parses and checks a locator for a recording: the AST, or CawError 'target-invalid' that says what is wrong. */
export const checkLocator = (code, { framework = 'web' } = {}) => {
    const ast = parseLocator(code);
    const reason = rejectReason(code, { framework });
    if (reason === null) return ast;
    const id = selectorsOf(ast).map((selector) => generatedIdIn(selector, framework)).find((found) => found !== null);
    throw invalid(code, t(`config.locator.reject.${reason}`, { id }), reason);
};

// Calls that only narrow what the element's own call found (explainLocator in framework/index.mjs skips the same).
const NARROWING = new Set(['filter', 'nth', 'first', 'last', 'visible']);

/**
 * The locator with its element's name swapped, everything else as it was: `getByRole('button', { name: 'Speichern', exact:
 * true })` becomes `{ name: 'Sichern', exact: true }`. Only the element's own getByRole (the last call before narrowing ones)
 * and only a plain string name: one with a placeholder (`{{runTag}}`) or a regex is no rename caw can prove.
 * @returns { code, from } with the new code, checked as a recording locator, and the old name; or null
 */
export const renamedLocator = (code, to, { framework = 'web' } = {}) => {
    if (typeof to !== 'string' || to.trim() === '') return null;
    let ast;
    try {
        ast = parseLocator(code);
    } catch {
        return null;
    }
    const at = ast.findLastIndex(({ method }) => !NARROWING.has(method));
    const own = ast[at];
    const from = isOptions(own?.args[1]) ? own.args[1].name : undefined;
    if (own?.method !== 'getByRole' || typeof from !== 'string' || from.includes('{{') || from === to) return null;
    const renamed = printLocator([...ast.slice(0, at), { method: 'getByRole', args: [own.args[0], { ...own.args[1], name: to }] }, ...ast.slice(at + 1)]);
    try {
        checkLocator(renamed, { framework });
    } catch {
        return null;
    }
    return { code: renamed, from };
};

const astOf = (code) => (typeof code === 'string' ? parseLocator(code) : canonical(code));

/** The frame part of the chain: everything up to and including the last contentFrame(); [] in the main frame. */
export const chainPrefix = (ast) => {
    const chain = astOf(ast);
    const last = chain.findLastIndex(({ method }) => method === 'contentFrame');
    return chain.slice(0, last + 1);
};

/** Splits a chain into segments: one element-finding call with the calls that narrow it (filter, nth, …). */
const segmentsOf = (chain) => {
    const segments = [];
    for (const call of chain) {
        if (METHODS[call.method]?.scope || segments.length === 0) segments.push({ find: call, then: [] });
        else segments.at(-1).then.push(call);
    }
    return segments;
};

const TAG = /^[A-Za-z][\w-]*$/;
// A tag with at most one class: how extjs-query.mjs picks the element inside a component.
const PART = /^[A-Za-z][\w-]*(?:\.[\w-]+)?$/;

/**
 * The element inside an ExtJS component, e.g. locator('extjs=textfield[label="Bereich*"]').locator('input'): the recording names
 * the component, the tag only picks its one element of that kind (extjs-query.mjs). Such a chain is named like the component.
 */
const componentPart = (segments) => {
    const [component, part] = segments.slice(-2);
    return part !== undefined && part.then.length === 0 && part.find.method === 'locator' && typeof part.find.args[0] === 'string'
        && PART.test(part.find.args[0].trim()) && component.find.method === 'locator' && typeof component.find.args[0] === 'string'
        && component.find.args[0].trim().startsWith('extjs=');
};

/**
 * Positional: picks among several by position (nth, first, last anywhere in the chain) or finds the element by its bare tag
 * name, e.g. locator('div') with nothing narrowing it.
 */
export const isPositional = (ast) => {
    const chain = astOf(ast);
    if (chain.some(({ method }) => POSITION.has(method))) return true;
    if (componentPart(segmentsOf(chain))) return false;
    const last = segmentsOf(chain).at(-1);
    return last !== undefined && last.find.method === 'locator' && typeof last.find.args[0] === 'string' && TAG.test(last.find.args[0].trim())
        && !last.then.some(({ method }) => method === 'filter' || method === 'and' || method === 'visible');
};

const shown = (value) => (isRegExp(value) ? String(value) : value);

// ExtJS ComponentQuery: split at combinators outside brackets and quotes; label the last part, scope the one before.
const extjsParts = (query) => {
    const parts = [];
    let current = '';
    let depth = 0;
    let quote = null;
    for (let at = 0; at < query.length; at += 1) {
        const char = query[at];
        if (quote !== null) {
            current += char;
            if (char === '\\') { current += query[at + 1] ?? ''; at += 1; } else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '[' || char === '(') depth += 1;
        else if (char === ']' || char === ')') depth -= 1;
        if (depth === 0 && (/\s/.test(char) || char === '>')) {
            if (current !== '') parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current !== '') parts.push(current);
    return parts;
};

const EXTJS_TEXT = /\[\s*@?(text|fieldLabel|boxLabel|label|title|tooltip|emptyText|name)\s*[~^$*]?=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]]*?))\s*\]/;

const extjsLabel = (part) => {
    const xtype = /^[A-Za-z_][\w.-]*/.exec(part)?.[0] ?? 'Element';
    const text = EXTJS_TEXT.exec(part);
    if (text !== null) return `${xtype} "${(text[2] ?? text[3] ?? text[4]).replace(/\\(.)/g, '$1')}"`;
    const id = /#([\w-]+)/.exec(part) ?? /\[\s*(?:itemId|reference)\s*=\s*["']?([\w-]+)/.exec(part);
    return id === null ? xtype : `${xtype} "#${id[1]}"`;
};

const CSS_TEXT = /^([A-Za-z][\w-]*)?\[\s*(title|name|aria-label|alt|placeholder)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\]$/;

const LABEL_KIND = { getByText: 'text', getByLabel: 'field', getByPlaceholder: 'field', getByAltText: 'image', getByTitle: 'Element' };

/** Label of one segment: kind plus shown text, with the position when it picks by position. */
const segmentLabel = ({ find, then }) => {
    const { method, args } = find;
    let kind = 'Element';
    let text;
    let scope = null;
    if (method === 'getByRole') {
        kind = args[0];
        text = args[1]?.name ?? args[1]?.description;
    } else if (method === 'getByTestId') {
        text = isRegExp(args[0]) ? String(args[0]) : `#${args[0]}`;
    } else if (Object.hasOwn(LABEL_KIND, method)) {
        kind = LABEL_KIND[method];
        text = args[0];
    } else if (method === 'locator' && isChain(args[0])) {
        return { ...labelOf(args[0].chain), scope: null };
    } else if (method === 'locator') {
        const selector = args[0].trim();
        if (selector.startsWith('extjs=')) {
            const parts = extjsParts(selector.slice('extjs='.length).trim());
            kind = extjsLabel(parts.at(-1) ?? '');
            if (parts.length > 1) scope = extjsLabel(parts.at(-2));
        } else if (TAG.test(selector)) {
            kind = selector;
        } else {
            const attribute = CSS_TEXT.exec(selector);
            if (attribute === null) kind = selector;
            else [kind, text] = [attribute[1] ?? 'Element', (attribute[3] ?? attribute[4]).replace(/\\(.)/g, '$1')];
        }
    }
    for (const { method: narrow, args: narrowArgs } of then) {
        if (narrow === 'filter' && text === undefined && narrowArgs[0]?.hasText !== undefined) text = narrowArgs[0].hasText;
    }
    const positions = then.filter(({ method: narrow }) => POSITION.has(narrow)).map(({ method: narrow, args: narrowArgs }) => {
        if (narrow === 'first') return ' [1]';
        if (narrow === 'last') return ' [last]';
        return narrowArgs[0] < 0 ? ` [last${narrowArgs[0] + 1}]` : ` [${narrowArgs[0] + 1}]`;
    });
    const label = `${kind}${text === undefined ? '' : ` "${shown(text)}"`}${positions.join('')}`;
    return { label, scope, ...(text === undefined ? {} : { text: shown(text) }) };
};

const labelOf = (chain) => {
    const all = segmentsOf(chain);
    const segments = componentPart(all) ? all.slice(0, -1) : all;
    const { label, scope, text } = segmentLabel(segments.at(-1));
    const own = text === undefined ? {} : { text };
    if (scope !== null) return { label: `${label} in ${scope}`, ...own };
    if (segments.length < 2) return { label, ...own };
    return { label: `${label} in ${segmentLabel(segments.at(-2)).label}`, ...own };
};

/**
 * Short form for messages: the element and the nearest scope around it, e.g. button "Save" in dialog "New todo",
 * app_abortButton "Abbrechen", button "Edit" [2]. Unparseable code is shown as it is.
 */
export const locatorLabel = (code) => {
    let chain;
    try {
        chain = astOf(code);
    } catch {
        return String(code);
    }
    return labelOf(chain).label;
};

/** The text that names the element (its name, label or text, a regex as /…/), or undefined if the locator names none. */
export const locatorText = (code) => {
    try {
        return labelOf(astOf(code)).text;
    } catch {
        return undefined;
    }
};
