-- HySmart Station v0.8.0 production-integrity migration.
-- Back up first; run against staging before production. This migration intentionally does not
-- delete, reassign, or guess at historical business records.

-- Fail safely instead of silently changing legacy data if multiple attendance sessions are open.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.attendance_records
    WHERE clock_out_at IS NULL
    GROUP BY station_id, user_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'V080_DUPLICATE_OPEN_ATTENDANCE: close/review duplicate open attendance records before applying migration 0007';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attendance_per_staff_station
  ON public.attendance_records(station_id, user_id) WHERE clock_out_at IS NULL;
CREATE INDEX IF NOT EXISTS attendance_station_clockin_idx
  ON public.attendance_records(station_id, clock_in_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_company_created_idx
  ON public.audit_events(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_tank_created_idx
  ON public.tank_stock_movements(tank_id, created_at DESC);

-- Financial and measurement facts are append-only: corrections must be represented by a
-- compensating/reversal workflow rather than silently rewriting the original record.
CREATE OR REPLACE FUNCTION public.reject_financial_fact_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_OPERATIONAL_RECORD: create an approved correction/reversal instead of editing this record';
END $$;

DROP TRIGGER IF EXISTS immutable_meter_reading_update ON public.nozzle_meter_readings;
CREATE TRIGGER immutable_meter_reading_update BEFORE UPDATE ON public.nozzle_meter_readings
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_fact_update();
DROP TRIGGER IF EXISTS immutable_sales_collection_update ON public.sales_collections;
CREATE TRIGGER immutable_sales_collection_update BEFORE UPDATE ON public.sales_collections
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_fact_update();
DROP TRIGGER IF EXISTS immutable_tank_delivery_update ON public.tank_deliveries;
CREATE TRIGGER immutable_tank_delivery_update BEFORE UPDATE ON public.tank_deliveries
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_fact_update();
DROP TRIGGER IF EXISTS immutable_stock_movement_update ON public.tank_stock_movements;
CREATE TRIGGER immutable_stock_movement_update BEFORE UPDATE ON public.tank_stock_movements
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_fact_update();

-- No direct client role receives execute permission on the trigger helper.
REVOKE ALL ON FUNCTION public.reject_financial_fact_update() FROM PUBLIC;

-- Keep financial tables protected by RLS. Service-role access must remain server-only.
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_cash_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_shift_reconciliations ENABLE ROW LEVEL SECURITY;
