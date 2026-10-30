import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(resolve(here, p), 'utf8');
test('company director role is consistently authorized for company reports and operational management', () => {
  const companies = read('../src/routes/companies.js');
  const operations = read('../src/routes/operations.js');
  const controls = read('../src/routes/controls.js');
  const governance = read('../src/routes/governance.js');
  const migration = read('../supabase/migrations/0037_company_director_reporting_access.sql');
  const messages = read('../src/routes/messages.js');
  assert.match(companies, /in\('role', \[?['\"]COMPANY_OWNER['\"], ['\"]COMPANY_ADMIN['\"]\]?\)/);
  for (const source of [operations, controls, governance]) assert.match(source, /COMPANY_OWNER', 'COMPANY_ADMIN/);
  assert.match(migration, /cm\.role in \('COMPANY_OWNER', 'COMPANY_ADMIN'\)/);
  assert.match(migration, /get_company_dashboard_summary/);
  assert.match(messages, /COMPANY_OWNER', 'COMPANY_ADMIN/);
});
test('operational alert sales comparisons exclude pending and rejected meter readings', () => {
  const alerts = read('../src/routes/alerts.js');
  assert.match(alerts, /from\('nozzle_meter_readings'\)[^\n]*eq\('status', 'approved'\)/);
  assert.match(alerts, /from\('kg_nozzle_meter_readings'\)[^\n]*eq\('status', 'approved'\)/);
});
test('frontend exposes the same operational modules served by the backend', () => {
  const app = read('../../station_pwa/src/App.jsx');
  const controls = read('../../station_pwa/src/pages/ControlsPage.jsx');
  const overview = read('../../station_pwa/src/pages/OverviewPage.jsx');
  assert.match(app, /path="team"/);
  assert.match(app, /path="attendance"/);
  assert.match(app, /path="controls"/);
  assert.match(controls, /ShiftOpeningWorkflow/);
  assert.match(controls, /BranchDailyClose/);
  assert.match(overview, /CompanyRiskPulse/);
  assert.match(overview, /CompanyDailyClosing/);
});
