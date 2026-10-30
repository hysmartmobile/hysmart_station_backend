import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const root = new URL('../', import.meta.url);

test('v2.4.0 adds persistent user-scoped inbox with read state and deduplication', () => {
  const migration = read('../supabase/migrations/0020_notification_inbox_and_email_queue.sql');
  const route = read('../src/routes/notifications.js');
  assert.match(migration, /create table if not exists public\.notification_inbox/i);
  assert.match(migration, /unique\(user_id, fingerprint\)/i);
  assert.match(route, /\.eq\('user_id', req\.user\.id\)/);
  assert.match(route, /\/inbox\/\:id\/read/);
  assert.match(route, /sync-management-alerts/);
});

test('v2.4.0 wires notification centre and secure Resend worker configuration', () => {
  const app = read('../src/app.js');
  const worker = read('../src/workers/notification-delivery.js');
  const layout = read('../../station_pwa/src/layouts/AppLayout.jsx');
  const env = read('../.env.example');
  assert.match(app, /app\.use\('\/api\/notifications'/);
  assert.match(worker, /api\.resend\.com\/emails/);
  assert.match(worker, /RESEND_API_KEY/);
  assert.match(layout, /notification-center-trigger/);
  assert.match(layout, /notification-count/);
  assert.match(env, /NOTIFICATION_FROM_EMAIL/);
  assert.ok(existsSync(new URL('../src/workers/notification-delivery.js', import.meta.url)));
});
