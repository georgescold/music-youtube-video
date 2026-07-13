// Gestion des chaînes (multi-tenant). Credentials sensibles chiffrés au repos (crypto.mjs).
import { dbSelect, dbInsert, dbPatch, dbDelete } from './supabase.mjs';
import { encrypt, decrypt, mask } from './crypto.mjs';

const SENSITIVE = ['yt_client_secret', 'yt_refresh_token', 'epidemic_jwt', 'claude_token'];
// Identifiants PARTAGÉS (accès de COMPTE, mêmes pour toutes les chaînes) : Epidemic + Claude.
// Le client OAuth Google (id/secret), le refresh token et l'ID de chaîne sont PROPRES À CHAQUE CHAÎNE
// (une chaîne peut être sur un autre projet Google / un autre utilisateur / avoir son propre quota).
export const SHARED_ACCOUNT = ['epidemic_jwt', 'epidemic_cookies', 'claude_token'];
// Copiés d'une chaîne existante à la CRÉATION (défaut pratique), mais modifiables ensuite par chaîne — pas propagés.
const INHERIT_ON_CREATE = [...SHARED_ACCOUNT, 'yt_client_id', 'yt_client_secret'];

export async function listChannels() {
  return dbSelect('channels', '?order=created_at.asc');
}
export async function getChannel(id) {
  return (await dbSelect('channels', `?id=eq.${id}`))[0] || null;
}
export async function getActiveChannel() {
  const all = await listChannels();
  return all.find(c => c.is_active) || all[0] || null;
}
export async function createChannel(name) {
  await dbPatch('channels', 'is_active=eq.true', { is_active: false }).catch(() => {});
  // Hérite (à la création) des accès partagés + du client OAuth par DÉFAUT (blobs chiffrés copiés tels quels).
  // Le client OAuth devient alors PROPRE à la nouvelle chaîne (modifiable, non lié aux autres).
  const existing = (await listChannels())[0];
  const inherit = {};
  if (existing) for (const k of INHERIT_ON_CREATE) if (existing[k] != null) inherit[k] = existing[k];
  const [ch] = await dbInsert('channels', [{ name: name || 'Nouvelle chaîne', is_active: true, ...inherit }]);
  return ch;
}

// Propage les identifiants partagés (patch en clair) vers TOUTES les chaînes (chiffrés au passage).
export async function propagateSharedCreds(patch) {
  const shared = {};
  for (const k of SHARED_ACCOUNT) if (k in patch) shared[k] = patch[k];
  if (!Object.keys(shared).length) return;
  const all = await listChannels();
  for (const c of all) await updateChannel(c.id, shared).catch(() => {});
}
export async function setActiveChannel(id) {
  await dbPatch('channels', 'is_active=eq.true', { is_active: false }).catch(() => {});
  const [ch] = await dbPatch('channels', `id=eq.${id}`, { is_active: true });
  return ch;
}
export async function updateChannel(id, patch) {
  const p = {};
  const plain = ['name', 'yt_client_id', 'yt_channel_id', 'yt_handle', 'daily_publish_time', 'target_duration_sec', 'target_min_sec', 'target_max_sec', 'publish_time_start', 'publish_time_end', 'publish_times', 'utm_base', 'ads_enabled', 'ad_frequency_min', 'ad_duration_sec', 'ad_intro', 'ad_outro', 'discord_webhook', 'publish_mode', 'cron_enabled', 'coach_enabled', 'max_posts_per_day', 'coach_state', 'coach_updated_at', 'thumbnail_enabled', 'thumbnail_text', 'thumbnail_font', 'video_text', 'background_mode', 'slideshow_count', 'reuse_gap', 'discord_notifs', 'daily_report_hour', 'stats_daily', 'claude_model',
    'objective', 'product_desc', 'product_url', 'affiliate_url', 'affiliate_label', 'inspiration_urls', 'playbook', 'playbook_updated_at',
    'emotion_palette', 'emotion_cursor', 'emotion_palette_updated_at', 'emotion_from_image', 'seo_plan', 'seo_plan_updated_at'];
  for (const k of plain) if (k in patch) p[k] = patch[k];
  if (patch.ad_placement && typeof patch.ad_placement === 'object') {
    const q = patch.ad_placement, clamp = (v, d) => Math.min(1, Math.max(0, Number(v) ?? d));
    p.ad_placement = { x: clamp(q.x, 0.68), y: clamp(q.y, 0.55), w: clamp(q.w, 0.28), h: clamp(q.h, 0.40) };
  }
  for (const k of SENSITIVE) if (k in patch) p[k] = patch[k] ? encrypt(patch[k]) : null; // '' -> null (efface)
  const [ch] = await dbPatch('channels', `id=eq.${id}`, p);
  return ch;
}

// Credentials déchiffrés, prêts pour les services (youtube/epidemic/claude).
export function channelCreds(ch) {
  if (!ch) return {};
  return {
    youtube: { clientId: ch.yt_client_id, clientSecret: decrypt(ch.yt_client_secret), refreshToken: decrypt(ch.yt_refresh_token), channelId: ch.yt_channel_id },
    epidemicJwt: decrypt(ch.epidemic_jwt),
    epidemicCookies: decrypt(ch.epidemic_cookies), // auth de session MCP (priment sur le JWT)
    claudeToken: decrypt(ch.claude_token)
  };
}

// Vue "sûre" pour le navigateur : jamais de secret complet, seulement un masque + booléens configurés.
export function channelPublicView(ch) {
  if (!ch) return null;
  return {
    id: ch.id, name: ch.name, is_active: ch.is_active,
    publish_mode: ch.publish_mode || 'review',
    cron_enabled: !!ch.cron_enabled,
    coach_enabled: !!ch.coach_enabled,
    stats_daily: ch.stats_daily === true,
    stats_updated_at: ch.stats_updated_at || null,
    claude_model: ch.claude_model || 'sonnet',
    discord_notifs: (ch.discord_notifs && typeof ch.discord_notifs === 'object') ? ch.discord_notifs : {},
    daily_report_hour: ch.daily_report_hour ?? 8,
    max_posts_per_day: ch.max_posts_per_day || 1,
    coach_state: ch.coach_state || null,
    coach_updated_at: ch.coach_updated_at || null,
    thumbnail_enabled: ch.thumbnail_enabled !== false,
    thumbnail_text: ch.thumbnail_text !== false,
    video_text: ch.video_text === true,
    thumbnail_font: ch.thumbnail_font || 'playfair',
    strategy: {
      objective: ch.objective || '', product_desc: ch.product_desc || '', product_url: ch.product_url || '',
      affiliate_url: ch.affiliate_url || '', affiliate_label: ch.affiliate_label || '',
      inspiration_urls: Array.isArray(ch.inspiration_urls) ? ch.inspiration_urls : [],
      playbook: ch.playbook || null, playbook_updated_at: ch.playbook_updated_at || null
    },
    emotions: {
      palette: Array.isArray(ch.emotion_palette) ? ch.emotion_palette : [],
      cursor: ch.emotion_cursor || 0,
      updated_at: ch.emotion_palette_updated_at || null,
      from_image: ch.emotion_from_image !== false
    },
    seo_plan: ch.seo_plan || null,
    seo_plan_updated_at: ch.seo_plan_updated_at || null,
    discord: { configured: !!ch.discord_webhook, mask: mask(ch.discord_webhook) },
    youtube: { configured: !!ch.yt_refresh_token, clientId: ch.yt_client_id || null, clientIdMask: mask(ch.yt_client_id), channelId: ch.yt_channel_id || null, hasSecret: !!ch.yt_client_secret, hasRefresh: !!ch.yt_refresh_token },
    epidemic: { configured: !!ch.epidemic_jwt, mask: mask(decrypt(ch.epidemic_jwt)) },
    claude: { configured: !!ch.claude_token, mask: mask(decrypt(ch.claude_token)) },
    settings: { daily_publish_time: ch.daily_publish_time, target_duration_sec: ch.target_duration_sec,
      target_min_sec: ch.target_min_sec ?? ch.target_duration_sec ?? 5400, target_max_sec: ch.target_max_sec ?? ch.target_duration_sec ?? 5400,
      publish_time_start: (ch.publish_time_start || (ch.daily_publish_time ? String(ch.daily_publish_time).slice(0, 5) : '18:00')), publish_time_end: (ch.publish_time_end || (ch.daily_publish_time ? String(ch.daily_publish_time).slice(0, 5) : '18:00')),
      publish_times: Array.isArray(ch.publish_times) ? ch.publish_times : [],
      utm_base: ch.utm_base, ads_enabled: ch.ads_enabled === true, ad_frequency_min: ch.ad_frequency_min, ad_duration_sec: ch.ad_duration_sec, ad_placement: ch.ad_placement || { x: 0.68, y: 0.55, w: 0.28, h: 0.40 }, ad_intro: ch.ad_intro !== false, ad_outro: ch.ad_outro !== false, background_mode: ch.background_mode || 'slideshow', slideshow_count: ch.slideshow_count ?? 0, reuse_gap: ch.reuse_gap ?? 30 }
  };
}
