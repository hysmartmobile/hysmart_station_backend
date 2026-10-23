import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const route = await readFile(new URL('../src/routes/companies.js', import.meta.url), 'utf8');

test('daily closing report paginates shift rows instead of silently truncating at a fixed limit', () => {
  assert.match(route, /const pageSize = 1000/);
  assert.match(route, /const maxRows = 100000/);
  assert.match(route, /\.range\(offset, offset \+ pageSize - 1\)/);
  assert.match(route, /shiftsTruncated/);
  assert.match(route, /100,000-shift safety cap/);
});

test('daily closing report loads reconciliation records only for the selected shifts', () => {
  assert.match(route, /const shiftIds = shiftRows\.map\(\(shift\) => shift\.id\)/);
  assert.match(route, /\.in\('cash_shift_id', chunk\)/);
  assert.doesNotMatch(route, /\.from\('station_shift_reconciliations'\)[\s\S]{0,300}\.in\('station_id', ids\)[\s\S]{0,180}\.limit\(10000\)/);
});

test('daily closing report selects the deployed reconciliation note column', () => {
  assert.match(route, /notes,handover_note/);
  assert.match(route, /handoverNote:[\s\S]{0,100}reconciliation\.handover_note/);
  assert.match(route, /if \(!recs\.has\(item\.cash_shift_id\)\) recs\.set\(item\.cash_shift_id, item\)/);
});


test('company financial report filters kilogram readings to approved records', () => {
  assert.match(route, /'kgSales',\s*'kg_nozzle_meter_readings',\s*'recorded_at',\s*'expected_amount',\s*true/);
  assert.doesNotMatch(route, /kg_nozzle_meter_readings has no status column/);
});

test('daily closing report preserves the newest reconciliation and handover note', () => {
  assert.match(route, /order\('reconciled_at', \{ ascending: false \}\)/);
  assert.match(route, /if \(!recs\.has\(item\.cash_shift_id\)\) recs\.set\(item\.cash_shift_id, item\)/);
  assert.match(route, /handoverNote:[\s\S]{0,100}reconciliation\.handover_note/);
});
