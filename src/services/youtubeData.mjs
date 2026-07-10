// Lecture publique via YouTube Data API (clé API, pas d'OAuth) : résout une chaîne d'inspiration
// et récupère ses vidéos récentes (titres + miniatures) pour en extraire des patterns.
const KEY = () => process.env.YOUTUBE_API_KEY;
const API = 'https://www.googleapis.com/youtube/v3';

async function api(path) {
  const r = await fetch(`${API}/${path}${path.includes('?') ? '&' : '?'}key=${KEY()}`);
  const d = await r.json();
  if (!r.ok) throw new Error(`YouTube Data ${r.status}: ${JSON.stringify(d.error?.message || d).slice(0, 160)}`);
  return d;
}

// Extrait un handle (@nom), un ID de chaîne (UC...) ou un nom depuis une URL/texte libre.
export function parseChannelRef(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/youtube\.com\/channel\/(UC[\w-]+)/i))) return { type: 'id', value: m[1] };
  if ((m = s.match(/youtube\.com\/@([\w.\-]+)/i))) return { type: 'handle', value: m[1] };
  if ((m = s.match(/youtube\.com\/(?:c|user)\/([\w.\-]+)/i))) return { type: 'search', value: m[1] };
  if (s.startsWith('@')) return { type: 'handle', value: s.slice(1) };
  if (/^UC[\w-]{20,}$/.test(s)) return { type: 'id', value: s };
  return { type: 'search', value: s };
}

// Renvoie { id, title } ou null.
export async function resolveChannel(input) {
  const ref = parseChannelRef(input);
  if (!ref) return null;
  if (ref.type === 'id') {
    const d = await api(`channels?part=snippet&id=${encodeURIComponent(ref.value)}`);
    const it = d.items?.[0]; return it ? { id: it.id, title: it.snippet.title } : null;
  }
  if (ref.type === 'handle') {
    const d = await api(`channels?part=snippet&forHandle=${encodeURIComponent(ref.value)}`);
    const it = d.items?.[0]; if (it) return { id: it.id, title: it.snippet.title };
  }
  // Repli : recherche par nom.
  const s = await api(`search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(ref.value)}`);
  const it = s.items?.[0];
  return it ? { id: it.snippet.channelId || it.id?.channelId, title: it.snippet.title } : null;
}

// Vidéos récentes d'une chaîne : titres + miniature + vues. Passe par la playlist "uploads".
export async function getRecentVideos(channelId, max = 15) {
  const ch = await api(`channels?part=contentDetails&id=${encodeURIComponent(channelId)}`);
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const pl = await api(`playlistItems?part=snippet,contentDetails&maxResults=${Math.min(50, max)}&playlistId=${uploads}`);
  const items = (pl.items || []).map(i => ({
    videoId: i.contentDetails?.videoId,
    title: i.snippet?.title,
    publishedAt: i.contentDetails?.videoPublishedAt || i.snippet?.publishedAt,
    thumbnail: i.snippet?.thumbnails?.high?.url || i.snippet?.thumbnails?.medium?.url || null
  })).filter(v => v.videoId && v.title);
  // Enrichit avec les vues (facultatif, aide à repérer ce qui marche).
  const ids = items.map(v => v.videoId).slice(0, 50).join(',');
  if (ids) {
    try {
      const st = await api(`videos?part=statistics&id=${ids}`);
      const byId = Object.fromEntries((st.items || []).map(v => [v.id, Number(v.statistics?.viewCount || 0)]));
      for (const v of items) v.views = byId[v.videoId] || 0;
    } catch { /* vues facultatives */ }
  }
  return items;
}
