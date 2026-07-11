// Generation titre + description via Claude CLI. La tracklist et le bloc Compaatible
// sont assembles en code (timestamps exacts, lien UTM controle) ; Claude fournit le creatif.
import { askClaude, extractJson } from '../services/claude.mjs';

// Exemples de TON (émotion brute, 1re personne, déclencheur) — jamais à recopier.
const TITLE_SEEDS = [
  "si tu me voyais pleurer dans ma chambre",
  "nous nous retrouverons un jour…",
  "nos chemins se séparent mais je sais qu'on se retrouvera",
  "je t'aime encore, même si je ne devrais plus",
  "il est 3h du matin et tu me manques toujours",
  "personne ne saura à quel point je t'ai aimé"
];

// Retire la balise [Playlist] d'un titre (pour les liens internes lisibles).
function stripTag(t) { return String(t || '').replace(/\[\s*playlist\s*\]/ig, '').replace(/\s{2,}/g, ' ').trim(); }

// Normalise un titre pour comparer (minuscules, sans ponctuation ni espaces multiples).
function normTitle(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Choisit 3-5 hashtags variés : les hashtags identitaires + un tirage du vivier en évitant les récents.
function pickHashtags(plan, recentHashtags = [], count = 5) {
  const norm = h => String(h).replace(/^#/, '').trim();
  const core = [...new Set((plan?.core_hashtags || []).map(norm))].filter(Boolean).slice(0, 2);
  const pool = [...new Set((plan?.hashtag_pool || []).map(norm))].filter(h => h && !core.includes(h));
  if (!pool.length) return core; // pas de vivier -> on laissera Claude compléter en amont
  const recent = new Set(recentHashtags.map(norm));
  const fresh = pool.filter(h => !recent.has(h));
  const bag = fresh.length >= (count - core.length) ? fresh : pool; // si trop peu de "frais", on rouvre tout le vivier
  // Mélange déterministe simple (pas de Math.random pour rester lisible) puis on complète.
  const shuffled = bag.map((h, i) => ({ h, k: (i * 2654435761) % bag.length })).sort((a, b) => a.k - b.k).map(x => x.h);
  const picked = [...core];
  for (const h of shuffled) { if (picked.length >= count) break; if (!picked.includes(h)) picked.push(h); }
  return picked;
}

export async function generateMetadata({ tracklist, mood = 'romantique', utmUrl, avoidTitles = [], strategy = {}, emotion = null, seoPlan = null, recentHashtags = [], internalLinks = [], channelHandle = '', channelName = '', titleOverride = '', log = () => {} }) {
  const pb = strategy.playbook || {};
  const plan = seoPlan || {};
  // Contexte SEO adaptatif : le domaine/ton vient de la chaîne (objectif + produit), pas d'un thème présupposé.
  const hasContext = !!(strategy.objective || strategy.product_desc || pb.title_patterns?.length);
  const contextLine = (strategy.objective || strategy.product_desc)
    ? 'CONTEXTE DE LA CHAÎNE : ' + [strategy.objective, strategy.product_desc && ('Produit promu : ' + strategy.product_desc)].filter(Boolean).join(' — ')
    : "CONTEXTE PAR DÉFAUT (aucun renseigné) : chaîne de playlists de musique d'amour francophone.";
  const system = [
    "Tu es un expert du SEO YouTube pour les chaînes de playlists (viralité + conversion, pratiques 2026).",
    contextLine,
    "SEO ADAPTATIF : cale le TON, le champ lexical, les mots-clés, hashtags et tags sur LE DOMAINE, l'objectif ET LA LANGUE de cette chaîne. Ne présuppose aucun thème générique.",
    plan.primary_keywords?.length ? 'Mots-clés PRINCIPaux du plan SEO (à privilégier) : ' + plan.primary_keywords.join(', ') : '',
    plan.pillars?.length ? 'Piliers de contenu de la chaîne : ' + plan.pillars.join(' · ') : '',
    "Le HOOK (1re phrase de la description) doit contenir le mot-clé principal DÈS LES 40 PREMIERS CARACTÈRES (avant la troncature mobile).",
    "",
    "RÈGLES DU TITRE (le plus important) :",
    "- Le titre NE DÉCRIT JAMAIS l'image ni une scène (interdit : « il t'embrasse dans le champ », « un couple sous la pluie »).",
    "- Il EXPRIME et DÉCUPLE l'émotion que ressent LE SPECTATEUR, comme un miroir de son propre vécu.",
    "- C'est un DÉCLENCHEUR (trigger) : il fait réagir à coup sûr et donne envie de cliquer parce qu'il reflète PARFAITEMENT ce que la personne ressent à cet instant.",
    "- Voix intime, souvent à la 1re personne, brute et sincère, profonde. Comme une confidence ou une parole de chanson.",
    "- Exemples du TON visé (ne pas recopier) : « si tu me voyais pleurer dans ma chambre », « nous nous retrouverons un jour… », « nos chemins se séparent mais je sais qu'on se retrouvera », « je t'aime encore même si je ne devrais plus ».",
    "- Inclure la balise [Playlist]. Toujours différent des titres déjà publiés.",
    emotion ? `ÉMOTION À DÉCUPLER dans le titre : « ${emotion.name} »${emotion.description ? ' — ' + emotion.description : ''}. Écris CE que ressent le spectateur qui vit cette émotion (pas ce qu'on voit).` : '',
    "Réponds UNIQUEMENT par du JSON valide, sans texte autour."
  ].filter(Boolean).join('\n');

  const avoidSet = new Set(avoidTitles.map(normTitle));
  const buildUser = (extraAvoid = []) => [
    `Ambiance / mood de la playlist : ${mood}.`,
    // Les exemples "amour" ne servent que faute de contexte propre à la chaîne (sinon ils biaiseraient un autre domaine).
    !hasContext ? 'Exemples de tons de titres appréciés (inspire-toi du style, adapte au domaine de la chaîne, ne recopie aucun mot pour mot) :\n' + TITLE_SEEDS.map(s => '- ' + s).join('\n') : '',
    pb.title_patterns?.length ? 'FORMULES DE TITRES QUI MARCHENT (déduites de tes vidéos références — applique l\'esprit et la structure, pas le copier-coller) :\n' + pb.title_patterns.slice(0, 12).map(s => '- ' + s).join('\n') : '',
    pb.title_style?.length ? 'STYLE D\'ÉCRITURE des titres à respecter (casse, ponctuation, ton…) : ' + pb.title_style.join(' · ') : '',
    pb.winning_examples?.length ? 'Titres gagnants réels (pour caler le ton, NE recopie pas) :\n' + pb.winning_examples.slice(0, 5).map(s => '- ' + s).join('\n') : '',
    pb.emotional_hooks?.length ? 'Déclencheurs émotionnels à exploiter : ' + pb.emotional_hooks.slice(0, 12).join(', ') : '',
    (avoidTitles.length || extraAvoid.length) ? '\nNe RÉUTILISE JAMAIS aucun de ces titres déjà publiés (ni une variante quasi identique) :' : '',
    [...avoidTitles, ...extraAvoid].slice(-40).map(s => '- ' + s).join('\n'),
    '',
    'Génère (dans la langue de la chaîne) :',
    '- "title" : le titre-déclencheur (60-70 caractères max), incluant [Playlist]. Il DÉCUPLE l\'émotion du spectateur, ne décrit JAMAIS l\'image.',
    '- "hook" : 2-3 phrases d\'accroche pour le début de la description, cohérentes avec le positionnement de la chaîne.',
    '- "keywords" : 12 à 18 mots-clés SEO adaptés au domaine (chaînes courtes).',
    '- "hashtags" : 8 hashtags pertinents pour ce domaine (sans le #, juste le mot).',
    '- "tags" : 10 tags YouTube (mots ou expressions courtes).',
    '',
    'Format EXACT : {"title":"...","hook":"...","keywords":["..."],"hashtags":["..."],"tags":["..."]}'
  ].filter(Boolean).join('\n');

  log('génération métadonnées via Claude…');
  let meta = extractJson(await askClaude(system, buildUser(), 'sonnet'));
  const forcedTitle = String(titleOverride || '').trim();
  if (forcedTitle) {
    // Titre imposé par l'utilisateur : on garde le reste (hook, mots-clés, hashtags, tags) mais on force le titre.
    meta.title = /\[\s*playlist\s*\]/i.test(forcedTitle) ? forcedTitle : forcedTitle + ' [Playlist]';
    log('titre imposé : ' + meta.title);
  } else {
    // Anti-doublon : si le titre existe déjà, on régénère (jusqu'à 3 fois) en le mettant explicitement à éviter.
    const extraAvoid = [];
    for (let attempt = 0; attempt < 3 && avoidSet.has(normTitle(meta.title)); attempt++) {
      log(`titre déjà utilisé ("${meta.title}") — nouvelle génération…`);
      extraAvoid.push(meta.title);
      meta = extractJson(await askClaude(system, buildUser(extraAvoid), 'sonnet'));
    }
  }

  // Chapitres YouTube : 1re entrée forcée à 0:00 (règle YouTube), titres descriptifs -> +watch time, ranking multi-requêtes.
  const chapters = tracklist.map((l, i) => `${i === 0 ? '0:00' : l.stamp} ${l.title}${l.artist ? ' — ' + l.artist : ''}`).join('\n');

  // CTA conversion : lien d'affiliation de la chaîne si fourni, sinon le lien Compaatible (UTM).
  const ctaUrl = strategy.affiliate_url || utmUrl || '';
  const ctaLabel = strategy.affiliate_label || 'Test de compatibilité gratuit';
  const productLine = strategy.product_desc || 'Cette playlist t\'est proposée par Compaatible, l\'app qui trouve les gens vraiment faits pour toi.';
  const ctaBlock = ['━━━━━━━━━━━━━━━━━━', '💞 ' + productLine, '👉 ' + ctaLabel + ' : ' + ctaUrl, '━━━━━━━━━━━━━━━━━━'].join('\n');

  // Maillage interne : liens vers d'autres vidéos de la chaîne -> temps de session, découverte croisée.
  const links = (internalLinks || []).filter(v => v && v.url && v.title).slice(0, 3);
  const internalBlock = links.length
    ? '🎧 À écouter aussi :\n' + links.map(v => '• ' + stripTag(v.title) + ' : ' + v.url).join('\n')
    : '';

  // Hashtags : rotation depuis le vivier du plan (variété) ; sinon ceux de Claude.
  const planTags = pickHashtags(plan, recentHashtags, 5);
  const hashtags = (planTags.length ? planTags : (meta.hashtags || []).map(h => String(h).replace(/^#/, '')).slice(0, 5)).filter(Boolean);

  const parts = [
    meta.hook,          // mot-clé principal en tête (avant troncature mobile)
    '', ctaBlock,       // conversion, haut de description
    '', 'CHAPITRES', chapters
  ];
  if (internalBlock) parts.push('', internalBlock);
  parts.push(
    '', 'Mots-clés : ' + (meta.keywords || []).join(', '),
    '', hashtags.map(h => '#' + h).join(' '),
    '', '🎵 Musique sous licence Epidemic Sound.' + (channelHandle ? ' Chaîne : ' + channelHandle : (channelName ? ' Chaîne : ' + channelName : ''))
  );
  const description = parts.join('\n');

  return {
    title: String(meta.title || 'Playlist [Playlist]').slice(0, 100),
    description: description.slice(0, 4900),
    tags: (meta.tags || []).slice(0, 15),
    hashtags
  };
}
