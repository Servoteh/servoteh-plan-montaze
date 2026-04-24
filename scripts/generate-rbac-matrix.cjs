#!/usr/bin/env node
/**
 * RBAC Matrix Generator (Faza 2, 2026-04-23)
 *
 * Parsuje sve CREATE POLICY i SECURITY DEFINER FUNCTION naredbe iz:
 *   - sql/schema.sql
 *   - sql/migrations/*.sql
 *
 * I emituje docs/RBAC_MATRIX.md koji se može review-ovati od strane non-tech
 * stakeholdera, a CI nas hvata ako neko zaboravi da regeneriše posle nove
 * migracije (vidi --check mod).
 *
 * Pokretanje:
 *   node scripts/generate-rbac-matrix.cjs            # generiše/prepiše docs/RBAC_MATRIX.md
 *   node scripts/generate-rbac-matrix.cjs --check    # exit 1 ako MD ne odgovara trenutnom stanju
 *
 * Granice (poznato):
 *   * Parser je regex-based, ne pravi pravi SQL parser. Hvata 95% pattern-a
 *     koji su u upotrebi (CREATE POLICY ... ON ... FOR ... TO ... USING (...)
 *     [WITH CHECK (...)]). Edge case-i (multi-line subselect-i sa zagradama)
 *     mogu da promaknu — onda dodaj ručno u "manual" sekciju MD-a.
 *   * NE čita pg_policies sa žive baze (CI ne sme da ima Supabase kredencijale).
 *     Posle DROP POLICY u nekoj migraciji, generator i dalje vidi prvobitnu
 *     CREATE — to je dizajn-tradeoff: tabelu finalnog efekta dobijaš samo
 *     iz `psql -c "\\dp"` na živoj bazi.
 *
 * Exit codes:
 *   0 — OK (write mode: napisao MD; check mode: MD je sinhron)
 *   1 — check mode: MD nije sinhron sa kodom (CI fail)
 *   2 — interna greška (fajl nedostaje, parser regression)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* RBAC_ROOT env var je test helper — Vitest setup koristi privremeni ROOT
   da izoluje fixture od pravog repo-a. U produkciji se NE postavlja. */
const ROOT = process.env.RBAC_ROOT
  ? path.resolve(process.env.RBAC_ROOT)
  : path.resolve(__dirname, '..');
const SCHEMA_FILE = path.join(ROOT, 'sql', 'schema.sql');
const MIGR_DIR = path.join(ROOT, 'sql', 'migrations');
const OUTPUT = path.join(ROOT, 'docs', 'RBAC_MATRIX.md');

const CHECK_MODE = process.argv.includes('--check');

/* ── Regex pattern-i ─────────────────────────────────────────────────────── */

/* CREATE POLICY "name" ON [schema.]table [AS PERMISSIVE/RESTRICTIVE]
 *   FOR <ALL|SELECT|INSERT|UPDATE|DELETE>
 *   TO <role[, role...]>
 *   USING (...)
 *   [WITH CHECK (...)]
 * Zatvarajuća tačka-zarez. Dozvoljava multi-line.
 */
const POLICY_RE =
  /CREATE\s+POLICY\s+"?([\w-]+)"?\s+ON\s+(?:public\.)?(\w+)(?:\s+AS\s+(PERMISSIVE|RESTRICTIVE))?\s+FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\s+TO\s+([\w,\s]+?)(?:\s+USING\s*\(([\s\S]*?)\))?(?:\s+WITH\s+CHECK\s*\(([\s\S]*?)\))?\s*;/gi;

/* CREATE [OR REPLACE] FUNCTION [public.]name(args) ... SECURITY DEFINER */
const SECDEF_RE =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\([^)]*\)[\s\S]*?SECURITY\s+DEFINER/gi;

/* GRANT <privs> ON [schema.]table_or_func TO <role[, role...]> */
const GRANT_RE =
  /GRANT\s+([\w,\s]+?)\s+ON\s+(?:FUNCTION\s+)?(?:public\.)?(\w+)(?:\s*\([^)]*\))?\s+TO\s+([\w,\s]+?)\s*;/gi;

/* REVOKE <privs> ON ... FROM <role> */
const REVOKE_RE =
  /REVOKE\s+([\w,\s]+?)\s+ON\s+(?:FUNCTION\s+)?(?:public\.)?(\w+)(?:\s*\([^)]*\))?\s+FROM\s+([\w,\s]+?)\s*;/gi;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])--[^\n]*$/gm, '$1');
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGR_DIR)) return [];
  return fs
    .readdirSync(MIGR_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIGR_DIR, f));
}

function readSqlFile(p) {
  return { file: path.relative(ROOT, p).replace(/\\/g, '/'), sql: stripSqlComments(fs.readFileSync(p, 'utf8')) };
}

/** Skratiti predugačke USING klauzule za prikaz u tabeli. */
function snippet(s, max = 80) {
  if (!s) return '';
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

function escMd(s) {
  return String(s).replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

/* ── Parsing ─────────────────────────────────────────────────────────────── */

function parseFile({ file, sql }) {
  const out = { file, policies: [], secDefs: [], grants: [], revokes: [] };

  for (const m of sql.matchAll(POLICY_RE)) {
    out.policies.push({
      name: m[1],
      table: m[2],
      kind: (m[3] || 'PERMISSIVE').toUpperCase(),
      action: m[4].toUpperCase(),
      roles: m[5].split(',').map((s) => s.trim()).filter(Boolean),
      using: m[6] ? m[6].trim() : '',
      withCheck: m[7] ? m[7].trim() : '',
    });
  }
  for (const m of sql.matchAll(SECDEF_RE)) {
    out.secDefs.push({ name: m[1] });
  }
  for (const m of sql.matchAll(GRANT_RE)) {
    out.grants.push({
      privs: m[1].split(',').map((s) => s.trim().toUpperCase()),
      object: m[2],
      roles: m[3].split(',').map((s) => s.trim()),
    });
  }
  for (const m of sql.matchAll(REVOKE_RE)) {
    out.revokes.push({
      privs: m[1].split(',').map((s) => s.trim().toUpperCase()),
      object: m[2],
      roles: m[3].split(',').map((s) => s.trim()),
    });
  }
  return out;
}

function collectAll() {
  const files = [SCHEMA_FILE, ...listMigrationFiles()];
  return files.filter(fs.existsSync).map((p) => parseFile(readSqlFile(p)));
}

/* ── Aggregation ─────────────────────────────────────────────────────────── */

/**
 * Računaj "efektivnu" sliku — koristimo isti princip kao Postgres:
 * politika sa istim imenom + tabelom u kasnijem fajlu zamenjuje raniju.
 * (Ovo je dovoljno blizu real ponašanja jer migracije imaju
 * DROP POLICY IF EXISTS pre svakog CREATE-a.)
 */
function effectivePolicies(parsed) {
  const map = new Map(); // key = `${table}::${name}` -> {policy, file}
  for (const f of parsed) {
    for (const pol of f.policies) {
      map.set(`${pol.table}::${pol.name}`, { policy: pol, file: f.file });
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.policy.table !== b.policy.table) return a.policy.table.localeCompare(b.policy.table);
    if (a.policy.action !== b.policy.action) return a.policy.action.localeCompare(b.policy.action);
    return a.policy.name.localeCompare(b.policy.name);
  });
}

function effectiveGrantsRevokes(parsed) {
  /* Svaki GRANT/REVOKE primenjuje se redom; vraćamo finalnu mapu
     `${object}::${role}` -> Set<priv>. */
  const map = new Map();
  for (const f of parsed) {
    for (const g of f.grants) {
      for (const role of g.roles) {
        const key = `${g.object}::${role}`;
        const cur = map.get(key) || new Set();
        for (const p of g.privs) cur.add(p);
        map.set(key, cur);
      }
    }
    for (const r of f.revokes) {
      for (const role of r.roles) {
        const key = `${r.object}::${role}`;
        const cur = map.get(key);
        if (!cur) continue;
        for (const p of r.privs) cur.delete(p);
        if (cur.size === 0) map.delete(key);
      }
    }
  }
  return map;
}

function flagPolicy(pol) {
  /* Vraća listu warning flag-ova za politiku. */
  const flags = [];
  const using = pol.using.toLowerCase();
  if (/^\s*true\s*$/.test(using) && pol.action !== 'INSERT') {
    flags.push('USING(true)');
  }
  if (pol.roles.includes('anon')) {
    flags.push('TO anon');
  }
  if (!pol.using && pol.action !== 'INSERT') {
    flags.push('no-USING');
  }
  return flags;
}

/* ── Markdown render ─────────────────────────────────────────────────────── */

function render(parsed) {
  const eff = effectivePolicies(parsed);
  const grants = effectiveGrantsRevokes(parsed);

  /* Grupiši politike po tabeli. */
  const byTable = new Map();
  for (const { policy, file } of eff) {
    if (!byTable.has(policy.table)) byTable.set(policy.table, []);
    byTable.get(policy.table).push({ policy, file });
  }

  const allSecDefs = new Map();
  for (const f of parsed) {
    for (const sd of f.secDefs) allSecDefs.set(sd.name, f.file);
  }

  /* Anon grant lista (filtrira zanimljiv sadržaj — funkcije i view-i). */
  const anonAccess = [];
  for (const [key, privs] of grants.entries()) {
    const [obj, role] = key.split('::');
    if (role === 'anon' && privs.size > 0) {
      anonAccess.push({ object: obj, privs: [...privs].sort() });
    }
  }
  anonAccess.sort((a, b) => a.object.localeCompare(b.object));

  const lines = [];

  lines.push('# RBAC Matrix — auto-generisano');
  lines.push('');
  lines.push('> **Generisano:** `node scripts/generate-rbac-matrix.cjs`');
  lines.push('> **NE EDITUJ RUČNO** — promene će biti pregažene. Edituj migracije pa regeneriši.');
  lines.push('> CI proverava sinhronizaciju: `node scripts/generate-rbac-matrix.cjs --check`.');
  lines.push('');
  lines.push('## 1. Sažetak');
  lines.push('');
  lines.push(`- **Tabela sa RLS politikama:** ${byTable.size}`);
  lines.push(`- **Ukupno efektivnih politika:** ${eff.length}`);
  lines.push(`- **SECURITY DEFINER funkcija:** ${allSecDefs.size}`);
  lines.push(`- **Objekata sa anon grant-om:** ${anonAccess.length}`);
  lines.push('');

  lines.push('## 2. Anon (javni) pristup');
  lines.push('');
  lines.push('Svaki red u ovoj tabeli je *javno čitljiv* preko anon API ključa (koji ide u JS bundle).');
  lines.push('Bilo šta osetljivo ovde znači security incident.');
  lines.push('');
  if (anonAccess.length === 0) {
    lines.push('_Nema objekata grant-ovanih anon roli — ✅ dobro stanje._');
  } else {
    lines.push('| Objekat | Privilegije |');
    lines.push('|---|---|');
    for (const a of anonAccess) {
      lines.push(`| \`${escMd(a.object)}\` | ${a.privs.map((p) => `\`${p}\``).join(', ')} |`);
    }
  }
  lines.push('');

  lines.push('## 3. SECURITY DEFINER funkcije');
  lines.push('');
  lines.push('Funkcije koje izvršavaju sa privilegijama vlasnika (bypass RLS-a). Svaka je potencijalna');
  lines.push('eskalacija ako search_path nije postavljen ili ako logika ne proverava ulogu.');
  lines.push('');
  lines.push('| Funkcija | Definisana u |');
  lines.push('|---|---|');
  for (const [name, file] of [...allSecDefs.entries()].sort()) {
    lines.push(`| \`${escMd(name)}\` | \`${escMd(file)}\` |`);
  }
  lines.push('');

  lines.push('## 4. RLS politike po tabeli');
  lines.push('');
  lines.push('Legenda flag-ova:');
  lines.push('- `USING(true)` — politika ne filtrira ništa (svi authenticated vide / pišu sve).');
  lines.push('- `TO anon` — politika se primenjuje na anon rolu.');
  lines.push('- `no-USING` — politika nema USING klauzulu (samo INSERT smene smiju biti bez USING-a).');
  lines.push('');

  for (const [table, items] of [...byTable.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### \`${table}\``);
    lines.push('');
    lines.push('| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const { policy, file } of items) {
      const flags = flagPolicy(policy);
      const flagStr = flags.length === 0 ? '✅' : flags.map((f) => `⚠ ${f}`).join('<br>');
      lines.push(
        `| \`${escMd(policy.name)}\` | ${policy.action} | ${policy.roles.map((r) => `\`${r}\``).join(', ')} | \`${escMd(snippet(policy.using, 60))}\` | \`${escMd(snippet(policy.withCheck, 60))}\` | ${flagStr} | \`${escMd(file)}\` |`
      );
    }
    lines.push('');
  }

  lines.push('## 5. Statistika rizika');
  lines.push('');
  let usingTrueCount = 0;
  let anonPolicyCount = 0;
  for (const { policy } of eff) {
    if (/^\s*true\s*$/.test(policy.using.toLowerCase()) && policy.action !== 'INSERT') usingTrueCount++;
    if (policy.roles.includes('anon')) anonPolicyCount++;
  }
  lines.push(`- Politike sa \`USING(true)\` (osim INSERT): **${usingTrueCount}**`);
  lines.push(`- Politike sa \`TO anon\`: **${anonPolicyCount}**`);
  lines.push(`- Anon objekt grant-ovi (sa SELECT/INSERT/UPDATE/DELETE): **${anonAccess.length}**`);
  lines.push('');

  lines.push('## 6. Verifikacija sa žive baze');
  lines.push('');
  lines.push('Ova matrica je izvedena iz SQL koda. Za pravu sliku sa Supabase produkcije:');
  lines.push('');
  lines.push('```sql');
  lines.push('-- Sve aktivne politike:');
  lines.push('SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check');
  lines.push('FROM   pg_policies');
  lines.push('WHERE  schemaname = \'public\'');
  lines.push('ORDER  BY tablename, policyname;');
  lines.push('');
  lines.push('-- Sve grant-ove na osetljivim objektima:');
  lines.push('SELECT grantee, table_name, privilege_type');
  lines.push('FROM   information_schema.role_table_grants');
  lines.push('WHERE  table_schema = \'public\' AND grantee IN (\'anon\',\'authenticated\')');
  lines.push('ORDER  BY table_name, grantee, privilege_type;');
  lines.push('```');
  lines.push('');
  return lines.join('\n') + '\n';
}

/* ── Main ────────────────────────────────────────────────────────────────── */

function main() {
  let parsed;
  try {
    parsed = collectAll();
  } catch (e) {
    console.error('[rbac-matrix] Parser greška:', e.message);
    process.exit(2);
  }

  const md = render(parsed);

  if (CHECK_MODE) {
    if (!fs.existsSync(OUTPUT)) {
      console.error(`[rbac-matrix] CHECK FAIL — ${path.relative(ROOT, OUTPUT)} ne postoji.`);
      console.error('Pokreni: node scripts/generate-rbac-matrix.cjs');
      process.exit(1);
    }
    const existing = fs.readFileSync(OUTPUT, 'utf8');
    const a = crypto.createHash('sha256').update(existing).digest('hex');
    const b = crypto.createHash('sha256').update(md).digest('hex');
    if (a === b) {
      console.log(`[rbac-matrix] CHECK OK — ${path.relative(ROOT, OUTPUT)} sinhron sa kodom.`);
      process.exit(0);
    }
    console.error(`[rbac-matrix] CHECK FAIL — ${path.relative(ROOT, OUTPUT)} nije sinhron.`);
    console.error('Neko je dodao/promenio CREATE POLICY ili GRANT bez regenerisanja matrice.');
    console.error('Pokreni lokalno: node scripts/generate-rbac-matrix.cjs');
    console.error('Pa commit-uj rezultat.');
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT, md, 'utf8');
  console.log(`[rbac-matrix] Napisano ${path.relative(ROOT, OUTPUT)} (${md.length} bajtova).`);
  process.exit(0);
}

main();
