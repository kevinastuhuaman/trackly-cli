'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const skill = read('skills/trackly-apply/SKILL.md');
const formIntegrity = read('skills/trackly-apply/references/form-integrity.md');
const answerCompounding = read('skills/trackly-apply/references/answer-compounding.md');
const applicationWriting = read('skills/trackly-apply/references/application-writing.md');
const batchOrchestration = read('skills/trackly-apply/references/batch-orchestration.md');

test('skill requires deterministic resolution before generating a user question packet', () => {
  assert.match(skill, /references\/answer-resolution\.md/);
  assert.match(skill, /before (?:generating|building).*question packet/i);
  assert.match(skill, /exact_profile/);
  assert.match(skill, /safe_derivation/);
  assert.match(skill, /supported_draft/);
  assert.match(skill, /missing_fact/);
  assert.match(skill, /live_consent/);
  assert.match(skill, /forbidden_inference/);
});

test('answer resolver implements semantic experience ranges and strict type validation', () => {
  const resolver = read('skills/trackly-apply/references/answer-resolution.md');
  assert.match(resolver, /minimum(?: qualification|\/profile range)/i);
  assert.match(resolver, /exact (?:bounded )?band/i);
  assert.match(resolver, /explicit (?:disqualifying )?maximum/i);
  assert.match(resolver, /7 years.*2[–-]4 years.*Yes/is);
  assert.match(resolver, /no more than 4 years.*No/is);
  assert.match(resolver, /exactly between 2 and 4 years.*No/is);
  assert.match(resolver, /financial-infrastructure years.*(?:yes|Yes).*type mismatch/is);
  assert.match(resolver, /SQL.*C2.*type mismatch/is);
  assert.match(resolver, /English.*C2.*valid/is);
});

test('answer resolver enforces source precedence and legal-name isolation', () => {
  const resolver = read('skills/trackly-apply/references/answer-resolution.md');
  assert.match(resolver, /current profile revision.*(?:transcript|conversation).*screenshot.*parser.*cached/is);
  assert.match(resolver, /ordinary.*name.*canonical first.*last.*casing/is);
  assert.match(resolver, /government[- ]ID.*only.*explicit/is);
  assert.match(resolver, /parser.*never.*authority/is);
  assert.match(resolver, /not_employed.*current.*non-authoritative/is);
  assert.match(resolver, /most_recent_company/);
  assert.match(resolver, /most_recent_title/);
});

test('answer resolver preserves consent boundaries and supported writing', () => {
  const resolver = read('skills/trackly-apply/references/answer-resolution.md');
  assert.match(resolver, /named applicant privacy notice/i);
  assert.match(resolver, /marketing.*retention.*arbitration.*background check.*recording/is);
  assert.match(resolver, /onsite willingness.*does not.*policy.*read/is);
  assert.match(resolver, /truthfulness.*per-run/i);
  assert.match(resolver, /supported_draft.*fill.*final truth/is);
  assert.match(resolver, /explicit gaps/i);
  assert.match(applicationWriting, /supported.*optional.*must not be left blank/is);
});

test('browser integrity treats masked and framework-controlled contacts as automatable', () => {
  assert.match(formIntegrity, /current profile revision/i);
  assert.match(formIntegrity, /transcript|conversation/i);
  assert.match(formIntegrity, /static.*(?:value|attribute).*not.*(?:truth|proof|authority)/is);
  assert.match(formIntegrity, /rendered.*live.*state/is);
  assert.match(formIntegrity, /masked phone/i);
  assert.match(formIntegrity, /autocomplete.*exact.*option.*committed/is);
  assert.match(formIntegrity, /parser.*ordinary.*name.*casing/is);
});

test('answer compounding rejects mismatches and asks reusable gaps only at point of need', () => {
  assert.match(answerCompounding, /expected (?:input )?type/i);
  assert.match(answerCompounding, /mismatch.*unresolved/is);
  assert.match(answerCompounding, /whole number/i);
  assert.match(answerCompounding, /Yes or No/i);
  assert.match(answerCompounding, /visible (?:form|application).*requires/is);
  assert.match(answerCompounding, /never.*coerce/is);
});

test('accessible-first is a hard scheduling invariant before authenticated drafts', () => {
  assert.match(batchOrchestration, /hard (?:scheduler )?invariant/i);
  assert.match(batchOrchestration, /known.*auth(?:entication)?[- ]gated.*must not be opened/is);
  assert.match(batchOrchestration, /accessible candidate remains/i);
  assert.match(batchOrchestration, /minimal non-mutating probe/i);
  assert.match(batchOrchestration, /draft.*(?:must not|never).*start/is);
  assert.match(batchOrchestration, /release.*(?:reservation|capacity)/i);
  assert.match(batchOrchestration, /authParked/);
});
