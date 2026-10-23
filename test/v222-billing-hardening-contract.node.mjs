import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const billing = await readFile(new URL('src/routes/billing.js', root), 'utf8');
const gate = await readFile(new URL('src/middleware/subscriptionAccess.js', root), 'utf8');
const me = await readFile(new URL('src/routes/me.js', root), 'utf8');
const migration = await readFile(new URL('supabase/migrations/0031_billing_idempotency_and_entitlement_hardening.sql', root), 'utf8');
const frontend = await readFile(new URL('../../hysmart station_frontend/src/pages/BillingPage.jsx', import.meta.url), 'utf8');

test('checkout attempt exists before provider checkout can return a callback', () => {
  assert.ok(billing.indexOf("from('company_payment_attempts').insert") < billing.indexOf("fetch('https://api.paystack.co/transaction/initialize'"));
  assert.match(billing, /status: 'failed'/);
});

test('webhook and browser verification share the atomic activation RPC', () => {
  assert.equal((billing.match(/rpc\('activate_company_subscription_from_payment'/g) || []).length, 2);
  assert.match(billing, /x-paystack-signature/);
  assert.match(billing, /timingSafeEqual/);
  assert.match(billing, /transaction\?\.id == null/);
  assert.match(billing, /Number\(transaction\?\.metadata\?\.branch_limit\) !== expected\.branchLimit/);
});

test('database activation is transactional and idempotent under row lock', () => {
  assert.match(migration, /where paystack_reference = p_reference\s+for update/i);
  assert.match(migration, /alreadyProcessed/);
  assert.match(migration, /paystack_transaction_id/);
  assert.match(migration, /SUBSCRIPTION_ACTIVATED/);
  assert.match(migration, /grant execute on function public\.activate_company_subscription_from_payment[^;]*to service_role/i);
});

test('missing paid-through timestamps do not grant indefinite subscription access', () => {
  assert.match(gate, /!!subscription\.data\.current_period_end/);
  assert.match(me, /!!subscription\.data\.current_period_end/);
  assert.match(migration, /v_sub\.current_period_end is null or v_sub\.current_period_end <= now\(\)/);
});

test('billing page discloses manual renewal and immediate unprorated plan changes', () => {
  assert.match(frontend, /manual monthly payment, not automatic recurring billing/i);
  assert.match(frontend, /unused time is not prorated/i);
});
