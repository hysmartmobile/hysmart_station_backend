import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('forgot-password submits a Supabase recovery email with the correct public callback route', async () => {
  const login = await read('hysmart station_frontend/src/pages/LoginPage.jsx');
  assert.match(login, /resetPasswordForEmail\(email\.trim\(\),\s*\{\s*redirectTo\s*\}\)/);
  assert.match(login, /\$\{window\.location\.origin\}\/reset-password/);
  assert.match(login, /If an account exists for this email/);
  assert.match(login, /Forgot your password\?/);
});

test('reset page validates confirmation and updates password only with an authenticated Supabase session', async () => {
  const page = await read('hysmart station_frontend/src/pages/ResetPasswordPage.jsx');
  assert.match(page, /if \(!session \|\| !recoveryMode\)/);
  assert.match(page, /const \{ session, loading, configured, signOut, recoveryMode \} = useAuth\(\)/);
  assert.match(page, /password !== confirm/);
  assert.match(page, /password\.length < 8/);
  assert.match(page, /supabase\.auth\.updateUser\(\{ password \}\)/);
  assert.match(page, /await signOut\(\)/);
  assert.match(page, /expired/i);
  const auth = await read('hysmart station_frontend/src/features/auth/AuthContext.jsx');
  assert.match(auth, /_event === 'PASSWORD_RECOVERY'/);
  assert.match(auth, /sessionStorage\.setItem\('hysmart-password-recovery', 'true'\)/);
  assert.match(auth, /sessionStorage\.removeItem\('hysmart-password-recovery'\)/);
});

test('authenticated account password change re-verifies the current password first', async () => {
  const page = await read('hysmart station_frontend/src/pages/AccountSecurityPage.jsx');
  assert.ok(page.indexOf('signInWithPassword') < page.indexOf('updateUser'), 'current password must be verified before updateUser');
  assert.match(page, /current === next/);
  assert.match(page, /next !== confirm/);
  assert.match(page, /At least 8 characters/);
});

test('password recovery routes are registered and account security is available to every sidebar role', async () => {
  const app = await read('hysmart station_frontend/src/App.jsx');
  const layout = await read('hysmart station_frontend/src/layouts/AppLayout.jsx');
  assert.match(app, /path="\/reset-password" element={<ResetPasswordPage \/>}/);
  assert.match(app, /path="account-security" element={<AccountSecurityPage \/>}/);
  assert.match(layout, /\['\/account-security', 'Account security', KeyRound\]/);
  for (const rolesFilter of ["'/support', '/account-security'", "'/accountability', '/support', '/account-security'", "'/stations', '/support', '/account-security'"]) assert.ok(layout.includes(rolesFilter), `account security missing from role filter ${rolesFilter}`);
});
