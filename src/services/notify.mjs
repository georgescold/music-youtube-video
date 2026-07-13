// Notifications Discord par webhook (une par chaîne). Envoi best-effort (n'échoue jamais le pipeline).
import { dbInsert } from './supabase.mjs';
export const COLORS = { ok: 0x3f7a55, error: 0xb3413a, info: 0x181715, warn: 0xb0862e };

// Enregistre la notif dans l'app (cloche 🔔), TOUJOURS (indépendamment de Discord). Best-effort.
function recordInApp(channel, type, embed) {
  if (!channel || !channel.id) return;
  dbInsert('notifications', [{ channel_id: channel.id, type, title: embed.title || null, body: embed.description || null, url: embed.url || null }]).catch(() => {});
}

// Types de notifications + libellé (pour l'UI) + valeur par défaut (activé sauf mention).
export const NOTIF_TYPES = {
  video_published: { label: 'Vidéo publiée (titre + lien + miniature)', def: true, group: 'Production' },
  video_review: { label: 'Vidéo à valider (lien de relecture)', def: true, group: 'Production' },
  gen_failed: { label: 'Échec de génération (raison)', def: true, group: 'Production' },
  gen_started: { label: 'Génération démarrée', def: false, group: 'Production' },
  epidemic_auth: { label: 'Epidemic déconnecté / reconnecté', def: true, group: 'Santé' },
  youtube_auth: { label: 'YouTube déconnecté (jeton expiré)', def: true, group: 'Santé' },
  youtube_unverified: { label: 'Chaîne YouTube non vérifiée (vérif. téléphone)', def: true, group: 'Santé' },
  quota: { label: 'Quota d\'upload YouTube atteint', def: true, group: 'Santé' },
  backgrounds_low: { label: 'Images de fond bientôt épuisées', def: true, group: 'Santé' },
  daily_report: { label: 'Rapport quotidien (vues, top, rétention)', def: true, group: 'Performance' },
  viral: { label: 'Vidéo qui perce 🚀', def: true, group: 'Performance' },
  milestones: { label: 'Paliers de vues (100 / 1k / 10k)', def: true, group: 'Performance' },
  coach_report: { label: 'Rapport du coach', def: true, group: 'Performance' },
  weekly_recap: { label: 'Récap hebdomadaire', def: false, group: 'Performance' }
};

// Une notif est active si la préférence de la chaîne l'autorise (sinon valeur par défaut du type).
export function notifEnabled(channel, type) {
  const prefs = (channel && channel.discord_notifs) || {};
  if (type in prefs) return prefs[type] !== false;
  return NOTIF_TYPES[type] ? NOTIF_TYPES[type].def !== false : true;
}
// Émet une notification : TOUJOURS dans l'app (cloche), et sur Discord si la préférence l'autorise.
// Le nom de la chaîne est TOUJOURS rappelé sur Discord (un webhook peut mélanger plusieurs chaînes dans
// le même salon/canal, contrairement à la cloche in-app qui est déjà filtrée sur la chaîne active).
export function notifyChannel(channel, type, embed) {
  recordInApp(channel, type, embed); // in-app : voit tout, même sans webhook
  if (!channel || !channel.discord_webhook || !notifEnabled(channel, type)) return Promise.resolve(false);
  return sendDiscord(channel.discord_webhook, { ...embed, footer: { text: '📺 ' + (channel.name || 'Chaîne') } }).catch(() => false);
}

export async function sendDiscord(webhook, { title, description, color = COLORS.info, url, image, thumbnail, footer } = {}) {
  if (!webhook) return false;
  const embed = { color };
  if (title) embed.title = String(title).slice(0, 256);
  if (description) embed.description = String(description).slice(0, 4000);
  if (url) embed.url = url;
  if (image) embed.image = { url: image };
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (footer) embed.footer = { text: String(footer.text || footer).slice(0, 256) };
  try {
    const r = await fetch(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
    });
    return r.ok || r.status === 204;
  } catch { return false; }
}

export function isDiscordWebhook(url) {
  return /^https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\//i.test(String(url || ''));
}
