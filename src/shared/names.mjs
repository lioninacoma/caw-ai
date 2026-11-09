// Die Namen im Projekt: Config, Ordner der Tests und Aufzeichnungen, Projektkontext, Zugangsdaten, Laufordner.

export const CONFIG_FILE = 'caw.config.json';
export const PROJECT_DIR = 'caw';
export const TEST_DIR = `${PROJECT_DIR}/tests`;
export const RECORDING_DIR = `${PROJECT_DIR}/recordings`;
export const ENV_FILE = `${PROJECT_DIR}/.env`;
/** Projektkontext fuer die Tests, wie CLAUDE.md: Eigenheiten der Anwendungen, relevante Infos. Pflegt der Mensch. */
export const CONTEXT_FILE = `${PROJECT_DIR}/caw.md`;
/** Laufordner: Berichte, Screenshots, Austausch mit der Sandbox. Nicht eingecheckt. */
export const RUN_DIR = '.caw';
/** Das zuletzt in der Werkbank fuer die eigene Claude-Code-Session gewaehlte Element, unter RUN_DIR. */
export const SELECTION_FILE = 'auswahl.json';
