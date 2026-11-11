// caw-ai theme: Themes auflisten, eines waehlen, eines pruefen. Das Theme ist persoenlich (prefs.json), gilt also in allen Projekten.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE } from '../shared/names.mjs';
import { writePref } from '../shared/prefs.mjs';
import { activeTheme, listThemes, loadTheme, missingFonts, readThemePackage, themeDir, themeWarnings, validateTheme } from '../shared/theme-package.mjs';
import { createUi } from '../shared/ui.mjs';

/** Der Team-Standard zaehlt fuer „aktiv“ mit: Die Config wird gelesen, wenn es eine gibt; eine kaputte stoert hier nicht. */
const readProject = (root) => {
    if (!existsSync(join(root, CONFIG_FILE))) return;
    try {
        loadConfig(root);
    } catch {
        // Ohne gueltige Config gilt eben kein Team-Standard.
    }
};

const known = (name, env) => {
    if (readThemePackage(name, env) !== undefined) return;
    const names = listThemes(env).map((theme) => theme.name);
    throw new CawError('usage', t('cli.themeUnknown', { name, names: names.join(', ') }));
};

/**
 * caw-ai theme [use <name> | check <name>]
 * @returns Exit-Code
 */
export const themeCommand = (root, args, { ui = createUi(), env = process.env } = {}) => {
    const [action, name, ...rest] = args;
    if (rest.length > 0) throw new CawError('usage', t('cli.themeUsage'));
    readProject(root);
    if (action === undefined) {
        const active = activeTheme(env).name;
        ui.heading(t('cli.themeHeading'));
        for (const theme of listThemes(env)) {
            const text = `${theme.name.padEnd(12)} ${theme.label}${theme.builtin ? '' : ` · ${t('cli.themeOwn', { base: theme.base })}`}`;
            if (theme.name === active) ui.success(`${text} ${t('cli.themeActive')}`);
            else ui.info(text);
        }
        ui.note(t('cli.themeHint'));
        return EXIT.pass;
    }
    if (name === undefined || !['use', 'check'].includes(action)) throw new CawError('usage', t('cli.themeUsage'));
    known(name, env);
    if (action === 'use') {
        writePref('theme', name, env);
        ui.success(t('cli.themeUsed', { name }));
        return EXIT.pass;
    }
    const pkg = readThemePackage(name, env);
    const problems = validateTheme(pkg);
    const theme = loadTheme(name, env);
    const warnings = themeWarnings(theme);
    const fonts = missingFonts(theme, env);
    const dir = themeDir(name, env);
    ui.heading(t('cli.themeCheck', { name }));
    ui.info(typeof dir === 'string' ? dir : decodeURIComponent(dir.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    if (problems.length === 0) ui.success(t('cli.themeSchemaOk'));
    for (const problem of problems) ui.warn(problem);
    for (const warning of warnings) ui.warn(warning.kind === 'width' ? t('cli.themeWidth') : t('cli.themeContrast', { pair: warning.text, ratio: warning.ratio }));
    for (const file of fonts) ui.warn(t('cli.themeFontMissing', { file }));
    if (warnings.length === 0 && fonts.length === 0) ui.success(t('cli.themeLooksOk'));
    return problems.length > 0 || fonts.length > 0 ? EXIT.error : EXIT.pass;
};
