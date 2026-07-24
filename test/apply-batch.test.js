'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(
  __dirname,
  '..',
  'skills',
  'trackly-apply',
  'SKILL.md',
), 'utf8');
const reference = fs.readFileSync(path.join(
  __dirname,
  '..',
  'skills',
  'trackly-apply',
  'references',
  'batch-orchestration.md',
), 'utf8');
const reviewHandoff = fs.readFileSync(path.join(
  __dirname,
  '..',
  'skills',
  'trackly-apply',
  'references',
  'review-handoff.md',
), 'utf8');

test('main skill requires batch and browser lifecycle contracts on every run', () => {
  assert.match(skill, /references\/batch-orchestration\.md/);
  assert.match(skill, /references\/browser-lifecycle\.md/);
  assert.match(skill, /mandatory even for a one-job batch/i);
});

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
  assert.match(reference, /`trackly_approve_apply_batch_resume`/);
  assert.match(reference, /`trackly_verify_prepared_resume`/);
  assert.match(reference, /`trackly_certify_apply_batch_truth`/);
});

test('batch handoff separates grouped actions from per-run review evidence', () => {
  assert.match(reviewHandoff, /Grouped actions/i);
  assert.match(reviewHandoff, /company.*role.*run.*action type/is);
  assert.match(reviewHandoff, /one\s+review block per run/i);
  assert.match(reviewHandoff, /inspection epoch/i);
  assert.match(reviewHandoff, /truth certification/i);
  assert.match(reviewHandoff, /closure evidence/i);
  assert.match(reviewHandoff, /raw tab identifiers/i);
  assert.match(reviewHandoff, /Never include.*credentials.*OTP.*CAPTCHA/is);
});

test('batch orchestration uses bounded server-owned checkpoint tools', () => {
  assert.match(reference, /`trackly_create_apply_batch`/);
  assert.match(reference, /`trackly_get_apply_batch`/);
  assert.match(reference, /`trackly_claim_apply_batch`/);
  assert.match(reference, /`trackly_checkpoint_apply_batch`/);
  assert.match(reference, /groups of at most 20/i);
  assert.match(reference, /prior inspection epoch.*new inspection epoch/is);
  assert.match(reference, /one to 25 typed actions/i);
  assert.match(reference, /epoch\/version advances once/i);
  assert.match(reference, /Never add raw labels, options, answers,\s+or\s+page\s+text/i);
  assert.match(reference, /`packetPhase: first_pass`/);
  assert.match(reference, /`packetPhase: delta`/);
  assert.match(reference, /per-member conflict does not\s+cancel\s+successful siblings/i);
});
