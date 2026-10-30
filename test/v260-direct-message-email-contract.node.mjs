import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
test('v2.6.0 direct message email is opt-in and defaults off', () => {
  const migration = read('../supabase/migrations/0022_direct_message_email_preferences.sql');
  const route = read('../src/routes/notifications.js');
  assert.match(migration, /direct_message_email_enabled boolean not null default false/);
  assert.match(migration, /revoke all on public\.notification_user_preferences from anon, authenticated/);
  assert.match(route, /get\('\/direct-message-email-preference'/);
  assert.match(route, /put\('\/direct-message-email-preference'/);
  assert.match(route, /typeof req\.body\?\.enabled !== 'boolean'/);
});
test('v2.6.0 opted-in direct message recipients receive queued email copies without blocking inbox delivery', () => {
  const route = read('../src/routes/messages.js');
  assert.match(route, /notification_user_preferences/);
  assert.match(route, /direct_message_email_enabled', true/);
  assert.match(route, /auth\.admin\.getUserById/);
  assert.match(route, /notification_type: 'direct_message'/);
  assert.match(route, /channel: 'email'/);
  assert.match(route, /status: 'queued'/);
  assert.match(route, /Email is best-effort; never block the in-app message/);
  assert.match(route, /emailJobsQueued/);
});
test('v2.6.0 exposes an explicit email-copy preference in staff messaging UI', () => {
  const layout = read('../../station_pwa/src/layouts/AppLayout.jsx');
  assert.match(layout, /Email copies of staff messages/);
  assert.match(layout, /direct-message-email-preference/);
  assert.match(layout, /messages always appear here/);
});
