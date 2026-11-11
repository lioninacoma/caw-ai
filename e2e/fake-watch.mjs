// Stand-in for the Sencha watch's web server in the e2e: serves the current folder (the app folder) on 127.0.0.1:<port>, as
// `sencha app watch` serves its workspace on 1841. No Sencha needed, and independent of any real watch on the machine.
// Usage: node fake-watch.mjs <port> [<pid file>]; the pid file shows the e2e that caw started it and stopped it again.
import { writeFileSync } from 'node:fs';

import { serveFolder } from '../test/static-server.mjs';

const [port, pidFile] = process.argv.slice(2);
await serveFolder(process.cwd(), { port: Number(port) });
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
