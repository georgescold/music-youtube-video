// Flux OAuth local, one-shot : echange le consentement Google contre un refresh_token YouTube,
// puis l'ecrit directement dans .env (YOUTUBE_REFRESH_TOKEN). A relancer si jamais revoque.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');

function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const PORT = 8080;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly' // stats de reach (CTR, rétention) pour le CRON intelligent
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET manquants dans .env');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
  access_type: 'offline',
  prompt: 'consent'
});

console.log('AUTH_URL_START');
console.log(authUrl);
console.log('AUTH_URL_END');
console.log('En attente du retour Google sur ' + REDIRECT_URI + ' ...');

function saveRefreshToken(token) {
  let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  if (/^YOUTUBE_REFRESH_TOKEN=.*$/m.test(env)) {
    env = env.replace(/^YOUTUBE_REFRESH_TOKEN=.*$/m, `YOUTUBE_REFRESH_TOKEN=${token}`);
  } else {
    env += `\nYOUTUBE_REFRESH_TOKEN=${token}\n`;
  }
  writeFileSync(ENV_PATH, env);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }

  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h1>Autorisation refusee</h1><p>${error}</p>`);
    console.error('RESULT: refuse -', error);
    server.close(() => process.exit(1));
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400); res.end('code manquant'); return; }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      })
    });
    const data = await tokenRes.json();

    if (!tokenRes.ok || !data.refresh_token) {
      console.error('RESULT: echec -', JSON.stringify(data));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>Erreur</h1><pre>${JSON.stringify(data, null, 2)}</pre>`);
      server.close(() => process.exit(1));
      return;
    }

    saveRefreshToken(data.refresh_token);
    console.log('RESULT: succes');
    console.log('scopes accordes :', data.scope);

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Connecte !</h1><p>Tu peux fermer cet onglet et revenir a Claude Code.</p>');
    server.close(() => process.exit(0));
  } catch (e) {
    console.error('RESULT: erreur -', e.message);
    res.writeHead(500); res.end('Erreur serveur');
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, '127.0.0.1');
