import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
test('v2.24.1 restores Africa/Lagos dashboard boundaries in both current and forward migrations', () => {
  const migration42 = read('supabase/migrations/0042_equal_owner_director_permissions.sql');
  const migration43 = read('supabase/migrations/0043_restore_lagos_dashboard_boundaries.sql');
  for (const sql of [migration42, migration43]) {
    assert.match(sql, /date_trunc\('day', now\(\) at time zone 'Africa\/Lagos'\) at time zone 'Africa\/Lagos'/);
    assert.match(sql, /role in \('COMPANY_OWNER', 'COMPANY_ADMIN'\)/);
    assert.match(sql, /grant execute on function public\.get_company_dashboard_summary\(uuid\) to service_role/i);
  }
});
test('v2.24.1 validates and normalizes statement cursor timestamps before PostgREST filtering', () => {
  const route = read('src/routes/operations.js');
  assert.match(route, /T\\d\{2\}:\\d\{2\}:\\d\{2\}/);
  assert.match(route, /validCursorTimestamp\(cursor\.date\)/);
  assert.match(route, /timestampMicros\(y\.date\)-timestampMicros\(x\.date\)/);
  assert.match(route, /JSON\.stringify\(\{date:last\.date,id:last\.id\}\)/);
  assert.doesNotMatch(route, /new Date\(last\.date\)\.toISOString\(\)/);
});
test('v2.24.1 runtime and health version fallbacks are aligned', () => {
  assert.match(read('src/config/env.js'), /version: env\.APP_VERSION \|\| '2\.25\.8'/);
  assert.match(read('src/routes/health.js'), /config\.version \|\| '2\.25\.8'/);
});

test('v2.24.1 repairs invitation RPC back to email-bound invites after migration 0042', () => {
  for (const path of ['supabase/migrations/0042_equal_owner_director_permissions.sql','supabase/migrations/0043_restore_lagos_dashboard_boundaries.sql']) {
    const sql = read(path);
    assert.match(sql, /p_email text/);
    assert.match(sql, /lower\(trim\(p_email\)\)/);
    assert.match(sql, /insert into public\.station_invitations\(station_id,email,phone,role,token_hash,invited_by\)/);
    assert.doesNotMatch(sql, /p_phone text/);
  }
});
test('v2.24.1 branch creation fails closed when the subscription period end is null', () => {
  for (const path of ['supabase/migrations/0042_equal_owner_director_permissions.sql','supabase/migrations/0043_restore_lagos_dashboard_boundaries.sql']) {
    const sql = read(path);
    assert.match(sql, /v_sub\.current_period_end is null or v_sub\.current_period_end <= now\(\)/);
  }
});
