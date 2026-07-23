// Point focal des images de fond : évite de décapiter le sujet quand une image portrait est recadrée en 16:9.
//
// Deux garde-fous pour ne pas payer un appel Claude inutilement :
//  1. si le recadrage ne jette presque rien (image déjà ~16:9), on garde le centrage — gratuit ;
//  2. sinon on analyse UNE fois par image et on met le résultat en cache sur le volume persistant
//     (les images de fond sont réutilisées d'une vidéo à l'autre : sans cache on repaierait à chaque montage).
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeFraming } from './vision.mjs';

const DATA = process.env.DATA_DIR || './data';
export const FOCAL_DIR = join(DATA, 'focal');
export const CENTER = { x: 0.5, y: 0.5 };
// En dessous de cette proportion d'image jetée, le centrage ne risque pas de couper le sujet.
export const MIN_LOSS = 0.12;

const cacheFile = key => join(FOCAL_DIR, String(key).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');

export function readFocal(key) {
  if (!key) return null;
  try {
    const j = JSON.parse(readFileSync(cacheFile(key), 'utf8'));
    if (Number.isFinite(j?.x) && Number.isFinite(j?.y)) return { x: j.x, y: j.y };
  } catch {}
  return null;
}

export function writeFocal(key, focal) {
  if (!key) return;
  try { mkdirSync(FOCAL_DIR, { recursive: true }); writeFileSync(cacheFile(key), JSON.stringify(focal)); } catch {}
}

// Proportion de l'image source jetée par un recadrage « remplir le cadre » (0 = rien, 0.5 = la moitié).
export function cropLoss({ srcW, srcH, outW, outH }) {
  if (!srcW || !srcH || !outW || !outH) return 0;
  const s = Math.max(outW / srcW, outH / srcH);
  return 1 - (outW * outH) / (srcW * s * srcH * s);
}

// Renvoie { focal, reason } — `reason` sert à tracer la décision dans les logs de génération.
export async function focalFor({ key, imgPath, srcW, srcH, outW, outH, token, model = 'sonnet', minLoss = MIN_LOSS }) {
  const loss = cropLoss({ srcW, srcH, outW, outH });
  const pct = Math.round(loss * 100);
  if (loss < minLoss) return { focal: CENTER, reason: `centré (seulement ${pct}% rogné)` };
  const cached = readFocal(key);
  if (cached) return { focal: cached, reason: `point focal en cache (${pct}% rogné)` };
  const f = await analyzeFraming(imgPath, { token, model });
  writeFocal(key, f);
  return { focal: f, reason: `point focal analysé x=${f.x} y=${f.y} (${pct}% rogné)` };
}

export function hasFocalCache(key) { return !!key && existsSync(cacheFile(key)); }
