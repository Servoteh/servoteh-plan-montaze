-- ═══════════════════════════════════════════════════════════
-- CLEANUP: Ukloni legacy RLS politike na user_roles iz schema.sql
--
-- Kontekst:
--   sql/schema.sql (početna shema) je definisao dve politike pod
--   imenima `roles_select` i `roles_manage`. Naša migracija
--   enable_user_roles_rls_proper.sql ih NIJE dropovala (jer ne
--   znamo za njih), pa su ostale aktivne. Posle migracije imamo
--   4 politike umesto 3, i jedna od njih (`roles_select`) ima
--   `USING (true)` što POTPUNO PONIŠTAVA bezbednost (svaki
--   ulogovan user vidi ceo user_roles).
--
--   PostgreSQL RLS politike za istu komandu se OR-uju → ako
--   bilo koja vraća true, red se vidi/menja.
--
-- Posle ovoga:
--   user_roles_read_self        — svako vidi svoj red
--   user_roles_read_admin_all   — admin vidi sve
--   user_roles_admin_write      — samo admin write
--   (bez `roles_select`/`roles_manage`)
--
-- Bezbedno za re-run.
-- ═══════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "roles_select"  ON user_roles;
DROP POLICY IF EXISTS "roles_manage"  ON user_roles;

-- Defensivno: bilo koja druga "user can read own role by email"
-- koja se u nekoj prethodnoj iteraciji možda kreirala manuelno.
DROP POLICY IF EXISTS "user can read own role by email" ON user_roles;

-- Verifikacija — treba 3 politike, sve naše:
SELECT polname,
       CASE polcmd
         WHEN 'r' THEN 'SELECT'
         WHEN 'a' THEN 'INSERT'
         WHEN 'w' THEN 'UPDATE'
         WHEN 'd' THEN 'DELETE'
         WHEN '*' THEN 'ALL'
       END AS cmd
FROM   pg_policy
WHERE  polrelid='user_roles'::regclass
ORDER  BY polname;
-- Očekivano:
--   user_roles_admin_write     | ALL
--   user_roles_read_admin_all  | SELECT
--   user_roles_read_self       | SELECT
