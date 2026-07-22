// Déduction d'émotion via le CLI Claude (forfait, vision par l'outil Read). Multi-tenant : opts.token.
// Trois entrées possibles : une image, un titre imposé, ou les deux (le « combo » image ↔ titre ↔ musique).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveClaude, resolveModel, extractJson } from './claude.mjs';

// Contrat de sortie commun : c'est cet objet qui pilote ensuite la curation musicale.
const JSON_SPEC = `Réponds UNIQUEMENT en JSON valide :
{"emotion":"...","situation":"...","mots_cles_musique":["...","..."]}
- "emotion" : en français, l'émotion/le sentiment profond ressenti (ex : « le manque après une rupture », « l'espoir de se retrouver un jour », « la tendresse des débuts »). PAS une description visuelle.
- "situation" : en français, en 1 phrase, le moment de vie / la situation émotionnelle que ça évoque pour le spectateur.
- "mots_cles_musique" : 4 à 6 termes d'ambiance musicale EN ANGLAIS qui incarnent cette émotion (pour orienter une recherche de musique).`;

// Lance le CLI Claude et renvoie le JSON extrait. `allowRead` n'est nécessaire que pour lire une image.
function runClaudeJson(prompt, { token, model = 'sonnet', allowRead = false } = {}) {
  return new Promise((resolve, reject) => {
    const tok = token || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!tok) return reject(new Error('CLAUDE_CODE_OAUTH_TOKEN manquant'));
    const bin = resolveClaude();
    const args = ['-p', '--strict-mcp-config', '--no-session-persistence'];
    if (allowRead) args.push('--allowedTools', 'Read');
    args.push('--model', resolveModel(model));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN') delete env[k];
    env.CLAUDE_CODE_OAUTH_TOKEN = tok; delete env.CLAUDECODE;

    let child;
    try {
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
        const js = join(dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        child = existsSync(js) ? spawn(process.execPath, [js, ...args], { env, windowsHide: true }) : spawn(bin, args, { env, windowsHide: true, shell: true });
      } else child = spawn(bin, args, { env, windowsHide: true });
    } catch (e) { return reject(e); }

    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => reject(e));
    child.on('close', code => {
      if (code !== 0 || !out.trim()) return reject(new Error((err.trim() || out.trim() || ('claude exit ' + code)).slice(0, 300)));
      try { resolve(extractJson(out)); } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// Émotion déduite d'une image. `titleHint` (titre imposé par l'utilisateur) prime sur le ressenti visuel :
// c'est son intention explicite, l'image ne fait que la préciser.
export function analyzeImage(imgPath, { token, model = 'sonnet', titleHint = '' } = {}) {
  const title = String(titleHint || '').trim();
  const prompt = title
    ? `Lis l'image située ici : ${imgPath}\nL'utilisateur a IMPOSÉ ce titre pour la vidéo : « ${title} »\nCe titre exprime son intention : il PRIME. L'image sert à préciser la nuance du ressenti, pas à le contredire.\nNe DÉCRIS PAS la scène. Déduis l'émotion humaine profonde que porte ce titre, éclairée par l'image.\n${JSON_SPEC}`
    : `Lis l'image située ici : ${imgPath}\nNe DÉCRIS PAS la scène. Ressens-la : quelle ÉMOTION humaine profonde, quel moment de vie intime évoque-t-elle chez quelqu'un qui la regarde ?\n${JSON_SPEC}`;
  return runClaudeJson(prompt, { token, model, allowRead: true });
}

// Émotion déduite d'un titre seul (aucune image exploitable). Pas d'outil Read nécessaire.
export function analyzeTitle(title, { token, model = 'sonnet' } = {}) {
  const t = String(title || '').trim();
  const prompt = `L'utilisateur a IMPOSÉ ce titre pour une vidéo de playlist musicale : « ${t} »\nNe paraphrase pas le titre. Déduis l'ÉMOTION humaine profonde, le moment de vie intime qu'il évoque chez quelqu'un qui le lit.\n${JSON_SPEC}`;
  return runClaudeJson(prompt, { token, model, allowRead: false });
}
