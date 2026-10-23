import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=rel=>readFile(path.join(root,rel),'utf8');
test('support routes validate ticket input, keep tickets scoped, and support representative status workflow',async()=>{
 const route=await read('src/routes/support.js');
 for(const token of ["r.get('/faqs'","r.get('/tickets'","r.post('/tickets'","r.get('/tickets/:id/messages'","r.post('/tickets/:id/messages'","r.patch('/tickets/:id/status'",'COMPANY_SCOPE_DENIED','REPRESENTATIVE_REQUIRED','SUPPORT_TICKET_CREATED','SUPPORT_TICKET_STATUS_CHANGED']) assert.ok(route.includes(token),`missing ${token}`);
 assert.match(route,/subject: z\.string\(\)\.trim\(\)\.min\(4\)\.max\(160\)/);
 assert.match(route,/message: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(5000\)/);
});
test('support migration has RLS policies, indexes, seed FAQs and explicit representative authorization',async()=>{
 const sql=await read('supabase/migrations/0047_custom_support_tickets_faq.sql');
 for(const token of ['create table if not exists public.support_tickets','create table if not exists public.support_ticket_messages','create table if not exists public.support_faqs','enable row level security','support_tickets_customer_create','support_ticket_messages_create','support_representatives','on conflict (question) do update','How do I set up my company and first station?']) assert.ok(sql.toLowerCase().includes(token.toLowerCase()),`missing ${token}`);
 assert.match(sql,/created_by = auth\.uid\(\)/);
});
test('support centre is routed and included in role-aware navigation',async()=>{
 const app=await read('../hysmart station_frontend/src/App.jsx');
 const layout=await read('../hysmart station_frontend/src/layouts/AppLayout.jsx');
 const page=await read('../hysmart station_frontend/src/pages/SupportPage.jsx');
 assert.ok(app.includes("path=\"support\" element={<SupportPage />}"));
 assert.ok(layout.includes("['/support', 'Support & FAQs', LifeBuoy]"));
 for(const token of ['Search setup, billing, sales, inventory','Submit ticket','My tickets','Send reply']) assert.ok(page.includes(token),`missing UI text ${token}`);
});
