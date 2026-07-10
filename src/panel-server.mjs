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
import { setPrivacyStatus, deleteVideo } from './services/youtube.mjs';
import { testYouTube, testEpidemic, testClaude } from './services/connectionTests.mjs';
import { listChannels, getActiveChannel, createChannel, setActiveChannel, updateChannel, channelCreds, channelPublicView } from './services/channels.mjs';

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
const genState = { running: false, videoId: null, phase: null, error: null, startedAt: null, lastResult: null };
let genTimer = null;

function generateOnce({ dryRun = false } = {}) {
  if (genState.running) return false;
  Object.assign(genState, { running: true, error: null, phase: 'démarrage', startedAt: Date.now(), videoId: null });
  runPipeline({ dryRun, log: m => { genState.phase = m; } })
    .then(r => { Object.assign(genState, { running: false, lastResult: r, videoId: r.videoId, phase: 'terminé' }); })
    .catch(e => { Object.assign(genState, { running: false, error: String(e.message || e), phase: 'échec' }); console.error('[gen] échec', e); });
  return true;
}

function msUntilNextDaily(hhmm) {
  const [h, m] = String(hhmm || '18:00').split(':').map(Number);
  const now = new Date();
  const next = new Date(now); next.setHours(h || 18, m || 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}
async function setupScheduler() {
  if (genTimer) clearTimeout(genTimer);
  const settings = (await dbSelect('settings', '?limit=1').catch(() => []))[0] || {};
  const wait = msUntilNextDaily(settings.daily_publish_time);
  genTimer = setTimeout(async () => {
    console.log('[scheduler] génération quotidienne');
    generateOnce({ dryRun: false });
    setupScheduler();
  }, wait);
  console.log(`[scheduler] prochaine génération dans ${Math.round(wait / 60000)} min (${settings.daily_publish_time || '18:00'} ${process.env.TZ})`);
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
</style></head><body>
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
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const q = url.searchParams;

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
      const ch = await getActiveChannel();
      const rows = await dbSelect('reference_songs', (ch ? `?channel_id=eq.${ch.id}&` : '?') + 'order=added_at.desc');
      return json(res, rows);
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
        const ch = await getActiveChannel();
        const [row] = await dbInsert('reference_songs', [{ spotify_url: spotifyUrl, title, artist, mood_tags: moodTags, channel_id: ch?.id || null }]);
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
      return json(res, genState);
    }
    if (req.method === 'POST' && path === '/api/videos/generate') {
      const refs = await dbSelect('reference_songs', '?active=eq.true&limit=1').catch(() => []);
      if (!refs.length) return json(res, { ok: false, error: 'Ajoute au moins une chanson de référence active avant de générer.' });
      const started = generateOnce({ dryRun: false });
      return json(res, { ok: true, started });
    }
    if (req.method === 'POST' && path === '/api/videos/approve') {
      const b = await readJsonBody(req);
      const [v] = await dbSelect('videos', `?id=eq.${b.id}`);
      if (!v) return json(res, { ok: false, error: 'vidéo introuvable' });
      try {
        if (v.youtube_video_id) await setPrivacyStatus(v.youtube_video_id, 'public');
        await dbPatch('videos', `id=eq.${b.id}`, { status: 'published' });
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
      if (b.ad_frequency_min != null) patch.ad_frequency_min = Math.max(1, Number(b.ad_frequency_min) || 10);
      if (b.ad_duration_sec != null) patch.ad_duration_sec = Math.max(2, Number(b.ad_duration_sec) || 8);
      if (b.ad_placement && typeof b.ad_placement === 'object') patch.ad_placement = b.ad_placement;
      if (typeof b.ad_intro === 'boolean') patch.ad_intro = b.ad_intro;
      if (typeof b.ad_outro === 'boolean') patch.ad_outro = b.ad_outro;
      // Secrets : mis à jour uniquement si une nouvelle valeur non vide est fournie (sinon on conserve l'existant).
      for (const [field, incoming] of [['yt_client_secret', b.yt_client_secret], ['yt_refresh_token', b.yt_refresh_token], ['epidemic_jwt', b.epidemic_jwt], ['claude_token', b.claude_token]]) {
        if (typeof incoming === 'string' && incoming.trim()) patch[field] = incoming.trim();
      }
      const updated = await updateChannel(ch.id, patch);
      return json(res, { ok: true, channel: channelPublicView(updated) });
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
});
