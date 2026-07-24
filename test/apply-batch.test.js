'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reference = fs.readFileSync(path.join(
  __dirname,
  '..',
  'skills',
  'trackly-apply',
  'references',
  'batch-orchestration.md',
), 'utf8');

test('batch orchestration freezes recent-first server membership', () => {
  assert.match(reference, /active.*first/is);
  assert.match(reference, /savedAt.*descending/is);
  assert.match(reference, /job ID.*ascending/is);
  assert.match(reference, /server-frozen/i);
  assert.match(reference, /never replace, rescore, or expand/i);
  assert.match(reference, /saved after the\s+snapshot.*future batch/is);
});

test('batch first pass fills known fields before one grouped question packet', () => {
  assert.match(reference, /fill and verify every known field/i);
  assert.match(reference, /continue to the next frozen member/i);
  assert.match(reference, /one grouped first-pass packet/i);
  assert.match(reference, /company.*role.*run.*action\s+type/is);
  assert.match(reference, /delta packet.*newly\s+revealed/is);
});

test('batch keeps recoverable actions distinct from terminal blockers', () => {
  assert.match(reference, /`needs_input`/);
  assert.match(reference, /Credentials, OTPs,\s+CAPTCHA answers, raw question text, and private answer values/i);
  assert.match(reference, /access CAPTCHA.*before private data/is);
  assert.match(reference, /submit-time CAPTCHA.*`review_ready`/is);
  assert.match(reference, /terminal `blocked`.*trust or observability/is);
});

test('batch mutations require concurrency and replay guards', () => {
  assert.match(reference, /renewable lease/i);
  assert.match(reference, /optimistic.*version/i);
  assert.match(reference, /inspection epoch/i);
  assert.match(reference, /idempotency key/i);
  assert.match(reference, /same key.*different\s+payload.*409/is);
});

test('batch resume approval and truth certification are separate', () => {
  assert.match(reference, /resume approval.*exact content hash/is);
  assert.match(reference, /per-run local path proof/i);
  assert.match(reference, /truth certification.*after final answers/is);
  assert.match(reference, /never.*reusable profile answer/is);
  assert.match(reference, /membership.*profile revision.*resume hash.*answer snapshot.*wording.*inspection epoch change invalidates/is);
});
