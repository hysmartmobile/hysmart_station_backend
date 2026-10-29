import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFile(path.join(root, p), 'utf8');
test('creator access endpoint is protected by active creator-admin middleware', async () => {
 const route = await read('src/routes/creatorAdmin.js');
 assert.match(route, /isActiveCreatorAdmin\(req\.supabase,req\.user\.id\)/);
 assert.match(route, /r\.get\('\/access'.*isCreatorAdmin:true/s);
});
test('frontend checks creator access, exposes creator navigation, and redirects creator from workspace overview', async () => {
 const layout = await read('../station_pwa/src/layouts/AppLayout.jsx');
 assert.match(layout, /apiRequest\('\/creator\/access'/);
 assert.match(layout, /Creator Administrator/);
 assert.match(layout, /nav\('\/creator', \{ replace: true \}\)/);
});
