/**
 * Vitest pokriva `scripts/check-schema-security-baseline.cjs`:
 * - svaki RULE mora da hvata očekivani anti-pattern,
 * - "čisto" SQL mora da vrati 0 violations.
 *
 * Skriptu pozivamo kao child_process pa tu hvatamo i pravo CLI ponašanje
 * (exit code, output u stderr). Ulaz uplistuje preko privremenog fajla
 * koji `--schema` flag override-uje. Trenutno skripta nema `--schema`
 * flag, pa testovi monkey-patch-uju default putanju kroz env override.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'check-schema-security-baseline.cjs');

/** Pokreće skriptu sa privremenom kopijom schema.sql i vraća { code, stderr, stdout }. */
function runWithSchema(schemaContent) {
  const tmp = mkdtempSync(join(tmpdir(), 'schema-baseline-'));
  const sqlDir = join(tmp, 'sql');
  const fakeRoot = tmp;
  try {
    require('node:fs').mkdirSync(sqlDir, { recursive: true });
    writeFileSync(join(sqlDir, 'schema.sql'), schemaContent, 'utf8');

    /* Skripta računa SCHEMA_PATH kao `__dirname/../sql/schema.sql`.
       Pokrećemo je kroz `node -e` da postavimo cwd i prepatch __dirname. */
    const runner = `
      const path = require('path');
      const Module = require('module');
      const orig = Module.prototype.require;
      // Override path.resolve unutar skripte: forsira korišćenje fakeRoot.
      const realResolve = path.resolve;
      path.resolve = function(...args) {
        const out = realResolve.apply(path, args);
        if (out.endsWith(path.join('sql','schema.sql'))) {
          return path.join(${JSON.stringify(fakeRoot)}, 'sql', 'schema.sql');
        }
        return out;
      };
      require(${JSON.stringify(SCRIPT)});
    `;
    const res = spawnSync(process.execPath, ['-e', runner], {
      encoding: 'utf8',
    });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('check-schema-security-baseline.cjs', () => {
  it('exit 0 na čistom schema.sql', () => {
    const cleanSql = `
      -- prazna schema, samo header
      CREATE TABLE foo (id int);
    `;
    const { code, stderr } = runWithSchema(cleanSql);
    expect(stderr).not.toMatch(/SECURITY BASELINE FAILURE/);
    expect(code).toBe(0);
  });

  it('hvata pilot has_edit_role koji bezuslovno vraća TRUE', () => {
    const badSql = `
      CREATE OR REPLACE FUNCTION public.has_edit_role(proj_id UUID DEFAULT NULL)
      RETURNS BOOLEAN
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      BEGIN
        RETURN true;
      END;
      $$;
    `;
    const { code, stderr } = runWithSchema(badSql);
    expect(stderr).toMatch(/has-edit-role-return-true/);
    expect(code).toBe(1);
  });

  it('NE hvata has_edit_role sa pravom proverom uloge (čak i ako negde ima RETURN true u IF grani)', () => {
    const okSql = `
      CREATE OR REPLACE FUNCTION public.has_edit_role(proj_id UUID DEFAULT NULL)
      RETURNS BOOLEAN
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.user_roles WHERE role='admin') THEN
          RETURN true;
        END IF;
        RETURN false;
      END;
      $$;
    `;
    const { code } = runWithSchema(okSql);
    expect(code).toBe(0);
  });

  it('hvata roles_select USING(true)', () => {
    const badSql = `
      CREATE POLICY "roles_select" ON user_roles FOR SELECT TO authenticated USING (true);
    `;
    const { code, stderr } = runWithSchema(badSql);
    expect(stderr).toMatch(/roles-select-using-true/);
    expect(code).toBe(1);
  });

  it('hvata roles_manage pilot politiku', () => {
    const badSql = `
      CREATE POLICY "roles_manage" ON user_roles FOR ALL TO authenticated USING (true);
    `;
    const { code, stderr } = runWithSchema(badSql);
    expect(stderr).toMatch(/roles-manage-pilot/);
    expect(code).toBe(1);
  });

  it('hvata GRANT SELECT ON v_production_operations TO anon', () => {
    const badSql = `GRANT SELECT ON public.v_production_operations TO anon;`;
    const { code, stderr } = runWithSchema(badSql);
    expect(stderr).toMatch(/grant-select-anon-v-production/);
    expect(code).toBe(1);
  });

  it('ignoriše zabranjene tekstove unutar SQL komentara', () => {
    const okSql = `
      -- Pre 2026-04-23 ovde je stajao GRANT SELECT ON public.v_production_operations TO anon;
      /* DEPRECATED:
         CREATE POLICY "roles_select" ON user_roles FOR SELECT TO authenticated USING (true);
      */
      CREATE TABLE bar(id int);
    `;
    const { code } = runWithSchema(okSql);
    expect(code).toBe(0);
  });
});
