-- ============================================================================
-- ODRŽAVANJE (CMMS) — zalihe i dobavljači
-- ============================================================================
-- MORA posle:
--   * add_maint_work_orders.sql
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maint_stock_movement_type') THEN
    CREATE TYPE public.maint_stock_movement_type AS ENUM ('in', 'out', 'adjustment', 'return');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.maint_suppliers (
  supplier_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  contact     TEXT,
  email       TEXT,
  phone       TEXT,
  notes       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT maint_suppliers_name_nonempty CHECK (length(trim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS public.maint_parts (
  part_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_code     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  unit          TEXT NOT NULL DEFAULT 'kom',
  supplier_id   UUID REFERENCES public.maint_suppliers (supplier_id) ON DELETE SET NULL,
  manufacturer  TEXT,
  model         TEXT,
  min_stock     NUMERIC(12, 4) NOT NULL DEFAULT 0,
  current_stock NUMERIC(12, 4) NOT NULL DEFAULT 0,
  unit_cost     NUMERIC(12, 2),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT maint_parts_code_nonempty CHECK (length(trim(part_code)) > 0),
  CONSTRAINT maint_parts_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT maint_parts_min_stock_nonnegative CHECK (min_stock >= 0)
);

CREATE TABLE IF NOT EXISTS public.maint_part_stock_movements (
  movement_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id       UUID NOT NULL REFERENCES public.maint_parts (part_id) ON DELETE RESTRICT,
  wo_id         UUID REFERENCES public.maint_work_orders (wo_id) ON DELETE SET NULL,
  movement_type public.maint_stock_movement_type NOT NULL,
  quantity      NUMERIC(12, 4) NOT NULL,
  unit_cost     NUMERIC(12, 2),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT maint_part_stock_qty_valid CHECK (
    (movement_type = 'adjustment' AND quantity <> 0)
    OR (movement_type <> 'adjustment' AND quantity > 0)
  )
);

ALTER TABLE public.maint_wo_parts
  ADD COLUMN IF NOT EXISTS part_id UUID REFERENCES public.maint_parts (part_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_maint_parts_active_name
  ON public.maint_parts (active, name);

CREATE INDEX IF NOT EXISTS idx_maint_parts_supplier
  ON public.maint_parts (supplier_id);

CREATE INDEX IF NOT EXISTS idx_maint_stock_movements_part
  ON public.maint_part_stock_movements (part_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_maint_stock_movements_wo
  ON public.maint_part_stock_movements (wo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_maint_wo_parts_part
  ON public.maint_wo_parts (part_id);

DROP TRIGGER IF EXISTS maint_suppliers_touch_updated ON public.maint_suppliers;
CREATE TRIGGER maint_suppliers_touch_updated
  BEFORE UPDATE ON public.maint_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS maint_parts_touch_updated ON public.maint_parts;
CREATE TRIGGER maint_parts_touch_updated
  BEFORE UPDATE ON public.maint_parts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.maint_apply_part_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delta NUMERIC(12, 4);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  v_delta := CASE NEW.movement_type
    WHEN 'in' THEN NEW.quantity
    WHEN 'return' THEN NEW.quantity
    WHEN 'out' THEN -NEW.quantity
    WHEN 'adjustment' THEN NEW.quantity
  END;

  UPDATE public.maint_parts
  SET current_stock = current_stock + v_delta
  WHERE part_id = NEW.part_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maint_part_stock_movements_apply ON public.maint_part_stock_movements;
CREATE TRIGGER maint_part_stock_movements_apply
  AFTER INSERT ON public.maint_part_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.maint_apply_part_stock_movement();

ALTER TABLE public.maint_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maint_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maint_part_stock_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_suppliers_select ON public.maint_suppliers;
CREATE POLICY maint_suppliers_select ON public.maint_suppliers
  FOR SELECT USING (public.maint_has_floor_read_access());

DROP POLICY IF EXISTS maint_suppliers_insert ON public.maint_suppliers;
CREATE POLICY maint_suppliers_insert ON public.maint_suppliers
  FOR INSERT WITH CHECK (
    public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_suppliers_update ON public.maint_suppliers;
CREATE POLICY maint_suppliers_update ON public.maint_suppliers
  FOR UPDATE USING (
    public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  )
  WITH CHECK (
    public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_parts_select ON public.maint_parts;
CREATE POLICY maint_parts_select ON public.maint_parts
  FOR SELECT USING (public.maint_has_floor_read_access());

DROP POLICY IF EXISTS maint_parts_insert ON public.maint_parts;
CREATE POLICY maint_parts_insert ON public.maint_parts
  FOR INSERT WITH CHECK (
    public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_parts_update ON public.maint_parts;
CREATE POLICY maint_parts_update ON public.maint_parts
  FOR UPDATE USING (
    public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  )
  WITH CHECK (
    public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_stock_movements_select ON public.maint_part_stock_movements;
CREATE POLICY maint_stock_movements_select ON public.maint_part_stock_movements
  FOR SELECT USING (public.maint_has_floor_read_access());

DROP POLICY IF EXISTS maint_stock_movements_insert ON public.maint_part_stock_movements;
CREATE POLICY maint_stock_movements_insert ON public.maint_part_stock_movements
  FOR INSERT WITH CHECK (
    created_by = auth.uid()
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('technician', 'chief', 'admin')
    )
    AND (
      wo_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.maint_work_orders w
        WHERE w.wo_id = maint_part_stock_movements.wo_id
          AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
      )
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.maint_suppliers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.maint_parts TO authenticated;
GRANT SELECT, INSERT ON public.maint_part_stock_movements TO authenticated;
GRANT EXECUTE ON FUNCTION public.maint_apply_part_stock_movement() TO authenticated;

COMMIT;
