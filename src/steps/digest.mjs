// Rapports Discord périodiques : rapport quotidien, détection "vidéo qui perce" (viral), paliers de vues, récap hebdo.
// S'appuie sur les snapshots video_stats (capturés par collectStats). Best-effort, ne casse jamais.
import { dbSelect, dbPatch } from '../services/supabase.mjs';
import { notifyChannel, COLORS } from '../services/notify.mjs';

const MILESTONES = [100, 1000, 10000, 100000, 1000000];
function fmt(n) { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' M'; if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + ' k'; return String(n); }

// Charge les vidéos en ligne + les 2 derniers snapshots par vidéo (pour calculer les gains).
async function loadData(channel) {
  const vids = await dbSelect('videos', `?channel_id=eq.${channel.id}&youtube_video_id=not.is.null&select=id,title,youtube_url,created_at,published_at,milestone_state&order=created_at.desc&limit=300`).catch(() => []);
  const snaps = await dbSelect('video_stats', `?channel_id=eq.${channel.id}&order=captured_at.desc&limit=3000&select=video_id,views,avg_view_pct,captured_at`).catch(() => []);
  const byVid = new Map();
  for (const s of snaps) { const a = byVid.get(s.video_id) || []; if (a.length < 2) { a.push(s); byVid.set(s.video_id, a); } }
  return { vids, byVid };
}

// Rapport quotidien + paliers + détection viral. À lancer après une capture de stats fraîche.
export async function sendDailyDigest(channel) {
  if (!channel || !channel.discord_webhook) return;
  const { vids, byVid } = await loadData(channel);
  const now = Date.now();
  let totalViews = 0, totalGain = 0, rSum = 0, rN = 0, postedToday = 0, top = null;

  for (const v of vids) {
    const ss = byVid.get(v.id) || [];
    const cur = ss[0], prev = ss[1];
    const views = cur?.views || 0;
    const gain = (cur && prev) ? Math.max(0, (cur.views || 0) - (prev.views || 0)) : 0;
    totalViews += views; totalGain += gain;
    if (cur?.avg_view_pct != null) { rSum += cur.avg_view_pct; rN++; }
    const posted = v.published_at || v.created_at;
    if (posted && (now - new Date(posted)) < 26 * 3600000) postedToday++;
    if (!top || views > top.views) top = { title: v.title, url: v.youtube_url, views };

    // Paliers + viral (on met à jour milestone_state pour ne notifier qu'une fois).
    const st = (v.milestone_state && typeof v.milestone_state === 'object') ? v.milestone_state : {};
    const doneMs = Array.isArray(st.milestones) ? st.milestones : [];
    const newMs = MILESTONES.filter(m => views >= m && !doneMs.includes(m));
    let changed = false;
    if (newMs.length) {
      const m = Math.max(...newMs);
      notifyChannel(channel, 'milestones', { title: '🏆 ' + fmt(m) + ' vues !', description: `**${v.title}** vient de dépasser ${fmt(m)} vues.`, color: COLORS.ok, url: v.youtube_url || undefined });
      st.milestones = [...doneMs, ...newMs]; changed = true;
    }
    // Viral : accélération anormale (vitesse récente très au-dessus de sa moyenne), une seule alerte.
    if (!st.viral && cur && prev && gain >= 150 && views >= 300) {
      const hours = Math.max(1, (new Date(cur.captured_at) - new Date(prev.captured_at)) / 3600000);
      const perDay = gain / hours * 24;
      const ageDays = Math.max(1, (now - new Date(posted)) / 86400000);
      const avgPerDay = views / ageDays;
      if (perDay >= 200 && perDay >= 3 * avgPerDay) {
        notifyChannel(channel, 'viral', { title: '🚀 Une vidéo perce !', description: `**${v.title}** décolle : ~${fmt(Math.round(perDay))} vues/jour (×${(perDay / avgPerDay).toFixed(1)} sa moyenne). C'est le moment de la pousser.`, color: 0x1f8b4c, url: v.youtube_url || undefined });
        st.viral = true; changed = true;
      }
    }
    if (changed) await dbPatch('videos', `id=eq.${v.id}`, { milestone_state: st }).catch(() => {});
  }

  const retention = rN ? Math.round(rSum / rN) : null;
  const lines = [
    `📹 ${postedToday} vidéo(s) postée(s) sur ~24 h`,
    `👁 ${fmt(totalViews)} vues au total${totalGain ? ` (+${fmt(totalGain)} depuis la dernière mesure)` : ''}`,
    retention != null ? `⏱ Rétention moyenne : ${retention} %` : '',
    top && top.views ? `🏆 Top : **${top.title}** — ${fmt(top.views)} vues` : ''
  ].filter(Boolean).join('\n');
  await notifyChannel(channel, 'daily_report', { title: '📊 Rapport quotidien — ' + (channel.name || ''), description: lines || 'Aucune donnée pour le moment.', color: COLORS.info, url: top?.url || undefined });
}

// Récap hebdomadaire : bilan de la semaine (vidéos postées, vues, top).
export async function sendWeeklyRecap(channel) {
  if (!channel || !channel.discord_webhook) return;
  const { vids, byVid } = await loadData(channel);
  const now = Date.now();
  let postedWeek = 0, totalViews = 0, top = null;
  for (const v of vids) {
    const views = (byVid.get(v.id) || [])[0]?.views || 0;
    totalViews += views;
    const posted = v.published_at || v.created_at;
    if (posted && (now - new Date(posted)) < 7.5 * 86400000) postedWeek++;
    if (!top || views > top.views) top = { title: v.title, views, url: v.youtube_url };
  }
  const lines = [
    `📅 ${postedWeek} vidéo(s) postée(s) cette semaine`,
    `👁 ${fmt(totalViews)} vues cumulées sur la chaîne`,
    top && top.views ? `🏆 Meilleure vidéo : **${top.title}** — ${fmt(top.views)} vues` : ''
  ].filter(Boolean).join('\n');
  await notifyChannel(channel, 'weekly_recap', { title: '🗓️ Récap de la semaine — ' + (channel.name || ''), description: lines, color: COLORS.info, url: top?.url || undefined });
}
