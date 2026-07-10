// Montage FFmpeg : concatenation audio + fond + banniere optionnelle -> MP4, + tracklist.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const FF = process.env.FFMPEG_BIN || 'ffmpeg';
const FP = process.env.FFPROBE_BIN || 'ffprobe';
const fwd = p => String(p).replace(/\\/g, '/');

export function probeDuration(path) {
  const out = execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString().trim();
  return parseFloat(out);
}

// Concatene des MP3 en un seul fichier (re-encode pour eviter les artefacts de concat brute).
export function concatAudio(trackPaths, outPath) {
  const listPath = outPath + '.list.txt';
  writeFileSync(listPath, trackPaths.map(p => `file '${fwd(p)}'`).join('\n'), 'utf8');
  execFileSync(FF, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath], { stdio: 'ignore' });
  return outPath;
}

// Genere une tracklist avec timestamps a partir des durees reelles des fichiers.
export function buildTracklist(tracks) {
  let t = 0;
  const lines = [];
  for (const tr of tracks) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    const stamp = (h > 0 ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    lines.push({ stamp, title: tr.title, artist: (tr.credits || []).find(c => c.role === 'MAIN_ARTIST')?.artist?.name || '' });
    t += probeDuration(tr.path);
  }
  return lines;
}

// Assemble la video finale.
export function renderVideo({ backgroundPath, audioPath, bannerPath, outPath, width = 1920, height = 1080, fps = Number(process.env.RENDER_FPS) || 4, log = () => {} }) {
  // Fond statique -> tres peu d'images/seconde suffisent. A 24 fps une video de 90 min = ~130k images
  // a encoder pour une image immobile (tres lent sur CPU contraint). A 4 fps c'est ~6x plus rapide,
  // sans difference visible (l'image ne bouge pas). Overridable via RENDER_FPS.
  const inputs = ['-loop', '1', '-framerate', String(fps), '-i', backgroundPath];
  if (bannerPath) inputs.push('-i', bannerPath);
  inputs.push('-i', audioPath);
  const audioIdx = bannerPath ? 2 : 1;

  let filter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg]`;
  let vmap = '[bg]';
  if (bannerPath) {
    const bw = Math.round(width * 0.26);
    filter += `;[1:v]scale=${bw}:-2[bn];[bg][bn]overlay=W-w-48:H-h-48[v]`;
    vmap = '[v]';
  }

  const args = ['-y', ...inputs,
    '-filter_complex', filter, '-map', vmap, '-map', `${audioIdx}:a`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outPath];
  log('ffmpeg render…');
  execFileSync(FF, args, { stdio: 'ignore' });
  return outPath;
}

// Fond neutre par defaut (si l'utilisateur n'a pas depose d'image de fond).
export function generateDefaultBackground(outPath, width = 1920, height = 1080) {
  execFileSync(FF, ['-y', '-f', 'lavfi', '-i', `color=c=0x14100f:s=${width}x${height}`, '-frames:v', '1', outPath], { stdio: 'ignore' });
  return outPath;
}
