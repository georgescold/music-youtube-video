// Curation adaptative : Claude analyse les références, décide voix/instrumental et les angles,
// puis on cherche multi-angles + externalID + moods + similaires -> dédup + variété d'artistes.
// Conçu pour être multi-utilisateurs : aucune préférence de style codée en dur, tout vient des références.
import { callTool as defaultCallTool, isEpidemicAuthError } from '../services/epidemicMcp.mjs';
import { askClaude, extractJson } from '../services/claude.mjs';

export function spotifyTrackId(url) {
  const m = String(url || '').match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
function recs(res) {
  return (res?.data?.recordings?.nodes || res?.data?.similarRecordings?.nodes || [])
    .map(n => n.recording || n).filter(r => r && r.audioFile?.durationInMilliseconds);
}
function mainArtist(rec) {
  const c = (rec.credits || []).find(x => x.role === 'MAIN_ARTIST') || (rec.credits || [])[0];
  return c?.artist?.name || 'inconnu';
}
export function durationSec(rec) { return Math.round((rec.audioFile?.durationInMilliseconds || 0) / 1000); }

// Une erreur d'auth (401) est fatale et concerne TOUS les appels -> on la fait remonter au lieu de l'avaler
// silencieusement (sinon le pipeline échouait avec le message trompeur « curation vide »).
async function searchTerm(call, term, filter, first = 10) {
  try { return recs(await call('SearchRecordings', { query: { term }, filter, sort: { by: 'RELEVANCE', order: 'DESCENDING' }, first })); }
  catch (e) { if (isEpidemicAuthError(e)) throw e; return []; }
}
async function searchExternal(call, spotifyId, filter, first = 15) {
  try { return recs(await call('SearchRecordings', { query: { externalID: { type: 'SPOTIFY_TRACK', id: spotifyId } }, filter, first })); }
  catch (e) { if (isEpidemicAuthError(e)) throw e; return []; }
}
async function similarTo(call, id, first = 8) {
  try { return recs(await call('SearchSimilarToRecording', { id, first })); }
  catch (e) { if (isEpidemicAuthError(e)) throw e; return []; }
}

// Claude analyse le style COMMUN des références et décide de l'approche (adaptatif, pas de style imposé).
async function analyzeReferences(references, moodHint, model = 'sonnet') {
  const refDesc = references.map(r => `- ${r.title || r.spotify_url}${(r.mood_tags || []).length ? ' [moods: ' + r.mood_tags.join(', ') + ']' : ''}`).join('\n') || '(aucune référence précise)';
  const system = "Tu es directeur musical. Tu analyses des chansons de référence pour bâtir une playlist qui leur ressemble. Tu réponds UNIQUEMENT en JSON valide.";
  const user = [
    `Ambiance/thème indicatif : ${moodHint || 'à déduire des références'}.`,
    `Chansons de référence fournies par l'utilisateur :`,
    refDesc,
    '',
    "Analyse le STYLE COMMUN de ces références et décide de la meilleure approche pour une playlist longue qui leur ressemble.",
    "Réponds avec :",
    '- "understanding" : 1-2 phrases EN FRANÇAIS décrivant précisément le style commun (genre, instrumentation, tempo, mood, type de voix, époque).',
    '- "vocals" : "instrumental", "vocal" ou "mixed" — choisis ce qui ressemble le plus au caractère des références (si elles sont chantées et que la voix est centrale, penche vers "vocal" ou "mixed").',
    '- "angles" : 12 requêtes de recherche EN ANGLAIS, variées mais cohérentes avec les références (genre, instrument, tempo/énergie, nuance émotionnelle). 2-4 mots chacune, sans répétition.',
    'Format EXACT : {"understanding":"...","vocals":"instrumental|vocal|mixed","angles":["...", ...]}'
  ].join('\n');
  try {
    const j = extractJson(await askClaude(system, user, model));
    return {
      understanding: typeof j.understanding === 'string' ? j.understanding.trim() : '',
      vocals: ['instrumental', 'vocal', 'mixed'].includes(j.vocals) ? j.vocals : 'mixed',
      angles: Array.isArray(j.angles) ? j.angles.filter(x => typeof x === 'string' && x.trim()).slice(0, 12) : []
    };
  } catch { return { understanding: '', vocals: 'mixed', angles: [] }; }
}

const DEFAULT_ANGLES = ['romantic piano', 'soft love ballad', 'acoustic love song', 'cinematic romance', 'nostalgic love', 'slow rnb love', 'tender strings', 'mellow indie love', 'jazzy romance', 'ambient love', 'folk love song', 'bittersweet piano'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// vocalsOverride: 'instrumental' | 'vocal' | 'mixed' | undefined (undefined = Claude décide, adaptatif)
export async function curatePlaylist({ references = [], targetSec = 5400, vocalsOverride, moodHint, emotion, client, model = 'sonnet', controller, log = () => {} }) {
  const ck = () => { if (controller?.cancelled) throw new Error('cancelled'); };
  const call = client?.callTool || defaultCallTool; // client Epidemic de la chaîne (jeton stocké dans l'app), sinon défaut (env)
  // Si une émotion pilote la vidéo, elle devient le contexte prioritaire de la curation.
  const hint = emotion ? `${emotion.name} — ${emotion.description}` : moodHint;
  const analysis = await analyzeReferences(references, hint, model);
  const vocalsMode = vocalsOverride || analysis.vocals;
  if (emotion) log('émotion : ' + emotion.name);
  if (analysis.understanding) log('compris : ' + analysis.understanding);
  log('mode voix : ' + vocalsMode);

  const filter = { duration: { min: 90000, max: 360000 } };
  if (vocalsMode === 'instrumental') filter.vocals = false;
  else if (vocalsMode === 'vocal') filter.vocals = true;
  // "mixed" : pas de filtre vocals -> Epidemic renvoie les deux.

  // Les mots-clés de l'émotion passent en tête des angles -> la musique incarne l'émotion visée.
  let angles = emotion?.keywords?.length ? [...emotion.keywords, ...analysis.angles] : analysis.angles;
  angles = [...new Set(angles)];
  if (angles.length < 6) angles = [...new Set([...angles, ...DEFAULT_ANGLES])];
  angles = angles.slice(0, 14);
  log('angles : ' + angles.join(' · '));

  const pool = new Map();
  const add = list => { for (const r of list) pool.set(r.id, r); };

  for (const a of angles) { ck(); add(await searchTerm(call, a, filter, 10)); }
  for (const ref of references) {
    ck();
    const sid = spotifyTrackId(ref.spotify_url);
    if (sid) add(await searchExternal(call, sid, filter, 15));
    for (const m of (ref.mood_tags || [])) add(await searchTerm(call, m, filter, 8));
  }
  log('pool après recherches : ' + pool.size);
  for (const seed of shuffle([...pool.values()]).slice(0, 6)) { ck(); add(await similarTo(call, seed.id, 8)); }
  log('pool après similaires : ' + pool.size);

  const shuffled = shuffle([...pool.values()]);
  const selected = [];
  const perArtist = {};
  let total = 0;
  for (const rec of shuffled) {
    if (total >= targetSec) break;
    const a = mainArtist(rec);
    if ((perArtist[a] || 0) >= 2) continue;
    selected.push(rec); perArtist[a] = (perArtist[a] || 0) + 1; total += durationSec(rec);
  }
  if (total < targetSec) {
    for (const rec of shuffled) {
      if (total >= targetSec) break;
      if (selected.includes(rec)) continue;
      selected.push(rec); total += durationSec(rec);
    }
  }
  const uniqueArtists = new Set(selected.map(mainArtist)).size;
  log(`sélection : ${selected.length} morceaux · ${Math.round(total / 60)} min · ${uniqueArtists} artistes (pool ${pool.size})`);
  return { tracks: selected, totalSec: total, understanding: analysis.understanding, vocalsMode };
}
