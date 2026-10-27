import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const route = readFileSync(new URL('../src/routes/operations.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../hysmart station_frontend/src/pages/ReportsPage.jsx', import.meta.url), 'utf8');
test('branch statement endpoint filters every transaction source by selected date range', () => {
  assert.match(route, /statement-transactions/);
  assert.match(route, /\.gte\(dateColumn,startInclusive\)\.lt\(dateColumn,endExclusive\)/);
  assert.match(route, /nozzle_meter_readings.*recorded_at/);
  assert.match(route, /sales_collections.*collected_at/);
  assert.match(route, /tank_deliveries.*delivered_at/);
  assert.match(route, /station_shift_reconciliations.*reconciled_at/);
});
test('branch statement endpoint uses stable cursor pagination and approved meter sales', () => {
  assert.match(route, /base64url/);
  assert.match(route, /range\(0,pageSize\)/);
  assert.match(route, /q=q\.eq\('status','approved'\)/);
  assert.match(route, /nextCursor/);
  assert.match(page, /while\(cursor\)/);
  assert.doesNotMatch(page, /most recent 100 records per source table/);
});

test('statement pagination has composite indexes for all queried date/id paths', () => {
 const indexes = readFileSync(new URL('../supabase/migrations/0044_statement_query_indexes.sql', import.meta.url), 'utf8');
 for (const table of ['nozzle_meter_readings','kg_nozzle_meter_readings','sales_collections','kg_sales_collections','sales_collection_reversals','kg_sales_collection_reversals','tank_deliveries','shift_reconciliations','station_shift_reconciliations','tank_stock_checks','kg_tank_stock_checks']) assert.match(indexes, new RegExp('on public\\.' + table + ' \\(station_id,'));
});
