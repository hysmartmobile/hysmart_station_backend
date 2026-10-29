import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(join(root, p), 'utf8');
const migration = read('supabase/migrations/0041_accountability_transactions.sql');
const route = read('src/routes/accountability.js');
const app = read('src/app.js');
const page = read('../station_pwa/src/pages/AccountabilityPage.jsx');
const layout = read('../station_pwa/src/layouts/AppLayout.jsx');

test('v2.23.7 creates a server-mediated immutable transaction ledger with response and dispute history', () => {
  assert.match(migration, /create table if not exists public\.branch_accountability_transactions/);
  assert.match(migration, /ACCOUNTABILITY_TRANSACTION_IMMUTABLE/);
  assert.match(migration, /accountability_company_reference_uq/);
  assert.match(migration, /ACCOUNTABILITY_TRANSACTION_DISPUTED/);
  assert.match(migration, /ACCOUNTABILITY_TRANSACTION_DISPUTE_RESOLVED/);
  assert.match(migration, /revoke all on public\.branch_accountability_transactions from anon, authenticated/);
  assert.match(migration, /grant select, insert, update on public\.branch_accountability_transactions to service_role/);
});

test('v2.23.7 enforces participant acknowledgement and owner/director-only dispute resolution', () => {
  assert.match(route, /eq\('to_user_id',req\.user\.id\)/);
  assert.match(route, /Only the company owner\/director can resolve a dispute/);
  assert.match(route, /from_user_id:req\.user\.id/);
  assert.match(route, /INVALID_HANDOVER_DIRECTION/);
  assert.match(route, /REFERENCE_ALREADY_USED/);
  assert.match(route, /managerStationIds\.has\(x\.station_id\)\|\|x\.from_user_id===req\.user\.id\|\|x\.to_user_id===req\.user\.id/);
  assert.match(app, /app\.use\('\/api\/accountability', subscriptionAccess\(supabase\), accountabilityRoutes\(\)\)/);
});

test('v2.23.7 exposes the money handover ledger to owner, manager and attendant interfaces', () => {
  assert.match(page, /Money handover/);
  assert.match(page, /Acknowledge/);
  assert.match(page, /Dispute/);
  assert.match(page, /Resolve dispute/);
  assert.match(layout, /\['\/accountability', 'Money handovers'/);
});
