// Running processes as command lines, with no knowledge of framework or build. What a pattern stands for is up to the framework adapter.

import { execFileSync } from 'node:child_process';

const LIST_TIMEOUT_MS = 15_000;

/** The command lines of all processes on the machine, or null if they cannot be determined. */
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

/** true: a process matches the pattern, false: none, null: unknown. */
export const processRunning = (pattern, lines = commandLines()) => (lines === null ? null : lines.some((line) => pattern.test(line)));
