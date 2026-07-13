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

// Choisit les 1-2 articles de blog du produit les plus pertinents pour CETTE vidéo (thème/émotion).
// Renvoie [{url,title}] (vide si rien de vraiment pertinent). Dégrade proprement sans token/articles.
async function pickBlogLinks({ articles = [], title = '', emotion = null, keywords = [], model = 'sonnet', token, log = () => {} }) {
  const list = (articles || []).filter(a => a && a.url && a.title).slice(0, 40);
  if (!list.length || !token) return [];
  try {
    const system = "Tu relies une vidéo (playlist musicale) à des articles de blog d'un produit. Tu choisis UNIQUEMENT ceux dont le SUJET a un vrai rapport thématique/émotionnel avec la vidéo — la pertinence prime sur le remplissage. Réponds en JSON.";
    const user = [
      'VIDÉO — titre : ' + title,
      emotion?.name ? 'Émotion : ' + emotion.name + (emotion.description ? ' (' + emotion.description + ')' : '') : '',
      keywords?.length ? 'Mots-clés : ' + keywords.slice(0, 10).join(', ') : '',
      '', 'ARTICLES DE BLOG DISPONIBLES :',
      list.map((a, i) => `${i}. ${a.title}`).join('\n'), '',
      'Choisis les 1 à 2 articles les PLUS pertinents pour un spectateur de cette vidéo (0 si aucun ne colle vraiment).',
      'Format EXACT : {"idx":[numéros]}'
    ].filter(Boolean).join('\n');
    const j = extractJson(await askClaude(system, user, model, { token }));
    const idx = Array.isArray(j.idx) ? j.idx : [];
    const picked = [...new Set(idx.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < list.length))].slice(0, 2).map(n => list[n]);
    if (picked.length) log('articles de blog liés : ' + picked.map(a => a.title).join(' | '));
    return picked;
  } catch (e) { log('sélection blog KO : ' + e.message); return []; }
}

export async function generateMetadata({ tracklist, mood = 'romantique', utmUrl, avoidTitles = [], strategy = {}, emotion = null, seoPlan = null, recentHashtags = [], internalLinks = [], blogArticles = [], channelHandle = '', channelName = '', titleOverride = '', model = 'sonnet', token, log = () => {} }) {
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
    "RÈGLES DU TITRE (priorité N°1 de toute la vidéo) :",
    "1. REPRODUIS LES PATTERNS DE TES VIDÉOS DE RÉFÉRENCE. Les 'titres gagnants' fournis sont ta MATRICE : même structure, même longueur, même ponctuation, même ressort psychologique. C'est CE qui déclenche le clic — c'est la priorité absolue.",
    "2. Le titre est le MONOLOGUE INTÉRIEUR BRUT du spectateur — une pensée/confidence qu'IL pourrait écrire lui-même à 3h du matin, dans SA voix, sur SON vécu, à la 1re personne.",
    "3. INTERDIT ABSOLU : décrire une ACTION, une SCÈNE ou un DÉCOR. Exemples de ce qu'il NE FAUT JAMAIS écrire : « courir vers l'inconnu », « danser sous la pluie », « partir à deux à l'aventure », « il t'embrasse dans le champ ». Ce sont des ACTIONS/SCÈNES, pas des émotions ressenties. On n'écrit pas ce qui se passe, on écrit ce que la personne RESSENT au fond d'elle.",
    "4. ÉMOTION FINE et précise, jamais générique : pas « l'amour » ou « le bonheur », mais le pincement exact (le manque à 3h du matin, l'aveu qu'on n'ose pas dire, le « et si on s'était ratés », la personne qui hante encore…).",
    "5. TEST DÉCISIF : un inconnu qui lit le titre doit se dire « c'est exactement moi / mon histoire » et cliquer par réflexe. Si le titre pourrait légender une photo, il est MAUVAIS.",
    "6. Voix intime, brute, sincère, profonde — comme une parole de chanson. Inclure [Playlist]. Jamais un titre déjà publié.",
    "BON ton (ne pas recopier) : « si tu me voyais pleurer dans ma chambre », « je t'aime encore même si je ne devrais plus », « il est 3h et tu me manques toujours », « personne ne saura à quel point je t'ai aimé ».",
    emotion ? `BOUSSOLE ÉMOTIONNELLE (usage INTERNE — ne reprends PAS ses mots, ne décris PAS la scène) : « ${emotion.name} »${emotion.description ? ' — ' + emotion.description : ''}. Traduis CE ressenti en la voix intime du spectateur, dans le style de tes références.` : '',
    "Réponds UNIQUEMENT par du JSON valide, sans texte autour."
  ].filter(Boolean).join('\n');

  const avoidSet = new Set(avoidTitles.map(normTitle));
  // Contexte partagé (mood + playbook déduit des vidéos de référence + titres à éviter).
  const ctx = (extraAvoid = []) => [
    // ★ LA MATRICE d'abord : les titres/patterns qui MARCHENT chez tes références = le modèle prioritaire.
    pb.winning_examples?.length ? '★★★ TA MATRICE — TITRES DE RÉFÉRENCE QUI CARTONNENT. Reproduis leur STRUCTURE, leur TON et leur ANGLE (sans recopier les mots) — c\'est la priorité N°1 :\n' + pb.winning_examples.slice(0, 6).map(s => '- ' + s).join('\n') : '',
    pb.title_patterns?.length ? 'FORMULES QUI MARCHENT (structure + ressort psychologique à réutiliser) :\n' + pb.title_patterns.slice(0, 12).map(s => '- ' + s).join('\n') : '',
    pb.title_style?.length ? 'STYLE D\'ÉCRITURE à respecter (casse, ponctuation, longueur, point de vue…) : ' + pb.title_style.join(' · ') : '',
    pb.emotional_hooks?.length ? 'Déclencheurs émotionnels à exploiter : ' + pb.emotional_hooks.slice(0, 12).join(', ') : '',
    // Faute de références analysées, on donne des exemples de ton (secondaire).
    !hasContext && !pb.winning_examples?.length ? 'Exemples de tons appréciés (inspire-toi du style, ne recopie pas) :\n' + TITLE_SEEDS.map(s => '- ' + s).join('\n') : '',
    `Ambiance / mood de la playlist : ${mood}.`,
    (avoidTitles.length || extraAvoid.length) ? '\nNe RÉUTILISE JAMAIS aucun de ces titres déjà publiés (ni une variante quasi identique) :\n' + [...avoidTitles, ...extraAvoid].slice(-40).map(s => '- ' + s).join('\n') : ''
  ];
  // Spécif du reste (description/SEO), commune à toutes les passes qui produisent les métadonnées.
  const restSpec = [
    '- "hook" : 2-3 phrases d\'accroche pour le début de la description, cohérentes avec le positionnement de la chaîne.',
    '- "keywords" : 12 à 18 mots-clés SEO adaptés au domaine (chaînes courtes).',
    '- "hashtags" : 8 hashtags pertinents pour ce domaine (sans le #, juste le mot).',
    '- "tags" : 10 tags YouTube (mots ou expressions courtes).'
  ];
  // Passe unique (repli / titre imposé) : titre + reste d'un coup.
  const buildUser = (extraAvoid = []) => [
    ...ctx(extraAvoid), '', 'Génère (dans la langue de la chaîne) :',
    '- "title" : le titre-déclencheur (60-70 caractères max), incluant [Playlist]. Il DÉCUPLE l\'émotion du spectateur, ne décrit JAMAIS l\'image.',
    ...restSpec, '',
    'Format EXACT : {"title":"...","hook":"...","keywords":["..."],"hashtags":["..."],"tags":["..."]}'
  ].filter(Boolean).join('\n');
  // Passe 1 : plusieurs titres candidats, angles variés.
  const candidatesUser = (extraAvoid = []) => [
    ...ctx(extraAvoid), '',
    'Génère 8 titres CANDIDATS, TOUS différents. Chacun CALQUÉ sur la STRUCTURE de ta matrice (titres de référence) et écrit comme le MONOLOGUE INTÉRIEUR BRUT du spectateur (sa pensée à 3h du matin, 1re personne).',
    'Explore un ressort émotionnel FIN et DIFFÉRENT à chaque candidat (le manque, l\'aveu qu\'on n\'ose pas, le « et si », la personne qui hante, le pardon impossible…).',
    'INTERDIT : décrire une action/scène/décor (« courir vers l\'inconnu », « danser sous la pluie »…). On écrit ce que la personne RESSENT, pas ce qui se passe.',
    'Chaque candidat : 60-70 caractères max, dans le style exact de la chaîne. N\'ajoute PAS [Playlist] (ce sera fait ensuite).',
    'Format EXACT : {"candidates":["...","...","...","...","...","...","...","..."]}'
  ].filter(Boolean).join('\n');
  // Passe 2 : Claude JUGE les candidats, choisit (et peut affiner) le meilleur, puis produit le reste.
  const judgeUser = (candidates, extraAvoid = []) => [
    ...ctx(extraAvoid), '',
    'Voici des titres CANDIDATS pour cette vidéo :',
    candidates.map((c, i) => `${i + 1}. ${c}`).join('\n'), '',
    'D\'ABORD, ÉLIMINE tout candidat qui décrit une ACTION ou une SCÈNE plutôt qu\'une émotion ressentie (ex : « courir vers l\'inconnu ») — disqualifié d\'office.',
    'Puis CHOISIS LE MEILLEUR selon ces critères, dans cet ordre :',
    '1. Il colle le mieux aux PATTERNS de ta matrice (structure/ton/angle des titres de référence qui cartonnent).',
    '2. C\'est le MONOLOGUE INTÉRIEUR BRUT du spectateur : il lit et se dit « c\'est exactement moi/mon histoire ».',
    '3. Émotion FINE et précise (pas générique), envie IRRÉSISTIBLE de cliquer.',
    '4. CHAQUE MOT est pesé, au service de l\'émotion — zéro mot faible ou de remplissage.',
    '5. Différent des titres déjà publiés.',
    'Tu peux AFFINER le gagnant mot à mot pour le rapprocher encore de tes références et le rendre plus percutant — garde son esprit.',
    '', 'Puis renvoie le titre final (avec [Playlist]) + le reste. Format EXACT :',
    '{"title":"... [Playlist]","hook":"...","keywords":["..."],"hashtags":["..."],"tags":["..."]}'
  ].filter(Boolean).join('\n');

  let meta;
  const forcedTitle = String(titleOverride || '').trim();
  if (forcedTitle) {
    // Titre imposé : on le respecte TEL QUEL, on ne génère que le reste (hook/keywords/hashtags/tags).
    meta = extractJson(await askClaude(system, buildUser(), model, { token }));
    meta.title = forcedTitle;
    log('titre imposé : ' + meta.title);
  } else {
    // Passe 1 — candidats.
    log('génération de titres candidats…');
    let cj = {};
    try { cj = extractJson(await askClaude(system, candidatesUser(), model, { token })); } catch (e) { cj = {}; }
    let candidates = (Array.isArray(cj.candidates) ? cj.candidates : []).map(s => String(s || '').trim()).filter(Boolean);
    candidates = candidates.filter(t => !avoidSet.has(normTitle(t))).slice(0, 8);
    if (candidates.length >= 2) {
      // Passe 2 — sélection + affinage du meilleur + reste.
      log(`sélection du meilleur titre parmi ${candidates.length} candidats…`);
      meta = extractJson(await askClaude(system, judgeUser(candidates), model, { token }));
      for (let attempt = 0; attempt < 2 && avoidSet.has(normTitle(meta.title)); attempt++) {
        meta = extractJson(await askClaude(system, judgeUser(candidates, [meta.title]), model, { token }));
      }
      log('titre retenu : ' + meta.title);
    } else {
      // Repli (candidats indisponibles) : passe unique + anti-doublon.
      meta = extractJson(await askClaude(system, buildUser(), model, { token }));
      const extraAvoid = [];
      for (let attempt = 0; attempt < 3 && avoidSet.has(normTitle(meta.title)); attempt++) { extraAvoid.push(meta.title); meta = extractJson(await askClaude(system, buildUser(extraAvoid), model, { token })); }
    }
  }

  // Chapitres YouTube : 1re entrée forcée à 0:00 (règle YouTube), titres descriptifs -> +watch time, ranking multi-requêtes.
  const chapters = tracklist.map((l, i) => `${i === 0 ? '0:00' : l.stamp} ${l.title}${l.artist ? ' — ' + l.artist : ''}`).join('\n');

  // CTA conversion : lien unique, toujours tracké UTM (construit en amont depuis l'override d'affiliation
  // s'il existe, sinon le site produit, sinon le défaut Compaatible).
  const ctaUrl = utmUrl || '';
  const ctaLabel = strategy.affiliate_label || 'Test de compatibilité gratuit';
  const productLine = strategy.product_desc || 'Cette playlist t\'est proposée par Compaatible, l\'app qui trouve les gens vraiment faits pour toi.';
  const ctaBlock = ['━━━━━━━━━━━━━━━━━━', '💞 ' + productLine, '👉 ' + ctaLabel + ' : ' + ctaUrl, '━━━━━━━━━━━━━━━━━━'].join('\n');

  // Maillage interne : liens vers d'autres vidéos de la chaîne -> temps de session, découverte croisée.
  const links = (internalLinks || []).filter(v => v && v.url && v.title).slice(0, 3);
  const internalBlock = links.length
    ? '🎧 À écouter aussi :\n' + links.map(v => '• ' + stripTag(v.title) + ' : ' + v.url).join('\n')
    : '';

  // Articles de blog du produit pertinents pour ce thème -> trafic de référence vers l'entonnoir (liens nofollow).
  const blogPicks = await pickBlogLinks({ articles: blogArticles, title: meta.title, emotion, keywords: meta.keywords, model, token, log });
  const blogBlock = blogPicks.length
    ? '📖 À lire aussi :\n' + blogPicks.map(a => '• ' + String(a.title).replace(/\s+/g, ' ').trim() + ' : ' + a.url).join('\n')
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
  if (blogBlock) parts.push('', blogBlock);
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
