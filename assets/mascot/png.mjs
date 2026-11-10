// Kleiner PNG-Leser und -Schreiber fuer die Maskottchen-Pipeline, ohne Abhaengigkeiten.
// Liest 8-Bit-PNGs ohne Interlace (Palette, Grau, RGB, RGBA), schreibt immer RGBA.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** PNG-Datei -> { width, height, data: RGBA-Bytes }. */
export const decodePng = (file) => {
    if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error('keine PNG-Datei');
    let offset = 8, header = null, palette = null, alpha = null;
    const idat = [];
    while (offset < file.length) {
        const length = file.readUInt32BE(offset), type = file.toString('latin1', offset + 4, offset + 8);
        const body = file.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
        else if (type === 'PLTE') palette = body;
        else if (type === 'tRNS') alpha = body;
        else if (type === 'IDAT') idat.push(body);
        else if (type === 'IEND') break;
        offset += 12 + length;
    }
    const { width, height, depth, color, interlace } = header;
    if (depth !== 8 || interlace !== 0 || !(color in CHANNELS)) throw new Error(`PNG-Format nicht unterstuetzt (Tiefe ${depth}, Farbtyp ${color}, Interlace ${interlace})`);
    const bpp = CHANNELS[color], stride = width * bpp, raw = inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = pixels.subarray(y * stride, (y + 1) * stride), prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x += 1) {
            const a = x >= bpp ? out[x - bpp] : 0, b = prev ? prev[x] : 0, c = prev && x >= bpp ? prev[x - bpp] : 0;
            const add = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
            if (add === undefined) throw new Error(`PNG-Filter ${filter} unbekannt`);
            out[x] = (line[x] + add) & 0xff;
        }
    }
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        const p = pixels.subarray(i * bpp, (i + 1) * bpp);
        let rgba;
        if (color === 3) rgba = [palette[p[0] * 3], palette[p[0] * 3 + 1], palette[p[0] * 3 + 2], alpha && p[0] < alpha.length ? alpha[p[0]] : 255];
        else if (color === 0) rgba = [p[0], p[0], p[0], 255];
        else if (color === 4) rgba = [p[0], p[0], p[0], p[1]];
        else if (color === 2) rgba = [p[0], p[1], p[2], 255];
        else rgba = [p[0], p[1], p[2], p[3]];
        data.set(rgba, i * 4);
    }
    return { width, height, data };
};

const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
};

/** { width, height, data: RGBA-Bytes } -> PNG-Datei (RGBA, ohne Filter). */
export const encodePng = ({ width, height, data }) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y += 1) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

/** Leeres RGBA-Bild. */
export const blank = (width, height) => ({ width, height, data: Buffer.alloc(width * height * 4) });

/** Ganzzahlig vergroessern, nur fuer Vorschauen. */
export const upscale = (image, k) => {
    const out = blank(image.width * k, image.height * k);
    for (let y = 0; y < out.height; y += 1) {
        for (let x = 0; x < out.width; x += 1) {
            image.data.copy(out.data, (y * out.width + x) * 4, (Math.floor(y / k) * image.width + Math.floor(x / k)) * 4, (Math.floor(y / k) * image.width + Math.floor(x / k)) * 4 + 4);
        }
    }
    return out;
};
