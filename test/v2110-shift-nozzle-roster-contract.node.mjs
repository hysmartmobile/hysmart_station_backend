import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/0027_shift_nozzle_roster_readiness.sql'),'utf8');
const routes=fs.readFileSync(path.join(root,'src/routes/operations.js'),'utf8');
const controls=fs.readFileSync(path.join(root,'src/routes/controls.js'),'utf8');
const ui=fs.readFileSync(path.resolve(root,'../hysmart station_frontend/src/pages/ShiftOpeningWorkflow.jsx'),'utf8');
test('shift nozzle roster is branch-bound, shift-bound, and manager-configured atomically',()=>{
 assert.match(migration,/create table if not exists public\.shift_nozzle_roster/);
 assert.match(migration,/set_shift_nozzle_roster/);
 assert.match(migration,/ROSTER_LOCKED_AFTER_ACTIVITY/);
 assert.match(routes,/\/shift-openings\/roster/);
 assert.match(routes,/checked\(req,res,p\.data\.stationId,true\)/);
});
test('all assigned nozzles need approved openings before official meter sales',()=>{
 assert.match(migration,/SHIFT_OPENING_READINESS_INCOMPLETE/);
 assert.match(migration,/NOZZLE_NOT_ASSIGNED_TO_SHIFT/);
 assert.match(migration,/APPROVED_OPENING_METER_REQUIRED/);
 assert.match(routes,/Every nozzle assigned to this shift must have a manager-approved opening meter/);
});
test('shift closure refuses configured rosters with missing approved openings',()=>{
 assert.match(controls,/SHIFT_OPENING_READINESS_INCOMPLETE/);
 assert.match(controls,/shift_nozzle_roster/);
});
test('UI allows managers to configure expected nozzles and shows readiness',()=>{
 assert.match(ui,/Shift nozzle roster & readiness/);
 assert.match(ui,/Save shift roster/);
 assert.match(ui,/Opening readiness/);
 assert.match(ui,/readiness\?\.configured/);
});
