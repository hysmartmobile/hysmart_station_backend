import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const sql = readFileSync(resolve(root, 'supabase/migrations/0006_shift_linked_sales_and_idempotency.sql'), 'utf8');
const operations = readFileSync(resolve(root, 'src/routes/operations.js'), 'utf8');
const controls = readFileSync(resolve(root, 'src/routes/controls.js'), 'utf8');
test('v0.7 migration adds shift references and unique idempotency indexes', () => {
  assert.match(sql, /add column if not exists cash_shift_id uuid references public\.station_cash_shifts/);
  assert.match(sql, /meter_readings_idempotency_uq/);
  assert.match(sql, /sales_collections_idempotency_uq/);
});
test('meter and collection writes use shift-bound database RPCs', () => {
  assert.match(operations, /record_shift_meter_reading/);
  assert.match(operations, /record_shift_sales_collection/);
  assert.match(operations, /OPEN_CASH_SHIFT_REQUIRED/);
  assert.match(sql, /READING_NOT_IN_CASH_SHIFT/);
});
test('shift sales reconciliation separates payment methods and requires a closed shift', () => {
  assert.match(sql, /reconcile_station_cash_shift/);
  assert.match(sql, /CLOSED_CASH_SHIFT_REQUIRED/);
  for (const column of ['cash_collected','pos_collected','bank_transfer_collected','other_collected','sales_variance']) assert.match(sql, new RegExp(column));
  assert.match(operations, /reconcile-cash-shift/);
});
test('cashier shift list is scoped to the attendant when role is attendant-only', () => {
  assert.match(controls, /a\.attendant\s*&&\s*!a\.owner\s*&&\s*!a\.manager/);
  assert.match(controls, /cashier_user_id'\s*,\s*req\.user\.id/);
});
