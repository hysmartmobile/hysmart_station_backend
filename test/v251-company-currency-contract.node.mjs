import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(path.join(root, rel), 'utf8');

test('company currency is persisted in schema and bootstrap RPC', async () => {
  const migration = await read('supabase/migrations/0046_company_currency_preference.sql');
  const route = await read('src/routes/companies.js');
  assert.match(migration, /add column if not exists currency text not null default 'NGN'/i);
  assert.match(migration, /p_company_currency text/i);
  assert.match(migration, /bootstrap_company_owner\(uuid,text,text\)/i);
  assert.match(route, /p_company_currency: parsed\.data\.currency/);
});

test('only owner may change currency and change is locked after first station', async () => {
  const route = await read('src/routes/companies.js');
  assert.match(route, /in\('role', \['COMPANY_OWNER','COMPANY_ADMIN'\]\)/);
  assert.match(route, /CURRENCY_LOCKED/);
  assert.match(route, /from\('stations'\)\.select\('id'\)/);
});

test('frontend exposes currency selection and formats company money dynamically', async () => {
  const setup = await read('../station_pwa/src/pages/CompanySetupPage.jsx').catch(async () => read('../station_pwa/src/pages/CompanySetupPage.jsx'));
  const settings = await read('../station_pwa/src/pages/CompanySettingsPage.jsx').catch(async () => read('../station_pwa/src/pages/CompanySettingsPage.jsx'));
  const util = await read('../station_pwa/src/lib/currency.js').catch(async () => read('../station_pwa/src/lib/currency.js'));
  assert.match(setup, /company-currency/);
  assert.match(settings, /Save company currency/);
  assert.match(util, /Intl\.NumberFormat/);
});
