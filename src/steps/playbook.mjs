// Analyse les chaînes d'inspiration (titres + miniatures récents via YouTube Data API)
// puis demande à Claude d'en extraire des patterns réutilisables (le "playbook" de la chaîne).
import { collectReferenceVideos } from '../services/youtubeData.mjs';
import { askClaude, extractJson } from '../services/claude.mjs';

export async function analyzeInspiration(urls = [], { token, perChannel = 15, model = 'sonnet', log = () => {} } = {}) {
  // Accepte des URLs de VIDÉOS et/ou de CHAÎNES.
  const videos = await collectReferenceVideos(urls, perChannel, log);
  if (!videos.length) return { ok: false, error: 'aucune vidéo/chaîne de référence exploitable', playbook: null };

  // Triées par vues : on montre d'abord ce qui marche.
  const top = [...videos].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 40);
  const corpus = 'Vidéos de référence (triées par vues) :\n' + top.map(v => `- (${v.views || 0} vues) ${v.title}`).join('\n');

  const system = [
    "Tu es analyste growth YouTube, expert du COPYWRITING de titres qui déclenchent le clic.",
    "On te donne des titres réels de vidéos de référence (avec nombre de vues).",
    "PRIORITÉ ABSOLUE : décoder les PATTERNS DE TITRES qui fonctionnent, pour pouvoir en produire des nouveaux dans le même esprit.",
    "Sois chirurgical : structure exacte, ressort psychologique, style d'écriture (casse, ponctuation, longueur, point de vue).",
    "Réponds UNIQUEMENT en JSON valide, en français."
  ].join('\n');
  const user = [
    'Vidéos de référence (triées par vues) :', '', corpus, '',
    'Analyse les TITRES en priorité et extrais :',
    '- "title_patterns" : 8-12 formules de titres qui marchent. Pour CHACUNE : la structure/formule ET le ressort émotionnel (ex : "confidence à la 1re personne, phrase en suspens avec … qui laisse le manque ouvert", "aveu vulnérable qui met le spectateur à nu").',
    '- "title_style" : 4-6 règles de STYLE d\'écriture observées (casse ex minuscules, ponctuation ex « … », longueur, 1re/2e personne, langue, ton — brut/poétique).',
    '- "winning_examples" : 3-5 des MEILLEURS titres réels (les plus vus), recopiés tels quels, comme ancrage de ton.',
    '- "emotional_hooks" : 8-12 déclencheurs émotionnels / thèmes récurrents.',
    '- "do" : 4 conseils concrets pour les titres.',
    '- "dont" : 3 pièges à éviter (clichés, descriptions plates).',
    'Format EXACT : {"title_patterns":["..."],"title_style":["..."],"winning_examples":["..."],"emotional_hooks":["..."],"do":["..."],"dont":["..."]}'
  ].join('\n');

  log('décodage des patterns de titres via Claude…');
  const pb = extractJson(await askClaude(system, user, model, { token }));
  const playbook = {
    title_patterns: arr(pb.title_patterns), title_style: arr(pb.title_style), winning_examples: arr(pb.winning_examples),
    emotional_hooks: arr(pb.emotional_hooks), do: arr(pb.do), dont: arr(pb.dont),
    sources: { videos: videos.length }
  };
  return { ok: true, playbook };
}

function arr(x) { return Array.isArray(x) ? x.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()) : []; }
