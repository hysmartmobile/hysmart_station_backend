import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const frontend=await readFile(path.resolve(here,'../../hysmart station_frontend/src/pages/AccountabilityPage.jsx'),'utf8');
const backend=await readFile(path.resolve(here,'../src/routes/accountability.js'),'utf8');
test('accountability frontend normalizes every collection before filtering',()=>{
 for(const key of ['stations','staff','companyLeaders','transactions']) {
  assert.ok(frontend.includes(`${key}:Array.isArray(payload.${key})?payload.${key}:[]`), `missing normalization for ${key}`);
 }
});
test('empty accountability response returns every collection and safe flags',()=>{
 for(const fragment of ['stations:[],staff:[],companyLeaders:[],transactions:[],truncated:false','isAttendant:false','canResolve:!!leaderQ.data']) assert.ok(backend.includes(fragment), `missing response field: ${fragment}`);
});
