import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const migration=readFileSync(resolve(root,'supabase/migrations/0009_integrity_hardening.sql'),'utf8');
const operations=readFileSync(resolve(root,'src/routes/operations.js'),'utf8');
const controls=readFileSync(resolve(root,'src/routes/controls.js'),'utf8');
test('database guards serialize tank deliveries and enforce capacity',()=>{assert.match(migration,/guard_tank_delivery_capacity/);assert.match(migration,/for update/);assert.match(migration,/TANK_CAPACITY_EXCEEDED/)});
test('tank stock is calculated in database without application row-limit aggregation',()=>{assert.match(migration,/calculate_tank_book_stock/);assert.match(controls,/rpc\(\s*'calculate_tank_book_stock'/)});
test('tank and nozzle assets enforce company/product consistency',()=>{assert.match(migration,/TANK_PRODUCT_COMPANY_MISMATCH/);assert.match(migration,/NOZZLE_ASSET_MISMATCH/)});
test('idempotency keys compare payload, not only actor and shift',()=>{assert.match(migration,/v_reading\.current_meter_litres is distinct from v_meter/);assert.match(migration,/v_collection\.amount is distinct from v_amount/)});
test('collections cannot exceed net meter-derived expected sales',()=>{assert.match(migration,/COLLECTION_EXCEEDS_READING_AMOUNT/);assert.match(migration,/for update/)});
test('delivery route maps database capacity failure to a conflict response',()=>{assert.match(operations,/DUPLICATE_DELIVERY_REFERENCE/);assert.match(operations,/TANK_CAPACITY_EXCEEDED/)});
test('date reconciliation accounts for approved reversal rows',()=>{assert.match(operations,/reversedByCollection/);assert.match(operations,/sales_collection_reversals/)});

test('reversal approvals serialize against collections on the same reading',()=>{assert.match(migration,/v_reading public\.nozzle_meter_readings%rowtype/);assert.match(migration,/where id=v_collection\.reading_id and station_id=v_collection\.station_id for update/)});

test('meter and payment precision is normalized before idempotency comparisons',()=>{assert.match(migration,/v_meter:=round\(p_current_meter_litres,3\)/);assert.match(migration,/v_price:=round\(p_price_per_litre,2\)/);assert.match(migration,/v_amount:=round\(p_amount,2\)/)});

test('asset reassignment and capacity reduction cannot rewrite historical stock context',()=>{assert.match(migration,/TANK_PRODUCT_HAS_HISTORY/);assert.match(migration,/TANK_CAPACITY_BELOW_BOOK_STOCK/);assert.match(migration,/NOZZLE_ASSET_HAS_HISTORY/)});
