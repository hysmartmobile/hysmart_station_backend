import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const migration=readFileSync(new URL('../supabase/migrations/0014_physical_stock_reconciliation.sql',import.meta.url),'utf8');
const operations=readFileSync(new URL('../src/routes/operations.js',import.meta.url),'utf8');
test('physical stock checks store measured stock and a generated variance',()=>{
 assert.match(migration,/create table if not exists public\.tank_stock_checks/);
 assert.match(migration,/variance_litres numeric\(14,2\) generated always as \(measured_stock_litres-book_stock_litres\)/);
 assert.match(migration,/record_tank_stock_check/);
 assert.match(migration,/sum\(d\.quantity_litres\)/);
 assert.match(migration,/sum\(r\.litres_sold\)/);
});
test('stock check API requires manager or owner and uses database-calculated book stock',()=>{
 assert.match(operations,/r\.post\('\/stock-checks'/);
 assert.match(operations,/checked\(req,res,p\.data\.stationId,true\)/);
 assert.match(operations,/rpc\('record_tank_stock_check'/);
 assert.match(operations,/PHYSICAL_STOCK_CHECK_RECORDED/);
});
test('operations listing includes branch-scoped physical stock checks',()=>{
 assert.match(operations,/\.eq\('station_id',sid\)/);
 assert.match(operations,/'tank_stock_checks'/);
});
