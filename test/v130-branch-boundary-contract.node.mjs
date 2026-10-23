import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const read=(p)=>readFileSync(resolve(here,p),'utf8');
test('station listing gives company-wide branches to active owner/director and assigned branches to station staff',()=>{
 const source=read('../src/routes/stations.js');
 assert.match(source,/\.in\('role',\['COMPANY_OWNER','COMPANY_ADMIN'\]\)/);
 assert.match(source,/from\('station_members'\)/);
 assert.match(source,/\.eq\('status','active'\)/);
});
test('manager and attendant operations require active membership for the requested station',()=>{
 const operations=read('../src/routes/operations.js');
 const attendance=read('../src/routes/attendance.js');
 assert.match(operations,/\.eq\('station_id',stationId\)[\s\S]*?\.eq\('user_id',req\.user\.id\)/);
 assert.match(attendance,/\.eq\('station_id',stationId\)[\s\S]*?\.eq\('user_id',req\.user\.id\)/);
});
test('effective email invitation RPC allows owner/director to invite managers and managers to invite attendants only',()=>{
 const sql=read('../supabase/migrations/0035_email_based_station_invitations.sql');
 assert.match(sql,/role in \('COMPANY_OWNER','COMPANY_ADMIN'\)/);
 assert.match(sql,/p_role='STATION_MANAGER' and not v_owner/);
 assert.match(sql,/p_role='ATTENDANT' and not \(v_owner or v_manager\)/);
});
test('owner/director may remove managers, assigned managers may remove attendants, and self-removal is blocked',()=>{
 const sql=read('../supabase/migrations/0036_atomic_station_member_removal.sql');
 const source=read('../src/routes/team.js');
 assert.match(sql,/v_target\.role = 'STATION_MANAGER' and not v_is_leader/);
 assert.match(sql,/v_target\.role = 'ATTENDANT' and not \(v_is_leader or v_is_manager\)/);
 assert.match(source,/SELF_REMOVAL_NOT_ALLOWED/);
});
