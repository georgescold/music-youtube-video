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

export async function generateMetadata({ tracklist, mood = 'romantique', utmUrl, log = () => {} }) {
  const system = [
    "Tu es un expert du SEO YouTube pour les chaînes de playlists de musique d'amour francophones.",
    "Le format qui marche : un TITRE émotionnel à la 2e personne (style « POV : ... » ou scénario intime), en français, avec la balise [Playlist].",
    "Réponds UNIQUEMENT par du JSON valide, sans texte autour."
  ].join('\n');

  const user = [
    `Ambiance de la playlist : ${mood}.`,
    `Voici des exemples de tons de titres appréciés (inspire-toi du style, n'en recopie aucun mot pour mot) :`,
    TITLE_SEEDS.map(s => '- ' + s).join('\n'),
    '',
    'Génère :',
    '- "title" : un titre YouTube accrocheur (60-70 caractères max), en français, incluant [Playlist].',
    '- "hook" : 2-3 phrases d\'accroche émotionnelle pour le début de la description.',
    '- "keywords" : 12 à 18 mots-clés SEO en français (chaînes courtes).',
    '- "hashtags" : 8 hashtags pertinents (sans le #, juste le mot).',
    '- "tags" : 10 tags YouTube (mots ou expressions courtes).',
    '',
    'Format EXACT : {"title":"...","hook":"...","keywords":["..."],"hashtags":["..."],"tags":["..."]}'
  ].join('\n');

  log('génération métadonnées via Claude…');
  const raw = await askClaude(system, user, 'sonnet');
  const meta = extractJson(raw);

  const tracklistText = tracklist.map(l => `${l.stamp} ${l.title}${l.artist ? ' — ' + l.artist : ''}`).join('\n');
  const compaatibleBlock = [
    '——— Rien n\'est un hasard ———',
    'Cette playlist t\'est proposée par Compaatible, l\'app qui trouve les gens vraiment faits pour toi.',
    'Test de compatibilité gratuit 👉 ' + (utmUrl || '')
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
