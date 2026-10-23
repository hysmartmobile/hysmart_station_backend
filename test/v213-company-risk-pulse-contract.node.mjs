import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
test('v2.13 company risk pulse is owner overview only and uses the bounded financial report API', async () => {
 const overview = await read('../hysmart station_frontend/src/pages/OverviewPage.jsx');
 const pulse = await read('../hysmart station_frontend/src/pages/CompanyRiskPulse.jsx');
 assert.match(overview, /CompanyRiskPulse/);
 assert.match(overview, /owner \? <>/);
 assert.match(pulse, /companies\/financial-report/);
 assert.match(pulse, /Choose a valid date range of no more than 367 calendar days/);
 assert.match(pulse, /stockDiscrepancies/);
 assert.match(pulse, /expectedSales/);
 assert.match(pulse, /netCollections/);
 assert.match(pulse, /not automatically a cash shortage/);
 assert.match(pulse, /Litres and kilograms remain separate/);
});
test('v2.13 company financial source remains company-owner and branch scoped', async () => {
 const route = await read('src/routes/companies.js');
 assert.match(route, /companyLeadership\(req\)/);
 assert.match(route, /\.eq\('company_id',\s*owner\.company_id\)/);
 assert.match(route, /\.in\('station_id',\s*ids\)/);
});
