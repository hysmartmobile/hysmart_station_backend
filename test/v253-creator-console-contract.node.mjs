import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=rel=>readFile(path.join(root,rel),'utf8');
test('creator console is protected by database-managed creator admin records and exposes monitored platform metrics',async()=>{
 const route=await read('src/routes/creatorAdmin.js');
 for(const token of ["r.use(async(req,res,next)","isActiveCreatorAdmin(req.supabase,req.user.id)","CREATOR_ACCESS_DENIED","r.get('/dashboard'","totalRevenueNaira","last30DaysRevenueNaira","activeSubscriptions","revenueByMonth","averageSatisfaction","r.get('/tickets/:id'","r.post('/tickets/:id/reply'","r.patch('/tickets/:id/status'","r.post('/tickets/:id/notify'","notification_inbox","CREATOR_SUPPORT_REPLIED"]) assert.ok(route.includes(token),`missing ${token}`);
 assert.match(route,/status==='paid'/);
 const access=await read('src/services/creatorAccess.js'); assert.match(access,/from\('creator_admins'\)/); assert.match(access,/eq\('active', true\)/);
 const migration=await read('supabase/migrations/0049_database_managed_creator_admins.sql'); assert.match(migration,/create table if not exists public\.creator_admins/i); assert.match(migration,/enable row level security/i); assert.match(migration,/revoke all on table public\.creator_admins from anon, authenticated/i);
});
test('creator console route is mounted behind normal authentication and frontend provides dashboard route',async()=>{
 const app=await read('src/app.js'); const frontend=await read('../station_pwa/src/App.jsx'); const page=await read('../station_pwa/src/pages/CreatorDashboardPage.jsx');
 assert.ok(app.includes("app.use('/api', authMiddleware(supabase))")); assert.ok(app.includes("app.use('/api/creator', creatorAdminRoutes(config))")); assert.ok(frontend.includes('CreatorDashboardPage')); assert.ok(frontend.includes('path="/creator"')); for(const token of ['Subscription payment flow','Customer complaints & requests','Reply to customer','Notify customer','Customer satisfaction'])assert.ok(page.includes(token),`missing ${token}`);
});
test('migration supports customer satisfaction ratings with range and comment constraints',async()=>{
 const sql=await read('supabase/migrations/0048_creator_console_satisfaction.sql');
 assert.match(sql,/add column if not exists satisfaction_rating smallint/i); assert.match(sql,/satisfaction_rating between 1 and 5/i); assert.match(sql,/length\(satisfaction_comment\) <= 1000/i);
 const support=await read('src/routes/support.js'); assert.ok(support.includes("r.post('/tickets/:id/satisfaction'")); assert.ok(support.includes('TICKET_NOT_RESOLVED'));
});
