'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lintApplicationText } = require('../lib/application-text');

test('application text lint is deterministic, value-free, and honors punctuation policy', () => {
  const text = 'I built the workflow \u2014 and improved it.';
  const blocked = lintApplicationText({ text, emDashPolicy: 'forbid', claimsComplete: true, claims: [] });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.violations.map((item) => item.code), ['em_dash_forbidden']);
  assert.equal(blocked.text, undefined);
  assert.equal(blocked.sha256.length, 64);
  assert.equal(lintApplicationText({ text, emDashPolicy: 'allow', claimsComplete: true, claims: [] }).ok, true);

  const unsupported = lintApplicationText({
    text: 'I increased revenue by 40%.',
    claimsComplete: true,
    claims: [{ claimFingerprint: 'c'.repeat(64), evidenceRefs: [] }],
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.violations[0].code, 'unsupported_claim_reference');
  assert.doesNotMatch(JSON.stringify(unsupported), /revenue/i);
});

test('application text lint counts prohibited phrases without copying the draft', () => {
  const result = lintApplicationText({
    text: 'Very unique and very useful',
    prohibitedPhrases: ['very'],
    claimsComplete: true,
    claims: [],
  });
  assert.deepEqual(result.violations, [{ code: 'prohibited_phrase', count: 2 }]);
  assert.equal(result.text, undefined);
});

test('application text lint fails closed when claim metadata is omitted', () => {
  const result = lintApplicationText({ text: 'I increased revenue by 40%.' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [{ code: 'claim_metadata_required', count: 1 }]);
});

test('application text lint rejects claimsComplete without a claims array', () => {
  const result = lintApplicationText({
    text: 'I increased revenue by 40%.',
    claimsComplete: true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [{ code: 'claim_metadata_required', count: 1 }]);
});

test('application text lint uses locale-independent case folding', () => {
  const original = Intl.DateTimeFormat().resolvedOptions().locale;
  assert.equal(typeof original, 'string');
  const result = lintApplicationText({
    text: 'I built this workflow.',
    prohibitedPhrases: ['i'],
    claimsComplete: true,
    claims: [],
  });
  assert.deepEqual(result.violations, [{ code: 'prohibited_phrase', count: 3 }]);
});
