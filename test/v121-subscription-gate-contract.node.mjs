import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const gate = await readFile(new URL('../src/middleware/subscriptionAccess.js', import.meta.url), 'utf8');

test('subscription access middleware is mounted on operational and team APIs', () => {
  for (const route of ['/api/attendance', '/api/operations', '/api/controls', '/api/governance', "'/api', subscriptionAccess(supabase), teamRoutes(config)"]) {
    assert.ok(app.includes(route), `expected subscription gate on ${route}`);
  }
  assert.match(app, /app\.use\('\/api\/billing', billingRoutes\(config\)\);[\s\S]*?app\.use\('\/api\/companies', companyRoutes\(\)\);[\s\S]*?app\.use\('\/api\/attendance', subscriptionAccess\(supabase\)/);
});

test('subscription gate keeps billing recovery possible and fails closed on lookup errors', () => {
  assert.match(app, /app\.use\('\/api\/billing', billingRoutes\(config\)\)/);
  assert.match(gate, /if \(company\.error\) throw company\.error/);
  assert.match(gate, /if \(subscription\.error\) throw subscription\.error/);
  assert.match(gate, /status\(402\)/);
  assert.match(gate, /trialActive \|\| paidActive/);
});
