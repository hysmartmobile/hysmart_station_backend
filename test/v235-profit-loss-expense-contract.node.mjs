import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'..');
const read=p=>readFileSync(resolve(root,p),'utf8');
test('v2.23.5 adds verified opening inventory cost and dual-control expense ledger',()=>{
 const sql=read('supabase/migrations/0038_cost_basis_and_operating_expenses.sql');
 assert.match(sql,/opening_stock_unit_cost/);
 assert.match(sql,/create table if not exists public\.operating_expenses/);
 assert.match(sql,/operating_expenses_no_self_approval/);
 assert.match(sql,/audit_operating_expense_change/);
 const timezone=read('supabase/migrations/0039_nigeria_business_day_reporting.sql');
 assert.match(timezone,/Africa\/Lagos/);
});
test('profit and loss only uses approved meter readings and approved expenses',()=>{
 const route=read('src/routes/companies.js');
 assert.match(route,/get\('\/profit-loss-report'/);
 assert.match(route,/eq\('status','approved'\)/);
 assert.match(route,/costCoverageComplete/);
 assert.match(route,/SELF_APPROVAL_NOT_ALLOWED/);
 assert.match(route,/moving weighted-average inventory cost/);
});
test('reports UI exposes daily weekly monthly yearly periods and labels profit coverage honestly',()=>{
 const page=read('../station_pwa/src/pages/ReportsPage.jsx');
 for(const label of ['Today','This week','This month','This year','Trading profit & loss','Missing opening cost','Trading loss alert','Gross trading loss alert']) assert.ok(page.includes(label),`missing ${label}`);
});
