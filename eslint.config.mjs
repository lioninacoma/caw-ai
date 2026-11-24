// ESLint: the recommended rules of ESLint and eslint-plugin-n, plus a few well-established best practices.
// Formatting is not checked here; the code keeps its existing style.
import js from '@eslint/js';
import n from 'eslint-plugin-n';
import globals from 'globals';

export default [
    {
        // e2e/frameworks: only the matrix scripts and shared/ are linted, not the test apps and what runs produce.
        ignores: ['node_modules/', 'e2e/frameworks/*/', '!e2e/frameworks/shared/', 'e2e/frameworks/shared/.cert/', 'e2e/frameworks/.caw-home/', 'e2e/project/', 'e2e/export/', 'examples/**/.caw/', 'examples/**/node_modules/', '**/.caw/', 'e2e/.caw-home/'],
    },
    js.configs.recommended,
    n.configs['flat/recommended-module'],
    // An example has its own package.json: what it imports is installed there, not here.
    { files: ['examples/**/*.mjs'], rules: { 'n/no-missing-import': 'off', 'n/no-unpublished-import': 'off' } },
    {
        files: ['**/*.mjs', '**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            eqeqeq: ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'error',
            'object-shorthand': ['error', 'always'],
            'prefer-arrow-callback': 'error',
            'no-throw-literal': 'error',
            'no-return-await': 'error',
            'no-useless-return': 'error',
            'no-useless-concat': 'error',
            'no-useless-rename': 'error',
            'no-lonely-if': 'error',
            'no-else-return': ['error', { allowElseIf: false }],
            'no-unneeded-ternary': 'error',
            'no-implicit-coercion': ['error', { allow: ['!!'] }],
            'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-shadow': 'error',
            'consistent-return': 'off',
            radix: 'error',
            yoda: 'error',
            'n/no-process-exit': 'off',
            'n/hashbang': 'off',
        },
    },
    {
        // Functions that Playwright runs inside the page (evaluate, addInitScript) or that end up in page scripts via toString().
        files: [
            'src/host/framework/*.mjs', 'src/ext/extjs/*.mjs', 'src/host/demonstrate.mjs', 'src/host/record-locator.mjs', 'src/host/accessible-name.mjs', 'src/host/explore.mjs', 'src/host/sign-in-wait.mjs', 'src/host/browser-session.mjs',
            'src/host/chat.mjs', 'src/host/app-view.mjs', 'src/host/effects.mjs', 'src/host/style.mjs', 'src/host/workbench.mjs', 'src/host/visual.mjs', 'src/host/design.mjs', 'src/host/design-snapshot.mjs', 'src/host/look-hints.mjs',
            'test/*-browser.test.mjs', 'test/login-portal.test.mjs', 'e2e/*.mjs', 'e2e/scenarios/*.mjs',
        ],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['test/**', 'e2e/**', 'scripts/**'],
        rules: {
            'n/no-unpublished-import': 'off',
        },
    },
];
