// Self-signed certificate for the "deployed" servers on *.localhost. Created on the first start and never checked in; the matrix
// runs with insecureTls, any certificate will do.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = join(dirname(fileURLToPath(import.meta.url)), '.cert');
const key = join(folder, 'key.pem');
const cert = join(folder, 'cert.pem');

/** Creates key and certificate if they are missing. Needs openssl (on Windows, Git for Windows ships it). */
export const ensureCert = () => {
    if (existsSync(key) && existsSync(cert)) return;
    mkdirSync(folder, { recursive: true });
    const result = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
        '-keyout', key, '-out', cert,
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost',
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`openssl is missing or fails: ${result.error?.message ?? result.stderr}`);
};

export const readCert = () => {
    ensureCert();
    return { key: readFileSync(key), cert: readFileSync(cert) };
};
