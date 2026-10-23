import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../hysmart station_frontend/src/pages/ReportsPage.jsx', import.meta.url), 'utf8');
test('branch PDF/print statements include company letterhead and report options', () => {
  assert.match(source, /HYSMART STATION/);
  assert.match(source, /Branch Transaction Account Statement/);
  assert.match(source, /General Branch Account Details/);
  assert.match(source, /Print \/ Save as PDF/);
  assert.match(source, /companyName \|\| billing\?\.companyName/);
});
test('statement uses date-filtered server-side cursor pagination and approved readings', () => {
  assert.match(source, /statement-transactions/);
  assert.match(source, /pagination/);
  assert.match(source, /Only approved meter readings are listed as official sales/);
  assert.match(source, /htmlSafe/);
});
