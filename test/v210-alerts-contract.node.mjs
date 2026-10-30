import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const route = await readFile(new URL('../src/routes/alerts.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../../station_pwa/src/pages/AlertsPage.jsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../../station_pwa/src/layouts/AppLayout.jsx', import.meta.url), 'utf8');
test('alerts require company owner for company-wide scope', () => {
  assert.match(route, /ownerMembership\(req\)/);
  assert.match(route, /Company owner or director access is required for company-wide management alerts/);
});
test('branch alert scope checks company owner or assigned manager', () => {
  assert.match(route, /sm\?\.role === 'STATION_MANAGER'/);
  assert.match(route, /if \(!owner && !manager\)/);
});
test('alerts cover overdue attendance, cash variances, stock discrepancies, pending approvals and collection gaps', () => {
  for (const code of ['overdue_attendance','cash_variance','litre_stock_variance','kg_stock_variance','pending_litre_adjustment','pending_kg_adjustment','collection_gap']) assert.ok(route.includes(code), `missing ${code}`);
});
test('alerts are mounted behind subscription access and displayed in the frontend', () => {
  assert.match(app, /app\.use\('\/api\/alerts', subscriptionAccess\(supabase\), alertRoutes\(\)\)/);
  assert.match(page, /Prioritized action list/);
  assert.match(layout, /\['\/alerts', 'Operational alerts'/);
});
test('sales-to-collection alert explicitly explains its limitations', () => {
  assert.match(route, /do not account for payment timing or every reversal scenario/);
});
