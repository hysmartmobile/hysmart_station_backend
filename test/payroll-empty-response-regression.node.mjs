import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
test('payroll page normalizes missing API collections to arrays', () => {
  const page = readFileSync(resolve(root, '../hysmart station_frontend/src/pages/PayrollPage.jsx'), 'utf8');
  for (const key of ['stations', 'staff', 'payroll', 'expenses']) {
    assert.match(page, new RegExp(`Array\\.isArray\\(payload\\.${key}\\)`));
  }
});
test('payroll API empty-branch response includes expenses and safe permissions', () => {
  const route = readFileSync(resolve(root, 'src/routes/payroll.js'), 'utf8');
  assert.match(route, /if\(!stations\.length\)return res\.json\(\{data:\{stations:\[\],staff:\[\],payroll:\[\],expenses:\[\],truncated:false/);
  assert.match(route, /canSubmit:false/);
});
