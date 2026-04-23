#!/usr/bin/env node
/**
 * Security baseline guard for sql/schema.sql.
 *
 * `schema.sql` se primenjuje na praznu bazu kao bootstrap. Migracije
 * (sql/migrations/*.sql) ga zatežu, ali ako neko greškom resetuje bazu i
 * pokrene SAMO `schema.sql`, sistem ne sme biti otvoren.
 *
 * Ova skripta proverava da `schema.sql` NIKAD ne sadrži poznate pilot
 * anti-patterne. Ako se neki vrati u kod, CI build pada sa exit 1 i
 * jasnom porukom šta je narušeno + kako se popravlja.
 *
 * Pokretanje:
 *   node scripts/check-schema-security-baseline.cjs
 *
 * Exit codes:
 *   0 — OK
 *   1 — narušen baseline (CI fail)
 *   2 — interna greška (fajl nedostaje)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'sql', 'schema.sql');

/** Lista zabranjenih pattern-a + objašnjenje + remediation. */
const RULES = [
  {
    /* Lovi SAMO pilot anti-pattern gde je telo funkcije bukvalno samo
       `BEGIN RETURN true; END` (bez ikakve provere uloge). Implementacija
       koja proverava user_roles ima IF/EXISTS pre eventualnog `RETURN true`. */
    id: 'has-edit-role-return-true',
    pattern:
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?has_edit_role[^;]*?AS\s*\$\$\s*BEGIN\s*RETURN\s+true\s*;\s*END\s*;\s*\$\$/i,
    severity: 'CRITICAL',
    message:
      'has_edit_role() ne sme bezuslovno vraćati TRUE. Pilot režim "svako autentifikovan piše" je uklonjen 2026-04-23.',
    fix: 'Vrati implementaciju iz add_menadzment_full_edit_kadrovska.sql (provera user_roles po globalnoj/per-project roli).',
  },
  {
    id: 'roles-select-using-true',
    pattern:
      /CREATE\s+POLICY\s+"?roles_select"?\s+ON\s+user_roles[\s\S]{0,200}?USING\s*\(\s*true\s*\)/i,
    severity: 'CRITICAL',
    message:
      'Politika "roles_select" sa USING(true) otvara ceo user_roles registar svakom autentifikovanom korisniku.',
    fix: 'Koristi user_roles_read_self + user_roles_read_admin_all pattern (vidi enable_user_roles_rls_proper.sql).',
  },
  {
    id: 'roles-manage-pilot',
    pattern: /CREATE\s+POLICY\s+"?roles_manage"?\s+ON\s+user_roles/i,
    severity: 'HIGH',
    message:
      'Pilot politika "roles_manage" je zamenjena sa "user_roles_admin_write" — uklonjena 2026-04-23.',
    fix: 'Ne vraćaj "roles_manage". Koristi user_roles_admin_write iz schema.sql/enable_user_roles_rls_proper.sql.',
  },
  {
    id: 'grant-select-anon-v-production',
    pattern:
      /GRANT\s+SELECT\s+ON\s+(?:public\.)?v_production_operations\s+TO\s+anon/i,
    severity: 'CRITICAL',
    message:
      'GRANT SELECT na v_production_operations za rolu anon je opozvan 2026-04-23 (vidi revoke_anon_v_production_operations.sql).',
    fix: 'Ukloni GRANT za anon. Authenticated rola i dalje ima pristup za potrebe UI-ja.',
  },
];

function readSchema() {
  try {
    return fs.readFileSync(SCHEMA_PATH, 'utf8');
  } catch (e) {
    console.error(`[security-baseline] Ne mogu da pročitam ${SCHEMA_PATH}: ${e.message}`);
    process.exit(2);
  }
}

function stripSqlComments(sql) {
  /* Ukloni `-- line comments` i `/ * block comments * /` da regex ne hvata
     primere u dokumentaciji. */
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])--[^\n]*$/gm, '$1');
}

function main() {
  const raw = readSchema();
  const sql = stripSqlComments(raw);

  const violations = [];
  for (const rule of RULES) {
    if (rule.pattern.test(sql)) {
      violations.push(rule);
    }
  }

  if (violations.length === 0) {
    console.log('[security-baseline] OK — sql/schema.sql ne sadrži zabranjene pilot pattern-e.');
    process.exit(0);
  }

  console.error('');
  console.error('========================================================');
  console.error('  SECURITY BASELINE FAILURE — sql/schema.sql');
  console.error('========================================================');
  for (const v of violations) {
    console.error('');
    console.error(`[${v.severity}] ${v.id}`);
    console.error(`  Problem: ${v.message}`);
    console.error(`  Popravka: ${v.fix}`);
  }
  console.error('');
  console.error('Naruseno pravila: ' + violations.length);
  console.error('Vidi: scripts/check-schema-security-baseline.cjs za detalje.');
  process.exit(1);
}

main();
