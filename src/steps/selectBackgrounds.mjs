// Sélection des images de fond avec règle anti-répétition.
// Règle : ne jamais réutiliser un fond utilisé dans les `gap` dernières vidéos (défaut 30).
// Mode 'single' -> 1 image par vidéo ; 'slideshow' -> `count` images (0 = toutes les éligibles).
import { dbSelect } from '../services/supabase.mjs';

// Renvoie { chosen: [asset...], warning: string|null }
export async function selectBackgrounds({ channelId, pool, mode = 'slideshow', count = 0, gap = 30 }) {
  if (!pool.length) return { chosen: [], warning: null };

  // Historique récent : fonds utilisés dans les `gap` dernières vidéos de la chaîne.
  const filter = channelId ? `?channel_id=eq.${channelId}&` : '?';
  const recent = await dbSelect('videos', `${filter}order=created_at.desc&limit=${gap}&select=background_asset_ids`);
  // recency[id] = distance en vidéos (0 = la plus récente) ; absent = jamais utilisé récemment.
  const recency = new Map();
  recent.forEach((v, i) => {
    for (const id of (Array.isArray(v.background_asset_ids) ? v.background_asset_ids : [])) {
      if (!recency.has(id)) recency.set(id, i);
    }
  });

  const eligible = pool.filter(a => !recency.has(a.id));       // pas utilisé dans les `gap` dernières
  const need = mode === 'single' ? 1 : (count > 0 ? count : pool.length);

  let chosen = [];
  let warning = null;

  if (eligible.length >= need) {
    // Assez d'images « fraîches » : on pioche en tournant (les moins récemment vues d'abord = ici jamais vues).
    chosen = pickSpread(eligible, need);
  } else {
    // Pas assez d'images fraîches -> on prend toutes les éligibles + on complète par les plus anciennes utilisées.
    const stale = pool
      .filter(a => recency.has(a.id))
      .sort((a, b) => recency.get(b.id) - recency.get(a.id)); // distance la plus grande d'abord (=le plus ancien)
    chosen = [...eligible, ...stale].slice(0, need);
    if (mode === 'single' || count > 0) {
      const needTotal = need * (gap + 1); // nb d'images pour ne jamais répéter dans la fenêtre d'écart
      warning = `Pas assez d'images de fond : ${pool.length} en banque pour un écart de ${gap} vidéos (il en faudrait au moins ${needTotal}). Une image récente a dû être réutilisée. Ajoute des images dans l'onglet Assets pour éviter les doublons.`;
    }
  }
  return { chosen, warning };
}

// Répartit le choix sur l'ensemble du pool (évite de toujours prendre les mêmes en tête de liste).
function pickSpread(arr, n) {
  if (n >= arr.length) return arr.slice();
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}
