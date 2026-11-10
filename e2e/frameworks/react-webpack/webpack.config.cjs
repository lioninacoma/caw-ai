// Dieselben Quellen wie react-vite, gebaut mit webpack 5. Anders als Vite: klassische Skripte statt ES-Module, eine Laufzeit im
// Einstieg, die lazy Chunks per JSONP unter Namen aus ihrer eigenen Tabelle laedt, Hash als [contenthash] hinter einem Punkt.
//   CAW_BUILD   Kennung auf der Seite (dev, deployed, local)
//   --output-path deploy|local   wie bei den anderen Projekten
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
            // react und react-router aus react-vite, sonst gaebe es zwei Kopien
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
            // Der Socket fuer HMR unter der Adresse der Seite (localhost), nicht unter host: Sonst lehnt der Server den Origin ab.
            client: { webSocketURL: 'auto://0.0.0.0:0/ws' },
            proxy: [{ context: ['/api'], target: 'http://127.0.0.1:3999' }],
        },
        performance: { hints: false },
    };
};
