// Dérive une palette d'émotions EXHAUSTIVE à partir des exemples de la chaîne :
// chaînes modèles (titres récents) + chansons de référence. Chaque émotion porte sa description
// et des mots-clés musicaux (EN) qui serviront à la curation.
import { resolveChannel, getRecentVideos } from '../services/youtubeData.mjs';
import { askClaude, extractJson } from '../services/claude.mjs';

export async function deriveEmotions({ inspirationUrls = [], references = [], token, log = () => {} } = {}) {
  // 1) Titres des chaînes modèles.
  const channelBlocks = [];
  for (const u of inspirationUrls) {
    try {
      const ch = await resolveChannel(u);
      if (!ch?.id) continue;
      const vids = await getRecentVideos(ch.id, 15);
      if (vids.length) channelBlocks.push(`Chaîne « ${ch.title} » :\n` + vids.map(v => '- ' + v.title).join('\n'));
      log(`modèle : ${ch.title} — ${vids.length} titres`);
    } catch (e) { log('modèle ignoré : ' + e.message); }
  }
  // 2) Chansons de référence.
  const refBlock = references.length
    ? 'Chansons de référence :\n' + references.map(r => `- ${r.title || '?'}${r.artist ? ' — ' + r.artist : ''}${(r.mood_tags || []).length ? ' [' + r.mood_tags.join(', ') + ']' : ''}`).join('\n')
    : '';

  if (!channelBlocks.length && !refBlock) return { ok: false, error: 'aucun exemple exploitable (ajoute des chaînes d\'inspiration et/ou des chansons de référence)', emotions: [] };

  const system = [
    "Tu es analyste émotionnel spécialisé dans la musique d'amour et les playlists YouTube.",
    "À partir d'exemples (titres de chaînes modèles + chansons de référence), tu dresses la liste EXHAUSTIVE des émotions distinctes présentes.",
    "Sois précis et nuancé : distingue les émotions proches (ex : « manque de l'autre » vs « nostalgie d'un amour passé » vs « solitude à deux »).",
    "Vise 20 à 40 émotions, chacune UNIQUE (pas de doublon sémantique).",
    "Réponds UNIQUEMENT en JSON valide, en français pour name/description, en anglais pour keywords."
  ].join('\n');
  const user = [
    'EXEMPLES :', '',
    channelBlocks.join('\n\n'), '', refBlock, '',
    'Dresse la liste EXHAUSTIVE des émotions distinctes que ces exemples incarnent ou visent.',
    'Pour CHAQUE émotion :',
    '- "name" : nom court et évocateur en français (ex : « le manque à 3h du matin », « euphorie des débuts »).',
    '- "description" : 1 phrase précisant la nuance exacte.',
    '- "keywords" : 4 à 6 termes de recherche musicale EN ANGLAIS qui incarnent cette émotion (mood/genre/instrument/tempo).',
    'Format EXACT : {"emotions":[{"name":"...","description":"...","keywords":["..."]}, ...]}'
  ].join('\n');

  log('dérivation de la palette d\'émotions via Claude…');
  const j = extractJson(await askClaude(system, user, 'sonnet', { token }));
  const emotions = (Array.isArray(j.emotions) ? j.emotions : [])
    .map(e => ({
      name: String(e.name || '').trim(),
      description: String(e.description || '').trim(),
      keywords: Array.isArray(e.keywords) ? e.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()).slice(0, 6) : []
    }))
    .filter(e => e.name);
  if (!emotions.length) return { ok: false, error: 'aucune émotion extraite', emotions: [] };
  return { ok: true, emotions };
}
