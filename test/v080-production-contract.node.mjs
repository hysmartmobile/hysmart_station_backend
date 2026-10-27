import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestContext } from '../src/middleware/requestContext.js';
import { errorHandler, notFound } from '../src/middleware/errors.js';

function responseMock() {
  return {
    headers: {}, statusCode: 200, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('request context creates request ID and disables caching', () => {
  const req = {}; const res = responseMock(); let called = false;
  requestContext(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.match(req.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(res.headers['X-Request-Id'], req.requestId);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('not found response includes request ID without implementation details', () => {
  const req = { requestId: 'request-test-id' }; const res = responseMock();
  notFound(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.requestId, 'request-test-id');
});

test('internal errors do not expose provider message or SQL', () => {
  const original = console.error; console.error = () => {};
  try {
    const req = { requestId: 'request-test-id' }; const res = responseMock();
    errorHandler(new Error('secret database password and SQL'), req, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.requestId, 'request-test-id');
    assert.equal(JSON.stringify(res.body).includes('secret database'), false);
  } finally { console.error = original; }
});

test('migration includes duplicate attendance guard and append-only operational facts', async () => {
  const sql = await readFile(new URL('../supabase/migrations/0007_production_integrity.sql', import.meta.url), 'utf8');
  assert.match(sql, /V080_DUPLICATE_OPEN_ATTENDANCE/);
  assert.match(sql, /one_open_attendance_per_staff_station/);
  assert.match(sql, /immutable_meter_reading_update/);
  assert.match(sql, /immutable_sales_collection_update/);
  assert.match(sql, /IMMUTABLE_OPERATIONAL_RECORD/);
});
