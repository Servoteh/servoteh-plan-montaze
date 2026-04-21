-- ═══════════════════════════════════════════════════════════════════════
-- K3.2 — Mesečni obračun zarade: PRE-CHECK + MIGRACIJA + POST-VERIFIKACIJA
--
-- KAKO DA KORISTIŠ u Supabase SQL Editor-u:
--   1) Otvori: https://supabase.com/dashboard/project/fniruhsuotwsrjsbhrxd/sql/new
--   2) Ovaj fajl je podeljen u 7 BLOKOVA. Pokreći ih JEDAN PO JEDAN:
--      označi ceo blok mišem (od "/* === BLOK X ... === */" do sledećeg),
--      pa Ctrl+Enter ili klik Run (Run selection).
--   3) Kopiraj output (tabelu) nazad u chat.
--
-- BLOKOVI:
--   BLOK 1  — PRE-CHECK (pre migracije)       — očekuj: svi false (ili neki true ako već postoji)
--   BLOK 2  — MIGRACIJA                        — ceo sadržaj add_kadr_salary_payroll.sql
--                                                (pokreni samo ako BLOK 1 nije sve true)
--   BLOK 3  — POST: 4 osnovna flag-a           — očekuj: svi true
--   BLOK 4  — POST: RLS policies (4 reda)
--   BLOK 5  — POST: Constraints (5 CHECK + 1 UNIQUE + 1 FK + 1 PK)
--   BLOK 6  — POST: Triggeri (3 kom)
--   BLOK 7  — SMOKE TEST RPC
-- ═══════════════════════════════════════════════════════════════════════


/* ═════════════════ BLOK 1: PRE-CHECK (pre migracije) ═════════════════ */

SELECT
  EXISTS (SELECT 1 FROM pg_tables
           WHERE schemaname='public' AND tablename='salary_payroll')
    AS has_table_salary_payroll,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='salary_terms'
             AND column_name='transport_allowance_rsd')
    AS has_col_transport_allowance_rsd,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='salary_terms'
             AND column_name='per_diem_rsd')
    AS has_col_per_diem_rsd,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='salary_terms'
             AND column_name='per_diem_eur')
    AS has_col_per_diem_eur,
  EXISTS (SELECT 1 FROM information_schema.views
           WHERE table_schema='public' AND table_name='v_salary_payroll_month')
    AS has_view_v_salary_payroll_month,
  EXISTS (SELECT 1 FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public' AND p.proname='kadr_payroll_init_month')
    AS has_rpc_kadr_payroll_init_month;


/* ═════════════════ BLOK 2: MIGRACIJA ═══════════════════════════════════
   Otvori u editor-u fajl:
     sql/migrations/add_kadr_salary_payroll.sql
   Selektuj sve (Ctrl+A), kopiraj, nalepi OVDE umesto ovog komentara,
   i pokreni. Migracija je idempotentna (safe za re-run).
   ─────────────────────────────────────────────────────────────────────── */


/* ═════════════════ BLOK 3: POST — 4 osnovna flag-a ═════════════════════ */

SELECT
  EXISTS (SELECT 1 FROM pg_tables
           WHERE schemaname='public' AND tablename='salary_payroll')
    AS table_salary_payroll,
  (EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='salary_terms'
              AND column_name='transport_allowance_rsd')
   AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='salary_terms'
                  AND column_name='per_diem_rsd')
   AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='salary_terms'
                  AND column_name='per_diem_eur'))
    AS salary_terms_extra_cols,
  EXISTS (SELECT 1 FROM information_schema.views
           WHERE table_schema='public' AND table_name='v_salary_payroll_month')
    AS view_v_salary_payroll_month,
  EXISTS (SELECT 1 FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public' AND p.proname='kadr_payroll_init_month')
    AS rpc_kadr_payroll_init_month;


/* ═════════════════ BLOK 4: POST — RLS policies (očekuj 4 reda) ═════════ */

SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname='public' AND tablename='salary_payroll'
 ORDER BY policyname;


/* ═════════════════ BLOK 5: POST — Constraints ══════════════════════════
   Očekuj:
     - 5 CHECK-ova: month_chk, year_chk, status_chk, type_chk, nonneg_chk
     - 1 UNIQUE  : (employee_id, period_year, period_month)
     - 1 PRIMARY KEY, 1 FOREIGN KEY (employees)  — info
   ─────────────────────────────────────────────────────────────────────── */

SELECT c.conname,
       c.contype,                         -- c = check, u = unique, p = PK, f = FK
       pg_get_constraintdef(c.oid, true)  AS definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname='public' AND t.relname='salary_payroll'
 ORDER BY c.contype, c.conname;


/* ═════════════════ BLOK 6: POST — Triggeri (očekuj 3 kom.) ═════════════
   Triggeri:
     - trg_salary_payroll_updated     (BEFORE UPDATE → update_updated_at)
     - trg_salary_payroll_created_by  (BEFORE INSERT → salary_payroll_set_created_by)
     - trg_salary_payroll_totals      (BEFORE INSERT OR UPDATE → salary_payroll_compute_totals)
   ─────────────────────────────────────────────────────────────────────── */

SELECT t.tgname                                                            AS trigger_name,
       CASE WHEN (t.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END         AS timing,
       CASE WHEN (t.tgtype & 4)  > 0 THEN 'INSERT'
            WHEN (t.tgtype & 8)  > 0 THEN 'DELETE'
            WHEN (t.tgtype & 16) > 0 THEN 'UPDATE'
            WHEN (t.tgtype & 20) > 0 THEN 'INSERT OR UPDATE'
       END                                                                  AS event,
       p.proname                                                             AS function_name,
       NOT t.tgisinternal                                                    AS user_trigger
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE n.nspname='public'
   AND c.relname='salary_payroll'
   AND NOT t.tgisinternal
 ORDER BY t.tgname;


/* ═════════════════ BLOK 7: SMOKE TEST — RPC init_month ═════════════════
   Ako si prijavljen kao admin: vrati broj kreiranih draft redova
     (prvi put = broj aktivnih zaposlenih; svaki sledeći put = 0, idempotent).
   Ako si prijavljen kao običan korisnik ili nisi admin u ovoj sesiji:
     očekivana je greška "forbidden" (SQLSTATE 42501) — to je normalno.

   NAPOMENA: SQL Editor u Supabase-u izvršava kao `postgres` super-user
   po default-u — tada ga `current_user_is_admin()` NE propušta (ta
   funkcija se vezuje za auth.jwt() email). Ako dobiješ 42501, OK je —
   funkcija radi. Za pravi test idi u UI prijavljen kao admin.
   ─────────────────────────────────────────────────────────────────────── */

SELECT public.kadr_payroll_init_month(
  EXTRACT(YEAR  FROM CURRENT_DATE)::int,
  EXTRACT(MONTH FROM CURRENT_DATE)::int
) AS created_rows;
