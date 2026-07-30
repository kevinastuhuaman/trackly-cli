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
  assert.match(lifecycle, /`trackly_record_apply_surface_evidence`/);
  assert.match(lifecycle, /`surface_inventory_reconciled`/);
  assert.match(lifecycle, /`surface_close_receipt`/);
  assert.match(lifecycle, /`surface_post_close_absent`/);
  assert.match(lifecycle, /backend.*derives `closed_verified`/is);
  assert.match(lifecycle, /must not claim `closed_verified`/i);
  assert.match(lifecycle, /`closure_unverified`/);
  assert.match(lifecycle, /`missing`/);
});

test('a missing incomplete tab reuses its run and exact requisition URL', () => {
  assert.match(lifecycle, /exact backend-stored requisition URL/i);
  assert.match(lifecycle, /`trackly_bind_apply_surface`.*`recovery_binding`/is);
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

test('browser finalization preserves the complete live application inventory', () => {
  assert.match(lifecycle, /finalization as destructive cleanup/i);
  assert.match(lifecycle, /complete current controller-owned and user-owned inventory\s+union/i);
  assert.match(lifecycle, /every currently live mapped application\s+tab, including frozen-batch members and legacy single-run tabs/i);
  assert.match(lifecycle, /`browser\.tabs\.finalize\(\{ keep \}\)` exactly once/i);
  assert.match(lifecycle, /omitted, empty, partial, guessed, or stale keep list/i);
  assert.match(lifecycle, /review-ready, inspecting, needs-input, or submitted-but-unreconciled/i);
  assert.match(
    lifecycle,
    /documented\s+per-tab durable-handoff primitive[\s\S]{0,120}every live\s+application tab/i,
  );
  assert.match(
    lifecycle,
    /mere presence of a finalizer must never override the verified per-tab[\s\S]{0,40}fallback/i,
  );
  assert.match(lifecycle, /verify\s+an exact persistence receipt for each one/i);
  assert.match(lifecycle, /never invoke an implicit\s+close-all cleanup/i);
  assert.match(lifecycle, /stop before\s+mutating the form or\s+entering private\s+data/i);
  assert.match(lifecycle, /A no-op is not a preservation\s+mechanism/i);
  assert.match(lifecycle, /user confirms they closed it\s+directly/i);
  assert.match(lifecycle, /defer inventory recovery to the next turn/i);
  assert.match(lifecycle, /must not be rerun/i);
});

test('handoff claims require user-visible proof rather than controller ownership', () => {
  assert.match(lifecycle, /Opening or restoring a controller tab is not proof/i);
  assert.match(lifecycle, /complete user-owned inventory/i);
  assert.match(lifecycle, /documented visible state or exact user-visible handoff receipt/i);
  assert.match(lifecycle, /visibility is unverified/i);
  assert.match(lifecycle, /Inventory\s+membership alone is never visibility proof/i);
  assert.match(lifecycle, /Never convert controller ownership into a visibility claim/i);
});
