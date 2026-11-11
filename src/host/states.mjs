// States on click: after the handover (open, run --until) the workbench offers via F1 every test that matches the
// signed-in role, the app and the target. A step can be restored if it and all steps before it are recorded and current.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { TEST_DIR } from '../shared/names.mjs';
import { authOf } from '../shared/config.mjs';
import { assertPlayable } from './replay.mjs';
import { loadTest, staleSteps, withDefaults, withExpectations } from './test-file.mjs';

const authType = (config) => authOf(config).type;

/** The ids of all tests in the project, sorted. */
const testIds = (root) => {
    const dir = join(root, TEST_DIR);
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -'.yaml'.length)).sort() : [];
};

/** A test as the run needs it: with config defaults and expectations. undefined if it cannot be read. */
export const loadStateTest = (root, config, id) => {
    try {
        const spec = withDefaults(loadTest(root, id), config);
        return spec.expectations === undefined ? withExpectations(spec) : spec;
    } catch {
        return undefined;
    }
};

/**
 * The tests whose states can be restored here: the target among their targets, any role and app. Restoring signs in
 * freshly with the account of the test's role. `role`/`app` narrow the list, e.g. for basic auth, where the account is tied to the browser.
 * @returns [{ id, name, role, app, mutates, steps: [{ id, name, ok, why }] }]; `why`: stale, missing or after (follows a blocked step)
 */
export const stateCatalog = (root, config, { role, app, target }) => testIds(root).flatMap((id) => {
    const spec = loadStateTest(root, config, id);
    if (spec === undefined || !(spec.targets ?? []).includes(target)) return [];
    if ((role !== undefined && spec.role !== role) || (app !== undefined && spec.app !== app)) return [];
    // Without an account for the role or without the app in the config nothing can be restored.
    if (config.apps?.[spec.app] === undefined || (spec.role !== undefined && config.roles?.[spec.role] === undefined && authType(config) !== 'none' && authType(config) !== 'storageState')) return [];
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
    return [{ id, name: String(spec.name ?? ''), role: String(spec.role ?? ''), app: String(spec.app ?? ''), mutates: spec.mutates !== false, steps }];
});

/** Is the step in the catalog and restorable? */
export const canRestore = (catalog, testId, stepId) => catalog.some((test) => test.id === testId && test.steps.some((step) => step.id === stepId && step.ok));
