// Analyse les chaînes d'inspiration (titres + miniatures récents via YouTube Data API)
// puis demande à Claude d'en extraire des patterns réutilisables (le "playbook" de la chaîne).
import { resolveChannel, getRecentVideos } from '../services/youtubeData.mjs';
import { askClaude, extractJson } from '../services/claude.mjs';

export async function analyzeInspiration(urls = [], { token, perChannel = 15, log = () => {} } = {}) {
  const channels = [];
  const errors = [];
  for (const u of urls) {
    try {
      const ch = await resolveChannel(u);
      if (!ch?.id) { errors.push(`${u} : chaîne introuvable`); continue; }
      const vids = await getRecentVideos(ch.id, perChannel);
      channels.push({ input: u, title: ch.title, videos: vids });
      log(`inspiration : ${ch.title} — ${vids.length} vidéos`);
    } catch (e) { errors.push(`${u} : ${e.message}`); }
  }
  if (!channels.length) return { ok: false, error: errors.join(' · ') || 'aucune chaîne exploitable', playbook: null };

  // On trie les vidéos par vues pour montrer d'abord ce qui marche.
  const corpus = channels.map(c => {
    const top = [...c.videos].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 12);
    return `Chaîne « ${c.title} » :\n` + top.map(v => `- (${v.views || 0} vues) ${v.title}`).join('\n');
  }).join('\n\n');

  const system = [
    "Tu es analyste SEO/growth pour des chaînes YouTube de playlists musicales.",
    "On te donne les titres réels (avec nombre de vues) de chaînes d'inspiration.",
    "Tu en extrais des PATTERNS actionnables pour écrire de futurs titres/miniatures performants.",
    "Réponds UNIQUEMENT en JSON valide, en français."
  ].join('\n');
  const user = [
    'Voici les vidéos récentes des chaînes d\'inspiration (triées par vues) :',
    '', corpus, '',
    'Extrais :',
    '- "title_patterns" : 6-10 formules de titres qui reviennent / marchent (décris la structure, ex : "POV + scénario intime", "chiffre + promesse émotionnelle").',
    '- "emotional_hooks" : 8-12 déclencheurs émotionnels / mots-clés récurrents.',
    '- "thumbnail_patterns" : 4-6 observations sur les miniatures probables (ambiance, texte, visages, couleurs) déduites des titres/codes du genre.',
    '- "do" : 5 conseils concrets à appliquer.',
    '- "dont" : 4 pièges à éviter (clichés, sur-utilisation).',
    'Format EXACT : {"title_patterns":["..."],"emotional_hooks":["..."],"thumbnail_patterns":["..."],"do":["..."],"dont":["..."]}'
  ].join('\n');

  log('synthèse des patterns via Claude…');
  const pb = extractJson(await askClaude(system, user, 'sonnet', { token }));
  const playbook = {
    title_patterns: arr(pb.title_patterns), emotional_hooks: arr(pb.emotional_hooks),
    thumbnail_patterns: arr(pb.thumbnail_patterns), do: arr(pb.do), dont: arr(pb.dont),
    sources: channels.map(c => ({ title: c.title, videos: c.videos.length }))
  };
  return { ok: true, playbook, errors };
}

function arr(x) { return Array.isArray(x) ? x.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()) : []; }
