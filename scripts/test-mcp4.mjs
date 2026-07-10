import { readFileSync } from 'node:fs';
import { listTools, callTool } from '../src/services/epidemicMcp.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const tools = await listTools();
for (const name of ['DownloadRecording', 'SearchSimilarToRecording']) {
  const t = tools.tools.find(x => x.name === name);
  console.log('\n==== ' + name + ' inputSchema ====');
  console.log(JSON.stringify(t?.inputSchema, null, 2).slice(0, 1200));
}

console.log('\n==== SearchRecordings (forme correcte) ====');
const search = await callTool('SearchRecordings', {
  query: { term: 'romantic love' },
  filter: { vocals: false, duration: { min: 120000, max: 360000 } },
  sort: { by: 'RELEVANCE', order: 'DESCENDING' },
  first: 3
});
console.log(JSON.stringify(search, null, 2).slice(0, 3000));
