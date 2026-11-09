// Einmalcode nach RFC 6238 (TOTP, HMAC-SHA1, 30 s, 6 Stellen), wie ihn Authenticator-Apps zeigen: fuer Testkonten,
// deren Anmeldung nach dem Passwort einen zweiten Faktor verlangt. Das Geheimnis ist Base32, wie im otpauth-Link.

import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const BITS_PER_CHAR = 5;
const BITS_PER_BYTE = 8;

/** Base32 (RFC 4648) zu Bytes; Leerzeichen, Bindestriche und `=` zaehlen nicht. */
export const base32Bytes = (text) => {
    const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (const char of clean) {
        const value = ALPHABET.indexOf(char);
        if (value === -1) throw new Error(`base32: unerlaubtes Zeichen ${JSON.stringify(char)}`);
        buffer = (buffer << BITS_PER_CHAR) | value;
        bits += BITS_PER_CHAR;
        if (bits >= BITS_PER_BYTE) {
            bits -= BITS_PER_BYTE;
            bytes.push((buffer >> bits) & 0xff);
        }
    }
    return Buffer.from(bytes);
};

/** Der Code zum Zeitpunkt `nowMs` fuer ein rohes Geheimnis (Bytes). */
export const totpFromKey = (key, nowMs = Date.now(), { digits = DIGITS, step = STEP_SECONDS, algorithm = 'sha1' } = {}) => {
    const counter = Buffer.alloc(BITS_PER_BYTE);
    counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / step)));
    const mac = createHmac(algorithm, key).update(counter).digest();
    const offset = mac[mac.length - 1] & 0x0f;
    const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
    return String(value).padStart(digits, '0');
};

/** Der Code fuer ein Base32-Geheimnis, wie es in `caw/.env` steht. */
export const totp = (secret, nowMs = Date.now()) => totpFromKey(base32Bytes(secret), nowMs);
