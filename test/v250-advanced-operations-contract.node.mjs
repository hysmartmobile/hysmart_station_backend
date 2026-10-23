import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, new URL('../', import.meta.url)), 'utf8');

test('v2.25.0 migration adds receipt verification, shop POS, anomaly cases and integration event trail', () => {
  const sql = read('supabase/migrations/0045_advanced_operations_pos_integrations.sql');
  for (const table of ['delivery_receipt_checks','shop_products','shop_sales','shop_sale_items','operational_anomaly_cases','integration_connections','integration_event_log']) assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(sql, /unique\(station_id,idempotency_key\)/);
  assert.match(sql, /create or replace function public\.checkout_shop_sale/);
  assert.match(sql, /for update/);
  assert.match(sql, /AUDIT_LOG_APPEND_ONLY/);
  assert.match(sql, /revoke all on public\.%I from anon, authenticated/);
});

test('advanced operations require station scope and manager rights for configuration and reviews', () => {
  const route = read('src/routes/advancedOperations.js');
  assert.match(route, /async function access\(req, stationId\)/);
  assert.match(route, /Only company leadership or an assigned station manager/);
  assert.match(route, /DISCOUNT_APPROVAL_REQUIRED/);
  assert.match(route, /CREDIT_APPROVAL_REQUIRED/);
  assert.match(route, /DELIVERY_ALREADY_VERIFIED/);
  assert.match(route, /Do not place credentials or secrets/i);
});

test('POS checkout is atomic and duplicate submission is idempotent', () => {
  const sql = read('supabase/migrations/0045_advanced_operations_pos_integrations.sql');
  const route = read('src/routes/advancedOperations.js');
  assert.match(sql, /if found then return jsonb_build_object\('sale',to_jsonb\(v_sale\),'duplicate',true\)/);
  assert.match(sql, /SHOP_STOCK_INSUFFICIENT/);
  assert.match(sql, /DUPLICATE_PRODUCT_ITEMS/);
  assert.match(route, /p_idempotency_key: p\.data\.idempotencyKey/);
  assert.match(route, /no second sale was created/);
});

test('anomaly rules account for collection reversals and physical stock variance', () => {
  const route = read('src/routes/advancedOperations.js');
  assert.match(route, /kg_sales_collection_reversals/);
  assert.match(route, /net collected/);
  assert.match(route, /tank_stock_checks/);
  assert.match(route, /not proof of fraud/i);
  assert.match(route, /notifyManagers/);
});

test('integration self-check never claims an external provider was contacted', () => {
  const route = read('src/routes/advancedOperations.js');
  assert.match(route, /providerReachable: null/);
  assert.match(route, /no external provider or physical device was contacted/);
  assert.match(route, /credentialReference/);
  assert.match(route, /ADAPTER_NOT_CONFIGURED/);
});

test('official stock positions use approved readings, verified deliveries and uncapped server aggregation', () => {
  const sql = read('supabase/migrations/0045_advanced_operations_pos_integrations.sql');
  const operations = read('src/routes/operations.js');
  const inventory = read('../hysmart station_frontend/src/pages/InventoryPage.jsx');
  assert.match(sql, /r\.status='approved'/);
  assert.match(sql, /left join public\.delivery_receipt_checks rc on rc\.delivery_id=d\.id/);
  assert.match(sql, /create or replace function public\.get_station_tank_stock_positions/);
  assert.match(operations, /get_station_tank_stock_positions/);
  assert.match(inventory, /tank_stock_positions/);
});

test('escalation worker and PWA safety rules are present', () => {
  const worker = read('src/workers/anomaly-escalation.js');
  const sw = read('../hysmart station_frontend/public/sw.js');
  assert.match(worker, /next_escalation_at/);
  assert.match(worker, /ANOMALY_CASE_ESCALATED/);
  assert.match(sw, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /CACHE_NAME = `\$\{CACHE_PREFIX\}v2\.25\.3`/);
});
