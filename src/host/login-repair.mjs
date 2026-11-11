// When sign-in fails, Claude proposes a corrected auth block. It only sees evidence from the page (loginEvidence): selector hits,
// stable fields, buttons and classes, without field values or account texts. Claude gets no tools, only this evidence; nothing is
// written until the human says yes. Only where tokens are allowed anyway (with chat, environment with claude).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveClaude } from '../shared/claude-bin.mjs';
import { authOf, validateConfig } from '../shared/config.mjs';
import { language, t } from '../shared/i18n.mjs';
import { CONFIG_FILE } from '../shared/names.mjs';
import { askYesNo, createUi } from '../shared/ui.mjs';
import { connectionSettings } from '../sandbox/commands.mjs';

const ui = createUi();
const ANSWER_MS = 120_000;
const FIELDS = ['path', 'userSelector', 'passwordSelector', 'submitSelector', 'codeSelector', 'signedInSelector'];

/** Is this an error a different auth block can fix? */
export const isLoginFailure = (error) => ['login-failed', 'login-form-missing'].includes(error?.code) && error.evidence !== null && error.evidence !== undefined;

export const repairPrompt = ({ auth, message, evidence }) => `A browser test tool failed to sign in to a web application.
Propose a corrected "auth" block for its config. Generic rules, no knowledge about any product:
- Selectors must be stable across page loads and the same for every account. Avoid IDs with random-looking parts.
- signedInSelector must exist on every page after sign-in for every account, regardless of permissions. A state class on html/body
  (e.g. body.signed-in) is best; a sign-out link is good; menus that only some users see are bad.
- Omit submitSelector when pressing Enter in the password field submits the form (login.submitsWithEnter is true).
- path is the path of the page with the sign-in form, starting with "/".
- Change only what the evidence shows is wrong.

Error: ${message}

Current auth block:
${JSON.stringify(auth, null, 2)}

Evidence from the page at the moment of failure ("hits" = how many elements each configured selector matched now; "login" = sign-in
form found on this page, null if none; "stateClasses" = classes on html/body; "markers" = stable selectors on the page):
${JSON.stringify(evidence, null, 2)}

Answer with exactly one JSON object and nothing else:
{"auth": { ...the full corrected auth block... }, "why": "one or two short sentences in ${language() === 'de' ? 'German' : 'English'}"}
If the evidence does not allow a confident fix, answer {"auth": null, "why": "..."}.`;

/** The first JSON object in Claude's answer, also inside a code block. */
export const parseAnswer = (text) => {
    const start = String(text).indexOf('{');
    const end = String(text).lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(String(text).slice(start, end + 1));
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
};

/** Only known fields, only strings; the type stays as it is. */
export const cleanAuth = (current, proposed) => {
    if (typeof proposed !== 'object' || proposed === null) return null;
    const next = { type: current.type };
    for (const key of FIELDS) {
        const value = proposed[key];
        if (typeof value === 'string' && value.trim() !== '') next[key] = value.trim();
    }
    return next;
};

const runClaude = (prompt, { bin = resolveClaude(), cwd }) => new Promise((ok) => {
    if (bin === null || bin === undefined) {
        ok(null);
        return;
    }
    // No tools, no project settings: only the evidence in the prompt.
    const args = [...bin.args, '-p', '--tools', '', '--permission-mode', 'dontAsk', '--setting-sources', '', '--settings', JSON.stringify(connectionSettings()), '--output-format', 'json'];
    const child = spawn(bin.file, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), ANSWER_MS);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); ok(null); });
    child.on('close', () => {
        clearTimeout(timer);
        try {
            ok(JSON.parse(out).result ?? null);
        } catch {
            ok(null);
        }
    });
    child.stdin.end(prompt);
});

const askYes = (question) => askYesNo(question, { fallback: false });

/** The change per field as lines for ui.box: field, old, new. */
const diffLines = (before, after) => FIELDS.filter((key) => before[key] !== after[key])
    .flatMap((key) => [{ status: 'info', text: key }, { status: 'removed', text: before[key] ?? '—' }, { status: 'added', text: after[key] ?? '—' }]);

/**
 * Asks Claude, shows the proposal and writes it to caw.config.json after a yes.
 * @returns true if the config was changed
 */
export const offerAuthRepair = async ({ root, config, error, ask = askYes, claude = runClaude }) => {
    const auth = authOf(config);
    ui.info(t('repair.asking'));
    const answer = parseAnswer(await claude(repairPrompt({ auth, message: error.message, evidence: error.evidence }), { cwd: root }));
    if (answer === null) {
        ui.note(t('repair.noAnswer'));
        return false;
    }
    const next = cleanAuth(auth, answer.auth);
    const changes = next === null ? [] : diffLines(auth, next);
    if (changes.length === 0) {
        ui.note(t('repair.none', { why: String(answer.why ?? '').slice(0, 400) }));
        return false;
    }
    const path = join(root, CONFIG_FILE);
    const raw = readFileSync(path, 'utf8');
    const updated = { ...JSON.parse(raw), auth: next };
    const issues = validateConfig(updated, root).issues.filter((issue) => /auth/.test(issue));
    if (issues.length > 0) {
        ui.note(t('repair.invalid', { issues: issues.join('; ') }));
        return false;
    }
    ui.box(t('repair.proposal', { file: CONFIG_FILE }), [...changes, { status: 'note', text: String(answer.why ?? '').slice(0, 400) }]);
    if (!process.stdin.isTTY && ask === askYes) return false;
    if (!await ask(t('repair.confirm'))) return false;
    const text = `${JSON.stringify(updated, null, 4)}\n`;
    writeFileSync(path, raw.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text);
    ui.success(t('repair.written', { file: CONFIG_FILE }));
    return true;
};
