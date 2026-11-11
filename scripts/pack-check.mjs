// Prueft, was `npm pack` ausliefern wuerde: nur Laufzeitdateien, keine Geheimnisse, keine Tests oder Fixtures, und keine
// Begriffe eines einzelnen Projekts. Exit 1 mit Liste, sonst Exit 0.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [{ files }] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }));
const paths = files.map(({ path }) => path.replaceAll('\\', '/'));

const ALLOWED = /^(bin|src|templates|assets|themes)\/|^(package\.json|README(\.de)?\.md|NOTICE\.md|LICENSE|CHANGELOG\.md)$/;
const FORBIDDEN_NAME = /(^|\/)\.env(\.|$)(?!.*example)|\.pem$|\.key$|(^|\/)\.caw\/|(^|\/)caw\/\.auth\/|\.tgz$|(^|\/)(test|e2e|scripts)\//;
// Optional: Woerter eines eigenen Projekts, die nicht ins Paket duerfen, kommagetrennt in CAW_PACK_TERMS.
const terms = (process.env.CAW_PACK_TERMS ?? '').split(',').map((term) => term.trim()).filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const PROJECT_TERMS = terms.length > 0 ? new RegExp(`\\b(${terms.join('|')})\\b`, 'i') : /(?!)/;

const problems = [];
for (const path of paths) {
    if (!ALLOWED.test(path)) problems.push(`${path}: gehört nicht ins Paket`);
    if (FORBIDDEN_NAME.test(path)) problems.push(`${path}: Geheimnis, Test oder Laufdaten`);
    if (/\.(mjs|js|json|md|yaml|tpl|sh|txt|example)$/.test(path) || path.endsWith('env.example')) {
        const text = readFileSync(join(root, path), 'utf8');
        const hit = PROJECT_TERMS.exec(text);
        if (hit !== null) problems.push(`${path}: projektspezifischer Begriff „${hit[0]}“`);
        if (/CLAUDE_CODE_OAUTH_TOKEN\s*=\s*\S{8,}|sk-ant-[\w-]{8,}/.test(text)) problems.push(`${path}: sieht nach einem Token aus`);
    }
}
const TEMPLATES = ['caw.config.example.json', 'Dockerfile.tpl', 'entrypoint.sh', 'init-firewall.sh', 'skill.md'].map((name) => `templates/${name}`);
for (const needed of ['bin/caw-ai.mjs', ...TEMPLATES, 'package.json', 'README.md', 'NOTICE.md', 'LICENSE', 'CHANGELOG.md']) {
    if (!paths.includes(needed)) problems.push(`${needed} fehlt im Paket`);
}
if (problems.length > 0) {
    console.error(`Paketinhalt (${paths.length} Dateien) hat ${problems.length} Problem(e):\n- ${problems.join('\n- ')}`);
    process.exit(1);
}
console.log(`Paketinhalt geprüft: ${paths.length} Dateien, keine Geheimnisse, keine Tests, keine Projektbegriffe.`);
