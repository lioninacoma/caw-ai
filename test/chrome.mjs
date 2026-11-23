// Starts Chrome for the browser tests. Without Chrome the tests skip locally; with CAW_REQUIRE_CHROME=1 (set in CI) a missing
// Chrome fails the suite instead of passing it green with skipped tests.
import { chromium } from 'playwright-core';

import { registerEngines } from '../src/ext/extjs/extjs-engine.mjs';

// The extjs= engine is registered before every launch, as caw does. `args`: further Chrome flags, e.g. caw's host lock (browserArgs);
// `ignoreDefaultArgs`: Playwright's flags left out, e.g. --hide-scrollbars for a page that lays out like one in a window.
export const launchChrome = async ({ args = [], ignoreDefaultArgs } = {}) => {
    await registerEngines();
    return chromium.launch({ channel: 'chrome', headless: true, args, ...(ignoreDefaultArgs === undefined ? {} : { ignoreDefaultArgs }) }).catch((error) => {
        if (process.env.CAW_REQUIRE_CHROME === '1') throw new Error(`Chrome is required (CAW_REQUIRE_CHROME=1): ${error.message}`);
        return null;
    });
};
