// Playwright writes the browser context's options into the trace, HTTP Basic credentials (`httpCredentials`) in plain text.
// scrubTrace rewrites a saved trace zip with every secret masked; entries without a secret are copied unchanged.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

import { MASK } from './secrets.mjs';

const MIN_SECRET = 4;
const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64 = 0xffffffff;

/** The byte sequences of a secret as it can appear in a trace: as is and JSON-escaped. */
const needlesOf = (secrets) => [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= MIN_SECRET)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length)
    .map((text) => Buffer.from(text, 'utf8'));

const replaceAll = (data, needle, mask) => {
    let at = data.indexOf(needle);
    if (at < 0) return data;
    const parts = [];
    let from = 0;
    while (at >= 0) {
        parts.push(data.subarray(from, at), mask);
        from = at + needle.length;
        at = data.indexOf(needle, from);
    }
    parts.push(data.subarray(from));
    return Buffer.concat(parts);
};

/** The entries of a zip from its central directory; null for anything this reader does not handle (zip64, broken). */
const entriesOf = (buffer) => {
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || buffer.readUInt32LE(end) !== END) return null;
    const count = buffer.readUInt16LE(end + 10);
    let at = buffer.readUInt32LE(end + 16);
    if (count === 0xffff || at === ZIP64) return null;
    const entries = [];
    for (let index = 0; index < count; index += 1) {
        if (buffer.readUInt32LE(at) !== CENTRAL) return null;
        const method = buffer.readUInt16LE(at + 10);
        const size = buffer.readUInt32LE(at + 20);
        const nameLength = buffer.readUInt16LE(at + 28);
        const local = buffer.readUInt32LE(at + 42);
        if (size === ZIP64 || local === ZIP64 || (method !== 0 && method !== 8) || buffer.readUInt32LE(local) !== LOCAL) return null;
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        entries.push({
            name: buffer.subarray(at + 46, at + 46 + nameLength),
            method,
            crc: buffer.readUInt32LE(at + 16),
            compressed: buffer.subarray(start, start + size),
            size: buffer.readUInt32LE(at + 24),
            time: buffer.readUInt32LE(at + 12),
        });
        at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    }
    return entries;
};

const writeZip = (entries) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(entry.method, 8);
        local.writeUInt32LE(entry.time, 10);
        local.writeUInt32LE(entry.crc, 14);
        local.writeUInt32LE(entry.compressed.length, 18);
        local.writeUInt32LE(entry.size, 22);
        local.writeUInt16LE(entry.name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(entry.method, 10);
        central.writeUInt32LE(entry.time, 12);
        central.writeUInt32LE(entry.crc, 16);
        central.writeUInt32LE(entry.compressed.length, 20);
        central.writeUInt32LE(entry.size, 24);
        central.writeUInt16LE(entry.name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, entry.name, entry.compressed);
        centrals.push(central, entry.name);
        offset += 30 + entry.name.length + entry.compressed.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
};

/**
 * Masks every secret in the trace zip at `file`. A zip this reader cannot rewrite is removed when it holds a secret: a
 * missing trace is better than a password in one.
 * @returns whether something was masked (or the file removed)
 */
export const scrubTrace = (file, secrets) => {
    const needles = needlesOf(secrets);
    if (needles.length === 0 || !existsSync(file)) return false;
    const buffer = readFileSync(file);
    const entries = entriesOf(buffer);
    if (entries === null) {
        if (!needles.some((needle) => buffer.includes(needle))) return false;
        rmSync(file, { force: true });
        return true;
    }
    const mask = Buffer.from(MASK, 'utf8');
    let changed = false;
    const rewritten = entries.map((entry) => {
        const data = entry.method === 8 ? inflateRawSync(entry.compressed) : entry.compressed;
        const masked = needles.reduce((current, needle) => replaceAll(current, needle, mask), data);
        if (masked === data) return entry;
        changed = true;
        return { ...entry, method: 8, crc: crc32(masked), compressed: deflateRawSync(masked), size: masked.length };
    });
    if (changed) writeFileSync(file, writeZip(rewritten));
    return changed;
};
