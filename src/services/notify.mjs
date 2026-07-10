// Notifications Discord par webhook (une par chaîne). Envoi best-effort (n'échoue jamais le pipeline).
export const COLORS = { ok: 0x3f7a55, error: 0xb3413a, info: 0x181715, warn: 0xb0862e };

export async function sendDiscord(webhook, { title, description, color = COLORS.info, url } = {}) {
  if (!webhook) return false;
  const embed = { color };
  if (title) embed.title = String(title).slice(0, 256);
  if (description) embed.description = String(description).slice(0, 4000);
  if (url) embed.url = url;
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
