import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '../..');
const frontend = path.join(root, 'hysmart station_frontend');
const backend = path.join(root, 'hysmart station_backend');
const read = (p) => readFile(p, 'utf8');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

 test('all frontend relative imports resolve to real source files', async () => {
  const files = (await walk(path.join(frontend, 'src'))).filter(p => /\.(jsx?|mjs)$/.test(p));
  const missing = [];
  for (const file of files) {
    const source = await read(file);
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const spec = match[1];
      const base = path.resolve(path.dirname(file), spec);
      const candidates = [base, ...['.js','.jsx','.mjs','.json'].map(ext => base + ext), ...['index.js','index.jsx'].map(name => path.join(base,name))];
      let exists = false;
      for (const candidate of candidates) { try { if ((await stat(candidate)).isFile()) { exists = true; break; } } catch {} }
      if (!exists) missing.push(`${path.relative(root,file)} -> ${spec}`);
    }
  }
  assert.deepEqual(missing, [], `Missing local imports:\n${missing.join('\n')}`);
});

test('every sidebar destination has a matching React route', async () => {
  const layout = await read(path.join(frontend, 'src/layouts/AppLayout.jsx'));
  const app = await read(path.join(frontend, 'src/App.jsx'));
  const linksBlock = layout.match(/const links = \[(.*?)\];/s)?.[1];
  assert.ok(linksBlock, 'sidebar link configuration should exist');
  const destinations = [...linksBlock.matchAll(/\['([^']+)',\s*'[^']+'/g)].map(m => m[1]);
  const routePaths = new Set(['/']);
  for (const m of app.matchAll(/<Route\s+path="([^"]+)"/g)) routePaths.add(m[1]);
  const missing = destinations.filter(to => !routePaths.has(to) && !routePaths.has(to.replace(/^\//,'')));
  assert.deepEqual(missing, [], `Sidebar routes missing in App.jsx: ${missing.join(', ')}`);
});

test('sidebar can scroll without pushing sign-out/theme controls off-screen', async () => {
  const css = await read(path.join(frontend, 'src/styles.css'));
  assert.match(css, /\.sidebar nav\{[^}]*overflow-y:auto/s, 'sidebar nav needs vertical scrolling');
  assert.match(css, /\.sidebar nav\{[^}]*min-height:0/s, 'flex child must be allowed to shrink');
  assert.match(css, /\.sidebar-bottom\{margin-top:auto/s, 'sidebar actions should remain anchored at bottom');
});

test('theme switch persists selection and both light/dark theme styles exist', async () => {
  const layout = await read(path.join(frontend, 'src/layouts/AppLayout.jsx'));
  const css = await read(path.join(frontend, 'src/styles.css'));
  assert.match(layout, /localStorage\.setItem\('hysmart-theme', theme\)/);
  assert.match(layout, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(css, /:root\{[^}]*--page:/s);
  assert.match(css, /data-theme="dark"/);
  assert.match(css, /:focus-visible/);
});

test('all migrations are present sequentially through the release migration 0049', async () => {
  const dir = path.join(backend, 'supabase/migrations');
  const files = (await readdir(dir)).filter(n => /^\d{4}_.*\.sql$/.test(n));
  const nums = new Set(files.map(n => Number(n.slice(0,4))));
  const missing = Array.from({length:49}, (_,i)=>i+1).filter(n=>!nums.has(n));
  assert.deepEqual(missing, [], `Missing migration numbers: ${missing.join(', ')}`);
  assert.ok(files.some(n => n.startsWith('0049_')), 'release migration 0049 should exist');
});

test('creator access migration is fail-closed and does not expose the allowlist to client roles', async () => {
  const sql = await read(path.join(backend, 'supabase/migrations/0049_database_managed_creator_admins.sql'));
  const service = await read(path.join(backend, 'src/services/creatorAccess.js'));
  const route = await read(path.join(backend, 'src/routes/creatorAdmin.js'));
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.creator_admins from anon, authenticated/i);
  assert.match(sql, /grant all on table public\.creator_admins to service_role/i);
  assert.match(service, /\.eq\('active', true\)/);
  assert.match(route, /CREATOR_ACCESS_DENIED/);
});

test('all backend route modules imported by app.js are mounted', async () => {
  const app = await read(path.join(backend, 'src/app.js'));
  const imports = [...app.matchAll(/import\s+(?:\{[^}]+\}|\w+)\s+from\s+['"]\.\/routes\/([^'"]+)['"]/g)];
  const unmounted = [];
  for (const match of imports) {
    const routeFile = match[1];
    const importLine = match[0];
    const names = importLine.match(/import\s+(?:\{([^}]+)\}|(\w+))/);
    const identifiers = names?.[1] ? names[1].split(',').map(x=>x.trim().split(/\s+as\s+/).pop()) : [names?.[2]];
    if (!identifiers.some(id => id && new RegExp(`app\\.use\\([^;]*\\b${id}\\b`, 's').test(app))) unmounted.push(routeFile);
  }
  assert.deepEqual(unmounted, [], `Imported but unmounted routes: ${unmounted.join(', ')}`);
});
