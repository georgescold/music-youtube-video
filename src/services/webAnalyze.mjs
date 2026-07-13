// Récupère et « lit » le site web d'un produit côté serveur, pour ancrer le SEO sur le vrai produit.
// Pas de dépendance : fetch natif + extraction texte par regex (titre, meta description, corps nettoyé).

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
function metaContent(html, name) {
  const re = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*>', 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  // Capture selon le VRAI délimiteur (") ou ('), sinon une apostrophe française « L'app » couperait le contenu.
  const m = tag.match(/content=(?:"([^"]*)"|'([^']*)')/i);
  return ((m && (m[1] ?? m[2])) || '').trim();
}

function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).href; } catch { return ''; }
}

// Requête HTTP simple avec timeout ; renvoie le texte brut (ou null).
async function get(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PlaylistYoutubeSEO/1.0)', 'accept': 'text/html,application/xml,*/*' } });
    if (!r.ok) return null;
    return (await r.text());
  } catch { return null; } finally { clearTimeout(t); }
}

const BLOG_RE = /\/(blog|article|articles|post|posts|guide|guides|conseil|conseils|magazine|journal|actualites?|news)\//i;
function titleFromSlug(u) {
  try {
    const seg = new URL(u).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
    const t = decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  } catch { return ''; }
}
function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().replace(/\s*[|–—·»].*$/, '').trim(); // retire le suffixe de marque
}
function locs(xml) { return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].trim()); }

// Découvre les articles de blog du site (via sitemap, sinon la page /blog).
// Renvoie [{ url, title }] (titres réels quand récupérables, sinon dérivés du slug).
export async function fetchBlogArticles(siteUrl, { max = 40, maxTitles = 30, log = () => {} } = {}) {
  const base = normalizeUrl(siteUrl);
  if (!base) return { ok: false, error: 'URL invalide', articles: [] };
  const origin = new URL(base).origin;

  // 1) Sitemaps candidats : robots.txt + emplacements classiques.
  const sitemaps = new Set(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml'].map(p => origin + p));
  const robots = await get(origin + '/robots.txt').catch(() => null);
  if (robots) for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) { try { sitemaps.add(new URL(m[1].trim()).href); } catch {} }

  // 2) Collecte des URLs de pages (résout un éventuel index de sitemaps).
  const pageUrls = new Set();
  let checked = 0;
  for (const sm of sitemaps) {
    if (checked >= 8) break;
    const xml = await get(sm); if (!xml) continue; checked++;
    if (/<sitemapindex/i.test(xml)) {
      const subs = locs(xml);
      // Priorise les sous-sitemaps « blog/post/article ».
      subs.sort((a, b) => (BLOG_RE.test(b) ? 1 : 0) - (BLOG_RE.test(a) ? 1 : 0));
      for (const sub of subs.slice(0, 5)) { const x = await get(sub); if (x) locs(x).forEach(u => pageUrls.add(u)); if (checked++ >= 12) break; }
    } else {
      locs(xml).forEach(u => pageUrls.add(u));
    }
    if (pageUrls.size > 400) break;
  }

  // 3) Filtre « articles de blog ».
  let urls = [...pageUrls].filter(u => BLOG_RE.test(u));
  // 3bis) Fallback : pas de sitemap exploitable -> on lit la page /blog et on en extrait les liens.
  if (!urls.length) {
    for (const p of ['/blog', '/blog/', '/articles', '/journal', '/conseils']) {
      const html = await get(origin + p); if (!html) continue;
      for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
        let href = m[1]; try { href = new URL(href, origin + p).href; } catch { continue; }
        if (href.startsWith(origin) && BLOG_RE.test(href)) pageUrls.add(href);
      }
      urls = [...pageUrls].filter(u => BLOG_RE.test(u));
      if (urls.length) break;
    }
  }
  // Nettoie : retire les pages d'index (…/blog, …/blog/page/2), dédoublonne, plafonne.
  urls = [...new Set(urls)]
    .filter(u => { const path = new URL(u).pathname.replace(/\/+$/, ''); const segs = path.split('/').filter(Boolean); return segs.length >= 2 && !/\/(page|category|categorie|tag|author)\//i.test(u); })
    .slice(0, max);
  if (!urls.length) { log('aucun article de blog détecté'); return { ok: true, articles: [] }; }
  log(urls.length + ' article(s) de blog détecté(s)');

  // 4) Titres réels (limités) + dérivés du slug pour le reste.
  const withTitles = urls.slice(0, maxTitles);
  const titles = {};
  const batch = 6;
  for (let i = 0; i < withTitles.length; i += batch) {
    await Promise.all(withTitles.slice(i, i + batch).map(async u => {
      const html = await get(u, { timeoutMs: 8000 });
      if (html) {
        const og = metaContent(html, 'og:title');
        const tt = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        // Le slug est fiable et descriptif ; on ne préfère le <title> que s'il est nettement plus riche
        // (les SPA renvoient un <title> de marque générique identique partout — inutile pour le matching).
        const slug = titleFromSlug(u);
        const fetched = cleanTitle(og || tt);
        titles[u] = (fetched && fetched.length > slug.length + 4) ? fetched : slug;
      }
    }));
  }
  const articles = urls.map(u => ({ url: u, title: titles[u] || titleFromSlug(u) })).filter(a => a.title);
  return { ok: true, articles };
}

// Renvoie { ok, url, title, description, text } — text = extrait nettoyé (~6000 car. max).
export async function fetchSiteText(url, { maxChars = 6000, timeoutMs = 12000, log = () => {} } = {}) {
  const target = normalizeUrl(url);
  if (!target) return { ok: false, error: 'URL invalide' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    log('lecture du site produit : ' + target);
    const r = await fetch(target, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PlaylistYoutubeSEO/1.0)', 'accept': 'text/html,*/*' }
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, url: target };
    const html = (await r.text()).slice(0, 500000);
    const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const description = metaContent(html, 'description') || metaContent(html, 'og:description');
    const body = stripTags(html).slice(0, maxChars);
    return { ok: true, url: target, title, description, text: body };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'délai dépassé' : e.message, url: target };
  } finally {
    clearTimeout(t);
  }
}
