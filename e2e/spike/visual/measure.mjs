// Measures the pixel noise between runs that nothing changed, so the visual thresholds (visual.tolerance, visual.maxRatio,
// visual.designMaxRatio in src/host/visual.mjs DEFAULT_VISUAL) come from data instead of a guess. Each run starts a fresh
// headless Chrome (rendering differs a little between launches: fonts, anti-aliasing, GPU), captures every page with caw's
// own captureStep (same viewport, CSS pixels, same masks) and compares it with the first run's capture using caw's own
// comparePixels, for several channel tolerances.
//
//   node e2e/spike/visual/measure.mjs [--runs 30] [--tolerances 0,8,16,24,32] [--viewport 1280x720] [--url <url> ...]
//                                     [--out e2e/spike/data/visual-<platform>.json]
//
// Without --url it starts the spike app (e2e/spike/app.mjs, environment a: a list, a form, a sync notice that flickers) and
// adds the errand example's target design rendered as caw renders designs. Run it on Windows and on Linux (CI image): the
// image of a learned look is per platform, the thresholds are not. Proposal printed at the end, per tolerance:
// p99 of the ratio over all pages and runs, times 2 plus 0.0005 as margin; take the larger of both platforms. Not run in
// npm test and not shipped (pack-check rejects e2e/).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { renderDesign } from '../../../src/host/design.mjs';
import { captureStep, comparePixels } from '../../../src/host/visual.mjs';
import { startApp } from '../app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? fallback : args[at + 1];
};
const all = (name) => args.flatMap((arg, index) => (arg === `--${name}` ? [args[index + 1]] : []));

const runs = Number(flag('runs', '30'));
const tolerances = flag('tolerances', '0,8,16,24,32').split(',').map(Number);
const [width, height] = flag('viewport', '1280x720').split('x').map(Number);
const out = flag('out', join(here, '..', 'data', `visual-${process.platform}.json`));
const launch = () => chromium.launch({ channel: 'chrome', headless: true });

const quantile = (values, q) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

const main = async () => {
    const app = all('url').length > 0 ? null : await startApp();
    const pages = all('url').length > 0
        ? all('url').map((url) => ({ name: url, url }))
        : [{ name: 'spike a /', url: `http://a.localhost:${app.port}/` }, { name: 'errand design', design: join(here, '..', '..', '..', 'examples', 'errand', 'caw', 'design', 'todo-detail.html') }];
    const captures = new Map(pages.map(({ name }) => [name, []]));
    const started = Date.now();
    try {
        for (let run = 1; run <= runs; run += 1) {
            const browser = await launch();
            try {
                for (const page of pages) {
                    let target;
                    if (page.design === undefined) {
                        const context = await browser.newContext({ viewport: { width, height } });
                        target = await context.newPage();
                        // Chrome resolves *.localhost to loopback itself; the spike app answers per host name.
                        await target.goto(page.url, { waitUntil: 'networkidle' });
                    } else {
                        target = await renderDesign(browser, readFileSync(page.design, 'utf8'), { width, height });
                    }
                    try {
                        captures.get(page.name).push(await captureStep(target, {}));
                    } finally {
                        await target.context().close();
                    }
                }
            } finally {
                await browser.close();
            }
            const left = ((Date.now() - started) / run) * (runs - run) / 1000;
            console.log(`run ${run}/${runs}, about ${Math.round(left)} s left`);
        }
        // Every capture against the first one of its page, in one comparison browser.
        const browser = await launch();
        const ratios = Object.fromEntries(tolerances.map((tolerance) => [tolerance, []]));
        const perPage = {};
        try {
            for (const [name, shots] of captures) {
                perPage[name] = Object.fromEntries(tolerances.map((tolerance) => [tolerance, []]));
                for (const shot of shots.slice(1)) {
                    for (const tolerance of tolerances) {
                        const { ratio } = await comparePixels(browser, shot.png, shots[0].png, { masks: [...shots[0].masks, ...shot.masks], tolerance });
                        ratios[tolerance].push(ratio);
                        perPage[name][tolerance].push(ratio);
                    }
                }
            }
        } finally {
            await browser.close();
        }
        const summary = tolerances.map((tolerance) => {
            const values = ratios[tolerance];
            const p99 = quantile(values, 0.99);
            return { tolerance, n: values.length, p50: quantile(values, 0.5), p99, max: Math.max(0, ...values), proposedMaxRatio: Math.round((p99 * 2 + 0.0005) * 10000) / 10000 };
        });
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({ platform: process.platform, runs, viewport: { width, height }, pages: pages.map(({ name }) => name), summary, perPage }, null, 2));
        console.log(`\n| tolerance | comparisons | p50 | p99 | max | proposed maxRatio |\n|---|---|---|---|---|---|`);
        for (const row of summary) console.log(`| ${row.tolerance} | ${row.n} | ${row.p50} | ${row.p99} | ${row.max} | ${row.proposedMaxRatio} |`);
        console.log(`\nWritten: ${out}. Run on the other platform too and take the larger proposal.`);
    } finally {
        await app?.close();
    }
};

await main();
