// Renouvellement AUTOMATIQUE du jeton Epidemic — tourne dans le cloud (GitHub Actions), sans ordinateur allumé.
//
// Principe : Epidemic interdit tout refresh serveur (refresh_token/password/DCR = unauthorized_client). Le jeton
// ne peut naître que dans un navigateur connecté. Ce script rejoue TA SESSION (cookies stockés en secret GitHub)
// dans un Chromium headless, laisse la page Epidemic s'authentifier silencieusement, capte le jeton frais dans
// une requête réseau, et le pousse dans l'app via /api/settings/epidemic-token (protégé par secret partagé).
//
// Limite : les cookies de session expirent aussi (quelques semaines/mois). Quand ça arrive, le job échoue ->
// il faut ré-extraire les cookies une fois depuis un nouveau login. C'est la seule intervention manuelle restante.
//
// Env attendues :
//   EPIDEMIC_COOKIES        JSON (array de cookies exportés du navigateur, format Playwright ou extension "cookies")
//   APP_URL                 base de l'app (ex : https://music-youtube-video-production.up.railway.app)
//   EPIDEMIC_REFRESH_SECRET secret partagé identique à celui configuré sur l'app (Railway)
//   DISCORD_WEBHOOK         (optionnel) pour alerter en cas d'échec (session morte -> re-login requis)
import { chromium } from 'playwright';

const { EPIDEMIC_COOKIES, APP_URL, EPIDEMIC_REFRESH_SECRET, DISCORD_WEBHOOK } = process.env;

function fail(msg) { console.error('❌ ' + msg); return msg; }

async function notify(msg) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: '🔑 Renouvellement Epidemic échoué', description: msg.slice(0, 1500) + '\n\nRé-extrais tes cookies Epidemic et mets à jour le secret GitHub `EPIDEMIC_COOKIES`.', color: 0xE23D3D }] })
    });
  } catch {}
}

// Normalise les cookies pour Playwright (accepte l'export "EditThisCookie"/DevTools : sameSite en texte, etc.).
function normalizeCookies(raw) {
  const arr = JSON.parse(raw);
  const ss = v => (['Strict', 'Lax', 'None'].includes(v) ? v : (v === 'no_restriction' ? 'None' : v === 'lax' ? 'Lax' : v === 'strict' ? 'Strict' : 'Lax'));
  return arr.map(c => {
    const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: !!c.httpOnly, secure: c.secure !== false, sameSite: ss(c.sameSite) };
    if (typeof c.expirationDate === 'number') out.expires = Math.floor(c.expirationDate);
    else if (typeof c.expires === 'number' && c.expires > 0) out.expires = Math.floor(c.expires);
    if (!out.domain) throw new Error('cookie sans domain : ' + c.name);
    return out;
  });
}

// Un JWT Epidemic ressemble à eyJ....eyJ....sig (3 segments base64url). On garde le plus long capté.
function looksLikeJwt(t) { return /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(t || ''); }

async function main() {
  if (!EPIDEMIC_COOKIES) return fail('EPIDEMIC_COOKIES manquant');
  if (!APP_URL) return fail('APP_URL manquant');
  if (!EPIDEMIC_REFRESH_SECRET) return fail('EPIDEMIC_REFRESH_SECRET manquant');

  let cookies;
  try { cookies = normalizeCookies(EPIDEMIC_COOKIES); }
  catch (e) { return fail('cookies illisibles : ' + e.message); }
  console.log(`cookies chargés : ${cookies.length}`);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'fr-FR'
  });
  await context.addCookies(cookies);

  const tokens = new Set();
  const grab = h => {
    const auth = h?.authorization || h?.Authorization;
    if (auth && /^Bearer\s+eyJ/.test(auth)) { const t = auth.replace(/^Bearer\s+/, '').trim(); if (looksLikeJwt(t)) tokens.add(t); }
  };
  context.on('request', r => grab(r.headers()));

  const page = await context.newPage();
  try {
    // La home authentifiée déclenche des appels API portant le Bearer. On visite aussi la bibliothèque musicale
    // pour forcer des requêtes catalogue si la home n'en émet pas assez.
    await page.goto('https://www.epidemicsound.com/music/search/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
    if (![...tokens].some(looksLikeJwt)) {
      await page.goto('https://www.epidemicsound.com/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
    }
    // Dernier recours : lire un éventuel jeton stocké côté page.
    if (![...tokens].size) {
      const fromStore = await page.evaluate(() => {
        const hunt = s => { for (let i = 0; i < s.length; i++) { const v = s.getItem(s.key(i)); const m = (v || '').match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/); if (m) return m[0]; } return null; };
        try { return hunt(localStorage) || hunt(sessionStorage); } catch { return null; }
      }).catch(() => null);
      if (fromStore) tokens.add(fromStore);
    }
  } finally {
    await browser.close();
  }

  // On garde le jeton avec l'exp la plus lointaine (le plus frais).
  const expOf = t => { try { return JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).exp || 0; } catch { return 0; } };
  const best = [...tokens].filter(looksLikeJwt).sort((a, b) => expOf(b) - expOf(a))[0];
  if (!best) { const m = fail('aucun jeton capté — session probablement expirée (re-login requis)'); await notify(m); process.exit(1); }
  console.log(`jeton capté (exp ${new Date(expOf(best) * 1000).toISOString()})`);

  // Pousse le jeton frais dans l'app (qui le valide, le propage à toutes les chaînes et relance les échecs).
  const res = await fetch(APP_URL.replace(/\/$/, '') + '/api/settings/epidemic-token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-refresh-secret': EPIDEMIC_REFRESH_SECRET },
    body: JSON.stringify({ jwt: best })
  });
  const body = await res.text();
  if (!res.ok) { const m = fail(`l'app a refusé le jeton : HTTP ${res.status} ${body.slice(0, 200)}`); await notify(m); process.exit(1); }
  console.log('✅ jeton Epidemic mis à jour dans l\'app : ' + body.slice(0, 200));
}

main().catch(async e => { const m = fail('erreur inattendue : ' + (e?.message || e)); await notify(m); process.exit(1); });
