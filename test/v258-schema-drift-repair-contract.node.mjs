import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('v2.25.8 repairs missing notification delivery type without dropping existing rows', () => {
  const sql = read('supabase/migrations/0050_repair_legacy_notification_and_shift_columns.sql');
  assert.match(sql, /alter table public\.notification_delivery_log\s+add column if not exists notification_type text/i);
  assert.match(sql, /update public\.notification_delivery_log[\s\S]*?where notification_type is null/i);
  assert.match(sql, /alter column notification_type set not null/i);
  assert.match(sql, /metadata ->> 'notification_type'/i);
});

test('v2.25.8 repairs missing shift opening submission timestamp and its index', () => {
  const sql = read('supabase/migrations/0050_repair_legacy_notification_and_shift_columns.sql');
  assert.match(sql, /alter table public\.shift_meter_openings\s+add column if not exists submitted_at timestamptz/i);
  assert.match(sql, /update public\.shift_meter_openings\s+set submitted_at = now\(\)\s+where submitted_at is null/i);
  assert.match(sql, /alter column submitted_at set not null/i);
  assert.match(sql, /create index if not exists shift_openings_station_status_idx/i);
  assert.match(sql, /begin;[\s\S]*commit;/i);
});

test('runtime version is aligned to the schema drift repair release', () => {
  assert.equal(read('../VERSION').trim(), '2.25.9');
  assert.match(read('package.json'), /"version": "2\.25\.9"/);
});
