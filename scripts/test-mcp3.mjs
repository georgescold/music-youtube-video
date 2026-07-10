import { readFileSync } from 'node:fs';
import { listTools } from '../src/services/epidemicMcp.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const tools = await listTools();
const want = ['SearchRecordings', 'SearchExternalReferences', 'SearchSimilarToRecording', 'DownloadRecording'];
for (const name of want) {
  const t = (tools.tools || []).find(x => x.name === name);
  console.log('\n======== ' + name + ' ========');
  console.log(JSON.stringify(t?.inputSchema, null, 2));
}
