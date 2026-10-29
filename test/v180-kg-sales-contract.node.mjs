import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const migration=readFileSync(new URL('supabase/migrations/0016_complete_kg_sales_workflow.sql',root),'utf8');
const routes=readFileSync(new URL('src/routes/operations.js',root),'utf8');
const sales=readFileSync(new URL('../../station_pwa/src/pages/SalesPage.jsx',import.meta.url),'utf8');
test('kg sales ledger stores kg quantities separately with generated sales and amount',()=>{
 assert.match(migration,/create table if not exists public\.kg_nozzle_meter_readings/);
 assert.match(migration,/kg_sold numeric\(16,3\) generated always as \(current_meter_kg-previous_meter_kg\)/);
 assert.match(migration,/expected_amount numeric\(16,2\) generated always as \(\(current_meter_kg-previous_meter_kg\)\*price_per_kg\)/);
});
test('kg sales endpoints require assigned branch and open cashier shift RPCs',()=>{
 assert.match(routes,/r\.post\('\/kg-meter-readings'/);
 assert.match(routes,/record_shift_kg_meter_reading/);
 assert.match(routes,/r\.post\('\/kg-collections'/);
 assert.match(routes,/record_kg_sales_collection/);
 assert.match(routes,/r\.post\('\/kg-stock-checks'/);
 assert.match(routes,/record_kg_tank_stock_check/);
});
test('kg readings and collections are included in shift close and company owner totals',()=>{
 assert.match(migration,/kg_sales_collections where cash_shift_id=v_shift\.id and payment_method='cash'/);
 assert.match(migration,/kg_nozzle_meter_readings where cash_shift_id=p_shift_id/);
 assert.match(migration,/'kgSalesAllTime'/);
 assert.match(migration,/'kgCollectionsAllTime'/);
 assert.match(migration,/v_reading\.current_meter_kg<>round\(p_current_meter_kg,3\)/);
 assert.match(migration,/v_collection\.amount<>round\(p_amount,2\)/);
 assert.match(migration,/v_book:=coalesce\(v_opening,0\)\+v_prior_deliveries-v_kg_sold/);
});
test('sales screen offers separate kg reading, collection and stock-check workflows',()=>{
 assert.match(sales,/\/operations\/kg-meter-readings/);
 assert.match(sales,/\/operations\/kg-collections/);
 assert.match(sales,/\/operations\/kg-stock-checks/);
 assert.match(sales,/Kilogram \/ LPG sales ledger/);
});
