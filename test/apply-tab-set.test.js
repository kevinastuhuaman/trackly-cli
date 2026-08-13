'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  APPLY_TAB_SET_FAILURE_CODES,
  canonicalizeTabId,
  validateApplyTabKeepSet,
} = require('../lib/apply-tab-set');

function validate(overrides = {}) {
  return validateApplyTabKeepSet({
    expectedTabIds: ['101', 'tab-b'],
    keepTabIds: ['101', 'tab-b'],
    controllerInventory: { complete: true, tabIds: ['101'] },
    userInventory: { complete: true, tabIds: ['tab-b', 'unrelated-tab'] },
    ...overrides,
  });
}

test('canonicalizes safe numeric IDs without changing opaque string IDs', () => {
  assert.equal(canonicalizeTabId(101), '101');
  assert.equal(canonicalizeTabId('101'), '101');
  assert.equal(canonicalizeTabId('tab-b'), 'tab-b');
  assert.throws(() => canonicalizeTabId(Number.MAX_SAFE_INTEGER + 1), /safe integers/i);
  assert.throws(() => canonicalizeTabId('   '), /nonblank opaque strings/i);
  assert.equal(canonicalizeTabId(' x '), ' x ');
  assert.equal(canonicalizeTabId('x'.repeat(512)), 'x'.repeat(512));
  assert.throws(() => canonicalizeTabId('x'.repeat(513)), /512 characters/i);
});

test('enforces collection bounds inside the exported pure helper', () => {
  const sequentialIds = (length) => Array.from({ length }, (_, index) => `tab-${index}`);
  assert.equal(validate({
    expectedTabIds: sequentialIds(100),
    keepTabIds: sequentialIds(100),
    controllerInventory: { complete: true, tabIds: sequentialIds(1000) },
    userInventory: { complete: true, tabIds: [] },
  }).safeToFinalize, true);
  assert.throws(() => validate({ expectedTabIds: sequentialIds(101) }), /expectedTabIds.*100/i);
  assert.throws(() => validate({ keepTabIds: sequentialIds(101) }), /keepTabIds.*100/i);
  assert.throws(() => validate({
    controllerInventory: { complete: true, tabIds: sequentialIds(1001) },
  }), /controllerInventory\.tabIds.*1000/i);
  assert.throws(() => validate({
    userInventory: { complete: true, tabIds: sequentialIds(1001) },
  }), /userInventory\.tabIds.*1000/i);
});

test('returns the canonical keep set when complete inventories cover every expected tab', () => {
  const result = validate();
  assert.equal(result.safeToFinalize, true);
  assert.deepEqual(result.failureCodes, []);
  assert.deepEqual(result.canonicalKeepTabIds, ['101', 'tab-b']);
  assert.equal(result.inventoryUnionCount, 3);
});

test('allows unrelated browser tabs outside the expected keep set', () => {
  const result = validate({
    controllerInventory: { complete: true, tabIds: ['101', 'browser-settings'] },
    userInventory: { complete: true, tabIds: ['tab-b', 'personal-tab'] },
  });
  assert.equal(result.safeToFinalize, true);
  assert.equal(result.inventoryUnionCount, 4);
  assert.deepEqual(result.canonicalKeepTabIds, ['101', 'tab-b']);
});

test('fails closed when either inventory is not explicitly complete', () => {
  const result = validate({
    controllerInventory: { complete: false, tabIds: ['101'] },
    userInventory: { tabIds: ['tab-b'] },
  });
  assert.equal(result.safeToFinalize, false);
  assert.deepEqual(result.failureCodes, [
    APPLY_TAB_SET_FAILURE_CODES.CONTROLLER_INVENTORY_INCOMPLETE,
    APPLY_TAB_SET_FAILURE_CODES.USER_INVENTORY_INCOMPLETE,
  ]);
  assert.deepEqual(result.canonicalKeepTabIds, []);
});

test('requires a nonempty expected set for the session finalizer path', () => {
  const result = validate({ expectedTabIds: [], keepTabIds: [] });
  assert.equal(result.safeToFinalize, false);
  assert.ok(result.failureCodes.includes(APPLY_TAB_SET_FAILURE_CODES.EXPECTED_SET_EMPTY));
});

test('rejects duplicates independently in every caller-supplied list', () => {
  const result = validate({
    expectedTabIds: [101, '101'],
    keepTabIds: ['tab-b', 'tab-b'],
    controllerInventory: { complete: true, tabIds: [101, '101'] },
    userInventory: { complete: true, tabIds: ['tab-b', 'tab-b'] },
  });
  assert.equal(result.safeToFinalize, false);
  assert.ok(result.failureCodes.includes(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_EXPECTED_TAB_ID));
  assert.ok(result.failureCodes.includes(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_KEEP_TAB_ID));
  assert.ok(result.failureCodes.includes(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_CONTROLLER_TAB_ID));
  assert.ok(result.failureCodes.includes(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_USER_TAB_ID));
});

test('fails closed when numeric and string IDs share one lexical value', () => {
  const result = validate({
    expectedTabIds: [101, 'tab-b'],
    keepTabIds: ['101', 'tab-b'],
  });
  assert.equal(result.safeToFinalize, false);
  assert.ok(result.failureCodes.includes(
    APPLY_TAB_SET_FAILURE_CODES.AMBIGUOUS_CROSS_TYPE_TAB_ID,
  ));
});

test('fails closed when the expected and keep sets differ', () => {
  const result = validate({
    keepTabIds: ['101'],
  });
  assert.equal(result.safeToFinalize, false);
  assert.ok(result.failureCodes.includes(
    APPLY_TAB_SET_FAILURE_CODES.EXPECTED_KEEP_CARDINALITY_MISMATCH,
  ));
  assert.ok(result.failureCodes.includes(APPLY_TAB_SET_FAILURE_CODES.EXPECTED_KEEP_SET_MISMATCH));
  assert.deepEqual(result.canonicalKeepTabIds, []);
});

test('returns a stable specific failure when the keep set is empty', () => {
  const result = validate({ keepTabIds: [] });
  assert.equal(result.safeToFinalize, false);
  assert.ok(result.failureCodes.includes(
    APPLY_TAB_SET_FAILURE_CODES.KEEP_SET_EMPTY_WITH_EXPECTED_TABS,
  ));
});

test('fails closed when an expected tab is absent from the complete inventory union', () => {
  const result = validate({
    controllerInventory: { complete: true, tabIds: ['101'] },
    userInventory: { complete: true, tabIds: ['unrelated-tab'] },
  });
  assert.equal(result.safeToFinalize, false);
  assert.ok(result.failureCodes.includes(
    APPLY_TAB_SET_FAILURE_CODES.EXPECTED_TAB_MISSING_FROM_INVENTORY_UNION,
  ));
  assert.deepEqual(result.canonicalKeepTabIds, []);
});

test('does not perform browser or network actions', () => {
  const source = require('node:fs').readFileSync(require.resolve('../lib/apply-tab-set'), 'utf8');
  assert.doesNotMatch(source, /apiRequest|fetch\(|browser\.|close\(|focus\(|finalize\(/);
});
