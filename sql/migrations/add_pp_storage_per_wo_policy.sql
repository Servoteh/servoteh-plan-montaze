-- ============================================================================
-- F.7 PILOT HARDENING — M-3: storage per-WO scope policy
-- ============================================================================
-- ⚠️ MANUELNA PRIMENA — Supabase Dashboard:
--    Storage → policies → bucket "production-drawings"
--
-- Razlog: Supabase MCP / service_role ne može da menja `storage.objects`
-- politike (mora biti owner of relation). Migration mora da ide kroz
-- Supabase Dashboard ili `supabase` CLI sa odgovarajućim DB password-om.
--
-- ── Šta i zašto ────────────────────────────────────────────────────────
-- Pre ove migracije, Storage RLS na `production-drawings` bucket je:
--   USING (bucket_id = 'production-drawings')
-- za sve authenticated korisnike. Bilo ko ulogovan može preko
-- `GET /storage/v1/object/production-drawings/*` da pročita BILO KOJI fajl
-- (bez sopstvene sesije i bez signed URL guard-a).
--
-- Storage layout (services/planProizvodnje.js:569):
--   {work_order_id}/{line_id}/{uuid}_{file_name}
--
-- Trenutni rizik: TEORIJSKI. Bucket je trenutno prazan (0 objekata) i
-- klijentski kod ne servira raw URL nigde — sve ide kroz `getDrawingSignedUrl`
-- koji generiše signed URL sa TTL=5min. Ali eksplicitna RLS politika je
-- defense in depth.
--
-- ── Korak 1: helper funkcija ───────────────────────────────────────────
-- (Ovo MOŽE da se primeni preko MCP — nije storage.objects.)
CREATE OR REPLACE FUNCTION public.pd_storage_can_read(p_storage_path text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    public.can_edit_plan_proizvodnje()
    OR EXISTS (
      SELECT 1 FROM public.production_drawings pd
      WHERE pd.storage_path = p_storage_path
        AND pd.deleted_at IS NULL
    );
$function$;

COMMENT ON FUNCTION public.pd_storage_can_read(text) IS
  'F.7 (M-3): true ako sme da cita storage objekat iz production-drawings — '
  'edit-role sve, ostali samo registrovane (production_drawings.storage_path).';

-- ── Korak 2: storage policy (Dashboard manual) ─────────────────────────
-- U Supabase Dashboard → Storage → policies → bucket production-drawings,
-- skini staru SELECT politiku "pd_storage_read_authenticated" i dodaj:
--
-- Policy name: pd_storage_read_scoped
-- Allowed operation: SELECT
-- Target roles: authenticated
-- USING expression:
--   bucket_id = 'production-drawings' AND public.pd_storage_can_read(name)
--
-- Ekvivalentan SQL (mora se izvršiti kao postgres superuser, ne kao
-- service_role, što MCP nije):
--
--   DROP POLICY IF EXISTS pd_storage_read_authenticated ON storage.objects;
--   DROP POLICY IF EXISTS pd_storage_read_scoped ON storage.objects;
--   CREATE POLICY pd_storage_read_scoped
--     ON storage.objects FOR SELECT
--     TO authenticated
--     USING (
--       bucket_id = 'production-drawings'
--       AND public.pd_storage_can_read(name)
--     );
--
-- INSERT/UPDATE/DELETE politike NE menjamo — već su can_edit_plan_proizvodnje().
