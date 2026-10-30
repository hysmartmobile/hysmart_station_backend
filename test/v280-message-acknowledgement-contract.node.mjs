import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
test('v2.8.0 adds optional acknowledgement storage with server-mediated access', () => {
  const migration = read('../supabase/migrations/0024_direct_message_acknowledgements.sql');
  assert.match(migration, /requires_acknowledgement boolean not null default false/);
  assert.match(migration, /acknowledged_at timestamptz/);
  assert.match(migration, /revoke all on public\.notification_inbox from anon, authenticated/);
  const route = read('../src/routes/messages.js');
  assert.match(route, /requiresAcknowledgement: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(route, /acknowledgedCount/);
  const notifications = read('../src/routes/notifications.js');
  assert.match(notifications, /r\.post\('\/inbox\/:id\/acknowledge'/);
  assert.match(notifications, /eq\('user_id', req\.user\.id\)/);
  assert.match(notifications, /eq\('requires_acknowledgement', true\)/);
});
test('v2.8.0 UI supports requesting and completing acknowledgements', () => {
  const page = read('../../station_pwa/src/pages/MessagesPage.jsx');
  assert.match(page, /Require staff acknowledgement/);
  assert.match(page, /acknowledgedCount/);
  const layout = read('../../station_pwa/src/layouts/AppLayout.jsx');
  assert.match(layout, /Acknowledge instruction/);
  assert.match(layout, /notifications\/inbox\/\$\{item\.id\}\/acknowledge/);
});
