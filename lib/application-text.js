'use strict';

const crypto = require('node:crypto');

const EM_DASH = '\u2014';
const GENERIC_PATTERNS = [
  { code: 'generic_ai_filler', pattern: /\b(?:delve|leverage my unique|thrilled to apply|dynamic team|esteemed company)\b/i },
  { code: 'formulaic_contrast', pattern: /\bnot just\b[^.]{0,160}\bbut also\b/i },
];

function lintApplicationText(input = {}) {
  const text = typeof input.text === 'string' ? input.text : '';
  const lowerText = text.toLowerCase();
  const emDashPolicy = input.emDashPolicy || 'forbid';
  const violations = [];
  const add = (code, count = 1) => violations.push({ code, count });

  const emDashCount = [...text].filter((character) => character === EM_DASH).length;
  if (emDashPolicy === 'forbid' && emDashCount > 0) add('em_dash_forbidden', emDashCount);
  if (!['forbid', 'allow_if_voice_sample', 'allow'].includes(emDashPolicy)) add('invalid_em_dash_policy');
  if (emDashPolicy === 'allow_if_voice_sample' && emDashCount > 0 && input.voiceSampleAllowsEmDash !== true) {
    add('em_dash_voice_sample_required', emDashCount);
  }

  for (const { code, pattern } of GENERIC_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    if (matches?.length) add(code, matches.length);
  }

  for (const phrase of input.prohibitedPhrases || []) {
    if (typeof phrase !== 'string' || phrase.length === 0) continue;
    const lowerPhrase = phrase.toLowerCase();
    let count = 0;
    let offset = 0;
    while (offset < lowerText.length) {
      const index = lowerText.indexOf(lowerPhrase, offset);
      if (index < 0) break;
      count += 1;
      offset = index + lowerPhrase.length;
    }
    if (count > 0) add('prohibited_phrase', count);
  }

  if (Number.isInteger(input.maxLength) && input.maxLength >= 0 && text.length > input.maxLength) {
    add('maximum_length_exceeded', text.length - input.maxLength);
  }
  if (Number.isInteger(input.minLength) && input.minLength >= 0 && text.length < input.minLength) {
    add('minimum_length_not_met', input.minLength - text.length);
  }

  if (input.claimsComplete !== true || !Array.isArray(input.claims)) add('claim_metadata_required');
  for (const claim of Array.isArray(input.claims) ? input.claims : []) {
    if (!claim || !/^[a-f0-9]{64}$/.test(claim.claimFingerprint || '') || !Array.isArray(claim.evidenceRefs) || claim.evidenceRefs.length === 0) {
      add('unsupported_claim_reference');
    }
  }

  return {
    ok: violations.length === 0,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    length: text.length,
    policy: { emDashPolicy },
    violations,
  };
}

module.exports = { lintApplicationText };
