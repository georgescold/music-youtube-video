import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { resolveClaude } from '../src/services/claude.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const bank = 'C:/Users/loysc/Desktop/Au Bon Moment - Youtube/Images banque';
const file = readdirSync(bank).find(f => /\.(jpg|png)$/i.test(f));
const imgPath = bank + '/' + file;
console.log('image testée :', file);

const prompt = `Lis l'image située ici : ${imgPath}\nAnalyse-la et réponds UNIQUEMENT en JSON valide : {"style":"...","scene":"...","emotion":"...","couleurs":"..."} — en français, précis.`;

const bin = resolveClaude();
const args = ['-p', '--strict-mcp-config', '--no-session-persistence', '--allowedTools', 'Read', '--model', 'claude-sonnet-5'];
const cenv = { ...process.env };
for (const k of Object.keys(cenv)) if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN') delete cenv[k];
delete cenv.CLAUDECODE;

function spawnClaude() {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const js = join(dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(js)) return spawn(process.execPath, [js, ...args], { env: cenv, windowsHide: true });
    return spawn(bin, args, { env: cenv, windowsHide: true, shell: true });
  }
  return spawn(bin, args, { env: cenv, windowsHide: true });
}

const child = spawnClaude();
let out = '', err = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => err += d);
child.on('close', code => {
  console.log('--- exit', code, '---');
  console.log('STDOUT:', out.trim().slice(0, 1500));
  if (err.trim()) console.log('STDERR:', err.trim().slice(0, 500));
});
child.stdin.on('error', () => {});
child.stdin.end(prompt);
