'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../contracts/trackly-apply-tools.json');

const source = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf8');

function toolArguments(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const registration = new RegExp(`server\\.tool\\(\\s*['"]${escapedName}['"]`).exec(source);
  assert.ok(registration, `${name} is not registered`);
  const open = source.indexOf('(', registration.index);
  const args = [];
  let argStart = open + 1;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let quote = '';
  let escaped = false;
  for (let index = open + 1; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') parens++;
    else if (char === ')' && parens > 0) parens--;
    else if (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if ((char === ',' || char === ')') && parens === 0 && braces === 0 && brackets === 0) {
      args.push(source.slice(argStart, index).trim());
      if (char === ')') break;
      argStart = index + 1;
    }
  }
  return args;
}

const normalizeSchema = (schema) => schema.replace(/\s+/g, '').replace(/,([}\]])/g, '$1');

test('local MCP Apply schemas match each complete versioned input schema', () => {
  assert.equal(contract.contractVersion, '3.2.0');
  for (const [name, expectedSchema] of Object.entries(contract.tools)) {
    const localSchema = typeof expectedSchema === 'string' ? expectedSchema : expectedSchema.local;
    assert.equal(normalizeSchema(toolArguments(name)[2]), localSchema, `${name} schema drifted`);
  }
});

test('versioned contract owns the exact Apply scenario and browser-surface enums', () => {
  assert.deepEqual(contract.constants.applyScenarioCodes, [
    'browser_reclaim', 'resume_upload', 'resume_parser_recheck', 'semantic_boolean_commit',
    'custom_select_commit', 'multi_step_navigation', 'free_text_voice',
    'required_error_sweep', 'final_consent', 'handoff_reclaim',
    'critical_contact_integrity', 'manual_submit_boundary', 'job_identity_match',
  ]);
  assert.deepEqual(contract.constants.applyBrowserSurfaces, [
    'codex_in_app', 'chrome_extension', 'claude_in_chrome',
  ]);
  assert.match(source, /const APPLY_SCENARIO_CODES = APPLY_CONTRACT\.constants\.applyScenarioCodes/);
  assert.match(source, /const APPLY_BROWSER_SURFACES = APPLY_CONTRACT\.constants\.applyBrowserSurfaces/);
});

test('Apply contract owns value-free bulk checkpoint semantics', () => {
  assert.deepEqual(contract.constants.applyCheckpointActionCodes, [
    'answer/unknown',
    'auth/sign_in',
    'auth/otp',
    'captcha/before_form',
    'captcha/at_submit',
    'artifact/upload_required',
    'legal/decision_required',
    'consent/decision_required',
    'review/manual_submit',
    'trust/origin_mismatch',
    'observability/unverifiable_state',
  ]);
  assert.deepEqual(contract.constants.applyCheckpointPacketPhases, ['first_pass', 'delta']);
  const schema = normalizeSchema(toolArguments('trackly_checkpoint_apply_batch')[2]);
  assert.match(schema, /checkpoints:z\.array\(z\.object\(/);
  assert.match(schema, /actions:z\.array\(z\.object\(/);
  assert.match(schema, /actions:.*\.min\(1\)\.max\(25\)/);
  assert.match(schema, /inspectionEpoch:.*packetPhase:.*knownFieldsCommitted:.*actions:/);
  assert.match(schema, /\.min\(1\)\.max\(20\)/);
  assert.match(schema, /expectedMemberVersion/);
  assert.match(schema, /expectedInspectionEpoch/);
  assert.match(schema, /inspectionEpoch/);
  assert.match(schema, /continuationAllowed/);
  assert.match(schema, /fieldFingerprint/);
  assert.match(schema, /knownFieldsCommitted/);
  assert.match(schema, /idempotencyKey/);
  assert.doesNotMatch(
    schema,
    /questionLabel|fieldLabel|rawLabel|options|answerValue|credential|captchaText|pageText/i,
  );
  assert.match(source, /\/api\/jobscout\/apply\/batches\/\$\{batchId\}\/checkpoints/);
});

test('Apply contract binds recovered surfaces and proves close from three current-epoch facts', () => {
  assert.deepEqual(contract.constants.applySurfaceBindingReasons, [
    'initial_binding', 'recovery_binding',
  ]);
  assert.deepEqual(contract.constants.applySurfaceEvidenceTypes, [
    'surface_inventory_reconciled',
    'surface_missing',
    'surface_close_attempted',
    'surface_close_receipt',
    'surface_post_close_absent',
    'surface_close_failed',
  ]);
  assert.deepEqual(contract.constants.applySurfaceOwnershipStates, [
    'controller_owned', 'user_owned', 'controller_user_union', 'unresolved',
  ]);

  const bindingSchema = normalizeSchema(toolArguments('trackly_bind_apply_surface')[2]);
  assert.match(bindingSchema, /memberId/);
  assert.match(bindingSchema, /runId/);
  assert.match(bindingSchema, /expectedMemberVersion/);
  assert.match(bindingSchema, /expectedInspectionEpoch/);
  assert.match(bindingSchema, /browserBindingHash/);
  assert.match(bindingSchema, /bindingReason:z\.enum\(APPLY_SURFACE_BINDING_REASONS\)/);

  const evidenceSchema = normalizeSchema(
    toolArguments('trackly_record_apply_surface_evidence')[2],
  );
  assert.match(evidenceSchema, /ownershipState:z\.enum\(APPLY_SURFACE_OWNERSHIP_STATES\)/);
  assert.match(evidenceSchema, /completeInventory:z\.boolean\(\)/);
  assert.match(evidenceSchema, /evidenceType:z\.enum\(APPLY_SURFACE_EVIDENCE_TYPES\)/);
  assert.doesNotMatch(evidenceSchema, /rawTabId|tabUrl|pageText|questionText|answerValue/i);
  assert.match(source, /never creates a replacement run/i);
  assert.match(source, /complete controller\+user union inventory/i);
});

test('Apply contract separates exact resume approval from late truth certification', () => {
  const resumeSchema = normalizeSchema(toolArguments('trackly_approve_apply_batch_resume')[2]);
  assert.match(resumeSchema, /membershipHash/);
  assert.match(resumeSchema, /resumeId/);
  assert.match(resumeSchema, /resumeSha256/);
  assert.match(resumeSchema, /resumeFilename/);
  assert.match(resumeSchema, /resumeSizeBytes/);
  assert.match(resumeSchema, /memberRuns:z\.array\(z\.object\(/);
  assert.doesNotMatch(resumeSchema, /answerSnapshotHash|wordingFingerprint/);

  const truthSchema = normalizeSchema(toolArguments('trackly_certify_apply_batch_truth')[2]);
  assert.match(truthSchema, /answerSnapshotHash/);
  assert.match(truthSchema, /wordingFingerprint/);
  assert.match(truthSchema, /inspectionEpoch/);
  assert.doesNotMatch(truthSchema, /resumeFilename|resumeSizeBytes/);
  assert.match(source, /\/resume-approval/);
  assert.match(source, /\/truth-certification/);
  assert.match(source, /never becomes a profile answer/i);
});

test('local MCP freezes, reads, claims, and binds server-owned batches', () => {
  const createRegion = source.slice(
    source.indexOf("'trackly_create_apply_batch'"),
    source.indexOf("'trackly_get_apply_batch'"),
  );
  const claimRegion = source.slice(
    source.indexOf("'trackly_claim_apply_batch'"),
    source.indexOf("'trackly_checkpoint_apply_batch'"),
  );
  const runSchema = normalizeSchema(toolArguments('trackly_start_apply_run')[2]);

  assert.match(createRegion, /\/api\/jobscout\/apply\/batches/);
  assert.match(createRegion, /'Idempotency-Key': idempotencyKey/);
  assert.match(claimRegion, /expectedRevision/);
  assert.match(claimRegion, /leaseToken/);
  for (const key of [
    'batchId',
    'memberId',
    'expectedMemberVersion',
    'expectedInspectionEpoch',
    'leaseToken',
  ]) {
    assert.match(runSchema, new RegExp(`${key}:`));
  }
});

test('Apply skill emits value-free beta evidence for contact integrity and the manual-submit boundary', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  const coverage = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'references', 'scenario-coverage.md'), 'utf8');

  assert.match(skill, /`critical_contact_integrity`/);
  assert.match(skill, /`manual_submit_boundary`/);
  assert.match(skill, /`job_identity_match`/);
  assert.match(skill, /after every navigation or redirect and before entering any additional private data/);
  assert.match(skill, /require both `originPolicy\.tenantRule` and `originPolicy\.verifiedAtsTenant` to be non-null/);
  assert.match(skill, /report both universal evidence scenarios before every `review_ready` outcome/);
  assert.match(coverage, /never include email, phone, applicant name, answer values, page text, or local paths/);
});

test('local MCP has no uncontracted Trackly Apply tools', () => {
  const names = [...source.matchAll(/server\.tool\(\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((name) => name.includes('apply') || name.includes('application_profile') || name.includes('application_outcome') || name.includes('profile_onboarding') || name === 'trackly_prepare_resume' || name === 'trackly_verify_prepared_resume')
    .sort();
  assert.deepEqual(names, Object.keys(contract.tools).sort());
});

test('Apply contract makes maintenance resumable without duplicate runs or submission', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  assert.match(skill, /Treat maintenance as resumable, never retryable/);
  assert.match(skill, /Do not call `trackly_start_apply_run` again/);
  assert.match(skill, /refetch `trackly_get_apply_protocol` and the application profile/);
  assert.match(skill, /Never click Submit/);

  assert.match(source, /If maintenance interrupts an existing run, do not call this tool again/);
  assert.match(source, /resume the existing agent_browser run/);
  assert.match(source, /Never start a duplicate run, blindly retry a mutation,.*or click Submit/);
});

test('Apply skill treats background-check authorization as explicit reusable consent', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  assert.match(skill, /`consent\.background_check_if_advanced`/);
  assert.match(skill, /only when the form explicitly asks for consent to a background check if the candidate advances/);
  assert.match(skill, /If it is unknown, ask before selecting it/);
  assert.match(skill, /save the answer at the user's chosen scope/);
  assert.match(skill, /Never infer it from privacy, demographic, recruiting-data, general application, criminal-record, or professional-reference consent/);
  assert.match(skill, /Treat the latter two as separate unknown consent questions/);
});

test('Apply skill maps boolean answers semantically and verifies the canonical value', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  const integrity = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'references', 'form-integrity.md'), 'utf8');

  assert.match(skill, /`true` to Yes, `false` to No/);
  assert.match(skill, /never by option order, index, proximity, or a stale prior selection/);
  assert.match(skill, /compare the committed value with the canonical Trackly value/);
  assert.match(skill, /If the field is required or had a validation error before selection/);
  assert.match(skill, /An optional control with no validation error passes when its committed value is correct/);
  assert.match(integrity, /Never choose a boolean option by index, DOM order, keyboard offset, proximity, or previous control state/);
  assert.match(integrity, /semantic opposite of the canonical value/);
  assert.match(integrity, /An optional control that never had a validation error passes when its committed value is correct/);
});

test('Apply skill freezes and completes every member of an explicitly requested batch', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');

  assert.match(skill, /freeze the deterministic ordered set of exactly `N` job IDs/);
  assert.match(skill, /Do not replace, rescore, or expand that approved batch/);
  assert.match(skill, /job ID -> application run ID -> browser tab mapping/);
  assert.match(skill, /conditional resume preparation\/confirmation\/verification when an upload control exists/);
  assert.match(skill, /for every member/);
  assert.match(skill, /show and verify each member's exact path, size, hash, run ID, and expiration/);
  assert.match(skill, /only for the frozen job\/run\/tab set/);
  assert.match(skill, /a run falls outside the frozen batch/);
  assert.match(skill, /preserve the current review-ready tab and continue the same lifecycle for the next mapped batch member/);
  assert.match(skill, /stop only after every frozen member is review-ready/);
  assert.match(skill, /one review block per run/);
});

test('Apply skill proves semantic browser readiness before preparing resume bytes', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  const integrity = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'references', 'form-integrity.md'), 'utf8');

  assert.match(skill, /browser readiness gate/);
  assert.match(skill, /Codex in-app browser controls, Chrome MCP\/extension browser control, or Claude in Chrome/);
  assert.match(skill, /discover or reclaim every target tab/);
  assert.match(skill, /exact employer, role, ATS, requisition URL, job ID, and run ID/);
  assert.match(skill, /Do not call `trackly_prepare_resume` until this same-run attestation succeeds/);
  assert.match(skill, /`observationType: browser_ready`/);
  assert.match(skill, /`browserBindingHash`/);
  assert.match(skill, /browser surface, and browser binding hash/);
  assert.match(skill, /coordinate-only clicking is forbidden/);
  assert.match(skill, /preserve every existing run and tab mapping/);
  assert.match(skill, /A missing file input is not itself a blocker/);
  assert.match(skill, /If and only if the application offers or requires a resume attachment/);
  assert.match(skill, /skip steps 8–11 and do not report `resume_upload` as exercised/);
  assert.match(integrity, /semantic browser bridge becomes unavailable/);
  assert.match(integrity, /reclaim and re-verify the tab/);
  assert.match(integrity, /A form without a file input skips the resume path/);
});

test('Apply skill scopes learned answers and keeps accuracy certification ephemeral', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');

  assert.match(skill, /`employment\.previously_worked_for_employer`.*company scope/s);
  assert.match(skill, /`employment\.has_close_relationship_at_employer`.*company scope/s);
  assert.match(skill, /`location\.requires_relocation_assistance`.*global scope/s);
  assert.match(skill, /`eeo\.gender_identity`.*global scope/s);
  assert.match(skill, /`consent\.future_opportunity_retention`.*company scope/s);
  assert.match(skill, /accuracy or truthfulness certification/);
  assert.match(skill, /Never save that attestation to the reusable profile/);
  assert.match(skill, /ask and verify it on every application run/);
});

test('Apply skill records and reports actual scenario coverage for every run', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  const coverage = fs.readFileSync(path.join(
    __dirname,
    '..',
    'skills',
    'trackly-apply',
    'references',
    'scenario-coverage.md',
  ), 'utf8');
  const review = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'references', 'review-handoff.md'), 'utf8');

  assert.match(skill, /references\/scenario-coverage\.md/);
  assert.match(skill, /`observationType: scenario_coverage`/);
  assert.match(skill, /`observationType: browser_ready`/);
  assert.match(skill, /`metadata\.committed: true`/);
  assert.match(skill, /do not send a duplicate `scenario_coverage` row/);
  assert.match(skill, /actual scenario coverage/);
  assert.match(coverage, /browserSurface/);
  assert.match(coverage, /Every `passed` or `corrected` scenario requires `true`/);
  assert.match(coverage, /A blocked scenario is not scenario-coverage evidence/);
  assert.doesNotMatch(coverage, /`resolutionCode`: `passed`, `corrected`, or `blocked`/);
  assert.match(coverage, /resumedAfterHandoff/);
  assert.match(coverage, /resume_upload/);
  assert.match(coverage, /required_error_sweep/);
  assert.match(coverage, /final_consent/);
  assert.match(review, /Actual scenario coverage:/);
});

test('Apply observation contract accepts redacted browser scenario metadata', () => {
  const schema = normalizeSchema(toolArguments('trackly_report_apply_observation')[2]);

  assert.match(schema, /runId:z\.number\(\)\.int\(\)\.min\(1\),/);
  assert.match(schema, /scenarioCode:z\.enum\(APPLY_SCENARIO_CODES\)/);
  assert.match(schema, /browserSurface:z\.enum\(APPLY_BROWSER_SURFACES\)/);
  assert.match(schema, /committed:z\.boolean\(\)/);
  assert.match(schema, /browserBindingHash:z\.string\(\)\.regex\(\/\^\[a-f0-9\]\{64\}\$\/\)\.optional\(\)/);
  assert.match(schema, /resumedAfterHandoff:z\.boolean\(\)\.optional\(\)/);
  assert.doesNotMatch(schema, /answerValue|pageText/);
});

test('Apply MCP prompt gates resume preparation on the same browser binding', () => {
  const browserGate = source.indexOf('Reclaim semantic browser control');
  const prepare = source.indexOf('prepare the run-bound resume locally', browserGate);
  assert.ok(browserGate > 0);
  assert.ok(prepare > browserGate);
  assert.match(source.slice(browserGate, prepare), /browser_ready attestation/);
});

test('Apply MCP evidence preserves custom bounds and prompt rejects pre-3.1 protocols', () => {
  const evidenceRegion = source.slice(
    source.indexOf("'trackly_get_apply_evidence'"),
    source.indexOf("'trackly_get_apply_protocol'"),
  );
  const promptRegion = source.slice(
    source.indexOf("server.registerPrompt('trackly-apply'"),
    source.indexOf("server.registerResource('trackly-apply-protocol'"),
  );

  assert.match(evidenceRegion, /const query = qs\.toString\(\)/);
  assert.match(evidenceRegion, /const suffix = query \? `\?\$\{query\}` : ''/);
  assert.match(promptRegion, /before starting a new run, require the fetched Trackly Apply protocol to be version 3\.1\.0 or newer/);
  assert.match(promptRegion, /After trackly_start_apply_run returns, or before resuming an existing run, require the returned or stored run\.protocolVersion to be version 3\.1\.0 or newer/);
});

test('Apply skill 4.1 requires protocol 3.1 or newer and skill major 4', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  assert.match(skill, /Skill 4\.1 requires protocol major 3 \(version 3\.1\.0 or newer\)/);
  assert.match(skill, /`compatibleSkillMajor: 4`/);
  assert.match(skill, /pre-evidence skill or run/);
  assert.match(skill, /Never continue a pre-evidence 3\.0\.x run under skill 4\.1/);
  assert.match(skill, /Preserve that run instead of starting a replacement/);
});

test('Apply skill consumes backend ATS capabilities and enforces guided stop conditions', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  const playbook = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'references', 'ats-playbook.md'), 'utf8');
  assert.match(skill, /backend-owned `atsCapability`, `originPolicy`, and `executionBlocker`/);
  assert.match(skill, /Stop before `trackly_start_apply_run` whenever `executionBlocker` is non-null/);
  assert.match(skill, /Unknown employer forms use the protocol's `unknownAtsFallback` only when/);
  assert.match(skill, /LinkedIn-hosted applications are manual-only/);
  assert.match(skill, /corresponding same-run committed evidence/);
  assert.match(skill, /host === allowedDomain/);
  assert.match(skill, /host\.endsWith\("\." \+ allowedDomain\)/);
  assert.match(skill, /originPolicy\.tenantRule/);
  assert.match(skill, /originPolicy\.verifiedAtsTenant/);
  assert.match(skill, /never invent or reinterpret a strategy token/);
  assert.match(skill, /`trackly_employer_source_exact_origin`/);
  assert.match(skill, /never convert it into a hostname suffix or carry it across a redirect or iframe origin change/);
  assert.match(playbook, /Guided enterprise ATS/);
  assert.match(playbook, /Guided mid-market ATS/);
  assert.match(playbook, /Unknown employer-hosted form/);
  assert.match(playbook, /Do not automate LinkedIn-hosted applications/);
});

test('Apply skill treats missing education months as unknown instead of inferring defaults', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');

  assert.match(skill, /Treat partial dates as unknown at the missing precision/);
  assert.match(skill, /ask once and sync the complete date/);
  assert.match(skill, /Never accept an ATS-selected current\/default month or infer an education month/);
});

test('Apply skill reconciles contradictory ATS submission states without retrying Submit', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  const integrity = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'references', 'form-integrity.md'), 'utf8');

  assert.match(skill, /contradictory ATS response such as “already applied” as provisional/);
  assert.match(skill, /Do not click Submit again/);
  assert.match(skill, /explicit success state on that same requisition overrides the provisional error/);
  assert.match(integrity, /exact requisition identifier are unchanged/);
  assert.match(integrity, /Without success or explicit user confirmation, record blocked/);
});

test('Apply skill calibrates free-text answers without requiring an external humanizer', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'SKILL.md'), 'utf8');
  const writing = fs.readFileSync(path.join(__dirname, '..', 'skills', 'trackly-apply', 'references', 'application-writing.md'), 'utf8');

  assert.match(skill, /Do not require a separate writing or humanizer skill/);
  assert.match(writing, /`writing\.voice_sample` and `writing\.style_instructions`/);
  assert.match(writing, /never block an application run when they are unknown/);
  assert.match(writing, /ask once before drafting and synchronize the answer/);
  assert.match(writing, /decline a voice sample/);
  assert.match(writing, /intentionally blank style instructions/);
  assert.match(writing, /continue with the plain default style for the current run/);
  assert.match(writing, /Never copy them into the public skill, logs, observations, or another user's defaults/);
  assert.match(writing, /This gate remains authoritative and self-contained/);
  assert.match(writing, /Use no em dash by default/);
  assert.match(writing, /generic company praise or unsupported enthusiasm/);
  assert.match(writing, /When a voice sample exists, compare the final response with it/);
  assert.match(writing, /When the sample was declined or remains unknown for the current run/);
  assert.match(writing, /use the saved style instructions or plain default instead/);
});
