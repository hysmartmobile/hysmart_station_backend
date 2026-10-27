import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/0013_net_collection_reporting.sql', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../src/routes/operations.js', import.meta.url), 'utf8');
const salesPage = readFileSync(new URL('../../hysmart station_frontend/src/pages/SalesPage.jsx', import.meta.url), 'utf8');

test('owner dashboard reports collections net of reversals', () => {
  assert.match(migration, /collectionsToday[\s\S]*?sc\.amount - coalesce\(rv\.reversed_amount,0\)/);
  assert.match(migration, /collectionsAllTime[\s\S]*?sc\.amount - coalesce\(rv\.reversed_amount,0\)/);
  assert.match(migration, /collectionsReversedToday/);
  assert.match(migration, /collectionsReversedAllTime/);
});
test('operations API includes branch-scoped collection reversals', () => {
  assert.match(operations, /'sales_collection_reversals'/);
  assert.match(operations, /sales_collection_reversals:'created_at'/);
  assert.match(operations, /visibleCollectionIds=new Set\(data\.sales_collections\.map\(c=>c\.id\)\)/);
});
test('sales screen presents net collections and reversed amounts', () => {
  assert.match(salesPage, /Net collections/);
  assert.match(salesPage, /collectionsReversed|reversed/);
  assert.match(salesPage, /grossCollected-reversed/);
});
