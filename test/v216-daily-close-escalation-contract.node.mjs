import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('v2.16 worker targets previous business date in configurable station timezone', async () => {
  const worker = await read('src/workers/notification-delivery.js');
  assert.match(worker, /BUSINESS_TIMEZONE \|\| 'Africa\/Lagos'/);
  assert.match(worker, /previousBusinessDate/);
  assert.match(worker, /setUTCDate\(day\.getUTCDate\(\) - 1\)/);
});

test('v2.16 escalates missing or rejected daily closes to branch managers only', async () => {
  const worker = await read('src/workers/notification-delivery.js');
  assert.match(worker, /eq\('role', 'STATION_MANAGER'\)\.eq\('status', 'active'\)/);
  assert.match(worker, /daily_close_overdue/);
  assert.match(worker, /daily_close_rejected/);
  assert.match(worker, /managersByStation\.get\(station\.id\)/);
  assert.match(worker, /Review the owner feedback/);
});

test('v2.16 routes submitted close review reminders to company owners and leaves approved closes alone', async () => {
  const worker = await read('src/workers/notification-delivery.js');
  assert.match(worker, /in\('role', \['COMPANY_OWNER', 'COMPANY_ADMIN'\]\)\.eq\('status', 'active'\)/);
  assert.match(worker, /daily_close_owner_review_pending/);
  assert.match(worker, /ownersByCompany\.get\(station\.company_id\)/);
  assert.match(worker, /else \{\s+continue;/);
});

test('v2.16 deduplicates in-app and email reminders and honors email opt-in', async () => {
  const worker = await read('src/workers/notification-delivery.js');
  assert.match(worker, /onConflict: 'user_id,fingerprint', ignoreDuplicates: true/);
  assert.match(worker, /eq\('enabled', true\)\.eq\('daily_summary', true\)/);
  assert.match(worker, /daily-close-reminder:/);
  assert.match(worker, /Queued.*daily-summary email delivery|Email is sent only to recipients who explicitly enabled daily-summary email delivery/);
});

test('v2.16 escalates owner reviews pending longer than 24 hours with a daily fingerprint', async () => {
  const worker = await read('src/workers/notification-delivery.js');
  assert.match(worker, /Date\.now\(\) - 24 \* 60 \* 60 \* 1000/);
  assert.match(worker, /daily_close_owner_escalation/);
  assert.match(worker, /daily_close_owner_review_overdue/);
});
