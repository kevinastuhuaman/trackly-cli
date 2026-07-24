'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lifecycle = fs.readFileSync(path.join(
  __dirname,
  '..',
  'skills',
  'trackly-apply',
  'references',
  'browser-lifecycle.md',
), 'utf8');

test('tab closure requires complete controller and user inventories plus a close receipt', () => {
  assert.match(lifecycle, /controller-owned inventory/i);
  assert.match(lifecycle, /user-owned inventory/i);
  assert.match(lifecycle, /complete.*inventory/i);
  assert.match(lifecycle, /explicit close receipt/i);
  assert.match(lifecycle, /post-close union/i);
  assert.match(lifecycle, /must not claim `closed_verified`/i);
  assert.match(lifecycle, /`closure_unverified`/);
  assert.match(lifecycle, /`missing`/);
});

test('a missing incomplete tab reuses its run and exact requisition URL', () => {
  assert.match(lifecycle, /exact backend-stored requisition URL/i);
  assert.match(lifecycle, /reuse the existing run/i);
  assert.match(lifecycle, /never create a\s+replacement run/i);
  assert.match(lifecycle, /revalidate.*origin.*job identity/is);
  assert.match(lifecycle, /increment.*inspection epoch/i);
  assert.match(lifecycle, /do not claim.*draft state.*survived/is);
  assert.match(lifecycle, /refill.*verified canonical answers/i);
});

test('raw tab identifiers stay in a private local ledger', () => {
  assert.match(lifecycle, /raw tab identifiers.*never.*Trackly backend/is);
  assert.match(lifecycle, /mode `0600`/);
  assert.match(lifecycle, /binding hash/i);
  assert.match(lifecycle, /value-free/i);
});

test('old inspection epochs cannot satisfy review or closure', () => {
  assert.match(lifecycle, /earlier inspection epoch.*cannot satisfy.*current review gate/is);
  assert.match(lifecycle, /Close evidence from an earlier inspection epoch cannot\s+satisfy the current closure gate/i);
  assert.match(lifecycle, /changed success URL.*revalidate/is);
});
