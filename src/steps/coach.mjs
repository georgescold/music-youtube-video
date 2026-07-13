// CRON intelligent : collecte les stats des vidéos publiées, en tire des décisions (warm-up + reach),
// et rédige un rapport. S'appuie sur l'API Analytics (CTR/rétention) si dispo, sinon sur les vues.
import { dbSelect, dbInsert } from '../services/supabase.mjs';
import { getVideoStats } from '../services/youtube.mjs';
import { getVideoAnalytics } from '../services/youtubeAnalytics.mjs';
import { askClaude, extractJson } from '../services/claude.mjs';

const MIN_SAMPLE = 6;          // en dessous : on n'optimise pas, on reste en warm-up/exploration
const EXPLORE_RATE = 0.30;     // part d'exploration (émotions non encore éprouvées)

// Fenêtre YYYY-MM-DD (Analytics veut des dates).
function ymd(d) { return d.toISOString().slice(0, 10); }

// 1) Collecte : snapshot des stats de toutes les vidéos publiées de la chaîne.
export async function collectStats({ channel, creds, now, log = () => {} }) {
  const vids = await dbSelect('videos', `?channel_id=eq.${channel.id}&youtube_video_id=not.is.null&select=id,youtube_video_id,published_at,created_at&order=created_at.desc&limit=200`).catch(() => []);
  if (!vids.length) return { ok: true, captured: 0, analytics: false };
  const ids = vids.map(v => v.youtube_video_id);

  let dataStats = {};
  try { dataStats = await getVideoStats(ids, creds); } catch (e) { log('stats Data KO : ' + e.message); }

  const end = now || new Date();
  const start = new Date(end.getTime() - 90 * 86400000);
  const an = await getVideoAnalytics({ videoIds: ids, startDate: ymd(start), endDate: ymd(end), creds });
  const analyticsOk = an.ok && Object.keys(an.byVideo).length > 0;

  const rows = vids.map(v => {
    const d = dataStats[v.youtube_video_id] || {};
    const a = (an.byVideo || {})[v.youtube_video_id] || {};
    return {
      video_id: v.id, youtube_video_id: v.youtube_video_id, channel_id: channel.id,
      views: d.views ?? a.views ?? null, likes: d.likes ?? null, comments: d.comments ?? null,
      impressions: a.impressions ?? null, ctr: a.ctr ?? null,
      avg_view_pct: a.avgViewPct ?? null, avg_view_sec: a.avgViewSec ?? null, watch_time_min: a.watchTimeMin ?? null
    };
  });
  await dbInsert('video_stats', rows).catch(e => log('insert stats KO : ' + e.message));
  return { ok: true, captured: rows.length, analytics: analyticsOk, needsReauth: an.needsReauth };
}

// Score de reach : vitesse de vues (vues/jour), pondérée par la rétention quand elle est disponible.
// (CTR/impressions ne sont pas exposés par l'API Analytics pour une chaîne standard.)
function reachScore(v, stat, now) {
  const ageDays = Math.max(1, (now - new Date(v.published_at || v.created_at)) / 86400000);
  const velocity = (stat.views || 0) / ageDays;
  if (stat.avg_view_pct != null) return velocity * (0.5 + stat.avg_view_pct / 100); // récompense la rétention
  return velocity;
}

// 2) Analyse + décisions : agrégats par émotion/créneau/durée + synthèse Claude. Renvoie le coach_state.
export async function analyzeAndDecide({ channel, creds, token, now = new Date(), log = () => {} }) {
  const collect = await collectStats({ channel, creds, now, log });
  const vids = await dbSelect('videos', `?channel_id=eq.${channel.id}&youtube_video_id=not.is.null&select=id,title,emotion,duration_sec,published_at,created_at,status&order=created_at.desc&limit=200`).catch(() => []);
  // Dernier snapshot par vidéo.
  const stats = await dbSelect('video_stats', `?channel_id=eq.${channel.id}&order=captured_at.desc&limit=1000`).catch(() => []);
  const latest = {};
  for (const s of stats) if (!latest[s.video_id]) latest[s.video_id] = s;

  const scored = vids.filter(v => latest[v.id]).map(v => {
    const s = latest[v.id];
    const publishedHour = new Date(v.published_at || v.created_at).getHours();
    return { v, s, score: reachScore(v, s, now), hour: publishedHour, durMin: Math.round((v.duration_sec || 0) / 60), emotion: v.emotion };
  });

  const sample = scored.length;
  const byKey = (arr, key) => {
    const m = {};
    for (const r of arr) { const k = r[key]; if (k == null || k === '') continue; (m[k] = m[k] || []).push(r.score); }
    return Object.fromEntries(Object.entries(m).map(([k, xs]) => [k, { n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / xs.length }]));
  };
  const emotionPerf = byKey(scored, 'emotion');
  const hourPerf = byKey(scored, 'hour');
  const durPerf = byKey(scored.map(r => ({ ...r, durBucket: r.durMin ? Math.round(r.durMin / 15) * 15 : null })), 'durBucket');
  const best = (perf) => Object.entries(perf).sort((a, b) => b[1].avg - a[1].avg)[0]?.[0] ?? null;

  const published = vids.filter(v => v.status === 'published').length;
  const firstDate = vids.length ? new Date(vids[vids.length - 1].created_at) : now;
  const ageDays = Math.max(0, Math.round((now - firstDate) / 86400000));

  // Synthèse stratégique par Claude (facultative, dégrade sans token).
  let insights = '', recommendations = [];
  if (sample >= 3 && token) {
    try {
      const table = scored.slice(0, 40).map(r => `- « ${(r.emotion || '?')} » | ${r.durMin}min | ${r.hour}h | score ${r.score.toFixed(1)}${r.s.ctr != null ? ` | CTR ${r.s.ctr}%` : ''}${r.s.avg_view_pct != null ? ` | rétention ${r.s.avg_view_pct}%` : ''} | ${r.s.views ?? '?'} vues`).join('\n');
      const system = "Tu es coach growth YouTube. À partir des perfs réelles des vidéos d'une chaîne, tu donnes des décisions concrètes pour augmenter le reach. Réponds en JSON français.";
      const user = [
        `Chaîne : ${channel.name}. ${published} vidéos publiées, ${ageDays} jours d'ancienneté. Métriques : ${collect.analytics ? 'Analytics (CTR/rétention)' : 'vues/engagement'}.`,
        'Perfs par vidéo (score = reach) :', table, '',
        'Donne : "insights" (3-4 phrases sur ce qui marche/ne marche pas), "recommendations" (4 décisions concrètes et actionnables).',
        'Format EXACT : {"insights":"...","recommendations":["..."]}'
      ].join('\n');
      const j = extractJson(await askClaude(system, user, channel?.claude_model || 'sonnet', { token }));
      insights = String(j.insights || '').trim();
      recommendations = Array.isArray(j.recommendations) ? j.recommendations.filter(x => typeof x === 'string').map(x => x.trim()) : [];
    } catch (e) { log('coach Claude KO : ' + e.message); }
  }

  const state = {
    updated_at: now.toISOString(), sample_size: sample, published, age_days: ageDays,
    metrics_source: collect.analytics ? 'analytics' : 'data', needs_reauth: !!collect.needsReauth,
    emotion_perf: emotionPerf, hour_perf: hourPerf, duration_perf: durPerf,
    best_emotion: best(emotionPerf), best_hour: best(hourPerf) != null ? Number(best(hourPerf)) : null,
    best_duration_min: best(durPerf) != null ? Number(best(durPerf)) : null,
    insights, recommendations
  };
  return { ok: true, state, collect };
}

// Cadence warm-up : combien de vidéos/jour, en montant avec la maturité (plafonnée par max).
export function computeCadence({ publishedCount = 0, ageDays = 0, maxPerDay = 1 }) {
  let target = 1;                                   // socle : régularité
  if (publishedCount >= 30 && ageDays >= 30) target = 3;
  else if (publishedCount >= 14 && ageDays >= 14) target = 2;
  return Math.max(1, Math.min(maxPerDay, target));
}

// Choix d'émotion piloté par le coach : exploite les émotions gagnantes, tout en explorant.
// Renvoie { index, exploit }. `index` porte sur la palette.
export function chooseEmotionIndex({ palette = [], cursor = 0, coachState = null, rnd = 0.5 }) {
  if (!palette.length) return { index: -1, exploit: false };
  const perf = coachState?.emotion_perf || {};
  const enough = (coachState?.sample_size || 0) >= MIN_SAMPLE;
  if (!enough || rnd < EXPLORE_RATE) return { index: cursor % palette.length, exploit: false }; // rotation/exploration
  // Exploitation : meilleure émotion connue présente dans la palette.
  const ranked = Object.entries(perf).sort((a, b) => b[1].avg - a[1].avg).map(([name]) => name);
  for (const name of ranked) {
    const i = palette.findIndex(e => e.name === name);
    if (i >= 0) return { index: i, exploit: true };
  }
  return { index: cursor % palette.length, exploit: false };
}
