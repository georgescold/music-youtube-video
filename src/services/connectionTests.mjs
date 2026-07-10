// Tests de connexion par fournisseur. Chacun prend des credentials en paramètre (multi-tenant)
// et renvoie { ok: boolean, detail: string }. Utilisé par la page Paramètres du panneau.
import { getMyChannel } from './youtube.mjs';
import { createEpidemicClient } from './epidemicMcp.mjs';
import { askClaude } from './claude.mjs';

export async function testYouTube(creds) {
  try {
    const ch = await getMyChannel(creds);
    if (!ch) return { ok: false, detail: 'connecté, mais aucune chaîne trouvée pour ce compte' };
    const long = ch.status?.longUploadsStatus;
    const warn = long && long !== 'allowed' ? ` · ⚠ vidéos >15min : ${long} (vérifier la chaîne sur youtube.com/verify)` : '';
    return { ok: true, detail: `chaîne « ${ch.snippet.title} »${warn}` };
  } catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 200) }; }
}

export async function testEpidemic(jwt, url) {
  try {
    const client = createEpidemicClient(jwt, url);
    const r = await client.callTool('SearchRecordings', { query: { term: 'love' }, first: 1 });
    const n = (r?.data?.recordings?.nodes || []).length;
    return { ok: n > 0, detail: n > 0 ? 'catalogue Epidemic accessible' : 'connecté mais aucun résultat renvoyé' };
  } catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 200) }; }
}

export async function testClaude(token) {
  try {
    const out = await askClaude('Réponds exactement le mot: OK', 'ping', 'haiku', { token });
    return { ok: /ok/i.test(out || ''), detail: out ? 'le modèle Claude a répondu' : 'aucune réponse' };
  } catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 200) }; }
}
