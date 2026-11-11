// Zustaende per Klick: Nach der Uebergabe (open, run --until) bietet die Werkbank mit F1 alle Tests an, die zur angemeldeten Rolle,
// zur App und zur Umgebung passen. Ein Schritt laesst sich herstellen, wenn er und alle davor aufgenommen und aktuell sind.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { TEST_DIR } from '../shared/names.mjs';
import { assertPlayable } from './replay.mjs';
import { loadTest, staleSteps, withDefaults, withExpectations } from './test-file.mjs';

/** Die Namen aller Tests im Projekt, sortiert. */
const testIds = (root) => {
    const dir = join(root, TEST_DIR);
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -'.yaml'.length)).sort() : [];
};

/** Ein Test, wie ihn der Lauf braucht: mit Vorgaben der Config und Erwartungen. undefined, wenn er sich nicht lesen laesst. */
export const loadStateTest = (root, config, id) => {
    try {
        const spec = withDefaults(loadTest(root, id), config);
        return spec.expectations === undefined ? withExpectations(spec) : spec;
    } catch {
        return undefined;
    }
};

/**
 * Die Tests, deren Zustaende sich hier herstellen lassen: gleiche Rolle, gleiche App, die Umgebung unter ihren Zielen.
 * @returns [{ id, name, mutates, steps: [{ id, name, ok, why }] }]; `why`: stale, missing oder after (nach einem gesperrten Schritt)
 */
export const stateCatalog = (root, config, { role, app, target }) => testIds(root).flatMap((id) => {
    const spec = loadStateTest(root, config, id);
    if (spec === undefined || spec.role !== role || spec.app !== app || !(spec.targets ?? []).includes(target)) return [];
    const stale = new Set(staleSteps(spec).map((step) => step.id));
    let blocked = false;
    const steps = spec.steps.map((step) => {
        let why;
        if (blocked) why = 'after';
        else if (step.recording === undefined) why = 'missing';
        else if (stale.has(step.id)) why = 'stale';
        else {
            try {
                assertPlayable(spec, target, step.id);
            } catch {
                why = 'stale';
            }
        }
        if (why !== undefined) blocked = true;
        return { id: step.id, name: String(step.name ?? ''), ok: why === undefined, ...(why === undefined ? {} : { why }) };
    });
    if (!steps.some(({ ok }) => ok)) return [];
    return [{ id, name: String(spec.name ?? ''), mutates: spec.mutates !== false, steps }];
});

/** Steht der Schritt im Katalog und laesst sich herstellen? */
export const canRestore = (catalog, testId, stepId) => catalog.some((test) => test.id === testId && test.steps.some((step) => step.id === stepId && step.ok));
