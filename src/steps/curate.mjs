// Curation : construit une playlist (~cible de duree) a partir de chansons de reference.
// Utilise SearchRecordings (par term/mood et par externalID Spotify) via le MCP Epidemic.
import { callTool } from '../services/epidemicMcp.mjs';

export function spotifyTrackId(url) {
  const m = String(url || '').match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function nodes(res) {
  return (res?.data?.recordings?.nodes || []).map(n => n.recording).filter(r => r && r.audioFile?.durationInMilliseconds);
}
function mainArtist(rec) {
  const c = (rec.credits || []).find(x => x.role === 'MAIN_ARTIST') || (rec.credits || [])[0];
  return c?.artist?.name || 'inconnu';
}
export function durationSec(rec) { return Math.round((rec.audioFile?.durationInMilliseconds || 0) / 1000); }

async function searchTerm(term, filter, first = 15) {
  try {
    return nodes(await callTool('SearchRecordings', {
      query: { term }, filter, sort: { by: 'RELEVANCE', order: 'DESCENDING' }, first
    }));
  } catch { return []; }
}
async function searchExternal(spotifyId, filter, first = 20) {
  try {
    return nodes(await callTool('SearchRecordings', {
      query: { externalID: { type: 'SPOTIFY_TRACK', id: spotifyId } }, filter, first
    }));
  } catch { return []; }
}

// references: [{ spotify_url, mood_tags: [] }] ; targetSec: duree visee ; vocals: autoriser voix
export async function curatePlaylist({ references = [], targetSec = 5400, vocals = false, log = () => {} }) {
  const filter = { vocals, duration: { min: 90000, max: 360000 } }; // morceaux 1m30–6m
  const pool = new Map();
  const add = recs => { for (const r of recs) pool.set(r.id, r); };

  for (const ref of references) {
    const sid = spotifyTrackId(ref.spotify_url);
    if (sid) { const r = await searchExternal(sid, filter); add(r); log(`ref Spotify ${sid} → ${r.length} morceaux`); }
    for (const mood of (ref.mood_tags || [])) { const r = await searchTerm(mood, filter); add(r); log(`mood "${mood}" → ${r.length}`); }
  }
  if (pool.size < 12) { const r = await searchTerm('romantic love', filter, 30); add(r); log(`fallback romantic → ${r.length}`); }

  // Selection : remplit jusqu'a la cible, max 2 morceaux par artiste principal, pas de doublon.
  const candidates = [...pool.values()];
  const selected = [];
  const perArtist = {};
  let total = 0;
  for (const rec of candidates) {
    if (total >= targetSec) break;
    const a = mainArtist(rec);
    if ((perArtist[a] || 0) >= 2) continue;
    selected.push(rec); perArtist[a] = (perArtist[a] || 0) + 1; total += durationSec(rec);
  }
  // Si pas assez, on relache la contrainte par artiste.
  if (total < targetSec) {
    for (const rec of candidates) {
      if (total >= targetSec) break;
      if (selected.includes(rec)) continue;
      selected.push(rec); total += durationSec(rec);
    }
  }
  log(`selection : ${selected.length} morceaux, ${Math.round(total / 60)} min (pool ${pool.size})`);
  return { tracks: selected, totalSec: total };
}
