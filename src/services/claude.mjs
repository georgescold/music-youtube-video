// Appel du CLI `claude` (FORFAIT, jamais de cle API). Auth : CLAUDE_CODE_OAUTH_TOKEN.
// Adapte de georgescold/reddit-warmup (meme contournement Windows pour les shims .cmd).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MODEL_IDS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001'
};
export function resolveModel(m) {
  const key = String(m || '').trim().toLowerCase();
  if (!key) return MODEL_IDS.sonnet;
  if (MODEL_IDS[key]) return MODEL_IDS[key];
  return key;
}

export function askClaude(system, user, model, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return reject(new Error('CLAUDE_CODE_OAUTH_TOKEN manquant. Lance `claude setup-token`.'));
    }
    const bin = resolveClaude();
    const args = ['-p', '--strict-mcp-config', '--no-session-persistence', '--tools', ''];
    args.push('--system-prompt', system);
    const resolved = resolveModel(model);
    if (resolved) args.push('--model', resolved);
    if (opts.effort) args.push('--effort', opts.effort);

    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN') delete env[k];
    delete env.CLAUDECODE;

    let child;
    try { child = spawnClaude(bin, args, env); }
    catch (e) { return reject(new Error('Lancement de claude impossible : ' + e.message)); }

    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => reject(new Error('Lancement de claude impossible : ' + e.message)));
    child.on('close', code => {
      if (code === 0 && out.trim()) return resolve(out.trim());
      reject(new Error((err.trim() || out.trim() || ('claude exit ' + code)).slice(0, 400)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(user);
  });
}

function spawnClaude(bin, args, env) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const js = join(dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(js)) return spawn(process.execPath, [js, ...args], { env, windowsHide: true });
    return spawn(bin, args, { env, windowsHide: true, shell: true });
  }
  return spawn(bin, args, { env, windowsHide: true });
}

export function resolveClaude() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const win = process.platform === 'win32';
  const exts = win ? ['.exe', '.cmd', ''] : [''];
  const dirs = (process.env.PATH || '').split(win ? ';' : ':').filter(Boolean);
  if (process.env.HOME) dirs.push(join(process.env.HOME, '.local', 'bin'));
  if (win && process.env.USERPROFILE) dirs.push(join(process.env.USERPROFILE, '.local', 'bin'));
  for (const d of dirs) for (const e of exts) { const p = join(d, 'claude' + e); try { if (existsSync(p)) return p; } catch {} }
  return win ? 'claude.exe' : 'claude';
}

// Extrait un objet JSON d'une reponse Claude (tolere le texte autour / les blocs ```).
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('pas de JSON dans la reponse Claude');
  return JSON.parse(candidate.slice(start, end + 1));
}
