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
import { setPrivacyStatus, deleteVideo, getMyChannel } from './services/youtube.mjs';
import { testYouTube, testEpidemic, testClaude } from './services/connectionTests.mjs';
import { listChannels, getActiveChannel, getChannel, createChannel, setActiveChannel, updateChannel, channelCreds, channelPublicView, propagateSharedCreds } from './services/channels.mjs';
import { sendDiscord, isDiscordWebhook, COLORS } from './services/notify.mjs';
import { analyzeInspiration } from './steps/playbook.mjs';
import { deriveEmotions } from './steps/emotions.mjs';
import { generateSeoPlan } from './steps/seoPlan.mjs';
import { computeCadence, analyzeAndDecide } from './steps/coach.mjs';

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
let genController = null;

function generateOnce({ dryRun = false, targetSec = null } = {}) {
  if (genState.running) return false;
  const controller = { cancelled: false, child: null };
  genController = controller;
  Object.assign(genState, { running: true, error: null, cancelled: false, phase: 'démarrage', startedAt: Date.now(), videoId: null, log: [] });
  const pushLog = (m) => {
    const line = { t: Date.now(), m: String(m) };
    genState.phase = line.m; genState.log.push(line);
    if (genState.log.length > 600) genState.log.shift();
  };
  pushLog('démarrage de la génération…' + (targetSec ? ` (durée visée ${Math.round(targetSec / 60)} min)` : ''));
  runPipeline({ dryRun, targetSec, controller, log: pushLog })
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

async function setupScheduler() {
  if (genTimer) clearTimeout(genTimer);
  const ch = await getActiveChannel().catch(() => null);
  if (!ch?.cron_enabled) { console.log('[scheduler] CRON désactivé — aucune génération automatique programmée.'); return; }
  const { published, ageDays } = await channelMaturity(ch.id);
  const cadence = computeCadence({ publishedCount: published, ageDays, maxPerDay: ch.max_posts_per_day || 1 });
  const doneToday = await generatedToday(ch.id);
  const start = ch.publish_time_start || (ch.daily_publish_time ? String(ch.daily_publish_time).slice(0, 5) : '18:00');
  const end = ch.publish_time_end || start;
  const now = new Date();
  const { startDt, endDt } = windowDates(start, end, now);
  let at;
  if (doneToday < cadence && now < endDt) at = pickInRange(new Date(Math.max(now, startDt)), endDt);           // encore un créneau aujourd'hui
  else at = pickInRange(new Date(startDt.getTime() + 86400000), new Date(endDt.getTime() + 86400000));         // demain
  const wait = Math.max(1000, at - now);
  genTimer = setTimeout(async () => {
    const cur = await getActiveChannel().catch(() => null);
    if (cur?.cron_enabled && (await generatedToday(cur.id)) < computeCadence({ publishedCount: published, ageDays, maxPerDay: cur.max_posts_per_day || 1 })) {
      console.log('[scheduler] génération (cadence ' + cadence + '/j)'); generateOnce({ dryRun: false });
    } else console.log('[scheduler] créneau sauté (CRON off ou quota du jour atteint).');
    setupScheduler();
  }, wait);
  console.log(`[scheduler] cadence ${cadence}/j (${published} publiées, ${ageDays}j) · déjà ${doneToday} aujourd'hui · prochaine ${at.toLocaleString('fr-FR')} (fenêtre ${start}–${end})`);
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
    sendDiscord(ch.discord_webhook, { title: '🧠 Rapport du coach — ' + ch.name, description: lines.slice(0, 1800), color: COLORS.info }).catch(() => {});
  }
  return r;
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

    // ── Assets ──
    if (req.method === 'GET' && path === '/api/assets') {
      const ch = await getActiveChannel();
      const rows = await dbSelect('assets', (ch ? `?channel_id=eq.${ch.id}&` : '?') + 'order=uploaded_at.desc');
      const withUrls = await Promise.all(rows.map(async r => ({ ...r, url: await storageSign('assets', r.storage_path).catch(() => null) })));
      return json(res, withUrls);
    }
    if (req.method === 'POST' && path === '/api/assets/upload') {
      const kind = q.get('kind') || 'other';
      const filename = decodeURIComponent(q.get('filename') || 'fichier');
      const contentType = req.headers['content-type'] || 'application/octet-stream';
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
      return json(res, rows);
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
      // Durée en fourchette (minutes) fournie à la génération manuelle -> tirage aléatoire ; sinon fourchette de la chaîne.
      const b = await readJsonBody(req).catch(() => ({}));
      let targetSec = null;
      const mn = Number(b?.minMin), mx = Number(b?.maxMin);
      if (mn >= 1 && mx >= 1) {
        const lo = Math.max(5, Math.min(mn, mx)), hi = Math.min(600, Math.max(mn, mx));
        targetSec = (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60;
      }
      const started = generateOnce({ dryRun: false, targetSec });
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
        if (v.youtube_video_id) await setPrivacyStatus(v.youtube_video_id, 'public');
        await dbPatch('videos', `id=eq.${b.id}`, { status: 'published', published_at: new Date().toISOString() });
        return json(res, { ok: true });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
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
        if (v?.youtube_video_id) await deleteVideo(v.youtube_video_id).catch(() => {});
        await dbDelete('videos', `id=eq.${b.id}`);
        return json(res, { ok: true });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
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

    // ── Paramètres (chaîne active) ──
    if (req.method === 'GET' && path === '/api/settings') {
      return json(res, channelPublicView(await getActiveChannel()) || {});
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
      if (isHHMM(b.publish_time_start)) patch.publish_time_start = b.publish_time_start;
      if (isHHMM(b.publish_time_end)) patch.publish_time_end = b.publish_time_end;
      if (isHHMM(b.publish_time_start)) patch.daily_publish_time = b.publish_time_start; // rétro-compat
      if (b.ad_frequency_min != null) patch.ad_frequency_min = Math.max(1, Number(b.ad_frequency_min) || 10);
      if (b.ad_duration_sec != null) patch.ad_duration_sec = Math.max(2, Number(b.ad_duration_sec) || 8);
      if (b.ad_placement && typeof b.ad_placement === 'object') patch.ad_placement = b.ad_placement;
      if (typeof b.ad_intro === 'boolean') patch.ad_intro = b.ad_intro;
      if (typeof b.ad_outro === 'boolean') patch.ad_outro = b.ad_outro;
      if (typeof b.discord_webhook === 'string' && b.discord_webhook.trim()) { const w = b.discord_webhook.trim(); if (isDiscordWebhook(w)) patch.discord_webhook = w; else return json(res, { ok: false, error: 'Webhook Discord invalide (https://discord.com/api/webhooks/…)' }); }
      if (b.publish_mode === 'auto' || b.publish_mode === 'review') patch.publish_mode = b.publish_mode;
      if (typeof b.cron_enabled === 'boolean') patch.cron_enabled = b.cron_enabled;
      if (typeof b.coach_enabled === 'boolean') patch.coach_enabled = b.coach_enabled;
      if (b.max_posts_per_day != null) patch.max_posts_per_day = Math.max(1, Math.min(10, Number(b.max_posts_per_day) || 1));
      if (typeof b.emotion_from_image === 'boolean') patch.emotion_from_image = b.emotion_from_image;
      if (typeof b.thumbnail_enabled === 'boolean') patch.thumbnail_enabled = b.thumbnail_enabled;
      if (typeof b.thumbnail_text === 'boolean') patch.thumbnail_text = b.thumbnail_text;
      if (['playfair', 'inter', 'cormorant'].includes(b.thumbnail_font)) patch.thumbnail_font = b.thumbnail_font;
      if (b.background_mode === 'single' || b.background_mode === 'slideshow') patch.background_mode = b.background_mode;
      if (b.slideshow_count != null) patch.slideshow_count = Math.max(0, Math.min(100, Number(b.slideshow_count) || 0));
      if (b.reuse_gap != null) patch.reuse_gap = Math.max(0, Math.min(365, Number(b.reuse_gap) || 0));
      for (const k of ['objective', 'product_desc', 'affiliate_url', 'affiliate_label']) if (typeof b[k] === 'string') patch[k] = b[k].trim();
      if (Array.isArray(b.inspiration_urls)) patch.inspiration_urls = b.inspiration_urls.map(s => String(s).trim()).filter(Boolean).slice(0, 20);
      // Secrets : mis à jour uniquement si une nouvelle valeur non vide est fournie (sinon on conserve l'existant).
      for (const [field, incoming] of [['yt_client_secret', b.yt_client_secret], ['yt_refresh_token', b.yt_refresh_token], ['epidemic_jwt', b.epidemic_jwt], ['claude_token', b.claude_token]]) {
        if (typeof incoming === 'string' && incoming.trim()) patch[field] = incoming.trim();
      }
      const updated = await updateChannel(ch.id, patch);
      // Identifiants partagés du compte (Epidemic/Claude/OAuth client) -> répercutés sur TOUTES les chaînes.
      await propagateSharedCreds(patch).catch(() => {});
      // Si la fenêtre horaire ou l'interrupteur du CRON a changé, on reprogramme.
      if (patch.publish_time_start || patch.publish_time_end || 'cron_enabled' in patch || 'max_posts_per_day' in patch) setupScheduler().catch(() => {});
      return json(res, { ok: true, channel: channelPublicView(updated) });
    }
    if (req.method === 'POST' && path === '/api/test/discord') {
      const ch = await getActiveChannel();
      if (!ch?.discord_webhook) return json(res, { ok: false, detail: 'aucun webhook configuré' });
      const ok = await sendDiscord(ch.discord_webhook, { title: '🔔 Test — The Playlist Youtube', description: 'Le webhook de la chaîne « ' + (ch.name || '') + ' » est bien connecté.', color: COLORS.info });
      return json(res, { ok, detail: ok ? 'message envoyé sur Discord' : 'échec de l\'envoi' });
    }
    // Analyse les chaînes d'inspiration -> playbook (patterns titres/miniatures).
    if (req.method === 'POST' && path === '/api/settings/analyze-inspiration') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const urls = Array.isArray(ch.inspiration_urls) ? ch.inspiration_urls : [];
      if (!urls.length) return json(res, { ok: false, error: 'ajoute au moins une chaîne d\'inspiration puis enregistre avant d\'analyser' });
      const token = channelCreds(ch).claudeToken;
      const r = await analyzeInspiration(urls, { token, log: m => console.log('[playbook]', m) });
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
      const r = await generateSeoPlan({ objective: ch.objective || '', productDesc: ch.product_desc || '', inspirationUrls: urls, references: refs, token, log: m => console.log('[seo]', m) });
      if (!r.ok) return json(res, { ok: false, error: r.error });
      const updated = await updateChannel(ch.id, { seo_plan: r.plan, seo_plan_updated_at: new Date().toISOString() });
      return json(res, { ok: true, plan: r.plan, channel: channelPublicView(updated) });
    }
    // Dérive la palette d'émotions depuis les chaînes modèles + les chansons de référence.
    if (req.method === 'POST' && path === '/api/settings/derive-emotions') {
      const ch = await getActiveChannel();
      if (!ch) return json(res, { ok: false, error: 'aucune chaîne active' });
      const urls = Array.isArray(ch.inspiration_urls) ? ch.inspiration_urls : [];
      const refs = await dbSelect('reference_songs', `?active=eq.true&channel_id=eq.${ch.id}&select=title,artist,mood_tags`).catch(() => []);
      const token = channelCreds(ch).claudeToken;
      const r = await deriveEmotions({ inspirationUrls: urls, references: refs, token, log: m => console.log('[emotions]', m) });
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
      if (path.endsWith('epidemic')) return json(res, await testEpidemic(creds.epidemicJwt));
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
  setupCoach().catch(e => console.error('[coach] init KO', e.message));
  // Nettoyage des générations orphelines (interrompues par un redémarrage) -> marquées échec.
  dbPatch('videos', 'status=in.(curating,downloading,rendering,uploading)', { status: 'failed', error: 'interrompu par un redémarrage du serveur' })
    .then(r => { if (r?.length) console.log(`[cleanup] ${r.length} génération(s) orpheline(s) marquée(s) échec`); })
    .catch(() => {});
});
