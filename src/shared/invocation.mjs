// How the person calls caw, for the commands that hints and messages suggest. After `npm i -D caw-ai` only `npx caw` works
// (the bin is in node_modules/.bin, not on the PATH); a global install is called as `caw`. npm sets npm_execpath for every
// command it runs (npx, npm exec, a package script), a global bin started from the shell does not have it.

/** `npx caw` when npm started caw, otherwise `caw`. Texts use it as {caw}. */
export const cawCommand = (env = process.env) => (typeof env.npm_execpath === 'string' && env.npm_execpath !== '' ? 'npx caw' : 'caw');
