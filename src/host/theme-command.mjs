// caw theme: list themes, pick one, check one. The theme is personal (prefs.json), so it applies to all projects.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE } from '../shared/names.mjs';
import { writePref } from '../shared/prefs.mjs';
import { MODES, activeTheme, listThemes, loadTheme, missingFonts, readThemePackage, themeDir, themeMode, themeWarnings, validateTheme } from '../shared/theme-package.mjs';
import { createUi } from '../shared/ui.mjs';

/** The team default counts towards "active": the config is read if there is one; a broken one does not matter here. */
const readProject = (root) => {
    if (!existsSync(join(root, CONFIG_FILE))) return;
    try {
        loadConfig(root);
    } catch {
        // Without a valid config there is simply no team default.
    }
};

const requireKnownTheme = (name, env) => {
    if (readThemePackage(name, env) !== undefined) return;
    const names = listThemes(env).map((theme) => theme.name);
    throw new CawError('usage', t('cli.themeUnknown', { name, names: names.join(', ') }));
};

/**
 * caw theme [use <name> | mode <dark|light> | check <name>]
 * @returns exit code
 */
export const themeCommand = (root, args, { ui = createUi(), env = process.env } = {}) => {
    const [action, name, ...rest] = args;
    if (rest.length > 0) throw new CawError('usage', t('cli.themeUsage'));
    readProject(root);
    if (action === undefined) {
        const active = activeTheme(env).name;
        ui.heading(t('cli.themeHeading', { mode: t(`cli.themeMode.${themeMode(env)}`) }));
        for (const theme of listThemes(env)) {
            const text = `${theme.name.padEnd(12)} ${theme.label}${theme.builtin ? '' : ` · ${t('cli.themeOwn', { base: theme.base })}`}`;
            if (theme.name === active) ui.success(`${text} ${t('cli.themeActive')}`);
            else ui.info(text);
        }
        ui.note(t('cli.themeHint'));
        return EXIT.pass;
    }
    if (name === undefined || !['use', 'mode', 'check'].includes(action)) throw new CawError('usage', t('cli.themeUsage'));
    if (action === 'mode') {
        if (!MODES.includes(name)) throw new CawError('usage', t('cli.themeUsage'));
        writePref('mode', name, env);
        ui.success(t('cli.themeModeSet', { mode: t(`cli.themeMode.${name}`) }));
        const active = activeTheme(env);
        if (!active.modes.includes(name)) ui.note(t(`cli.themeOnly.${active.scheme}`, { name: active.name }));
        return EXIT.pass;
    }
    requireKnownTheme(name, env);
    if (action === 'use') {
        writePref('theme', name, env);
        ui.success(t('cli.themeUsed', { name }));
        return EXIT.pass;
    }
    const pkg = readThemePackage(name, env);
    const problems = validateTheme(pkg);
    const theme = loadTheme(name, env);
    // Contrast in every mode the theme has.
    const { modes } = theme;
    const warnings = modes.flatMap((mode) => themeWarnings(loadTheme(name, env, mode)).map((warning) => ({ ...warning, text: modes.length > 1 && warning.kind === 'contrast' ? `${warning.text} (${t(`cli.themeMode.${mode}`)})` : warning.text })))
        .filter((warning, index, all) => warning.kind !== 'width' || all.findIndex((other) => other.kind === 'width') === index);
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
