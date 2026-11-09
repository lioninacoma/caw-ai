// Laufende Prozesse als Befehlszeilen, ohne Wissen ueber Framework oder Build. Wofuer ein Muster steht, sagt der Framework-Adapter.

import { execFileSync } from 'node:child_process';

const LIST_TIMEOUT_MS = 15_000;

/** Die Befehlszeilen aller Prozesse des Rechners, oder null, wenn sich das nicht ermitteln laesst. */
export const commandLines = (platform = process.platform, exec = execFileSync) => {
    try {
        const output = platform === 'win32'
            ? exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, windowsHide: true })
            : exec('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS });
        return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
        return null;
    }
};

/** true: ein Prozess passt zum Muster, false: keiner, null: unbekannt. */
export const processRunning = (pattern, lines = commandLines()) => (lines === null ? null : lines.some((line) => pattern.test(line)));
