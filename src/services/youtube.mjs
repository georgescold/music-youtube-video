// Upload YouTube. Multi-tenant : chaque fonction accepte des credentials { clientId, clientSecret, refreshToken }.
// Par défaut, on lit l'env (compat mono-tenant). Access token courte durée re-demandé à chaque appel.
import { statSync, createReadStream, readFileSync } from 'node:fs';

function envCreds() {
  return {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN
  };
}

export async function getAccessToken(creds = envCreds()) {
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) throw new Error('credentials YouTube incomplets (client id/secret/refresh token)');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: 'refresh_token' })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`refresh token: ${r.status} ${data.error_description || data.error || JSON.stringify(data)}`);
  return data.access_token;
}

// Stats publiques de base (Data API) pour une liste de vidéos : vues, likes, commentaires.
export async function getVideoStats(videoIds = [], creds = envCreds()) {
  if (!videoIds.length) return {};
  const accessToken = await getAccessToken(creds);
  const out = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50).join(',');
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(`videos.list stats: ${r.status} ${JSON.stringify(d).slice(0, 160)}`);
    for (const v of (d.items || [])) {
      out[v.id] = {
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0)
      };
    }
  }
  return out;
}

export async function getMyChannel(creds = envCreds()) {
  const accessToken = await getAccessToken(creds);
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,status&mine=true', { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  if (!r.ok) throw new Error(`channels.list: ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data.items?.[0] || null;
}

export async function uploadVideo({ filePath, title, description, tags = [], privacyStatus = 'private', creds = envCreds() }) {
  const accessToken = await getAccessToken(creds);
  const metadata = { snippet: { title, description, tags }, status: { privacyStatus, selfDeclaredMadeForKids: false } };
  const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify(metadata)
  });
  if (!initRes.ok) throw new Error(`init upload: ${initRes.status} ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('init upload: pas de location retournée');
  const stat = statSync(filePath);
  const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) }, body: createReadStream(filePath), duplex: 'half' });
  const data = await putRes.json();
  if (!putRes.ok) throw new Error(`upload bytes: ${putRes.status} ${JSON.stringify(data)}`);
  return data;
}

export async function setThumbnail(videoId, filePath, creds = envCreds()) {
  const accessToken = await getAccessToken(creds);
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/png' }, body: readFileSync(filePath)
  });
  if (!r.ok) throw new Error(`thumbnail: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function setPrivacyStatus(videoId, privacyStatus, creds = envCreds()) {
  const accessToken = await getAccessToken(creds);
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
    method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, status: { privacyStatus } })
  });
  if (!r.ok) throw new Error(`update privacy: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function deleteVideo(videoId, creds = envCreds()) {
  const accessToken = await getAccessToken(creds);
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok && r.status !== 204) throw new Error(`delete: ${r.status} ${await r.text()}`);
}
