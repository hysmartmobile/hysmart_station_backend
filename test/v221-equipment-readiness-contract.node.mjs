import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const page = readFileSync(resolve(root, 'station_pwa/src/pages/GettingStartedPage.jsx'), 'utf8');
const operations = readFileSync(resolve(root, 'hysmart_station_backend/src/routes/operations.js'), 'utf8');
const version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
test('v2.21 readiness is the current package version', () => {
 assert.equal(version, '2.25.9');
});
test('readiness checks branch-scoped operations and controls APIs', () => {
 assert.match(page, /apiRequest\(`\/operations\?stationId=/);
 assert.match(page, /apiRequest\(`\/controls\?stationId=/);
 assert.match(page, /apiRequest\(`\/operations\/shift-openings\/roster\?stationId=/);
});
test('readiness validates product, tank, pump and nozzle relationships', () => {
 assert.match(page, /fuel_products/);
 assert.match(page, /station_tanks/);
 assert.match(page, /station_pumps/);
 assert.match(page, /pump_nozzles/);
 assert.match(page, /tanks\.find\(t => t\.id === x\.tank_id\)\?\.product_id === x\.product_id/);
});
test('a shift is ready only when every open shift roster is configured and approved', () => {
 assert.match(page, /rosterChecks\.every\(x => x\.configured\)/);
 assert.match(page, /rosterChecks\.every\(x => x\.ready\)/);
 assert.match(page, /Opening meter readings approved for every assigned nozzle on each open shift/);
 assert.match(operations, /ready:assigned\.length>0&&items\.every\(x=>x\.openingStatus==='approved'\)/);
});
test('readiness disclaimer does not claim physical or accounting certification', () => {
 assert.match(page, /does not certify physical equipment/);
 assert.match(page, /Pending meter readings must never be treated as official accounting records/);
});
