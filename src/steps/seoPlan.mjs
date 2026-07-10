// Génère un PLAN SEO durable par chaîne : piliers de contenu, clusters de mots-clés,
// grand vivier de hashtags (pour la rotation), conventions de titres, idées de CTA.
// Nourri par le contexte de la chaîne + les titres réels des chaînes modèles.
// (La recherche web live n'est pas exécutée côté serveur ; on s'appuie sur la connaissance SEO de Claude
//  + les données réelles de la niche via les chaînes modèles.)
import { collectReferenceVideos } from '../services/youtubeData.mjs';
import { askClaude, extractJson } from '../services/claude.mjs';

export async function generateSeoPlan({ objective = '', productDesc = '', inspirationUrls = [], references = [], token, log = () => {} } = {}) {
  // Vidéos de référence (URLs de vidéos et/ou de chaînes), triées par vues.
  const vids = await collectReferenceVideos(inspirationUrls, 15, log);
  const top = [...vids].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 30);
  const modelTitles = top.length ? ['Titres de vidéos de référence (ce qui marche dans la niche) : ' + top.map(v => v.title).join(' | ')] : [];
  const refBlock = references.length ? 'Chansons de référence : ' + references.map(r => r.title).filter(Boolean).join(', ') : '';

  const system = [
    "Tu es consultant SEO YouTube senior (viralité + conversion). Tu appliques les meilleures pratiques 2026 :",
    "- mot-clé principal dans la 1re phrase de la description (dans les 40 premiers caractères) ;",
    "- 3 à 5 hashtags TRÈS pertinents par vidéo (au-delà = spam), donc il faut un GRAND vivier pour varier ;",
    "- chapitres à timestamps descriptifs, playlists thématiques, maillage interne entre vidéos ;",
    "- titres qui déclenchent le clic (curiosité, émotion, bénéfice clair) sans clickbait mensonger.",
    "Tu conçois un PLAN SEO durable et RÉUTILISABLE pour UNE chaîne, calé sur SON domaine et SA langue.",
    "Réponds UNIQUEMENT en JSON valide."
  ].join('\n');
  const user = [
    'CONTEXTE DE LA CHAÎNE :',
    objective ? '- Objectif : ' + objective : '- Objectif : (non précisé) chaîne de playlists de musique d\'amour francophone.',
    productDesc ? '- Produit promu : ' + productDesc : '',
    '',
    modelTitles.length ? 'TITRES RÉELS DES CHAÎNES MODÈLES (ce qui marche dans la niche) :\n' + modelTitles.join('\n') : '',
    refBlock, '',
    'Produis un plan SEO :',
    '- "niche_summary" : 2 phrases situant précisément la niche et l\'audience.',
    '- "pillars" : 4 à 6 piliers de contenu (thèmes récurrents structurants).',
    '- "primary_keywords" : 6 à 10 mots-clés principaux (têtes de recherche du domaine).',
    '- "secondary_keywords" : 15 à 25 mots-clés longue traîne.',
    '- "hashtag_pool" : 35 à 50 hashtags pertinents (sans #), variés, pour tourner d\'une vidéo à l\'autre.',
    '- "core_hashtags" : 2 à 3 hashtags identitaires à garder quasi systématiquement.',
    '- "title_conventions" : 5 règles concrètes pour écrire les titres de cette chaîne.',
    '- "cta_ideas" : 4 idées d\'appel à l\'action orientées conversion (vers le produit).',
    '- "internal_linking" : 2 phrases sur la stratégie de maillage interne (playlists + liens entre vidéos).',
    'Tout dans la LANGUE de la chaîne.',
    'Format EXACT : {"niche_summary":"...","pillars":["..."],"primary_keywords":["..."],"secondary_keywords":["..."],"hashtag_pool":["..."],"core_hashtags":["..."],"title_conventions":["..."],"cta_ideas":["..."],"internal_linking":"..."}'
  ].filter(Boolean).join('\n');

  log('conception du plan SEO via Claude…');
  const j = extractJson(await askClaude(system, user, 'sonnet', { token }));
  const arr = x => Array.isArray(x) ? x.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().replace(/^#/, '')) : [];
  const plan = {
    niche_summary: String(j.niche_summary || '').trim(),
    pillars: arr(j.pillars),
    primary_keywords: arr(j.primary_keywords),
    secondary_keywords: arr(j.secondary_keywords),
    hashtag_pool: [...new Set(arr(j.hashtag_pool))],
    core_hashtags: [...new Set(arr(j.core_hashtags))],
    title_conventions: arr(j.title_conventions),
    cta_ideas: arr(j.cta_ideas),
    internal_linking: String(j.internal_linking || '').trim()
  };
  if (!plan.hashtag_pool.length && !plan.primary_keywords.length) return { ok: false, error: 'plan vide', plan: null };
  return { ok: true, plan };
}
