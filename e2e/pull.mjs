// Pulls the images of e2e/images.lock.json by digest (Docker directly or in WSL, like the sandbox).
//   node e2e/pull.mjs [image …]      without images: all locked images
import { imageLock, pullImages } from './infra.mjs';

const wanted = process.argv.slice(2);
await pullImages(wanted.length > 0 ? wanted : Object.keys(imageLock()));
console.log(`pulled: ${(wanted.length > 0 ? wanted : Object.keys(imageLock())).join(', ')}`);
