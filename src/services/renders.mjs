// Conservation des rendus sur le volume persistant (/data), pour le mode « téléchargement seul ».
// Le volume Railway fait 5 Go et un rendu de 1h30 pèse ~250-500 Mo : on ne garde que les N derniers.
import { mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.DATA_DIR || './data';
export const RENDERS_DIR = join(DATA, 'renders');
export const KEEP_RENDERS = 5;

export function renderDir(videoId) { return join(RENDERS_DIR, String(videoId)); }

// Chemins des fichiers conservés pour une vidéo (null quand le fichier n'existe pas / a été purgé).
export function renderFiles(videoId) {
  const d = renderDir(videoId);
  const video = join(d, 'video.mp4');
  const thumb = join(d, 'thumbnail.jpg');
  return { video: existsSync(video) ? video : null, thumb: existsSync(thumb) ? thumb : null };
}

export function hasRender(videoId) { return !!renderFiles(videoId).video; }

// Copie le MP4 (+ la miniature) sur le volume, puis purge les rendus les plus anciens.
export function saveRender({ videoId, videoPath, thumbPath = null }) {
  const d = renderDir(videoId);
  mkdirSync(d, { recursive: true });
  copyFileSync(videoPath, join(d, 'video.mp4'));
  if (thumbPath && existsSync(thumbPath)) copyFileSync(thumbPath, join(d, 'thumbnail.jpg'));
  pruneRenders();
  return d;
}

// Ne conserve que les `keep` dossiers de rendu les plus récents. Renvoie les ids purgés.
export function pruneRenders(keep = KEEP_RENDERS) {
  if (!existsSync(RENDERS_DIR)) return [];
  const dirs = readdirSync(RENDERS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => { const p = join(RENDERS_DIR, e.name); return { name: e.name, path: p, mtime: statSync(p).mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const d of dirs.slice(keep)) { try { rmSync(d.path, { recursive: true, force: true }); removed.push(d.name); } catch {} }
  return removed;
}

export function deleteRender(videoId) {
  try { rmSync(renderDir(videoId), { recursive: true, force: true }); } catch {}
}
