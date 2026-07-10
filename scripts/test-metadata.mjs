import { readFileSync } from 'node:fs';
import { generateMetadata } from '../src/steps/metadata.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
for (const k of Object.keys(env)) process.env[k] = env[k];

const tracklist = [
  { stamp: '00:00', title: 'Wedding Plans', artist: 'Von Meyer' },
  { stamp: '03:18', title: 'Marie', artist: 'Howard Harper-Barnes' },
  { stamp: '05:29', title: 'Romantic Folksong', artist: '' }
];

const meta = await generateMetadata({
  tracklist, mood: 'romantique, doux, piano',
  utmUrl: 'https://compaatible.app/?utm_source=youtube&utm_campaign=aubonmoment',
  log: m => console.log('  ' + m)
});

console.log('\n=== TITRE ===\n' + meta.title);
console.log('\n=== TAGS ===\n' + JSON.stringify(meta.tags));
console.log('\n=== DESCRIPTION ===\n' + meta.description);
