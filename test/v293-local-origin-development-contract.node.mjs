import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('development allows local Vite origins while production relies on explicit allowlist', () => {
  const app = readFileSync(resolve(root, 'src/app.js'), 'utf8');
  const config = readFileSync(resolve(root, 'src/config/env.js'), 'utf8');
  assert.match(app, /if \(config\.nodeEnv !== 'production'\)/);
  assert.match(app, /allowedOrigins\.add\('http:\/\/localhost:5173'\)/);
  assert.match(app, /allowedOrigins\.add\('http:\/\/127\.0\.0\.1:5173'\)/);
  assert.match(config, /localhost frontend origins are not allowed in production/);
});
