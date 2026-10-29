import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const sql=readFileSync(join(root,'supabase/migrations/0025_mandatory_meter_approval.sql'),'utf8');
const routes=readFileSync(join(root,'src/routes/operations.js'),'utf8');
const ui=readFileSync(join(root,'..','station_pwa/src/pages/ControlsPage.jsx'),'utf8');
test('v2.9.0 stores review status for litre and kg meter readings and advances baselines only on approval',()=>{
 assert.match(sql,/nozzle_meter_readings add column if not exists status text not null default 'approved'/);
 assert.match(sql,/kg_nozzle_meter_readings add column if not exists status text not null default 'approved'/);
 assert.match(sql,/last_meter_litres=v\.current_meter_litres/);
 assert.match(sql,/last_meter_kg=v\.current_meter_kg/);
 assert.match(sql,/status='pending'/);
 assert.match(sql,/SELF_APPROVAL_NOT_ALLOWED/);
});
test('v2.9.0 prevents collections against unapproved readings and blocks another reading while pending',()=>{
 assert.match(sql,/v_reading\.status <> 'approved' then raise exception 'METER_APPROVAL_REQUIRED'/);
 assert.match(sql,/where nozzle_id=p_nozzle_id and status='pending'/);
 assert.match(routes,/METER_APPROVAL_REQUIRED/);
 assert.match(routes,/METER_APPROVAL_PENDING/);
});
test('v2.9.0 exposes branch-scoped manager review endpoints and controls approval UI',()=>{
 assert.match(routes,/r\.get\('\/meter-approvals'/);
 assert.match(routes,/r\.post\('\/meter-approvals\/review'/);
 assert.match(routes,/checked\(req,res,p\.data\.stationId,true\)/);
 assert.match(ui,/Meter reading approvals/);
 assert.match(ui,/readingId:m\.id,unit:m\._unit,approve:true/);
});
