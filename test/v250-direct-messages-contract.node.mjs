import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
test('v2.5.0 direct messages are saved to the recipient notification inbox', () => {
  const route = read('../src/routes/messages.js');
  const migration = read('../supabase/migrations/0021_direct_staff_messages.sql');
  assert.match(route, /from\('notification_inbox'\)\.insert\(rows\)/);
  assert.match(route, /notification_type: 'direct_message'/);
  assert.match(route, /From \$\{req\.user\.user_metadata/);
  assert.match(migration, /sender_user_id/);
  assert.match(migration, /message_type/);
});
test('v2.5.0 checks recipient membership and branch scope on the server', () => {
  const route = read('../src/routes/messages.js');
  assert.match(route, /role === 'STATION_MANAGER'/);
  assert.match(route, /stationId && !scope\.stations\.some/);
  assert.match(route, /RECIPIENT_OUT_OF_SCOPE/);
  assert.match(route, /Only a company owner, director, or assigned branch manager/);
});
test('v2.5.0 exposes staff messaging in the frontend', () => {
  const app = read('../../hysmart station_frontend/src/App.jsx');
  const layout = read('../../hysmart station_frontend/src/layouts/AppLayout.jsx');
  const page = read('../../hysmart station_frontend/src/pages/MessagesPage.jsx');
  assert.match(app, /path="messages" element=\{<MessagesPage \/>\}/);
  assert.match(layout, /Staff messages/);
  assert.match(page, /\/messages/);
  assert.match(page, /notification centre/);
});
