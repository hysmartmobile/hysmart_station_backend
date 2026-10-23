import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(resolve(here, p), 'utf8');

test('v2.23.3 member removal is atomic and writes an audit event in the same transaction', () => {
  const sql = read('../supabase/migrations/0036_atomic_station_member_removal.sql');
  assert.match(sql, /create or replace function public\.remove_station_member/);
  assert.match(sql, /for update/);
  assert.match(sql, /insert into public\.audit_events/);
  assert.match(sql, /grant execute on function public\.remove_station_member\(uuid, uuid, uuid\) to service_role/);
});

test('v2.23.3 company owner and director can remove managers; assigned managers cannot remove managers', () => {
  const sql = read('../supabase/migrations/0036_atomic_station_member_removal.sql');
  assert.match(sql, /'COMPANY_OWNER', 'COMPANY_ADMIN'/);
  assert.match(sql, /v_target\.role = 'STATION_MANAGER' and not v_is_leader/);
  assert.match(sql, /v_target\.role = 'ATTENDANT' and not \(v_is_leader or v_is_manager\)/);
  assert.match(sql, /coalesce\([\s\S]*?v_company_status = 'active'/);
});

test('v2.23.3 API uses the atomic database operation and prevents self-removal', () => {
  const source = read('../src/routes/team.js');
  assert.match(source, /rpc\('remove_station_member'/);
  assert.match(source, /targetUserId===req\.user\.id/);
  assert.match(source, /SELF_REMOVAL_NOT_ALLOWED/);
});

test('v2.23.3 company financial reports consistently filter litre and kg meter readings to approved status', () => {
  const source = read('../src/routes/companies.js');
  assert.match(source, /'litreSales',[\s\S]*?true/);
  assert.match(source, /'kgSales',[\s\S]*?true/);
  assert.match(source, /q = q\.eq\('status', 'approved'\)/);
  assert.doesNotMatch(source, /LPG meter readings do not have a status column/);
});
