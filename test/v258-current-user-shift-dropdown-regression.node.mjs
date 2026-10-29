import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
test('operations asset response exposes authenticated user id for own-shift filtering', () => {
  const route = read('src/routes/operations.js');
  assert.match(route, /currentUserId\s*:\s*req\.user\.id/);
  assert.doesNotMatch(route, /data\.station_tanks=data\.station_tanks\|\|\[\];data\.station_pumps=data\.station_pumps\|\|\[\];data\.pump_nozzles=data\.pump_nozzles\|\|\[\]/);
  assert.match(route, /Station-scoped asset records are visible to authorized attendants/);
  const component = read('../station_pwa/src/pages/ShiftOpeningWorkflow.jsx');
  assert.match(component, /s\.cashier_user_id\s*===\s*assets\?\.currentUserId/);
  assert.match(component, /No open cashier shift was found for your account/);
});
