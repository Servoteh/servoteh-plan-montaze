-- ============================================================================
-- CMMS — ŠABLON za početne podatke (NE izvršavaj slepo u produkciji)
-- ============================================================================
-- Prilagodi vrednosti i UUID-ove. Mnoge tabele zahtevaju postojeće auth.users
-- za created_by / updated_by — koristi stvarne user_id iz vaše instance.
-- ============================================================================

-- BEGIN;

-- Primer: lokacija (ako koristite hijerarhiju lokacija)
-- INSERT INTO public.maint_locations (location_id, name, code, parent_location_id)
-- VALUES (gen_random_uuid(), 'HALA 1', 'H1', NULL)
-- ON CONFLICT DO NOTHING;

-- Primer: generičko sredstvo (mašina) — obično se veže na postojeću maint_machines / asset sync
-- INSERT INTO public.maint_assets (asset_id, asset_type, asset_code, name, location_id, operational_status)
-- VALUES (
--   gen_random_uuid(),
--   'machine',
--   'MAS-001',
--   'Primer mašine',
--   NULL,
--   'operational'
-- );

-- Primer: dobavljač
-- INSERT INTO public.maint_suppliers (supplier_id, name, contact, phone, active)
-- VALUES (gen_random_uuid(), 'Primer DOO', 'Kontakt osoba', '+381...', true);

-- Primer: rezervni deo
-- INSERT INTO public.maint_parts (
--   part_id, part_code, name, unit, supplier_id, min_stock, current_stock, unit_cost, active
-- ) VALUES (
--   gen_random_uuid(),
--   'DEL-0001',
--   'Filter ulja',
--   'kom',
--   NULL,
--   2,
--   0,
--   1500.00,
--   true
-- );

-- Primer: preventivni šablon (machine_code mora postojati u maint_machines)
-- INSERT INTO public.maint_tasks (
--   id, machine_code, title, description, instructions,
--   interval_value, interval_unit, severity, required_role, grace_period_days, active
-- ) VALUES (
--   gen_random_uuid(),
--   'STVARNI_MACHINE_CODE',
--   'Nedeljni vizuelni pregled',
--   NULL,
--   'Proveriti curenje, buku, zagrevanje.',
--   1,
--   'week',
--   'normal',
--   'operator',
--   3,
--   true
-- );

-- COMMIT;
