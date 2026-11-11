// Names in the project: config, test and recording folders, project context, credentials, run folder.

export const CONFIG_FILE = 'caw.config.json';
export const PROJECT_DIR = 'caw';
export const TEST_DIR = `${PROJECT_DIR}/tests`;
export const RECORDING_DIR = `${PROJECT_DIR}/recordings`;
export const ENV_FILE = `${PROJECT_DIR}/.env`;
/** Project context for the tests, like CLAUDE.md: quirks of the applications, relevant notes. Maintained by the human. */
export const CONTEXT_FILE = `${PROJECT_DIR}/caw.md`;
/** Run folder: reports, screenshots, exchange with the sandbox. Not checked in. */
export const RUN_DIR = '.caw';
/** The element last selected in the workbench for the human's own Claude Code session, under RUN_DIR. */
export const SELECTION_FILE = 'auswahl.json';
