-- Read-only schema diagnostic for HySmart Station. Safe to run in Supabase SQL Editor.
-- This does not create, alter, or delete any database object.
WITH expected_tables(table_name) AS (
  VALUES
    ('companies'), ('company_members'), ('stations'), ('station_members'),
    ('fuel_products'), ('station_tanks'), ('station_pumps'), ('pump_nozzles'),
    ('tank_deliveries'), ('nozzle_meter_readings'), ('sales_collections'),
    ('sales_collection_reversal_requests'), ('sales_collection_reversals'),
    ('kg_nozzle_meter_readings'), ('kg_sales_collections'),
    ('kg_collection_reversal_requests'), ('kg_sales_collection_reversals'),
    ('notification_inbox'), ('notification_delivery_log'),
    ('station_cash_shifts'), ('shift_meter_openings'), ('shift_nozzle_roster'),
    ('station_shift_reconciliations'), ('station_daily_closing_reviews')
)
SELECT e.table_name,
       CASE WHEN t.table_name IS NULL THEN 'MISSING' ELSE 'PRESENT' END AS status
FROM expected_tables e
LEFT JOIN information_schema.tables t
  ON t.table_schema = 'public' AND t.table_name = e.table_name
ORDER BY status DESC, e.table_name;

-- Critical columns involved in the known notification, product-price, and reversal errors.
WITH expected_columns(table_name, column_name) AS (
  VALUES
    ('fuel_products','default_price_per_unit'),
    ('notification_inbox','message_group_id'),
    ('notification_inbox','requires_acknowledgement'),
    ('notification_inbox','acknowledged_at'),
    ('notification_inbox','message_type'),
    ('sales_collection_reversal_requests','collection_id'),
    ('sales_collection_reversals','collection_id'),
    ('kg_collection_reversal_requests','collection_id'),
    ('kg_sales_collection_reversals','collection_id'),
    ('nozzle_meter_readings','status'),
    ('kg_nozzle_meter_readings','status')
)
SELECT e.table_name, e.column_name,
       CASE WHEN c.column_name IS NULL THEN 'MISSING' ELSE 'PRESENT' END AS status
FROM expected_columns e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
ORDER BY status DESC, e.table_name, e.column_name;
