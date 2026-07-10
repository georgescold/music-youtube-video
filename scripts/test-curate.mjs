import { readFileSync } from 'node:fs';
import { curatePlaylist } from '../src/steps/curate.mjs';
import { dbSelect } from '../src/services/supabase.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const references = await dbSelect('reference_songs', '?active=eq.true');
console.log('Références actives :', references.map(r => r.title || r.spotify_url).join(' | '));

const { tracks, totalSec } = await curatePlaylist({
  references: references.map(r => ({ spotify_url: r.spotify_url, title: r.title, mood_tags: r.mood_tags })),
  targetSec: 5400, vocals: false, moodHint: 'romantique et doux', log: m => console.log('  ' + m)
});

console.log('\n=== SÉLECTION (' + tracks.length + ' morceaux, ' + Math.round(totalSec / 60) + ' min) ===');
tracks.forEach((t, i) => console.log(String(i + 1).padStart(2) + '. ' + t.title + ' — ' + ((t.credits || []).find(c => c.role === 'MAIN_ARTIST')?.artist?.name || '?')));
