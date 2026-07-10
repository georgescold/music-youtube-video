import { readFileSync } from 'node:fs';
import { runPipeline } from '../src/pipeline.mjs';
import { dbInsert, dbSelect, dbDelete } from '../src/services/supabase.mjs';
import { deleteVideo } from '../src/services/youtube.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

console.log('== insertion chanson de référence de test ==');
const [ref] = await dbInsert('reference_songs', [{
  spotify_url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
  title: 'TEST REF', mood_tags: ['romantic', 'love', 'piano'], active: true
}]);
console.log('  ref id:', ref.id);

let result;
try {
  console.log('== run pipeline (cible 300s, upload réel) ==');
  result = await runPipeline({ targetSec: 300, dryRun: false, log: m => console.log('  ' + m) });
  console.log('\n== RÉSULTAT ==', JSON.stringify(result));

  const [video] = await dbSelect('videos', `?id=eq.${result.videoId}`);
  console.log('status:', video.status, '| durée:', video.duration_sec, 's | yt:', video.youtube_video_id);
  console.log('titre:', video.title);
  const tracks = await dbSelect('video_tracks', `?video_id=eq.${result.videoId}&order=position`);
  console.log('tracks en base:', tracks.length);
} finally {
  console.log('\n== NETTOYAGE ==');
  if (result?.youtubeId) { await deleteVideo(result.youtubeId).catch(e => console.log('  yt delete:', e.message)); console.log('  vidéo YouTube supprimée'); }
  if (result?.videoId) { await dbDelete('videos', `id=eq.${result.videoId}`); console.log('  ligne video supprimée (cascade tracks/logs)'); }
  await dbDelete('reference_songs', `id=eq.${ref.id}`);
  console.log('  ref de test supprimée');
}
