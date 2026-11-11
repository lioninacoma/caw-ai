import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base32Bytes, totp, totpFromKey } from '../src/shared/totp.mjs';

// RFC 6238, appendix B: the SHA1 secret "12345678901234567890", 8 digits.
const RFC_KEY = Buffer.from('12345678901234567890');
const RFC_VECTORS = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
];

test('totp: the test vectors from RFC 6238', () => {
    for (const [seconds, code] of RFC_VECTORS) assert.equal(totpFromKey(RFC_KEY, seconds * 1000, { digits: 8 }), code);
});

test('totp: Base32 yields the same bytes as the raw secret', () => {
    assert.deepEqual(base32Bytes('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), RFC_KEY);
    assert.deepEqual(base32Bytes('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq=='), RFC_KEY);
});

test('totp: six digits, one code per 30 s', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totp(secret, 59_000), '287082');
    assert.equal(totp(secret, 30_000), totp(secret, 59_999));
    assert.notEqual(totp(secret, 59_999), totp(secret, 60_000));
});

test('totp: a character outside Base32 is rejected', () => {
    assert.throws(() => base32Bytes('ABC1'), /invalid character/);
});
