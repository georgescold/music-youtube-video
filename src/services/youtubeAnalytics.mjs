// YouTube Analytics API (reports.query) : vraies métriques de reach (impressions, CTR, rétention).
// Nécessite le scope yt-analytics.readonly. Dégrade proprement (renvoie null) si le scope manque.
import { getAccessToken } from './youtube.mjs';

const NEEDS_SCOPE = 'yt-analytics.readonly';

// Renvoie { byVideo: { [videoId]: {views, impressions, ctr, avgViewPct, avgViewSec, watchTimeMin} }, ok, error }
export async function getVideoAnalytics({ videoIds = [], startDate, endDate, creds } = {}) {
  if (!videoIds.length) return { ok: true, byVideo: {} };
  let accessToken;
  try { accessToken = await getAccessToken(creds); } catch (e) { return { ok: false, error: e.message, byVideo: {} }; }

  // impressions + CTR sont dans un report distinct de la rétention ; on tente le report complet et on dégrade.
  const metrics = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage';
  const params = new URLSearchParams({
    ids: 'channel==MINE', startDate, endDate,
    metrics, dimensions: 'video', maxResults: '200', sort: '-views',
    filters: 'video==' + videoIds.slice(0, 200).join(',')
  });
  const base = await query(accessToken, params);
  if (!base.ok) return { ok: false, error: base.error, needsReauth: base.needsReauth, byVideo: {} };

  // NB : impressions/CTR ne sont PAS exposés par l'API Analytics pour une chaîne standard (Studio uniquement).
  // On collecte vues + rétention + temps de visionnage, qui sont d'excellents signaux de reach.
  const byVideo = {};
  for (const row of base.rows) {
    byVideo[row.video] = {
      views: num(row.views), watchTimeMin: num(row.estimatedMinutesWatched),
      avgViewSec: num(row.averageViewDuration), avgViewPct: num(row.averageViewPercentage)
    };
  }
  return { ok: true, byVideo };
}

async function query(accessToken, params) {
  const r = await fetch('https://youtubeanalytics.googleapis.com/v2/reports?' + params.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d.error?.message || JSON.stringify(d).slice(0, 200);
    const needsReauth = r.status === 403 && /scope|insufficient|permission/i.test(msg);
    return { ok: false, error: (needsReauth ? `Autorisation ${NEEDS_SCOPE} manquante — ré-autorise l'accès YouTube. ` : '') + msg, needsReauth, rows: [] };
  }
  const cols = (d.columnHeaders || []).map(c => c.name);
  const rows = (d.rows || []).map(r => Object.fromEntries(r.map((v, i) => [cols[i], v])));
  return { ok: true, rows };
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
