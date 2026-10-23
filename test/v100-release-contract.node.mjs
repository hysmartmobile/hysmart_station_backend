import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root=new URL('../',import.meta.url);
const read=(p)=>readFileSync(new URL(p,root),'utf8');
test('health router is mounted so readiness route is reachable',()=>{const app=read('src/app.js');const health=read('src/routes/health.js');assert.match(app,/app\.use\('\/api\/health',\s*healthRoutes\(config,\s*supabase\)\)/);assert.match(health,/r\.get\('\/ready'/);assert.match(health,/config\.version/)});
test('production config requires explicit HTTPS frontend origins',()=>{const env=read('src/config/env.js');assert.match(env,/FRONTEND_ORIGIN must explicitly list/);assert.match(env,/Every production FRONTEND_ORIGIN must be a valid HTTPS URL/);assert.match(env,/localhost frontend origins are not allowed/)});
test('governance event and reversal responses are station/case scoped',()=>{const route=read('src/routes/governance.js');assert.match(route,/in\('dispute_id',caseIds\)/);assert.match(route,/requestIds/);assert.match(route,/reversalRequests:requestRows/)});
test('release package versions are aligned',()=>{const version=readFileSync(new URL('../VERSION',root),'utf8').trim();for(const p of ['../hysmart station_frontend/package.json','package.json']){const pkg=JSON.parse(readFileSync(new URL(p,root),'utf8'));assert.equal(pkg.version,version)}});
