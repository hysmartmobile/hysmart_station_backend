import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative) => readFileSync(resolve(here, relative), 'utf8');

test('sales selectors use real eligible records and explain empty states instead of dummy options', () => {
  const page = source('../../hysmart station_frontend/src/pages/SalesPage.jsx');
  assert.match(page, /activeLitreNozzles=nozzles\.filter/);
  assert.match(page, /activeKgNozzles=nozzles\.filter/);
  assert.match(page, /approvedLitreReadings=\(data\?\.nozzle_meter_readings\|\|\[\]\)\.filter\(r=>r\.status==='approved'&&!!openShiftId&&r\.cash_shift_id===openShiftId\)/);
  assert.match(page, /approvedKgReadings=\(data\?\.kg_nozzle_meter_readings\|\|\[\]\)\.filter\(r=>r\.status==='approved'&&!!openShiftId&&r\.cash_shift_id===openShiftId\)/);
  assert.match(page, /No active litre nozzles configured for this station/);
  assert.match(page, /No active kilogram nozzles configured for this station/);
  assert.match(page, /No eligible approved litre readings are available for your open cashier shift/);
  assert.match(page, /No eligible approved kilogram readings are available for your open cashier shift/);
  assert.match(page, /mode==='reading'&&!activeLitreNozzles\.length/);
  assert.match(page, /mode==='collection'&&!approvedLitreReadings\.length/);
});

test('shift-opening selectors explain missing shifts and nozzles without inventing selectable records', () => {
  const page = source('../../hysmart station_frontend/src/pages/ShiftOpeningWorkflow.jsx');
  assert.match(page, /Open a cashier shift in Tank & cash controls first/);
  assert.match(page, /No eligible active nozzle is configured for this station\/shift/);
  assert.match(page, /No open cashier shifts available at this station/);
});

test('operations response exposes current user and returns real station-scoped equipment', () => {
  const route = source('../src/routes/operations.js');
  assert.match(route, /station_tanks/);
  assert.match(route, /station_pumps/);
  assert.match(route, /pump_nozzles/);
  assert.match(route, /currentUserId:req\.user\.id/);
  assert.match(route, /openCashShift/);
  assert.match(route, /cashier_user_id',req\.user\.id/);
  assert.doesNotMatch(route, /data\.station_tanks=\[\];data\.station_pumps=\[\];data\.pump_nozzles=\[\]/);
});
