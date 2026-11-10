// Der Ablaufplan, den Claude im Chat vorlegt, ist die spaetere Testdatei ohne Aufzeichnung: dieselben Felder, keine zweite Form.
// Der Agent kann das Projekt nicht aendern. Die Metadaten schreibt das Tool, Rolle, Ziele und Schreibrecht bleiben beim Menschen.

import { t } from '../shared/i18n.mjs';
import { parsePlan, withExpectations } from './test-file.mjs';

export const PLAN_FILE = 'plan.yaml';

const MAX_LENGTH = 100_000;
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Der Text stammt mittelbar aus der Anwendung und landet in Chat und Terminal.
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Passt ein Plan? Laeuft, bevor der Mensch ihn sieht, damit der Agent noch nachbessern kann.
 * @returns { problems, plan }
 */
export const readPlan = (text) => {
    const problems = [];
    if (text.length > MAX_LENGTH) problems.push(t('config.plan.tooLong', { max: MAX_LENGTH }));
    if (CONTROL.test(text)) problems.push(t('config.plan.control'));
    if (EMAIL.test(text)) problems.push(t('config.plan.email'));
    const parsed = parsePlan(text);
    problems.push(...parsed.problems);
    return problems.length > 0 ? { problems } : { problems, plan: parsed.plan };
};

/** Metadaten vom Tool, Inhalt vom Agenten. Eine Aufzeichnung gibt es erst nach dem Lauf. */
export const composeTest = (meta, { notes, steps }) => withExpectations({
    id: meta.id,
    app: meta.app,
    role: meta.role,
    targets: meta.targets,
    ...(meta.code === undefined ? {} : { code: meta.code }),
    mutates: meta.mutates,
    also: meta.also ?? [],
    notes,
    steps,
});

/** Ersetzt genau einen Schritt, alle anderen bleiben dieselben Objekte. */
export const replaceStep = (spec, step) => withExpectations({ ...spec, steps: spec.steps.map((current) => (current.id === step.id ? step : current)) });

/** Gleicher Plan fuer einen Schritt: Titel, Aktion, Ergebnis, Hinweis und Wiederholung. Die Aufzeichnung zaehlt nicht. */
export const samePlanStep = (a, b) => ['id', 'name', 'do', 'expect', 'note'].every((key) => (a[key] ?? '') === (b[key] ?? ''))
    && JSON.stringify(a.retry ?? null) === JSON.stringify(b.retry ?? null);

/** Was die Plankarte im Chat zeigt, nur Plan-Felder. */
export const planView = ({ notes, steps }, { repairing = false, rerecord = false, previous } = {}) => ({
    repairing,
    title: repairing ? t(rerecord ? 'config.plan.rerecord' : 'config.plan.fix', { id: String(steps[0]?.id) }) : t('config.plan.title'),
    notes: repairing ? '' : notes,
    steps: steps.map(({ id, name, do: action, expect, note, retry }) => ({
        id,
        name,
        do: action,
        expect,
        ...(note === undefined ? {} : { note }),
        ...(retry === undefined ? {} : { retry }),
        ...(previous !== undefined && previous.expect !== expect ? { previousExpect: previous.expect } : {}),
    })),
});
