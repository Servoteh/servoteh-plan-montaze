/**
 * Vitest pokriva `scripts/generate-rbac-matrix.cjs`:
 * - default mode: piše MD, exit 0
 * - --check mode kad je MD sinhron: exit 0
 * - --check mode kad je MD zastareo: exit 1
 *
 * Skripta se izvršava sa monkey-patch-ovanim `path.resolve` koji forsira
 * korišćenje privremenog ROOT-a (isti pattern kao schemaSecurityBaseline test).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'generate-rbac-matrix.cjs');

function runWithFakeRoot(rootDir, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, RBAC_ROOT: rootDir },
  });
}

function setupFakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'rbac-test-'));
  mkdirSync(join(root, 'sql'), { recursive: true });
  mkdirSync(join(root, 'sql', 'migrations'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'sql', 'schema.sql'),
    `CREATE POLICY "test_policy" ON test_table FOR SELECT TO authenticated USING (true);\n`,
    'utf8'
  );
  return root;
}

describe('generate-rbac-matrix.cjs', () => {
  it('default mode piše MD i izlazi 0', () => {
    const root = setupFakeRepo();
    try {
      const res = runWithFakeRoot(root);
      expect(res.status).toBe(0);
      const md = readFileSync(join(root, 'docs', 'RBAC_MATRIX.md'), 'utf8');
      expect(md).toMatch(/RBAC Matrix/);
      expect(md).toMatch(/test_policy/);
      expect(md).toMatch(/test_table/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--check mode prolazi kad je MD sinhron', () => {
    const root = setupFakeRepo();
    try {
      runWithFakeRoot(root); // generisanje
      const check = runWithFakeRoot(root, ['--check']);
      expect(check.status).toBe(0);
      expect(check.stdout).toMatch(/sinhron/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--check mode pada kad neko doda novu politiku bez regenerisanja', () => {
    const root = setupFakeRepo();
    try {
      runWithFakeRoot(root); // generisanje sa 1 politikom

      // Dodaj novu politiku — MD treba da bude regenerisan, ali nije.
      writeFileSync(
        join(root, 'sql', 'migrations', 'new_change.sql'),
        `CREATE POLICY "new_policy" ON other_table FOR ALL TO anon USING (true);\n`,
        'utf8'
      );

      const check = runWithFakeRoot(root, ['--check']);
      expect(check.status).toBe(1);
      expect(check.stderr).toMatch(/CHECK FAIL/);
      expect(check.stderr).toMatch(/regenerisanja/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--check mode pada kad MD ne postoji uopšte', () => {
    const root = setupFakeRepo();
    try {
      // Nema docs/RBAC_MATRIX.md — odmah check.
      const check = runWithFakeRoot(root, ['--check']);
      expect(check.status).toBe(1);
      expect(check.stderr).toMatch(/ne postoji/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hvata anon grant-ove i prikazuje ih u "Anon (javni) pristup" sekciji', () => {
    const root = setupFakeRepo();
    try {
      writeFileSync(
        join(root, 'sql', 'migrations', 'add_grant.sql'),
        `GRANT SELECT ON public.public_view TO anon;\n` +
          `GRANT EXECUTE ON FUNCTION public.helper_fn() TO anon;\n`,
        'utf8'
      );
      runWithFakeRoot(root);
      const md = readFileSync(join(root, 'docs', 'RBAC_MATRIX.md'), 'utf8');
      expect(md).toMatch(/Anon \(javni\) pristup/);
      expect(md).toMatch(/public_view/);
      expect(md).toMatch(/helper_fn/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REVOKE poništava raniji GRANT (anon ne ostaje u tabeli posle REVOKE-a)', () => {
    const root = setupFakeRepo();
    try {
      // Migracija 1: grant. Migracija 2: revoke. Konačno: anon nema pristup.
      writeFileSync(
        join(root, 'sql', 'migrations', 'a_grant.sql'),
        `GRANT SELECT ON public.leaky_view TO anon;\n`,
        'utf8'
      );
      writeFileSync(
        join(root, 'sql', 'migrations', 'b_revoke.sql'),
        `REVOKE SELECT ON public.leaky_view FROM anon;\n`,
        'utf8'
      );
      runWithFakeRoot(root);
      const md = readFileSync(join(root, 'docs', 'RBAC_MATRIX.md'), 'utf8');
      expect(md).not.toMatch(/leaky_view/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
