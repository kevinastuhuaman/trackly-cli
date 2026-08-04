'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isIso3166Alpha2 } = require('../lib/iso-country-codes');

test('jurisdiction validation accepts ISO countries and rejects reserved placeholders', () => {
  assert.equal(isIso3166Alpha2('US'), true);
  assert.equal(isIso3166Alpha2('ca'), true);
  assert.equal(isIso3166Alpha2(' PE '), true);
  assert.equal(isIso3166Alpha2('XX'), false);
  assert.equal(isIso3166Alpha2('ZZ'), false);
  assert.equal(isIso3166Alpha2('USA'), false);
});
