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

// Extrait un ID de vidéo depuis une URL (youtu.be, watch?v=, shorts, embed).
export function parseVideoId(input) {
  const s = String(input || '').trim();
  let m;
  if ((m = s.match(/youtu\.be\/([\w-]{11})/))) return m[1];
  if ((m = s.match(/[?&]v=([\w-]{11})/))) return m[1];
  if ((m = s.match(/youtube\.com\/(?:shorts|embed|live)\/([\w-]{11})/))) return m[1];
  return null;
}

// Détails de vidéos par ID (titre, miniature, vues). Par lots de 50.
export async function getVideosById(ids = []) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).join(',');
    const d = await api(`videos?part=snippet,statistics&id=${batch}`);
    for (const v of (d.items || [])) {
      out.push({
        videoId: v.id, title: v.snippet?.title, channelTitle: v.snippet?.channelTitle,
        publishedAt: v.snippet?.publishedAt, views: Number(v.statistics?.viewCount || 0),
        thumbnail: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || null
      });
    }
  }
  return out;
}

// Rassemble les vidéos de référence à partir d'un mélange d'URLs de VIDÉOS et/ou de CHAÎNES.
// Une URL de vidéo -> cette vidéo précise ; une chaîne/@handle -> ses vidéos récentes.
export async function collectReferenceVideos(urls = [], perChannel = 15, log = () => {}) {
  const out = [];
  const videoIds = [];
  for (const u of urls) {
    const vid = parseVideoId(u);
    if (vid) { videoIds.push(vid); continue; }
    try {
      const ch = await resolveChannel(u);
      if (ch?.id) { const vids = await getRecentVideos(ch.id, perChannel); out.push(...vids); log(`chaîne ${ch.title} — ${vids.length} vidéos`); }
    } catch (e) { log('réf ignorée : ' + e.message); }
  }
  if (videoIds.length) {
    try { const vids = await getVideosById(videoIds); out.push(...vids); log(`${vids.length} vidéo(s) de référence`); }
    catch (e) { log('vidéos réf KO : ' + e.message); }
  }
  return out;
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
