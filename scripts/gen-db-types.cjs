/**
 * Pokušava `npx supabase gen types typescript --local` i piše
 * `src/types/supabase-generated.d.ts`. Ako nema lokalne baze, izlaz 0 (bez prekida CI).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const outPath = path.join(__dirname, '..', 'src', 'types', 'supabase-generated.d.ts');

try {
  const buf = execFileSync(
    'npx',
    ['supabase', 'gen', 'types', 'typescript', '--local', '--schema', 'public'],
    { encoding: 'utf-8', maxBuffer: 30 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const header = `/* Auto-generated: npm run gen:db-types. Ne edituj ručno. */\n`;
  fs.writeFileSync(outPath, header + buf, 'utf8');
  console.log('[gen-db-types] wrote', outPath);
} catch (e) {
  console.log(
    '[gen-db-types] preskočeno (lokalni Supabase nije pokrenut ili nema npx supabase). Ručni tipovi: src/types/maintWorkOrders.js',
  );
  process.exit(0);
}
