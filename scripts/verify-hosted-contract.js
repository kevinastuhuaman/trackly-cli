#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cliRoot = path.join(__dirname, '..');
const backendCandidates = process.env.TRACKLY_BACKEND_DIR
  ? [path.resolve(process.env.TRACKLY_BACKEND_DIR)]
  : [
      path.resolve(cliRoot, '..', 'backend'),
      path.resolve(cliRoot, '..', 'granola-followup-app'),
      path.join(require('node:os').homedir(), 'closeai', 'granola-followup-app'),
    ];
const localContractPath = path.join(cliRoot, 'contracts', 'trackly-apply-tools.json');
const backendRoot = backendCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'contracts', 'trackly-apply-tools.json')))
  || backendCandidates[0];
const hostedContractPath = path.join(backendRoot, 'contracts', 'trackly-apply-tools.json');
const localApplySourcePath = path.join(cliRoot, 'mcp', 'apply-tools.js');
const hostedApplySourcePath = path.join(backendRoot, 'src', 'mcp', 'server.ts');

if (!fs.existsSync(hostedContractPath)) {
  throw new Error(`Hosted contract not found at ${hostedContractPath}. Set TRACKLY_BACKEND_DIR to the close-ai checkout.`);
}

const local = JSON.parse(fs.readFileSync(localContractPath, 'utf8'));
const hosted = JSON.parse(fs.readFileSync(hostedContractPath, 'utf8'));
const localApplySource = fs.readFileSync(localApplySourcePath, 'utf8');
const hostedApplySource = fs.readFileSync(hostedApplySourcePath, 'utf8');
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

function schemaDefinition(source, name, sourcePath) {
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
      return source.slice(start, index).trim();
    }
  }
  assert.fail(`${name} is unterminated in ${sourcePath}`);
}

function conditionAfter(source, anchor, sourcePath) {
  const anchorIndex = source.indexOf(anchor);
  assert.ok(anchorIndex >= 0, `${anchor} is missing from ${sourcePath}`);
  const ifIndex = source.indexOf('if', anchorIndex + anchor.length);
  const start = source.indexOf('(', ifIndex);
  assert.ok(ifIndex >= 0 && start >= 0, `validation condition is missing from ${sourcePath}`);
  let parens = 0;
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
    if (char === '(') parens += 1;
    else if (char === ')') {
      parens -= 1;
      if (parens === 0) return source.slice(start + 1, index).trim();
    }
  }
  assert.fail(`validation condition is unterminated in ${sourcePath}`);
}

const normalizeSchema = (schema) => schema.replace(/\s+/g, '').replace(/,([}\]])/g, '$1');
for (const schemaName of [
  'applyExecutionDispositionSchema',
  'truthCertificationCommon',
]) {
  assert.equal(
    normalizeSchema(schemaDefinition(localApplySource, schemaName, localApplySourcePath)),
    normalizeSchema(schemaDefinition(hostedApplySource, schemaName, hostedApplySourcePath)),
    `${schemaName} executable constraints drifted between hosted and local MCP`,
  );
}

const localTruthSchema = normalizeSchema(schemaDefinition(
  localApplySource,
  'truthCertificationSchema',
  localApplySourcePath,
));
const hostedTruthSchema = normalizeSchema(schemaDefinition(
  hostedApplySource,
  'truthCertificationSchema',
  hostedApplySourcePath,
));
assert.equal(
  localTruthSchema,
  hostedTruthSchema,
  'truth certification executable branch constraints drifted between hosted and local MCP',
);

assert.equal(
  normalizeSchema(schemaDefinition(localApplySource, 'startApplyRunInputSchema', localApplySourcePath)),
  normalizeSchema(schemaDefinition(hostedApplySource, 'startApplyRunSchema', hostedApplySourcePath)),
  'start Apply run advertised fields drifted between hosted and local MCP',
);
const localStartApplyRunSchema = schemaDefinition(
  localApplySource,
  'startApplyRunSchema',
  localApplySourcePath,
);
assert.match(normalizeSchema(localStartApplyRunSchema), /\.superRefine\(/);
const hostedStartToolStart = hostedApplySource.indexOf("'trackly_start_apply_run'");
const hostedStartToolEnd = hostedApplySource.indexOf('\n  server.tool(', hostedStartToolStart);
assert.ok(hostedStartToolStart >= 0 && hostedStartToolEnd > hostedStartToolStart);
const hostedStartTool = hostedApplySource.slice(hostedStartToolStart, hostedStartToolEnd);
assert.equal(
  normalizeSchema(schemaDefinition(localStartApplyRunSchema, 'batchValues', localApplySourcePath)),
  normalizeSchema(schemaDefinition(hostedStartTool, 'batchValues', hostedApplySourcePath)),
  'start Apply run batch-binding members drifted between hosted and local MCP',
);
assert.equal(
  normalizeSchema(conditionAfter(localStartApplyRunSchema, 'const batchValues', localApplySourcePath)),
  normalizeSchema(conditionAfter(hostedStartTool, 'const batchValues', hostedApplySourcePath)),
  'start Apply run complete validation condition drifted between hosted and local MCP',
);
assert.match(hostedStartTool, /incomplete_apply_batch_binding/);

console.log(
  `Trackly Apply MCP contracts and named executable schemas match at ${local.contractVersion}.`,
);
