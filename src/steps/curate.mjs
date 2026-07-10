// Curation "profonde" : construit une playlist variée et cohérente avec les chansons de référence.
// 1) Claude analyse les références -> plusieurs angles de recherche distincts (genre/instrument/tempo/mood)
// 2) recherches multi-angles + match externalID Spotify + moods des références
// 3) expansion via "morceaux similaires"
// 4) dédup + variété d'artistes + remplissage jusqu'à la cible.
import { callTool } from '../services/epidemicMcp.mjs';
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

async function searchTerm(term, filter, first = 10) {
  try { return recs(await callTool('SearchRecordings', { query: { term }, filter, sort: { by: 'RELEVANCE', order: 'DESCENDING' }, first })); }
  catch { return []; }
}
async function searchExternal(spotifyId, filter, first = 15) {
  try { return recs(await callTool('SearchRecordings', { query: { externalID: { type: 'SPOTIFY_TRACK', id: spotifyId } }, filter, first })); }
  catch { return []; }
}
async function similarTo(id, first = 8) {
  try { return recs(await callTool('SearchSimilarToRecording', { id, first })); }
  catch { return []; }
}

// Claude génère des angles de recherche variés à partir des références.
async function anglesFromClaude(references, moodHint) {
  const refDesc = references.map(r => `- ${r.title || r.spotify_url}${(r.mood_tags || []).length ? ' [moods: ' + r.mood_tags.join(', ') + ']' : ''}`).join('\n') || '(aucune référence précise)';
  const system = "Tu es directeur musical d'une chaîne de playlists de musique d'amour. Tu réponds UNIQUEMENT en JSON valide.";
  const user = [
    `Ambiance cible : ${moodHint || 'romantique'}.`,
    `Chansons de référence données par l'utilisateur (le style à approcher) :`,
    refDesc,
    '',
    "Propose 12 angles de recherche EN ANGLAIS pour piocher dans une grande bibliothèque de musique (instrumentale/production), variés mais tous cohérents avec ces références et l'ambiance amour.",
    "Couvre différents axes : genre (ex: soul, rnb, folk, cinematic, lofi, jazz, indie), instrument (piano, acoustic guitar, strings), tempo/énergie (slow, mellow), et nuances émotionnelles (nostalgic, tender, passionate, bittersweet).",
    "Chaque angle = 2 à 4 mots. Évite les répétitions.",
    'Format EXACT : {"angles":["...","...", ...]}'
  ].join('\n');
  try {
    const a = extractJson(await askClaude(system, user, 'sonnet')).angles;
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()).slice(0, 12) : [];
  } catch { return []; }
}

const DEFAULT_ANGLES = ['romantic piano', 'soft love ballad', 'acoustic love song', 'cinematic romance', 'nostalgic love', 'slow rnb love', 'tender strings', 'mellow indie love', 'jazzy romance', 'ambient love', 'folk love song', 'bittersweet piano'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export async function curatePlaylist({ references = [], targetSec = 5400, vocals = false, moodHint = 'romantique', log = () => {} }) {
  const filter = { vocals, duration: { min: 90000, max: 360000 } };
  const pool = new Map();
  const add = list => { for (const r of list) pool.set(r.id, r); };

  // 1) Angles Claude (fallback sur une liste variée si Claude échoue)
  let angles = await anglesFromClaude(references, moodHint);
  if (angles.length < 6) angles = [...new Set([...angles, ...DEFAULT_ANGLES])].slice(0, 12);
  log('angles : ' + angles.join(' · '));
  for (const a of angles) add(await searchTerm(a, filter, 10));

  // 2) Match externalID Spotify + moods des références
  for (const ref of references) {
    const sid = spotifyTrackId(ref.spotify_url);
    if (sid) add(await searchExternal(sid, filter, 15));
    for (const m of (ref.mood_tags || [])) add(await searchTerm(m, filter, 8));
  }
  log('pool après recherches : ' + pool.size);

  // 3) Expansion "similaires" sur quelques graines
  for (const seed of shuffle([...pool.values()]).slice(0, 6)) add(await similarTo(seed.id, 8));
  log('pool après similaires : ' + pool.size);

  // 4) Sélection variée : mélange, cap 2 par artiste, remplissage jusqu'à la cible
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
  log(`sélection : ${selected.length} morceaux · ${Math.round(total / 60)} min · ${uniqueArtists} artistes différents (pool ${pool.size})`);
  return { tracks: selected, totalSec: total };
}
