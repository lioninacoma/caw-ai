// Proof for an answer from the session (caw_decide). The run folder is readable and writable by the session's own file tools,
// so an answer file alone proves nothing: the session could write one and skip the person's consent. An answer counts only
// with an HMAC whose key no file holds: the shared secret of two X25519 key pairs, the run's and the session's MCP server's,
// whose private halves live only in those two processes' memory. The run publishes its public key in decision.json, the MCP
// server its own in its listener file (attach.mjs) or, for a run it starts itself, through the run's stdin.

import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, timingSafeEqual } from 'node:crypto';

/** Set by the MCP server on a run it starts: the run reads the server's public key as the first line of its stdin. */
export const KEY_ENV = 'CAW_ANSWER_KEY';
const KEY_FROM_STDIN = 'stdin';
const KEY_PATTERN = /^[A-Za-z0-9+/=]{40,200}$/;

/** A new key pair: the public half as base64 (SPKI DER), the private half as a KeyObject that never leaves the process. */
export const newKeyPair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
};

/** A public key from its base64 form; undefined when it is none. */
const publicKeyOf = (text) => {
    if (typeof text !== 'string' || !KEY_PATTERN.test(text)) return undefined;
    try {
        const key = createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
        return key.asymmetricKeyType === 'x25519' ? key : undefined;
    } catch {
        return undefined;
    }
};

/** Whether `text` is a public key caw can use. */
export const isPublicKey = (text) => publicKeyOf(text) !== undefined;

/** A short name for a public key, to say which one a run trusts. */
export const fingerprint = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

/** What the proof covers: the run (its key), the decision (seq, id) and the whole answer. */
const signed = (runKey, { seq, id, option, message, picked, by }) => JSON.stringify([runKey, seq, id, option, message ?? null, picked ?? null, by]);

const macOf = (privateKey, peer, runKey, answer) => {
    const other = publicKeyOf(peer);
    if (other === undefined) return undefined;
    const secret = diffieHellman({ privateKey, publicKey: other });
    return createHmac('sha256', secret).update(signed(runKey, answer)).digest();
};

/**
 * The MCP server's side: the answer with its proof for the run whose public key is `runKey`.
 * @param keys the server's key pair (newKeyPair)
 */
export const signAnswer = (keys, runKey, answer) => {
    const mac = macOf(keys.privateKey, runKey, runKey, answer);
    if (mac === undefined) throw new Error('The run has no usable key.');
    return { ...answer, from: keys.publicKey, proof: mac.toString('hex') };
};

/**
 * The run's side: is the proof right, made by one of the keys it trusts?
 * @param keys    the run's key pair
 * @param trusted public keys (base64) whose answers count
 */
export const verifyAnswer = (keys, trusted, answer) => {
    if (typeof answer?.from !== 'string' || typeof answer.proof !== 'string' || !/^[0-9a-f]{64}$/.test(answer.proof)) return false;
    if (!trusted.includes(answer.from)) return false;
    const mac = macOf(keys.privateKey, answer.from, keys.publicKey, answer);
    return mac !== undefined && timingSafeEqual(mac, Buffer.from(answer.proof, 'hex'));
};

/** The first line of a stream, or undefined at its end or after `timeoutMs`. */
const firstLine = (input, timeoutMs) => new Promise((resolve) => {
    let text = '';
    const done = (value) => {
        clearTimeout(timer);
        input.off('data', take);
        input.off('end', ended);
        input.off('error', ended);
        input.pause?.();
        input.destroy?.();
        resolve(value);
    };
    const take = (chunk) => {
        text += chunk;
        const end = text.indexOf('\n');
        if (end !== -1) done(text.slice(0, end).trim());
        else if (text.length > 1000) done(undefined);
    };
    const ended = () => done(undefined);
    const timer = setTimeout(ended, timeoutMs);
    input.setEncoding?.('utf8');
    input.on('data', take);
    input.on('end', ended);
    input.on('error', ended);
});

let spawner;
/**
 * The public key of the MCP server that started this run (caw_start), read once from stdin when KEY_ENV says so.
 * @returns undefined when no MCP server started the run, null when one did but no usable key came, otherwise the key
 */
export const spawnerKey = ({ env = process.env, input = process.stdin, timeoutMs = 5000 } = {}) => {
    spawner ??= (async () => {
        if (env[KEY_ENV] !== KEY_FROM_STDIN) return undefined;
        // Nothing the run starts reads it again.
        delete env[KEY_ENV];
        const line = await firstLine(input, timeoutMs);
        return isPublicKey(line) ? line : null;
    })();
    return spawner;
};

/** Tests only: forget the key read before. */
export const forgetSpawnerKey = () => {
    spawner = undefined;
};

/** What the MCP server gives a run it starts: the environment variable, and the line for its stdin. */
export const spawnerHandover = (keys) => ({ env: { [KEY_ENV]: KEY_FROM_STDIN }, line: `${keys.publicKey}\n` });
