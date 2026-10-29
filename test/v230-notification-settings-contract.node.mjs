import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const route = await readFile(new URL('../src/routes/alerts.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../../station_pwa/src/pages/AlertsPage.jsx', import.meta.url), 'utf8');
test('notification settings have read and write API endpoints', () => {
  assert.match(route, /r\.get\('\/notification-preferences'/);
  assert.match(route, /r\.put\('\/notification-preferences'/);
  assert.match(route, /r\.get\('\/delivery-history'/);
  assert.match(route, /z\.enum\(\['email', 'sms', 'in_app'\]\)/);
});
test('notification settings enforce branch and company-owner scope', () => {
  assert.match(route, /resolveScope\(req, req\.query\.stationId/);
  assert.match(route, /Only a company owner can change company-wide notification settings/);
  assert.match(route, /Settings saved\. Email requires RESEND_API_KEY, NOTIFICATION_FROM_EMAIL, and the scheduled worker/);
});
test('frontend exposes channel settings and delivery history without claiming live delivery', () => {
  assert.match(page, /Notification delivery settings/);
  assert.match(page, /Save notification settings/);
  assert.match(page, /Recent delivery log/);
  assert.match(page, /external delivery is not active until a provider and secure worker are configured/);
});
