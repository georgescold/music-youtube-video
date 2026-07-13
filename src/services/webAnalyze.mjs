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
