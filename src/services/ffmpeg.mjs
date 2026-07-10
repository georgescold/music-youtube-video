// Montage FFmpeg. Deux notions distinctes :
//  - FONDS (backgrounds) : image(s) ou vidéo. Plusieurs images -> réparties équitablement (slideshow équilibré).
//  - PUBS (ads) : image/animation/vidéo superposées à des moments précis (intro, outro + fréquence réglable).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const FF = process.env.FFMPEG_BIN || 'ffmpeg';
const FP = process.env.FFPROBE_BIN || 'ffprobe';
const fwd = p => String(p).replace(/\\/g, '/');

export function probeDuration(path) {
  const out = execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString().trim();
  return parseFloat(out) || 0;
}

export function concatAudio(trackPaths, outPath) {
  const listPath = outPath + '.list.txt';
  writeFileSync(listPath, trackPaths.map(p => `file '${fwd(p)}'`).join('\n'), 'utf8');
  execFileSync(FF, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath], { stdio: 'ignore' });
  return outPath;
}

export function buildTracklist(tracks) {
  let t = 0; const lines = [];
  for (const tr of tracks) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    const stamp = (h > 0 ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    lines.push({ stamp, title: tr.title, artist: (tr.credits || []).find(c => c.role === 'MAIN_ARTIST')?.artist?.name || '' });
    t += probeDuration(tr.path);
  }
  return lines;
}

export function generateDefaultBackground(outPath, width = 1920, height = 1080) {
  execFileSync(FF, ['-y', '-f', 'lavfi', '-i', `color=c=0x14100f:s=${width}x${height}`, '-frames:v', '1', outPath], { stdio: 'ignore' });
  return outPath;
}

// Calcule les fenêtres d'apparition des pubs : intro (option), toutes les `freqMin` min, outro (option).
export function adIntervals(durationSec, freqMin, durSec, { intro = true, outro = true } = {}) {
  const D = durationSec, dur = Math.min(durSec, D);
  const out = [];
  if (intro) out.push([0, dur]);
  const step = Math.max(30, freqMin * 60);
  for (let t = step; t < D - dur; t += step) out.push([t, Math.min(t + dur, D)]);
  if (outro) out.push([Math.max(0, D - dur), D]);
  if (!out.length) return [];
  // fusionne les fenêtres qui se chevauchent (ex : freq très courte)
  out.sort((a, b) => a[0] - b[0]);
  const merged = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const last = merged[merged.length - 1];
    if (out[i][0] <= last[1]) last[1] = Math.max(last[1], out[i][1]);
    else merged.push(out[i]);
  }
  return merged;
}

// backgrounds: [{ path, isVideo }] · ads: [{ path, isVideo }]
export function renderVideo({ backgrounds = [], ads = [], audioPath, outPath, adFrequencyMin = 10, adDurationSec = 8, adIntro = true, adOutro = true, placement, width = 1920, height = 1080, fps = Number(process.env.RENDER_FPS) || 4, log = () => {} }) {
  const D = Math.max(1, Math.round(probeDuration(audioPath)));
  const inputs = [];
  let idx = 0;
  const addInput = args => { inputs.push(...args); return idx++; };
  const filters = [];
  const scaleCropFps = (src, out) => `[${src}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}[${out}]`;

  // ── Fond ──
  const bgImages = backgrounds.filter(b => !b.isVideo).map(b => b.path);
  const bgVideo = backgrounds.find(b => b.isVideo);
  let bgLabel;
  if (bgImages.length) {
    const T = (D / bgImages.length).toFixed(3); // temps égal par image = équilibrage équitable
    const segs = [];
    bgImages.forEach((p, i) => {
      const inIdx = addInput(['-loop', '1', '-t', T, '-i', p]);
      filters.push(scaleCropFps(`${inIdx}:v`, `b${i}`));
      segs.push(`[b${i}]`);
    });
    if (segs.length === 1) bgLabel = 'b0';
    else { filters.push(`${segs.join('')}concat=n=${segs.length}:v=1[bg]`); bgLabel = 'bg'; }
  } else if (bgVideo) {
    const inIdx = addInput(['-stream_loop', '-1', '-t', String(D), '-i', bgVideo.path]);
    filters.push(scaleCropFps(`${inIdx}:v`, 'bg')); bgLabel = 'bg';
  } else {
    const inIdx = addInput(['-f', 'lavfi', '-t', String(D), '-i', `color=c=0x14100f:s=${width}x${height}:r=${fps}`]);
    filters.push(`[${inIdx}:v]setsar=1[bg]`); bgLabel = 'bg';
  }

  // ── Pubs : chaque pub a SA position (ad.placement), fenêtres réparties, assets en rotation ──
  const windows = adIntervals(D, adFrequencyMin, adDurationSec, { intro: adIntro, outro: adOutro });
  let vLabel = bgLabel;
  if (ads.length && windows.length) {
    const perAd = ads.map(() => []);
    windows.forEach((w, k) => perAd[k % ads.length].push(w));
    ads.forEach((ad, ai) => {
      const mine = perAd[ai];
      if (!mine.length) return;
      const p = ad.placement || placement || {};
      const boxW = Math.max(16, Math.round(width * (p.w ?? 0.28)));
      const boxH = Math.max(16, Math.round(height * (p.h ?? 0.40)));
      const ox = Math.min(width - 1, Math.max(0, Math.round(width * (p.x ?? 0.68))));
      const oy = Math.min(height - 1, Math.max(0, Math.round(height * (p.y ?? 0.55))));
      const inIdx = ad.isVideo ? addInput(['-stream_loop', '-1', '-i', ad.path]) : addInput(['-loop', '1', '-i', ad.path]);
      filters.push(`[${inIdx}:v]scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease,setsar=1[ad${ai}]`);
      const enable = mine.map(([s, e]) => `between(t,${s.toFixed(2)},${e.toFixed(2)})`).join('+');
      filters.push(`[${vLabel}][ad${ai}]overlay=${ox}:${oy}:enable='${enable}':shortest=1[v${ai}]`);
      vLabel = `v${ai}`;
    });
  }

  const audioIdx = addInput(['-i', audioPath]);
  const args = ['-y', ...inputs, '-filter_complex', filters.join(';'),
    '-map', `[${vLabel}]`, '-map', `${audioIdx}:a`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outPath];
  log(`ffmpeg render — fonds:${backgrounds.length} · pubs:${ads.length} · apparitions:${windows.length}`);
  execFileSync(FF, args, { stdio: 'ignore' });
  return { outPath, windows };
}
