import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('v2.23.2 declares kg adjustment form state before using it', () => {
  const ui = read('hysmart station_frontend/src/pages/ControlsPage.jsx');
  assert.match(ui, /\[kgAdjust\s*,\s*setKgAdjust\]\s*=\s*useState/);
  assert.match(ui, /setKgAdjust\(s\s*=>\s*\(\{\.\.\.s/);
});

test('v2.23.2 exposes stock adjustment review actions only to owners', () => {
  const ui = read('hysmart station_frontend/src/pages/ControlsPage.jsx');
  assert.match(ui, /control\?\.permissions\?\.isOwner&&a\.status==='pending'/);
});

test('v2.23.2 daily dashboard collection totals use reversal posting date', () => {
  const migration = read('hysmart station_backend/supabase/migrations/0034_daily_reversal_reporting.sql');
  assert.match(migration, /rv\.created_at >= date_trunc\('day', now\(\)\)/);
  assert.match(migration, /'collectionsReversedToday'.*rv\.created_at/s);
  assert.doesNotMatch(migration, /collectionsReversedToday'.*sc\.collected_at/s);
});

test('v2.23.2 report range validation checks normalized calendar dates', () => {
  const route = read('hysmart station_backend/src/routes/companies.js');
  assert.match(route, /a\.toISOString\(\)\.slice\(0,\s*10\)\s*!==\s*from/);
  assert.match(route, /b\.toISOString\(\)\.slice\(0,\s*10\)\s*!==\s*to/);
});


test('v2.23.2 controls UI writes official litre and kg stock-check ledgers', () => {
  const ui = read('hysmart station_frontend/src/pages/ControlsPage.jsx');
  assert.match(ui, /apiRequest\('\/operations\/stock-checks'/);
  assert.match(ui, /apiRequest\('\/operations\/kg-stock-checks'/);
  assert.match(ui, /assets\?\.tank_stock_checks/);
  assert.match(ui, /assets\?\.kg_tank_stock_checks/);
  assert.match(ui, /Physical kg stock check/);
});

test('v2.23.2 manager and attendant dashboards expose role-relevant operational metrics', () => {
  const ui = read('hysmart station_frontend/src/pages/OverviewPage.jsx');
  assert.match(ui, /Pending meter readings/);
  assert.match(ui, /Open cashier shifts/);
  assert.match(ui, /Awaiting reconciliation/);
  assert.match(ui, /My attendance/);
  assert.match(ui, /My collections/);
  assert.match(ui, /operations\/meter-approvals/);
});
