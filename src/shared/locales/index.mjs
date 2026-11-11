// All catalogues, each language assembled from areas. Each area has its own files; keys carry the area as prefix.
import de_cli from './de/cli.mjs';
import de_config from './de/config.mjs';
import de_session from './de/session.mjs';
import de_run from './de/run.mjs';
import de_chat from './de/chat.mjs';
import de_workbench from './de/workbench.mjs';
import en_cli from './en/cli.mjs';
import en_config from './en/config.mjs';
import en_session from './en/session.mjs';
import en_run from './en/run.mjs';
import en_chat from './en/chat.mjs';
import en_workbench from './en/workbench.mjs';

export const CATALOGS = {
    de: { ...de_cli, ...de_config, ...de_session, ...de_run, ...de_chat, ...de_workbench },
    en: { ...en_cli, ...en_config, ...en_session, ...en_run, ...en_chat, ...en_workbench },
};
