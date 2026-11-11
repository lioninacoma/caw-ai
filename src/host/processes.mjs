// Running processes and their listening ports, with no knowledge of framework or build. What a pattern stands for is up to the
// framework adapter. Only used to find a local code server that runs on another port than configured, never to decide readiness.

import { execFileSync } from 'node:child_process';

const LIST_TIMEOUT_MS = 15_000;

const powershell = (exec, command) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, windowsHide: true });

/** All processes on the machine as { pid, command }, or null if they cannot be determined. */
export const processList = (platform = process.platform, exec = execFileSync) => {
    try {
        const output = platform === 'win32'
            ? powershell(exec, 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }')
            : exec('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS });
        return output.split(/\r?\n/).map((line) => /^\s*(\d+)\s+(.*?)\s*$/.exec(line)).filter((match) => match !== null && match[2] !== '')
            .map((match) => ({ pid: Number(match[1]), command: match[2] }));
    } catch {
        return null;
    }
};

/** The ids of the processes whose command line matches the pattern; empty if unknown. */
export const matchingPids = (pattern, list = processList()) => (list ?? []).filter(({ command }) => pattern.test(command)).map(({ pid }) => pid);

const portOf = (address) => {
    const match = /:(\d+)$/.exec(address ?? '');
    return match === null ? null : Number(match[1]);
};

/**
 * Listening TCP sockets from the output of one of the tools, as [{ pid, port }]:
 * - windows: Get-NetTCPConnection -State Listen as "<OwningProcess> <LocalPort>" per line
 * - ss:      ss -ltnpH, e.g. LISTEN 0 50 *:1841 *:* users:(("java",pid=4321,fd=45))
 * - lsof:    lsof -nP -iTCP -sTCP:LISTEN -Fpn, fields p<pid> and n<address:port>
 */
export const parseListening = (output, format) => {
    const found = [];
    const lines = String(output ?? '').split(/\r?\n/);
    if (format === 'windows') {
        for (const line of lines) {
            const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
            if (match !== null) found.push({ pid: Number(match[1]), port: Number(match[2]) });
        }
    } else if (format === 'ss') {
        for (const line of lines) {
            const fields = line.trim().split(/\s+/);
            const port = fields[0] === 'LISTEN' ? portOf(fields[3]) : null;
            if (port === null) continue;
            for (const match of line.matchAll(/pid=(\d+)/g)) found.push({ pid: Number(match[1]), port });
        }
    } else if (format === 'lsof') {
        let pid = null;
        for (const line of lines) {
            if (line.startsWith('p')) pid = Number(line.slice(1));
            const port = line.startsWith('n') && pid !== null ? portOf(line.slice(1)) : null;
            if (port !== null) found.push({ pid, port });
        }
    }
    return found;
};

const listening = (platform, exec) => {
    if (platform === 'win32') {
        return parseListening(powershell(exec, 'Get-NetTCPConnection -State Listen | ForEach-Object { "$($_.OwningProcess) $($_.LocalPort)" }'), 'windows');
    }
    try {
        return parseListening(exec('ss', ['-ltnpH'], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS }), 'ss');
    } catch {
        return parseListening(exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS }), 'lsof');
    }
};

/** The TCP ports the processes listen on, sorted; empty if they cannot be determined. */
export const listeningPorts = (pids, { platform = process.platform, exec = execFileSync } = {}) => {
    const wanted = new Set(pids.map(Number));
    if (wanted.size === 0) return [];
    try {
        return [...new Set(listening(platform, exec).filter(({ pid }) => wanted.has(pid)).map(({ port }) => port))].sort((a, b) => a - b);
    } catch {
        return [];
    }
};
