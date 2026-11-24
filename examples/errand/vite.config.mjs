// Errand as a Vite dev server: every request runs the current server.mjs, a change reloads the open page.
import { defineConfig } from 'vite';

const OWN = /^\/(@vite\/|@id\/|node_modules\/vite\/)/;
const CLIENT = '<script type="module" src="/@vite/client"></script>';

const errand = () => ({
    name: 'errand',
    configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
            if (OWN.test(req.url)) return next();
            try {
                const { handle } = await server.ssrLoadModule('/server.mjs');
                // The pages get Vite's client, which reloads them after a change.
                const end = res.end.bind(res);
                res.end = (text, ...rest) => end(typeof text === 'string' ? text.replace('</head>', `${CLIENT}</head>`) : text, ...rest);
                await handle(req, res);
            } catch (error) {
                server.ssrFixStacktrace(error);
                next(error);
            }
            return undefined;
        });
    },
    handleHotUpdate({ file, server }) {
        if (!file.endsWith('/server.mjs')) return undefined;
        server.ws.send({ type: 'full-reload' });
        return [];
    },
});

export default defineConfig({
    appType: 'custom',
    clearScreen: false,
    plugins: [errand()],
    // caw's files change while it runs: they are no part of the app.
    server: { host: '127.0.0.1', port: 4174, strictPort: true, watch: { ignored: ['**/caw/**', '**/.caw/**'] } },
});
