import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const migration = readFileSync(new URL('supabase/migrations/0017_kg_adjustments_and_collection_reversals.sql', root), 'utf8');
const controls = readFileSync(new URL('src/routes/controls.js', root), 'utf8');
const governance = readFileSync(new URL('src/routes/governance.js', root), 'utf8');
const sales = readFileSync(new URL('../../station_pwa/src/pages/SalesPage.jsx', import.meta.url), 'utf8');
const operations = readFileSync(new URL('src/routes/operations.js', root), 'utf8');
const controlUi = readFileSync(new URL('../../station_pwa/src/pages/ControlsPage.jsx', import.meta.url), 'utf8');
const governanceUi = readFileSync(new URL('../../station_pwa/src/pages/GovernancePage.jsx', import.meta.url), 'utf8');
test('kilogram stock adjustments are owner-approved, unit-separated and capacity/negative-stock checked', () => {
  assert.match(migration, /create table if not exists public\.kg_stock_adjustment_requests/);
  assert.match(migration, /create table if not exists public\.kg_tank_stock_movements/);
  assert.match(migration, /review_kg_stock_adjustment/);
  assert.match(migration, /v_req\.requested_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'/);
  assert.match(migration, /v_next>v_tank\.capacity_units/);
  assert.match(migration, /v_next<0/);
  assert.match(controls, /\/kg-stock-adjustments/);
  assert.match(controls, /OWNER_APPROVAL_REQUIRED/);
});
test('kilogram collection reversals preserve original records and enforce dual control and remaining amount', () => {
  assert.match(migration, /create table if not exists public\.kg_collection_reversal_requests/);
  assert.match(migration, /create table if not exists public\.kg_sales_collection_reversals/);
  assert.match(migration, /review_kg_sales_collection_reversal/);
  assert.match(migration, /v_req\.requested_amount>v_collection\.amount-v_already/);
  assert.match(governance, /\/kg-collection-reversal-requests/);
  assert.match(governance, /review_kg_sales_collection_reversal/);
});
test('kg adjustments affect kg book stock and reversals affect net collections and shift reconciliation', () => {
  assert.match(migration, /sum\(case when movement_type='adjustment_in' then quantity_kg else -quantity_kg end\)/);
  assert.match(migration, /kg_sales_collection_reversals/);
  assert.match(migration, /get_company_dashboard_summary/);
  assert.match(sales, /kg_sales_collection_reversals/);
  assert.match(operations, /kg_sales_collection_reversals/);
  assert.match(operations, /kgReversedByCollection/);
  assert.match(controlUi, /kg-stock-adjustments/);
  assert.match(governanceUi, /kg-collection-reversal-requests/);
});
