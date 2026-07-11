// Renouvellement AUTOMATIQUE de la session Epidemic — cloud (GitHub Actions), sans ordinateur allumé.
//
// Le MCP Epidemic s'authentifie par COOKIES de session (prouvé : search + download fonctionnent depuis un
// simple serveur avec l'en-tête Cookie). Ce job rejoue TA SESSION (cookies en secret GitHub) dans un Chromium
// headless, visite le site — ce qui RAFRAÎCHIT/prolonge la session (Set-Cookie, ré-auth SSO silencieuse) —
// puis récupère les cookies frais et les pousse dans l'app via /api/settings/epidemic-token.
//
// La session SSO Keycloak (KEYCLOAK_SESSION) est longue (≈ jusqu'en 2027) : tant qu'elle vit, le job renouvelle
// tout seul les cookies de l'app. Intervention manuelle uniquement si la session SSO meurt (déconnexion) ->
// ré-extraire les cookies une fois.
//
// Env :
//   EPIDEMIC_COOKIES        cookies exportés (Netscape "Get cookies.txt LOCALLY", ou JSON) — les DEUX domaines
//                           (www.epidemicsound.com ET login.epidemicsound.com)
//   APP_URL                 base de l'app (ex : https://…railway.app)
//   EPIDEMIC_REFRESH_SECRET secret partagé identique à celui de l'app
//   DISCORD_WEBHOOK         (optionnel) alerte si la session est morte
import { chromium } from 'playwright';

const { EPIDEMIC_COOKIES, APP_URL, EPIDEMIC_REFRESH_SECRET, DISCORD_WEBHOOK } = process.env;
function fail(m) { console.error('❌ ' + m); return m; }
async function notify(msg) {
  if (!DISCORD_WEBHOOK) return;
  try { await fetch(DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [{ title: '🔑 Renouvellement Epidemic échoué', description: msg.slice(0, 1500) + '\n\nRé-exporte tes cookies Epidemic (les 2 domaines) et mets à jour le secret GitHub `EPIDEMIC_COOKIES`.', color: 0xE23D3D }] }) }); } catch {}
}

// Accepte Netscape cookies.txt OU JSON array -> cookies Playwright.
function loadCookies(raw) {
  const t = raw.trim();
  const ss = v => (['Strict', 'Lax', 'None'].includes(v) ? v : v === 'no_restriction' ? 'None' : v === 'lax' ? 'Lax' : v === 'strict' ? 'Strict' : 'Lax');
  if (t.startsWith('[') || t.startsWith('{')) {
    const arr = JSON.parse(t); const list = Array.isArray(arr) ? arr : (arr.cookies || []);
    return list.map(c => { const o = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: !!c.httpOnly, secure: c.secure !== false, sameSite: ss(c.sameSite) }; const e = c.expires ?? c.expirationDate; if (typeof e === 'number' && e > 0) o.expires = Math.floor(e); return o; });
  }
  const out = [];
  for (const lineRaw of t.split(/\r?\n/)) {
    let line = lineRaw, httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice(10); }
    else if (line.startsWith('#') || !line.trim()) continue;
    const f = line.split('\t'); if (f.length < 7) continue;
    const o = { name: f[5], value: f.slice(6).join('\t'), domain: f[0], path: f[2] || '/', secure: f[3] === 'TRUE', httpOnly, sameSite: 'Lax' };
    const e = Number(f[4]); if (e > 0) o.expires = e;
    out.push(o);
  }
  return out;
}

async function main() {
  if (!EPIDEMIC_COOKIES) return fail('EPIDEMIC_COOKIES manquant');
  if (!APP_URL) return fail('APP_URL manquant');
  if (!EPIDEMIC_REFRESH_SECRET) return fail('EPIDEMIC_REFRESH_SECRET manquant');

  let seed;
  try { seed = loadCookies(EPIDEMIC_COOKIES); } catch (e) { return fail('cookies illisibles : ' + e.message); }
  console.log('cookies chargés :', seed.length);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', locale: 'fr-FR' });
  await context.addCookies(seed);
  const page = await context.newPage();
  try {
    // Visiter le site connecté rafraîchit la session (Set-Cookie) et, si besoin, ré-authentifie via le SSO.
    await page.goto('https://www.epidemicsound.com/music/featured/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    // Un appel MCP force le serveur à (re)valider la session et à poser les cookies d'affinité à jour.
    await page.evaluate(async () => {
      try { await fetch('https://www.epidemicsound.com/a/mcp-service/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'refresh', version: '1' } } }) }); } catch {}
    }).catch(() => {});
    await page.waitForTimeout(1500);
  } finally {
    var fresh = await context.cookies().catch(() => []);
    await browser.close();
  }

  // On ne garde que les cookies Epidemic (www + login), c'est ce que l'app réinjecte et envoie au MCP.
  const keep = fresh.filter(c => String(c.domain).includes('epidemicsound.com'))
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expires }));
  const hasSession = keep.some(c => /session/i.test(c.name));
  if (!keep.length || !hasSession) { const m = fail(`cookies de session absents après visite (session probablement expirée). gardés=${keep.length}`); await notify(m); process.exit(1); }
  console.log(`cookies frais : ${keep.length} (dont session)`);

  const res = await fetch(APP_URL.replace(/\/$/, '') + '/api/settings/epidemic-token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-refresh-secret': EPIDEMIC_REFRESH_SECRET },
    body: JSON.stringify({ cookies: keep })
  });
  const body = await res.text();
  if (!res.ok) { const m = fail(`l'app a refusé les cookies : HTTP ${res.status} ${body.slice(0, 200)}`); await notify(m); process.exit(1); }
  console.log('✅ session Epidemic renouvelée dans l\'app : ' + body.slice(0, 200));
}

main().catch(async e => { const m = fail('erreur inattendue : ' + (e?.message || e)); await notify(m); process.exit(1); });
