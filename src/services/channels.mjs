// Gestion des chaînes (multi-tenant). Credentials sensibles chiffrés au repos (crypto.mjs).
import { dbSelect, dbInsert, dbPatch, dbDelete } from './supabase.mjs';
import { encrypt, decrypt, mask } from './crypto.mjs';

const SENSITIVE = ['yt_client_secret', 'yt_refresh_token', 'epidemic_jwt', 'claude_token'];

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
  const [ch] = await dbInsert('channels', [{ name: name || 'Nouvelle chaîne', is_active: true }]);
  return ch;
}
export async function setActiveChannel(id) {
  await dbPatch('channels', 'is_active=eq.true', { is_active: false }).catch(() => {});
  const [ch] = await dbPatch('channels', `id=eq.${id}`, { is_active: true });
  return ch;
}
export async function updateChannel(id, patch) {
  const p = {};
  const plain = ['name', 'yt_client_id', 'yt_channel_id', 'daily_publish_time', 'target_duration_sec', 'utm_base', 'ad_frequency_min', 'ad_duration_sec', 'ad_intro', 'ad_outro', 'discord_webhook', 'publish_mode', 'background_mode', 'slideshow_count', 'reuse_gap'];
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
    claudeToken: decrypt(ch.claude_token)
  };
}

// Vue "sûre" pour le navigateur : jamais de secret complet, seulement un masque + booléens configurés.
export function channelPublicView(ch) {
  if (!ch) return null;
  return {
    id: ch.id, name: ch.name, is_active: ch.is_active,
    publish_mode: ch.publish_mode || 'review',
    discord: { configured: !!ch.discord_webhook, mask: mask(ch.discord_webhook) },
    youtube: { configured: !!ch.yt_refresh_token, clientId: ch.yt_client_id || null, clientIdMask: mask(ch.yt_client_id), channelId: ch.yt_channel_id || null, hasSecret: !!ch.yt_client_secret, hasRefresh: !!ch.yt_refresh_token },
    epidemic: { configured: !!ch.epidemic_jwt, mask: mask(decrypt(ch.epidemic_jwt)) },
    claude: { configured: !!ch.claude_token, mask: mask(decrypt(ch.claude_token)) },
    settings: { daily_publish_time: ch.daily_publish_time, target_duration_sec: ch.target_duration_sec, utm_base: ch.utm_base, ad_frequency_min: ch.ad_frequency_min, ad_duration_sec: ch.ad_duration_sec, ad_placement: ch.ad_placement || { x: 0.68, y: 0.55, w: 0.28, h: 0.40 }, ad_intro: ch.ad_intro !== false, ad_outro: ch.ad_outro !== false, background_mode: ch.background_mode || 'slideshow', slideshow_count: ch.slideshow_count ?? 0, reuse_gap: ch.reuse_gap ?? 30 }
  };
}
