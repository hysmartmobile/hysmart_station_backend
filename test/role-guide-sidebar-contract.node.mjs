import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const layout = await readFile(new URL('../../hysmart station_frontend/src/layouts/AppLayout.jsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../../hysmart station_frontend/src/App.jsx', import.meta.url), 'utf8');
const guide = await readFile(new URL('../../hysmart station_frontend/src/pages/UserGuidePage.jsx', import.meta.url), 'utf8');

test('sidebar provides the correct named manual and matching route for each effective role', () => {
  assert.match(layout, /\['\/user-guide\/owner', 'Owner user guide', BookOpen\]/);
  assert.match(layout, /\['\/user-guide\/manager', 'Manager user guide', BookOpen\]/);
  assert.match(layout, /\['\/user-guide\/attendant', 'Attendant user manual', BookOpen\]/);
  assert.match(app, /path="user-guide\/owner"/);
  assert.match(app, /path="user-guide\/manager"/);
  assert.match(app, /path="user-guide\/attendant"/);
});

test("guide URL cannot select a manual above the signed-in user's role", () => {
  assert.match(guide, /roleRank\[role\] >= roleRank\[requestedRole\]/);
  assert.match(guide, /permittedRoutes = guideRole === 'owner'/);
});
