// The same sources as react-vite, built with webpack 5. Unlike Vite: classic scripts instead of ES modules, a runtime in the entry
// that loads lazy chunks via JSONP under names from its own table, hash as [contenthash] after a dot.
//   CAW_BUILD   build id on the page (dev, deployed, local)
//   --output-path deploy|local   as in the other projects
const { join, resolve } = require('node:path');
const { DefinePlugin } = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const shared = resolve(__dirname, '../react-vite');

module.exports = (_env, argv) => {
    const production = argv.mode !== 'development';
    return {
        mode: production ? 'production' : 'development',
        context: shared,
        entry: { main: './src/main.tsx' },
        output: {
            path: resolve(__dirname, 'dist'),
            publicPath: '/',
            filename: 'static/js/[name].[contenthash:8].js',
            chunkFilename: 'static/js/[name].[contenthash:8].chunk.js',
            clean: true,
        },
        devtool: 'source-map',
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
            // react and react-router from react-vite, otherwise there would be two copies
            modules: [join(shared, 'node_modules'), 'node_modules'],
        },
        module: {
            rules: [{ test: /\.[jt]sx?$/, exclude: /node_modules/, loader: require.resolve('esbuild-loader'), options: { target: 'es2020', jsx: 'automatic' } }],
        },
        plugins: [
            new DefinePlugin({ 'import.meta.env.VITE_BUILD': JSON.stringify(process.env.CAW_BUILD ?? 'dev') }),
            new HtmlWebpackPlugin({ template: resolve(__dirname, 'index.html') }),
            new CopyWebpackPlugin({ patterns: [{ from: join(shared, 'public'), to: '.' }] }),
        ],
        devServer: {
            host: '127.0.0.1',
            port: 5175,
            historyApiFallback: true,
            hot: true,
            // The HMR socket at the address of the page (localhost), not at host: otherwise the server rejects the origin.
            client: { webSocketURL: 'auto://0.0.0.0:0/ws' },
            proxy: [{ context: ['/api'], target: 'http://127.0.0.1:3999' }],
        },
        // CAW_SPLIT=1: vendor code in chunks of its own that the page loads by tag; without the tags of the local build main would not start.
        ...(process.env.CAW_SPLIT === '1' ? { optimization: { runtimeChunk: 'single', splitChunks: { chunks: 'all', cacheGroups: { vendor: { test: /[\\/]node_modules[\\/]/, name: 'vendor' } } } } } : {}),
        performance: { hints: false },
    };
};
