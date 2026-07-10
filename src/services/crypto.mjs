// Chiffrement des credentials stockés par chaîne (AES-256-GCM). Clé : APP_ENCRYPTION_KEY.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

function key() {
  const raw = process.env.APP_ENCRYPTION_KEY || '';
  if (!raw) throw new Error('APP_ENCRYPTION_KEY manquant');
  return (raw.length === 64 && /^[0-9a-f]+$/i.test(raw)) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest();
}

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(blob) {
  if (!blob) return null;
  const s = String(blob);
  if (!s.startsWith('v1:')) return s; // valeur en clair (compat) -> renvoyée telle quelle
  const buf = Buffer.from(s.slice(3), 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// Masque pour l'affichage (ne jamais renvoyer un secret complet au navigateur).
export function mask(v) {
  if (!v) return null;
  const s = String(v);
  return s.length <= 8 ? '••••' : s.slice(0, 4) + '…' + s.slice(-4);
}
