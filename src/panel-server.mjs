// Panneau de controle "The Playlist Youtube" : sert panel.html + API (auth, assets).
// Meme pattern que reddit-warmup : Node http natif, sans framework, sans build step.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dbSelect, dbInsert, dbPatch, dbDelete, storageUpload, storageSign, storageDelete } from './services/supabase.mjs';
import { runPipeline } from './pipeline.mjs';
import { setPrivacyStatus, deleteVideo, getMyChannel, setThumbnail, getVideoStats, buildAuthUrl, exchangeYouTubeCode } from './services/youtube.mjs';
import { getVideoAnalytics } from './services/youtubeAnalytics.mjs';
import { renderThumbnail, stripPlaylistTag, THUMB_FONTS } from './services/ffmpeg.mjs';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { testYouTube, testEpidemic, testClaude } from './services/connectionTests.mjs';
import { EPIDEMIC_AUTH_MESSAGE } from './services/epidemicMcp.mjs';
import { listChannels, getActiveChannel, getChannel, createChannel, setActiveChannel, updateChannel, channelCreds, channelPublicView, propagateSharedCreds } from './services/channels.mjs';
import { sendDiscord, notifyChannel, notifEnabled, NOTIF_TYPES, isDiscordWebhook, COLORS } from './services/notify.mjs';
import { sendDailyDigest, sendWeeklyRecap } from './steps/digest.mjs';
import { analyzeInspiration } from './steps/playbook.mjs';
import { deriveEmotions } from './steps/emotions.mjs';
import { generateSeoPlan } from './steps/seoPlan.mjs';
import { fetchBlogArticles } from './services/webAnalyze.mjs';
import { computeCadence, analyzeAndDecide, collectStats } from './steps/coach.mjs';
import { renderFiles, deleteRender } from './services/renders.mjs';
import { readFocal } from './services/focal.mjs';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
process.chdir(ROOT);

function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
loadEnv();

process.env.TZ = process.env.TZ || 'Europe/Paris';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PANEL_PORT || process.env.PORT) || 8770;
const DATA = process.env.DATA_DIR || './data';
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024; // marge sous la limite bucket (50 Mo)

// ── Etat de generation + planificateur quotidien ──
const genState = { running: false, videoId: null, phase: null, error: null, cancelled: false, startedAt: null, lastResult: null, log: [] };
let genTimer = null;
let coachTimer = null;
let statsTimer = null;
let weeklyTimer = null;
let genController = null;

function generateOnce({ dryRun = false, targetSec = null, titleOverride = '', backgroundAssetId = null, thumbnailAssetId = null, channelId = null } = {}) {
  if (genState.running) return false;
  const controller = { cancelled: false, child: null };
  genController = controller;
  Object.assign(genState, { running: true, error: null, cancelled: false, phase: 'démarrage', startedAt: Date.now(), videoId: null, channelId, log: [] });
  const pushLog = (m) => {
    const line = { t: Date.now(), m: String(m) };
    genState.phase = line.m; genState.log.push(line);
    if (genState.log.length > 600) genState.log.shift();
  };
  pushLog('démarrage de la génération…' + (titleOverride ? ` (titre imposé)` : '') + (targetSec ? ` (durée visée ${Math.round(targetSec / 60)} min)` : ''));
  runPipeline({ dryRun, targetSec, titleOverride, backgroundAssetId, thumbnailAssetId, channelId, controller, log: pushLog })
    .then(r => { Object.assign(genState, { running: false, lastResult: r, videoId: r.videoId, phase: 'terminé' }); pushLog('✅ terminé — vidéo prête'); })
    .catch(e => {
      const cancelled = controller.cancelled || /cancel/i.test(String(e.message || e));
      Object.assign(genState, { running: false, cancelled, error: cancelled ? null : String(e.message || e), phase: cancelled ? 'annulé' : 'échec' });
      pushLog(cancelled ? '⏹️ génération annulée' : ('❌ échec : ' + String(e.message || e)));
      if (!cancelled) console.error('[gen] échec', e);
    })
    .finally(() => { if (genController === controller) genController = null; });
  return true;
}

function toMinOfDay(hhmm) { const [h, m] = String(hhmm || '18:00').slice(0, 5).split(':').map(Number); return (h || 0) * 60 + (m || 0); }
// Minute-cible d'un créneau pour AUJOURD'HUI. « HH:MM » = exact ; « HH:MM-HH:MM » = fourchette : heure tirée
// au hasard MAIS stable dans la journée (hash du jour+index -> pas de jitter entre les ticks du cerveau).
function slotTargetMin(slot, index, dayKey) {
  const m = String(slot || '').match(/^(\d{2}):(\d{2})(?:-(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const a = (+m[1]) * 60 + (+m[2]);
  const b = m[3] != null ? (+m[3]) * 60 + (+m[4]) : a;
  const lo = Math.min(a, b), hi = Math.max(a, b), span = hi - lo;
  if (span === 0) return lo;
  let h = 0; const s = dayKey + '#' + index;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return lo + (h % (span + 1));
}
// Prochaines actions planifiées de la chaîne (pour le dashboard). Selon le mode (fixe = créneaux, auto = fenêtre+warm-up).
async function buildUpcoming(ch, now = new Date()) {
  if (!ch || !ch.cron_enabled) return { actions: [], next_label: null };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayKey = now.toISOString().slice(0, 10);
  const tomorrowKey = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const verb = ch.publish_mode === 'auto' ? 'Génération + publication (public)'
    : ch.publish_mode === 'draft' ? 'Génération + dépôt en privé (à publier toi-même)'
    : ch.publish_mode === 'local' ? 'Génération seule (à télécharger, aucun envoi YouTube)'
    : 'Génération (brouillon à valider)';
  const acts = [];
  const modeFixed = ch.publish_schedule_mode === 'fixed' || (!ch.publish_schedule_mode && Array.isArray(ch.publish_times) && ch.publish_times.length > 0);
  if (modeFixed) {
    const slots = (ch.publish_times || []).filter(t => /^\d{2}:\d{2}(-\d{2}:\d{2})?$/.test(t));
    const targets = slots.map((t, i) => slotTargetMin(t, i, todayKey)).filter(x => x != null).sort((a, b) => a - b);
    for (const m of targets.filter(m => m > nowMin)) acts.push({ label: verb, detail: "aujourd'hui " + fmt(m), when: todayKey + 'T' + fmt(m) });
    const tTargets = slots.map((t, i) => slotTargetMin(t, i, tomorrowKey)).filter(x => x != null).sort((a, b) => a - b);
    if (tTargets.length) acts.push({ label: verb, detail: 'demain ' + fmt(tTargets[0]), when: tomorrowKey + 'T' + fmt(tTargets[0]) });
  } else {
    const start = ch.publish_time_start || (ch.daily_publish_time ? String(ch.daily_publish_time).slice(0, 5) : '18:00');
    const end = ch.publish_time_end || start;
    const { published, ageDays } = await channelMaturity(ch.id).catch(() => ({ published: 0, ageDays: 0 }));
    const cadence = computeCadence({ publishedCount: published, ageDays, maxPerDay: ch.max_posts_per_day || 1 });
    const done = await generatedToday(ch.id).catch(() => 0);
    const remaining = Math.max(0, cadence - done);
    if (remaining > 0 && nowMin <= toMinOfDay(end)) acts.push({ label: verb, detail: "aujourd'hui dans la fenêtre " + start + '–' + end + ' (reste ' + remaining + ')', when: null });
    else acts.push({ label: verb, detail: 'demain dans la fenêtre ' + start + '–' + end + " (jusqu'à " + cadence + ')', when: tomorrowKey });
  }
  return { actions: acts.slice(0, 6), next_label: acts[0]?.detail || null };
}
function windowDates(start, end, now) {
  let a = toMinOfDay(start), b = toMinOfDay(end); if (b < a) b += 1440;
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  return { startDt: new Date(midnight.getTime() + a * 60000), endDt: new Date(midnight.getTime() + b * 60000) };
}
function pickInRange(fromDt, toDt) { const span = Math.max(0, toDt - fromDt); return new Date(fromDt.getTime() + Math.random() * span); }

async function channelMaturity(chId) {
  const pub = await dbSelect('videos', `?channel_id=eq.${chId}&status=eq.published&select=id`).catch(() => []);
  const first = await dbSelect('videos', `?channel_id=eq.${chId}&select=created_at&order=created_at.asc&limit=1`).catch(() => []);
  const ageDays = first[0] ? Math.round((Date.now() - new Date(first[0].created_at)) / 86400000) : 0;
  return { published: pub.length, ageDays };
}
async function generatedToday(chId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const rows = await dbSelect('videos', `?channel_id=eq.${chId}&created_at=gte.${start.toISOString()}&select=id`).catch(() => []);
  return rows.length;
}

// ── CERVEAU D'AUTOMATISATION MULTI-CHAÎNES ──
// Quota YouTube = PAR PROJET GOOGLE (client OAuth), donc PARTAGÉ par toutes les chaînes du même client.
// Un upload coûte ~1600 unités / 10000 par jour -> ~5-6 vidéos/jour cumulées. On plafonne pour éviter quotaExceeded.
const DAILY_UPLOAD_BUDGET = Number(process.env.DAILY_UPLOAD_BUDGET) || 5;
const BRAIN_TICK_MS = 7 * 60 * 1000;
let quotaNotified = {}; // 'client|YYYY-MM-DD' -> déjà notifié (une alerte quota/jour/client)
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

// Uploads RÉUSSIS aujourd'hui, regroupés par client OAuth (le quota Google est partagé au niveau du client).
async function uploadsTodayByClient(chans) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const vids = await dbSelect('videos', `?created_at=gte.${start.toISOString()}&youtube_video_id=not.is.null&select=channel_id`).catch(() => []);
  const clientOf = {}; for (const c of chans) clientOf[c.id] = c.yt_client_id || 'none';
  const byClient = {};
  for (const v of vids) { const cl = clientOf[v.channel_id] || 'none'; byClient[cl] = (byClient[cl] || 0) + 1; }
  return byClient;
}

// Le cerveau : tourne en continu, évalue TOUTES les chaînes en CRON, respecte fenêtre + warm-up (par chaîne)
// + budget quota (partagé par client), et lance UNE génération à la fois (sérialisée). Alerte Discord si blocage.
async function setupScheduler() {
  if (genTimer) clearTimeout(genTimer);
  genTimer = setTimeout(async () => { await brainTick().catch(e => console.error('[cerveau]', e.message)); setupScheduler(); }, BRAIN_TICK_MS);
  brainTick().catch(e => console.error('[cerveau]', e.message)); // évalue aussi tout de suite
}
async function brainTick() {
  const all = await listChannels().catch(() => []);
  const chans = all.filter(c => c.cron_enabled);
  if (!chans.length) return;
  if (genState.running) return; // une seule génération à la fois -> protège le quota et les ressources
  const byClient = await uploadsTodayByClient(all);
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const ch of shuffle(chans)) { // mélange = équité entre chaînes
    // Planning : mode « fixed » = créneaux-fourchettes fixés à la main ; mode « auto » = fenêtre + warm-up.
    const times = Array.isArray(ch.publish_times) ? ch.publish_times.filter(t => /^\d{2}:\d{2}(-\d{2}:\d{2})?$/.test(t)) : [];
    const modeFixed = ch.publish_schedule_mode === 'fixed' || (!ch.publish_schedule_mode && times.length > 0);
    let due;
    if (modeFixed) {
      if (!times.length) continue;                                     // mode heures précises mais aucun créneau -> rien
      // Anti-rattrapage : si le planning a été (re)programmé AUJOURD'HUI, on ignore les créneaux déjà passés
      // à ce moment-là (on ne rattrape pas rétroactivement une heure antérieure au réglage).
      const setAt = ch.schedule_set_at ? new Date(ch.schedule_set_at) : null;
      const setMin = (setAt && setAt.toISOString().slice(0, 10) === todayKey) ? (setAt.getHours() * 60 + setAt.getMinutes()) : -1;
      due = times.filter((t, i) => { const m = slotTargetMin(t, i, todayKey); return m != null && m > setMin && nowMin >= m; }).length;
      if (due === 0) continue;                                         // pas encore l'heure du 1er créneau (ou déjà passés au réglage)
    } else {
      const start = ch.publish_time_start || (ch.daily_publish_time ? String(ch.daily_publish_time).slice(0, 5) : '18:00');
      const end = ch.publish_time_end || start;
      const { startDt, endDt } = windowDates(start, end, now);
      if (now < startDt || now > endDt) continue;                       // hors fenêtre horaire
      const { published, ageDays } = await channelMaturity(ch.id);
      due = computeCadence({ publishedCount: published, ageDays, maxPerDay: ch.max_posts_per_day || 1 }); // warm-up
    }
    if ((await generatedToday(ch.id)) >= due) continue;                 // déjà fait tous les créneaux dus
    const client = ch.yt_client_id || 'none';
    if ((byClient[client] || 0) >= DAILY_UPLOAD_BUDGET) {              // budget quota PARTAGÉ atteint
      const k = client + '|' + todayKey;
      if (!quotaNotified[k]) { quotaNotified[k] = true; notifyChannel(ch, 'quota', { title: '🚦 Quota YouTube du jour atteint', description: `Le budget d'uploads du jour (${DAILY_UPLOAD_BUDGET}) — partagé par les chaînes de ce compte Google — est atteint. Les générations reprendront demain. Pour en poster plus, demande une hausse de quota côté Google Cloud.`, color: COLORS.warn }); }
      continue;
    }
    console.log(`[cerveau] génération « ${ch.name} » — ${due} du à ${byClient[client] || 0}/${DAILY_UPLOAD_BUDGET} (quota)`);
    generateOnce({ dryRun: false, channelId: ch.id });
    return; // une génération par tick (sérialisée)
  }
}

// CRON intelligent : analyse quotidienne des stats + décisions + rapport Discord.
async function setupCoach() {
  if (coachTimer) clearTimeout(coachTimer);
  const now = new Date();
  const at = new Date(now); at.setHours(9, 0, 0, 0); if (at <= now) at.setDate(at.getDate() + 1); // tous les jours ~09:00
  coachTimer = setTimeout(async () => { await runCoach().catch(e => console.error('[coach]', e.message)); setupCoach(); }, at - now);
  console.log(`[coach] prochaine analyse ${at.toLocaleString('fr-FR')}`);
}
async function runCoach({ force = false } = {}) {
  const ch = await getActiveChannel().catch(() => null);
  if (!ch) return { ok: false, error: 'aucune chaîne active' };
  if (!ch.coach_enabled && !force) return { ok: false, error: 'coach désactivé' };
  const creds = channelCreds(ch).youtube;
  const token = channelCreds(ch).claudeToken;
  const r = await analyzeAndDecide({ channel: ch, creds, token, log: m => console.log('[coach]', m) });
  if (!r.ok) return r;
  await updateChannel(ch.id, { coach_state: r.state, coach_updated_at: new Date().toISOString() }).catch(() => {});
  if (ch.discord_webhook) {
    const s = r.state;
    const lines = [
      `📊 ${s.published} publiées · ${s.sample_size} analysées · source ${s.metrics_source}`,
      s.best_emotion ? `Meilleure émotion : ${s.best_emotion}` : '',
      s.best_hour != null ? `Meilleur créneau : ${s.best_hour}h` : '',
      s.best_duration_min ? `Meilleure durée : ~${s.best_duration_min} min` : '',
      s.insights ? '\n' + s.insights : '',
      (s.recommendations || []).length ? '\nDécisions :\n• ' + s.recommendations.join('\n• ') : '',
      s.needs_reauth ? '\n⚠️ Ré-autorise l\'accès YouTube pour les métriques Analytics (CTR/rétention).' : ''
    ].filter(Boolean).join('\n');
    notifyChannel(ch, 'coach_report', { title: '🧠 Rapport du coach — ' + ch.name, description: lines.slice(0, 1800), color: COLORS.info });
  }
  return r;
}

// ── Mise à jour des stats (léger : snapshot vues/rétention -> video_stats). Manuel ou quotidien. ──
// (Re)génère le plan SEO d'une chaîne en analysant le site du produit. Utilisé en arrière-plan
// dès qu'un site produit est renseigné/changé — le SEO est ancré sur le vrai produit, par défaut.
async function autoGenerateSeoPlan(ch) {
  if (!ch) return;
  try {
    const urls = Array.isArray(ch.inspiration_urls) ? ch.inspiration_urls : [];
    const refs = await dbSelect('reference_songs', `?active=eq.true&channel_id=eq.${ch.id}&select=title`).catch(() => []);
    const token = channelCreds(ch).claudeToken;
    const r = await generateSeoPlan({ objective: ch.objective || '', productDesc: ch.product_desc || '', productUrl: ch.product_url || '', inspirationUrls: urls, references: refs, token, model: ch.claude_model || 'sonnet', log: m => console.log('[seo:auto]', m) });
    const patch = {};
    if (r.ok) { patch.seo_plan = r.plan; patch.seo_plan_updated_at = new Date().toISOString(); }
    // Articles de blog du produit (pour les liens « À lire aussi » dans les descriptions).
    if (ch.product_url) {
      const blog = await fetchBlogArticles(ch.product_url, { log: m => console.log('[blog:auto]', m) }).catch(() => ({ ok: false }));
      if (blog.ok) { patch.blog_articles = blog.articles; patch.blog_articles_updated_at = new Date().toISOString(); }
    }
    // Palette d'émotions : nécessaire au coach (source d'émotion par défaut). Dérivée si absente.
    if (!(Array.isArray(ch.emotion_palette) && ch.emotion_palette.length)) {
      const refsE = await dbSelect('reference_songs', `?active=eq.true&channel_id=eq.${ch.id}&select=title,artist,mood_tags`).catch(() => []);
      const em = await deriveEmotions({ inspirationUrls: urls, references: refsE, token, model: ch.claude_model || 'sonnet', log: m => console.log('[emotions:auto]', m) }).catch(() => ({ ok: false }));
      if (em.ok && em.emotions.length) { patch.emotion_palette = em.emotions; patch.emotion_cursor = 0; patch.emotion_palette_updated_at = new Date().toISOString(); }
    }
    if (Object.keys(patch).length) { await updateChannel(ch.id, patch); console.log('[seo:auto] MàJ pour', ch.name, '— plan:', r.ok, 'articles:', patch.blog_articles?.length ?? '—', 'émotions:', patch.emotion_palette?.length ?? '—'); }
  } catch (e) { console.error('[seo:auto] KO', e.message); }
}

async function refreshStats(ch) {
  if (!ch) return { ok: false, error: 'aucune chaîne' };
  const r = await collectStats({ channel: ch, creds: channelCreds(ch).youtube, now: new Date(), log: m => console.log('[stats]', m) }).catch(e => ({ ok: false, error: e.message }));
  await updateChannel(ch.id, { stats_updated_at: new Date().toISOString() }).catch(() => {});
  return r;
}
// Planifie une MàJ quotidienne des stats (~08:00) pour la chaîne active, si stats_daily est activé.
async function setupStatsRefresh() {
  if (statsTimer) clearTimeout(statsTimer);
  const ch0 = await getActiveChannel().catch(() => null);
  const hour = Math.max(0, Math.min(23, ch0?.daily_report_hour ?? 8));
  const now = new Date();
  const at = new Date(now); at.setHours(hour, 0, 0, 0); if (at <= now) at.setDate(at.getDate() + 1);
  statsTimer = setTimeout(async () => {
    // Multi-chaînes : MàJ des stats + rapport quotidien pour CHAQUE chaîne (pas seulement l'active).
    for (const ch of await listChannels().catch(() => [])) {
      const wantsStatsNotif = ch.discord_webhook && (notifEnabled(ch, 'daily_report') || notifEnabled(ch, 'viral') || notifEnabled(ch, 'milestones'));
      if (ch.stats_daily || wantsStatsNotif) { console.log('[stats] MàJ quotidienne — ' + ch.name); await refreshStats(ch).catch(e => console.error('[stats]', e.message)); }
      await sendDailyDigest(ch).catch(e => console.error('[digest]', e.message));
    }
    setupStatsRefresh();
  }, at - now);
}
// Récap hebdomadaire (lundi ~09:00) pour TOUTES les chaînes.
async function setupWeeklyRecap() {
  if (weeklyTimer) clearTimeout(weeklyTimer);
  const now = new Date();
  const at = new Date(now); at.setHours(9, 0, 0, 0);
  let add = (1 - at.getDay() + 7) % 7; if (add === 0 && at <= now) add = 7; // prochain lundi
  at.setDate(at.getDate() + add);
  weeklyTimer = setTimeout(async () => {
    for (const ch of await listChannels().catch(() => [])) await sendWeeklyRecap(ch).catch(e => console.error('[recap]', e.message));
    setupWeeklyRecap();
  }, at - now);
}

// ── Comptes (email + mot de passe) + session par cookie signe (HMAC). 1er inscrit = proprietaire,
// puis l'inscription se ferme. En local (hote non public) et tant qu'aucun compte n'existe -> ouvert. ──
const usersFile = () => join(DATA, 'users.json');
function loadUsers() { try { const u = JSON.parse(readFileSync(usersFile(), 'utf8')); return Array.isArray(u) ? u : []; } catch { return []; } }
function saveUsers(list) { try { mkdirSync(DATA, { recursive: true }); writeFileSync(usersFile(), JSON.stringify(list, null, 2)); } catch (e) { console.error('users save KO', e.message); } }
function userByEmail(email) { const e = String(email || '').trim().toLowerCase(); return loadUsers().find(u => u.email === e) || null; }
function hashPassword(password, salt = randomBytes(16).toString('hex')) { return { salt, hash: scryptSync(String(password), salt, 64).toString('hex') }; }
function verifyPassword(password, salt, hash) {
  try { const h = scryptSync(String(password), salt, 64).toString('hex'); return timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex')); } catch { return false; }
}
let _secret = null;
function sessionSecret() {
  if (_secret) return _secret;
  const f = join(DATA, '.session-secret');
  try { _secret = readFileSync(f, 'utf8').trim(); if (_secret) return _secret; } catch {}
  _secret = randomBytes(32).toString('hex');
  try { mkdirSync(DATA, { recursive: true }); writeFileSync(f, _secret); } catch {}
  return _secret;
}
function makeAuthCookie(email) {
  const e = Buffer.from(String(email).toLowerCase()).toString('base64url');
  return e + '.' + createHmac('sha256', sessionSecret()).update(e).digest('base64url');
}
function emailFromCookie(c) {
  const [e, sig] = String(c || '').split('.');
  if (!e || !sig) return null;
  const expect = createHmac('sha256', sessionSecret()).update(e).digest('base64url');
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return Buffer.from(e, 'base64url').toString();
}
function parseCookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }); return out; }
function setAuthCookie(req, res, email) {
  const secure = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `auth=${makeAuthCookie(email)}; Max-Age=${60 * 60 * 24 * 30}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}
function clearAuthCookie(res) { res.setHeader('Set-Cookie', 'auth=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'); }
function authOk(req) {
  const email = emailFromCookie(parseCookies(req).auth);
  if (email && userByEmail(email)) return true;
  if (HOST !== '0.0.0.0' && loadUsers().length === 0) return true; // dev local, aucun compte -> ouvert
  return false;
}

const send = (res, code, type, b) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(b); };
const json = (res, obj, code = 200) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
async function readJsonBody(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 2e6) break; } try { return JSON.parse(b || '{}'); } catch { return {}; } }

function authPage(mode) {
  const signup = mode === 'signup';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${signup ? 'Créer un compte' : 'Connexion'} — The Playlist Youtube</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --font-sans:"Manrope",ui-sans-serif,system-ui,-apple-system,sans-serif;
  --color-paper:#ffffff; --color-soft:#faf8f4; --color-soft2:#f2efe9;
  --color-ink:#181715; --color-mut:#6e6a62; --color-rule:#ece9e3; --color-rule2:#dedad2;
  --danger:#b3413a; --success:#3f7a55;
}
html{color-scheme:light}
*{box-sizing:border-box;font-family:var(--font-sans)}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--color-soft);padding:20px}
.card{background:var(--color-paper);border:1px solid var(--color-rule);border-radius:14px;padding:32px 28px;width:min(380px,94vw)}
h1{font-size:18px;font-weight:700;margin:0 0 4px;color:var(--color-ink);letter-spacing:-.01em}
.sub{color:var(--color-mut);font-size:13px;margin:0 0 22px}
label{display:block;font-size:12px;font-weight:600;color:var(--color-mut);margin:14px 0 5px}
input{width:100%;padding:9px 11px;background:var(--color-paper);border:1px solid var(--color-rule2);border-radius:8px;font-size:14px;outline:none;color:var(--color-ink)}
input:focus{border-color:var(--color-ink)}
button{width:100%;margin-top:20px;padding:10px;background:var(--color-ink);color:var(--color-paper);border:0;border-radius:100px;font-size:13.5px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5}
.msg{margin-top:12px;font-size:12.5px;min-height:16px}
.err{color:var(--danger)}.ok{color:var(--success)}
.theme-toggle{position:fixed;top:16px;right:16px;background:var(--color-paper);color:var(--color-ink);border:1px solid var(--color-rule2);border-radius:100px;padding:6px 11px;font-size:14px;line-height:1;cursor:pointer;width:auto;margin:0}
</style>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/theme.css">
<script>(function(){try{var t=localStorage.getItem('abm-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head><body>
<button class="theme-toggle" type="button" aria-label="Thème"></button>
<div class="card">
  <img src="/logo.png" alt="" style="height:24px;display:block;margin-bottom:16px">
  <h1>${signup ? 'Crée ton compte' : 'The Playlist Youtube'}</h1>
  <p class="sub">${signup ? 'Premier compte = propriétaire du panneau.' : 'Connexion au panneau'}</p>
  <form id="f">
    <label>Email</label><input id="email" type="email" autocomplete="username" required>
    <label>Mot de passe</label><input id="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
    <button id="btn" type="submit">${signup ? 'Créer mon compte' : 'Se connecter'}</button>
    <div class="msg" id="msg"></div>
  </form>
</div>
<script>
const f=document.getElementById('f'),msg=document.getElementById('msg'),btn=document.getElementById('btn');
f.onsubmit=async e=>{e.preventDefault();btn.disabled=true;msg.className='msg';msg.textContent='…';
 const body={email:email.value.trim(),password:password.value};
 try{const r=await fetch('/api/auth/${signup ? 'signup' : 'login'}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  if(d.ok){msg.className='msg ok';msg.textContent='Connecté, redirection…';location.href='/';}
  else{msg.className='msg err';msg.textContent=d.error||'Erreur';btn.disabled=false;}
 }catch(err){msg.className='msg err';msg.textContent='Erreur réseau';btn.disabled=false;}
};
</script>
<script src="/theme.js"></script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const q = url.searchParams;

    if (req.method === 'GET' && path === '/favicon.svg') {
      return readFile(join(__dirname, 'favicon.svg')).then(b => send(res, 200, 'image/svg+xml; charset=utf-8', b)).catch(() => send(res, 404, 'text/plain', ''));
    }
    if (req.method === 'GET' && /^\/fonts\/(playfair|inter|cormorant)\.ttf$/.test(path)) {
      const key = path.match(/^\/fonts\/(\w+)\.ttf$/)[1];
      return readFile(join(__dirname, 'assets', 'fonts', THUMB_FONTS[key])).then(b => send(res, 200, 'font/ttf', b)).catch(() => send(res, 404, 'text/plain', ''));
    }
    if (req.method === 'GET' && path === '/theme.css') {
      return readFile(join(__dirname, 'theme.css')).then(b => send(res, 200, 'text/css; charset=utf-8', b)).catch(() => send(res, 404, 'text/plain', ''));
    }
    if (req.method === 'GET' && path === '/theme.js') {
      return readFile(join(__dirname, 'theme.js')).then(b => send(res, 200, 'text/javascript; charset=utf-8', b)).catch(() => send(res, 404, 'text/plain', ''));
    }
    if (req.method === 'GET' && path === '/logo.png') {
      return readFile(join(__dirname, 'logo.png')).then(b => send(res, 200, 'image/png', b)).catch(() => send(res, 404, 'text/plain', ''));
    }
    if (req.method === 'GET' && path === '/login') return send(res, 200, 'text/html; charset=utf-8', authPage('login'));
    if (req.method === 'GET' && path === '/signup') return send(res, 200, 'text/html; charset=utf-8', authPage(loadUsers().length ? 'login' : 'signup'));
    if (req.method === 'POST' && path === '/api/auth/signup') {
      const b = await readJsonBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const pw = String(b.password || '');
      if (loadUsers().length) return json(res, { ok: false, error: 'Un compte existe déjà — connecte-toi.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, { ok: false, error: 'Email invalide.' });
      if (pw.length < 6) return json(res, { ok: false, error: 'Mot de passe : 6 caractères minimum.' });
      const { salt, hash } = hashPassword(pw);
      saveUsers([{ email, salt, hash, createdAt: new Date().toISOString() }]);
      setAuthCookie(req, res, email);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      const b = await readJsonBody(req);
      const u = userByEmail(b.email);
      if (!u || !verifyPassword(String(b.password || ''), u.salt, u.hash)) return json(res, { ok: false, error: 'Email ou mot de passe incorrect.' });
      setAuthCookie(req, res, u.email);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/auth/logout') { clearAuthCookie(res); return json(res, { ok: true }); }

    // Renouvellement automatique du jeton Epidemic (poussé par le job planifié GitHub Actions).
    // Protégé par un secret partagé (pas par le cookie de session) car appelé de machine à machine.
    if (req.method === 'POST' && path === '/api/settings/epidemic-token') {
      const secret = process.env.EPIDEMIC_REFRESH_SECRET;
      if (!secret || req.headers['x-refresh-secret'] !== secret) return json(res, { ok: false, error: 'non autorisé' }, 401);
      const b = await readJsonBody(req).catch(() => ({}));
      // Auth de session par COOKIES (méthode robuste, poussée par le job GitHub) ; le JWT reste accepté en secours.
      const cookies = typeof b.cookies === 'string' ? b.cookies.trim() : (Array.isArray(b.cookies) ? JSON.stringify(b.cookies) : '');
      const jwt = typeof b.jwt === 'string' ? b.jwt.trim() : '';
      if (!cookies && !jwt) return json(res, { ok: false, error: 'cookies ou jwt requis' });
      // On valide AVANT de stocker (ne jamais écraser une session qui marche par une morte).
      const auth = cookies ? { cookies } : { jwt };
      const test = await testEpidemic(auth).catch(() => ({ ok: false, detail: 'test échoué' }));
      if (!test.ok) return json(res, { ok: false, error: 'auth Epidemic fournie invalide : ' + (test.detail || '') });
      const patch = cookies ? { epidemic_cookies: cookies } : { epidemic_jwt: jwt };
      await propagateSharedCreds(patch).catch(() => {}); // partagé -> toutes les chaînes
      // Reprise auto : nettoie les tentatives mortes faute d'Epidemic (le CRON régénérera avec la session fraîche).
      const stuck = await dbSelect('videos', `?status=eq.failed&note=eq.epidemic_auth&select=id`).catch(() => []);
      if (stuck.length) await dbDelete('videos', `status=eq.failed&note=eq.epidemic_auth`).catch(() => {});
      console.log(`[epidemic-refresh] ${cookies ? 'cookies' : 'jwt'} mis à jour (${stuck.length} échec(s) nettoyé(s))`);
      return json(res, { ok: true, cleaned: stuck.length });
    }

    if (!authOk(req)) {
      if ((req.headers.accept || '').includes('text/html')) { res.writeHead(302, { location: loadUsers().length ? '/login' : '/signup' }); return res.end(); }
      return json(res, { error: 'Non authentifié' }, 401);
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(__dirname, 'panel.html')));
    }
    if (req.method === 'GET' && path === '/references') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(__dirname, 'references.html')));
    }
    if (req.method === 'GET' && path === '/videos') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(__dirname, 'videos.html')));
    }
    if (req.method === 'GET' && path === '/settings') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(__dirname, 'settings.html')));
    }
    if (req.method === 'GET' && path === '/onboarding') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(__dirname, 'onboarding.html')));
    }

    // ── Connexion YouTube en un clic (OAuth navigateur) : redirige vers Google, revient sur /oauth/youtube/callback. ──
    const oauthRedirect = () => ((req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')) + '://' + req.headers.host + '/oauth/youtube/callback');
    if (req.method === 'GET' && path === '/oauth/youtube/start') {
      const chId = q.get('channel');
      const ch = chId ? await getChannel(chId) : await getActiveChannel();
      if (!ch) return send(res, 400, 'text/html', '<p>Chaîne introuvable.</p>');
      const creds = channelCreds(ch).youtube;
      if (!creds.clientId) return send(res, 400, 'text/html', '<p>Client OAuth Google manquant (Paramètres).</p>');
      res.writeHead(302, { location: buildAuthUrl({ clientId: creds.clientId, redirectUri: oauthRedirect(), state: ch.id }) });
      return res.end();
    }
    if (req.method === 'GET' && path === '/oauth/youtube/callback') {
      const code = q.get('code'), chId = q.get('state'), err = q.get('error');
      const done = (ok, msg) => send(res, 200, 'text/html; charset=utf-8',
        `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
         <div><div style="font-size:40px">${ok ? '✅' : '⚠️'}</div><p style="max-width:420px">${msg}</p><p style="color:#888;font-size:13px">Tu peux fermer cette fenêtre.</p></div>
         <script>try{window.opener&&window.opener.postMessage({ytoauth:${ok ? 'true' : 'false'}},'*')}catch(e){}setTimeout(function(){window.close()},${ok ? 1200 : 6000})</script></body>`);
      if (err) return done(false, 'Autorisation refusée : ' + err);
      const ch = chId ? await getChannel(chId) : null;
      if (!code || !ch) return done(false, 'Requête invalide.');
      try {
        const creds = channelCreds(ch).youtube;
        const r = await exchangeYouTubeCode({ code, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: oauthRedirect() });
        if (!r.refreshToken) return done(false, 'Google n\'a pas renvoyé de refresh token. Réessaie en cochant bien le consentement.');
        const updated = await updateChannel(ch.id, { yt_refresh_token: r.refreshToken, ...(r.channelId ? { yt_channel_id: r.channelId } : {}) });
        setupScheduler().catch(() => {});
        // Prévient (une fois) si la chaîne n'est pas vérifiée : la miniature perso et les vidéos > 15 min l'exigent.
        try {
          const yt = await getMyChannel(channelCreds(updated).youtube);
          const lu = yt?.status?.longUploadsStatus;
          if (lu && lu !== 'allowed' && lu !== 'eligible') {
            notifyChannel(updated, 'youtube_unverified', { title: '⚠️ Chaîne YouTube à vérifier', description: 'La chaîne « ' + (r.channelTitle || updated.name) + ' » n\'est pas vérifiée. La miniature personnalisée et les vidéos de +15 min nécessitent une vérification par téléphone : https://www.youtube.com/verify', color: COLORS.warn, url: 'https://www.youtube.com/verify' });
          }
        } catch (e) {}
        return done(true, 'Chaîne YouTube connectée' + (r.channelTitle ? ' : « ' + r.channelTitle + ' »' : '') + ' !');
      } catch (e) {
        return done(false, 'Échec de connexion : ' + String(e.message || e).slice(0, 200));
      }
    }

    // ── Assets ──
    if (req.method === 'GET' && path === '/api/assets') {
      const ch = await getActiveChannel();
      const rows = await dbSelect('assets', (ch ? `?channel_id=eq.${ch.id}&` : '?') + 'order=uploaded_at.desc');
      const withUrls = await Promise.all(rows.map(async r => ({ ...r, url: await storageSign('assets', r.storage_path).catch(() => null) })));
      return json(res, withUrls);
    }
    // Re-téléchargement d'un asset déjà envoyé. On relaie le fichier depuis le stockage plutôt que de
    // renvoyer l'URL signée : le navigateur ignore l'attribut `download` en cross-origin (il ouvrirait
    // l'image dans un onglet). Ici on force la pièce jointe, avec le nom de fichier d'origine.
    if (req.method === 'GET' && path === '/api/assets/download') {
      const id = q.get('id');
      const [a] = id ? await dbSelect('assets', `?id=eq.${id}`).catch(() => []) : [];
      if (!a) return json(res, { ok: false, error: 'fichier introuvable' }, 404);
      const signed = await storageSign('assets', a.storage_path).catch(() => null);
      if (!signed) return json(res, { ok: false, error: 'fichier indisponible dans le stockage' }, 404);
      const up = await fetch(signed).catch(() => null);
      if (!up || !up.ok) return json(res, { ok: false, error: 'téléchargement impossible depuis le stockage' }, 502);
      const name = String(a.filename || 'fichier').replace(/[\\/:*?"<>|\r\n]+/g, '').trim() || 'fichier';
      const len = up.headers.get('content-length');
      res.writeHead(200, {
        'content-type': a.mime_type || up.headers.get('content-type') || 'application/octet-stream',
        ...(len ? { 'content-length': len } : {}),
        'content-disposition': `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store'
      });
      return Readable.fromWeb(up.body).pipe(res);
    }
    if (req.method === 'POST' && path === '/api/assets/upload') {
      const kind = q.get('kind') || 'other';
      const filename = decodeURIComponent(q.get('filename') || 'fichier');
      const contentType = req.headers['content-type'] || 'application/octet-stream';
      // Fond & Pub doivent être des médias (image/vidéo), sinon FFmpeg plante au montage.
      if ((kind === 'background' || kind === 'ad') && !/^(image|video)\//.test(contentType)) {
        return json(res, { ok: false, error: `« ${filename} » n'est pas une image/vidéo (${contentType}). Fond et Publicité n'acceptent que des images ou vidéos.` });
      }
      const chunks = []; let size = 0; let tooBig = false;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) { tooBig = true; break; }
        chunks.push(chunk);
      }
      if (tooBig) { req.destroy(); return json(res, { ok: false, error: 'Fichier trop volumineux (45 Mo max).' }, 413); }
      const buffer = Buffer.concat(chunks);
      const ext = filename.includes('.') ? filename.split('.').pop() : 'bin';
      const storagePath = `${kind}/${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
      try {
        await storageUpload('assets', storagePath, buffer, contentType);
        const ch = await getActiveChannel();
        const [row] = await dbInsert('assets', [{ kind, filename, storage_path: storagePath, mime_type: contentType, size_bytes: size, channel_id: ch?.id || null, placement: kind === 'ad' ? { x: 0.68, y: 0.55, w: 0.28, h: 0.40 } : null }]);
        return json(res, { ok: true, asset: row });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    if (req.method === 'POST' && path === '/api/assets/delete') {
      const b = await readJsonBody(req);
      if (!b.id || !b.storage_path) return json(res, { ok: false, error: 'id et storage_path requis' });
      try {
        await storageDelete('assets', [b.storage_path]);
        await dbDelete('assets', `id=eq.${b.id}`);
        return json(res, { ok: true });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    if (req.method === 'POST' && path === '/api/assets/placement') {
      const b = await readJsonBody(req);
      if (!b.id || !b.placement) return json(res, { ok: false, error: 'id et placement requis' });
      const q = b.placement, cl = (v, d) => Math.min(1, Math.max(0, Number(v) ?? d));
      const placement = { x: cl(q.x, 0.68), y: cl(q.y, 0.55), w: cl(q.w, 0.28), h: cl(q.h, 0.40) };
      try { const [row] = await dbPatch('assets', `id=eq.${b.id}`, { placement }); return json(res, { ok: true, asset: row }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    if (req.method === 'POST' && path === '/api/assets/toggle') {
      const b = await readJsonBody(req);
      if (!b.id) return json(res, { ok: false, error: 'id requis' });
      try { const [row] = await dbPatch('assets', `id=eq.${b.id}`, { active: !!b.active }); return json(res, { ok: true, asset: row }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    // Mode d'affichage d'une pub : 'periodic' (fenêtres intro/fréquence/outro) ou 'constant' (overlay permanent).
    if (req.method === 'POST' && path === '/api/assets/mode') {
      const b = await readJsonBody(req);
      if (!b.id || !['periodic', 'constant'].includes(b.ad_mode)) return json(res, { ok: false, error: 'id et ad_mode (periodic|constant) requis' });
      try { const [row] = await dbPatch('assets', `id=eq.${b.id}`, { ad_mode: b.ad_mode }); return json(res, { ok: true, asset: row }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    // Pour quel fond CETTE pub (déjà liée à une autre via /api/assets/pair) est-elle prévue :
    // 'for_light_bg'|'for_dark_bg'|'' (aucune préférence). Ne touche pas le lien (variant_group).
    if (req.method === 'POST' && path === '/api/assets/variant') {
      const b = await readJsonBody(req);
      if (!b.id) return json(res, { ok: false, error: 'id requis' });
      if (b.contrast_variant && !['for_light_bg', 'for_dark_bg'].includes(b.contrast_variant)) return json(res, { ok: false, error: 'contrast_variant invalide' });
      try {
        const [row] = await dbPatch('assets', `id=eq.${b.id}`, { contrast_variant: b.contrast_variant || null });
        return json(res, { ok: true, asset: row });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    // Associe DEUX pubs comme variantes de la MÊME pub (choix via un menu, pas un nom à taper en double) :
    // partnerId fourni -> les deux prennent le même `variant_group` (clé déterministe, triée par id) ;
    // partnerId vide -> délie CETTE pub (le partenaire redevient seul dans son groupe, sans effet).
    if (req.method === 'POST' && path === '/api/assets/pair') {
      const b = await readJsonBody(req);
      if (!b.id) return json(res, { ok: false, error: 'id requis' });
      try {
        if (!b.partnerId) {
          const [row] = await dbPatch('assets', `id=eq.${b.id}`, { variant_group: null, contrast_variant: null });
          return json(res, { ok: true, asset: row });
        }
        const groupKey = [b.id, b.partnerId].sort().join('_');
        const [row] = await dbPatch('assets', `id=eq.${b.id}`, { variant_group: groupKey });
        await dbPatch('assets', `id=eq.${b.partnerId}`, { variant_group: groupKey }).catch(() => {});
        return json(res, { ok: true, asset: row });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }

    // ── Chansons de référence ──
    if (req.method === 'GET' && path === '/api/references') {
      const chId = q.get('channel_id') || (await getActiveChannel())?.id;
      const rows = await dbSelect('reference_songs', (chId ? `?channel_id=eq.${chId}&` : '?') + 'order=added_at.desc');
      return json(res, rows);
    }
    // Vidéos références d'une chaîne donnée (inspiration_urls), scopées par channel_id.
    if (req.method === 'GET' && path === '/api/references/videos') {
      const chId = q.get('channel_id');
      const ch = chId ? await getChannel(chId) : await getActiveChannel();
      return json(res, { inspiration_urls: Array.isArray(ch?.inspiration_urls) ? ch.inspiration_urls : [] });
    }
    if (req.method === 'POST' && path === '/api/references/videos') {
      const b = await readJsonBody(req);
      const chId = b.channel_id || (await getActiveChannel())?.id;
      if (!chId) return json(res, { ok: false, error: 'chaîne requise' });
      const urls = Array.isArray(b.inspiration_urls) ? b.inspiration_urls.map(s => String(s).trim()).filter(Boolean).slice(0, 50) : [];
      await updateChannel(chId, { inspiration_urls: urls });
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/references') {
      const b = await readJsonBody(req);
      const spotifyUrl = String(b.spotify_url || '').trim();
      if (!/^https:\/\/open\.spotify\.com\/(intl-[a-z]+\/)?track\/[A-Za-z0-9]+/.test(spotifyUrl)) {
        return json(res, { ok: false, error: 'Lien Spotify invalide (attendu : https://open.spotify.com/track/...)' });
      }
      const moodTags = String(b.mood_tags || '').split(',').map(s => s.trim()).filter(Boolean);
      try {
        let title = String(b.title || '').trim() || null;
        let artist = String(b.artist || '').trim() || null;
        if (!title) {
          try {
            const oembed = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(spotifyUrl)).then(r => r.ok ? r.json() : null);
            if (oembed?.title) title = oembed.title;
          } catch {}
        }
        const chId = b.channel_id || (await getActiveChannel())?.id;
        const [row] = await dbInsert('reference_songs', [{ spotify_url: spotifyUrl, title, artist, mood_tags: moodTags, channel_id: chId || null }]);
        return json(res, { ok: true, reference: row });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    if (req.method === 'POST' && path === '/api/references/toggle') {
      const b = await readJsonBody(req);
      if (!b.id) return json(res, { ok: false, error: 'id requis' });
      try { const [row] = await dbPatch('reference_songs', `id=eq.${b.id}`, { active: !!b.active }); return json(res, { ok: true, reference: row }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    if (req.method === 'POST' && path === '/api/references/delete') {
      const b = await readJsonBody(req);
      if (!b.id) return json(res, { ok: false, error: 'id requis' });
      try { await dbDelete('reference_songs', `id=eq.${b.id}`); return json(res, { ok: true }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }

    // ── Videos ──
    if (req.method === 'GET' && path === '/api/videos') {
      const ch = await getActiveChannel();
      const rows = await dbSelect('videos', (ch ? `?channel_id=eq.${ch.id}&` : '?') + 'order=created_at.desc&limit=50');
      // On joint le mode de publication de la chaîne (draft/review/auto/local) pour que l'UI adapte l'action de
      // publication, et la présence du fichier conservé pour afficher (ou non) les boutons de téléchargement.
      const pm = ch?.publish_mode || 'review';
      return json(res, rows.map(v => {
        const f = renderFiles(v.id);
        return { ...v, publish_mode: pm, has_file: !!f.video, has_thumb_file: !!f.thumb };
      }));
    }
    // Stats "aperçu" (batch) : vues/likes/commentaires en direct pour les vidéos en ligne de la chaîne active.
    if (req.method === 'GET' && path === '/api/videos/stats') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { byId: {} });
      const vids = await dbSelect('videos', `?channel_id=eq.${ch.id}&youtube_video_id=not.is.null&select=youtube_video_id`).catch(() => []);
      const ids = [...new Set(vids.map(v => v.youtube_video_id).filter(Boolean))];
      if (!ids.length) return json(res, { byId: {} });
      let byId = {};
      try { byId = await getVideoStats(ids, channelCreds(ch).youtube) || {}; } // renvoie déjà { [ytId]: {views,likes,comments} }
      catch (e) { /* dégradé silencieux : l'aperçu s'affiche sans chiffres */ }
      return json(res, { byId });
    }
    // Mise à jour manuelle des stats de la chaîne (snapshot -> video_stats).
    if (req.method === 'POST' && path === '/api/stats/refresh') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const r = await refreshStats(ch);
      return json(res, { ok: r.ok !== false, captured: r.captured || 0, analytics: !!r.analytics, needsReauth: !!r.needsReauth, error: r.error || null });
    }
    // Détail d'une vidéo : rétention/temps de visionnage (Analytics) + paramètres de génération.
    if (req.method === 'GET' && path === '/api/videos/detail') {
      const id = q.get('id');
      const [v] = id ? await dbSelect('videos', `?id=eq.${id}`).catch(() => []) : [];
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' });
      const ch = v.channel_id ? await getChannel(v.channel_id) : await getActiveChannel();
      // Paramètres : images de fond (URLs signées), tracklist, émotion/mood/durée/miniature/hashtags.
      const bgIds = Array.isArray(v.background_asset_ids) ? v.background_asset_ids : [];
      let bgImages = [];
      if (bgIds.length) {
        const assets = await dbSelect('assets', `?id=in.(${bgIds.join(',')})&select=id,storage_path,mime_type,filename`).catch(() => []);
        bgImages = await Promise.all(assets.filter(a => (a.mime_type || '').startsWith('image')).map(async a => ({ filename: a.filename, url: await storageSign('assets', a.storage_path).catch(() => null) })));
      }
      const tracks = await dbSelect('video_tracks', `?video_id=eq.${id}&order=position.asc&select=title,artist,start_sec,length_sec`).catch(() => []);
      // Analytics (rétention + temps de visionnage) — dégrade proprement si scope manquant ou vidéo trop récente.
      let analytics = null;
      if (v.youtube_video_id) {
        const start = String(v.published_at || v.created_at || '2020-01-01').slice(0, 10);
        const end = new Date().toISOString().slice(0, 10);
        const a = await getVideoAnalytics({ videoIds: [v.youtube_video_id], startDate: start, endDate: end, creds: channelCreds(ch).youtube }).catch(() => ({ ok: false }));
        analytics = a.ok ? (a.byVideo[v.youtube_video_id] || {}) : { error: a.error, needsReauth: a.needsReauth };
      }
      return json(res, {
        ok: true,
        params: { emotion: v.emotion, mood: v.mood, theme: v.theme, duration_sec: v.duration_sec, thumbnail_config: v.thumbnail_config || null, hashtags: v.hashtags || [], bgImages, tracks, refCount: (v.reference_song_ids || []).length },
        analytics
      });
    }
    // Centre de notifications in-app (cloche) : liste des événements de la chaîne active + compteur non-lus.
    if (req.method === 'GET' && path === '/api/notifications') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { items: [], unread: 0 });
      const items = await dbSelect('notifications', `?channel_id=eq.${ch.id}&order=created_at.desc&limit=40&select=id,type,title,body,url,read,created_at`).catch(() => []);
      const unread = items.filter(n => !n.read).length;
      return json(res, { items, unread });
    }
    if (req.method === 'POST' && path === '/api/notifications/read') {
      const ch = await getActiveChannel();
      if (ch) await dbPatch('notifications', `channel_id=eq.${ch.id}&read=eq.false`, { read: true }).catch(() => {});
      return json(res, { ok: true });
    }
    // Statut de vérification YouTube d'une chaîne (miniature perso / vidéos > 15 min nécessitent la vérif téléphone).
    if (req.method === 'GET' && path === '/api/youtube/status') {
      const chId = q.get('channel');
      const ch = chId ? await getChannel(chId) : await getActiveChannel();
      if (!ch) return json(res, { ok: false });
      try {
        const yt = await getMyChannel(channelCreds(ch).youtube);
        const longUploads = yt?.status?.longUploadsStatus || 'unknown';
        return json(res, { ok: true, title: yt?.snippet?.title || null, verified: longUploads === 'allowed' || longUploads === 'eligible', longUploads });
      } catch (e) { return json(res, { ok: false, error: String(e.message || e).slice(0, 150) }); }
    }
    // Tableau de bord d'accueil : statut auto (Live), compteurs, dernières vidéos + dernières actions.
    if (req.method === 'GET' && path === '/api/home') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { channel: null });
      const vids = await dbSelect('videos', `?channel_id=eq.${ch.id}&order=created_at.desc&limit=200&select=id,title,status,created_at,published_at,youtube_url,error`).catch(() => []);
      const counts = { total: vids.length, published: 0, pending_review: 0, failed: 0 };
      for (const v of vids) if (v.status in counts) counts[v.status]++;
      // Dernières actions : UNE ligne par vidéo (l'essentiel, pas le détail de chaque étape technique).
      const STATUS_LABEL = { published: 'Publiée', pending_review: 'À valider', failed: 'Échec', cancelled: 'Annulée', curating: 'En cours (curation)', downloading: 'En cours (téléchargement)', rendering: 'En cours (montage)', uploading: 'En cours (upload)' };
      const actions = vids.slice(0, 5).map(v => ({
        step: v.status, status: v.status === 'failed' ? 'fail' : 'ok',
        message: v.status === 'failed' ? (v.error || '') : '',
        created_at: v.published_at || v.created_at, title: v.title || '(vidéo)', label: STATUS_LABEL[v.status] || v.status
      }));
      const today = await generatedToday(ch.id).catch(() => 0);
      // Stats agrégées de la chaîne : dernier snapshot par vidéo (video_stats) -> total vues/likes + rétention moyenne.
      let stats = { views: 0, likes: 0, retention: null, videos: 0 };
      try {
        const snaps = await dbSelect('video_stats', `?channel_id=eq.${ch.id}&order=captured_at.desc&limit=1000&select=video_id,views,likes,avg_view_pct`).catch(() => []);
        const latest = new Map();
        for (const s of snaps) if (!latest.has(s.video_id)) latest.set(s.video_id, s); // 1re occurrence = plus récente
        let rSum = 0, rN = 0;
        for (const s of latest.values()) { stats.views += s.views || 0; stats.likes += s.likes || 0; if (s.avg_view_pct != null) { rSum += s.avg_view_pct; rN++; } }
        stats.videos = latest.size; stats.retention = rN ? Math.round(rSum / rN) : null;
      } catch (e) {}
      const upcoming = await buildUpcoming(ch, new Date()).catch(() => ({ actions: [], next_label: null }));
      const scheduleMode = ch.publish_schedule_mode || ((Array.isArray(ch.publish_times) && ch.publish_times.length) ? 'fixed' : 'auto');
      return json(res, {
        channel: { name: ch.name, cron_enabled: !!ch.cron_enabled, publish_mode: ch.publish_mode || 'review', schedule_mode: scheduleMode, max_posts_per_day: ch.max_posts_per_day || 1, publish_time_start: ch.publish_time_start || null, publish_time_end: ch.publish_time_end || null, stats_daily: ch.stats_daily === true, stats_updated_at: ch.stats_updated_at || null },
        counts, today, recent: vids.slice(0, 6), actions, upcoming, stats
      });
    }
    if (req.method === 'GET' && path === '/api/videos/status') {
      const since = Math.max(0, Number(q.get('since')) || 0); // n'envoie que les nouvelles lignes de journal
      return json(res, {
        running: genState.running, phase: genState.phase, error: genState.error, cancelled: genState.cancelled,
        videoId: genState.videoId, startedAt: genState.startedAt,
        total: genState.log.length, log: genState.log.slice(since)
      });
    }
    if (req.method === 'POST' && path === '/api/videos/generate') {
      const refs = await dbSelect('reference_songs', '?active=eq.true&limit=1').catch(() => []);
      if (!refs.length) return json(res, { ok: false, error: 'Ajoute au moins une chanson de référence active avant de générer.' });
      // Pré-check Epidemic : le jeton meurt régulièrement (session fermée). On vérifie AVANT de lancer un run
      // pour ne pas gâcher une génération et afficher un message clair (au lieu de « curation vide »).
      const preCh = await getActiveChannel();
      const preEp = await testEpidemic({ jwt: channelCreds(preCh).epidemicJwt, cookies: channelCreds(preCh).epidemicCookies }).catch(() => ({ ok: false }));
      if (!preEp.ok) {
        notifyChannel(preCh, 'epidemic_auth', { title: '🔑 Epidemic déconnecté', description: EPIDEMIC_AUTH_MESSAGE, color: COLORS.error });
        return json(res, { ok: false, error: EPIDEMIC_AUTH_MESSAGE });
      }
      // Pré-check YouTube : si le compte de la chaîne n'est plus autorisé, on renvoie un flag pour proposer la
      // reconnexion en 1 clic (au lieu de gâcher tout le montage puis échouer à l'upload).
      const preYt = await testYouTube(channelCreds(preCh).youtube || {}).catch(() => ({ ok: false, detail: '' }));
      if (!preYt.ok) {
        notifyChannel(preCh, 'youtube_auth', { title: '🔴 YouTube déconnecté', description: 'Le compte YouTube de « ' + (preCh?.name || '') + ' » n\'est plus autorisé. Reconnecte-le pour reprendre les générations.', color: COLORS.error });
        return json(res, { ok: false, reconnect: 'youtube', error: 'YouTube n\'est plus autorisé pour cette chaîne' + (preYt.detail ? ' (' + preYt.detail + ')' : '') + '. Reconnecte-la en un clic 👇' });
      }
      // Durée en fourchette (minutes) fournie à la génération manuelle -> tirage aléatoire ; sinon fourchette de la chaîne.
      const b = await readJsonBody(req).catch(() => ({}));
      let targetSec = null;
      const mn = Number(b?.minMin), mx = Number(b?.maxMin);
      if (mn >= 1 && mx >= 1) {
        const lo = Math.max(5, Math.min(mn, mx)), hi = Math.min(600, Math.max(mn, mx));
        targetSec = (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60;
      }
      // Options facultatives : titre imposé + image de FOND choisie + image de MINIATURE choisie (séparées).
      const titleOverride = typeof b?.title === 'string' ? b.title.trim().slice(0, 200) : '';
      // Valide qu'un id d'asset appartient bien à la chaîne active et est un fond image ; sinon null.
      const validImage = async id => {
        if (typeof id !== 'string' || !id) return null;
        const owned = await dbSelect('assets', `?id=eq.${id}&channel_id=eq.${preCh?.id}&kind=eq.background&select=id,mime_type`).catch(() => []);
        return owned.length && /^image\//.test(owned[0].mime_type || '') ? id : null;
      };
      const backgroundAssetId = await validImage(b?.backgroundAssetId);
      const thumbnailAssetId = await validImage(b?.thumbnailAssetId);
      const started = generateOnce({ dryRun: false, targetSec, titleOverride, backgroundAssetId, thumbnailAssetId });
      return json(res, { ok: true, started });
    }
    if (req.method === 'POST' && path === '/api/videos/generate/cancel') {
      if (!genState.running || !genController) return json(res, { ok: false, error: 'aucune génération en cours' });
      genController.cancelled = true;
      genState.phase = 'annulation…';
      try { genController.child?.kill('SIGKILL'); } catch {}
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/videos/approve') {
      const b = await readJsonBody(req);
      const [v] = await dbSelect('videos', `?id=eq.${b.id}`);
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' });
      try {
        if (v.youtube_video_id) {
          const vch = v.channel_id ? await getChannel(v.channel_id) : await getActiveChannel();
          await setPrivacyStatus(v.youtube_video_id, 'public', channelCreds(vch || {}).youtube);
        }
        await dbPatch('videos', `id=eq.${b.id}`, { status: 'published', published_at: new Date().toISOString() });
        return json(res, { ok: true });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    // Téléchargement du rendu conservé (mode « téléchargement seul ») : MP4 ou miniature.
    // Streamé depuis le volume /data ; seuls les 5 derniers rendus existent encore.
    if (req.method === 'GET' && (path === '/api/videos/download' || path === '/api/videos/download-thumbnail')) {
      const id = q.get('id');
      const [v] = id ? await dbSelect('videos', `?id=eq.${id}`).catch(() => []) : [];
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' }, 404);
      const wantThumb = path.endsWith('download-thumbnail');
      const f = renderFiles(v.id);
      const filePath = wantThumb ? f.thumb : f.video;
      if (!filePath) return json(res, { ok: false, error: 'fichier non disponible (purgé : seuls les 5 derniers rendus sont conservés)' }, 404);
      // Nom de fichier lisible, sans caractère qui casserait l'en-tête.
      const base = (v.title || 'video').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
      const name = base + (wantThumb ? '.jpg' : '.mp4');
      const size = statSync(filePath).size;
      res.writeHead(200, {
        'content-type': wantThumb ? 'image/jpeg' : 'video/mp4',
        'content-length': String(size),
        'content-disposition': `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store'
      });
      return createReadStream(filePath).pipe(res);
    }
    // Mode "dépôt en privé" : la vidéo est publiée par l'utilisateur DIRECTEMENT sur YouTube Studio.
    // Ce endpoint ne touche PAS l'API YouTube — il marque simplement la vidéo comme publiée côté outil (suivi + stats).
    if (req.method === 'POST' && path === '/api/videos/mark-published') {
      const b = await readJsonBody(req);
      const [v] = await dbSelect('videos', `?id=eq.${b.id}`);
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' });
      await dbPatch('videos', `id=eq.${b.id}`, { status: 'published', published_at: new Date().toISOString() });
      return json(res, { ok: true });
    }
    // Données pour l'éditeur de miniature (image de fond + réglages courants).
    if (req.method === 'GET' && path === '/api/videos/thumbnail') {
      const id = q.get('id');
      const [v] = await dbSelect('videos', `?id=eq.${id}`);
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' });
      const ch = v.channel_id ? await getChannel(v.channel_id) : await getActiveChannel();
      const ids = Array.isArray(v.background_asset_ids) && v.background_asset_ids.length ? v.background_asset_ids : (v.background_asset ? [v.background_asset] : []);
      let imageUrl = null;
      if (ids.length) {
        const rows = await dbSelect('assets', `?id=in.(${ids.join(',')})`).catch(() => []);
        const img = rows.find(a => /^image\//.test(a.mime_type || ''));
        if (img) imageUrl = await storageSign('assets', img.storage_path, 3600).catch(() => null);
      }
      const cfg = v.thumbnail_config || {};
      return json(res, {
        ok: true, imageUrl, hasYoutube: !!v.youtube_video_id,
        text: cfg.text != null ? cfg.text : stripPlaylistTag(v.title || ''),
        font: cfg.font || ch?.thumbnail_font || 'playfair',
        posX: cfg.posX ?? 0.5, posY: cfg.posY ?? 0.5,
        fonts: Object.keys(THUMB_FONTS)
      });
    }
    // Régénère la miniature (texte/police/position) et la ré-uploade sur YouTube.
    if (req.method === 'POST' && path === '/api/videos/thumbnail') {
      const b = await readJsonBody(req);
      const [v] = await dbSelect('videos', `?id=eq.${b.id}`);
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' });
      if (!v.youtube_video_id) return json(res, { ok: false, error: 'vidéo pas encore sur YouTube' });
      const ch = v.channel_id ? await getChannel(v.channel_id) : await getActiveChannel();
      const ids = Array.isArray(v.background_asset_ids) && v.background_asset_ids.length ? v.background_asset_ids : (v.background_asset ? [v.background_asset] : []);
      const rows = ids.length ? await dbSelect('assets', `?id=in.(${ids.join(',')})`).catch(() => []) : [];
      const img = rows.find(a => /^image\//.test(a.mime_type || ''));
      if (!img) return json(res, { ok: false, error: 'aucune image de fond pour cette vidéo' });
      const workDir = join(tmpdir(), 'thumb-' + b.id);
      mkdirSync(workDir, { recursive: true });
      try {
        const url = await storageSign('assets', img.storage_path, 600);
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        const imgPath = join(workDir, 'bg.' + ((img.filename.split('.').pop() || 'jpg').toLowerCase()));
        writeFileSync(imgPath, buf);
        const outPath = join(workDir, 'thumb.jpg');
        const font = ['playfair', 'inter', 'cormorant'].includes(b.font) ? b.font : (ch?.thumbnail_font || 'playfair');
        const text = String(b.text || '').slice(0, 200);
        const posX = Math.min(1, Math.max(0, Number(b.posX) || 0.5)), posY = Math.min(1, Math.max(0, Number(b.posY) || 0.5));
        // Même cadrage sur le sujet que le montage : le point focal a été mis en cache à la génération.
        const focal = readFocal(img.id);
        renderThumbnail({ imagePath: imgPath, text, outPath, workDir, font, withText: !!text.trim(), posX, posY, focal });
        await setThumbnail(v.youtube_video_id, outPath, channelCreds(ch || {}).youtube);
        await dbPatch('videos', `id=eq.${b.id}`, { thumbnail_config: { text, font, posX, posY } });
        return json(res, { ok: true });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
      finally { try { rmSync(workDir, { recursive: true, force: true }); } catch {} }
    }
    if (req.method === 'POST' && path === '/api/videos/reject') {
      const b = await readJsonBody(req);
      await dbPatch('videos', `id=eq.${b.id}`, { status: 'rejected' });
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/videos/update') {
      const b = await readJsonBody(req);
      const patch = {};
      if (typeof b.title === 'string') patch.title = b.title.slice(0, 100);
      if (typeof b.description === 'string') patch.description = b.description.slice(0, 4950);
      const [row] = await dbPatch('videos', `id=eq.${b.id}`, patch);
      return json(res, { ok: true, video: row });
    }
    if (req.method === 'POST' && path === '/api/videos/delete') {
      const b = await readJsonBody(req);
      const [v] = await dbSelect('videos', `?id=eq.${b.id}`);
      try {
        if (v?.youtube_video_id) {
          const vch = v.channel_id ? await getChannel(v.channel_id) : await getActiveChannel();
          await deleteVideo(v.youtube_video_id, channelCreds(vch || {}).youtube).catch(() => {});
        }
        deleteRender(b.id); // libère le rendu conservé sur /data, s'il existe
        await dbDelete('videos', `id=eq.${b.id}`);
        return json(res, { ok: true });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    // Reprend une génération en échec (ex : interrompue par un redéploiement du serveur). Le dossier de
    // travail (tracklist, audio téléchargé, montage) ne survit PAS à un redémarrage -> pas de reprise
    // « au même endroit » possible ; on relance une génération fraîche pour la même chaîne, en un clic.
    if (req.method === 'POST' && path === '/api/videos/resume') {
      const b = await readJsonBody(req);
      const [v] = await dbSelect('videos', `?id=eq.${b.id}`);
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' });
      if (v.status !== 'failed') return json(res, { ok: false, error: 'seule une vidéo en échec peut être reprise' });
      if (genState.running) return json(res, { ok: false, error: 'une génération est déjà en cours — réessaie dans un instant' });
      const vch = v.channel_id ? await getChannel(v.channel_id) : await getActiveChannel();
      if (!vch) return json(res, { ok: false, error: 'chaîne introuvable' });
      const preEp = await testEpidemic({ jwt: channelCreds(vch).epidemicJwt, cookies: channelCreds(vch).epidemicCookies }).catch(() => ({ ok: false }));
      if (!preEp.ok) {
        notifyChannel(vch, 'epidemic_auth', { title: '🔑 Epidemic déconnecté', description: EPIDEMIC_AUTH_MESSAGE, color: COLORS.error });
        return json(res, { ok: false, error: EPIDEMIC_AUTH_MESSAGE });
      }
      const preYt = await testYouTube(channelCreds(vch).youtube || {}).catch(() => ({ ok: false, detail: '' }));
      if (!preYt.ok) {
        notifyChannel(vch, 'youtube_auth', { title: '🔴 YouTube déconnecté', description: 'Le compte YouTube de « ' + (vch?.name || '') + ' » n\'est plus autorisé. Reconnecte-le pour reprendre les générations.', color: COLORS.error });
        return json(res, { ok: false, reconnect: 'youtube', error: 'YouTube n\'est plus autorisé pour cette chaîne' + (preYt.detail ? ' (' + preYt.detail + ')' : '') + '. Reconnecte-la en un clic 👇' });
      }
      await dbDelete('videos', `id=eq.${b.id}`).catch(() => {}); // rien d'utilisable dans la tentative échouée
      const started = generateOnce({ dryRun: false, channelId: vch.id });
      return json(res, { ok: true, started });
    }

    // ── Chaînes ──
    if (req.method === 'GET' && path === '/api/channels') {
      const chans = await listChannels();
      return json(res, { channels: chans.map(c => ({ id: c.id, name: c.name, is_active: c.is_active })), activeId: (chans.find(c => c.is_active) || chans[0])?.id || null });
    }
    if (req.method === 'POST' && path === '/api/channels/create') {
      const b = await readJsonBody(req); const ch = await createChannel(b.name); return json(res, { ok: true, id: ch.id });
    }
    if (req.method === 'POST' && path === '/api/channels/select') {
      const b = await readJsonBody(req); if (!b.id) return json(res, { ok: false, error: 'id requis' }); await setActiveChannel(b.id); return json(res, { ok: true });
    }
    // Supprime une chaîne DE L'OUTIL + toutes ses données liées (pas les vidéos déjà en ligne sur YouTube). Irréversible.
    if (req.method === 'POST' && path === '/api/channels/delete') {
      const b = await readJsonBody(req);
      const all = await listChannels();
      if (all.length <= 1) return json(res, { ok: false, error: 'Impossible de supprimer la seule chaîne. Crée-en une autre d\'abord.' });
      const id = b.id || (await getActiveChannel())?.id;
      const ch = all.find(c => c.id === id);
      if (!ch) return json(res, { ok: false, error: 'chaîne introuvable' });
      // Fichiers storage des assets de la chaîne (best-effort).
      const assets = await dbSelect('assets', `?channel_id=eq.${id}&select=storage_path`).catch(() => []);
      const paths = assets.map(a => a.storage_path).filter(Boolean);
      if (paths.length) await storageDelete('assets', paths).catch(() => {});
      // Lignes liées, dans l'ordre.
      const vids = await dbSelect('videos', `?channel_id=eq.${id}&select=id`).catch(() => []);
      const vidIds = vids.map(v => v.id);
      if (vidIds.length) { await dbDelete('run_logs', `video_id=in.(${vidIds.join(',')})`).catch(() => {}); await dbDelete('video_tracks', `video_id=in.(${vidIds.join(',')})`).catch(() => {}); }
      await dbDelete('video_stats', `channel_id=eq.${id}`).catch(() => {});
      await dbDelete('notifications', `channel_id=eq.${id}`).catch(() => {});
      await dbDelete('videos', `channel_id=eq.${id}`).catch(() => {});
      await dbDelete('assets', `channel_id=eq.${id}`).catch(() => {});
      await dbDelete('reference_songs', `channel_id=eq.${id}`).catch(() => {});
      await dbDelete('channels', `id=eq.${id}`).catch(() => {});
      // Si c'était l'active, on bascule sur une autre.
      if (ch.is_active) { const other = all.find(c => c.id !== id); if (other) await setActiveChannel(other.id).catch(() => {}); }
      setupScheduler().catch(() => {});
      return json(res, { ok: true });
    }

    // ── Paramètres (chaîne active) ──
    if (req.method === 'GET' && path === '/api/settings') {
      const ch = await getActiveChannel();
      // Résumé des pubs configurées (Assets) : donne un état clair directement dans Paramètres, pour
      // qu'on sache d'un coup d'œil ce que fait vraiment l'interrupteur « Activer les publicités ».
      let adsSummary = { total: 0, constant: 0, periodic: 0, active: 0 };
      if (ch) {
        const ads = await dbSelect('assets', `?channel_id=eq.${ch.id}&kind=eq.ad&select=ad_mode,active`).catch(() => []);
        adsSummary = {
          total: ads.length, active: ads.filter(a => a.active !== false).length,
          constant: ads.filter(a => a.active !== false && a.ad_mode === 'constant').length,
          periodic: ads.filter(a => a.active !== false && a.ad_mode !== 'constant').length
        };
      }
      return json(res, { ...(channelPublicView(ch) || {}), ads_summary: adsSummary, notif_types: NOTIF_TYPES });
    }
    if (req.method === 'POST' && path === '/api/settings/save') {
      const b = await readJsonBody(req);
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const patch = {};
      for (const k of ['name', 'yt_client_id', 'yt_channel_id', 'utm_base']) if (typeof b[k] === 'string') patch[k] = b[k].trim();
      if (b.daily_publish_time) patch.daily_publish_time = b.daily_publish_time;
      if (b.target_duration_sec) patch.target_duration_sec = Math.max(600, Number(b.target_duration_sec) || 5400);
      // Fourchettes (min/max en minutes depuis l'UI -> secondes). On garde min <= max.
      if (b.target_min_min != null || b.target_max_min != null) {
        let mn = Math.max(10, Math.min(240, Number(b.target_min_min) || 90));
        let mx = Math.max(10, Math.min(240, Number(b.target_max_min) || mn));
        if (mx < mn) [mn, mx] = [mx, mn];
        patch.target_min_sec = mn * 60; patch.target_max_sec = mx * 60;
        patch.target_duration_sec = mn * 60; // rétro-compat
      }
      const isHHMM = s => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
      // Mode de planification : 'auto' (fenêtre + warm-up) ou 'fixed' (créneaux-fourchettes fixés à la main).
      const schedMode = (b.publish_schedule_mode === 'fixed' || b.publish_schedule_mode === 'auto') ? b.publish_schedule_mode : null;
      if (schedMode) patch.publish_schedule_mode = schedMode;
      // Créneaux de publication : chacun « HH:MM » (exact) ou « HH:MM-HH:MM » (fourchette -> heure tirée au hasard).
      const isSlot = s => typeof s === 'string' && /^\d{2}:\d{2}(-\d{2}:\d{2})?$/.test(s);
      if (Array.isArray(b.publish_times)) {
        let slots = [...new Set(b.publish_times.filter(isSlot))].sort().slice(0, 8);
        if (schedMode === 'auto') slots = []; // en mode auto, aucune heure fixe
        patch.publish_times = slots;
        if (slots.length) patch.max_posts_per_day = Math.max(1, Math.min(10, slots.length)); // cohérence cadence
      }
      if (isHHMM(b.publish_time_start)) patch.publish_time_start = b.publish_time_start;
      if (isHHMM(b.publish_time_end)) patch.publish_time_end = b.publish_time_end;
      if (isHHMM(b.publish_time_start)) patch.daily_publish_time = b.publish_time_start; // rétro-compat
      // Anti-rattrapage : on horodate le moment où le planning est (re)programmé. Le cerveau ne rattrapera pas
      // les créneaux déjà passés à cet instant pour aujourd'hui (voir brainTick). Uniquement si le planning change.
      if ('publish_times' in patch || 'publish_schedule_mode' in patch || 'publish_time_start' in patch || 'publish_time_end' in patch || (typeof b.cron_enabled === 'boolean' && b.cron_enabled)) {
        patch.schedule_set_at = new Date().toISOString();
      }
      if (typeof b.ads_enabled === 'boolean') patch.ads_enabled = b.ads_enabled;
      if (b.ad_frequency_min != null) patch.ad_frequency_min = Math.max(1, Number(b.ad_frequency_min) || 10);
      if (b.ad_duration_sec != null) patch.ad_duration_sec = Math.max(2, Number(b.ad_duration_sec) || 8);
      if (b.ad_placement && typeof b.ad_placement === 'object') patch.ad_placement = b.ad_placement;
      if (typeof b.ad_intro === 'boolean') patch.ad_intro = b.ad_intro;
      if (typeof b.ad_outro === 'boolean') patch.ad_outro = b.ad_outro;
      if (typeof b.discord_webhook === 'string' && b.discord_webhook.trim()) { const w = b.discord_webhook.trim(); if (isDiscordWebhook(w)) patch.discord_webhook = w; else return json(res, { ok: false, error: 'Webhook Discord invalide (https://discord.com/api/webhooks/…)' }); }
      // Préférences de notifications par type (uniquement des booléens sur des types connus).
      if (b.discord_notifs && typeof b.discord_notifs === 'object' && !Array.isArray(b.discord_notifs)) {
        const clean = {};
        for (const k of Object.keys(NOTIF_TYPES)) if (typeof b.discord_notifs[k] === 'boolean') clean[k] = b.discord_notifs[k];
        patch.discord_notifs = clean;
      }
      if (b.daily_report_hour != null) patch.daily_report_hour = Math.max(0, Math.min(23, Number(b.daily_report_hour) || 8));
      if (['auto', 'review', 'draft', 'local'].includes(b.publish_mode)) patch.publish_mode = b.publish_mode;
      if (typeof b.cron_enabled === 'boolean') patch.cron_enabled = b.cron_enabled;
      // À l'activation de la génération auto (transition off -> on), active aussi la MàJ quotidienne des stats
      // par défaut si elle ne l'est pas déjà (sauf demande explicite contraire dans la même sauvegarde).
      if (patch.cron_enabled === true && !ch.cron_enabled && ch.stats_daily !== true && typeof b.stats_daily !== 'boolean') {
        patch.stats_daily = true;
      }
      if (typeof b.coach_enabled === 'boolean') patch.coach_enabled = b.coach_enabled;
      if (typeof b.stats_daily === 'boolean') patch.stats_daily = b.stats_daily;
      if (['sonnet', 'opus', 'haiku'].includes(b.claude_model)) patch.claude_model = b.claude_model;
      // Cadence manuelle : seulement en mode auto (en mode fixe, elle est déjà dérivée du nb de créneaux ci-dessus).
      if (b.max_posts_per_day != null && !(patch.publish_times && patch.publish_times.length)) patch.max_posts_per_day = Math.max(1, Math.min(10, Number(b.max_posts_per_day) || 1));
      if (typeof b.emotion_from_image === 'boolean') patch.emotion_from_image = b.emotion_from_image;
      if (typeof b.thumbnail_enabled === 'boolean') patch.thumbnail_enabled = b.thumbnail_enabled;
      if (typeof b.thumbnail_text === 'boolean') patch.thumbnail_text = b.thumbnail_text;
      if (typeof b.video_text === 'boolean') patch.video_text = b.video_text;
      if (['playfair', 'inter', 'cormorant'].includes(b.thumbnail_font)) patch.thumbnail_font = b.thumbnail_font;
      if (b.background_mode === 'single' || b.background_mode === 'slideshow') patch.background_mode = b.background_mode;
      if (b.slideshow_count != null) patch.slideshow_count = Math.max(0, Math.min(100, Number(b.slideshow_count) || 0));
      if (b.reuse_gap != null) patch.reuse_gap = Math.max(0, Math.min(365, Number(b.reuse_gap) || 0));
      for (const k of ['objective', 'product_desc', 'product_url', 'affiliate_url', 'affiliate_label']) if (typeof b[k] === 'string') patch[k] = b[k].trim();
      if (Array.isArray(b.inspiration_urls)) patch.inspiration_urls = b.inspiration_urls.map(s => String(s).trim()).filter(Boolean).slice(0, 20);
      // Secrets : mis à jour uniquement si une nouvelle valeur non vide est fournie (sinon on conserve l'existant).
      // Garde-fou anti-écrasement : chaque identifiant a un FORMAT attendu. Une valeur implausible (typiquement
      // un mot de passe de connexion injecté par l'autofill du navigateur dans un champ « laissé vide ») est
      // IGNORÉE — on ne l'écrit pas (et on ne bloque pas le reste de la sauvegarde). Cf. l'incident « testeur5 ».
      const credFormat = {
        yt_client_secret: v => /^GOCSPX-[\w-]{10,}$/.test(v),   // secret Google
        yt_refresh_token: v => v.length >= 40,                  // refresh token Google (~100+ car.)
        epidemic_jwt: v => v.length >= 40,                      // JWT long
        claude_token: v => /^sk-ant-/.test(v)                   // token OAuth Claude
      };
      const skippedCreds = [];
      for (const [field, incoming] of [['yt_client_secret', b.yt_client_secret], ['yt_refresh_token', b.yt_refresh_token], ['epidemic_jwt', b.epidemic_jwt], ['claude_token', b.claude_token]]) {
        if (typeof incoming !== 'string' || !incoming.trim()) continue; // vide -> on conserve l'existant
        const val = incoming.trim();
        if (credFormat[field](val)) patch[field] = val;
        else skippedCreds.push(field);
      }
      const updated = await updateChannel(ch.id, patch);
      // Identifiants partagés du compte (Epidemic/Claude/OAuth client) -> répercutés sur TOUTES les chaînes.
      await propagateSharedCreds(patch).catch(() => {});
      // SEO ancré sur le produit : dès qu'un site produit est renseigné/changé et qu'aucun plan n'existe encore
      // (ou que l'URL vient de changer), on (re)génère le plan SEO en arrière-plan à partir de l'analyse du site.
      const urlChanged = 'product_url' in patch && (patch.product_url || '') !== (ch.product_url || '');
      if ((updated.product_url && !updated.seo_plan) || urlChanged) autoGenerateSeoPlan(updated).catch(() => {});
      // Si la fenêtre horaire ou l'interrupteur du CRON a changé, on reprogramme.
      if (patch.publish_time_start || patch.publish_time_end || 'cron_enabled' in patch || 'max_posts_per_day' in patch) setupScheduler().catch(() => {});
      if ('stats_daily' in patch || 'daily_report_hour' in patch) setupStatsRefresh().catch(() => {});
      // Reprise auto : un jeton Epidemic frais vient d'être collé -> si des vidéos avaient échoué faute d'Epidemic,
      // on nettoie ces tentatives mortes et on relance une génération automatiquement.
      let resumed = false;
      if (patch.epidemic_jwt) {
        const ep = await testEpidemic({ jwt: channelCreds(updated).epidemicJwt, cookies: channelCreds(updated).epidemicCookies }).catch(() => ({ ok: false }));
        if (ep.ok) {
          const stuck = await dbSelect('videos', `?channel_id=eq.${ch.id}&status=eq.failed&note=eq.epidemic_auth&select=id`).catch(() => []);
          if (stuck.length) {
            await dbDelete('videos', `channel_id=eq.${ch.id}&status=eq.failed&note=eq.epidemic_auth`).catch(() => {});
            resumed = generateOnce({ dryRun: false });
            notifyChannel(updated, 'epidemic_auth', { title: '🔁 Epidemic reconnecté', description: `Jeton frais accepté — reprise automatique de la génération (${stuck.length} tentative(s) en échec nettoyée(s)).`, color: COLORS.ok });
          }
        }
      }
      const credLabels = { yt_client_secret: 'Secret client YouTube', yt_refresh_token: 'Refresh token YouTube', epidemic_jwt: 'Token Epidemic', claude_token: 'Token Claude' };
      const credWarning = skippedCreds.length ? ('Valeur(s) ignorée(s) car format invalide (souvent l\'autofill du navigateur) : ' + skippedCreds.map(f => credLabels[f]).join(', ') + '. L\'identifiant existant a été conservé.') : null;
      return json(res, { ok: true, channel: channelPublicView(updated), resumed, credWarning });
    }
    // Désactive/retire le webhook Discord de la chaîne active (plus aucune notification envoyée).
    if (req.method === 'POST' && path === '/api/settings/discord/clear') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      await dbPatch('channels', `id=eq.${ch.id}`, { discord_webhook: null });
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/test/discord') {
      const ch = await getActiveChannel();
      if (!ch?.discord_webhook) return json(res, { ok: false, detail: 'aucun webhook configuré' });
      const ok = await sendDiscord(ch.discord_webhook, { title: '🔔 Test — The Playlist Youtube', description: 'Le webhook de la chaîne « ' + (ch.name || '') + ' » est bien connecté.', color: COLORS.info, footer: { text: '📺 ' + (ch.name || 'Chaîne') } });
      return json(res, { ok, detail: ok ? 'message envoyé sur Discord' : 'échec de l\'envoi' });
    }
    // Analyse les chaînes d'inspiration -> playbook (patterns titres/miniatures).
    if (req.method === 'POST' && path === '/api/settings/analyze-inspiration') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const urls = Array.isArray(ch.inspiration_urls) ? ch.inspiration_urls : [];
      if (!urls.length) return json(res, { ok: false, error: 'ajoute au moins une chaîne d\'inspiration puis enregistre avant d\'analyser' });
      const token = channelCreds(ch).claudeToken;
      const r = await analyzeInspiration(urls, { token, model: ch.claude_model || 'sonnet', log: m => console.log('[playbook]', m) });
      if (!r.ok) return json(res, { ok: false, error: r.error });
      const updated = await updateChannel(ch.id, { playbook: r.playbook, playbook_updated_at: new Date().toISOString() });
      return json(res, { ok: true, playbook: r.playbook, errors: r.errors || [], channel: channelPublicView(updated) });
    }
    // Lance une analyse du coach maintenant (manuel) + rapport.
    if (req.method === 'POST' && path === '/api/settings/coach-run') {
      const r = await runCoach({ force: true });
      if (!r.ok) return json(res, { ok: false, error: r.error });
      return json(res, { ok: true, state: r.state, channel: channelPublicView(await getActiveChannel()) });
    }
    // Génère le plan SEO durable de la chaîne (piliers, mots-clés, vivier de hashtags, CTA…).
    if (req.method === 'POST' && path === '/api/settings/generate-seo-plan') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const urls = Array.isArray(ch.inspiration_urls) ? ch.inspiration_urls : [];
      const refs = await dbSelect('reference_songs', `?active=eq.true&channel_id=eq.${ch.id}&select=title`).catch(() => []);
      const token = channelCreds(ch).claudeToken;
      const r = await generateSeoPlan({ objective: ch.objective || '', productDesc: ch.product_desc || '', productUrl: ch.product_url || '', inspirationUrls: urls, references: refs, token, model: ch.claude_model || 'sonnet', log: m => console.log('[seo]', m) });
      if (!r.ok) return json(res, { ok: false, error: r.error });
      const patch = { seo_plan: r.plan, seo_plan_updated_at: new Date().toISOString() };
      if (ch.product_url) {
        const blog = await fetchBlogArticles(ch.product_url, { log: m => console.log('[blog]', m) }).catch(() => ({ ok: false }));
        if (blog.ok) { patch.blog_articles = blog.articles; patch.blog_articles_updated_at = new Date().toISOString(); }
      }
      const updated = await updateChannel(ch.id, patch);
      return json(res, { ok: true, plan: r.plan, blog_articles_count: patch.blog_articles?.length ?? (Array.isArray(ch.blog_articles) ? ch.blog_articles.length : 0), channel: channelPublicView(updated) });
    }
    // Dérive la palette d'émotions depuis les chaînes modèles + les chansons de référence.
    if (req.method === 'POST' && path === '/api/settings/derive-emotions') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const urls = Array.isArray(ch.inspiration_urls) ? ch.inspiration_urls : [];
      const refs = await dbSelect('reference_songs', `?active=eq.true&channel_id=eq.${ch.id}&select=title,artist,mood_tags`).catch(() => []);
      const token = channelCreds(ch).claudeToken;
      const r = await deriveEmotions({ inspirationUrls: urls, references: refs, token, model: ch.claude_model || 'sonnet', log: m => console.log('[emotions]', m) });
      if (!r.ok) return json(res, { ok: false, error: r.error });
      const updated = await updateChannel(ch.id, { emotion_palette: r.emotions, emotion_cursor: 0, emotion_palette_updated_at: new Date().toISOString() });
      return json(res, { ok: true, emotions: r.emotions, channel: channelPublicView(updated) });
    }
    // Rafraîchit le nom (et l'ID) de la chaîne depuis YouTube.
    if (req.method === 'POST' && path === '/api/settings/refresh-name') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const creds = channelCreds(ch);
      if (!creds.youtube?.refreshToken) return json(res, { ok: false, error: 'YouTube non connecté sur cette chaîne' });
      try {
        const yt = await getMyChannel(creds.youtube);
        const title = yt?.snippet?.title?.trim();
        if (!title) return json(res, { ok: false, error: 'nom introuvable côté YouTube' });
        const patch = { name: title };
        if (yt.id && yt.id !== ch.yt_channel_id) patch.yt_channel_id = yt.id;
        if (yt.snippet?.customUrl) patch.yt_handle = yt.snippet.customUrl; // ex : "@au-bon-moment"
        const updated = await updateChannel(ch.id, patch);
        return json(res, { ok: true, name: title, channel: channelPublicView(updated) });
      } catch (e) { return json(res, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && (path === '/api/test/youtube' || path === '/api/test/epidemic' || path === '/api/test/claude')) {
      const creds = channelCreds(await getActiveChannel());
      if (path.endsWith('youtube')) return json(res, await testYouTube(creds.youtube || {}));
      if (path.endsWith('epidemic')) return json(res, await testEpidemic({ jwt: creds.epidemicJwt, cookies: creds.epidemicCookies }));
      return json(res, await testClaude(creds.claudeToken));
    }

    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    console.error('Erreur serveur:', e);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Panel sur http://${HOST}:${PORT}`);
  setupScheduler().catch(e => console.error('[scheduler] init KO', e.message));
  setupStatsRefresh().catch(e => console.error('[stats] init KO', e.message));
  setupWeeklyRecap().catch(e => console.error('[recap] init KO', e.message));
  setupCoach().catch(e => console.error('[coach] init KO', e.message));
  // Nettoyage des générations orphelines (interrompues par un redémarrage/redéploiement) -> marquées échec,
  // avec un `note` dédié pour que l'UI propose directement le bouton « Reprendre ».
  dbPatch('videos', 'status=in.(curating,downloading,rendering,uploading)', { status: 'failed', error: 'interrompu par un redémarrage du serveur', note: 'interrupted' })
    .then(async rows => {
      if (!rows?.length) return;
      console.log(`[cleanup] ${rows.length} génération(s) orpheline(s) marquée(s) échec`);
      const byChannel = new Map();
      for (const v of rows) { const k = v.channel_id || 'none'; if (!byChannel.has(k)) byChannel.set(k, 0); byChannel.set(k, byChannel.get(k) + 1); }
      for (const [chId, n] of byChannel) {
        const ch = chId !== 'none' ? await getChannel(chId).catch(() => null) : await getActiveChannel().catch(() => null);
        if (ch) notifyChannel(ch, 'gen_failed', { title: '⏸️ Génération interrompue', description: `${n} génération(s) interrompue(s) par un redémarrage du serveur — clique « Reprendre » sur la vidéo en échec pour relancer.`, color: COLORS.warn });
      }
    })
    .catch(() => {});
});
