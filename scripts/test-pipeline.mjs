import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { curatePlaylist, durationSec } from '../src/steps/curate.mjs';
import { downloadAll } from '../src/steps/download.mjs';
import { concatAudio, renderVideo, generateDefaultBackground, buildTracklist, probeDuration } from '../src/services/ffmpeg.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const scratch = 'C:/Users/loysc/AppData/Local/Temp/claude/C--Users-loysc-Desktop-Au-Bon-Moment---Youtube/cd037e07-7664-4405-ac7e-e43d2c8de0c7/scratchpad/pipeline-test';
mkdirSync(scratch, { recursive: true });
const log = m => console.log('  ' + m);

console.log('== 1. Curation (cible 360s) ==');
const { tracks, totalSec } = await curatePlaylist({
  references: [{ spotify_url: '', mood_tags: ['romantic', 'love', 'piano'] }],
  targetSec: 360, vocals: false, log
});
console.log(`  → ${tracks.length} morceaux, ${totalSec}s`);
if (!tracks.length) { console.log('AUCUN morceau — abandon'); process.exit(1); }

console.log('== 2. Download ==');
const withPaths = await downloadAll(tracks, join(scratch, 'audio'), log);

console.log('== 3. Concat audio ==');
const audioPath = join(scratch, 'mix.mp3');
concatAudio(withPaths.map(t => t.path), audioPath);
console.log('  → durée mix:', probeDuration(audioPath).toFixed(1), 's');

console.log('== 4. Tracklist ==');
const tl = buildTracklist(withPaths);
tl.forEach(l => console.log(`  ${l.stamp}  ${l.title} — ${l.artist}`));

console.log('== 5. Render vidéo (fond par défaut) ==');
const bg = generateDefaultBackground(join(scratch, 'bg.png'));
const outPath = join(scratch, 'video.mp4');
renderVideo({ backgroundPath: bg, audioPath, outPath, log });
const vd = probeDuration(outPath);
console.log('  → vidéo:', vd.toFixed(1), 's');
console.log('\nRESULTAT:', outPath);
