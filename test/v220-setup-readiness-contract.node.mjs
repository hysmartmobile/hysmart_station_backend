import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const page = readFileSync(resolve(root, 'station_pwa/src/pages/GettingStartedPage.jsx'), 'utf8');
const version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
test('v2.20 setup assistant checks branches through authenticated API', () => {
 assert.equal(version, '2.25.9');
 assert.match(page, /apiRequest\('\/stations', \{ token: session\.access_token \}\)/);
 assert.match(page, /loadingBranches/);
 assert.match(page, /branchError/);
});
test('setup assistant never treats a branch record as complete station readiness', () => {
 assert.match(page, /does not mean the station is ready for official sales/);
 assert.match(page, /does not certify physical equipment/);
 assert.match(page, /Pending meter readings must never be treated as official accounting records/);
});
