import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { callTool } from '../src/services/epidemicMcp.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const id = '9ccba233-c29a-3980-a75c-bf4d73604a75'; // "Affectionate Love", ~146s
console.log('=== DownloadRecording MP3 FULL ===');
const dl = await callTool('DownloadRecording', { id, options: { fileType: 'MP3', stemType: 'FULL' } });
console.log('reponse:', JSON.stringify(dl).slice(0, 200));

const url = dl?.data?.recordingDownload?.assetUrl || dl?.recordingDownload?.assetUrl || dl?.assetUrl;
console.log('assetUrl host:', url ? new URL(url).host : '(introuvable)');
if (!url) { console.log('STRUCTURE:', JSON.stringify(dl, null, 2).slice(0, 1000)); process.exit(0); }

const out = new URL('../.tmp-download-test.mp3', import.meta.url);
const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync(out, buf);
console.log('telecharge:', (buf.length / 1024).toFixed(0), 'KB');
try {
  const dur = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${out.pathname.slice(1)}"`).toString().trim();
  console.log('duree reelle (ffprobe):', dur, 's  (attendu ~146s pour le morceau complet)');
} catch (e) { console.log('ffprobe:', e.message); }
