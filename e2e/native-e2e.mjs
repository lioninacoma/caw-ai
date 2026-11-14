// The e2e in real Chrome, one scenario after another. The scripts stand in for Claude in the sandbox and for the human at the
// chat; Claude never runs.
//   node e2e/native-e2e.mjs [ids]      e.g. "N1", "A,B,N6", "N*"; without ids every scenario
// Usually started through the watchdog, which aborts a hanging run: pwsh e2e/watchdog.ps1 N1 e2e.log
// Scenarios: scenarios/infra.mjs (INF…, the harness: Docker stacks, ports, packed package, MCP), scenarios/core.mjs (B…, the
// packed package in an empty project), scenarios/native.mjs (N…, the native fixture site e2e/native), scenarios/portal.mjs (letters and digits, the fake
// portal e2e/portal.mjs), scenarios/matrix.mjs (N14, the framework matrix e2e/frameworks).
import { print, runScenarios, tally } from './harness.mjs';
import { scenarios as core } from './scenarios/core.mjs';
import { scenarios as environments } from './scenarios/environments.mjs';
import { scenarios as infra } from './scenarios/infra.mjs';
import { scenarios as matrix } from './scenarios/matrix.mjs';
import { scenarios as native } from './scenarios/native.mjs';
import { scenarios as portal } from './scenarios/portal.mjs';

// The whole suite takes about an hour; a single scenario far less. The watchdog aborts earlier when the log stays silent.
const LIMIT_MS = 3 * 60 * 60 * 1000;
setTimeout(() => {
    print('FAIL watchdog: time limit');
    process.exit(9);
}, LIMIT_MS).unref();

await runScenarios([...infra, ...core, ...environments, ...native, ...portal, ...matrix], process.argv.slice(2).join(','));
print(`RESULT OK=${tally.ok} FAIL=${tally.fail} SKIP=${tally.skip}`);
process.exit(tally.fail > 0 ? 1 : 0);
