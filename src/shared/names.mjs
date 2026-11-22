// Names in the project: config, test and recording folders, project context, credentials, run folder.

export const CONFIG_FILE = 'caw.config.json';
export const PROJECT_DIR = 'caw';
export const TEST_DIR = `${PROJECT_DIR}/tests`;
export const RECORDING_DIR = `${PROJECT_DIR}/recordings`;
/**
 * Drafts from caw reproduce: plan and recording in one file, outside `run --all`, until `run <draft> --promote` moves the
 * proven test to caw/tests.
 */
export const DRAFT_DIR = `${PROJECT_DIR}/drafts`;
export const ENV_FILE = `${PROJECT_DIR}/.env`;
/** Project context for the tests, like CLAUDE.md: quirks of the applications, relevant notes. Maintained by the human. */
export const CONTEXT_FILE = `${PROJECT_DIR}/caw.md`;
/** Run folder: reports, screenshots, exchange with the sandbox. Not checked in. */
export const RUN_DIR = '.caw';
/** The element last selected in the workbench for the human's own Claude Code session, under RUN_DIR. */
export const SELECTION_FILE = 'selection.json';
/** The field paths of learned JSON response forms by their hash, under RUN_DIR: the recording keeps only the hash (effects.mjs). */
export const FORMS_FILE = 'response-forms.json';
/**
 * Effects and looks still being learned, per test as `<test>.json`, under RUN_DIR: the recording only gets them once they are
 * frozen (learning.mjs).
 */
export const LEARNING_DIR = 'learning';
/**
 * A reproduction's --ref: an id from another tool (a ticket), kept opaque and never resolved by caw. Narrow characters so it
 * is safe in a file, a table cell and a command line.
 */
export const REF_PATTERN = /^[\w.#:/-]{1,64}$/;
