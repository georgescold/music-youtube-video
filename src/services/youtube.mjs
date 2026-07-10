// Upload YouTube via refresh token stocke (compte proprietaire de la chaine).
// Access token courte duree (1h) -> re-demande a chaque appel, jamais mis en cache.
import { statSync, createReadStream, readFileSync } from 'node:fs';

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`refresh token: ${r.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function uploadVideo({ filePath, title, description, tags = [], privacyStatus = 'private' }) {
  const accessToken = await getAccessToken();
  const metadata = {
    snippet: { title, description, tags },
    status: { privacyStatus, selfDeclaredMadeForKids: false }
  };

  const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'video/mp4'
    },
    body: JSON.stringify(metadata)
  });
  if (!initRes.ok) throw new Error(`init upload: ${initRes.status} ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('init upload: pas de location retournee');

  const stat = statSync(filePath);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) },
    body: createReadStream(filePath),
    duplex: 'half'
  });
  const data = await putRes.json();
  if (!putRes.ok) throw new Error(`upload bytes: ${putRes.status} ${JSON.stringify(data)}`);
  return data;
}

export async function setThumbnail(videoId, filePath) {
  const accessToken = await getAccessToken();
  const buf = readFileSync(filePath);
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/png' },
    body: buf
  });
  if (!r.ok) throw new Error(`thumbnail: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function setPrivacyStatus(videoId, privacyStatus) {
  const accessToken = await getAccessToken();
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, status: { privacyStatus } })
  });
  if (!r.ok) throw new Error(`update privacy: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function deleteVideo(videoId) {
  const accessToken = await getAccessToken();
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok && r.status !== 204) throw new Error(`delete: ${r.status} ${await r.text()}`);
}
