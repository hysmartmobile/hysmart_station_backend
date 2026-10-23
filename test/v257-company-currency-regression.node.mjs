import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('v2.25.7 defines companyCurrency before financial report handlers use it', async () => {
  const src = await read('src/routes/companies.js');
  assert.match(src, /async function companyCurrency\(req, companyId\)/);
  assert.match(src, /\.from\('companies'\)[\s\S]*?\.select\('currency'\)[\s\S]*?\.eq\('id', companyId\)/);
  assert.match(src, /const reportCurrency = await companyCurrency\(req, owner\.company_id\)/);
  assert.match(src, /const reportCurrency = await companyCurrency\(req, leader\.company_id\)/);
  assert.match(src, /if \(result\.error\) throw result\.error;/);
});
