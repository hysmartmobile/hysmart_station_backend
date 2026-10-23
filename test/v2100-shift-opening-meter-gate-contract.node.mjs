import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/0026_shift_opening_meter_gate.sql'),'utf8');
const routes=fs.readFileSync(path.join(root,'src/routes/operations.js'),'utf8');
const controls=fs.readFileSync(path.join(root,'src/routes/controls.js'),'utf8');
const ui=fs.readFileSync(path.resolve(root,'../hysmart station_frontend/src/pages/ShiftOpeningWorkflow.jsx'),'utf8');
test('shift opening meters persist with separate approval and audit fields',()=>{
 for(const token of ['shift_meter_openings','cash_shift_id','nozzle_id','unit_of_measure','opening_meter','submitted_by','reviewed_by','reviewed_at','review_note','submission_notes']) assert.ok(migration.includes(token),`missing ${token}`);
 assert.match(migration,/status in \('pending','approved','rejected'\)/);
 assert.match(migration,/SELF_APPROVAL_NOT_ALLOWED/);
});
test('closing meter submissions require an approved opening snapshot for the same shift/nozzle/unit',()=>{
 assert.match(migration,/APPROVED_OPENING_METER_REQUIRED/);
 assert.match(migration,/require_approved_opening_for_litre_closing/);
 assert.match(migration,/require_approved_opening_for_kg_closing/);
 assert.match(routes,/APPROVED_OPENING_METER_REQUIRED/);
});
test('branch-scoped endpoints and manager review are present',()=>{
 assert.match(routes,/\/shift-openings/);
 assert.match(routes,/checked\(req,res,p\.data\.stationId,true\)/);
 assert.match(routes,/SHIFT_OPENING_METER_APPROVED/);
 assert.match(controls,/METER_APPROVAL_PENDING/);
 assert.match(controls,/shift_meter_openings/);
});
test('controls screen exposes attendant opening submission and manager review queue',()=>{
 assert.match(ui,/Submit opening meter/);
 assert.match(ui,/Manager review queue/);
 assert.match(ui,/Approve/);
 assert.match(ui,/Reject/);
});
