import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('invitation preview is public before auth and only exposes token-validated invitation details', () => {
  const app = read('hysmart_station_backend/src/app.js');
  const route = read('hysmart_station_backend/src/routes/publicInvitations.js');
  assert.ok(app.indexOf("publicInvitationRoutes(supabase)") < app.indexOf('authMiddleware(supabase)'));
  assert.match(route, /createHash\('sha256'\)/);
  assert.match(route, /\.eq\('token_hash', hash\(token\)\)/);
  assert.match(route, /invitation\.status !== 'pending'/);
  assert.match(route, /expires_at/);
  assert.match(route, /stationName: station\.name/);
  assert.match(route, /companyName: company\?\.name/);
  assert.match(route, /email: invitation\.email\.toLowerCase\(\)/);
  assert.doesNotMatch(route, /token_hash:\s*hash|inviteUrl:/);
});

test('invite registration displays server-validated company, branch, role and fixed invite email', () => {
  const page = read('station_pwa/src/pages/InvitePage.jsx');
  assert.match(page, /\/invitations\/preview\?token=/);
  assert.match(page, /preview\.companyName/);
  assert.match(page, /preview\.stationName/);
  assert.match(page, /roleLabel\(preview\.role\)/);
  assert.match(page, /value=\{preview\.email\} readOnly/);
  assert.match(page, /signUp\(/);
  assert.match(page, /email: cleanEmail/);
  assert.match(page, /\/invitations\/accept/);
  assert.match(page, /result\.role === 'ATTENDANT' \? '\/attendance' : '\/'/);
  assert.match(page, /invalid, expired, or already used/i);
});

test('invite page blocks registration until the invitation has been validated', () => {
  const page = read('station_pwa/src/pages/InvitePage.jsx');
  assert.match(page, /!preview \|\| previewError/);
  assert.match(page, /preview && !previewLoading && <form/);
  assert.match(page, /You are signed in with a different email/);
});
