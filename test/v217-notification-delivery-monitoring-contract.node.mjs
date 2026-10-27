import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const route = await readFile(path.join(here, '../src/routes/notifications.js'), 'utf8');
const worker = await readFile(path.join(here, '../src/workers/notification-delivery.js'), 'utf8');
const migration = await readFile(path.join(here, '../supabase/migrations/0030_notification_delivery_monitoring.sql'), 'utf8');
const frontend = await readFile(path.join(here, '../../hysmart station_frontend/src/pages/AlertsPage.jsx'), 'utf8');

test('v2.17 exposes company/branch-scoped delivery status and worker freshness', () => {
  assert.match(route, /r\.get\('\/delivery-status'/);
  assert.match(route, /eq\('company_id', scope\.companyId\)/);
  assert.match(route, /if \(!scope\.owner\) jobsQ = stationIds\.length \? jobsQ\.in\('station_id', stationIds\)/);
  assert.match(route, /staleAfterMinutes/);
  assert.match(route, /notification_worker_heartbeat/);
});

test('v2.17 retry endpoint only queues failed jobs with explicit safe failure codes', () => {
  assert.match(route, /r\.post\('\/delivery\/:id\/retry'/);
  assert.match(route, /found\.data\.status !== 'failed'/);
  assert.match(route, /RETRY_UNSAFE/);
  assert.match(route, /eq\('status', 'failed'\)\.select\('id,status'\)/);
  assert.match(route, /retry_requested_by: req\.user\.id/);
  assert.match(route, /queued does not mean delivered/);
});

test('v2.17 does not auto-retry ambiguous network failures', () => {
  assert.doesNotMatch(route, /'EMAIL_NETWORK_ERROR'/);
  assert.match(route, /uncertain delivery outcome/);
});

test('v2.17 worker records start, success, and failure heartbeats', () => {
  assert.match(worker, /writeWorkerHeartbeat\('running'\)/);
  assert.match(worker, /writeWorkerHeartbeat\('succeeded'/);
  assert.match(worker, /writeWorkerHeartbeat\('failed'/);
});

test('v2.17 heartbeat table is service-role-only and status constrained', () => {
  assert.match(migration, /create table if not exists public\.notification_worker_heartbeat/);
  assert.match(migration, /status in \('running','succeeded','failed'\)/);
  assert.match(migration, /revoke all on public\.notification_worker_heartbeat from anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on public\.notification_worker_heartbeat to service_role/);
});

test('v2.17 alert UI shows delivery health and only offers eligible retry controls', () => {
  assert.match(frontend, /\/notifications\/delivery-status/);
  assert.match(frontend, /Delivery worker health and retry controls/);
  assert.match(frontend, /job\.retryable/);
  assert.match(frontend, /\/notifications\/delivery\/\$\{id\}\/retry/);
  assert.match(frontend, /This is not confirmation of delivery/);
});
