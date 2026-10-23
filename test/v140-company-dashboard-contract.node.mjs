import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/0012_owner_company_dashboard.sql', import.meta.url), 'utf8');
const route = await readFile(new URL('../src/routes/companies.js', import.meta.url), 'utf8');
const overview = await readFile(new URL('../../hysmart station_frontend/src/pages/OverviewPage.jsx', import.meta.url), 'utf8');

test('company dashboard aggregation is owner-gated and server calculated', () => {
  assert.match(migration, /role\s*=\s*'COMPANY_OWNER'/);
  assert.match(migration, /status\s*=\s*'active'/);
  assert.match(migration, /raise exception 'COMPANY_OWNER_REQUIRED'/);
  assert.match(migration, /sum\(nmr\.expected_amount\)/);
  assert.match(migration, /sum\(sc\.amount\)/);
  assert.match(migration, /from public\.stations s where s\.company_id=v_company_id/);
  assert.match(migration, /revoke all on function public\.get_company_dashboard_summary\(uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_company_dashboard_summary\(uuid\) to service_role/);
  assert.match(route, /get\('\/dashboard-summary'/);
  assert.match(route, /get_company_dashboard_summary/);
});

test('owner overview distinguishes meter sales from recorded collections and shows branch reports', () => {
  assert.match(overview, /Sales today/);
  assert.match(overview, /Collections today/);
  assert.match(overview, /Branch performance/);
  assert.match(overview, /latestReconciliation/);
  assert.match(overview, /They are intentionally shown separately/);
});
