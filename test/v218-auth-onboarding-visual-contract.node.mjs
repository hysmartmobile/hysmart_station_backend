import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const frontend = resolve(import.meta.dirname, '../../station_pwa');
const read = (path) => readFileSync(resolve(frontend, path), 'utf8');
test('sign-in and sign-up keep auth flow and have a decorative station photo with fallback', () => {
  const page = read('src/pages/LoginPage.jsx');
  assert.match(page, /signInWithPassword/);
  assert.match(page, /auth\.signUp/);
  assert.match(page, /images\.pexels\.com\/photos\/20758453/);
  assert.match(page, /onError=/);
  assert.match(page, /auth-mobile-photo/);
});
test('company onboarding uses station imagery and preserves company creation', () => {
  const page = read('src/pages/CompanySetupPage.jsx');
  assert.match(page, /apiRequest\('\/companies'/);
  assert.match(page, /onboarding-photo/);
  assert.match(page, /images\.pexels\.com\/photos\/20758453/);
  assert.match(page, /onError=/);
});
test('staff invitation onboarding uses station imagery and preserves invitation flow', () => {
  const page = read('src/pages/InvitePage.jsx');
  assert.match(page, /\/invitations\/accept/);
  assert.match(page, /signInWithPassword/);
  assert.match(page, /invitations\/preview/);
  assert.match(page, /preview\.stationName/);
  assert.match(page, /preview\.companyName/);
  assert.match(page, /onboarding-photo/);
  assert.match(page, /onError=/);
});
test('styles define visible gradient fallbacks and mobile layouts for auth/onboarding', () => {
  const css = read('src/styles.css');
  assert.match(css, /auth-photo-layer.*background:/s);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /onboarding-photo/);
});
