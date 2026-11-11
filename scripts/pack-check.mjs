// Checks what `npm pack` would ship: runtime files only, no secrets, no tests or fixtures, and no terms of a single project.
// Exits 1 with a list of problems, otherwise 0.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [{ files }] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }));
const paths = files.map(({ path }) => path.replaceAll('\\', '/'));

const ALLOWED = /^(bin|src|templates|assets|themes)\/|^(package\.json|README(\.de)?\.md|NOTICE\.md|LICENSE|CHANGELOG\.md)$/;
const FORBIDDEN_NAME = /(^|\/)\.env(\.|$)(?!.*example)|\.pem$|\.key$|(^|\/)\.caw\/|(^|\/)caw\/\.auth\/|\.tgz$|(^|\/)(test|e2e|scripts)\//;
// Optional: words of your own project that must not end up in the package, comma-separated in CAW_PACK_TERMS.
const terms = (process.env.CAW_PACK_TERMS ?? '').split(',').map((term) => term.trim()).filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const PROJECT_TERMS = terms.length > 0 ? new RegExp(`\\b(${terms.join('|')})\\b`, 'i') : /(?!)/;

const problems = [];
for (const path of paths) {
    if (!ALLOWED.test(path)) problems.push(`${path}: does not belong in the package`);
    if (FORBIDDEN_NAME.test(path)) problems.push(`${path}: secret, test or run data`);
    if (/\.(mjs|js|json|md|yaml|tpl|sh|txt|example)$/.test(path) || path.endsWith('env.example')) {
        const text = readFileSync(join(root, path), 'utf8');
        const hit = PROJECT_TERMS.exec(text);
        if (hit !== null) problems.push(`${path}: project-specific term "${hit[0]}"`);
        if (/(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)\s*=\s*\S{8,}|sk-ant-[\w-]{8,}/.test(text)) problems.push(`${path}: looks like a token`);
    }
}
const TEMPLATES = ['caw.config.example.json', 'Dockerfile.tpl', 'entrypoint.sh', 'init-firewall.sh', 'skill.md'].map((name) => `templates/${name}`);
for (const needed of ['bin/caw-ai.mjs', ...TEMPLATES, 'package.json', 'README.md', 'NOTICE.md', 'LICENSE', 'CHANGELOG.md']) {
    if (!paths.includes(needed)) problems.push(`${needed} is missing from the package`);
}
if (problems.length > 0) {
    console.error(`Package contents (${paths.length} files) have ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
}
console.log(`Package contents checked: ${paths.length} files, no secrets, no tests, no project terms.`);
