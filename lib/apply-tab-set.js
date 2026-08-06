'use strict';

const APPLY_TAB_SET_FAILURE_CODES = Object.freeze({
  CONTROLLER_INVENTORY_INCOMPLETE: 'controller_inventory_incomplete',
  USER_INVENTORY_INCOMPLETE: 'user_inventory_incomplete',
  EXPECTED_SET_EMPTY: 'expected_set_empty',
  KEEP_SET_EMPTY_WITH_EXPECTED_TABS: 'keep_set_empty_with_expected_tabs',
  DUPLICATE_EXPECTED_TAB_ID: 'duplicate_expected_tab_id',
  DUPLICATE_KEEP_TAB_ID: 'duplicate_keep_tab_id',
  DUPLICATE_CONTROLLER_TAB_ID: 'duplicate_controller_tab_id',
  DUPLICATE_USER_TAB_ID: 'duplicate_user_tab_id',
  EXPECTED_KEEP_CARDINALITY_MISMATCH: 'expected_keep_cardinality_mismatch',
  EXPECTED_KEEP_SET_MISMATCH: 'expected_keep_set_mismatch',
  EXPECTED_TAB_MISSING_FROM_INVENTORY_UNION: 'expected_tab_missing_from_inventory_union',
});

function canonicalizeTabId(tabId) {
  if (typeof tabId === 'number') {
    if (!Number.isSafeInteger(tabId)) throw new TypeError('Tab IDs supplied as numbers must be safe integers.');
    return String(tabId);
  }
  if (typeof tabId !== 'string' || tabId.trim().length === 0) {
    throw new TypeError('Tab IDs must be safe integers or nonblank opaque strings.');
  }
  if (tabId.length > 512) throw new RangeError('Opaque tab IDs must not exceed 512 characters.');
  return tabId;
}

function canonicalizeTabIds(tabIds, { label, maxItems }) {
  if (!Array.isArray(tabIds)) throw new TypeError('Tab ID collections must be arrays.');
  if (tabIds.length > maxItems) {
    throw new RangeError(`${label} must not contain more than ${maxItems} tab IDs.`);
  }
  return tabIds.map(canonicalizeTabId);
}

function hasDuplicates(tabIds) {
  return new Set(tabIds).size !== tabIds.length;
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((tabId) => rightSet.has(tabId));
}

function validateApplyTabKeepSet({
  expectedTabIds,
  keepTabIds,
  controllerInventory,
  userInventory,
}) {
  const expected = canonicalizeTabIds(expectedTabIds, { label: 'expectedTabIds', maxItems: 100 });
  const keep = canonicalizeTabIds(keepTabIds, { label: 'keepTabIds', maxItems: 100 });
  const controller = canonicalizeTabIds(controllerInventory?.tabIds, {
    label: 'controllerInventory.tabIds',
    maxItems: 1000,
  });
  const user = canonicalizeTabIds(userInventory?.tabIds, {
    label: 'userInventory.tabIds',
    maxItems: 1000,
  });
  const failureCodes = [];
  const addFailure = (code) => {
    if (!failureCodes.includes(code)) failureCodes.push(code);
  };

  if (controllerInventory?.complete !== true) {
    addFailure(APPLY_TAB_SET_FAILURE_CODES.CONTROLLER_INVENTORY_INCOMPLETE);
  }
  if (userInventory?.complete !== true) {
    addFailure(APPLY_TAB_SET_FAILURE_CODES.USER_INVENTORY_INCOMPLETE);
  }
  if (expected.length === 0) addFailure(APPLY_TAB_SET_FAILURE_CODES.EXPECTED_SET_EMPTY);
  if (expected.length > 0 && keep.length === 0) {
    addFailure(APPLY_TAB_SET_FAILURE_CODES.KEEP_SET_EMPTY_WITH_EXPECTED_TABS);
  }
  if (hasDuplicates(expected)) addFailure(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_EXPECTED_TAB_ID);
  if (hasDuplicates(keep)) addFailure(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_KEEP_TAB_ID);
  if (hasDuplicates(controller)) addFailure(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_CONTROLLER_TAB_ID);
  if (hasDuplicates(user)) addFailure(APPLY_TAB_SET_FAILURE_CODES.DUPLICATE_USER_TAB_ID);
  if (expected.length !== keep.length) {
    addFailure(APPLY_TAB_SET_FAILURE_CODES.EXPECTED_KEEP_CARDINALITY_MISMATCH);
  }
  if (!sameSet(expected, keep)) addFailure(APPLY_TAB_SET_FAILURE_CODES.EXPECTED_KEEP_SET_MISMATCH);

  const inventoryUnion = new Set([...controller, ...user]);
  if (expected.some((tabId) => !inventoryUnion.has(tabId))) {
    addFailure(APPLY_TAB_SET_FAILURE_CODES.EXPECTED_TAB_MISSING_FROM_INVENTORY_UNION);
  }

  const safeToFinalize = failureCodes.length === 0;
  return {
    safeToFinalize,
    failureCodes,
    expectedCount: expected.length,
    keepCount: keep.length,
    controllerInventoryCount: controller.length,
    userInventoryCount: user.length,
    inventoryUnionCount: inventoryUnion.size,
    canonicalKeepTabIds: safeToFinalize ? keep : [],
  };
}

module.exports = {
  APPLY_TAB_SET_FAILURE_CODES,
  canonicalizeTabId,
  validateApplyTabKeepSet,
};
