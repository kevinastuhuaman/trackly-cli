#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256ExactBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function schemaDefinitionBounds(source, name, sourcePath) {
  const declaration = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(source);
  assert.ok(declaration, `${name} is missing from ${sourcePath}`);
  const start = declaration.index + declaration[0].length;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (char === ';' && parens === 0 && braces === 0 && brackets === 0) {
      return { declarationStart: declaration.index, expressionStart: start, semicolon: index };
    }
  }
  assert.fail(`${name} is unterminated in ${sourcePath}`);
}

function schemaDefinition(source, name, sourcePath) {
  const bounds = schemaDefinitionBounds(source, name, sourcePath);
  return source.slice(bounds.expressionStart, bounds.semicolon).trim();
}

function exactSchemaDefinition(source, name, sourcePath) {
  const bounds = schemaDefinitionBounds(source, name, sourcePath);
  return source.slice(bounds.declarationStart, bounds.semicolon + 1);
}

function verifyHostedContract() {
const cliRoot = path.join(__dirname, '..');
const backendCandidates = process.env.TRACKLY_BACKEND_DIR
  ? [path.resolve(process.env.TRACKLY_BACKEND_DIR)]
  : [
      path.resolve(cliRoot, '..', 'backend'),
      path.resolve(cliRoot, '..', 'granola-followup-app'),
      path.join(require('node:os').homedir(), 'closeai', 'granola-followup-app'),
    ];
const localContractPath = path.join(cliRoot, 'contracts', 'trackly-apply-tools.json');
const localApplySourcePath = path.join(cliRoot, 'mcp', 'apply-tools.js');
const backendRoot = backendCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'contracts', 'trackly-apply-tools.json')))
  || backendCandidates[0];
const hostedContractPath = path.join(backendRoot, 'contracts', 'trackly-apply-tools.json');
const hostedApplySourcePath = path.join(backendRoot, 'src', 'mcp', 'server.ts');
const hostedPluginContractPath = path.join(backendRoot, 'contracts', 'trackly-plugin-tools.json');
const hostedPluginSourcePath = path.join(backendRoot, 'src', 'mcp', 'plugin-server.ts');
const hostedPluginScopesPath = path.join(backendRoot, 'src', 'mcp', 'plugin-scopes.ts');
const hostedApplyExecutionContractPath = path.join(backendRoot, 'src', 'services', 'application-profile', 'apply-execution-contract.ts');
const hostedApplicationProfileServicePath = path.join(backendRoot, 'src', 'services', 'application-profile', 'service.ts');
const hostedJobscoutFilterUtilsPath = path.join(backendRoot, 'src', 'routes', 'jobscout-filter-utils.ts');
const pluginLockPath = path.join(cliRoot, 'plugins', 'trackly', 'skill-lock.json');

if (!fs.existsSync(hostedContractPath)) {
  throw new Error(`Hosted contract not found at ${hostedContractPath}. Set TRACKLY_BACKEND_DIR to the close-ai checkout.`);
}
if (!fs.existsSync(hostedPluginContractPath)) {
  throw new Error(`Hosted plugin contract not found at ${hostedPluginContractPath}. Set TRACKLY_BACKEND_DIR to a plugin-capable close-ai checkout.`);
}

const local = JSON.parse(fs.readFileSync(localContractPath, 'utf8'));
const localApplySource = fs.readFileSync(localApplySourcePath, 'utf8');
const hosted = JSON.parse(fs.readFileSync(hostedContractPath, 'utf8'));
const hostedApplySource = fs.readFileSync(hostedApplySourcePath, 'utf8');
const hostedPluginContract = JSON.parse(fs.readFileSync(hostedPluginContractPath, 'utf8'));
const pluginLock = JSON.parse(fs.readFileSync(pluginLockPath, 'utf8'));

if (
  hostedPluginContract === null
  || typeof hostedPluginContract !== 'object'
  || Array.isArray(hostedPluginContract)
  || hostedPluginContract.tools === null
  || typeof hostedPluginContract.tools !== 'object'
  || Array.isArray(hostedPluginContract.tools)
) {
  throw new Error(
    `Hosted plugin contract at ${hostedPluginContractPath} must contain a top-level "tools" JSON object before tool parity can be verified.`,
  );
}
const hostedPluginSource = fs.readFileSync(hostedPluginSourcePath, 'utf8');
const hostedPluginScopesSource = fs.readFileSync(hostedPluginScopesPath, 'utf8');
const hostedApplyExecutionContractSource = fs.readFileSync(hostedApplyExecutionContractPath, 'utf8');
const hostedApplicationProfileServiceSource = fs.readFileSync(hostedApplicationProfileServicePath, 'utf8');
const hostedJobscoutFilterUtilsSource = fs.readFileSync(hostedJobscoutFilterUtilsPath, 'utf8');

const LOCAL_ONLY_TOOLS = [
  'trackly_lint_application_text',
  'trackly_diagnose_local_path',
];

for (const constantName of [
  'applyExecutionMaxTarget',
  'applyBrowserSurfaces',
  'applyAccessClassifications',
  'applyExecutionDispositionSources',
  'applyExecutionStopReasonCodes',
  'applyProbeCleanupPreferences',
]) {
  assert.deepEqual(
    hosted.constants[constantName],
    local.constants[constantName],
    `${constantName} drifted between hosted and local execution contracts`,
  );
}
assert.equal(
  local.tools.trackly_record_apply_execution_dispositions,
  hosted.tools.trackly_record_apply_execution_dispositions,
  'trackly_record_apply_execution_dispositions schema alias drifted',
);
for (const toolName of LOCAL_ONLY_TOOLS) {
  assert.ok(local.tools[toolName], `${toolName} is missing from the local contract`);
  assert.equal(hosted.tools[toolName], undefined, `${toolName} must not be advertised by hosted MCP`);
  assert.doesNotMatch(hostedApplySource, new RegExp(`['"]${toolName}['"]`), `${toolName} must not be registered by hosted MCP`);
}
const sharedLocal = {
  ...local,
  tools: Object.fromEntries(Object.entries(local.tools).filter(([name]) => !LOCAL_ONLY_TOOLS.includes(name))),
};
assert.deepEqual(hosted, sharedLocal, 'Hosted and local Trackly Apply MCP contracts drifted outside documented local-only tools');
assert.match(
  local.tools.trackly_record_apply_execution_dispositions,
  /applyExecutionDispositionSchema/,
  'Disposition tool must reference the named executable schema',
);

const hostedPluginTools = Object.keys(hostedPluginContract.tools).sort();
const executablePluginTools = [...hostedPluginSource.matchAll(/\bregisterPluginTool\(\s*['"]([^'"]+)['"]/g)]
  .map((match) => match[1]);
const sortedExecutablePluginTools = [...executablePluginTools].sort();
assert.equal(hostedPluginContract.contractVersion, '1.0.0');
assert.deepEqual(
  hostedPluginContract.lifecycle,
  pluginLock.publicLifecycleContract,
  'Executable hosted plugin lifecycle drifted from the packaged public lifecycle contract',
);
for (const [toolName, scopes] of Object.entries(pluginLock.publicScopeContract)) {
  assert.deepEqual(
    hostedPluginContract.tools[toolName],
    scopes,
    `${toolName} scopes drifted from the packaged public scope contract`,
  );
}
const executableScopeDefinition = schemaDefinition(
  hostedPluginScopesSource,
  'TRACKLY_PLUGIN_TOOL_SCOPES',
  hostedPluginScopesPath,
);
const executableScopeContract = Object.fromEntries(
  [...executableScopeDefinition.matchAll(/^\s*(trackly_[a-z0-9_]+):\s*\[([^\]]*)\]/gm)]
    .map((match) => [
      match[1],
      [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map((scope) => scope[1]),
    ]),
);
assert.deepEqual(
  executableScopeContract,
  pluginLock.publicScopeContract,
  'All executable hosted plugin scope mappings must match the packaged public scope lock',
);
assert.deepEqual(
  hostedPluginTools,
  [...pluginLock.publicToolAllowlist].sort(),
  'Hosted plugin contract tools drifted from the packaged public facade allowlist',
);
assert.equal(
  new Set(executablePluginTools).size,
  executablePluginTools.length,
  'Executable hosted plugin source registers a public tool name more than once',
);
assert.deepEqual(
  sortedExecutablePluginTools,
  [...pluginLock.publicToolAllowlist].sort(),
  'Executable hosted plugin registrations drifted from the packaged public facade allowlist',
);
assert.deepEqual(
  sortedExecutablePluginTools,
  hostedPluginTools,
  'Executable hosted plugin registrations drifted from the hosted plugin contract',
);
assert.deepEqual(
  Object.keys(pluginLock.publicScopeContract).sort(),
  hostedPluginTools,
  'Packaged public scope lock must cover every hosted plugin tool',
);
assert.ok(
  executablePluginTools.every((name) => !/referral|contact|outreach|trackly_chat|(?:^|_)submit(?:_|$)/.test(name)),
  'Hosted plugin must not expose referral, contact, outreach, or agent-in-agent tools',
);
assert.ok(
  !executablePluginTools.includes('trackly_submit_application'),
  'Hosted plugin must not expose an application submission tool',
);

function pluginToolDefinition(name) {
  const marker = `registerPluginTool('${name}'`;
  const start = hostedPluginSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} is missing from ${hostedPluginSourcePath}`);
  const next = hostedPluginSource.indexOf("registerPluginTool('", start + marker.length);
  return hostedPluginSource.slice(start, next === -1 ? hostedPluginSource.length : next);
}

function topLevelCallArguments(callSource, name) {
  const open = callSource.indexOf('(');
  assert.notEqual(open, -1, `${name} registration has no argument list`);
  const argumentsList = [];
  let start = open + 1;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < callSource.length; index++) {
    const char = callSource[index];
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
    else if (char === ',' && parens === 0 && braces === 0 && brackets === 0) {
      argumentsList.push(callSource.slice(start, index).trim());
      start = index + 1;
    } else if (char === ')' && parens === 0 && braces === 0 && brackets === 0) {
      argumentsList.push(callSource.slice(start, index).trim());
      return argumentsList;
    }
  }
  assert.fail(`${name} registration has an unterminated argument list`);
}

const executableRegistrationArguments = Object.fromEntries(executablePluginTools.map((name) => {
  const args = topLevelCallArguments(pluginToolDefinition(name), name);
  assert.ok(args.length >= 3, `${name} registration must contain name, descriptor, and handler`);
  return [name, args];
}));
const executableDescriptorDigests = Object.fromEntries(
  executablePluginTools.map((name) => [name, sha256ExactBytes(executableRegistrationArguments[name][1])]),
);
assert.deepEqual(
  executableDescriptorDigests,
  pluginLock.publicExecutableContract.descriptorSha256,
  'Executable hosted plugin descriptors or inline schemas drifted from the packaged exact-byte digest lock',
);
const executableHandlerDigests = Object.fromEntries(
  executablePluginTools.map((name) => [name, sha256ExactBytes(executableRegistrationArguments[name][2])]),
);
assert.deepEqual(
  executableHandlerDigests,
  pluginLock.publicExecutableContract.handlerSha256,
  'Executable hosted plugin handler implementations drifted from the packaged exact-byte behavior digest lock',
);
assert.equal(
  sha256ExactBytes(hostedPluginSource),
  pluginLock.publicExecutableContract.pluginServerSha256,
  'Hosted plugin server implementation drifted from the packaged whole-source digest lock',
);

const executableSchemaDigests = Object.fromEntries(
  Object.keys(pluginLock.publicExecutableContract.schemaSha256).map((schemaName) => [
    schemaName,
    sha256ExactBytes(schemaDefinition(hostedPluginSource, schemaName, hostedPluginSourcePath)),
  ]),
);
assert.deepEqual(
  executableSchemaDigests,
  pluginLock.publicExecutableContract.schemaSha256,
  'Executable hosted plugin shared output schemas drifted from the packaged exact-byte digest lock',
);

const transitiveSources = {
  APPLY_EXECUTION_MAX_TARGET: [hostedApplyExecutionContractSource, hostedApplyExecutionContractPath],
  APPLY_EXECUTION_ACCESS_CLASSIFICATIONS: [hostedApplyExecutionContractSource, hostedApplyExecutionContractPath],
  APPLY_EXECUTION_STOP_REASON_CODES: [hostedApplyExecutionContractSource, hostedApplyExecutionContractPath],
  APPLY_BROWSER_SURFACES: [hostedApplyExecutionContractSource, hostedApplyExecutionContractPath],
  APPLY_SCENARIO_CODES: [hostedApplicationProfileServiceSource, hostedApplicationProfileServicePath],
  ALL_JOB_FUNCTIONS: [hostedJobscoutFilterUtilsSource, hostedJobscoutFilterUtilsPath],
};
const executableTransitiveDigests = Object.fromEntries(
  Object.keys(pluginLock.publicExecutableContract.transitiveSchemaSha256).map((constantName) => {
    const sourceEntry = transitiveSources[constantName];
    assert.ok(sourceEntry, `Unknown transitive public schema constant ${constantName}`);
    return [constantName, sha256ExactBytes(schemaDefinition(sourceEntry[0], constantName, sourceEntry[1]))];
  }),
);
assert.deepEqual(
  executableTransitiveDigests,
  pluginLock.publicExecutableContract.transitiveSchemaSha256,
  'Executable hosted plugin transitive schema constants drifted from the packaged exact-byte digest lock',
);

const namedApplySchemaSources = {
  localMcpApplyTools: [localApplySource, localApplySourcePath],
  hostedMcpServer: [hostedApplySource, hostedApplySourcePath],
};
const executableNamedApplySchemaDigests = Object.fromEntries(
  Object.entries(pluginLock.publicExecutableContract.namedApplySchemaSha256).map(([side, lockedDigests]) => {
    const sourceEntry = namedApplySchemaSources[side];
    assert.ok(sourceEntry, `Unknown named Apply schema source ${side}`);
    return [
      side,
      Object.fromEntries(Object.keys(lockedDigests).map((schemaName) => [
        schemaName,
        sha256ExactBytes(exactSchemaDefinition(sourceEntry[0], schemaName, sourceEntry[1])),
      ])),
    ];
  }),
);
assert.deepEqual(
  executableNamedApplySchemaDigests,
  pluginLock.publicExecutableContract.namedApplySchemaSha256,
  'Named local and hosted Apply schemas drifted from the packaged exact-byte digest lock',
);

const readinessSchema = schemaDefinition(
  hostedPluginSource,
  'readinessOutputSchema',
  hostedPluginSourcePath,
);
const profileFieldReferenceSchema = schemaDefinition(
  hostedPluginSource,
  'profileFieldReferenceSchema',
  hostedPluginSourcePath,
);
assert.match(readinessSchema, /missingRequired/);
assert.match(readinessSchema, /availableFields/);
assert.match(readinessSchema, /missingRequired: z\.array\(profileFieldReferenceSchema\)\.max\(100\)/);
assert.match(readinessSchema, /availableFields: z\.array\(profileFieldReferenceSchema\)\.max\(100\)/);
assert.match(profileFieldReferenceSchema, /key: z\.string\(\)\.min\(1\)\.max\(200\)/);
assert.match(profileFieldReferenceSchema, /label: z\.string\(\)\.min\(1\)\.max\(1000\)/);

const applySchema = schemaDefinition(
  hostedPluginSource,
  'applyOutputSchema',
  hostedPluginSourcePath,
);
for (const field of [
  'activeTarget', 'batchId', 'memberIds', 'nextAction',
  'use_active_target', 'advance_or_refresh', 'restart_after_reauthorization',
]) {
  assert.match(applySchema, new RegExp(`\\b${field}\\b`), `Apply output is missing ${field}`);
}
assert.doesNotMatch(applySchema, /\bleaseToken\b/);
const startOrResume = pluginToolDefinition('trackly_start_or_resume_apply');
for (const marker of ['browserSurface', 'plugin-prepare']) {
  assert.match(startOrResume, new RegExp(marker.replaceAll('/', '\\/')));
}
assert.match(startOrResume, /browserSurface: z\.enum\(APPLY_BROWSER_SURFACES\)/);
assert.doesNotMatch(startOrResume, /\bleaseToken\b|\/claim|\/api\/jobscout\/apply\/runs/);

const getWork = pluginToolDefinition('trackly_get_apply_work');
assert.match(getWork, /annotations: mutationAnnotations\(\)/);
assert.match(getWork, /plugin-work/);
assert.match(getWork, /memberIds: z\.array\(z\.number\(\)\.int\(\)\.min\(1\)\)\.min\(1\)/);
assert.match(getWork, /profileKeys: z\.array\(z\.string\(\)\.min\(1\)\.max\(200\)\)\.max\(100\)\.optional\(\)/);
assert.doesNotMatch(getWork, /readOnlyAnnotations/);

const progress = pluginToolDefinition('trackly_report_apply_progress');
assert.match(progress, /plugin-observations\/bulk/);
assert.doesNotMatch(progress, /\bleaseToken\b/);
const progressSchema = schemaDefinition(
  hostedPluginSource,
  'progressOutputSchema',
  hostedPluginSourcePath,
);
for (const field of ['success', 'operation', 'recordedCount', 'noSubmit']) {
  assert.match(progressSchema, new RegExp(`\\b${field}\\b`), `Progress output is missing ${field}`);
}
assert.match(progressSchema, /operation: z\.enum\(\['record_dispositions', 'record_observations', 'advance'\]\)/);
assert.match(progressSchema, /recordedCount: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
assert.match(progressSchema, /noSubmit: z\.literal\(true\)/);
assert.doesNotMatch(progressSchema, /\brunId\b|\bmemberId\b|\bbatchId\b|\bexecutionId\b/);
assert.match(progress, /plugin-work/);

const certify = pluginToolDefinition('trackly_certify_review_ready');
for (const field of [
  'batchId', 'memberId', 'expectedMemberVersion', 'inspectionEpoch',
  'answerSnapshotHash', 'wordingFingerprint', 'resumeDependency',
  'explicitUserTruthConfirmed', 'knownFieldsCommitted', 'idempotencyKey',
]) {
  assert.match(certify, new RegExp(`\\b${field}\\b`), `Review certification is missing ${field}`);
}
assert.match(certify, /plugin-review-ready/);
assert.match(certify, /explicitUserTruthConfirmed: z\.literal\(true\)/);
assert.match(certify, /knownFieldsCommitted: z\.literal\(true\)/);
assert.match(certify, /resumeDependency: z\.literal\('not_applicable'\)/);
assert.doesNotMatch(
  certify,
  /\bresumeId\b|\bresumeSha256\b|\bleaseToken\b|\bmembershipHash\b|\bprofileRevision\b|\bmemberRuns\b|\bexpiresAt\b|\bexplicitUserResumeApproved\b/,
);

const reconcile = pluginToolDefinition('trackly_reconcile_manual_submission');
for (const field of [
  'batchId', 'memberId', 'expectedMemberVersion', 'inspectionEpoch',
  'browserBindingHash', 'evidenceFingerprint', 'idempotencyKey',
  'confirmation', 'explicitUserConfirmed',
]) {
  assert.match(reconcile, new RegExp(`\\b${field}\\b`), `Manual reconciliation is missing ${field}`);
}
assert.match(reconcile, /plugin-manual-submission/);
assert.match(reconcile, /inspectionEpoch: z\.number\(\)\.int\(\)\.min\(1\)/);
assert.match(reconcile, /explicitUserConfirmed: z\.literal\(true\)/);
assert.doesNotMatch(reconcile, /\bleaseToken\b/);

console.log(
  `Trackly Apply MCP contracts match at ${local.contractVersion}; the ${hostedPluginTools.length}-tool public plugin facade matches at ${hostedPluginContract.contractVersion}.`,
);
}

module.exports = { exactSchemaDefinition, schemaDefinition, sha256ExactBytes, verifyHostedContract };

if (require.main === module) {
  verifyHostedContract();
}
