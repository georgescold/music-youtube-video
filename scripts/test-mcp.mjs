import { readFileSync } from 'node:fs';
import { listTools } from '../src/services/epidemicMcp.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

console.log('--- tools/list ---');
const tools = await listTools();
for (const t of tools.tools || []) {
  console.log('\n### ' + t.name);
  console.log((t.description || '').slice(0, 180));
  console.log('params:', JSON.stringify(t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : t.inputSchema));
}
