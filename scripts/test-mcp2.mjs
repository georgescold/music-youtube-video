import { readFileSync } from 'node:fs';
import { callTool } from '../src/services/epidemicMcp.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

console.log('=== SearchRecordings(query="romantic love", first=3) ===');
const search = await callTool('SearchRecordings', { query: 'romantic love', first: 3 });
console.log(JSON.stringify(search, null, 2).slice(0, 2500));

// Essayer d'extraire un id de morceau depuis la reponse
function findFirstId(obj) {
  const edges = obj?.edges || obj?.data?.edges || obj?.recordings?.edges;
  if (edges && edges[0]) return edges[0].node?.id || edges[0].id;
  return null;
}
const id = findFirstId(search);
console.log('\nPremier id extrait:', id);

if (id) {
  console.log('\n=== DownloadRecording(id, options MP3) ===');
  try {
    const dl = await callTool('DownloadRecording', { id, options: { fileType: 'MP3', stemType: 'FULL' } });
    console.log(JSON.stringify(dl, null, 2).slice(0, 800));
  } catch (e) { console.log('erreur options v1:', e.message); }
}
