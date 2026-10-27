-- HySmart Station v2.24.1: indexes for date-filtered branch statements and cursor pagination.
-- Apply after 0043. These indexes support the exact station/date/id access pattern used by
-- /api/operations/statement-transactions, including current and legacy reconciliation rows.

create index if not exists statement_litre_readings_page_idx
  on public.nozzle_meter_readings (station_id, recorded_at desc, id desc);
create index if not exists statement_kg_readings_page_idx
  on public.kg_nozzle_meter_readings (station_id, recorded_at desc, id desc);
create index if not exists statement_litre_collections_page_idx
  on public.sales_collections (station_id, collected_at desc, id desc);
create index if not exists statement_kg_collections_page_idx
  on public.kg_sales_collections (station_id, collected_at desc, id desc);
create index if not exists statement_litre_reversals_page_idx
  on public.sales_collection_reversals (station_id, created_at desc, id desc);
create index if not exists statement_kg_reversals_page_idx
  on public.kg_sales_collection_reversals (station_id, created_at desc, id desc);
create index if not exists statement_deliveries_page_idx
  on public.tank_deliveries (station_id, delivered_at desc, id desc);
create index if not exists statement_legacy_reconciliations_page_idx
  on public.shift_reconciliations (station_id, reconciled_at desc, id desc);
create index if not exists statement_cash_reconciliations_page_idx
  on public.station_shift_reconciliations (station_id, reconciled_at desc, id desc);
create index if not exists statement_litre_stock_checks_page_idx
  on public.tank_stock_checks (station_id, measured_at desc, id desc);
create index if not exists statement_kg_stock_checks_page_idx
  on public.kg_tank_stock_checks (station_id, measured_at desc, id desc);
