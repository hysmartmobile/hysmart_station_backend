import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFile(resolve(root,p),'utf8');
test('v2.23.8 company owner and director share branch, billing, workspace and invitation permissions',async()=>{
 const me=await read('src/routes/me.js'); const stations=await read('src/routes/stations.js'); const billing=await read('src/routes/billing.js'); const worker=await read('src/workers/notification-delivery.js');
 assert.match(me,/in\('role',\['COMPANY_OWNER','COMPANY_ADMIN'\]\)/);
 assert.match(stations,/in\('role',\['COMPANY_OWNER','COMPANY_ADMIN'\]\)/);
 assert.match(billing,/in\('role', \['COMPANY_OWNER', 'COMPANY_ADMIN'\]\)/);
 assert.match(worker,/in\('role', \['COMPANY_OWNER', 'COMPANY_ADMIN'\]\)/);
});
test('v2.23.8 migration grants both company roles the same branch and manager-invitation RPC permissions',async()=>{
 const sql=await read('supabase/migrations/0042_equal_owner_director_permissions.sql');
 assert.match(sql,/role in \('COMPANY_OWNER','COMPANY_ADMIN'\)/g);
 assert.match(sql,/create or replace function public\.create_station_for_owner/);
 assert.match(sql,/create or replace function public\.create_station_invitation/);
});
test('v2.23.8 frontend exposes branch creation to owner and director roles',async()=>{
 const page=await read('../station_pwa/src/pages/StationsPage.jsx');
 assert.match(page,/setCanCreateBranch\(!!data\.companies\?\.some\(c => \['COMPANY_OWNER','COMPANY_ADMIN'\]\.includes\(c\.role\)\)\)/);
});
