#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const acorn = require('acorn');
const babelParser = require('@babel/parser');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256ExactBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const parsedSourceCache = new Map();

function parseFullSource(source, sourcePath) {
  if (parsedSourceCache.has(source)) return parsedSourceCache.get(source);
  let ast;
  try {
    ast = babelParser.parse(source, {
      sourceType: 'unambiguous',
      plugins: ['typescript'],
    });
  } catch (error) {
    assert.fail(`Could not parse ${sourcePath} as executable JavaScript/TypeScript: ${error.message}`);
  }
  parsedSourceCache.set(source, ast);
  return ast;
}

function babelCalleeName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression' || node.computed) return null;
  const objectName = babelCalleeName(node.object);
  const propertyName = node.property?.type === 'Identifier' ? node.property.name : null;
  return objectName && propertyName ? `${objectName}.${propertyName}` : null;
}

function activeToolRegistrations(source, expectedCallee, sourcePath) {
  const registrations = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === 'CallExpression' && babelCalleeName(node.callee) === expectedCallee) {
      assert.equal(
        node.arguments[0]?.type,
        'StringLiteral',
        `${expectedCallee} in ${sourcePath} must register a static string-literal tool name`,
      );
      registrations.push({ name: node.arguments[0].value, call: node });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(parseFullSource(source, sourcePath));
  return registrations;
}

function registeredInputSchemaName(registration, sourcePath) {
  let descriptor = registration.call.arguments[1];
  while (descriptor?.type === 'TSSatisfiesExpression' || descriptor?.type === 'TSAsExpression') {
    descriptor = descriptor.expression;
  }
  assert.equal(
    descriptor?.type,
    'ObjectExpression',
    `${registration.name} in ${sourcePath} must publish an object descriptor`,
  );
  const inputSchemaProperties = descriptor.properties.filter((property) => (
    property.type === 'ObjectProperty'
    && !property.computed
    && (
      (property.key.type === 'Identifier' && property.key.name === 'inputSchema')
      || (property.key.type === 'StringLiteral' && property.key.value === 'inputSchema')
    )
  ));
  assert.equal(
    inputSchemaProperties.length,
    1,
    `${registration.name} in ${sourcePath} must publish exactly one active inputSchema property`,
  );
  assert.equal(
    inputSchemaProperties[0].value.type,
    'Identifier',
    `${registration.name} in ${sourcePath} must publish a named inputSchema identifier`,
  );
  return inputSchemaProperties[0].value.name;
}

function activeVariableDeclarator(source, name, sourcePath) {
  const matches = [];
  function visit(node, parent = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (
      node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier'
      && node.id.name === name
    ) {
      matches.push({ declarator: node, declaration: parent });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child, node);
    }
  }
  visit(parseFullSource(source, sourcePath));
  assert.equal(matches.length, 1, `${name} must have exactly one active variable declaration in ${sourcePath}`);
  const [{ declarator, declaration }] = matches;
  assert.equal(
    declaration?.type,
    'VariableDeclaration',
    `${name} in ${sourcePath} must belong to a variable declaration`,
  );
  assert.ok(declarator.init, `${name} in ${sourcePath} must have an initializer`);
  return { declarator, declaration };
}

function schemaDefinitionBounds(source, name, sourcePath) {
  const { declarator, declaration } = activeVariableDeclarator(source, name, sourcePath);
  return {
    declarationStart: declaration.start,
    declarationEnd: declaration.end,
    expressionStart: declarator.init.start,
    expressionEnd: declarator.init.end,
  };
}

function staticStringArrayMap(source, name, sourcePath) {
  let initializer = activeVariableDeclarator(source, name, sourcePath).declarator.init;
  while (initializer.type === 'TSSatisfiesExpression' || initializer.type === 'TSAsExpression') {
    initializer = initializer.expression;
  }
  assert.equal(initializer.type, 'ObjectExpression', `${name} in ${sourcePath} must initialize an object`);
  const entries = initializer.properties.map((property) => {
    assert.equal(
      property.type,
      'ObjectProperty',
      `${name} in ${sourcePath} must contain only static properties (no spreads or methods)`,
    );
    assert.equal(property.computed, false, `${name} in ${sourcePath} must not contain computed properties`);
    assert.equal(property.shorthand, false, `${name} in ${sourcePath} must not contain shorthand properties`);
    const propertyName = property.key.type === 'Identifier'
      ? property.key.name
      : property.key.type === 'StringLiteral'
        ? property.key.value
        : null;
    assert.equal(typeof propertyName, 'string', `${name} in ${sourcePath} must use static string keys`);
    assert.equal(
      property.value.type,
      'ArrayExpression',
      `${name}.${propertyName} in ${sourcePath} must be an array literal`,
    );
    assert.ok(
      property.value.elements.every((element) => element?.type === 'StringLiteral'),
      `${name}.${propertyName} in ${sourcePath} must contain only string literals`,
    );
    return [propertyName, property.value.elements.map((element) => element.value)];
  });
  assert.equal(
    new Set(entries.map(([propertyName]) => propertyName)).size,
    entries.length,
    `${name} in ${sourcePath} must not contain duplicate properties`,
  );
  return Object.fromEntries(entries);
}

function schemaDefinition(source, name, sourcePath) {
  const bounds = schemaDefinitionBounds(source, name, sourcePath);
  return source.slice(bounds.expressionStart, bounds.expressionEnd);
}

function exactSchemaDefinition(source, name, sourcePath) {
  const bounds = schemaDefinitionBounds(source, name, sourcePath);
  return source.slice(bounds.declarationStart, bounds.declarationEnd);
}

const AST_METADATA_FIELDS = new Set(['start', 'end', 'loc', 'range', 'raw']);

function canonicalSchemaAst(value) {
  if (value instanceof RegExp) {
    return { pattern: value.source, flags: value.flags };
  }
  if (Array.isArray(value)) return value.map(canonicalSchemaAst);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !AST_METADATA_FIELDS.has(key))
      .map(([key, child]) => [key, canonicalSchemaAst(child)]),
  );
}

function parseSchemaExpression(source, name, sourcePath) {
  const expression = schemaDefinition(source, name, sourcePath);
  const ast = acorn.parseExpressionAt(expression, 0, { ecmaVersion: 'latest' });
  assert.equal(
    ast.end,
    expression.length,
    `${name} in ${sourcePath} must contain exactly one complete schema expression`,
  );
  return ast;
}

function referencedConstantIdentifiers(ast) {
  const identifiers = new Set();
  function visit(node, parent = null, parentKey = '') {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, parentKey);
      return;
    }
    if (node.type === 'Identifier' && /^[A-Z][A-Z0-9_]+$/.test(node.name)) {
      const isStaticMemberProperty = parent?.type === 'MemberExpression'
        && parentKey === 'property'
        && !parent.computed;
      const isStaticObjectKey = parent?.type === 'Property'
        && parentKey === 'key'
        && !parent.computed;
      if (!isStaticMemberProperty && !isStaticObjectKey) identifiers.add(node.name);
    }
    for (const [key, child] of Object.entries(node)) {
      if (AST_METADATA_FIELDS.has(key)) continue;
      visit(child, node, key);
    }
  }
  visit(ast);
  return [...identifiers].sort();
}

function typescriptConstArrayValues(source, name, sourcePath) {
  const expression = schemaDefinition(source, name, sourcePath);
  const ast = acorn.parseExpressionAt(expression, 0, { ecmaVersion: 'latest' });
  assert.equal(
    expression.slice(ast.end).trim(),
    'as const',
    `${name} in ${sourcePath} must be a literal array followed only by "as const"`,
  );
  assert.equal(ast.type, 'ArrayExpression', `${name} in ${sourcePath} must be a literal array`);
  assert.ok(
    ast.elements.every((element) => element?.type === 'Literal' && typeof element.value === 'string'),
    `${name} in ${sourcePath} must contain only string literals`,
  );
  return ast.elements.map((element) => element.value);
}

function memberName(node) {
  if (node?.type !== 'MemberExpression' || node.computed) return null;
  return node.property?.type === 'Identifier' ? node.property.name : null;
}

function calleeName(node) {
  if (node?.type === 'Identifier') return node.name;
  const property = memberName(node);
  if (!property) return null;
  const object = calleeName(node.object);
  return object ? `${object}.${property}` : null;
}

function assertCall(node, expectedCallee, label) {
  assert.equal(node?.type, 'CallExpression', `${label} must be a call expression`);
  assert.equal(calleeName(node.callee), expectedCallee, `${label} must call ${expectedCallee}`);
  return node;
}

function objectSchemaProperties(node, label) {
  const call = assertCall(node, 'z.object', label);
  assert.equal(call.arguments.length, 1, `${label} must pass one object shape`);
  assert.equal(call.arguments[0]?.type, 'ObjectExpression', `${label} must contain an object shape`);
  return call.arguments[0].properties;
}

function propertyName(property) {
  if (property?.type !== 'Property' || property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  return property.key.type === 'Literal' ? property.key.value : null;
}

function namedProperties(properties, label) {
  const entries = properties
    .filter((property) => property.type === 'Property')
    .map((property) => [propertyName(property), property.value]);
  assert.ok(entries.every(([name]) => typeof name === 'string'), `${label} must use static property names`);
  const result = Object.fromEntries(entries);
  assert.equal(Object.keys(result).length, entries.length, `${label} must not repeat properties`);
  return result;
}

function soleSpread(properties, label) {
  const spreads = properties.filter((property) => property.type === 'SpreadElement');
  assert.equal(spreads.length, 1, `${label} must contain one common-schema spread`);
  return spreads[0].argument;
}

function unwrapMethodCall(node, method, label) {
  assert.equal(node?.type, 'CallExpression', `${label} must call .${method}()`);
  assert.equal(memberName(node.callee), method, `${label} must call .${method}()`);
  assert.equal(node.arguments.length, 0, `${label} .${method}() must not take arguments`);
  return node.callee.object;
}

function assertTruthWrapperCompatibility(localWrapper, hostedSchema) {
  const localProperties = objectSchemaProperties(localWrapper, 'truthCertificationInputSchema');
  const union = assertCall(hostedSchema, 'z.discriminatedUnion', 'hosted truthCertificationSchema');
  assert.equal(union.arguments[0]?.type, 'Literal');
  assert.equal(union.arguments[0].value, 'resumeDependency');
  assert.equal(union.arguments[1]?.type, 'ArrayExpression');
  assert.equal(union.arguments[1].elements.length, 2);

  const branches = new Map(union.arguments[1].elements.map((branch, index) => {
    const properties = objectSchemaProperties(branch, `hosted truth branch ${index + 1}`);
    assert.deepEqual(
      canonicalSchemaAst(soleSpread(properties, `hosted truth branch ${index + 1}`)),
      canonicalSchemaAst(soleSpread(localProperties, 'truthCertificationInputSchema')),
      `hosted truth branch ${index + 1} must spread the same common schema as the local wrapper`,
    );
    const named = namedProperties(properties, `hosted truth branch ${index + 1}`);
    assert.deepEqual(Object.keys(named), ['resumeDependency', 'resumeId', 'resumeSha256']);
    const literal = assertCall(named.resumeDependency, 'z.literal', `hosted truth branch ${index + 1} discriminant`);
    assert.equal(literal.arguments.length, 1);
    assert.equal(literal.arguments[0]?.type, 'Literal');
    return [literal.arguments[0].value, named];
  }));
  assert.deepEqual([...branches.keys()], ['approved', 'not_applicable']);

  const localNamed = namedProperties(localProperties, 'truthCertificationInputSchema');
  assert.deepEqual(Object.keys(localNamed), ['resumeDependency', 'resumeId', 'resumeSha256']);
  const publishedDiscriminant = assertCall(
    localNamed.resumeDependency,
    'z.enum',
    'truthCertificationInputSchema.resumeDependency',
  );
  assert.equal(publishedDiscriminant.arguments[0]?.type, 'ArrayExpression');
  assert.deepEqual(
    publishedDiscriminant.arguments[0].elements.map((element) => element.value),
    [...branches.keys()],
    'published truth discriminants must exactly cover the hosted parse branches',
  );

  for (const field of ['resumeId', 'resumeSha256']) {
    const publishedBase = unwrapMethodCall(
      unwrapMethodCall(localNamed[field], 'optional', `truthCertificationInputSchema.${field}`),
      'nullable',
      `truthCertificationInputSchema.${field}`,
    );
    assert.deepEqual(
      canonicalSchemaAst(publishedBase),
      canonicalSchemaAst(branches.get('approved')[field]),
      `published ${field} must preserve the approved hosted schema before nullable/optional widening`,
    );
    const notApplicableBase = unwrapMethodCall(
      branches.get('not_applicable')[field],
      'optional',
      `hosted not_applicable ${field}`,
    );
    const nullSchema = assertCall(notApplicableBase, 'z.null', `hosted not_applicable ${field}`);
    assert.equal(nullSchema.arguments.length, 0, `hosted not_applicable ${field} z.null() must not take arguments`);
  }
}

function assertStartRunWrapperCompatibility(localWrapper, hostedSchema) {
  assert.equal(hostedSchema?.type, 'CallExpression');
  assert.equal(memberName(hostedSchema.callee), 'superRefine');
  assert.equal(hostedSchema.arguments.length, 1, 'hosted startApplyRunSchema must have one refinement callback');
  assert.deepEqual(
    canonicalSchemaAst(localWrapper),
    canonicalSchemaAst(hostedSchema.callee.object),
    'startApplyRunInputSchema must equal the hosted published object before parse-time superRefine',
  );
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
const executablePluginRegistrations = activeToolRegistrations(
  hostedPluginSource,
  'registerPluginTool',
  hostedPluginSourcePath,
);
const executablePluginTools = executablePluginRegistrations.map((registration) => registration.name);
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
const executableScopeContract = staticStringArrayMap(
  hostedPluginScopesSource,
  'TRACKLY_PLUGIN_TOOL_SCOPES',
  hostedPluginScopesPath,
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

const namedApplyDependencySources = {
  localMcpApplyTools: [localApplySource, localApplySourcePath],
  hostedMcpServer: [hostedApplySource, hostedApplySourcePath],
  hostedApplyExecutionContract: [hostedApplyExecutionContractSource, hostedApplyExecutionContractPath],
};
const executableNamedApplyDependencyDigests = Object.fromEntries(
  Object.entries(pluginLock.publicExecutableContract.namedApplyDependencySha256).map(([side, lockedDigests]) => {
    const sourceEntry = namedApplyDependencySources[side];
    assert.ok(sourceEntry, `Unknown named Apply dependency source ${side}`);
    return [
      side,
      Object.fromEntries(Object.keys(lockedDigests).map((constantName) => [
        constantName,
        sha256ExactBytes(exactSchemaDefinition(sourceEntry[0], constantName, sourceEntry[1])),
      ])),
    ];
  }),
);
assert.deepEqual(
  executableNamedApplyDependencyDigests,
  pluginLock.publicExecutableContract.namedApplyDependencySha256,
  'Named local and hosted Apply schema dependencies drifted from the packaged exact-byte digest lock',
);

const sharedParseSchemaNames = [
  'applyExecutionDispositionSchema',
  'truthCertificationCommon',
  'truthCertificationSchema',
  'startApplyRunSchema',
];
const localApplySchemaAsts = Object.fromEntries(
  [
    ...sharedParseSchemaNames,
    'truthCertificationInputSchema',
    'startApplyRunInputSchema',
  ].map((schemaName) => [
    schemaName,
    parseSchemaExpression(localApplySource, schemaName, localApplySourcePath),
  ]),
);
const hostedApplySchemaAsts = Object.fromEntries(
  sharedParseSchemaNames.map((schemaName) => [
    schemaName,
    parseSchemaExpression(hostedApplySource, schemaName, hostedApplySourcePath),
  ]),
);
for (const schemaName of sharedParseSchemaNames) {
  assert.deepEqual(
    canonicalSchemaAst(localApplySchemaAsts[schemaName]),
    canonicalSchemaAst(hostedApplySchemaAsts[schemaName]),
    `${schemaName} executable AST drifted between local and hosted MCP`,
  );
}

const expectedSchemaConstants = [
  'APPLY_BROWSER_SURFACES',
  'APPLY_EXECUTION_ACCESS_CLASSIFICATIONS',
  'APPLY_EXECUTION_DISPOSITION_SOURCES',
  'SAFE_IDEMPOTENCY_KEY',
];
for (const [side, schemaAsts] of [
  ['local', localApplySchemaAsts],
  ['hosted', hostedApplySchemaAsts],
]) {
  const referencedConstants = [...new Set(
    sharedParseSchemaNames.flatMap((schemaName) => referencedConstantIdentifiers(schemaAsts[schemaName])),
  )].sort();
  assert.deepEqual(
    referencedConstants,
    expectedSchemaConstants,
    `${side} Apply schema transitive constant audit changed; explicitly lock and compare every new dependency`,
  );
}

assert.deepEqual(
  canonicalSchemaAst(parseSchemaExpression(localApplySource, 'SAFE_IDEMPOTENCY_KEY', localApplySourcePath)),
  canonicalSchemaAst(parseSchemaExpression(hostedApplySource, 'SAFE_IDEMPOTENCY_KEY', hostedApplySourcePath)),
  'SAFE_IDEMPOTENCY_KEY semantics drifted between local and hosted Apply schemas',
);
const contractBackedSchemaConstants = {
  APPLY_BROWSER_SURFACES: 'applyBrowserSurfaces',
  APPLY_EXECUTION_ACCESS_CLASSIFICATIONS: 'applyAccessClassifications',
  APPLY_EXECUTION_DISPOSITION_SOURCES: 'applyExecutionDispositionSources',
};
for (const [constantName, contractProperty] of Object.entries(contractBackedSchemaConstants)) {
  const expectedLocalAlias = parseSchemaExpression(
    `const expected = APPLY_CONTRACT.constants.${contractProperty};`,
    'expected',
    `${constantName} expected local contract alias`,
  );
  assert.deepEqual(
    canonicalSchemaAst(parseSchemaExpression(localApplySource, constantName, localApplySourcePath)),
    canonicalSchemaAst(expectedLocalAlias),
    `${constantName} local schema dependency must resolve through ${contractProperty}`,
  );
  assert.deepEqual(
    typescriptConstArrayValues(
      hostedApplyExecutionContractSource,
      constantName,
      hostedApplyExecutionContractPath,
    ),
    hosted.constants[contractProperty],
    `${constantName} hosted executable values must equal ${contractProperty}`,
  );
}

const publishedSchemaCompatibility = {
  trackly_certify_apply_batch_truth: {
    localPublished: 'truthCertificationInputSchema',
    hostedPublishedAndParse: 'truthCertificationSchema',
  },
  trackly_start_apply_run: {
    localPublished: 'startApplyRunInputSchema',
    hostedPublishedAndParse: 'startApplyRunSchema',
  },
};
for (const [toolName, mapping] of Object.entries(publishedSchemaCompatibility)) {
  for (const [side, sourceText, sourcePath, schemaName] of [
    ['local', localApplySource, localApplySourcePath, mapping.localPublished],
    ['hosted', hostedApplySource, hostedApplySourcePath, mapping.hostedPublishedAndParse],
  ]) {
    const registrations = activeToolRegistrations(sourceText, 'server.registerTool', sourcePath)
      .filter((registration) => registration.name === toolName);
    assert.equal(
      registrations.length,
      1,
      `${toolName} ${side} must have exactly one active server.registerTool registration`,
    );
    assert.equal(
      registeredInputSchemaName(registrations[0], sourcePath),
      schemaName,
      `${toolName} ${side} tools/list schema must use ${schemaName}`,
    );
  }
}
assertTruthWrapperCompatibility(
  localApplySchemaAsts.truthCertificationInputSchema,
  hostedApplySchemaAsts.truthCertificationSchema,
);
assertStartRunWrapperCompatibility(
  localApplySchemaAsts.startApplyRunInputSchema,
  hostedApplySchemaAsts.startApplyRunSchema,
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

module.exports = {
  activeToolRegistrations,
  canonicalSchemaAst,
  exactSchemaDefinition,
  parseSchemaExpression,
  referencedConstantIdentifiers,
  registeredInputSchemaName,
  schemaDefinition,
  sha256ExactBytes,
  staticStringArrayMap,
  typescriptConstArrayValues,
  verifyHostedContract,
};

if (require.main === module) {
  verifyHostedContract();
}
