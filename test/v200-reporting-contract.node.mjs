import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
test('v1.9 company reporting enforces owner scope and bounded date range', async () => {
 const src = await read('src/routes/companies.js');
 assert.match(src, /financial-report/);
 assert.match(src, /companyLeadership\(req\)/);
 assert.match(src, /INVALID_DATE_RANGE/);
 assert.match(src, /367 calendar days/);
 assert.match(src, /\.eq\('company_id',\s*owner\.company_id\)/);
 assert.match(src, /\.in\('station_id',\s*ids\)/);
 assert.match(src, /if\s*\(approvedOnly\)\s*\{[\s\S]*?\.eq\('status',\s*'approved'\)/);
 assert.match(src, /'litreSales',\s*'nozzle_meter_readings',\s*'recorded_at',\s*'expected_amount',\s*true/);
 assert.match(src, /'kgSales',\s*'kg_nozzle_meter_readings',\s*'recorded_at',\s*'expected_amount',\s*true/);
});
test('v1.9 financial report keeps physical units separate and subtracts reversals', async () => {
 const src = await read('src/routes/companies.js');
 assert.match(src, /salesLitres/);
 assert.match(src, /salesKg/);
 assert.match(src, /netCollections:\s*grossCollections\s*-\s*reversals/);
 assert.match(src, /stockDiscrepancies/);
 assert.match(src, /kg_sales_collection_reversals/);
 assert.match(src, /sales_collection_reversals/);
});
test('v1.9 audit export supports the same selected date range and bounded result size', async () => {
 const src = await read('src/routes/companies.js');
 assert.match(src, /r\.get\('\/audit'/);
 assert.match(src, /limit\(500\)/);
 assert.match(src, /inRange\(eq,\s*'created_at',\s*from,\s*to\)/);
});
test('v1.9 report screen offers date filters and spreadsheet-safe CSV exports', async () => {
 const page = await read('../hysmart station_frontend/src/pages/ReportsPage.jsx');
 assert.match(page, /type="date"/);
 assert.match(page, /companies\/financial-report/);
 assert.match(page, /hysmart-financial-report/);
 assert.match(page, /hysmart-audit-log/);
 assert.match(page, /csvCell/);
 assert.match(page, /Litres and kilograms are separate quantities/);
});
test('v1.9 report screen is registered and company navigation includes it', async () => {
 const app = await read('../hysmart station_frontend/src/App.jsx');
 const layout = await read('../hysmart station_frontend/src/layouts/AppLayout.jsx');
 assert.match(app, /path="reports" element={<ReportsPage \/>}/);
 assert.match(layout, /Financial reports/);
});
