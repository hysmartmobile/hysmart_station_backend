import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/0032_approved_meter_company_dashboard.sql', import.meta.url), 'utf8');
const reconciliationMigration = await readFile(new URL('../supabase/migrations/0033_owner_reconciliation_reporting.sql', import.meta.url), 'utf8');
const sales = await readFile(new URL('../../station_pwa/src/pages/SalesPage.jsx', import.meta.url), 'utf8');
const overview = await readFile(new URL('../../station_pwa/src/pages/OverviewPage.jsx', import.meta.url), 'utf8');
const api = await readFile(new URL('../../station_pwa/src/lib/api.js', import.meta.url), 'utf8');
const auth = await readFile(new URL('../../station_pwa/src/features/auth/AuthContext.jsx', import.meta.url), 'utf8');
const layoutSource = await readFile(new URL('../../station_pwa/src/layouts/AppLayout.jsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../../station_pwa/src/layouts/AppLayout.jsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../../station_pwa/src/App.jsx', import.meta.url), 'utf8');

test('company dashboard only includes approved litre and kg meter readings in sales totals', () => {
  assert.match(migration, /nmr\.status='approved'/);
  assert.match(migration, /kg\.status='approved'/);
  assert.match(migration, /sum\(kc\.amount - coalesce\(rv\.reversed_amount,0\)\)/);
  assert.match(migration, /kg_sales_collection_reversals/);
  assert.match(reconciliationMigration, /public\.station_shift_reconciliations sr where sr\.station_id=s\.id order by sr\.reconciled_at desc limit 1/);
  assert.doesNotMatch(reconciliationMigration, /from public\.shift_reconciliations sr where sr\.station_id=s\.id order by sr\.shift_date desc limit 1/);
});

test('sales screen excludes pending/rejected readings from expected-sales metrics and collection selectors', () => {
  assert.match(sales, /r\.shift_date===date&&r\.status==='approved'/);
  assert.match(sales, /nozzle_meter_readings\|\|\[\]\)\.filter\(r=>r\.status==='approved'&&!!openShiftId&&r\.cash_shift_id===openShiftId\)/);
  assert.match(sales, /kg_nozzle_meter_readings\|\|\[\]\)\.filter\(r=>r\.status==='approved'&&!!openShiftId&&r\.cash_shift_id===openShiftId\)/);
});

test('owner overview describes collection totals as net of reversals', () => {
  assert.match(overview, /Net recorded collections after reversals/);
  assert.doesNotMatch(overview, /collections figure does not yet subtract collection reversals/i);
});

test('frontend normalizes documented API origin values to the /api route prefix', () => {
  assert.match(api, /VITE_API_BASE_URL \|\| import\.meta\.env\.VITE_API_URL/);
  assert.match(api, /Request ID: \$\{requestId\}/);
  assert.match(auth, /\.catch\(\(\) =>/);
  assert.match(layoutSource, /successfulIds\.size/);
  assert.match(api, /\/api\$.*trimmedBase/);
  assert.match(app, /apiRequest\('\/me'/);
});

test('attendant navigation exposes only attendance, sales, alerts, messages and overview', () => {
  assert.match(layout, /const attendantRoutes = new Set\(\[[^\]]*'\/sales'[^\]]*\]\)/s);
  assert.doesNotMatch(layout.match(/const attendantRoutes = new Set\(\[[^\]]*\]\)/s)?.[0] || '', /'\/messages'/);
  assert.match(layout, /activeStationRoles\.includes\('STATION_MANAGER'\)/);
});
