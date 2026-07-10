// Generation titre + description via Claude CLI. La tracklist et le bloc Compaatible
// sont assembles en code (timestamps exacts, lien UTM controle) ; Claude fournit le creatif.
import { askClaude, extractJson } from '../services/claude.mjs';

const TITLE_SEEDS = [
  "POV : tu ne croyais plus en l'amour jusqu'à ce soir",
  "Il est 3h du matin et tu y repenses encore",
  "Cette playlist te redonnera foi en l'amour",
  "Les chansons qu'on écoute quand on pense à quelqu'un",
  "Une playlist secrète pour échapper à la réalité",
  "Écoute ça quand tout va bien et que tu es amoureux"
];

// Normalise un titre pour comparer (minuscules, sans ponctuation ni espaces multiples).
function normTitle(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function generateMetadata({ tracklist, mood = 'romantique', utmUrl, avoidTitles = [], strategy = {}, emotion = null, log = () => {} }) {
  const pb = strategy.playbook || {};
  const system = [
    "Tu es un expert du SEO YouTube pour les chaînes de playlists de musique d'amour francophones.",
    "Le format qui marche : un TITRE émotionnel à la 2e personne (style « POV : ... » ou scénario intime), en français, avec la balise [Playlist].",
    "Le titre doit être le plus deep et émotionnel possible, et TOUJOURS différent des titres déjà publiés.",
    emotion ? `ÉMOTION IMPOSÉE de cette vidéo : « ${emotion.name} » (${emotion.description}). Le titre DOIT capturer PRÉCISÉMENT cette émotion, pas une autre.` : '',
    strategy.objective ? `Objectif de la chaîne : ${strategy.objective}` : '',
    strategy.product_desc ? `Produit à mettre en valeur (pour orienter le champ lexical, sans le citer dans le titre) : ${strategy.product_desc}` : '',
    "Réponds UNIQUEMENT par du JSON valide, sans texte autour."
  ].filter(Boolean).join('\n');

  const avoidSet = new Set(avoidTitles.map(normTitle));
  const buildUser = (extraAvoid = []) => [
    `Ambiance de la playlist : ${mood}.`,
    `Voici des exemples de tons de titres appréciés (inspire-toi du style, n'en recopie aucun mot pour mot) :`,
    TITLE_SEEDS.map(s => '- ' + s).join('\n'),
    pb.title_patterns?.length ? '\nFormules de titres qui marchent sur les chaînes d\'inspiration (applique l\'esprit, pas le copier-coller) :\n' + pb.title_patterns.slice(0, 10).map(s => '- ' + s).join('\n') : '',
    pb.emotional_hooks?.length ? 'Déclencheurs émotionnels à exploiter : ' + pb.emotional_hooks.slice(0, 12).join(', ') : '',
    (avoidTitles.length || extraAvoid.length) ? '\nNe RÉUTILISE JAMAIS aucun de ces titres déjà publiés (ni une variante quasi identique) :' : '',
    [...avoidTitles, ...extraAvoid].slice(-40).map(s => '- ' + s).join('\n'),
    '',
    'Génère :',
    '- "title" : un titre YouTube accrocheur (60-70 caractères max), en français, incluant [Playlist].',
    '- "hook" : 2-3 phrases d\'accroche émotionnelle pour le début de la description.',
    '- "keywords" : 12 à 18 mots-clés SEO en français (chaînes courtes).',
    '- "hashtags" : 8 hashtags pertinents (sans le #, juste le mot).',
    '- "tags" : 10 tags YouTube (mots ou expressions courtes).',
    '',
    'Format EXACT : {"title":"...","hook":"...","keywords":["..."],"hashtags":["..."],"tags":["..."]}'
  ].filter(Boolean).join('\n');

  log('génération métadonnées via Claude…');
  let meta = extractJson(await askClaude(system, buildUser(), 'sonnet'));
  // Anti-doublon : si le titre existe déjà, on régénère (jusqu'à 3 fois) en le mettant explicitement à éviter.
  const extraAvoid = [];
  for (let attempt = 0; attempt < 3 && avoidSet.has(normTitle(meta.title)); attempt++) {
    log(`titre déjà utilisé ("${meta.title}") — nouvelle génération…`);
    extraAvoid.push(meta.title);
    meta = extractJson(await askClaude(system, buildUser(extraAvoid), 'sonnet'));
  }

  const tracklistText = tracklist.map(l => `${l.stamp} ${l.title}${l.artist ? ' — ' + l.artist : ''}`).join('\n');
  // Lien mis en avant : lien d'affiliation de la chaîne si fourni, sinon le lien Compaatible (UTM).
  const ctaUrl = strategy.affiliate_url || utmUrl || '';
  const ctaLabel = strategy.affiliate_label || 'Test de compatibilité gratuit';
  const productLine = strategy.product_desc || 'Cette playlist t\'est proposée par Compaatible, l\'app qui trouve les gens vraiment faits pour toi.';
  const compaatibleBlock = [
    '━━━━━━━━━━━━━━━━━━',
    '💞 ' + productLine,
    '👉 ' + ctaLabel + ' : ' + ctaUrl,
    '━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  const description = [
    meta.hook,
    '',
    compaatibleBlock,
    '',
    'Tracklist :',
    tracklistText,
    '',
    'Mots-clés : ' + (meta.keywords || []).join(', '),
    '',
    (meta.hashtags || []).map(h => '#' + String(h).replace(/^#/, '')).join(' '),
    '',
    '🎵 Musique sous licence Epidemic Sound. Chaîne : @AuBonMomentMusic'
  ].join('\n');

  return {
    title: String(meta.title || 'Playlist musique d\'amour [Playlist]').slice(0, 100),
    description: description.slice(0, 4900),
    tags: (meta.tags || []).slice(0, 15)
  };
}
