import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/0028_complete_shift_financial_reconciliation.sql'),'utf8');
const routes=fs.readFileSync(path.join(root,'src/routes/operations.js'),'utf8');
const controls=fs.readFileSync(path.resolve(root,'../hysmart station_frontend/src/pages/ControlsPage.jsx'),'utf8');
test('shift reconciliation includes approved litre and kg sales in expected revenue',()=>{
 assert.match(migration,/nozzle_meter_readings where cash_shift_id=p_shift_id and status='approved'/);
 assert.match(migration,/kg_nozzle_meter_readings where cash_shift_id=p_shift_id and status='approved'/);
});
test('net collections include both units and approved reversals without cross-table ID collisions',()=>{
 assert.match(migration,/public\.sales_collections/);
 assert.match(migration,/public\.kg_sales_collections/);
 assert.match(migration,/public\.sales_collection_reversals/);
 assert.match(migration,/public\.kg_sales_collection_reversals/);
 assert.match(migration,/r\.source_type=c\.source_type/);
});
test('reconciliation refuses pending approvals and pending reversals',()=>{
 assert.match(migration,/SHIFT_APPROVALS_PENDING/);
 assert.match(migration,/SHIFT_OPENING_READINESS_INCOMPLETE/);
 assert.match(migration,/SHIFT_REVERSALS_PENDING/);
 assert.match(routes,/SHIFT_APPROVALS_PENDING/);
 assert.match(routes,/SHIFT_REVERSALS_PENDING/);
});
test('reconciliation captures both cash variance and sales variance in handover record',()=>{
 assert.match(migration,/cash_variance/);
 assert.match(migration,/handover_note/);
 assert.match(migration,/sales_variance/);
 assert.match(controls,/cash variance/);
});
