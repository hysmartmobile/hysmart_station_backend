import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
test('v2.7.0 adds grouped read receipt identifiers and server-only access', () => {
  const migration = read('../supabase/migrations/0023_direct_message_read_receipts.sql');
  assert.match(migration, /add column if not exists message_group_id uuid/);
  assert.match(migration, /revoke all on public\.notification_inbox from anon, authenticated/);
  const route = read('../src/routes/messages.js');
  assert.match(route, /messageGroupId = crypto\.randomUUID\(\)/);
  assert.match(route, /r\.get\('\/sent'/);
  assert.match(route, /eq\('sender_user_id', req\.user\.id\)/);
  assert.match(route, /readCount/);
  assert.match(route, /unreadCount/);
  assert.match(route, /query\.in\('station_id', scope\.stations\.map/);
});
test('v2.7.0 frontend displays sent-message read receipts', () => {
  const page = read('../../hysmart station_frontend/src/pages/MessagesPage.jsx');
  assert.match(page, /Message read receipts/);
  assert.match(page, /apiRequest\('\/messages\/sent'/);
  assert.match(page, /Not read yet/);
  assert.match(page, /readCount/);
});
