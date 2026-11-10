// Selbstsigniertes Zertifikat fuer die "deployten" Server auf *.localhost. Wird beim ersten Start erzeugt und nie eingecheckt; die
// Matrix laeuft mit insecureTls, jedes Zertifikat reicht.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = join(dirname(fileURLToPath(import.meta.url)), '.cert');
const key = join(folder, 'key.pem');
const cert = join(folder, 'cert.pem');

/** Legt Schluessel und Zertifikat an, falls sie fehlen. Braucht openssl (unter Windows bringt Git for Windows es mit). */
export const ensureCert = () => {
    if (existsSync(key) && existsSync(cert)) return;
    mkdirSync(folder, { recursive: true });
    const result = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
        '-keyout', key, '-out', cert,
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost',
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`openssl fehlt oder scheitert: ${result.error?.message ?? result.stderr}`);
};

export const readCert = () => {
    ensureCert();
    return { key: readFileSync(key), cert: readFileSync(cert) };
};
