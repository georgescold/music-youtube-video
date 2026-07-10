import { readFileSync } from 'node:fs';
import { runPipeline } from '../src/pipeline.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const start = Date.now();
const result = await runPipeline({ dryRun: false, log: m => console.log('  ' + m) });
console.log('\n=== RÉSULTAT ===', JSON.stringify(result), '| durée totale:', Math.round((Date.now() - start) / 1000), 's');
