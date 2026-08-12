#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const acorn = require('acorn');
const babelParser = require('@babel/parser');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256ExactBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const CHECKED_IN_HOSTED_FIXTURE_SHA256 = 'b7acd0248e78f4117dd1ee2bd67531198e98e40eab42879759f93eba1168eefb';

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

function unwrapTransparentExpression(node) {
  let current = node;
  while (current && [
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
    'TSNonNullExpression',
    'ParenthesizedExpression',
  ].includes(current.type)) {
    current = current.expression;
  }
  return current;
}

function isStaticallyDisjointFromRootPath(node) {
  if (node?.type !== 'StringLiteral') return false;
  return node.value.startsWith('/')
    && node.value !== '/'
    && !/[?*+{}()[\]:]/.test(node.value);
}

function rootRouteChain(call) {
  const methods = [];
  let current = call;
  while (current?.type === 'CallExpression' && current.callee?.type === 'MemberExpression') {
    const method = current.callee.computed
      ? (current.callee.property?.type === 'StringLiteral' ? current.callee.property.value : null)
      : (current.callee.property?.type === 'Identifier' ? current.callee.property.name : null);
    methods.push(method);
    const receiver = unwrapTransparentExpression(current.callee.object);
    if (receiver?.type === 'CallExpression' && babelCalleeName(receiver.callee) === 'router.route') {
      return { methods, path: receiver.arguments[0] };
    }
    current = receiver;
  }
  return null;
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

function directToolRegistrationsInNamedParameterFunction(
  source,
  expectedFunction,
  receiverParameter,
  method,
  sourcePath,
  receiverOrigin = 'parameter',
) {
  const ast = parseFullSource(source, sourcePath);
  const functions = ast.program.body.filter((statement) => (
    statement.type === 'FunctionDeclaration' && statement.id?.name === expectedFunction
  ));
  assert.equal(functions.length, 1, `${sourcePath} must define exactly one top-level ${expectedFunction}`);
  const factory = functions[0];
  if (receiverOrigin === 'parameter') {
    assert.equal(
      factory.params[0]?.type,
      'Identifier',
      `${expectedFunction} in ${sourcePath} must receive its server directly`,
    );
    assert.equal(factory.params[0].name, receiverParameter);
  } else {
    assert.equal(receiverOrigin, 'direct-construction');
    const bindings = factory.body.body.flatMap((statement) => (
      statement.type === 'VariableDeclaration' && statement.kind === 'const'
        ? statement.declarations.filter((declaration) => (
          declaration.id?.type === 'Identifier'
          && declaration.id.name === receiverParameter
          && declaration.init?.type === 'NewExpression'
          && babelCalleeName(declaration.init.callee) === 'McpServer'
        ))
        : []
    ));
    assert.equal(
      bindings.length,
      1,
      `${expectedFunction} in ${sourcePath} must directly construct one immutable ${receiverParameter} McpServer`,
    );
  }
  const direct = factory.body.body.flatMap((statement) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    const callee = call?.type === 'CallExpression' ? call.callee : null;
    const receiver = callee?.type === 'MemberExpression' ? unwrapTransparentExpression(callee.object) : null;
    if (receiver?.type !== 'Identifier' || receiver.name !== receiverParameter) return [];
    const member = callee.computed
      ? (callee.property?.type === 'StringLiteral' ? callee.property.value : null)
      : (callee.property?.type === 'Identifier' ? callee.property.name : null);
    if (member !== method) return [];
    assert.equal(call.arguments[0]?.type, 'StringLiteral', `${sourcePath} registrations must use static names`);
    return [{ name: call.arguments[0].value, call }];
  });
  if (expectedFunction === 'registerApplyTools') {
    const catalogRegistrationIndexes = factory.body.body.flatMap((statement, index) => {
      const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
      const callee = call?.type === 'CallExpression' ? call.callee : null;
      const receiver = callee?.type === 'MemberExpression' ? unwrapTransparentExpression(callee.object) : null;
      const member = callee?.type === 'MemberExpression' && !callee.computed
        && callee.property?.type === 'Identifier'
        ? callee.property.name
        : null;
      return receiver?.type === 'Identifier'
        && receiver.name === receiverParameter
        && ['tool', 'registerTool', 'registerPrompt', 'registerResource'].includes(member)
        ? [index]
        : [];
    });
    assert.ok(catalogRegistrationIndexes.length > 0, `${sourcePath} must directly register Apply tools`);
    assert.ok(
      factory.body.body.slice(0, catalogRegistrationIndexes.at(-1) + 1).every((statement) => (
        statement.type === 'VariableDeclaration' || statement.type === 'ExpressionStatement'
      )),
      `${expectedFunction} in ${sourcePath} must reach every local registration without an earlier branch, return, or throw`,
    );
  }
  const permittedReceiverReferences = new Set();
  if (receiverOrigin === 'parameter') {
    permittedReceiverReferences.add(factory.params[0]);
  } else {
    const receiverDeclaration = factory.body.body.find((statement) => (
      statement.type === 'VariableDeclaration'
      && statement.declarations.some((declaration) => declaration.id?.name === receiverParameter)
    ));
    const receiverDeclarator = receiverDeclaration.declarations.find(
      (declaration) => declaration.id?.name === receiverParameter,
    );
    permittedReceiverReferences.add(receiverDeclarator.id);
  }
  const catalogRegistrationMethods = new Set(['tool', 'registerTool', 'registerPrompt', 'registerResource']);
  for (const statement of factory.body.body) {
    const expression = statement.type === 'ExpressionStatement' ? statement.expression : null;
    const callee = expression?.type === 'CallExpression' ? expression.callee : null;
    const receiver = callee?.type === 'MemberExpression' ? unwrapTransparentExpression(callee.object) : null;
    const member = callee?.type === 'MemberExpression'
      ? (callee.computed
        ? (callee.property?.type === 'StringLiteral' ? callee.property.value : null)
        : (callee.property?.type === 'Identifier' ? callee.property.name : null))
      : null;
    if (receiver?.type === 'Identifier'
      && receiver.name === receiverParameter
      && catalogRegistrationMethods.has(member)
      && expression.arguments[0]?.type === 'StringLiteral') {
      permittedReceiverReferences.add(receiver);
    }
    if (expectedFunction === 'createServer'
      && callee?.type === 'Identifier'
      && callee.name === 'registerApplyTools'
      && expression.arguments[0]?.type === 'Identifier'
      && expression.arguments[0].name === receiverParameter) {
      permittedReceiverReferences.add(expression.arguments[0]);
    }
    if (expectedFunction === 'createServer'
      && statement.type === 'ReturnStatement'
      && statement.argument?.type === 'Identifier'
      && statement.argument.name === receiverParameter) {
      permittedReceiverReferences.add(statement.argument);
    }
  }
  const unverifiedReceiverReferences = [];
  function visitReceiverReferences(node, parent = null, parentKey = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitReceiverReferences(child, parent, parentKey);
      return;
    }
    if (node.type === 'Identifier' && node.name === receiverParameter) {
      const isStaticMemberName = parent?.type === 'MemberExpression'
        && parentKey === 'property'
        && parent.computed === false;
      const isStaticObjectKey = parent?.type === 'ObjectProperty'
        && parentKey === 'key'
        && parent.computed === false
        && parent.shorthand === false;
      if (!isStaticMemberName && !isStaticObjectKey && !permittedReceiverReferences.has(node)) {
        unverifiedReceiverReferences.push(node);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitReceiverReferences(child, node, key);
    }
  }
  visitReceiverReferences(factory.body);
  assert.equal(
    unverifiedReceiverReferences.length,
    0,
    `${expectedFunction} in ${sourcePath} must not alias, escape, or otherwise reference ${receiverParameter} outside direct catalog registrations, the verified Apply registration call, and its final return`,
  );
  const all = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const receiver = unwrapTransparentExpression(node.callee.object);
      const member = node.callee.computed
        ? (node.callee.property?.type === 'StringLiteral' ? node.callee.property.value : null)
        : (node.callee.property?.type === 'Identifier' ? node.callee.property.name : null);
      if (receiver?.type === 'Identifier' && receiver.name === receiverParameter && member === method) all.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(factory.body);
  assert.equal(
    all.length,
    direct.length,
    `${expectedFunction} in ${sourcePath} must register every ${receiverParameter}.${method} tool directly on its reachable body`,
  );
  return direct;
}

function directHostedToolRegistrationsInNamedFactory(
  source,
  expectedFunction,
  helperName,
  sourcePath,
  expectedToolCatalog,
  {
    helperAstSha256 = '62cb38dc14622e0f6e96bca650876a142cc8a2b38adfb8bf9e257a13abdbc11d',
  } = {},
) {
  const ast = parseFullSource(source, sourcePath);
  assertImportBinding(
    source,
    'McpServer',
    'McpServer',
    '@modelcontextprotocol/sdk/server/mcp.js',
    sourcePath,
  );
  assertActiveFunctionAstSha256(source, helperName, helperAstSha256, sourcePath);
  const factory = activeNamedDefinitionAst(source, expectedFunction, sourcePath);
  assert.equal(factory.type, 'FunctionDeclaration');
  assert.equal(factory.async, false, `${expectedFunction} in ${sourcePath} must not be async`);
  assert.equal(factory.generator, false, `${expectedFunction} in ${sourcePath} must not be a generator`);
  assert.deepEqual(
    canonicalSchemaAst(factory.params),
    canonicalSchemaAst(babelParser.parseExpression(
      `(authToken: string, requestApi: McpApiRequest = apiRequest) => undefined`,
      { plugins: ['typescript'] },
    ).params),
    `${expectedFunction} in ${sourcePath} must preserve the exact authToken and canonical apiRequest-backed requestApi parameters without shadowing runtime dependencies`,
  );
  const body = factory.body.body;
  const serverDeclarations = body.flatMap((statement) => (
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter((declaration) => declaration.id?.type === 'Identifier' && declaration.id.name === 'server')
        .map((declaration) => ({ statement, declaration }))
      : []
  ));
  assert.equal(serverDeclarations.length, 1, `${expectedFunction} in ${sourcePath} must declare one exact server binding`);
  const [{ statement: serverStatement, declaration: serverDeclaration }] = serverDeclarations;
  assert.equal(serverStatement.kind, 'const', `${expectedFunction} in ${sourcePath} must declare server as immutable const`);
  assert.deepEqual(
    canonicalSchemaAst(serverDeclaration.init),
    canonicalSchemaAst(babelParser.parseExpression(
      `new McpServer({ name: 'trackly', version: MCP_VERSION })`,
      { plugins: ['typescript'] },
    )),
    `${expectedFunction} in ${sourcePath} must construct the canonical Trackly McpServer exactly`,
  );
  const registrations = body.flatMap((statement, index) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (call?.type !== 'CallExpression' || babelCalleeName(call.callee) !== helperName) return [];
    assert.equal(call.callee.type, 'Identifier', `${helperName} in ${sourcePath} must be called directly`);
    assert.equal(call.arguments[0]?.type, 'Identifier');
    assert.equal(call.arguments[0].name, 'server', `${helperName} in ${sourcePath} must receive the factory server`);
    assert.equal(call.arguments[1]?.type, 'StringLiteral', `${helperName} in ${sourcePath} must receive a static tool name`);
    return [{ name: call.arguments[1].value, call, index }];
  });
  assert.ok(registrations.length > 0, `${expectedFunction} in ${sourcePath} must register hosted tools through ${helperName}`);
  assert.deepEqual(
    registrations.map(({ name }) => name),
    expectedToolCatalog,
    `${expectedFunction} in ${sourcePath} hosted helper tool catalog drifted from the locked allowlist`,
  );
  const registrationIndexes = registrations.map(({ index }) => index);
  assert.ok(
    registrationIndexes.every((index, offset) => offset === 0 || index > registrationIndexes[offset - 1]),
    `${expectedFunction} in ${sourcePath} must preserve the direct hosted helper registration order`,
  );
  const allowedSchemaDeclarations = new Set([
    'truthCertificationCommon',
    'truthCertificationInputSchema',
    'truthCertificationSchema',
    'startApplyRunSchema',
  ]);
  const registrationCalls = new Set(registrations.map(({ call }) => call));
  const allowedServerMemberCalls = [];
  for (const [index, statement] of body.entries()) {
    if (statement === serverStatement) {
      assert.equal(index, 0, `${expectedFunction} in ${sourcePath} must construct server before executable work`);
      continue;
    }
    if (statement.type === 'VariableDeclaration') {
      assert.equal(statement.kind, 'const', `${expectedFunction} in ${sourcePath} schema bindings must be immutable const`);
      assert.ok(
        statement.declarations.every((declaration) => (
          declaration.id?.type === 'Identifier' && allowedSchemaDeclarations.has(declaration.id.name)
        )),
        `${expectedFunction} in ${sourcePath} may declare only the reviewed hosted schema bindings`,
      );
      continue;
    }
    if (statement.type === 'ExpressionStatement' && registrationCalls.has(statement.expression)) continue;
    if (statement.type === 'ExpressionStatement' && statement.expression?.type === 'CallExpression') {
      const callee = unwrapTransparentExpression(statement.expression.callee);
      const receiver = unwrapTransparentExpression(callee?.object);
      const method = callee?.type === 'MemberExpression'
        ? (callee.computed
          ? (callee.property?.type === 'StringLiteral' ? callee.property.value : null)
          : (callee.property?.type === 'Identifier' ? callee.property.name : null))
        : null;
      if (receiver?.type === 'Identifier' && receiver.name === 'server'
        && (method === 'registerPrompt' || method === 'registerResource')) {
        allowedServerMemberCalls.push(statement.expression);
        continue;
      }
    }
    if (statement.type === 'ReturnStatement') {
      assert.equal(index, body.length - 1, `${expectedFunction} in ${sourcePath} must return only after every registration`);
      assert.equal(statement.argument?.type, 'Identifier');
      assert.equal(statement.argument.name, 'server', `${expectedFunction} in ${sourcePath} must return the registered server`);
      continue;
    }
    assert.fail(
      `${expectedFunction} in ${sourcePath} may contain only its exact server construction, reviewed schemas, direct hosted registrations, prompt/resource registrations, and sole final return`,
    );
  }
  assert.deepEqual(
    allowedServerMemberCalls.map((call) => memberName(call.callee)),
    ['registerPrompt', 'registerResource'],
    `${expectedFunction} in ${sourcePath} must preserve one canonical prompt and one canonical resource registration`,
  );

  const nestedHelperCalls = [];
  function collectCalls(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) collectCalls(child);
      return;
    }
    if (node.type === 'CallExpression') {
      const callee = unwrapTransparentExpression(node.callee);
      if (callee?.type === 'Identifier' && callee.name === helperName) nestedHelperCalls.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      collectCalls(child);
    }
  }
  collectCalls(factory.body);
  assert.equal(
    nestedHelperCalls.length,
    registrations.length,
    `${expectedFunction} in ${sourcePath} must not hide additional ${helperName} calls in nested or conditional code`,
  );
  assert.ok(
    nestedHelperCalls.every((call) => registrationCalls.has(call)),
    `${expectedFunction} in ${sourcePath} must register every hosted tool through a direct reachable ${helperName} call`,
  );

  const allowedServerReferences = new Set([
    serverDeclaration.id,
    ...registrations.map(({ call }) => call.arguments[0]),
    ...allowedServerMemberCalls.map((call) => unwrapTransparentExpression(call.callee).object),
    body.at(-1).argument,
  ]);
  const serverReferences = collectBindingReferences(factory, 'server', () => false);
  assert.equal(
    serverReferences.length,
    allowedServerReferences.size,
    `${expectedFunction} in ${sourcePath} must not alias, escape, reassign, or use server through an alternate registrar`,
  );
  assert.ok(
    serverReferences.every((reference) => allowedServerReferences.has(reference)),
    `${expectedFunction} in ${sourcePath} must use server only for reviewed registrations and its final return`,
  );

  const helperDefinition = activeNamedDefinitionAst(source, helperName, sourcePath);
  const helperReferences = collectBindingReferences(ast, helperName, () => false);
  const allowedHelperReferences = new Set([helperDefinition.id, ...registrations.map(({ call }) => call.callee)]);
  assert.equal(
    helperReferences.length,
    allowedHelperReferences.size,
    `${helperName} in ${sourcePath} must not be aliased, escaped, reassigned, or invoked outside the reviewed catalog`,
  );
  assert.ok(
    helperReferences.every((reference) => allowedHelperReferences.has(reference)),
    `${helperName} in ${sourcePath} must be referenced only by its definition and direct reviewed registrations`,
  );
  return registrations;
}

function assertHostedStartApplyRunBatchBindingGuard(registration, sourcePath) {
  const wrapper = registration.call.arguments[4];
  assert.equal(wrapper?.type, 'CallExpression', `trackly_start_apply_run handler in ${sourcePath} must call wrapTool`);
  assert.equal(babelCalleeName(wrapper.callee), 'wrapTool', `trackly_start_apply_run handler in ${sourcePath} must use wrapTool`);
  const handler = wrapper.arguments[1];
  assert.equal(handler?.type, 'ArrowFunctionExpression', `trackly_start_apply_run in ${sourcePath} must use an arrow handler`);
  assert.equal(handler.async, true, `trackly_start_apply_run in ${sourcePath} must await its request handler`);
  assert.equal(handler.params.length, 1);
  assert.equal(handler.params[0]?.type, 'Identifier');
  assert.equal(handler.params[0].name, 'value');
  assert.equal(handler.body?.type, 'BlockStatement');
  const expectedHandler = babelParser.parseExpression(`async (value) => {
    const batchValues = [
      value.batchId,
      value.memberId,
      value.expectedMemberVersion,
      value.expectedInspectionEpoch,
      value.leaseToken,
    ];
    if (
      batchValues.some((item) => item !== undefined)
      && batchValues.some((item) => item === undefined)
    ) {
      throw Object.assign(new Error('Batch binding fields must be supplied together'), {
        status: 400,
        code: 'incomplete_apply_batch_binding',
      });
    }
    return requestApi('POST', '/api/jobscout/apply/runs', authToken, value);
  }`, { plugins: ['typescript'] });
  assert.deepEqual(
    canonicalSchemaAst(handler.body.body),
    canonicalSchemaAst(expectedHandler.body.body),
    `trackly_start_apply_run in ${sourcePath} must reject every partial batch binding before dispatching the exact start request`,
  );
}

function assertCommonJsDestructuredRequire(source, importedName, moduleName, sourcePath) {
  const ast = parseFullSource(source, sourcePath);
  const matches = ast.program.body.filter((statement) => {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') return false;
    return statement.declarations.some((declaration) => (
      declaration.id?.type === 'ObjectPattern'
      && declaration.id.properties.some((property) => (
        property.type === 'ObjectProperty'
        && property.key?.type === 'Identifier'
        && property.key.name === importedName
        && property.value?.type === 'Identifier'
        && property.value.name === importedName
      ))
      && declaration.init?.type === 'CallExpression'
      && declaration.init.callee?.type === 'Identifier'
      && declaration.init.callee.name === 'require'
      && declaration.init.arguments[0]?.type === 'StringLiteral'
      && declaration.init.arguments[0].value === moduleName
    ));
  });
  assert.equal(
    matches.length,
    1,
    `${sourcePath} must import ${importedName} exactly once from ${moduleName}`,
  );
}

const HOSTED_GIT_MAX_BUFFER = 16 * 1024 * 1024;

function gitOutput(repository, args, encoding = 'utf8') {
  try {
    return childProcess.execFileSync('git', ['-C', repository, ...args], {
      encoding,
      maxBuffer: HOSTED_GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    assert.fail(`Could not verify hosted snapshot Git provenance in ${repository}: ${detail}`);
  }
}

const HOSTED_DEPLOYABLE_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'contracts/trackly-apply-tools.json',
  'contracts/trackly-plugin-tools.json',
  'src/index.ts',
  'src/__tests__/cors-origins.integration.test.ts',
  'src/config/database.ts',
  'src/mcp/server.ts',
  'src/mcp/plugin-server.ts',
  'src/mcp/__tests__/plugin-server.test.ts',
  'src/mcp/plugin-ui.ts',
  'src/mcp/plugin-router.ts',
  'src/mcp/plugin-scopes.ts',
  'src/mcp/mcp-scopes.ts',
  'src/mcp/oauth-provider.ts',
  'src/mcp/mcp-tokens.ts',
  'src/mcp/hosted-auth-context.ts',
  'src/utils/auth-epoch.ts',
  'src/utils/azure-rehearsal-ip.ts',
  'src/utils/jwt.ts',
  'src/utils/trackly-web-origin.ts',
  'src/middleware/channel-attribution.ts',
  'src/middleware/maintenance-mode.ts',
  'src/services/job-brief.ts',
  'src/services/review-identity.ts',
  'src/services/trackly-access.ts',
  'src/services/application-profile/apply-execution-contract.ts',
  'src/services/application-profile/catalog.ts',
  'src/services/application-profile/service.ts',
  'src/routes/jobscout-filter-utils.ts',
  'src/routes/jobscout-tracker.ts',
  'src/routes/trackly-apply.ts',
  'src/routes/auth.ts',
]);

function assertMergeCommitPreservesPaths(repository, sourceCommit, mergeCommit, relativePaths) {
  for (const relativePath of relativePaths) {
    const sourceBytes = gitOutput(repository, ['show', `${sourceCommit}:${relativePath}`], null);
    const mergedBytes = gitOutput(repository, ['show', `${mergeCommit}:${relativePath}`], null);
    assert.equal(
      sha256ExactBytes(mergedBytes),
      sha256ExactBytes(sourceBytes),
      `${relativePath} bytes at merge ${mergeCommit} must exactly preserve reviewed source ${sourceCommit}`,
    );
  }
}

function assertHostedCommitTimestamps(repository, fixture) {
  for (const [runtimeName, runtime] of [
    ['sourceRuntime', fixture.sourceRuntime],
    ['mergedRuntime', fixture.mergedRuntime],
  ]) {
    assert.equal(
      runtime.committedAt,
      gitOutput(repository, ['show', '-s', '--format=%cI', runtime.commit]).trim(),
      `${runtimeName} ${runtime.commit} committedAt must equal its exact Git committer timestamp`,
    );
  }
}

function verifyHostedSnapshotGitProvenance(cliRoot, backendRoot) {
  const fixturePath = path.join(cliRoot, 'plugins', 'trackly', 'hosted-contract-fixture.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const sourceCommit = fixture.sourceRuntime.commit;
  const mergeCommit = fixture.mergedRuntime.commit;
  assert.equal(
    gitOutput(backendRoot, ['rev-parse', 'HEAD']).trim(),
    sourceCommit,
    `${backendRoot} must be checked out at the exact reviewed runtime source commit`,
  );
  assert.equal(
    gitOutput(backendRoot, ['status', '--porcelain', '--untracked-files=all']).trim(),
    '',
    `${backendRoot} must be completely clean so every inspected backend byte comes from the reviewed commit`,
  );
  for (const commit of [sourceCommit, fixture.sourceRuntime.parent, mergeCommit, ...fixture.mergedRuntime.parents]) {
    gitOutput(backendRoot, ['cat-file', '-e', `${commit}^{commit}`]);
  }
  assert.deepEqual(
    gitOutput(backendRoot, ['show', '-s', '--format=%P', sourceCommit]).trim().split(/\s+/),
    [fixture.sourceRuntime.parent],
    `${sourceCommit} must have the recorded reviewed parent`,
  );
  assert.deepEqual(
    gitOutput(backendRoot, ['show', '-s', '--format=%P', mergeCommit]).trim().split(/\s+/),
    fixture.mergedRuntime.parents,
    `${mergeCommit} must have the recorded merge parents in order`,
  );
  assertHostedCommitTimestamps(backendRoot, fixture);
  for (const relativePath of HOSTED_DEPLOYABLE_PATHS) {
    assert.equal(
      sha256ExactBytes(fs.readFileSync(path.join(backendRoot, relativePath))),
      sha256ExactBytes(gitOutput(backendRoot, ['show', `${sourceCommit}:${relativePath}`], null)),
      `${relativePath} working bytes must exactly match the reviewed runtime commit`,
    );
  }
  assertMergeCommitPreservesPaths(
    backendRoot,
    sourceCommit,
    mergeCommit,
    HOSTED_DEPLOYABLE_PATHS,
  );
  const lockedSources = {
    pluginServer: 'src/mcp/plugin-server.ts',
    pluginScopes: 'src/mcp/plugin-scopes.ts',
    jobBriefService: 'src/services/job-brief.ts',
    backendUiRedirect: 'src/utils/trackly-web-origin.ts',
    maintenanceMode: 'src/middleware/maintenance-mode.ts',
    databaseBinding: 'src/config/database.ts',
    reviewIdentity: 'src/services/review-identity.ts',
    applicationProfileService: 'src/services/application-profile/service.ts',
  };
  for (const [lockName, relativePath] of Object.entries(lockedSources)) {
    const committedBytes = gitOutput(backendRoot, ['show', `${sourceCommit}:${relativePath}`], null);
    assert.equal(
      sha256ExactBytes(committedBytes),
      fixture.sourceSha256[lockName],
      `${relativePath} bytes at ${sourceCommit} drifted from the reviewed hosted snapshot`,
    );
  }
}

function directToolRegistrationsInNamedFactory(
  source,
  expectedFunction,
  expectedCallee,
  sourcePath,
  expectedToolCatalog = null,
) {
  assertImportBinding(
    source,
    'McpServer',
    'McpServer',
    '@modelcontextprotocol/sdk/server/mcp.js',
    sourcePath,
  );
  const ast = parseFullSource(source, sourcePath);
  const factories = ast.program.body.filter((statement) => (
    statement.type === 'ExportNamedDeclaration'
    && statement.declaration?.type === 'FunctionDeclaration'
    && statement.declaration.id?.name === expectedFunction
  ));
  assert.equal(
    factories.length,
    1,
    `${sourcePath} must export exactly one ${expectedFunction} function declaration`,
  );
  const factory = factories[0].declaration;
  const shadowBindings = [];
  function bindingContainsMcpServer(node) {
    if (node === null || typeof node !== 'object') return false;
    if (node.type === 'Identifier') return node.name === 'McpServer';
    if (node.type === 'RestElement') return bindingContainsMcpServer(node.argument);
    if (node.type === 'AssignmentPattern') return bindingContainsMcpServer(node.left);
    if (node.type === 'ArrayPattern') return node.elements.some(bindingContainsMcpServer);
    if (node.type === 'ObjectPattern') return node.properties.some((property) => (
      property.type === 'RestElement'
        ? bindingContainsMcpServer(property.argument)
        : bindingContainsMcpServer(property.value)
    ));
    return false;
  }
  for (const parameter of factory.params) {
    if (bindingContainsMcpServer(parameter)) shadowBindings.push(parameter);
  }
  function findShadowBindings(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) findShadowBindings(child);
      return;
    }
    if (node.type === 'VariableDeclarator' && bindingContainsMcpServer(node.id)) shadowBindings.push(node);
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration')
      && node.id?.name === 'McpServer') shadowBindings.push(node);
    if (node.type === 'CatchClause' && bindingContainsMcpServer(node.param)) shadowBindings.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      findShadowBindings(child);
    }
  }
  findShadowBindings(factory.body);
  assert.equal(
    shadowBindings.length,
    0,
    `${expectedFunction} in ${sourcePath} must not shadow the canonical imported McpServer binding`,
  );
  const factoryStatements = factory.body.body;
  const expectedCalleeParts = expectedCallee.split('.');
  assert.equal(expectedCalleeParts.length, 2, `${expectedCallee} must be a direct receiver method`);
  const [expectedServerBinding, expectedMethod] = expectedCalleeParts;
  const serverBindings = factoryStatements.flatMap((statement) => (
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter((declarator) => (
        declarator.id?.type === 'Identifier'
        && declarator.id.name === expectedServerBinding
        && declarator.init?.type === 'NewExpression'
        && babelCalleeName(declarator.init.callee) === 'McpServer'
      )).map((declarator) => ({ declaration: statement, declarator }))
      : []
  ));
  assert.equal(
    serverBindings.length,
    1,
    `${expectedFunction} in ${sourcePath} must directly create exactly one ${expectedServerBinding} McpServer binding`,
  );
  assert.equal(
    serverBindings[0].declaration.kind,
    'const',
    `${expectedFunction} in ${sourcePath} must declare the ${expectedServerBinding} McpServer binding as immutable const`,
  );
  const registrationIndexes = [];
  const registrations = factoryStatements.flatMap((statement, index) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (call?.type !== 'CallExpression'
      || call.callee?.type !== 'MemberExpression'
      || call.callee.computed
      || call.callee.property?.type !== 'Identifier'
      || call.callee.property.name !== expectedMethod) return [];
    assert.equal(
      call.callee.object?.type,
      'Identifier',
      `${expectedMethod} in ${sourcePath} must be called on the exact ${expectedServerBinding} factory binding`,
    );
    assert.equal(
      call.callee.object.name,
      expectedServerBinding,
      `${expectedMethod} in ${sourcePath} must be called on the exact ${expectedServerBinding} factory binding`,
    );
    assert.equal(
      call.arguments[0]?.type,
      'StringLiteral',
      `${expectedCallee} in ${sourcePath} must register a static string-literal tool name`,
    );
    registrationIndexes.push(index);
    return [{ name: call.arguments[0].value, call }];
  });
  assert.ok(
    registrations.length > 0,
    `${expectedFunction} in ${sourcePath} must directly register its ${expectedCallee} tools during factory initialization`,
  );
  const lastRegistrationIndex = registrationIndexes.at(-1);
  assert.ok(
    factoryStatements.slice(0, lastRegistrationIndex + 1).every((statement) => (
      statement.type === 'VariableDeclaration' || statement.type === 'ExpressionStatement'
    )),
    `${expectedFunction} in ${sourcePath} must reach every ${expectedCallee} registration without an earlier branch, return, throw, or disabled path`,
  );
  const allowedTailRegistrationMethods = new Set([
    'tool',
    'registerTool',
    'registerPrompt',
    'registerResource',
  ]);
  const directFactoryRegistrations = factoryStatements.flatMap((statement) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    const callee = call?.type === 'CallExpression' ? call.callee : null;
    const receiver = callee?.type === 'MemberExpression'
      ? unwrapTransparentExpression(callee.object)
      : null;
    const method = callee?.type === 'MemberExpression' && !callee.computed
      && callee.property?.type === 'Identifier'
      ? callee.property.name
      : null;
    if (receiver?.type !== 'Identifier'
      || receiver.name !== expectedServerBinding
      || !allowedTailRegistrationMethods.has(method)) return [];
    assert.equal(
      call.arguments[0]?.type,
      'StringLiteral',
      `${expectedFunction} in ${sourcePath} must use a static name for every direct server registration`,
    );
    return [{ method, name: call.arguments[0].value, call }];
  });
  const serverDeclaration = serverBindings[0].declaration;
  function referencesFactoryServer(node) {
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(referencesFactoryServer);
    if (node.type === 'Identifier' && node.name === expectedServerBinding) return true;
    return Object.entries(node).some(([key, child]) => (
      key !== 'loc' && key !== 'extra' && referencesFactoryServer(child)
    ));
  }
  function schemaCalleeRoot(node) {
    const candidate = unwrapTransparentExpression(node);
    if (candidate?.type === 'Identifier') return candidate.name;
    if (candidate?.type === 'MemberExpression') return schemaCalleeRoot(candidate.object);
    if (candidate?.type === 'CallExpression') return schemaCalleeRoot(candidate.callee);
    return null;
  }
  function isVerifiedPureSchemaInitializer(node) {
    if (node === null || typeof node !== 'object') return true;
    if (Array.isArray(node)) return node.every(isVerifiedPureSchemaInitializer);
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)) return true;
    if ([
      'AssignmentExpression',
      'AwaitExpression',
      'ConditionalExpression',
      'NewExpression',
      'SequenceExpression',
      'TaggedTemplateExpression',
      'UpdateExpression',
      'YieldExpression',
    ].includes(node.type)) return false;
    if (node.type === 'CallExpression' && schemaCalleeRoot(node.callee) !== 'z') return false;
    return Object.entries(node).every(([key, child]) => (
      (key === 'loc' || key === 'extra') || isVerifiedPureSchemaInitializer(child)
    ));
  }
  const verifiedFactorySchemaDeclarations = new Set([
    'startApplyRunSchema',
    'truthCertificationCommon',
    'truthCertificationSchema',
  ]);
  if (expectedToolCatalog !== null) {
    const actualToolCatalog = directFactoryRegistrations
      .filter(({ method }) => method === 'tool' || method === 'registerTool')
      .map(({ name }) => name);
    assert.deepEqual(
      actualToolCatalog,
      expectedToolCatalog,
      `${expectedFunction} in ${sourcePath} executable tool catalog drifted from the locked hosted MCP allowlist`,
    );
  }
  assert.ok(
    factoryStatements.slice(lastRegistrationIndex + 1, -1).every((statement) => {
      const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
      const callee = call?.type === 'CallExpression' ? call.callee : null;
      const receiver = callee?.type === 'MemberExpression'
        ? unwrapTransparentExpression(callee.object)
        : null;
      return callee?.type === 'MemberExpression'
        && !callee.computed
        && receiver?.type === 'Identifier'
        && receiver.name === expectedServerBinding
        && callee.property?.type === 'Identifier'
        && allowedTailRegistrationMethods.has(callee.property.name);
    }),
    `${expectedFunction} in ${sourcePath} must reach its final server return through direct registration calls on the exact server, without a branch, return, throw, or other executable statement after ${expectedCallee} registration`,
  );
  assert.ok(
    factoryStatements.slice(0, -1).every((statement) => {
      if (statement === serverDeclaration) return true;
      if (statement.type === 'VariableDeclaration') {
        return statement.kind === 'const'
          && statement.declarations.every((declarator) => (
            declarator.id?.type === 'Identifier'
            && verifiedFactorySchemaDeclarations.has(declarator.id.name)
            && declarator.init
            && !referencesFactoryServer(declarator.init)
            && isVerifiedPureSchemaInitializer(declarator.init)
          ));
      }
      const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
      const callee = call?.type === 'CallExpression' ? call.callee : null;
      const receiver = callee?.type === 'MemberExpression'
        ? unwrapTransparentExpression(callee.object)
        : null;
      const method = callee?.type === 'MemberExpression' && !callee.computed
        && callee.property?.type === 'Identifier'
        ? callee.property.name
        : null;
      return receiver?.type === 'Identifier'
        && receiver.name === expectedServerBinding
        && allowedTailRegistrationMethods.has(method)
        && call.arguments[0]?.type === 'StringLiteral';
    }),
    `${expectedFunction} in ${sourcePath} may contain only verified pure schema declarations and direct cataloged server registrations before its return`,
  );
  const factoryReturns = [];
  const serverRebindings = [];
  function targetContainsServerBinding(node) {
    if (node === null || typeof node !== 'object') return false;
    if (node.type === 'Identifier') return node.name === expectedServerBinding;
    if (node.type === 'RestElement') return targetContainsServerBinding(node.argument);
    if (node.type === 'AssignmentPattern') return targetContainsServerBinding(node.left);
    if (node.type === 'ArrayPattern') return node.elements.some(targetContainsServerBinding);
    if (node.type === 'ObjectPattern') return node.properties.some((property) => (
      property.type === 'RestElement'
        ? targetContainsServerBinding(property.argument)
        : targetContainsServerBinding(property.value)
    ));
    return false;
  }
  function visitReturns(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitReturns(child);
      return;
    }
    if (
      node !== factory
      && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
    ) return;
    if (node.type === 'ReturnStatement') factoryReturns.push(node);
    if (node.type === 'AssignmentExpression' && targetContainsServerBinding(node.left)) {
      serverRebindings.push(node);
    }
    if (node.type === 'UpdateExpression' && targetContainsServerBinding(node.argument)) {
      serverRebindings.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitReturns(child);
    }
  }
  visitReturns(factory);
  assert.equal(
    serverRebindings.length,
    0,
    `${expectedFunction} in ${sourcePath} must never assign to or update the immutable ${expectedServerBinding} binding`,
  );
  assert.equal(
    factoryReturns.length,
    1,
    `${expectedFunction} in ${sourcePath} must have exactly one reachable factory return`,
  );
  assert.equal(
    factoryStatements.at(-1),
    factoryReturns[0],
    `${expectedFunction} in ${sourcePath} must end with its sole reachable factory return`,
  );
  assert.ok(
    factoryReturns[0].argument?.type === 'Identifier'
      && factoryReturns[0].argument.name === expectedServerBinding,
    `${expectedFunction} in ${sourcePath} must return the exact ${expectedServerBinding} that received the verified registrations`,
  );
  return registrations;
}

function directToolRegistrationsInExportedFunction(
  source,
  expectedFunction,
  expectedCallee,
  sourcePath,
  { requireUiResourceLoop = false } = {},
) {
  assertImportBinding(
    source,
    'McpServer',
    'McpServer',
    '@modelcontextprotocol/sdk/server/mcp.js',
    sourcePath,
  );
  const ast = parseFullSource(source, sourcePath);
  const factories = ast.program.body.filter((statement) => (
    statement.type === 'ExportNamedDeclaration'
    && statement.declaration?.type === 'FunctionDeclaration'
    && statement.declaration.id?.name === expectedFunction
  ));
  assert.equal(
    factories.length,
    1,
    `${sourcePath} must export exactly one ${expectedFunction} function declaration`,
  );
  const factory = factories[0].declaration;
  const factoryParameterFixture = parseFullSource(
    'function expected(authToken: string, requestApi: PluginApiRequest = apiRequest) {}',
    `${expectedFunction} expected parameters`,
  ).program.body[0];
  assert.deepEqual(
    canonicalSchemaAst(factory.params),
    canonicalSchemaAst(factoryParameterFixture.params),
    `${expectedFunction} in ${sourcePath} must receive authToken and the canonical apiRequest-backed requestApi helper exactly`,
  );
  const registrations = [];
  const registrationStatementIndexes = [];
  for (const [index, statement] of factory.body.body.entries()) {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (call?.type !== 'CallExpression' || babelCalleeName(call.callee) !== expectedCallee) continue;
    assert.equal(
      call.arguments[0]?.type,
      'StringLiteral',
      `${expectedCallee} in ${sourcePath} must register a static string-literal tool name`,
    );
    registrations.push({ name: call.arguments[0].value, call });
    registrationStatementIndexes.push(index);
  }
  assert.ok(registrations.length > 0, `${expectedFunction} in ${sourcePath} must directly register tools`);
  const firstRegistrationIndex = registrationStatementIndexes[0];
  assert.deepEqual(
    registrationStatementIndexes,
    Array.from({ length: registrations.length }, (_, index) => firstRegistrationIndex + index),
    `${expectedFunction} in ${sourcePath} must register tools in one unconditional contiguous block`,
  );

  const preRegistrationStatements = factory.body.body.slice(0, firstRegistrationIndex);
  assert.equal(
    preRegistrationStatements.length,
    4,
    `${expectedFunction} in ${sourcePath} must contain only the verified server, prompt capability, empty prompt handler, and registration-helper declarations before registering tools`,
  );
  assert.deepEqual(
    preRegistrationStatements.map((statement) => canonicalSchemaAst(statement)),
    parseFullSource(`
      const server = new McpServer({ name: 'trackly', version: PLUGIN_VERSION });
      server.server.registerCapabilities({ prompts: {} });
      server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
      const registerPluginTool = (name, config, handler) => {};
    `, `${expectedFunction} locked pre-registration prefix`).program.body.map((statement, index) => (
      index === 3 ? canonicalSchemaAst({ ...statement, declarations: [{
        ...statement.declarations[0],
        init: preRegistrationStatements[3].declarations[0].init,
      }] }) : canonicalSchemaAst(statement)
    )),
    `${expectedFunction} in ${sourcePath} must preserve the exact prompt capability and empty prompt handler before tool registration`,
  );
  const directDeclarators = preRegistrationStatements.flatMap((statement) => (
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  ));
  assert.deepEqual(
    directDeclarators.map((declarator) => declarator.id?.type === 'Identifier' && declarator.id.name),
    ['server', expectedCallee],
    `${expectedFunction} in ${sourcePath} must declare only server then ${expectedCallee} before registering tools`,
  );
  const serverBindings = directDeclarators.filter((declarator) => (
    declarator.id?.type === 'Identifier'
    && declarator.id.name === 'server'
    && declarator.init?.type === 'NewExpression'
    && babelCalleeName(declarator.init.callee) === 'McpServer'
  ));
  assert.equal(
    serverBindings.length,
    1,
    `${expectedFunction} in ${sourcePath} must directly create exactly one registered server`,
  );
  assert.deepEqual(
    canonicalSchemaAst(serverBindings[0].init),
    canonicalSchemaAst(babelParser.parseExpression(
      "new McpServer({ name: 'trackly', version: PLUGIN_VERSION })",
      { plugins: ['typescript'] },
    )),
    `${expectedFunction} in ${sourcePath} must use the locked pure server initializer`,
  );
  const registrationHelpers = directDeclarators.filter((declarator) => (
    declarator.id?.type === 'Identifier' && declarator.id.name === expectedCallee
  ));
  assert.equal(
    registrationHelpers.length,
    1,
    `${expectedFunction} in ${sourcePath} must directly define exactly one ${expectedCallee} helper`,
  );
  const registrationHelper = registrationHelpers[0].init;
  assert.ok(
    registrationHelper?.type === 'ArrowFunctionExpression'
      || registrationHelper?.type === 'FunctionExpression',
    `${expectedCallee} in ${sourcePath} must be a function`,
  );
  assert.equal(
    registrationHelper.body?.type,
    'BlockStatement',
    `${expectedCallee} in ${sourcePath} must use a block body`,
  );
  assert.deepEqual(
    registrationHelper.params.map((parameter) => (
      parameter.type === 'Identifier' ? parameter.name : null
    )),
    ['name', 'config', 'handler'],
    `${expectedCallee} in ${sourcePath} must receive the exact name, config, and handler bindings`,
  );
  const helperReturnStatements = registrationHelper.body.body.filter((statement) => (
    statement.type === 'ReturnStatement'
  ));
  assert.equal(
    helperReturnStatements.length,
    1,
    `${expectedCallee} in ${sourcePath} must return exactly one registration result`,
  );
  assert.equal(
    registrationHelper.body.body.at(-1),
    helperReturnStatements[0],
    `${expectedCallee} in ${sourcePath} must end by returning its registration result`,
  );
  assert.deepEqual(
    canonicalSchemaAst(registrationHelper.body),
    canonicalSchemaAst(babelParser.parseExpression(`(name, config, handler) => {
      const securitySchemes = [{
        type: 'oauth2',
        scopes: requiredScopesForPluginTool(name) || [],
      }];
      return server.registerTool(name, {
        ...config,
        _meta: {
          ...config._meta,
          securitySchemes,
        },
      } as any, handler);
    }`, { plugins: ['typescript'] }).body),
    `${expectedCallee} in ${sourcePath} must forward the exact name, config, and handler bindings through the locked security metadata augmentation`,
  );

  const factoryReturns = [];
  function visitFactoryReturns(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitFactoryReturns(child);
      return;
    }
    if (
      node !== factory
      && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
    ) return;
    if (node.type === 'ReturnStatement') factoryReturns.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitFactoryReturns(child);
    }
  }
  visitFactoryReturns(factory);
  const finalFactoryStatement = factory.body.body.at(-1);
  assert.equal(
    factoryReturns.length,
    1,
    `${expectedFunction} in ${sourcePath} must have exactly one reachable factory return`,
  );
  assert.equal(
    finalFactoryStatement,
    factoryReturns[0],
    `${expectedFunction} in ${sourcePath} must end with its sole reachable return`,
  );
  assert.ok(
    factoryReturns[0].argument?.type === 'Identifier'
      && factoryReturns[0].argument.name === 'server',
    `${expectedFunction} in ${sourcePath} must return the exact server that received the verified registrations`,
  );

  const nestedRegistrations = [];
  const lowLevelRegistrationReferences = [];
  const dynamicServerMemberReferences = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === 'CallExpression' && babelCalleeName(node.callee) === expectedCallee) {
      nestedRegistrations.push(node);
    }
    const memberReceiver = node.type === 'MemberExpression'
      ? unwrapTransparentExpression(node.object)
      : null;
    if (node.type === 'MemberExpression'
      && memberReceiver?.type === 'Identifier'
      && memberReceiver.name === 'server') {
      const propertyName = node.computed
        ? (node.property?.type === 'StringLiteral' ? node.property.value : null)
        : (node.property?.type === 'Identifier' ? node.property.name : null);
      if (propertyName === 'registerTool' || propertyName === 'tool') {
        lowLevelRegistrationReferences.push(node);
      } else if (node.computed && propertyName === null) {
        dynamicServerMemberReferences.push(node);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(factory.body);
  assert.equal(
    nestedRegistrations.length,
    registrations.length,
    `${expectedFunction} in ${sourcePath} must register every ${expectedCallee} tool unconditionally as a direct function-body statement`,
  );
  assert.deepEqual(
    lowLevelRegistrationReferences,
    [helperReturnStatements[0].argument.callee],
    `${expectedFunction} in ${sourcePath} must register tools only through the verified ${expectedCallee} helper`,
  );
  assert.equal(
    dynamicServerMemberReferences.length,
    0,
    `${expectedFunction} in ${sourcePath} must not use dynamic server member access that could bypass the verified ${expectedCallee} helper`,
  );
  const serverReferences = [];
  function visitServerReferences(node, parent = null, parentKey = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitServerReferences(child, parent, parentKey);
      return;
    }
    const isStaticPropertyName = parent?.type === 'MemberExpression'
      && parentKey === 'property' && !parent.computed;
    const isStaticObjectKey = parent?.type === 'ObjectProperty'
      && parentKey === 'key' && !parent.computed;
    if (node.type === 'Identifier'
      && node.name === 'server'
      && !isStaticPropertyName
      && !isStaticObjectKey) serverReferences.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitServerReferences(child, node, key);
    }
  }
  visitServerReferences(factory);
  const expectedUiResourceLoop = parseFullSource(
    [
      'for (const view of Object.keys(TRACKLY_PLUGIN_UI) as Array<keyof typeof TRACKLY_PLUGIN_UI>) {',
      '  const uri = TRACKLY_PLUGIN_UI[view];',
      '  server.registerResource(`trackly-${view}-card`, uri, {',
      '    title: `trackly ${view} card`,',
      "    description: 'Private trackly Apply status UI. The user always submits manually.',",
      '    mimeType: TRACKLY_PLUGIN_UI_MIME_TYPE,',
      '  }, async () => ({',
      '    contents: [{',
      '      uri,',
      '      mimeType: TRACKLY_PLUGIN_UI_MIME_TYPE,',
      '      text: tracklyPluginUiHtml(view),',
      '      _meta: TRACKLY_PLUGIN_UI_RESOURCE_META,',
      '    }],',
      '  }));',
      '}',
    ].join('\n'),
    'locked plugin UI resource registration',
  ).program.body[0];
  const uiResourceLoops = factory.body.body.filter((statement) => (
    JSON.stringify(canonicalSchemaAst(statement))
      === JSON.stringify(canonicalSchemaAst(expectedUiResourceLoop))
  ));
  if (requireUiResourceLoop) {
    assert.equal(
      uiResourceLoops.length,
      1,
      `${expectedFunction} in ${sourcePath} must contain exactly one locked plugin UI resource loop`,
    );
  } else {
    assert.ok(
      uiResourceLoops.length <= 1,
      `${expectedFunction} in ${sourcePath} may contain at most one exact locked plugin UI resource loop`,
    );
  }
  const uiResourceReceiver = uiResourceLoops[0]?.body?.body?.[1]?.expression?.callee?.object;
  const allowedServerReferences = [
    serverBindings[0].id,
    preRegistrationStatements[1].expression.callee.object.object,
    preRegistrationStatements[2].expression.callee.object.object,
    helperReturnStatements[0].argument.callee.object,
    ...(uiResourceReceiver ? [uiResourceReceiver] : []),
    factoryReturns[0].argument,
  ];
  assert.deepEqual(
    serverReferences,
    allowedServerReferences,
    `${expectedFunction} in ${sourcePath} must not alias, escape, or use its public facade server outside the verified registration helper, locked UI resource registration, and final return`,
  );
  return registrations;
}

function assertExportedFactoryUsedByPluginRouter(source, expectedFactory, sourcePath) {
  const ast = parseFullSource(source, sourcePath);
  assertImportBinding(source, 'Router', 'Router', 'express', sourcePath);
  assertActiveVariableInitializerAst(source, 'router', 'Router()', sourcePath);
  const exportedRouters = ast.program.body.filter((statement) => (
    statement.type === 'ExportDefaultDeclaration'
    && statement.declaration?.type === 'Identifier'
    && statement.declaration.name === 'router'
  ));
  assert.equal(
    exportedRouters.length,
    1,
    `${sourcePath} must default-export the exact canonical Express router receiving POST /`,
  );
  assertImportBinding(
    source,
    'StreamableHTTPServerTransport',
    'StreamableHTTPServerTransport',
    '@modelcontextprotocol/sdk/server/streamableHttp.js',
    sourcePath,
  );
  const imports = ast.program.body.filter((statement) => (
    statement.type === 'ImportDeclaration'
    && statement.source.value === './plugin-server.js'
    && statement.specifiers.some((specifier) => (
      specifier.type === 'ImportSpecifier'
      && specifier.imported?.name === expectedFactory
      && specifier.local?.name === expectedFactory
    ))
  ));
  assert.equal(
    imports.length,
    1,
    `${sourcePath} must import ${expectedFactory} exactly once from ./plugin-server.js`,
  );
  const tokenGeneratorImports = ast.program.body.filter((statement) => (
    statement.type === 'ImportDeclaration'
    && statement.source.value === './server.js'
    && statement.specifiers.some((specifier) => (
      specifier.type === 'ImportSpecifier'
      && specifier.imported?.name === 'generateHostedOAuthInternalToken'
      && specifier.local?.name === 'generateHostedOAuthInternalToken'
    ))
  ));
  assert.equal(
    tokenGeneratorImports.length,
    1,
    `${sourcePath} must import generateHostedOAuthInternalToken exactly once from ./server.js`,
  );
  const postRoutes = ast.program.body.flatMap((statement) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    return call?.type === 'CallExpression'
      && babelCalleeName(call.callee) === 'router.post'
      && call.arguments[0]?.type === 'StringLiteral'
      && call.arguments[0].value === '/'
      ? [call]
      : [];
  });
  assert.equal(
    postRoutes.length,
    1,
    `${sourcePath} must execute exactly one POST / plugin route registration at module initialization`,
  );
  const canonicalPostIndex = ast.program.body.findIndex((statement) => (
    statement.type === 'ExpressionStatement' && statement.expression === postRoutes[0]
  ));
  const competingRoutes = ast.program.body.slice(0, canonicalPostIndex).filter((statement) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (call?.type !== 'CallExpression') return false;
    const callee = babelCalleeName(call.callee);
    const chainedRoute = rootRouteChain(call);
    if (chainedRoute) {
      const mayHandlePost = chainedRoute.methods.some((method) => method === null || ['post', 'all'].includes(method));
      return mayHandlePost && !isStaticallyDisjointFromRootPath(chainedRoute.path);
    }
    const directReceiver = call.callee?.type === 'MemberExpression'
      ? unwrapTransparentExpression(call.callee.object)
      : null;
    if (directReceiver?.type === 'Identifier' && directReceiver.name === 'router' && call.callee.computed) {
      const method = call.callee.property?.type === 'StringLiteral' ? call.callee.property.value : null;
      if (method === null || ['post', 'all', 'use', 'route'].includes(method)) {
        return !isStaticallyDisjointFromRootPath(call.arguments[0]);
      }
    }
    if (!['router.post', 'router.all', 'router.use', 'router.route'].includes(callee)) return false;
    return !isStaticallyDisjointFromRootPath(call.arguments[0]);
  });
  assert.equal(
    competingRoutes.length,
    0,
    `${sourcePath} must not register an earlier router mount that could cover POST / ahead of the authenticated route`,
  );
  const routerDeclaration = ast.program.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter((declaration) => (
        declaration.id?.type === 'Identifier' && declaration.id.name === 'router'
      ))
      : []
  ))[0];
  const lockedRouteReceivers = ast.program.body.flatMap((statement) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    const callee = unwrapTransparentExpression(call?.callee);
    if (callee?.type !== 'MemberExpression') return [];
    const receiver = unwrapTransparentExpression(callee.object);
    const method = staticMemberName(callee);
    return receiver?.type === 'Identifier'
      && receiver.name === 'router'
      && (method === 'route' || EXPRESS_ROUTE_CALL_METHODS.has(method))
      ? [receiver]
      : [];
  });
  assert.deepEqual(
    collectBindingReferences(ast, 'router', () => false),
    [routerDeclaration.id, ...lockedRouteReceivers, exportedRouters[0].declaration],
    `router in ${sourcePath} must not be aliased, escaped, mutated, or referenced outside its locked route registrations and default export`,
  );
  const handler = postRoutes[0].arguments.at(-1);
  assert.ok(
    handler?.type === 'ArrowFunctionExpression' || handler?.type === 'FunctionExpression',
    `POST / in ${sourcePath} must end with a function handler`,
  );
  assert.deepEqual(
    handler.params.map((parameter) => parameter.type === 'Identifier' ? parameter.name : null),
    ['req', 'res'],
    `POST / handler in ${sourcePath} must bind its authenticated request and response directly`,
  );
  assert.equal(handler.body?.type, 'BlockStatement', `POST / handler in ${sourcePath} must use a block body`);
  assert.deepEqual(
    postRoutes[0].arguments.slice(1, -1).map((middleware) => (
      middleware.type === 'Identifier' ? middleware.name : null
    )),
    [
      'ipLimiter',
      'requirePluginEnabled',
      'validateOrigin',
      'bearerAuth',
      'enforcePluginResource',
      'requireTracklyAccess',
      'enforceTracklyPluginScope',
      'identityLimiter',
    ],
    `POST / in ${sourcePath} must authenticate and authorize the request before its handler`,
  );
  for (const [importedName, localName, moduleName] of [
    ['default', 'rateLimit', 'express-rate-limit'],
    ['ipKeyGenerator', 'ipKeyGenerator', 'express-rate-limit'],
    ['requireBearerAuth', 'requireBearerAuth', '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'],
    ['tracklyOAuthProvider', 'tracklyOAuthProvider', './oauth-provider.js'],
    ['MCP_PLUGIN_RESOURCE', 'MCP_PLUGIN_RESOURCE', './mcp-tokens.js'],
    ['enforceTracklyPluginScope', 'enforceTracklyPluginScope', './plugin-scopes.js'],
    ['requireTracklyAccess', 'requireTracklyAccess', '../services/trackly-access.js'],
    ['azureRehearsalRateLimitOptions', 'azureRehearsalRateLimitOptions', '../utils/azure-rehearsal-ip.js'],
  ]) {
    assertImportBinding(source, importedName, localName, moduleName, sourcePath);
  }
  assertActiveVariableInitializerAst(
    source,
    'RESOURCE_METADATA_URL',
    "`${process.env.MCP_ISSUER_URL || 'https://mcp.usetrackly.app'}/.well-known/oauth-protected-resource/api/plugin/trackly/mcp`",
    sourcePath,
  );
  assertActiveVariableInitializerAst(
    source,
    'allowedOrigins',
    `new Set([
      'https://closeai.mba',
      'https://www.closeai.mba',
      'https://usetrackly.app',
      'https://www.usetrackly.app',
      'https://mcp.usetrackly.app',
      'https://chatgpt.com',
    ])`,
    sourcePath,
  );
  assertActiveFunctionDefinitionAst(
    source,
    'validateOrigin',
    `function validateOrigin(req: Request, res: Response, next: NextFunction): void {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        res.status(403).json({ error: 'Forbidden origin' });
        return;
      }
      next();
    }`,
    sourcePath,
  );
  const allowedOriginsDeclaration = activeVariableDeclarator(
    source,
    'allowedOrigins',
    sourcePath,
  ).declarator;
  const validateOriginDefinition = activeNamedDefinitionAst(source, 'validateOrigin', sourcePath);
  const lockedAllowedOriginReferences = collectBindingReferences(
    validateOriginDefinition,
    'allowedOrigins',
    () => false,
  );
  assert.equal(
    lockedAllowedOriginReferences.length,
    1,
    `validateOrigin in ${sourcePath} must perform exactly one locked allowedOrigins membership check`,
  );
  assert.deepEqual(
    collectBindingReferences(ast, 'allowedOrigins', () => false),
    [allowedOriginsDeclaration.id, ...lockedAllowedOriginReferences],
    `allowedOrigins in ${sourcePath} must not be reassigned, mutated, aliased, escaped, or referenced outside its locked origin check`,
  );
  assert.deepEqual(
    canonicalSchemaAst(activeVariableDeclarator(source, 'bearerAuth', sourcePath).declarator.init),
    canonicalSchemaAst(babelParser.parseExpression(
      'requireBearerAuth({ verifier: tracklyOAuthProvider, resourceMetadataUrl: RESOURCE_METADATA_URL })',
      { plugins: ['typescript'] },
    )),
    `bearerAuth in ${sourcePath} must be the SDK bearer authentication middleware`,
  );
  assertActiveFunctionDefinitionAst(
    source,
    'enforcePluginResource',
    `function enforcePluginResource(
      req: Request,
      res: Response,
      next: NextFunction,
    ): void {
      if ((req as Request & { auth?: HostedOAuthAuthInfo }).auth?.extra?.resource === MCP_PLUGIN_RESOURCE) {
        next();
        return;
      }
      res.setHeader('WWW-Authenticate', \`Bearer resource_metadata="\${RESOURCE_METADATA_URL}"\`);
      res.status(401).json({ error: 'Bearer token is not valid for the trackly plugin resource' });
    }`,
    sourcePath,
  );
  assertActiveFunctionDefinitionAst(
    source,
    'requirePluginEnabled',
    `function requirePluginEnabled(
      _req: Request,
      res: Response,
      next: NextFunction,
    ): void {
      if (process.env.MCP_SERVER_ENABLED === 'true') {
        next();
        return;
      }
      res.status(503).json({ error: 'trackly plugin is not enabled' });
    }`,
    sourcePath,
  );
  assertActiveVariableInitializerAst(
    source,
    'PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX',
    '6_000',
    sourcePath,
  );
  assertActiveVariableInitializerAst(
    source,
    'ipLimiter',
    `rateLimit({
      windowMs: 60_000,
      max: PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many trackly plugin requests. Try again later.' },
      ...azureRehearsalRateLimitOptions(),
    })`,
    sourcePath,
  );
  assertActiveVariableInitializerAst(
    source,
    'identityLimiter',
    `rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        const auth = (req as Request & { auth?: HostedOAuthAuthInfo }).auth;
        return auth?.extra?.userId
          ? \`\${auth.clientId}:\${auth.extra.userId}\`
          : ipKeyGenerator(req.ip || '');
      },
      message: { error: 'trackly plugin rate limit exceeded. Try again later.' },
    })`,
    sourcePath,
  );
  const directHandlerDeclarators = handler.body.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  ));
  const handlerInitializer = (name) => {
    const matches = directHandlerDeclarators.filter((declarator) => (
      declarator.id?.type === 'Identifier' && declarator.id.name === name
    ));
    assert.equal(matches.length, 1, `POST / handler in ${sourcePath} must directly bind ${name} exactly once`);
    assert.ok(matches[0].init, `${name} in POST / handler in ${sourcePath} must have an initializer`);
    return matches[0].init;
  };
  assert.deepEqual(
    canonicalSchemaAst(handlerInitializer('authInfo')),
    canonicalSchemaAst(babelParser.parseExpression(
      '(req as Request & { auth: HostedOAuthAuthInfo }).auth',
      { plugins: ['typescript'] },
    )),
    `POST / handler in ${sourcePath} must derive authInfo from the authenticated request context`,
  );
  assert.deepEqual(
    canonicalSchemaAst(handlerInitializer('authToken')),
    canonicalSchemaAst(babelParser.parseExpression(
      'generateHostedOAuthInternalToken(authInfo)',
      { plugins: ['typescript'] },
    )),
    `POST / handler in ${sourcePath} must mint authToken only from authenticated authInfo`,
  );
  const factoryCalls = handler.body.body.flatMap((statement) => {
    if (statement.type !== 'VariableDeclaration') return [];
    return statement.declarations.filter((declarator) => (
      declarator.init?.type === 'CallExpression'
      && babelCalleeName(declarator.init.callee) === expectedFactory
    ));
  });
  assert.equal(
    factoryCalls.length,
    1,
    `POST / handler in ${sourcePath} must directly instantiate ${expectedFactory} exactly once`,
  );
  assert.equal(factoryCalls[0].id?.type, 'Identifier');
  assert.equal(factoryCalls[0].id.name, 'server');
  assert.equal(factoryCalls[0].init.arguments.length, 1);
  assert.equal(factoryCalls[0].init.arguments[0]?.type, 'Identifier');
  assert.equal(factoryCalls[0].init.arguments[0].name, 'authToken');

  const transportDeclarations = handler.body.body.flatMap((statement) => {
    if (statement.type !== 'VariableDeclaration') return [];
    return statement.declarations.filter((declarator) => (
      declarator.id?.type === 'Identifier'
      && declarator.id.name === 'transport'
      && declarator.init?.type === 'NewExpression'
      && babelCalleeName(declarator.init.callee) === 'StreamableHTTPServerTransport'
    ));
  });
  assert.equal(
    transportDeclarations.length,
    1,
    `POST / handler in ${sourcePath} must directly create exactly one StreamableHTTPServerTransport`,
  );
  assert.deepEqual(
    canonicalSchemaAst(transportDeclarations[0].init),
    canonicalSchemaAst(babelParser.parseExpression(
      'new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })',
    )),
    `POST / handler in ${sourcePath} must preserve the canonical stateless StreamableHTTPServerTransport construction`,
  );
  const tryStatements = handler.body.body.filter((statement) => statement.type === 'TryStatement');
  assert.equal(tryStatements.length, 1, `POST / handler in ${sourcePath} must execute exactly one live transport try block`);
  const liveTry = tryStatements[0];
  const liveTryIndex = handler.body.body.indexOf(liveTry);
  assert.deepEqual(
    handler.body.body.slice(0, liveTryIndex).map((statement) => (
      statement.type === 'VariableDeclaration'
        && statement.declarations.length === 1
        && statement.declarations[0].id?.type === 'Identifier'
        ? statement.declarations[0].id.name
        : null
    )),
    ['authInfo', 'authToken', 'server', 'transport'],
    `POST / handler in ${sourcePath} must reach factory creation and its live transport without an earlier exit, throw, branch, or side effect`,
  );
  const directConnects = handler.body.body.flatMap((statement) => {
    if (statement.type !== 'TryStatement') return [];
    return statement.block.body.filter((candidate) => (
      candidate.type === 'ExpressionStatement'
      && candidate.expression?.type === 'AwaitExpression'
      && candidate.expression.argument?.type === 'CallExpression'
      && babelCalleeName(candidate.expression.argument.callee) === 'server.connect'
      && candidate.expression.argument.arguments.length === 1
      && candidate.expression.argument.arguments[0]?.type === 'Identifier'
      && candidate.expression.argument.arguments[0].name === 'transport'
    ));
  });
  assert.equal(
    directConnects.length,
    1,
    `POST / handler in ${sourcePath} must directly connect its exact factory-result server to its live transport`,
  );
  const requestDispatches = handler.body.body.flatMap((statement) => {
    if (statement.type !== 'TryStatement') return [];
    return statement.block.body.filter((candidate) => {
      const expression = candidate.type === 'ExpressionStatement' ? candidate.expression : null;
      const call = expression?.type === 'AwaitExpression' ? expression.argument : null;
      return call?.type === 'CallExpression'
        && babelCalleeName(call.callee) === 'transport.handleRequest'
        && call.arguments.length === 3
        && call.arguments[0]?.type === 'Identifier'
        && call.arguments[0].name === 'req'
        && call.arguments[1]?.type === 'Identifier'
        && call.arguments[1].name === 'res'
        && call.arguments[2]?.type === 'MemberExpression'
        && !call.arguments[2].computed
        && call.arguments[2].object?.type === 'Identifier'
        && call.arguments[2].object.name === 'req'
        && call.arguments[2].property?.type === 'Identifier'
        && call.arguments[2].property.name === 'body';
    });
  });
  assert.equal(
    requestDispatches.length,
    1,
    `POST / handler in ${sourcePath} must directly dispatch req, res, and req.body through its connected transport`,
  );
  assert.ok(
    directConnects[0].start < requestDispatches[0].start,
    `POST / handler in ${sourcePath} must connect the server before dispatching the live request`,
  );
  assert.deepEqual(
    liveTry.block.body.slice(0, 2),
    [directConnects[0], requestDispatches[0]],
    `POST / handler in ${sourcePath} must reach connect and request dispatch without an intervening exit or throw`,
  );
  assert.equal(
    liveTry.finalizer?.type,
    'BlockStatement',
    `POST / handler in ${sourcePath} must unconditionally close its routed server in finally`,
  );
  assert.equal(
    liveTry.finalizer.body.length,
    1,
    `POST / handler in ${sourcePath} must close its routed server as the sole finally operation`,
  );
  const closeStatement = liveTry.finalizer.body[0];
  assert.equal(
    closeStatement?.type,
    'ExpressionStatement',
    `POST / handler in ${sourcePath} must await closing the exact routed server after dispatch or error`,
  );
  assert.equal(
    closeStatement.expression?.type,
    'AwaitExpression',
    `POST / handler in ${sourcePath} must await closing the exact routed server after dispatch or error`,
  );
  const awaitedClose = closeStatement.expression.argument;
  assert.equal(
    awaitedClose?.type,
    'CallExpression',
    `POST / handler in ${sourcePath} must await closing the exact routed server after dispatch or error`,
  );
  let closeCall = awaitedClose;
  if (awaitedClose.callee?.type === 'MemberExpression'
    && !awaitedClose.callee.computed
    && awaitedClose.callee.property?.type === 'Identifier'
    && awaitedClose.callee.property.name === 'catch') {
    assert.deepEqual(
      canonicalSchemaAst(awaitedClose.arguments),
      canonicalSchemaAst(babelParser.parseExpression('[() => {}]', { plugins: ['typescript'] }).elements),
      `POST / handler in ${sourcePath} may only suppress close failure with the locked empty catch`,
    );
    closeCall = awaitedClose.callee.object;
  }
  assert.equal(
    closeCall?.type,
    'CallExpression',
    `POST / handler in ${sourcePath} must await closing the exact routed server after dispatch or error`,
  );
  assert.equal(
    babelCalleeName(closeCall.callee),
    'server.close',
    `POST / handler in ${sourcePath} must await closing the exact routed server after dispatch or error`,
  );
  assert.equal(closeCall.arguments.length, 0);
}

function staticExpressPathCovers(candidatePath, mountPath, method) {
  const normalizedCandidate = candidatePath.length > 1
    ? candidatePath.replace(/\/+$/, '').toLowerCase()
    : candidatePath.toLowerCase();
  const normalizedMount = mountPath.length > 1
    ? mountPath.replace(/\/+$/, '').toLowerCase()
    : mountPath.toLowerCase();
  const patternIndex = normalizedCandidate.search(/[^a-z0-9/_-]/);
  if (patternIndex !== -1) {
    const staticPrefix = normalizedCandidate.slice(0, patternIndex).replace(/\/+$/, '');
    return staticPrefix === ''
      || normalizedMount.startsWith(staticPrefix);
  }
  if (method === 'use') {
    return normalizedCandidate === '/'
      || normalizedMount === normalizedCandidate
      || normalizedMount.startsWith(`${normalizedCandidate}/`);
  }
  if (normalizedCandidate === normalizedMount || normalizedCandidate === '*') return true;
  return false;
}

function canonicalPluginMount(factory, routerBinding, mountPath, sourcePath) {
  const mounts = factory.body.body.filter((statement) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    return call?.type === 'CallExpression'
      && babelCalleeName(call.callee) === 'app.use'
      && call.arguments[0]?.type === 'StringLiteral'
      && call.arguments[0].value === mountPath
      && call.arguments[1]?.type === 'Identifier'
      && call.arguments[1].name === routerBinding
      && call.arguments.length === 2;
  });
  assert.equal(
    mounts.length,
    1,
    `createApp in ${sourcePath} must directly mount imported ${routerBinding} exactly once at ${mountPath}`,
  );
  return mounts[0];
}

const REVIEWED_GLOBAL_MIDDLEWARE_CALL_DIGESTS = Object.freeze([
  'c9c8443c9a480263e54218e603a7ed927d1e4e411c7a4542e80206cb5b3ddecd',
  '81d41aba94334a95d3a6002fd6ced8069b9739cd52c6679c6293e01c3f547f75',
  '1eac0496bd02d2dadc4227b753c0ca2d04169bf3c43bec0f5d1eaa0c4bd4bf96',
  'f730c8df64484529aff713b1a49bdfcc570b99fb682f60d17a5fde0f9eed529a',
  '12def47c0dc1628a891b9045ed9c275af25dd73660929d528943f95a98c34855',
  'bc0d7d12f97ab6e9e79b00fa3701899806387b16353d9575628545a06644b2e9',
  'd63cf7bbc1fae45f475807325f4178283bfea854bf4aeecaf7754f66e509e0a5',
  'd79c16521f24347d7114358baafc46d77bbe47fe2034506bf941521e9e66737f',
  '971bb5b2a58a45df2caf26342572fcc3221e86544e0335be81a86cb22a30e284',
]);
const EXPRESS_ROUTE_CALL_METHODS = new Set([
  'use', 'all',
  'acl', 'bind', 'checkout', 'connect', 'copy', 'delete', 'get', 'head', 'link', 'lock',
  'm-search', 'merge', 'mkactivity', 'mkcalendar', 'mkcol', 'move', 'notify', 'options',
  'patch', 'post', 'propfind', 'proppatch', 'purge', 'put', 'query', 'rebind', 'report',
  'search', 'source', 'subscribe', 'trace', 'unbind', 'unlink', 'unlock', 'unsubscribe',
]);
const EXPRESS_APPLICATION_CALL_METHODS = new Set([...EXPRESS_ROUTE_CALL_METHODS, 'set']);

function staticMemberName(member) {
  if (member?.type !== 'MemberExpression') return null;
  if (!member.computed && member.property?.type === 'Identifier') return member.property.name;
  if (member.computed && member.property?.type === 'StringLiteral') return member.property.value;
  return null;
}

function assertPluginRoutePrecedence(
  source,
  routerBinding,
  mountPath,
  sourcePath,
  {
    resolvedFactory = null,
    reviewedGlobalMiddlewareCallDigests = REVIEWED_GLOBAL_MIDDLEWARE_CALL_DIGESTS,
  } = {},
) {
  const factory = resolvedFactory || activeNamedDefinitionAst(source, 'createApp', sourcePath);
  assert.equal(factory.body?.type, 'BlockStatement', `createApp in ${sourcePath} must use a block body`);
  const canonicalMount = canonicalPluginMount(factory, routerBinding, mountPath, sourcePath);
  const canonicalCall = canonicalMount.expression;
  const canonicalMountIndex = factory.body.body.indexOf(canonicalMount);
  assert.ok(
    factory.body.body.slice(0, canonicalMountIndex).every((statement) => (
      statement.type === 'VariableDeclaration' || statement.type === 'ExpressionStatement'
    )),
    `createApp in ${sourcePath} must preserve straight-line setup and must not place an unconditional return or throw before the canonical plugin mount`,
  );
  const directCreateAppCalls = new Set(factory.body.body.flatMap((statement) => (
    statement.type === 'ExpressionStatement' && statement.expression?.type === 'CallExpression'
      ? [statement.expression]
      : []
  )));
  const routeMethods = EXPRESS_ROUTE_CALL_METHODS;
  const reviewedGlobalMiddlewareCallDigestSet = new Set(reviewedGlobalMiddlewareCallDigests);
  const encounteredReviewedGlobalMiddlewareDigests = [];
  const earlierCoveringHandlers = [];
  function chainedRoutePath(receiver) {
    const candidate = unwrapTransparentExpression(receiver);
    if (candidate?.type !== 'CallExpression') return null;
    const callee = unwrapTransparentExpression(candidate.callee);
    if (callee?.type !== 'MemberExpression') return null;
    const method = staticMemberName(callee);
    const object = unwrapTransparentExpression(callee.object);
    if (object?.type === 'Identifier' && object.name === 'app' && method === 'route') {
      return candidate.arguments.length === 1 ? candidate.arguments[0] : null;
    }
    return chainedRoutePath(object);
  }
  let legalRedirectPathsVerified = false;
  function verifyLegalRedirectPaths(pathArgument, method) {
    if (legalRedirectPathsVerified) return;
    const declarations = factory.body.body.filter((statement) => (
      statement.type === 'VariableDeclaration'
      && statement.declarations.length === 1
      && statement.declarations[0].id?.type === 'Identifier'
      && statement.declarations[0].id.name === 'LEGAL_REDIRECT_PATHS'
    ));
    assert.equal(
      declarations.length,
      1,
      `createApp in ${sourcePath} must declare LEGAL_REDIRECT_PATHS exactly once`,
    );
    assert.equal(declarations[0].kind, 'const', `LEGAL_REDIRECT_PATHS in ${sourcePath} must be immutable`);
    const declaration = declarations[0].declarations[0];
    const initializer = declaration.init;
    assert.equal(initializer?.type, 'ArrayExpression', `LEGAL_REDIRECT_PATHS in ${sourcePath} must be a static array`);
    assert.ok(initializer.elements.length > 0, `LEGAL_REDIRECT_PATHS in ${sourcePath} must not be empty`);
    for (const element of initializer.elements) {
      assert.equal(element?.type, 'StringLiteral', `LEGAL_REDIRECT_PATHS in ${sourcePath} must contain only static paths`);
      assert.equal(
        staticExpressPathCovers(element.value, mountPath, method),
        false,
        `LEGAL_REDIRECT_PATHS in ${sourcePath} must remain disjoint from ${mountPath}`,
      );
    }
    const references = collectBindingReferences(factory, 'LEGAL_REDIRECT_PATHS', () => false);
    assert.deepEqual(
      references,
      [declaration.id, pathArgument],
      `LEGAL_REDIRECT_PATHS in ${sourcePath} must not be aliased, escaped, mutated, or used outside its locked route`,
    );
    legalRedirectPathsVerified = true;
  }
  function visitEarlierRoutes(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitEarlierRoutes(child);
      return;
    }
    if (node.type === 'CallExpression' && node.start < canonicalCall.start) {
      const callee = unwrapTransparentExpression(node.callee);
      const receiver = callee?.type === 'MemberExpression'
        ? unwrapTransparentExpression(callee.object)
        : null;
      const directAppCall = receiver?.type === 'Identifier' && receiver.name === 'app';
      const routePath = directAppCall ? null : chainedRoutePath(receiver);
      const staticMethod = staticMemberName(callee);
      const possibleRouteCall = callee?.type === 'MemberExpression'
        && (directAppCall || routePath !== null)
        && (staticMethod === null || routeMethods.has(staticMethod));
      if (possibleRouteCall) {
        const method = staticMethod && routeMethods.has(staticMethod) ? staticMethod : 'use';
        const pathArgument = routePath || node.arguments[0];
        const knownDisjointLegalRedirectPaths = pathArgument?.type === 'Identifier'
          && pathArgument.name === 'LEGAL_REDIRECT_PATHS';
        if (knownDisjointLegalRedirectPaths) {
          verifyLegalRedirectPaths(pathArgument, method);
        }
        const globalMiddlewareDigest = directAppCall && method === 'use' && node.arguments.length === 1
          ? sha256ExactBytes(JSON.stringify(canonicalSchemaAst(node)))
          : null;
        const reviewedGlobalMiddleware = globalMiddlewareDigest !== null
          && reviewedGlobalMiddlewareCallDigestSet.has(globalMiddlewareDigest)
          && directCreateAppCalls.has(node);
        if (reviewedGlobalMiddleware) encounteredReviewedGlobalMiddlewareDigests.push(globalMiddlewareDigest);
        const covers = pathArgument?.type === 'StringLiteral'
          ? staticExpressPathCovers(pathArgument.value, mountPath, method)
          : !knownDisjointLegalRedirectPaths && !reviewedGlobalMiddleware;
        if (covers) earlierCoveringHandlers.push(node);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitEarlierRoutes(child);
    }
  }
  visitEarlierRoutes(factory.body);
  assert.deepEqual(
    encounteredReviewedGlobalMiddlewareDigests,
    reviewedGlobalMiddlewareCallDigests,
    `createApp in ${sourcePath} must preserve the complete ordered reviewed global middleware inventory before ${mountPath}`,
  );
  assert.equal(
    earlierCoveringHandlers.length,
    0,
    `createApp in ${sourcePath} must not have an earlier Express route or path-scoped middleware covering ${mountPath}`,
  );
  return canonicalMount;
}

function assertServerListenSemantics(
  source,
  sourcePath,
  { listenAstSha256 = '791d37989e4e894d2abd4634ce723c795fb8611cdc8dd865c0534d9ee97bbfe7' } = {},
) {
  assertActiveVariableInitializerAst(source, 'PORT', 'process.env.PORT || 3000', sourcePath);
  const startServer = activeNamedDefinitionAst(source, 'startServer', sourcePath);
  const directListens = startServer.body.body.filter((statement) => (
    statement.type === 'ExpressionStatement'
    && statement.expression?.type === 'CallExpression'
    && babelCalleeName(statement.expression.callee) === 'app.listen'
  ));
  assert.equal(directListens.length, 1, `startServer in ${sourcePath} must have exactly one direct app.listen statement`);
  const allListens = [];
  function visitListens(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitListens(child);
      return;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const receiver = unwrapTransparentExpression(node.callee.object);
      const method = !node.callee.computed && node.callee.property?.type === 'Identifier'
        ? node.callee.property.name
        : node.callee.computed && node.callee.property?.type === 'StringLiteral'
          ? node.callee.property.value
          : null;
      if (receiver?.type === 'Identifier' && receiver.name === 'app' && method === 'listen') {
        allListens.push(node);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitListens(child);
    }
  }
  visitListens(startServer.body);
  const listenCall = directListens[0].expression;
  assert.deepEqual(
    allListens,
    [listenCall],
    `startServer in ${sourcePath} must have exactly one reachable app.listen call and no nested or computed alternatives`,
  );
  assert.equal(listenCall.arguments.length, 2, `app.listen in ${sourcePath} must receive exactly PORT and its callback`);
  assert.equal(
    listenCall.arguments[0]?.type === 'Identifier' ? listenCall.arguments[0].name : null,
    'PORT',
    `app.listen in ${sourcePath} must bind the active canonical PORT`,
  );
  assert.equal(
    listenCall.arguments[1]?.type,
    'ArrowFunctionExpression',
    `app.listen in ${sourcePath} must use the canonical startup callback`,
  );
  assert.equal(listenCall.arguments[1].params.length, 0, `app.listen callback in ${sourcePath} must not accept parameters`);
  assert.equal(listenCall.arguments[1].body?.type, 'BlockStatement', `app.listen callback in ${sourcePath} must use a block body`);
  assert.equal(
    sha256ExactBytes(JSON.stringify(canonicalSchemaAst(directListens[0]))),
    listenAstSha256,
    `app.listen in ${sourcePath} must preserve its locked active semantic AST`,
  );
  return directListens[0];
}

function assertLivePluginRouterMount(
  source,
  routerBinding,
  routerModule,
  mountPath,
  sourcePath,
  options = {},
) {
  assertImportBinding(source, 'default', routerBinding, routerModule, sourcePath);
  assertRateLimitBindingSemantics(source, sourcePath);
  assertImportedFunctionCallInventory(
    source,
    'azureRehearsalRateLimitOptions',
    './utils/azure-rehearsal-ip',
    ['generalLimiter', 'authLimiter'],
    sourcePath,
  );
  const ast = parseFullSource(source, sourcePath);
  const exportedFactories = ast.program.body.filter((statement) => (
    statement.type === 'ExportNamedDeclaration'
    && statement.declaration?.type === 'FunctionDeclaration'
    && statement.declaration.id?.name === 'createApp'
  ));
  assert.equal(
    exportedFactories.length,
    1,
    `${sourcePath} must export exactly one live createApp application factory`,
  );
  const factory = exportedFactories[0].declaration;
  assert.equal(
    activeNamedDefinitionAst(source, 'createApp', sourcePath),
    factory,
    `createApp in ${sourcePath} must remain the immutable exported application factory`,
  );
  assert.equal(factory.async, false, `createApp in ${sourcePath} must remain synchronous`);
  assert.equal(factory.generator, false, `createApp in ${sourcePath} must not return a generator`);
  assert.equal(factory.params.length, 0, `createApp in ${sourcePath} must not accept shadowing parameters`);
  const appDeclarations = factory.body.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter((declaration) => (
        statement.kind === 'const'
        && declaration.id?.type === 'Identifier'
        && declaration.id.name === 'app'
        && declaration.init?.type === 'CallExpression'
        && babelCalleeName(declaration.init.callee) === 'express'
        && declaration.init.arguments.length === 0
      ))
      : []
  ));
  assert.equal(
    appDeclarations.length,
    1,
    `createApp in ${sourcePath} must bind exactly one immutable Express application`,
  );
  const shadowedRouters = factory.body.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter((declaration) => (
        declaration.id?.type === 'Identifier' && declaration.id.name === routerBinding
      ))
      : []
  ));
  assert.equal(
    shadowedRouters.length,
    0,
    `createApp in ${sourcePath} must mount the imported ${routerBinding} binding without shadowing it`,
  );
  const routerImport = ast.program.body.flatMap((statement) => (
    statement.type === 'ImportDeclaration' && statement.source.value === routerModule
      ? statement.specifiers.filter((specifier) => (
        specifier.type === 'ImportDefaultSpecifier' && specifier.local?.name === routerBinding
      ))
      : []
  ));
  assert.equal(routerImport.length, 1);
  const routerReferences = [];
  function visitRouterReferences(node, parent = null, parentKey = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitRouterReferences(child, parent, parentKey);
      return;
    }
    const isStaticPropertyName = parent?.type === 'MemberExpression'
      && parentKey === 'property' && !parent.computed;
    const isStaticObjectKey = parent?.type === 'ObjectProperty'
      && parentKey === 'key' && !parent.computed;
    if (node.type === 'Identifier'
      && node.name === routerBinding
      && !isStaticPropertyName
      && !isStaticObjectKey) routerReferences.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitRouterReferences(child, node, key);
    }
  }
  visitRouterReferences(ast);
  const mounts = [canonicalPluginMount(factory, routerBinding, mountPath, sourcePath)];
  assertPluginRoutePrecedence(source, routerBinding, mountPath, sourcePath, {
    ...options,
    resolvedFactory: factory,
  });
  assert.deepEqual(
    routerReferences,
    [routerImport[0].local, mounts[0].expression.arguments[1]],
    `${sourcePath} must not alias, escape, or register ${routerBinding} outside its locked live application mount`,
  );
  const directReturns = factory.body.body.filter((statement) => statement.type === 'ReturnStatement');
  assert.equal(
    directReturns.length,
    1,
    `createApp in ${sourcePath} must directly return its mounted application exactly once`,
  );
  assert.equal(factory.body.body.at(-1), directReturns[0], `createApp in ${sourcePath} must end by returning its application`);
  assert.equal(
    directReturns[0].argument?.type === 'Identifier' ? directReturns[0].argument.name : null,
    'app',
    `createApp in ${sourcePath} must return the exact application receiving ${mountPath}`,
  );
  const permittedAppReferences = new Set([appDeclarations[0].id, directReturns[0].argument]);
  const unverifiedAppReferences = [];
  function visitAppReferences(node, parent = null, parentKey = null, grandparent = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitAppReferences(child, parent, parentKey, grandparent);
      return;
    }
    if (node.type === 'Identifier' && node.name === 'app') {
      const isStaticMemberName = parent?.type === 'MemberExpression'
        && parentKey === 'property'
        && !parent.computed;
      const isStaticObjectKey = parent?.type === 'ObjectProperty'
        && parentKey === 'key'
        && !parent.computed
        && !parent.shorthand;
      const isReviewedDirectCall = parent?.type === 'MemberExpression'
        && parentKey === 'object'
        && grandparent?.type === 'CallExpression'
        && grandparent.callee === parent
        && EXPRESS_APPLICATION_CALL_METHODS.has(staticMemberName(parent));
      if (!isStaticMemberName
        && !isStaticObjectKey
        && !isReviewedDirectCall
        && !permittedAppReferences.has(node)) {
        unverifiedAppReferences.push(node);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitAppReferences(child, node, key, parent);
    }
  }
  visitAppReferences(factory);
  assert.deepEqual(
    unverifiedAppReferences,
    [],
    `createApp in ${sourcePath} must not alias, escape, or otherwise reference the canonical Express application outside direct calls and its final return`,
  );
  assert.ok(
    factory.body.body.indexOf(mounts[0]) < factory.body.body.indexOf(directReturns[0]),
    `createApp in ${sourcePath} must mount ${mountPath} before returning the application`,
  );

  const startServer = activeNamedDefinitionAst(source, 'startServer', sourcePath);
  assert.equal(startServer.body?.type, 'BlockStatement', `startServer in ${sourcePath} must use a block body`);
  assert.equal(startServer.async, false, `startServer in ${sourcePath} must remain synchronous`);
  assert.equal(startServer.generator, false, `startServer in ${sourcePath} must not defer execution as a generator`);
  assert.equal(startServer.params.length, 0, `startServer in ${sourcePath} must not shadow createApp through parameters`);
  const liveAppStatements = startServer.body.body.filter((statement) => (
    statement.type === 'VariableDeclaration' && statement.kind === 'const'
      && statement.declarations.some((declaration) => (
        declaration.id?.type === 'Identifier'
        && declaration.id.name === 'app'
        && declaration.init?.type === 'CallExpression'
        && babelCalleeName(declaration.init.callee) === 'createApp'
        && declaration.init.arguments.length === 0
      ))
  ));
  assert.equal(
    liveAppStatements.length,
    1,
    `startServer in ${sourcePath} must instantiate the exact exported createApp application`,
  );
  assert.equal(
    liveAppStatements[0].declarations.length,
    1,
    `startServer in ${sourcePath} must isolate createApp in one side-effect-free declaration`,
  );
  const liveListens = startServer.body.body.filter((statement) => (
    statement.type === 'ExpressionStatement'
    && statement.expression?.type === 'CallExpression'
    && babelCalleeName(statement.expression.callee) === 'app.listen'
  ));
  assert.equal(liveListens.length, 1, `startServer in ${sourcePath} must listen on the exact createApp result`);
  const liveListenIndex = startServer.body.body.indexOf(liveListens[0]);
  assert.equal(
    startServer.body.body.indexOf(liveAppStatements[0]),
    1,
    `startServer in ${sourcePath} must create the live application immediately after its locked process-guard prelude`,
  );
  assert.deepEqual(
    canonicalSchemaAst(startServer.body.body[0]),
    canonicalSchemaAst(parseFullSource('installProcessGuards();', 'locked startServer prelude').program.body[0]),
    `startServer in ${sourcePath} must execute only installProcessGuards before creating the live application`,
  );
  assert.equal(
    liveListenIndex,
    startServer.body.body.indexOf(liveAppStatements[0]) + 1,
    `startServer in ${sourcePath} must immediately listen on the exact createApp result`,
  );
  assertActiveTopLevelStatementAst(
    source,
    `if (require.main === module) {
      startServer();
    }`,
    sourcePath,
  );
}

function assertRateLimitBindingSemantics(source, sourcePath) {
  const ast = parseFullSource(source, sourcePath);
  const factory = activeNamedDefinitionAst(source, 'createApp', sourcePath);
  const rateLimitImport = assertImportBinding(source, 'default', 'rateLimit', 'express-rate-limit', sourcePath);
  const rateLimitCalls = [];
  function visitRateLimitCalls(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitRateLimitCalls(child);
      return;
    }
    if (node.type === 'CallExpression') {
      const callee = unwrapTransparentExpression(node.callee);
      if (callee?.type === 'Identifier' && callee.name === 'rateLimit') rateLimitCalls.push(callee);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitRateLimitCalls(child);
    }
  }
  visitRateLimitCalls(ast);
  assert.deepEqual(
    collectBindingReferences(ast, 'rateLimit', () => false),
    [rateLimitImport.local, ...rateLimitCalls],
    `rateLimit in ${sourcePath} must come only from express-rate-limit and remain confined to its reviewed limiter initializers`,
  );
  for (const [name, expectedMountPaths] of [
    ['generalLimiter', ['/api/']],
    ['authLimiter', ['/auth/', '/api/admin/login']],
  ]) {
    const definitions = [];
    function visitDefinitions(node) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visitDefinitions(child);
        return;
      }
      if (node.type === 'VariableDeclaration') {
        for (const declarator of node.declarations) {
          if (declarator.id?.type === 'Identifier' && declarator.id.name === name) {
            definitions.push({ declarator, declaration: node });
          }
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === 'loc' || key === 'extra') continue;
        visitDefinitions(child);
      }
    }
    visitDefinitions(ast);
    assert.equal(definitions.length, 1, `${name} in ${sourcePath} must have exactly one active declaration`);
    const { declarator, declaration } = definitions[0];
    assert.equal(declaration.kind, 'const', `${name} in ${sourcePath} must remain immutable`);
    const appUseMounts = factory.body.body.flatMap((statement) => {
      const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
      if (call?.type !== 'CallExpression' || babelCalleeName(call.callee) !== 'app.use') return [];
      return call.arguments.flatMap((argument, index) => (
        argument?.type === 'Identifier' && argument.name === name
          ? [{
            path: index === 1 && call.arguments[0]?.type === 'StringLiteral'
              ? call.arguments[0].value
              : null,
            reference: argument,
          }]
          : []
      ));
    });
    assert.deepEqual(
      appUseMounts.map((mount) => mount.path),
      expectedMountPaths,
      `${name} in ${sourcePath} must protect the exact reviewed app.use mount paths`,
    );
    assert.deepEqual(
      collectBindingReferences(ast, name, () => false),
      [declarator.id, ...appUseMounts.map((mount) => mount.reference)],
      `${name} in ${sourcePath} must not be reassigned, mutated, aliased, escaped, or referenced outside its reviewed app.use mounts`,
    );
  }
}

function assertMcpScopeHelperSemantics(source, sourcePath) {
  assertActiveVariableInitializerAst(
    source,
    'MCP_SCOPE_DEFINITIONS',
    `{
      'jobs:read': 'Search and view jobs, companies, contacts, and discovery preferences',
      'tracking:read': 'View your saved jobs and application status',
      'tracking:write': 'Update your job tracking status and discovery preferences',
      'profile:read': 'View your application profile and Apply readiness',
      'profile:write': 'Save user-approved application answers',
      'sensitive:read': 'Read consented sensitive application answers needed for form filling',
      'sensitive:write': 'Grant or revoke encrypted storage consent for sensitive application answers',
      'apply:read': 'View your Apply queue, work, and value-free progress',
      'apply:write': 'Read and update your application profile and prepare user-approved applications',
    } as const`,
    sourcePath,
  );
  assertActiveVariableInitializerAst(
    source,
    'MCP_SUPPORTED_SCOPES',
    'Object.freeze(Object.keys(MCP_SCOPE_DEFINITIONS) as McpScope[])',
    sourcePath,
  );
  assertActiveVariableInitializerAst(
    source,
    'MCP_SUPPORTED_SCOPE_SET',
    'new Set<string>(MCP_SUPPORTED_SCOPES)',
    sourcePath,
  );
  assertActiveFunctionDefinitionAst(
    source,
    'normalizeMcpScopes',
    `function normalizeMcpScopes(
      values: readonly string[] | undefined,
      defaultToAll = false,
    ): McpScope[] {
      const candidate = values && values.length > 0
        ? values
        : (defaultToAll ? MCP_SUPPORTED_SCOPES : []);
      if (candidate.length === 0 || candidate.some((scope) => !MCP_SUPPORTED_SCOPE_SET.has(scope))) {
        throw new Error('Unsupported or empty MCP scope request');
      }
      return [...new Set(candidate)] as McpScope[];
    }`,
    sourcePath,
  );
  assertActiveFunctionDefinitionAst(
    source,
    'isScopeSubset',
    `function isScopeSubset(
      candidate: readonly string[],
      allowed: readonly string[],
    ): boolean {
      const allowedSet = new Set(allowed);
      return candidate.every((scope) => allowedSet.has(scope));
    }`,
    sourcePath,
  );
  const scopeSetReferences = [];
  function visitScopeSetReferences(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitScopeSetReferences(child);
      return;
    }
    if (node.type === 'Identifier' && node.name === 'MCP_SUPPORTED_SCOPE_SET') {
      scopeSetReferences.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitScopeSetReferences(child);
    }
  }
  visitScopeSetReferences(parseFullSource(source, sourcePath));
  assert.equal(
    scopeSetReferences.length,
    2,
    `MCP_SUPPORTED_SCOPE_SET in ${sourcePath} must be referenced only by its immutable declaration and locked membership check`,
  );
}

function assertImmutablePluginScopeFreeMethods(source, sourcePath) {
  const name = 'TRACKLY_PLUGIN_SCOPE_FREE_METHODS';
  assertActiveVariableInitializerAst(
    source,
    name,
    `new Set([
      'server/discover',
      'initialize',
      'ping',
      'notifications/initialized',
      'notifications/cancelled',
      'notifications/roots/list_changed',
      'notifications/progress',
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'prompts/list',
    ])`,
    sourcePath,
  );
  const ast = parseFullSource(source, sourcePath);
  const declaration = activeVariableDeclarator(source, name, sourcePath).declarator;
  const membershipCalls = [];
  const references = [];
  function visit(node, parent = null, parentKey = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, parentKey);
      return;
    }
    if (node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && !node.callee.computed
      && node.callee.object?.type === 'Identifier'
      && node.callee.object.name === name
      && node.callee.property?.type === 'Identifier'
      && node.callee.property.name === 'has'
      && node.arguments.length === 1) membershipCalls.push(node);
    const isStaticPropertyName = parent?.type === 'MemberExpression'
      && parentKey === 'property' && !parent.computed;
    const isStaticObjectKey = parent?.type === 'ObjectProperty'
      && parentKey === 'key' && !parent.computed;
    if (node.type === 'Identifier'
      && node.name === name
      && !isStaticPropertyName
      && !isStaticObjectKey) references.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child, node, key);
    }
  }
  visit(ast);
  assert.equal(
    membershipCalls.length,
    1,
    `${name} in ${sourcePath} must have exactly one locked scope-bypass membership check`,
  );
  assert.deepEqual(
    references,
    [declaration.id, membershipCalls[0].callee.object],
    `${name} in ${sourcePath} must not be aliased, escaped, mutated, or used outside its locked membership check`,
  );
}

function assertImmutablePluginToolScopesSemantics(source, sourcePath) {
  const name = 'TRACKLY_PLUGIN_TOOL_SCOPES';
  const namesBinding = 'TRACKLY_PLUGIN_TOOL_NAMES';
  assertActiveVariableInitializerAst(
    source,
    namesBinding,
    'Object.freeze(Object.keys(TRACKLY_PLUGIN_TOOL_SCOPES))',
    sourcePath,
  );
  const ast = parseFullSource(source, sourcePath);
  const declaration = activeVariableDeclarator(source, name, sourcePath).declarator;
  const namesDeclaration = activeVariableDeclarator(source, namesBinding, sourcePath).declarator;
  const namesReferences = collectBindingReferences(
    namesDeclaration.init,
    name,
    () => false,
  );
  assert.equal(
    namesReferences.length,
    1,
    `${namesBinding} in ${sourcePath} must enumerate ${name} exactly once`,
  );
  const requiredScopesFunction = activeNamedDefinitionAst(
    source,
    'requiredScopesForPluginTool',
    sourcePath,
  );
  const lockedFunctionReferences = collectBindingReferences(
    requiredScopesFunction,
    name,
    () => false,
  );
  assert.ok(
    lockedFunctionReferences.length > 0,
    `requiredScopesForPluginTool in ${sourcePath} must read ${name}`,
  );
  assertActiveFunctionDefinitionAst(
    source,
    'diagnosticToolName',
    `function diagnosticToolName(value: unknown): string {
      return typeof value === 'string' && Object.hasOwn(TRACKLY_PLUGIN_TOOL_SCOPES, value)
        ? value
        : '[redacted]';
    }`,
    sourcePath,
  );
  const diagnosticFunction = activeNamedDefinitionAst(
    source,
    'diagnosticToolName',
    sourcePath,
  );
  const diagnosticFunctionReferences = collectBindingReferences(
    diagnosticFunction,
    name,
    () => false,
  );
  assert.equal(
    diagnosticFunctionReferences.length,
    1,
    `diagnosticToolName in ${sourcePath} must validate names against ${name} exactly once`,
  );
  const references = collectBindingReferences(ast, name, () => false);
  assert.deepEqual(
    references,
    [
      declaration.id,
      ...namesReferences,
      ...diagnosticFunctionReferences,
      ...lockedFunctionReferences,
    ],
    `${name} in ${sourcePath} must not be reassigned, mutated, aliased, escaped, or referenced outside its locked names catalog, diagnostic redaction, and requiredScopesForPluginTool`,
  );
}

function collectBindingReferences(ast, name, excludedReference) {
  const references = [];
  function visit(node, parent = null, parentKey = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, parentKey);
      return;
    }
    const isStaticMemberName = parent?.type === 'MemberExpression'
      && parentKey === 'property' && !parent.computed;
    const isStaticObjectKey = parent?.type === 'ObjectProperty'
      && parentKey === 'key' && !parent.computed && !parent.shorthand;
    if (node.type === 'Identifier'
      && node.name === name
      && !isStaticMemberName
      && !isStaticObjectKey
      && !excludedReference(node, parent, parentKey)) references.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child, node, key);
    }
  }
  visit(ast);
  return references;
}

function assertInstallProcessGuardsSemantics(
  source,
  sourcePath,
  { functionAstSha256 = '2191522a7f9636c823b1f78f0cb8685985cb35c873ef3c7cd5e30cb296500409' } = {},
) {
  assertActiveFunctionAstSha256(source, 'installProcessGuards', functionAstSha256, sourcePath);
  const definition = activeNamedDefinitionAst(source, 'installProcessGuards', sourcePath);
  assert.equal(definition.body?.type, 'BlockStatement', `installProcessGuards in ${sourcePath} must use a block body`);
  assert.deepEqual(
    canonicalSchemaAst(definition.body.body.at(-1)),
    canonicalSchemaAst(parseFullSource('interval.unref?.();', 'locked process-guard normal return').program.body[0]),
    `installProcessGuards in ${sourcePath} must end by returning normally after unreferring its interval`,
  );

  const startServer = activeNamedDefinitionAst(source, 'startServer', sourcePath);
  const invocation = startServer.body?.body?.[0]?.expression;
  assert.equal(
    invocation?.type === 'CallExpression'
      && invocation.callee?.type === 'Identifier'
      && invocation.callee.name === 'installProcessGuards'
      && invocation.arguments.length === 0,
    true,
    `startServer in ${sourcePath} must begin with the sole installProcessGuards invocation`,
  );
  const ast = parseFullSource(source, sourcePath);
  const references = collectBindingReferences(
    ast,
    'installProcessGuards',
    () => false,
  );
  assert.deepEqual(
    references,
    [definition.id, invocation.callee],
    `installProcessGuards in ${sourcePath} must be referenced only by its active definition and locked startServer invocation`,
  );
}

function assertApplicationFieldByKeyReferenceSemantics(
  catalogSource,
  catalogSourcePath,
  scopesSource,
  scopesSourcePath,
) {
  const name = 'APPLICATION_FIELD_BY_KEY';
  assertActiveVariableInitializerAst(
    catalogSource,
    name,
    'new Map(APPLICATION_PROFILE_FIELDS.map((field) => [field.key, field]))',
    catalogSourcePath,
  );
  const catalogDeclaration = activeVariableDeclarator(
    catalogSource,
    name,
    catalogSourcePath,
  ).declarator;
  const catalogReferences = collectBindingReferences(
    parseFullSource(catalogSource, catalogSourcePath),
    name,
    () => false,
  );
  assert.deepEqual(
    catalogReferences,
    [catalogDeclaration.id],
    `${name} in ${catalogSourcePath} must not be reassigned, mutated, aliased, escaped, or referenced outside its immutable declaration`,
  );

  const applicationFieldImport = assertImportBinding(
    scopesSource,
    name,
    name,
    '../services/application-profile/catalog.js',
    scopesSourcePath,
  );
  const scopesAst = parseFullSource(scopesSource, scopesSourcePath);
  const lookups = [];
  function visitLookups(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitLookups(child);
      return;
    }
    if (node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && !node.callee.computed
      && node.callee.object?.type === 'Identifier'
      && node.callee.object.name === name
      && node.callee.property?.type === 'Identifier'
      && node.callee.property.name === 'get'
      && node.arguments.length === 1) lookups.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitLookups(child);
    }
  }
  visitLookups(scopesAst);
  assert.equal(lookups.length, 2, `${name} in ${scopesSourcePath} must have exactly two locked sensitivity lookups`);
  const scopeReferences = collectBindingReferences(
    scopesAst,
    name,
    (_node, parent, parentKey) => parent?.type === 'ImportSpecifier' && parentKey === 'imported',
  );
  assert.deepEqual(
    scopeReferences,
    [applicationFieldImport.local, ...lookups.map((lookup) => lookup.callee.object)],
    `${name} in ${scopesSourcePath} must be referenced only by its import and two locked sensitivity lookups`,
  );
}

function registrationArgumentSources(source, registration, sourcePath) {
  assert.ok(
    registration?.call?.arguments?.length >= 3,
    `${registration?.name || 'Tool'} registration in ${sourcePath} must contain name, descriptor, and handler`,
  );
  return registration.call.arguments.map((argument) => source.slice(argument.start, argument.end));
}

function registeredInputSchemaName(registration, sourcePath) {
  if (registration.call.callee?.type === 'Identifier'
    && registration.call.callee.name === 'registerHostedMcpTool') {
    const schema = registration.call.arguments[3];
    if (schema?.type === 'Identifier') return schema.name;
    assert.equal(schema?.type, 'MemberExpression');
    assert.equal(schema.computed, false);
    assert.equal(schema.property?.type, 'Identifier');
    assert.equal(schema.property.name, 'shape');
    assert.equal(schema.object?.type, 'Identifier');
    return schema.object.name;
  }
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

function registrationDescriptorPropertySource(source, registration, propertyName, sourcePath) {
  let descriptor = registration.call.arguments[1];
  while (descriptor?.type === 'TSSatisfiesExpression' || descriptor?.type === 'TSAsExpression') {
    descriptor = descriptor.expression;
  }
  assert.equal(
    descriptor?.type,
    'ObjectExpression',
    `${registration.name} in ${sourcePath} must publish an object descriptor`,
  );
  const matches = descriptor.properties.filter((property) => (
    property.type === 'ObjectProperty'
    && !property.computed
    && (
      (property.key.type === 'Identifier' && property.key.name === propertyName)
      || (property.key.type === 'StringLiteral' && property.key.value === propertyName)
    )
  ));
  assert.equal(
    matches.length,
    1,
    `${registration.name} in ${sourcePath} must publish exactly one active ${propertyName} property`,
  );
  return source.slice(matches[0].value.start, matches[0].value.end);
}

function registrationDescriptorPropertyAst(source, registration, propertyName, sourcePath) {
  return parseExpectedExpression(
    registrationDescriptorPropertySource(source, registration, propertyName, sourcePath),
    `${registration.name}.${propertyName} in ${sourcePath}`,
  );
}

function registrationInputSchemaAst(source, registration, sourcePath) {
  const callee = registration.call.callee;
  if (callee?.type === 'Identifier' && callee.name === 'registerHostedMcpTool') {
    assert.ok(registration.call.arguments[3], `${registration.name} in ${sourcePath} must publish an input schema`);
    return registration.call.arguments[3];
  }
  const method = callee?.type === 'MemberExpression' && !callee.computed
    && callee.property?.type === 'Identifier'
    ? callee.property.name
    : null;
  if (method === 'tool') {
    assert.ok(registration.call.arguments[2], `${registration.name} in ${sourcePath} must publish an input schema`);
    return registration.call.arguments[2];
  }
  assert.equal(method, 'registerTool', `${registration.name} in ${sourcePath} has an unsupported registration method`);
  return registrationDescriptorPropertyAst(source, registration, 'inputSchema', sourcePath);
}

function staticBabelObjectProperties(node, label) {
  assert.equal(node?.type, 'ObjectExpression', `${label} must be an object expression`);
  const entries = node.properties.map((property) => {
    assert.equal(property.type, 'ObjectProperty', `${label} must not contain spreads or methods`);
    assert.equal(property.computed, false, `${label} must not contain computed properties`);
    const name = property.key.type === 'Identifier'
      ? property.key.name
      : property.key.type === 'StringLiteral'
        ? property.key.value
        : null;
    assert.equal(typeof name, 'string', `${label} must use static property names`);
    return [name, property.value];
  });
  assert.equal(new Set(entries.map(([name]) => name)).size, entries.length, `${label} must not repeat fields`);
  return Object.fromEntries(entries);
}

function assertBabelPropertyExpression(properties, property, expression, label) {
  assert.ok(properties[property], `${label} is missing ${property}`);
  const expected = babelParser.parseExpression(expression, { plugins: ['typescript'] });
  assert.deepEqual(
    canonicalSchemaAst(properties[property]),
    canonicalSchemaAst(expected),
    `${label}.${property} must equal ${expression}`,
  );
}

function assertActiveFunctionDefinitionAst(source, name, expectedSource, sourcePath) {
  const expectedProgram = parseFullSource(expectedSource, `${name} expected contract`).program.body;
  assert.equal(expectedProgram.length, 1, `${name} expected contract must contain exactly one declaration`);
  assert.deepEqual(
    canonicalSchemaAst(activeNamedDefinitionAst(source, name, sourcePath)),
    canonicalSchemaAst(expectedProgram[0]),
    `${name} in ${sourcePath} must preserve its locked executable branch semantics`,
  );
}

function assertActiveFunctionAstSha256(source, name, expectedSha256, sourcePath) {
  const digest = sha256ExactBytes(JSON.stringify(
    canonicalSchemaAst(activeNamedDefinitionAst(source, name, sourcePath)),
  ));
  assert.equal(
    digest,
    expectedSha256,
    `${name} in ${sourcePath} must preserve its locked active semantic AST`,
  );
}

function assertPluginUiContractSemantics(
  source,
  sourcePath,
  { htmlAstSha256 = 'a5962f5687896272ef8ca365e93be831a0bde5e637d7ecb96e7437585362e3cc' } = {},
) {
  assertActiveVariableInitializerAst(
    source,
    'TRACKLY_PLUGIN_UI_MIME_TYPE',
    "'text/html;profile=mcp-app'",
    sourcePath,
  );
  assertActiveVariableInitializerAst(source, 'UI_DOMAIN', "'https://mcp.usetrackly.app'", sourcePath);
  assertActiveVariableInitializerAst(
    source,
    'TRACKLY_PLUGIN_UI',
    `Object.freeze({
      readiness: 'ui://trackly/apply-readiness-v1.html',
      apply: 'ui://trackly/apply-run-v1.html',
      resume: 'ui://trackly/resume-handoff-v1.html',
      review: 'ui://trackly/review-ready-v1.html',
    })`,
    sourcePath,
  );
  assertActiveVariableInitializerAst(
    source,
    'TRACKLY_PLUGIN_UI_RESOURCE_META',
    `Object.freeze({
      ui: {
        prefersBorder: true,
        domain: UI_DOMAIN,
        csp: {
          connectDomains: [],
          resourceDomains: [],
        },
      },
      'openai/widgetDescription': 'A private trackly Apply status card. Preparation stops before Submit.',
      'openai/widgetPrefersBorder': true,
      'openai/widgetDomain': UI_DOMAIN,
      'openai/widgetCSP': {
        connect_domains: [],
        resource_domains: [],
      },
    })`,
    sourcePath,
  );
  assertActiveFunctionDefinitionAst(
    source,
    'tracklyPluginToolUiMeta',
    `function tracklyPluginToolUiMeta(
      view: TracklyPluginUiView,
      invoking: string,
      invoked: string,
      extra: Record<string, unknown> = {},
    ) {
      const resourceUri = TRACKLY_PLUGIN_UI[view];
      return {
        ui: {
          resourceUri,
          visibility: ['model', 'app'],
        },
        'openai/outputTemplate': resourceUri,
        'openai/widgetAccessible': true,
        'openai/toolInvocation/invoking': invoking,
        'openai/toolInvocation/invoked': invoked,
        ...extra,
      };
    }`,
    sourcePath,
  );
  assertActiveFunctionAstSha256(source, 'tracklyPluginUiHtml', htmlAstSha256, sourcePath);
}

function assertPluginManualSubmissionRouteSemantics(source, sourcePath, expectedStatement) {
  assertActiveTopLevelStatementAst(source, expectedStatement, sourcePath);
}

function assertExactHostedSourceSha256(source, expectedSha256, sourcePath) {
  assert.equal(
    sha256ExactBytes(source),
    expectedSha256,
    `${sourcePath} must preserve its exact reviewed source bytes`,
  );
}

function assertPluginReviewReadyPersistenceSemantics(
  routeSource,
  serviceSource,
  routeSourcePath,
  serviceSourcePath,
  expectedRouteStatement,
  {
    routeAstSha256 = 'a4b0a5ba28a0c80c2ddbc438b3cde25f61a7bb092ead4efe1813384f9e7d46ec',
    certifyAstSha256 = '6c0c19a3c05794b0fa8e1ed7917fa9de4322e32ecef1006869e026394cb90ffd',
    serviceSourceSha256 = null,
  } = {},
) {
  assertImportedFunctionCallInventory(
    routeSource,
    'certifyPluginReviewReady',
    '../services/application-profile/service',
    1,
    routeSourcePath,
  );
  if (expectedRouteStatement !== undefined) {
    assertActiveTopLevelStatementAst(routeSource, expectedRouteStatement, routeSourcePath);
  } else {
    const routeStatements = parseFullSource(routeSource, routeSourcePath).program.body.filter((statement) => (
      statement.type === 'ExpressionStatement'
      && statement.expression?.type === 'CallExpression'
      && babelCalleeName(statement.expression.callee) === 'router.post'
      && statement.expression.arguments[0]?.type === 'StringLiteral'
      && statement.expression.arguments[0].value === '/jobscout/apply/runs/:id/plugin-review-ready'
    ));
    assert.equal(
      routeStatements.length,
      1,
      `${routeSourcePath} must define exactly one active plugin review-ready route`,
    );
    assert.equal(
      sha256ExactBytes(JSON.stringify(canonicalSchemaAst(routeStatements[0]))),
      routeAstSha256,
      `plugin review-ready route in ${routeSourcePath} must preserve its locked active semantic AST`,
    );
  }
  assertActiveFunctionAstSha256(
    serviceSource,
    'certifyPluginReviewReady',
    certifyAstSha256,
    serviceSourcePath,
  );
  if (serviceSourceSha256 !== null) {
    assertExactHostedSourceSha256(serviceSource, serviceSourceSha256, serviceSourcePath);
  }
}

function assertInternalSecretCompatibility(
  mcpTokenSource,
  jwtSource,
  mcpTokenSourcePath,
  jwtSourcePath,
  { verifyTokenAstSha256 = '92ba92722519a3112f5c52bfa5cd779c3a396e2ae00ee7c3bf81933057991086' } = {},
) {
  const sharedSecretExpression = "jwtSecretFromEnv || sessionSecretFromEnv || (isProduction ? '' : 'local-dev-jwt-secret')";
  for (const [source, sourcePath] of [
    [mcpTokenSource, mcpTokenSourcePath],
    [jwtSource, jwtSourcePath],
  ]) {
    assertActiveVariableInitializerAst(
      source,
      'isProduction',
      "process.env.NODE_ENV === 'production'",
      sourcePath,
    );
    assertActiveVariableInitializerAst(
      source,
      'jwtSecretFromEnv',
      "(process.env.JWT_SECRET || '').trim()",
      sourcePath,
    );
    assertActiveVariableInitializerAst(
      source,
      'sessionSecretFromEnv',
      "(process.env.SESSION_SECRET || '').trim()",
      sourcePath,
    );
  }
  assertActiveVariableInitializerAst(mcpTokenSource, 'BASE_SECRET', sharedSecretExpression, mcpTokenSourcePath);
  assertActiveVariableInitializerAst(mcpTokenSource, 'INTERNAL_SECRET', 'BASE_SECRET', mcpTokenSourcePath);
  assertActiveVariableInitializerAst(jwtSource, 'JWT_SECRET', sharedSecretExpression, jwtSourcePath);
  assertActiveTopLevelStatementAst(
    mcpTokenSource,
    `if (!BASE_SECRET) {
      throw new Error('[MCP Tokens] Missing JWT_SECRET or SESSION_SECRET in production.');
    }`,
    mcpTokenSourcePath,
  );
  assertActiveTopLevelStatementAst(
    jwtSource,
    `if (!JWT_SECRET) {
      throw new Error('[JWT] Missing JWT_SECRET or SESSION_SECRET in production.');
    }`,
    jwtSourcePath,
  );
  assertActiveFunctionAstSha256(jwtSource, 'verifyToken', verifyTokenAstSha256, jwtSourcePath);
}

function assertActiveClassMethodDefinitionAst(
  source,
  className,
  methodName,
  expectedMethodSource,
  sourcePath,
) {
  const program = parseFullSource(source, sourcePath).program;
  const classes = program.body.flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    return declaration?.type === 'ClassDeclaration' && declaration.id?.name === className
      ? [declaration]
      : [];
  });
  assert.equal(classes.length, 1, `${sourcePath} must define exactly one top-level ${className} class`);
  const methods = classes[0].body.body.filter((member) => (
    member.type === 'ClassMethod'
    && !member.computed
    && member.key?.type === 'Identifier'
    && member.key.name === methodName
  ));
  assert.equal(methods.length, 1, `${className} in ${sourcePath} must define exactly one ${methodName} method`);
  const fixture = parseFullSource(
    `class ExpectedMethod { ${expectedMethodSource} }`,
    `${className}.${methodName} expected contract`,
  ).program.body[0].body.body[0];
  assert.deepEqual(
    canonicalSchemaAst(methods[0]),
    canonicalSchemaAst(fixture),
    `${className}.${methodName} in ${sourcePath} must preserve its locked executable semantics`,
  );
}

function staticApplicationFieldSensitivityMap(source, sourcePath) {
  const array = unwrapTransparentExpression(
    activeVariableDeclarator(source, 'APPLICATION_PROFILE_FIELD_DEFINITIONS', sourcePath).declarator.init,
  );
  assert.equal(array?.type, 'ArrayExpression', `${sourcePath} application field catalog must be a static array`);
  const entries = array.elements.map((element, index) => {
    const properties = staticBabelObjectProperties(element, `${sourcePath} application field ${index}`);
    assert.equal(properties.key?.type, 'StringLiteral', `${sourcePath} application field ${index} needs a static key`);
    assert.equal(
      properties.sensitivity?.type,
      'StringLiteral',
      `${sourcePath} application field ${properties.key.value} needs a static sensitivity`,
    );
    assert.ok(
      ['standard', 'sensitive', 'restricted'].includes(properties.sensitivity.value),
      `${sourcePath} application field ${properties.key.value} has an unsupported sensitivity`,
    );
    return [properties.key.value, properties.sensitivity.value];
  });
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, `${sourcePath} field keys must be unique`);
  return Object.fromEntries(entries);
}

function assertActiveFunctionDirectStatementAst(
  source,
  name,
  expectedStatement,
  sourcePath,
  { mustPrecedeSoleFinalReturn = false } = {},
) {
  const definition = activeNamedDefinitionAst(source, name, sourcePath);
  const body = definition.body;
  assert.equal(body?.type, 'BlockStatement', `${name} in ${sourcePath} must use a block body`);
  const fixture = parseFullSource(
    `function expectedActiveStatement() { ${expectedStatement} }`,
    `${name} expected statement`,
  ).program.body[0];
  assert.equal(fixture.type, 'FunctionDeclaration');
  assert.equal(fixture.body.body.length, 1);
  const expectedAst = canonicalSchemaAst(fixture.body.body[0]);
  const matches = body.body.filter((statement) => (
    JSON.stringify(canonicalSchemaAst(statement)) === JSON.stringify(expectedAst)
  ));
  assert.equal(
    matches.length,
    1,
    `${name} in ${sourcePath} must execute its locked direct statement exactly once`,
  );
  if (mustPrecedeSoleFinalReturn) {
    const statementIndex = body.body.indexOf(matches[0]);
    const returns = [];
    function visitReturns(node) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visitReturns(child);
        return;
      }
      if (node !== definition
        && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)) return;
      if (node.type === 'ReturnStatement') returns.push(node);
      for (const [key, child] of Object.entries(node)) {
        if (key === 'loc' || key === 'extra') continue;
        visitReturns(child);
      }
    }
    visitReturns(definition);
    assert.equal(
      returns.length,
      1,
      `${name} in ${sourcePath} must have exactly one reachable return after its locked direct statement`,
    );
    assert.equal(
      body.body.at(-1),
      returns[0],
      `${name} in ${sourcePath} must end with its sole return after its locked direct statement`,
    );
    assert.ok(
      statementIndex >= 0 && statementIndex < body.body.length - 1,
      `${name} in ${sourcePath} must execute its locked direct statement before the sole final return`,
    );
    assert.ok(
      body.body.slice(0, statementIndex + 1).every((statement) => (
        statement.type === 'VariableDeclaration' || statement.type === 'ExpressionStatement'
      )),
      `${name} in ${sourcePath} must reach its locked direct statement without an earlier branch, return, or throw`,
    );
  }
}

function assertActiveVariableInitializerAst(source, name, expectedExpression, sourcePath) {
  assert.deepEqual(
    canonicalSchemaAst(activeVariableDeclarator(source, name, sourcePath).declarator.init),
    canonicalSchemaAst(babelParser.parseExpression(expectedExpression, { plugins: ['typescript'] })),
    `${name} in ${sourcePath} must preserve its locked executable definition`,
  );
}

function assertActiveTopLevelStatementAst(source, expectedStatement, sourcePath) {
  const program = parseFullSource(source, sourcePath).program;
  const fixture = parseFullSource(expectedStatement, `${sourcePath} expected top-level statement`).program.body;
  assert.equal(fixture.length, 1, `${sourcePath} expected top-level contract must contain one statement`);
  const expectedAst = JSON.stringify(canonicalSchemaAst(fixture[0]));
  const matches = program.body.filter((statement) => (
    JSON.stringify(canonicalSchemaAst(statement)) === expectedAst
  ));
  assert.equal(
    matches.length,
    1,
    `${sourcePath} must execute its locked fail-closed top-level statement exactly once`,
  );
}

function assertImportBinding(source, importedName, localName, moduleName, sourcePath) {
  const matches = parseFullSource(source, sourcePath).program.body.flatMap((statement) => (
    statement.type === 'ImportDeclaration' && statement.source.value === moduleName
      ? statement.specifiers.filter((specifier) => {
        if (importedName === 'default') {
          return specifier.type === 'ImportDefaultSpecifier' && specifier.local?.name === localName;
        }
        return specifier.type === 'ImportSpecifier'
          && specifier.imported?.name === importedName
          && specifier.local?.name === localName;
      })
      : []
  ));
  assert.equal(
    matches.length,
    1,
    `${sourcePath} must import ${importedName} as ${localName} exactly once from ${moduleName}`,
  );
  return matches[0];
}

function assertImportedFunctionCallInventory(source, name, moduleName, expectedCallSites, sourcePath) {
  const ast = parseFullSource(source, sourcePath);
  const importedBinding = assertImportBinding(source, name, name, moduleName, sourcePath);
  const calledBindings = [];
  const callSites = [];
  function visit(node, ancestors = []) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, ancestors);
      return;
    }
    if (node.type === 'CallExpression') {
      const callee = unwrapTransparentExpression(node.callee);
      if (callee?.type === 'Identifier' && callee.name === name) {
        calledBindings.push(callee);
        if (Array.isArray(expectedCallSites)) {
          const [spread, optionsObject, rateLimitCall, declaration] = ancestors.slice(-4).reverse();
          const binding = spread?.type === 'SpreadElement'
            && spread.argument === node
            && optionsObject?.type === 'ObjectExpression'
            && rateLimitCall?.type === 'CallExpression'
            && rateLimitCall.arguments.includes(optionsObject)
            && babelCalleeName(rateLimitCall.callee) === 'rateLimit'
            && declaration?.type === 'VariableDeclarator'
            && declaration.init === rateLimitCall
            && declaration.id?.type === 'Identifier'
            ? declaration.id.name
            : null;
          callSites.push(binding);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child, [...ancestors, node]);
    }
  }
  visit(ast);
  if (Array.isArray(expectedCallSites)) {
    assert.deepEqual(
      callSites,
      expectedCallSites,
      `${sourcePath} must spread imported ${name} into the exact reviewed rate-limit initializers`,
    );
  } else {
    assert.equal(
      calledBindings.length,
      expectedCallSites,
      `${sourcePath} must call imported ${name} exactly ${expectedCallSites} times`,
    );
  }
  const references = collectBindingReferences(
    ast,
    name,
    (_node, parent, parentKey) => parent?.type === 'ImportSpecifier' && parentKey === 'imported',
  );
  assert.deepEqual(
    references,
    [importedBinding.local, ...calledBindings],
    `${name} in ${sourcePath} must not be shadowed, reassigned, aliased, escaped, or referenced outside its locked calls`,
  );
}

function assertDescriptorUsesTopLevelBinding(
  source,
  registration,
  propertyName,
  expectedBinding,
  sourcePath,
) {
  const descriptorProperties = staticBabelObjectProperties(
    registration.call.arguments[1],
    `${registration.name} descriptor`,
  );
  assertBabelPropertyExpression(
    descriptorProperties,
    propertyName,
    expectedBinding,
    `${registration.name} descriptor`,
  );
  activeNamedDefinitionAst(source, expectedBinding, sourcePath);
  const factories = parseFullSource(source, sourcePath).program.body.filter((statement) => (
    statement.type === 'ExportNamedDeclaration'
    && statement.declaration?.type === 'FunctionDeclaration'
    && statement.declaration.id?.name === 'createTracklyPluginMcpServer'
  ));
  assert.equal(factories.length, 1, `${sourcePath} must export exactly one createTracklyPluginMcpServer factory`);
  const shadowBindings = factories[0].declaration.body.body.flatMap((statement) => (
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter((declarator) => (
        declarator.id?.type === 'Identifier' && declarator.id.name === expectedBinding
      ))
      : []
  ));
  assert.equal(
    shadowBindings.length,
    0,
    `${registration.name}.${propertyName} in ${sourcePath} must resolve to the active top-level ${expectedBinding} definition without a factory-local shadow`,
  );
}

function wrappedHandlerFunction(registration, sourcePath) {
  assert.equal(
    registration.call.arguments.length,
    3,
    `${registration.name} registration in ${sourcePath} must provide exactly name, descriptor, and handler arguments`,
  );
  const wrapper = registration.call.arguments[2];
  assert.equal(wrapper?.type, 'CallExpression', `${registration.name} handler in ${sourcePath} must use a wrapper call`);
  assert.equal(
    wrapper.callee?.type === 'Identifier' ? wrapper.callee.name : null,
    'wrapTool',
    `${registration.name} handler in ${sourcePath} must use the canonical wrapTool binding`,
  );
  assert.ok(
    wrapper.arguments.length === 2 || wrapper.arguments.length === 3,
    `${registration.name} wrapTool call in ${sourcePath} must provide exactly a handler, fallback message, and optional structured-content flag`,
  );
  const handler = wrapper.arguments[0];
  assert.ok(
    handler?.type === 'ArrowFunctionExpression' || handler?.type === 'FunctionExpression',
    `${registration.name} wrapper in ${sourcePath} must receive a function handler`,
  );
  assert.equal(
    wrapper.arguments[1]?.type,
    'StringLiteral',
    `${registration.name} wrapTool call in ${sourcePath} must provide a static fallback message after its sole function handler`,
  );
  if (wrapper.arguments.length === 3) {
    assert.ok(
      wrapper.arguments[2]?.type === 'BooleanLiteral' && wrapper.arguments[2].value === true,
      `${registration.name} wrapTool call in ${sourcePath} may enable structured content only with literal true`,
    );
  }
  return handler;
}

function wrappedHandlerReturnProperties(registration, sourcePath) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  assert.equal(handler.body?.type, 'BlockStatement', `${registration.name} handler in ${sourcePath} must use a block body`);
  const returns = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      node !== handler
      && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
    ) return;
    if (node.type === 'ReturnStatement') returns.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(handler);
  assert.equal(returns.length, 1, `${registration.name} handler in ${sourcePath} must have exactly one reachable projection return`);
  assert.equal(
    handler.body.body.at(-1),
    returns[0],
    `${registration.name} handler in ${sourcePath} must end with its sole bounded projection return`,
  );
  return staticBabelObjectProperties(returns[0].argument, `${registration.name} output projection`);
}

function wrappedHandlerReturnedObjectProperties(registration, sourcePath) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  if (handler.body?.type === 'ObjectExpression') {
    return staticBabelObjectProperties(handler.body, `${registration.name} output projection`);
  }
  return wrappedHandlerReturnProperties(registration, sourcePath);
}

function functionSoleReturnObjectProperties(source, functionName, sourcePath) {
  const definition = activeNamedDefinitionAst(source, functionName, sourcePath);
  assert.equal(definition.body?.type, 'BlockStatement', `${functionName} in ${sourcePath} must use a block body`);
  const returns = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      node !== definition
      && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
    ) return;
    if (node.type === 'ReturnStatement') returns.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(definition);
  assert.equal(returns.length, 1, `${functionName} in ${sourcePath} must have exactly one reachable projection return`);
  assert.equal(
    definition.body.body.at(-1),
    returns[0],
    `${functionName} in ${sourcePath} must end with its sole bounded projection return`,
  );
  return staticBabelObjectProperties(returns[0].argument, `${functionName} output projection`);
}

function assertWrappedHandlerDirectStatementAst(registration, expectedStatement, sourcePath) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  assert.equal(handler.body?.type, 'BlockStatement', `${registration.name} handler in ${sourcePath} must use a block body`);
  const fixture = parseFullSource(
    `function expectedHandlerStatement() { ${expectedStatement} }`,
    `${registration.name} expected handler statement`,
  ).program.body[0];
  assert.equal(fixture.type, 'FunctionDeclaration');
  assert.equal(fixture.body.body.length, 1);
  const expectedAst = canonicalSchemaAst(fixture.body.body[0]);
  const matches = handler.body.body.filter((statement) => (
    JSON.stringify(canonicalSchemaAst(statement)) === JSON.stringify(expectedAst)
  ));
  assert.equal(
    matches.length,
    1,
    `${registration.name} handler in ${sourcePath} must execute its locked direct statement exactly once`,
  );
}

function assertWrappedHandlerGuardedReturnAst(
  registration,
  guardExpression,
  expectedReturn,
  sourcePath,
) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  assert.equal(handler.body?.type, 'BlockStatement', `${registration.name} handler in ${sourcePath} must use a block body`);
  const expectedGuard = canonicalSchemaAst(
    babelParser.parseExpression(guardExpression, { plugins: ['typescript'] }),
  );
  const guardedBlocks = handler.body.body.filter((statement) => (
    statement.type === 'IfStatement'
    && JSON.stringify(canonicalSchemaAst(statement.test)) === JSON.stringify(expectedGuard)
    && statement.consequent?.type === 'BlockStatement'
    && statement.alternate === null
  ));
  assert.equal(
    guardedBlocks.length,
    1,
    `${registration.name} handler in ${sourcePath} must execute exactly one direct ${guardExpression} branch`,
  );
  const fixture = parseFullSource(
    `function expectedGuardedReturn() { ${expectedReturn} }`,
    `${registration.name} expected guarded return`,
  ).program.body[0];
  assert.equal(fixture.type, 'FunctionDeclaration');
  assert.equal(fixture.body.body.length, 1);
  const actualReturn = guardedBlocks[0].consequent.body.at(-1);
  assert.deepEqual(
    canonicalSchemaAst(actualReturn),
    canonicalSchemaAst(fixture.body.body[0]),
    `${registration.name} handler in ${sourcePath} must return its locked bounded projection from ${guardExpression}`,
  );
}

function assertWrappedHandlerGuardedBlockAst(
  registration,
  guardExpression,
  expectedBlock,
  sourcePath,
) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  assert.equal(handler.body?.type, 'BlockStatement', `${registration.name} handler in ${sourcePath} must use a block body`);
  const expectedGuard = canonicalSchemaAst(
    babelParser.parseExpression(guardExpression, { plugins: ['typescript'] }),
  );
  const guardedBlocks = handler.body.body.filter((statement) => (
    statement.type === 'IfStatement'
    && JSON.stringify(canonicalSchemaAst(statement.test)) === JSON.stringify(expectedGuard)
    && statement.consequent?.type === 'BlockStatement'
    && statement.alternate === null
  ));
  assert.equal(
    guardedBlocks.length,
    1,
    `${registration.name} handler in ${sourcePath} must execute exactly one direct ${guardExpression} branch`,
  );
  const expected = babelParser.parseExpression(`async () => ${expectedBlock}`, { plugins: ['typescript'] });
  assert.equal(expected.body?.type, 'BlockStatement');
  assert.deepEqual(
    canonicalSchemaAst(guardedBlocks[0].consequent),
    canonicalSchemaAst(expected.body),
    `${registration.name} handler in ${sourcePath} must preserve the complete locked ${guardExpression} branch`,
  );
}

function assertWrappedHandlerStatementSequenceAst(
  registration,
  expectedStatements,
  sourcePath,
) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  const fixture = parseFullSource(
    `async function expectedSequence() { ${expectedStatements} }`,
    `${registration.name} expected statement sequence`,
  ).program.body[0].body.body;
  const matches = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      node !== handler
      && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
    ) return;
    if (node.type === 'BlockStatement') {
      for (let index = 0; index <= node.body.length - fixture.length; index += 1) {
        const candidate = node.body.slice(index, index + fixture.length);
        if (JSON.stringify(canonicalSchemaAst(candidate)) === JSON.stringify(canonicalSchemaAst(fixture))) {
          matches.push(candidate);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(handler);
  assert.equal(
    matches.length,
    1,
    `${registration.name} handler in ${sourcePath} must execute its locked data-flow statement sequence exactly once`,
  );
}

function assertWrappedHandlerAst(registration, expectedHandler, sourcePath) {
  assert.deepEqual(
    canonicalSchemaAst(wrappedHandlerFunction(registration, sourcePath)),
    canonicalSchemaAst(babelParser.parseExpression(expectedHandler, { plugins: ['typescript'] })),
    `${registration.name} handler in ${sourcePath} must preserve its complete locked executable semantics`,
  );
}

function directCallsInWrappedHandler(registration, expectedCallee, sourcePath) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  const calls = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      node !== handler
      && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
    ) return;
    if (node.type === 'CallExpression' && babelCalleeName(node.callee) === expectedCallee) calls.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(handler);
  return calls;
}

function assertWrappedHandlerParsesWithSchema(registration, schemaName, sourcePath) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  assert.equal(handler.params.length, 1, `${registration.name} handler in ${sourcePath} must receive exactly params`);
  assert.equal(handler.params[0]?.type, 'Identifier', `${registration.name} handler in ${sourcePath} must receive params by identifier`);
  const parameterName = handler.params[0].name;
  const parseCalls = directCallsInWrappedHandler(registration, `${schemaName}.parse`, sourcePath);
  assert.equal(
    parseCalls.length,
    1,
    `${registration.name} handler in ${sourcePath} must execute exactly one ${schemaName}.parse(params) call`,
  );
  assert.equal(parseCalls[0].arguments.length, 1);
  assert.equal(parseCalls[0].arguments[0]?.type, 'Identifier');
  assert.equal(parseCalls[0].arguments[0].name, parameterName);
  if (handler.body.type === 'BlockStatement') {
    const firstStatement = handler.body.body[0];
    assert.equal(
      firstStatement?.type,
      'VariableDeclaration',
      `${registration.name} handler in ${sourcePath} must parse params in its first unconditional statement before forwarding or returning`,
    );
    assert.equal(firstStatement.declarations.length, 1);
    assert.equal(
      firstStatement.declarations[0].init,
      parseCalls[0],
      `${registration.name} handler in ${sourcePath} must directly initialize its first binding from ${schemaName}.parse(params)`,
    );
    return;
  }
  const forwardedCall = handler.body.type === 'AwaitExpression' ? handler.body.argument : handler.body;
  assert.equal(
    forwardedCall?.type,
    'CallExpression',
    `${registration.name} handler in ${sourcePath} must directly forward the parsed params from its expression body`,
  );
  assert.ok(
    forwardedCall.arguments.includes(parseCalls[0]),
    `${registration.name} handler in ${sourcePath} must evaluate ${schemaName}.parse(params) as a direct forwarding argument before the request call`,
  );
}

function assertWrappedHandlerRequestEndpoint(registration, method, pathExpression, sourcePath) {
  const handler = wrappedHandlerFunction(registration, sourcePath);
  const returnedExpression = handler.body?.type === 'BlockStatement'
    ? (() => {
      assert.equal(
        handler.body.body.length,
        1,
        `${registration.name} handler in ${sourcePath} must directly return its sole requestApi call`,
      );
      assert.equal(handler.body.body[0]?.type, 'ReturnStatement');
      return handler.body.body[0].argument;
    })()
    : handler.body;
  const requestCall = returnedExpression?.type === 'AwaitExpression'
    ? returnedExpression.argument
    : returnedExpression;
  assert.equal(
    requestCall?.type,
    'CallExpression',
    `${registration.name} handler in ${sourcePath} must directly return its requestApi call`,
  );
  assert.equal(
    babelCalleeName(requestCall.callee),
    'requestApi',
    `${registration.name} handler in ${sourcePath} must directly return its requestApi call`,
  );
  const [methodArgument, pathArgument] = requestCall.arguments;
  assert.equal(methodArgument?.type, 'StringLiteral');
  assert.equal(methodArgument.value, method);
  assert.deepEqual(
    canonicalSchemaAst(pathArgument),
    canonicalSchemaAst(babelParser.parseExpression(pathExpression, { plugins: ['typescript'] })),
    `${registration.name} handler in ${sourcePath} must target ${pathExpression}`,
  );
}

function assertWrappedHandlerAssignedRequestEndpoint(
  registration,
  bindingName,
  method,
  pathExpression,
  sourcePath,
  options = {},
) {
  const {
    afterBindingName = null,
    calleeName = 'requestApi',
    guardExpression = null,
    requireReachableForAllInputs = false,
  } = options;
  const handler = wrappedHandlerFunction(registration, sourcePath);
  const matches = [];
  function visit(node, parentBlock = null, activeGuard = null) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parentBlock, activeGuard);
      return;
    }
    if (
      node !== handler
      && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
    ) return;
    const block = node.type === 'BlockStatement' ? node : parentBlock;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === bindingName) {
      matches.push({ declarator: node, block, guard: activeGuard });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      const childGuard = node.type === 'IfStatement' && (key === 'consequent' || key === 'alternate')
        ? node.test
        : activeGuard;
      visit(child, block, childGuard);
    }
  }
  visit(handler);
  const expectedGuard = guardExpression === null
    ? null
    : canonicalSchemaAst(babelParser.parseExpression(guardExpression, { plugins: ['typescript'] }));
  const guardedMatches = matches.filter(({ guard }) => (
    guardExpression === null
      ? guard === null
      : JSON.stringify(canonicalSchemaAst(guard)) === JSON.stringify(expectedGuard)
  ));
  assert.equal(
    guardedMatches.length,
    1,
    `${registration.name} handler in ${sourcePath} must bind its live ${bindingName} request exactly once`,
  );
  const [{ declarator, block, guard }] = guardedMatches;
  if (guardExpression !== null) {
    assert.deepEqual(
      canonicalSchemaAst(guard),
      expectedGuard,
      `${registration.name} live ${bindingName} request in ${sourcePath} must execute under ${guardExpression}`,
    );
  }
  assert.equal(declarator.init?.type, 'AwaitExpression');
  const requestCall = declarator.init.argument;
  assert.equal(requestCall?.type, 'CallExpression');
  assert.equal(babelCalleeName(requestCall.callee), calleeName);
  const [methodArgument, pathArgument] = requestCall.arguments;
  assert.equal(methodArgument?.type, 'StringLiteral');
  assert.equal(methodArgument.value, method);
  assert.deepEqual(
    canonicalSchemaAst(pathArgument),
    canonicalSchemaAst(babelParser.parseExpression(pathExpression, { plugins: ['typescript'] })),
    `${registration.name} live ${bindingName} request in ${sourcePath} must target ${pathExpression}`,
  );
  assert.equal(block?.type, 'BlockStatement');
  const declarationStatementIndex = block.body.findIndex((statement) => (
    statement.type === 'VariableDeclaration' && statement.declarations.includes(declarator)
  ));
  assert.ok(declarationStatementIndex >= 0);
  if (requireReachableForAllInputs) {
    assert.equal(
      declarationStatementIndex,
      0,
      `${registration.name} live ${bindingName} request in ${sourcePath} must be reachable for every accepted input without an earlier branch, return, or throw`,
    );
  }
  if (afterBindingName !== null) {
    const prerequisiteIndex = block.body.findIndex((statement) => (
      statement.type === 'VariableDeclaration'
      && statement.declarations.some((candidate) => (
        candidate.id?.type === 'Identifier' && candidate.id.name === afterBindingName
      ))
    ));
    assert.ok(
      prerequisiteIndex >= 0 && prerequisiteIndex < declarationStatementIndex,
      `${registration.name} live ${bindingName} request in ${sourcePath} must occur after ${afterBindingName}`,
    );
  }
  const laterSource = block.body.slice(declarationStatementIndex + 1);
  let referenced = false;
  function findReference(node) {
    if (node === null || typeof node !== 'object' || referenced) return;
    if (Array.isArray(node)) {
      for (const child of node) findReference(child);
      return;
    }
    if (node.type === 'Identifier' && node.name === bindingName) referenced = true;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      findReference(child);
    }
  }
  findReference(laterSource);
  assert.ok(referenced, `${registration.name} handler in ${sourcePath} must consume its live ${bindingName} response`);
}

function contractDeclarationStatements(source, sourcePath) {
  const programBody = parseFullSource(source, sourcePath).program.body;
  const factoryBodies = programBody.flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null;
    if (
      declaration?.type !== 'FunctionDeclaration'
      || declaration.id?.name !== 'createTracklyMcpServer'
    ) return [];
    return declaration.body.body;
  });
  return [...programBody, ...factoryBodies];
}

function activeVariableDeclarator(source, name, sourcePath) {
  const matches = contractDeclarationStatements(source, sourcePath).flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration') return [];
    return declaration.declarations
      .filter((declarator) => declarator.id?.type === 'Identifier' && declarator.id.name === name)
      .map((declarator) => ({ declarator, declaration }));
  });
  assert.equal(matches.length, 1, `${name} must have exactly one active top-level variable declaration in ${sourcePath}`);
  const [{ declarator, declaration }] = matches;
  assert.equal(
    declaration?.type,
    'VariableDeclaration',
    `${name} in ${sourcePath} must belong to a variable declaration`,
  );
  assert.equal(
    declaration.kind,
    'const',
    `${name} in ${sourcePath} must use an immutable const declaration`,
  );
  assert.ok(declarator.init, `${name} in ${sourcePath} must have an initializer`);
  const writes = [];
  function targetContainsName(node) {
    if (node === null || typeof node !== 'object') return false;
    if (node.type === 'Identifier') return node.name === name;
    if (node.type === 'RestElement') return targetContainsName(node.argument);
    if (node.type === 'AssignmentPattern') return targetContainsName(node.left);
    if (node.type === 'ArrayPattern') return node.elements.some(targetContainsName);
    if (node.type === 'ObjectPattern') return node.properties.some((property) => (
      property.type === 'RestElement'
        ? targetContainsName(property.argument)
        : targetContainsName(property.value)
    ));
    return false;
  }
  function visitWrites(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitWrites(child);
      return;
    }
    if (node.type === 'AssignmentExpression' && targetContainsName(node.left)) writes.push(node);
    if (node.type === 'UpdateExpression' && targetContainsName(node.argument)) writes.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitWrites(child);
    }
  }
  visitWrites(parseFullSource(source, sourcePath));
  assert.equal(writes.length, 0, `${name} in ${sourcePath} must never be assigned or updated after declaration`);
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

function schemaObjectPropertyAsts(source, name, sourcePath) {
  const schemaAst = parseSchemaExpression(source, name, sourcePath);
  return namedProperties(objectSchemaProperties(schemaAst, name), name);
}

function parseExpectedExpression(expression, label) {
  const ast = acorn.parseExpressionAt(expression, 0, { ecmaVersion: 'latest' });
  assert.equal(ast.end, expression.length, `${label} must contain one complete expression`);
  return ast;
}

function assertSchemaPropertyExpression(properties, property, expression, label) {
  assert.ok(properties[property], `${label} is missing ${property}`);
  assert.deepEqual(
    canonicalSchemaAst(properties[property]),
    canonicalSchemaAst(parseExpectedExpression(expression, `${label}.${property}`)),
    `${label}.${property} must equal ${expression}`,
  );
}

function assertExactSchemaProperties(properties, contract, label) {
  assert.deepEqual(
    Object.keys(properties),
    Object.keys(contract),
    `${label} must publish only its locked fields`,
  );
  for (const [field, expression] of Object.entries(contract)) {
    assertSchemaPropertyExpression(properties, field, expression, label);
  }
}

function exactSchemaDefinition(source, name, sourcePath) {
  const bounds = schemaDefinitionBounds(source, name, sourcePath);
  return source.slice(bounds.declarationStart, bounds.declarationEnd);
}

const AST_METADATA_FIELDS = new Set([
  'start',
  'end',
  'loc',
  'range',
  'raw',
  'extra',
  'comments',
  'errors',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

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

function referencedFreeIdentifiers(ast) {
  const identifiers = new Set();
  const scopes = [new Set()];

  function addPatternBindings(pattern, scope) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      scope.add(pattern.name);
      return;
    }
    if (pattern.type === 'RestElement') {
      addPatternBindings(pattern.argument, scope);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      addPatternBindings(pattern.left, scope);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) addPatternBindings(element, scope);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        addPatternBindings(property.type === 'RestElement' ? property.argument : property.value, scope);
      }
    }
  }

  function isBound(name) {
    return scopes.some((scope) => scope.has(name));
  }

  function visit(node, parent = null, parentKey = '') {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, parentKey);
      return;
    }

    const isFunction = ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type);
    if (isFunction) {
      const functionScope = new Set();
      if (node.id?.type === 'Identifier') functionScope.add(node.id.name);
      for (const parameter of node.params || []) addPatternBindings(parameter, functionScope);
      scopes.unshift(functionScope);
      visit(node.body, node, 'body');
      scopes.shift();
      return;
    }

    if (node.type === 'Identifier') {
      const isStaticMemberProperty = parent?.type === 'MemberExpression'
        && parentKey === 'property'
        && !parent.computed;
      const isStaticPropertyKey = parent?.type === 'Property'
        && parentKey === 'key'
        && !parent.computed
        && !parent.shorthand;
      const isBinding = (
        (parent?.type === 'VariableDeclarator' && parentKey === 'id')
        || (parent?.type === 'CatchClause' && parentKey === 'param')
      );
      if (!isStaticMemberProperty && !isStaticPropertyKey && !isBinding && !isBound(node.name)) {
        identifiers.add(node.name);
      }
      return;
    }

    if (node.type === 'VariableDeclarator') addPatternBindings(node.id, scopes[0]);
    if (node.type === 'CatchClause') {
      const catchScope = new Set();
      addPatternBindings(node.param, catchScope);
      scopes.unshift(catchScope);
      visit(node.body, node, 'body');
      scopes.shift();
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (AST_METADATA_FIELDS.has(key)) continue;
      visit(child, node, key);
    }
  }
  visit(ast);
  return [...identifiers].sort();
}

function classifyFreeIdentifiers(identifiers, categories, label) {
  const classifications = {};
  for (const [category, names] of Object.entries(categories)) {
    for (const name of names) {
      assert.equal(
        classifications[name],
        undefined,
        `${label} dependency ${name} is assigned to more than one classification`,
      );
      classifications[name] = category;
    }
  }
  for (const name of identifiers) {
    assert.ok(
      classifications[name],
      `${label} dependency ${name} is unclassified; explicitly lock it as a runtime global, shared definition, or contract constant`,
    );
  }
  return Object.fromEntries(identifiers.map((name) => [name, classifications[name]]));
}

function activeNamedDefinitionAst(source, name, sourcePath) {
  const matches = contractDeclarationStatements(source, sourcePath).flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === name) return [declaration];
    if (declaration?.type !== 'VariableDeclaration') return [];
    return declaration.declarations.flatMap((declarator) => {
      if (declarator.id?.type !== 'Identifier' || declarator.id.name !== name) return [];
      assert.ok(declarator.init, `${name} in ${sourcePath} must have an initializer`);
      return [declarator.init];
    });
  });
  assert.equal(
    matches.length,
    1,
    `${name} must have exactly one active top-level variable or function definition in ${sourcePath}`,
  );
  const writes = [];
  function targetContainsName(node) {
    if (node === null || typeof node !== 'object') return false;
    if (node.type === 'Identifier') return node.name === name;
    if (node.type === 'RestElement') return targetContainsName(node.argument);
    if (node.type === 'AssignmentPattern') return targetContainsName(node.left);
    if (node.type === 'ArrayPattern') return node.elements.some(targetContainsName);
    if (node.type === 'ObjectPattern') return node.properties.some((property) => (
      property.type === 'RestElement'
        ? targetContainsName(property.argument)
        : targetContainsName(property.value)
    ));
    return false;
  }
  function visitWrites(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visitWrites(child);
      return;
    }
    if (node.type === 'AssignmentExpression' && targetContainsName(node.left)) writes.push(node);
    if (node.type === 'UpdateExpression' && targetContainsName(node.argument)) writes.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visitWrites(child);
    }
  }
  visitWrites(parseFullSource(source, sourcePath));
  assert.equal(
    writes.length,
    0,
    `${name} in ${sourcePath} must never be assigned or updated after its locked definition`,
  );
  return matches[0];
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
  while (node?.type === 'CallExpression' && memberName(node.callee) === 'strict') {
    assert.equal(node.arguments.length, 0, `${label} .strict() must not take arguments`);
    node = node.callee.object;
  }
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
  const hostedMember = memberName(hostedSchema.callee);
  const hostedPublishedObject = hostedMember === 'superRefine'
    ? hostedSchema.callee.object
    : hostedSchema;
  if (hostedMember === 'superRefine') {
    assert.equal(hostedSchema.arguments.length, 1, 'hosted startApplyRunSchema must have one refinement callback');
  } else {
    assert.equal(hostedMember, 'object', 'hosted startApplyRunSchema must be a z.object or a refined z.object');
  }
  assert.deepEqual(
    canonicalSchemaAst(localWrapper),
    canonicalSchemaAst(hostedPublishedObject),
    'startApplyRunInputSchema must equal the hosted published object before any parse-time refinement',
  );
}

function verifyCoordinatedBackendCore({
  localContract,
  hostedContract,
  localApplySource,
  hostedApplySource,
  hostedPluginContract,
  pluginLock,
  hostedPluginSource,
  sourcePaths = {},
}) {
  const localApplyPath = sourcePaths.localApply || 'local Apply source';
  const hostedApplyPath = sourcePaths.hostedApply || 'hosted Apply source';
  const hostedPluginPath = sourcePaths.hostedPlugin || 'hosted plugin source';
  assert.equal(
    localContract.tools.trackly_record_apply_execution_dispositions,
    hostedContract.tools.trackly_record_apply_execution_dispositions,
    'trackly_record_apply_execution_dispositions schema alias drifted',
  );
  assert.match(
    localContract.tools.trackly_record_apply_execution_dispositions,
    /applyExecutionDispositionSchema/,
    'Disposition tool must reference the named executable schema',
  );
  assert.deepEqual(
    canonicalSchemaAst(parseSchemaExpression(
      localApplySource,
      'applyExecutionDispositionSchema',
      localApplyPath,
    )),
    canonicalSchemaAst(parseSchemaExpression(
      hostedApplySource,
      'applyExecutionDispositionSchema',
      hostedApplyPath,
    )),
    'applyExecutionDispositionSchema executable AST drifted between local and hosted MCP',
  );
  assertActiveFunctionDefinitionAst(
    hostedPluginSource,
    'wrapTool',
    `function wrapTool(
      handler: (params: any) => Promise<unknown>,
      fallback: string,
      includeStructuredContent = false,
    ) {
      return async (params: any) => {
        try {
          return resultContent(await handler(params), includeStructuredContent);
        } catch (error) {
          return errorContent(error, fallback);
        }
      };
    }`,
    hostedPluginPath,
  );
  assert.deepEqual(
    hostedPluginContract.lifecycle,
    pluginLock.publicLifecycleContract,
    'Executable hosted plugin lifecycle drifted from the packaged public lifecycle contract',
  );
  assertStartRunWrapperCompatibility(
    parseSchemaExpression(localApplySource, 'startApplyRunInputSchema', localApplyPath),
    parseSchemaExpression(hostedApplySource, 'startApplyRunSchema', hostedApplyPath),
  );
}

function verifyCheckedInHostedContractFixture(
  cliRoot,
  { expectedFixtureSha256 = CHECKED_IN_HOSTED_FIXTURE_SHA256 } = {},
) {
  const fixturePath = path.join(cliRoot, 'plugins', 'trackly', 'hosted-contract-fixture.json');
  const fixtureSource = fs.readFileSync(fixturePath, 'utf8');
  assert.equal(
    sha256ExactBytes(fixtureSource),
    expectedFixtureSha256,
    `${fixturePath} bytes drifted from the independently reviewed hosted snapshot`,
  );
  const fixture = JSON.parse(fixtureSource);
  assert.deepEqual(
    Object.keys(fixture),
    [
      'formatVersion',
      'capturedAt',
      'sourceRuntime',
      'mergedRuntime',
      'applyContractVersion',
      'pluginContractVersion',
      'publicTools',
      'hostedMcpToolNames',
      'sourceSha256',
    ],
    `${fixturePath} must use the exact standalone fixture shape`,
  );
  assert.equal(fixture.formatVersion, 2);
  const commitPattern = /^[a-f0-9]{40}$/;
  assert.match(fixture.sourceRuntime.commit, commitPattern);
  assert.match(fixture.sourceRuntime.parent, commitPattern);
  assert.match(fixture.mergedRuntime.commit, commitPattern);
  assert.deepEqual(
    fixture.mergedRuntime.parents.filter((commit) => commit === fixture.sourceRuntime.commit),
    [fixture.sourceRuntime.commit],
    `${fixturePath} must prove the reviewed runtime commit is a direct parent of its recorded merge`,
  );
  for (const commit of fixture.mergedRuntime.parents) assert.match(commit, commitPattern);
  const timestamps = {
    sourceCommittedAt: Date.parse(fixture.sourceRuntime.committedAt),
    mergedCommittedAt: Date.parse(fixture.mergedRuntime.committedAt),
    capturedAt: Date.parse(fixture.capturedAt),
  };
  for (const [label, timestamp] of Object.entries(timestamps)) {
    assert.ok(Number.isFinite(timestamp), `${fixturePath} ${label} must be an absolute timestamp`);
  }
  assert.ok(
    timestamps.sourceCommittedAt <= timestamps.mergedCommittedAt,
    `${fixturePath} merge must not predate its reviewed runtime parent`,
  );
  assert.ok(
    timestamps.mergedCommittedAt <= timestamps.capturedAt,
    `${fixturePath} snapshot must not predate its recorded runtime merge`,
  );
  assert.ok(
    timestamps.capturedAt - timestamps.mergedCommittedAt <= 24 * 60 * 60 * 1000,
    `${fixturePath} snapshot must be captured within 24 hours of its recorded runtime merge`,
  );
  const localApplyContract = JSON.parse(fs.readFileSync(
    path.join(cliRoot, 'contracts', 'trackly-apply-tools.json'),
    'utf8',
  ));
  assert.equal(
    fixture.applyContractVersion,
    localApplyContract.contractVersion,
    `${fixturePath} must identify the checked-in local Apply contract version`,
  );
  assert.equal(fixture.pluginContractVersion, '1.0.0');
  const lock = JSON.parse(fs.readFileSync(path.join(path.dirname(fixturePath), 'skill-lock.json'), 'utf8'));
  const snapshotNames = fixture.publicTools.map(([name]) => name);
  assert.deepEqual(snapshotNames, lock.publicToolAllowlist, `${fixturePath} public tool-name snapshot drifted`);
  assert.equal(new Set(snapshotNames).size, snapshotNames.length, `${fixturePath} public tool names must be unique`);
  assert.deepEqual(Object.keys(lock.publicScopeContract).sort(), [...lock.publicToolAllowlist].sort());
  assert.deepEqual(
    Object.keys(lock.publicExecutableContract.descriptorSha256).sort(),
    [...lock.publicToolAllowlist].sort(),
  );
  assert.deepEqual(
    Object.keys(lock.publicExecutableContract.handlerSha256).sort(),
    [...lock.publicToolAllowlist].sort(),
  );
  for (const [name, schemaSha256, handlerSha256] of fixture.publicTools) {
    assert.match(schemaSha256, /^[a-f0-9]{64}$/);
    assert.match(handlerSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      schemaSha256,
      lock.publicExecutableContract.descriptorSha256[name],
      `${fixturePath} ${name} schema snapshot drifted from the packaged executable lock`,
    );
    assert.equal(
      handlerSha256,
      lock.publicExecutableContract.handlerSha256[name],
      `${fixturePath} ${name} handler snapshot drifted from the packaged executable lock`,
    );
  }
  assert.deepEqual(
    fixture.hostedMcpToolNames,
    lock.hostedMcpToolAllowlist,
    `${fixturePath} hosted MCP tool-name snapshot drifted`,
  );
  assert.equal(new Set(fixture.hostedMcpToolNames).size, fixture.hostedMcpToolNames.length);
  assert.deepEqual(fixture.sourceSha256, {
    pluginServer: lock.publicExecutableContract.pluginServerSha256,
    pluginScopes: lock.publicExecutableContract.pluginScopesSha256,
    jobBriefService: lock.publicExecutableContract.jobBriefServiceSha256,
    backendUiRedirect: lock.publicExecutableContract.backendUiRedirectSha256,
    maintenanceMode: lock.publicExecutableContract.maintenanceModeSha256,
    databaseBinding: lock.publicExecutableContract.databaseBindingSha256,
    reviewIdentity: lock.publicExecutableContract.reviewIdentitySha256,
    azureRateLimitOptions: lock.publicExecutableContract.azureRateLimitOptionsSha256,
    applicationProfileService: lock.publicExecutableContract.applicationProfileServiceSha256,
  }, `${fixturePath} hosted source snapshot drifted from the packaged executable lock`);
  for (const digest of [
    lock.publicExecutableContract.pluginServerSha256,
    lock.publicExecutableContract.pluginScopesSha256,
    lock.publicExecutableContract.jobBriefServiceSha256,
    lock.publicExecutableContract.backendUiRedirectSha256,
    lock.publicExecutableContract.maintenanceModeSha256,
    lock.publicExecutableContract.databaseBindingSha256,
    lock.publicExecutableContract.reviewIdentitySha256,
    lock.publicExecutableContract.azureRateLimitOptionsSha256,
    lock.publicExecutableContract.applicationProfileServiceSha256,
    ...Object.values(lock.publicExecutableContract.descriptorSha256),
    ...Object.values(lock.publicExecutableContract.handlerSha256),
  ]) assert.match(digest, /^[a-f0-9]{64}$/);
  console.log(
    `Checked-in hosted contract fixture passes for Apply ${fixture.applyContractVersion}; the ${snapshotNames.length}-tool public facade and ${fixture.hostedMcpToolNames.length}-tool hosted MCP catalogs are locked.`,
  );
}

function verifyHostedContract({
  cliRoot = path.join(__dirname, '..'),
  backendDir = process.env.TRACKLY_BACKEND_DIR,
  fixtureOptions,
  coordinatedFixture,
} = {}) {
if (coordinatedFixture) {
  verifyCoordinatedBackendCore(coordinatedFixture);
  return;
}
if (!backendDir) {
  verifyCheckedInHostedContractFixture(cliRoot, fixtureOptions);
  return;
}
const backendCandidates = backendDir
  ? [path.resolve(backendDir)]
  : [
      path.resolve(cliRoot, '..', 'backend'),
      path.resolve(cliRoot, '..', 'granola-followup-app'),
      path.join(require('node:os').homedir(), 'closeai', 'granola-followup-app'),
    ];
const localContractPath = path.join(cliRoot, 'contracts', 'trackly-apply-tools.json');
const localApplySourcePath = path.join(cliRoot, 'mcp', 'apply-tools.js');
const localServerSourcePath = path.join(cliRoot, 'mcp', 'server.js');
const backendRoot = backendCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'contracts', 'trackly-apply-tools.json')))
  || backendCandidates[0];
const hostedContractPath = path.join(backendRoot, 'contracts', 'trackly-apply-tools.json');
const hostedApplySourcePath = path.join(backendRoot, 'src', 'mcp', 'server.ts');
const hostedPluginContractPath = path.join(backendRoot, 'contracts', 'trackly-plugin-tools.json');
const hostedPluginSourcePath = path.join(backendRoot, 'src', 'mcp', 'plugin-server.ts');
const hostedPluginRouterPath = path.join(backendRoot, 'src', 'mcp', 'plugin-router.ts');
const hostedPluginScopesPath = path.join(backendRoot, 'src', 'mcp', 'plugin-scopes.ts');
const hostedMcpScopesPath = path.join(backendRoot, 'src', 'mcp', 'mcp-scopes.ts');
const hostedApplicationPath = path.join(backendRoot, 'src', 'index.ts');
const hostedOAuthProviderPath = path.join(backendRoot, 'src', 'mcp', 'oauth-provider.ts');
const hostedMcpTokensPath = path.join(backendRoot, 'src', 'mcp', 'mcp-tokens.ts');
const hostedAuthContextPath = path.join(backendRoot, 'src', 'mcp', 'hosted-auth-context.ts');
const hostedPluginUiPath = path.join(backendRoot, 'src', 'mcp', 'plugin-ui.ts');
const hostedAuthEpochPath = path.join(backendRoot, 'src', 'utils', 'auth-epoch.ts');
const hostedAzureRehearsalIpPath = path.join(backendRoot, 'src', 'utils', 'azure-rehearsal-ip.ts');
const hostedJwtPath = path.join(backendRoot, 'src', 'utils', 'jwt.ts');
const hostedJobBriefServicePath = path.join(backendRoot, 'src', 'services', 'job-brief.ts');
const hostedReviewIdentityPath = path.join(backendRoot, 'src', 'services', 'review-identity.ts');
const hostedTracklyAccessPath = path.join(backendRoot, 'src', 'services', 'trackly-access.ts');
const hostedApplyExecutionContractPath = path.join(backendRoot, 'src', 'services', 'application-profile', 'apply-execution-contract.ts');
const hostedApplicationProfileCatalogPath = path.join(backendRoot, 'src', 'services', 'application-profile', 'catalog.ts');
const hostedApplicationProfileServicePath = path.join(backendRoot, 'src', 'services', 'application-profile', 'service.ts');
const hostedJobscoutFilterUtilsPath = path.join(backendRoot, 'src', 'routes', 'jobscout-filter-utils.ts');
const hostedTracklyApplyPath = path.join(backendRoot, 'src', 'routes', 'trackly-apply.ts');
const pluginLockPath = path.join(cliRoot, 'plugins', 'trackly', 'skill-lock.json');

if (!fs.existsSync(hostedContractPath)) {
  throw new Error(`Hosted contract not found at ${hostedContractPath}. Set TRACKLY_BACKEND_DIR to the close-ai checkout.`);
}
if (!fs.existsSync(hostedPluginContractPath)) {
  throw new Error(`Hosted plugin contract not found at ${hostedPluginContractPath}. Set TRACKLY_BACKEND_DIR to a plugin-capable close-ai checkout.`);
}

const local = JSON.parse(fs.readFileSync(localContractPath, 'utf8'));
const localApplySource = fs.readFileSync(localApplySourcePath, 'utf8');
const localServerSource = fs.readFileSync(localServerSourcePath, 'utf8');
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
const hostedPluginRouterSource = fs.readFileSync(hostedPluginRouterPath, 'utf8');
const hostedPluginScopesSource = fs.readFileSync(hostedPluginScopesPath, 'utf8');
const hostedMcpScopesSource = fs.readFileSync(hostedMcpScopesPath, 'utf8');
const hostedApplicationSource = fs.readFileSync(hostedApplicationPath, 'utf8');
const hostedOAuthProviderSource = fs.readFileSync(hostedOAuthProviderPath, 'utf8');
const hostedMcpTokensSource = fs.readFileSync(hostedMcpTokensPath, 'utf8');
const hostedAuthContextSource = fs.readFileSync(hostedAuthContextPath, 'utf8');
const hostedPluginUiSource = fs.readFileSync(hostedPluginUiPath, 'utf8');
const hostedAuthEpochSource = fs.readFileSync(hostedAuthEpochPath, 'utf8');
const hostedAzureRehearsalIpSource = fs.readFileSync(hostedAzureRehearsalIpPath, 'utf8');
const hostedJwtSource = fs.readFileSync(hostedJwtPath, 'utf8');
const hostedJobBriefServiceSource = fs.readFileSync(hostedJobBriefServicePath, 'utf8');
const hostedReviewIdentitySource = fs.readFileSync(hostedReviewIdentityPath, 'utf8');
const hostedTracklyAccessSource = fs.readFileSync(hostedTracklyAccessPath, 'utf8');
const hostedApplyExecutionContractSource = fs.readFileSync(hostedApplyExecutionContractPath, 'utf8');
const hostedApplicationProfileCatalogSource = fs.readFileSync(hostedApplicationProfileCatalogPath, 'utf8');
const hostedApplicationProfileServiceSource = fs.readFileSync(hostedApplicationProfileServicePath, 'utf8');
const hostedJobscoutFilterUtilsSource = fs.readFileSync(hostedJobscoutFilterUtilsPath, 'utf8');
const hostedTracklyApplySource = fs.readFileSync(hostedTracklyApplyPath, 'utf8');

verifyHostedSnapshotGitProvenance(cliRoot, backendRoot);
assertLivePluginRouterMount(
  hostedApplicationSource,
  'tracklyPluginMcpRoutes',
  './mcp/plugin-router',
  '/api/plugin/trackly/mcp',
  hostedApplicationPath,
);
assertServerListenSemantics(hostedApplicationSource, hostedApplicationPath);
assertInstallProcessGuardsSemantics(hostedApplicationSource, hostedApplicationPath);
assertExactHostedSourceSha256(
  hostedAzureRehearsalIpSource,
  pluginLock.publicExecutableContract.azureRateLimitOptionsSha256,
  hostedAzureRehearsalIpPath,
);
assertCommonJsDestructuredRequire(
  localServerSource,
  'registerApplyTools',
  './apply-tools',
  localServerSourcePath,
);
assertActiveFunctionDirectStatementAst(
  localServerSource,
  'createServer',
  `registerApplyTools(server, {
    wrapTool,
    mcpUserAgent: MCP_USER_AGENT,
    throwMcpResourceError,
  });`,
  localServerSourcePath,
  { mustPrecedeSoleFinalReturn: true },
);

verifyCoordinatedBackendCore({
  localContract: local,
  hostedContract: hosted,
  localApplySource,
  hostedApplySource,
  hostedPluginContract,
  pluginLock,
  hostedPluginSource,
  sourcePaths: {
    localApply: localApplySourcePath,
    hostedApply: hostedApplySourcePath,
    hostedPlugin: hostedPluginSourcePath,
  },
});

const LOCAL_ONLY_TOOLS = [
  'trackly_lint_application_text',
  'trackly_diagnose_local_path',
];
const HOSTED_ONLY_TOOLS = [
  'trackly_chat',
  'get_more_tools',
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
assertExportedFactoryUsedByPluginRouter(
  hostedPluginRouterSource,
  'createTracklyPluginMcpServer',
  hostedPluginRouterPath,
);
assertActiveFunctionDefinitionAst(
  hostedTracklyAccessSource,
  'requireTracklyAccess',
  `async function requireTracklyAccess(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    await requireTracklyAccessForSurface(req, res, next);
  }`,
  hostedTracklyAccessPath,
);
assertActiveFunctionDefinitionAst(
  hostedTracklyAccessSource,
  'requireTracklyAccessForSurface',
  `async function requireTracklyAccessForSurface(
    req: Request,
    res: Response,
    next: NextFunction,
    requiredSurface?: 'native',
  ): Promise<void> {
    const mode = getTracklyAccessMode();
    const lifecycleExemptPaths = new Set(['/me', '/account', '/voice/history']);
    if (mode === 'off' || req.path === '/jobscout/me' || lifecycleExemptPaths.has(req.path)) {
      next();
      return;
    }

    const passportSessionAlreadyAudited = mode === 'audit'
      && requiredSurface !== 'native'
      && req.isAuthenticated?.() === true
      && Boolean((req.session as { passport?: { user?: unknown } } | undefined)?.passport?.user);
    if (passportSessionAlreadyAudited && webAccessDecisionCompleted(req.user)) {
      next();
      return;
    }

    const userId = Number(
      (req.user as { id?: number } | undefined)?.id
      ?? (req as Request & { auth?: { extra?: { userId?: number } } }).auth?.extra?.userId,
    );
    if (!Number.isInteger(userId) || userId <= 0) {
      if (mode === 'audit') {
        logger.warn('trackly-access', 'identity unavailable during audit', { path: req.path });
        next();
        return;
      }
      res.status(401).json({
        success: false,
        code: 'AUTHENTICATION_REQUIRED',
        error: 'Authentication is required.',
      });
      return;
    }

    try {
      const access = await getTracklyEntitlements(userId);
      if (!access.schemaReady) {
        if (mode === 'audit') {
          logger.warn('trackly-access', 'schema unavailable during audit', { userId, path: req.path });
          next();
          return;
        }
        res.status(503).json({
          success: false,
          code: 'ACCESS_CHECK_UNAVAILABLE',
          error: 'Trackly access could not be verified. Please try again.',
        });
        return;
      }
      const authenticatedRequest = req as Request & { apiKeyId?: number; apiKeyUserId?: number };
      const authenticatedUser = req.user as { client_platform?: string } | undefined;
      const apiKeyId = Number(authenticatedRequest.apiKeyId);
      const apiKeyUserId = Number(authenticatedRequest.apiKeyUserId);
      const isApiKeyRequest = (Number.isInteger(apiKeyId) && apiKeyId > 0)
        || (Number.isInteger(apiKeyUserId) && apiKeyUserId > 0);
      const isWebSurface = requiredSurface !== 'native' && !isApiKeyRequest && (
        req.isAuthenticated?.() === true
        || authenticatedUser?.client_platform === 'web'
      );
      const accessEnabled = isWebSurface
        ? access.webAccessEnabled
        : access.tracklyAccessEnabled;
      if (accessEnabled) {
        next();
        return;
      }
      if (mode === 'audit') {
        logger.warn('trackly-access', 'would deny Trackly request', { userId, path: req.path });
        next();
        return;
      }
      res.status(403).json({
        success: false,
        code: isWebSurface ? 'WEB_ACCESS_REQUIRED' : 'INVITATION_REQUIRED',
        error: isWebSurface
          ? 'Trackly Web is currently available to existing members.'
          : 'Trackly is currently available through a limited invitation rollout.',
        accessUrl: isWebSurface
          ? 'https://usetrackly.app/early-access?reason=web-access'
          : 'https://usetrackly.app/early-access',
      });
    } catch (error) {
      logger.error('trackly-access', 'access lookup failed', new Error('database lookup failed'), {
        userId,
        path: req.path,
      });
      if (mode === 'audit') {
        next();
        return;
      }
      res.status(503).json({
        success: false,
        code: 'ACCESS_CHECK_UNAVAILABLE',
        error: 'Trackly access could not be verified. Please try again.',
      });
    }
  }`,
  hostedTracklyAccessPath,
);
assertImportBinding(hostedTracklyAccessSource, 'pool', 'pool', '../config/database.js', hostedTracklyAccessPath);
assertActiveFunctionDefinitionAst(
  hostedTracklyAccessSource,
  'isUndefinedSchemaError',
  `function isUndefinedSchemaError(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    return code === '42703' || code === '42P01';
  }`,
  hostedTracklyAccessPath,
);
assertActiveFunctionDefinitionAst(
  hostedTracklyAccessSource,
  'getTracklyAccessMode',
  `function getTracklyAccessMode(): TracklyAccessMode {
    const configured = process.env.TRACKLY_ACCESS_MODE?.trim().toLowerCase();
    return configured === 'audit' || configured === 'enforce' ? configured : 'off';
  }`,
  hostedTracklyAccessPath,
);
assertActiveVariableInitializerAst(
  hostedTracklyAccessSource,
  'WEB_ACCESS_DECISION_COMPLETED',
  "Symbol('trackly.webAccessDecisionCompleted')",
  hostedTracklyAccessPath,
);
assertActiveFunctionDefinitionAst(
  hostedTracklyAccessSource,
  'webAccessDecisionCompleted',
  `function webAccessDecisionCompleted(user: unknown): boolean {
    return typeof user === 'object'
      && user !== null
      && (user as { [WEB_ACCESS_DECISION_COMPLETED]?: boolean })[WEB_ACCESS_DECISION_COMPLETED] === true;
  }`,
  hostedTracklyAccessPath,
);
assertActiveFunctionDefinitionAst(
  hostedTracklyAccessSource,
  'getTracklyEntitlements',
  `async function getTracklyEntitlements(
    userId: number,
    database: Queryable = pool,
  ): Promise<TracklyEntitlements> {
    try {
      const result = await database.query<{
        trackly_access_enabled: boolean;
        web_access_enabled: boolean;
      }>(
        \`SELECT trackly_access_enabled, web_access_enabled
         FROM users
        WHERE id = $1\`,
        [userId],
      );
      if (!result || !Array.isArray(result.rows)) {
        return { schemaReady: false, tracklyAccessEnabled: null, webAccessEnabled: null };
      }
      const row = result.rows[0];
      if (!row) {
        return { schemaReady: true, tracklyAccessEnabled: false, webAccessEnabled: false };
      }
      return {
        schemaReady: true,
        tracklyAccessEnabled: row.trackly_access_enabled === true,
        webAccessEnabled: row.web_access_enabled === true,
      };
    } catch (error) {
      if (isUndefinedSchemaError(error)) {
        return { schemaReady: false, tracklyAccessEnabled: null, webAccessEnabled: null };
      }
      throw error;
    }
  }`,
  hostedTracklyAccessPath,
);
assertImportBinding(hostedMcpTokensSource, 'default', 'jwt', 'jsonwebtoken', hostedMcpTokensPath);
assertImportBinding(
  hostedMcpTokensSource,
  'verifiedHostedMcpOAuthContext',
  'verifiedHostedMcpOAuthContext',
  './hosted-auth-context.js',
  hostedMcpTokensPath,
);
assertImportBinding(
  hostedAuthContextSource,
  'normalizeMcpScopes',
  'normalizeMcpScopes',
  './mcp-scopes.js',
  hostedAuthContextPath,
);
assertImportBinding(
  hostedMcpTokensSource,
  'normalizeAuthEpoch',
  'normalizeAuthEpoch',
  '../utils/auth-epoch.js',
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'isProduction',
  "process.env.NODE_ENV === 'production'",
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'jwtSecretFromEnv',
  "(process.env.JWT_SECRET || '').trim()",
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'sessionSecretFromEnv',
  "(process.env.SESSION_SECRET || '').trim()",
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'BASE_SECRET',
  "jwtSecretFromEnv || sessionSecretFromEnv || (isProduction ? '' : 'local-dev-jwt-secret')",
  hostedMcpTokensPath,
);
assertActiveTopLevelStatementAst(
  hostedMcpTokensSource,
  `if (!BASE_SECRET) {
    throw new Error('[MCP Tokens] Missing JWT_SECRET or SESSION_SECRET in production.');
  }`,
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(hostedMcpTokensSource, 'MCP_JWT_SECRET', "BASE_SECRET + '-mcp'", hostedMcpTokensPath);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'MCP_ISSUER',
  "process.env.MCP_ISSUER_URL || 'https://mcp.usetrackly.app'",
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'MCP_LEGACY_RESOURCE',
  '`${MCP_ISSUER}/api/mcp`',
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'MCP_PLUGIN_RESOURCE',
  '`${MCP_ISSUER}/api/plugin/trackly/mcp`',
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(
  hostedMcpTokensSource,
  'MCP_ALLOWED_RESOURCES',
  `Object.freeze([
    MCP_LEGACY_RESOURCE,
    MCP_PLUGIN_RESOURCE,
  ] as [string, string])`,
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(hostedMcpTokensSource, 'MCP_ACCESS_IDENTITY_VERSION', '1 as const', hostedMcpTokensPath);
assertActiveFunctionDefinitionAst(
  hostedMcpTokensSource,
  'normalizeMcpResource',
  `function normalizeMcpResource(resource?: string): string {
    const candidate = resource || MCP_LEGACY_RESOURCE;
    if (!MCP_ALLOWED_RESOURCES.includes(candidate)) {
      throw new Error('Unsupported MCP resource');
    }
    return candidate;
  }`,
  hostedMcpTokensPath,
);
assertActiveVariableInitializerAst(hostedAuthEpochSource, 'MAX_AUTH_EPOCH', '2_147_483_647', hostedAuthEpochPath);
assertActiveFunctionDefinitionAst(
  hostedAuthEpochSource,
  'normalizeAuthEpoch',
  `function normalizeAuthEpoch(
    value: unknown,
    missingValue?: number,
  ): number | null {
    if (value === undefined || value === null) {
      return missingValue === undefined ? null : missingValue;
    }
    return Number.isSafeInteger(value)
      && Number(value) >= 0
      && Number(value) <= MAX_AUTH_EPOCH
      ? Number(value)
      : null;
  }`,
  hostedAuthEpochPath,
);
assertActiveFunctionDefinitionAst(
  hostedMcpTokensSource,
  'generateInternalToken',
  `function generateInternalToken(
    user: McpTokenUser,
    hostedMcpOAuth?: VerifiedHostedMcpOAuthContext,
  ): string {
    return jwt.sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name || '',
        authEpoch: authEpochForMcpToken(user),
        ...(hostedMcpOAuth
          ? {
            hostedMcpOAuth: verifiedHostedMcpOAuthContext({
              clientId: hostedMcpOAuth.clientId,
              grantId: hostedMcpOAuth.grantId,
              scopes: hostedMcpOAuth.scopes,
            }),
          }
          : {}),
      },
      INTERNAL_SECRET,
      { expiresIn: '5m' },
    );
  }`,
  hostedMcpTokensPath,
);
assertInternalSecretCompatibility(
  hostedMcpTokensSource,
  hostedJwtSource,
  hostedMcpTokensPath,
  hostedJwtPath,
);
assertActiveVariableInitializerAst(
  hostedAuthContextSource,
  'HOSTED_MCP_AUTH_CONTEXT_VERSION',
  '1 as const',
  hostedAuthContextPath,
);
assertActiveVariableInitializerAst(
  hostedAuthContextSource,
  'OAUTH_CLIENT_ID',
  '/^[^\\u0000-\\u001f\\u007f]{1,512}$/',
  hostedAuthContextPath,
);
assertActiveVariableInitializerAst(
  hostedAuthContextSource,
  'OAUTH_GRANT_ID',
  '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
  hostedAuthContextPath,
);
assertActiveFunctionDefinitionAst(
  hostedAuthContextSource,
  'verifiedHostedMcpOAuthContext',
  `function verifiedHostedMcpOAuthContext(input: {
    clientId: unknown;
    grantId: unknown;
    scopes: unknown;
  }): VerifiedHostedMcpOAuthContext {
    if (typeof input.clientId !== 'string' || !OAUTH_CLIENT_ID.test(input.clientId)) {
      throw new Error('Invalid hosted MCP OAuth client identifier');
    }
    if (typeof input.grantId !== 'string' || !OAUTH_GRANT_ID.test(input.grantId)) {
      throw new Error('Invalid hosted MCP OAuth grant identifier');
    }
    if (!Array.isArray(input.scopes) || input.scopes.some((scope) => typeof scope !== 'string')) {
      throw new Error('Invalid hosted MCP OAuth scopes');
    }
    return {
      kind: 'hosted_mcp_oauth',
      version: HOSTED_MCP_AUTH_CONTEXT_VERSION,
      clientId: input.clientId,
      grantId: input.grantId,
      scopes: normalizeMcpScopes(input.scopes),
    };
  }`,
  hostedAuthContextPath,
);
assertActiveFunctionDefinitionAst(
  hostedMcpTokensSource,
  'verifyMcpAccessToken',
  `function verifyMcpAccessToken(
    token: string,
    expectedResource?: string,
  ): McpTokenPayload | null {
    try {
      const decoded = jwt.verify(token, MCP_JWT_SECRET, {
        audience: expectedResource
          ? normalizeMcpResource(expectedResource)
          : [...MCP_ALLOWED_RESOURCES],
      }) as unknown as McpTokenPayload;
      if (decoded.type !== 'mcp_access') return null;
      if (decoded.identityClassVersion !== MCP_ACCESS_IDENTITY_VERSION) return null;
      if (decoded.identityClass !== 'ordinary' && decoded.identityClass !== 'review') return null;
      if (typeof decoded.grant_id !== 'string' || decoded.grant_id.length === 0) return null;
      const resource = normalizeMcpResource(
        decoded.resource || (decoded.aud === MCP_LEGACY_RESOURCE ? MCP_LEGACY_RESOURCE : undefined),
      );
      if (decoded.aud !== resource) return null;
      const scopes = normalizeMcpScopes(decoded.scopes);
      const authEpoch = normalizeAuthEpoch(decoded.authEpoch, 0);
      return authEpoch === null ? null : { ...decoded, authEpoch, scopes, resource };
    } catch {
      return null;
    }
  }`,
  hostedMcpTokensPath,
);
assertActiveFunctionDefinitionAst(
  hostedReviewIdentitySource,
  'isConfiguredReviewUserId',
  `function isConfiguredReviewUserId(value: unknown): boolean {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) return false;
    return [1, 2, 3].some((slot) => configuredReviewUserId(slot) === Number(value));
  }`,
  hostedReviewIdentityPath,
);
for (const [importedName, localName, moduleName] of [
  ['verifyMcpAccessToken', 'verifyMcpAccessToken', './mcp-tokens.js'],
  ['normalizeMcpResource', 'normalizeMcpResource', './mcp-tokens.js'],
  ['normalizeAuthEpoch', 'normalizeAuthEpoch', '../utils/auth-epoch.js'],
  ['isConfiguredReviewUserId', 'isConfiguredReviewUserId', '../services/review-identity.js'],
  ['getTracklyAccessMode', 'getTracklyAccessMode', '../services/trackly-access.js'],
  ['getTracklyEntitlements', 'getTracklyEntitlements', '../services/trackly-access.js'],
  ['normalizeMcpScopes', 'normalizeMcpScopes', './mcp-scopes.js'],
  ['isScopeSubset', 'isScopeSubset', './mcp-scopes.js'],
]) {
  assertImportBinding(hostedOAuthProviderSource, importedName, localName, moduleName, hostedOAuthProviderPath);
}
assertImportBinding(hostedOAuthProviderSource, 'pool', 'pool', '../config/database.js', hostedOAuthProviderPath);
assertActiveFunctionDefinitionAst(
  hostedOAuthProviderSource,
  'requireMcpEntitlement',
  `async function requireMcpEntitlement(
    userId: number,
    database: NonNullable<Parameters<typeof getTracklyEntitlements>[1]> = pool,
  ): Promise<void> {
    const mode = getTracklyAccessMode();
    if (mode === 'off') return;
    let entitlement;
    try {
      entitlement = await getTracklyEntitlements(userId, database);
    } catch (error) {
      if (mode === 'audit') {
        logger.warn('trackly-access', 'MCP entitlement lookup failed during audit', { userId });
        return;
      }
      throw error;
    }
    if (entitlement.schemaReady && entitlement.tracklyAccessEnabled) return;
    if (mode === 'audit') {
      logger.warn('trackly-access', 'would deny MCP credential operation', { userId });
      return;
    }
    throw new InvalidGrantError('Trackly access requires an invitation. Visit https://usetrackly.app/early-access');
  }`,
  hostedOAuthProviderPath,
);
assertActiveVariableInitializerAst(
  hostedOAuthProviderSource,
  'tracklyOAuthProvider',
  'new TracklyOAuthProvider()',
  hostedOAuthProviderPath,
);
assertActiveClassMethodDefinitionAst(
  hostedOAuthProviderSource,
  'TracklyOAuthProvider',
  'verifyAccessToken',
  `async verifyAccessToken(token: string): Promise<AuthInfo> {
    const decoded = verifyMcpAccessToken(token);

    if (!decoded) {
      throw new InvalidTokenError('Invalid or expired MCP access token');
    }

    if (decoded.identityClass === 'review' || isConfiguredReviewUserId(decoded.userId)) {
      throw new InvalidTokenError('Invalid or expired MCP access token');
    }

    let grant: McpGrantRow;
    try {
      const result = await pool.query<McpGrantRow>(
        \`SELECT oauth_grant.grant_id, oauth_grant.user_id, oauth_grant.client_id,
                oauth_grant.consented_scopes, oauth_grant.resource, users.auth_epoch
         FROM mcp_oauth_grants AS oauth_grant
         JOIN users ON users.id = oauth_grant.user_id
         WHERE oauth_grant.grant_id = $1
           AND oauth_grant.revoked_at IS NULL
           AND oauth_grant.expires_at > NOW()\`,
        [decoded.grant_id],
      );
      if (result.rows.length !== 1) {
        throw new InvalidTokenError('Invalid or expired MCP access token');
      }
      grant = result.rows[0];
      const authoritativeScopes = normalizeMcpScopes(grant.consented_scopes);
      const currentAuthEpoch = normalizeAuthEpoch(grant.auth_epoch, 0);
      if (
        grant.user_id !== decoded.userId
        || grant.client_id !== decoded.client_id
        || normalizeMcpResource(grant.resource) !== decoded.resource
        || currentAuthEpoch === null
        || currentAuthEpoch !== decoded.authEpoch
        || !isScopeSubset(decoded.scopes, authoritativeScopes)
      ) {
        throw new InvalidTokenError('Invalid or expired MCP access token');
      }
      await requireMcpEntitlement(decoded.userId);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw error;
      throw new InvalidTokenError('Invalid or expired MCP access token');
    }

    return {
      token,
      clientId: decoded.client_id,
      scopes: decoded.scopes,
      expiresAt: decoded.exp!,
      extra: {
        userId: decoded.userId,
        email: decoded.email,
        name: decoded.name,
        authEpoch: decoded.authEpoch,
        grantId: decoded.grant_id,
        resource: decoded.resource,
      },
    };
  }`,
  hostedOAuthProviderPath,
);
assertImportBinding(
  hostedPluginSource,
  'default',
  'https',
  'node:https',
  hostedPluginSourcePath,
);
assertPluginUiContractSemantics(hostedPluginUiSource, hostedPluginUiPath);
for (const importedName of [
  'TRACKLY_PLUGIN_UI',
  'TRACKLY_PLUGIN_UI_MIME_TYPE',
  'TRACKLY_PLUGIN_UI_RESOURCE_META',
  'tracklyPluginToolUiMeta',
  'tracklyPluginUiHtml',
]) {
  assertImportBinding(hostedPluginSource, importedName, importedName, './plugin-ui.js', hostedPluginSourcePath);
}
assertActiveVariableInitializerAst(
  hostedPluginSource,
  'BASE_URL',
  "process.env.BASE_URL || 'https://closeai.mba'",
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'wrapTool',
  `function wrapTool(
    handler: (params: any) => Promise<unknown>,
    fallback: string,
    includeStructuredContent = false,
  ) {
    return async (params: any) => {
      try {
        return resultContent(await handler(params), includeStructuredContent);
      } catch (error) {
        return errorContent(error, fallback);
      }
    };
  }`,
  hostedPluginSourcePath,
);
assertActiveVariableInitializerAst(
  hostedPluginSource,
  'MAX_API_RESPONSE_BYTES',
  '10 * 1024 * 1024',
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'apiRequest',
  `function apiRequest(
    method: string,
    path: string,
    authToken: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    timeoutMs = 60_000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value: any) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const url = new URL(path, BASE_URL);
      const bodyString = body === undefined ? null : JSON.stringify(body);
      const request = https.request({
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: \`\${url.pathname}\${url.search}\`,
        headers: {
          Authorization: \`Bearer \${authToken}\`,
          'User-Agent': \`trackly-plugin-mcp/\${PLUGIN_VERSION}\`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(bodyString ? { 'Content-Length': String(Buffer.byteLength(bodyString)) } : {}),
          ...extraHeaders,
        },
      }, (response) => {
        response.setEncoding('utf8');
        let data = '';
        let responseBytes = 0;
        response.on('error', rejectOnce);
        response.on('aborted', () => {
          if (settled) return;
          rejectOnce(Object.assign(
            new Error('trackly response was aborted'),
            { code: 'TRACKLY_RESPONSE_ABORTED' },
          ));
        });
        response.on('data', (chunk) => {
          if (settled) return;
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > MAX_API_RESPONSE_BYTES) {
            const error = Object.assign(
              new Error('trackly response exceeded 10 MiB limit'),
              { code: 'TRACKLY_RESPONSE_TOO_LARGE' },
            );
            request.destroy(error);
            rejectOnce(error);
            return;
          }
          data += chunk;
        });
        response.on('end', () => {
          if (settled) return;
          const statusCode = response.statusCode || 500;
          let parsed: any;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            if (statusCode >= 200 && statusCode < 300) {
              rejectOnce(new Error('trackly returned an invalid response'));
              return;
            }
            parsed = {};
          }
          if (statusCode < 200 || statusCode >= 300) {
            const error = new Error(
              typeof parsed?.error === 'string' ? parsed.error : \`trackly request failed (\${statusCode})\`,
            ) as Error & { status?: number; code?: string; responseBody?: any };
            error.status = statusCode;
            error.code = typeof parsed?.code === 'string'
              ? parsed.code
              : (typeof parsed?.error === 'string' ? parsed.error : undefined);
            error.responseBody = parsed;
            rejectOnce(error);
            return;
          }
          resolveOnce(parsed);
        });
      });
      request.on('error', rejectOnce);
      request.setTimeout(timeoutMs, () => request.destroy(new Error('trackly request timed out')));
      if (bodyString) request.write(bodyString);
      request.end();
    });
  }`,
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'resultContent',
  `function resultContent(value: unknown, includeStructuredContent = false) {
    const content = {
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    };
    if (!includeStructuredContent) return content;
    const structuredContent = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { value };
    return { ...content, structuredContent };
  }`,
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'errorContent',
  `function errorContent(error: any, fallback: string) {
    const body = error?.responseBody;
    const payload: Record<string, unknown> = {
      error: typeof error?.message === 'string' ? error.message : fallback,
    };
    if (Number.isInteger(error?.status)) payload.status = error.status;
    if (typeof error?.code === 'string') payload.code = error.code;
    if (error?.status === 409 && body?.confirmation) {
      payload.confirmation = body.confirmation;
    }
    if (error?.status === 409 && body?.conflictCode) {
      payload.conflictCode = body.conflictCode;
    }
    if (Number.isSafeInteger(body?.currentRevision) && body.currentRevision >= 0) {
      payload.currentRevision = body.currentRevision;
    }
    if (Array.isArray(body?.changedKeys)) {
      payload.changedKeys = body.changedKeys
        .filter((key: unknown): key is string => typeof key === 'string' && key.length <= 200)
        .slice(0, 100);
    }
    if (typeof body?.retryable === 'boolean') payload.retryable = body.retryable;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }`,
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'projectApplyStartResult',
  `function projectApplyStartResult(
    response: any,
    requestedTarget: number,
    options: { resumed: boolean; started: boolean; targetMismatch: boolean },
  ) {
    const execution = response?.execution;
    const activeTarget = readinessCount(execution?.targetCount ?? execution?.target);
    return {
      view: 'apply' as const,
      success: response?.success !== false,
      active: response?.active === true
        || execution?.status === 'running'
        || execution?.status === 'target_reached',
      resumed: options.resumed,
      started: options.started,
      targetMismatch: options.targetMismatch,
      target: activeTarget ?? readinessCount(requestedTarget),
      requestedTarget: readinessCount(requestedTarget),
      activeTarget,
      executionId: readinessCount(execution?.id),
      revision: readinessCount(execution?.revision),
      status: safeExecutionStatus(execution?.status),
      batchId: null,
      memberIds: [],
      nextAction: options.targetMismatch ? 'use_active_target' as const : 'advance_or_refresh' as const,
      noSubmit: true as const,
    };
  }`,
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'safeReviewStatus',
  `function safeReviewStatus(value: unknown): (typeof APPLY_REVIEW_STATUS_VALUES)[number] | null {
    return typeof value === 'string'
      && (APPLY_REVIEW_STATUS_VALUES as readonly string[]).includes(value)
      ? value as (typeof APPLY_REVIEW_STATUS_VALUES)[number]
      : null;
  }`,
  hostedPluginSourcePath,
);
assertImportBinding(
  hostedApplySource,
  'generateInternalToken',
  'generateInternalToken',
  './mcp-tokens.js',
  hostedApplySourcePath,
);
assertImportBinding(
  hostedApplySource,
  'verifiedHostedMcpOAuthContext',
  'verifiedHostedMcpOAuthContext',
  './hosted-auth-context.js',
  hostedApplySourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedApplySource,
  'generateHostedOAuthInternalToken',
  `function generateHostedOAuthInternalToken(authInfo: HostedOAuthAuthInfo): string {
    return generateInternalToken(
      {
        id: authInfo.extra.userId,
        email: authInfo.extra.email,
        name: authInfo.extra.name || '',
        authEpoch: authInfo.extra.authEpoch,
      },
      verifiedHostedMcpOAuthContext({
        clientId: authInfo.clientId,
        grantId: authInfo.extra.grantId,
        scopes: authInfo.scopes,
      }),
    );
  }`,
  hostedApplySourcePath,
);
const executablePluginRegistrations = directToolRegistrationsInExportedFunction(
  hostedPluginSource,
  'createTracklyPluginMcpServer',
  'registerPluginTool',
  hostedPluginSourcePath,
  { requireUiResourceLoop: true },
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
assertMcpScopeHelperSemantics(hostedMcpScopesSource, hostedMcpScopesPath);
assertImmutablePluginScopeFreeMethods(hostedPluginScopesSource, hostedPluginScopesPath);
assertImmutablePluginToolScopesSemantics(hostedPluginScopesSource, hostedPluginScopesPath);
assertActiveVariableInitializerAst(
  hostedApplicationProfileCatalogSource,
  'APPLICATION_PROFILE_FIELDS',
  `APPLICATION_PROFILE_FIELD_DEFINITIONS.map((field, index) => ({
    ...field,
    order: index + 1,
    rationale: rationaleForCategory(field.category),
  }))`,
  hostedApplicationProfileCatalogPath,
);
assertApplicationFieldByKeyReferenceSemantics(
  hostedApplicationProfileCatalogSource,
  hostedApplicationProfileCatalogPath,
  hostedPluginScopesSource,
  hostedPluginScopesPath,
);
const applicationFieldSensitivityMap = staticApplicationFieldSensitivityMap(
  hostedApplicationProfileCatalogSource,
  hostedApplicationProfileCatalogPath,
);
assert.equal(
  sha256ExactBytes(JSON.stringify(applicationFieldSensitivityMap)),
  'd6970a25e4b10d3c32b7eb6bb2548915a6bf4d6ec6fc1f619677120383a36854',
  'Application profile field keys and sensitivity classifications drifted from the reviewed conditional-scope catalog',
);
assert.deepEqual(
  executableScopeContract,
  pluginLock.publicScopeContract,
  'All executable hosted plugin scope mappings must match the packaged public scope lock',
);
assert.equal(
  sha256ExactBytes(hostedPluginScopesSource),
  pluginLock.publicExecutableContract.pluginScopesSha256,
  'Hosted plugin conditional scope enforcement drifted from the packaged whole-source digest lock',
);
assertActiveFunctionDefinitionAst(
  hostedPluginScopesSource,
  'requiredScopesForPluginTool',
  `function requiredScopesForPluginTool(toolName: string): McpScope[] | null {
    if (!Object.hasOwn(TRACKLY_PLUGIN_TOOL_SCOPES, toolName)) return null;
    return [
      ...TRACKLY_PLUGIN_TOOL_SCOPES[
        toolName as keyof typeof TRACKLY_PLUGIN_TOOL_SCOPES
      ],
    ];
  }`,
  hostedPluginScopesPath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginScopesSource,
  'requiredScopesForPluginToolCall',
  `function requiredScopesForPluginToolCall(
    toolName: string,
    args: unknown,
  ): McpScope[] | null {
    const required = requiredScopesForPluginTool(toolName);
    if (required === null) return null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return required;
    const input = args as Record<string, unknown>;
    if (toolName === 'trackly_update_status' && input.action === 'applied') {
      required.push('apply:write');
    }
    if (toolName === 'trackly_save_application_answers' && Array.isArray(input.changes)) {
      const requestsSensitiveWrite = input.changes.some((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
        const key = (candidate as Record<string, unknown>).key;
        return typeof key === 'string'
          && APPLICATION_FIELD_BY_KEY.get(key)?.sensitivity !== 'standard';
      });
      if (requestsSensitiveWrite) required.push('sensitive:write');
    }
    if (toolName === 'trackly_get_apply_work') {
      const snapshot = input.snapshot;
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        const profileKeys = (snapshot as Record<string, unknown>).profileKeys;
        const requestsSensitiveRead = Array.isArray(profileKeys) && profileKeys.some((key) => (
          typeof key === 'string'
          && APPLICATION_FIELD_BY_KEY.get(key)?.sensitivity !== 'standard'
        ));
        if (requestsSensitiveRead) required.push('sensitive:read');
      }
    }
    return required;
  }`,
  hostedPluginScopesPath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginScopesSource,
  'enforceTracklyPluginScope',
  `function enforceTracklyPluginScope(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    type JsonRpcMessage = {
      id?: unknown;
      method?: unknown;
      params?: { name?: unknown; arguments?: unknown };
    };
    if (Array.isArray(req.body)) {
      res.status(400).json(req.body.map((candidate: unknown) => ({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'JSON-RPC batches are not supported' },
        id: candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? (candidate as JsonRpcMessage).id ?? null
          : null,
      })));
      return;
    }
    const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    const granted = Array.isArray((req as any).auth?.scopes)
      ? (req as any).auth.scopes as string[]
      : [];
    const grantedSet = new Set(granted);
    let denied: { message: JsonRpcMessage; required: McpScope[] | null } | undefined;
    for (const candidate of messages) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const message = candidate as JsonRpcMessage;
      if (isJsonRpcResponse(candidate as Record<string, unknown>)) continue;
      if (typeof message.method === 'string'
        && TRACKLY_PLUGIN_SCOPE_FREE_METHODS.has(message.method)) continue;
      if (message.method !== 'tools/call') {
        denied = { message, required: null };
        break;
      }
      const name = message.params?.name;
      const required = typeof name === 'string'
        ? requiredScopesForPluginToolCall(name, message.params?.arguments)
        : null;
      if (required === null || required.some((scope) => !grantedSet.has(scope))) {
        denied = { message, required };
        break;
      }
    }

    if (!denied) {
      next();
      return;
    }

    const required = denied.required || [];
    const messageShape = typeof denied.message.method === 'string'
      ? 'method-present'
      : 'method-free';
    const method = diagnosticMethod(denied.message.method);
    const tool = method === 'tools/call'
      ? diagnosticToolName(denied.message.params?.name)
      : '[redacted]';
    const missingSignature = required
      .filter((scope) => !grantedSet.has(scope))
      .sort()
      .join(',') || '[none]';
    const diagnosticKey = \`\${messageShape}:\${method}:\${tool}:\${missingSignature}\`;
    const diagnostic = scopeDenialDiagnostics.get(diagnosticKey) || {
      nextAt: 0,
      suppressed: 0,
    };
    const now = Date.now();
    if (now >= diagnostic.nextAt) {
      scopeDenialDiagnostics.set(diagnosticKey, {
        nextAt: now + SCOPE_DENIAL_DIAGNOSTIC_INTERVAL_MS,
        suppressed: 0,
      });
      try {
        logger.warn('trackly-plugin-mcp', 'OAuth scope enforcement denied request', {
          messageShape,
          method,
          tool,
          requiredScopes: required.slice(0, 16),
          grantedScopes: granted
            .filter((scope): scope is McpScope => (
              typeof scope === 'string' && MCP_SUPPORTED_SCOPES.includes(scope as McpScope)
            ))
            .slice(0, 16),
          suppressedSinceLast: diagnostic.suppressed,
        });
      } catch {
        // Diagnostics must never change the authorization response.
      }
    } else {
      diagnostic.suppressed += 1;
      scopeDenialDiagnostics.set(diagnosticKey, diagnostic);
    }
    res.setHeader(
      'WWW-Authenticate',
      \`Bearer error="insufficient_scope", scope="\${required.join(' ')}"\`,
    );
    res.status(403).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Insufficient OAuth scope',
        data: {
          error: 'insufficient_scope',
          required_scopes: required,
          granted_scopes: granted,
        },
      },
      id: denied.message.id ?? null,
    });
  }`,
  hostedPluginScopesPath,
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

function pluginToolRegistration(name) {
  const matches = executablePluginRegistrations.filter((registration) => registration.name === name);
  assert.equal(matches.length, 1, `${name} must have exactly one active registration in ${hostedPluginSourcePath}`);
  return matches[0];
}

function pluginToolDefinition(name) {
  const registration = pluginToolRegistration(name);
  return hostedPluginSource.slice(registration.call.start, registration.call.end);
}

const executableRegistrationArguments = Object.fromEntries(executablePluginTools.map((name) => {
  const registration = pluginToolRegistration(name);
  return [name, registrationArgumentSources(hostedPluginSource, registration, hostedPluginSourcePath)];
}));
assertActiveVariableInitializerAst(
  hostedPluginSource,
  'readOnlyAnnotations',
  `Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })`,
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'mutationAnnotations',
  `function mutationAnnotations(
    destructiveHint = false,
    idempotentHint = false,
  ) {
    return {
      readOnlyHint: false,
      destructiveHint,
      idempotentHint,
      openWorldHint: false,
    };
  }`,
  hostedPluginSourcePath,
);
const mutationAnnotationContract = {
  trackly_update_status: 'mutationAnnotations(false, false)',
  trackly_save_application_answers: 'mutationAnnotations(true, false)',
  trackly_grant_sensitive_storage_consent: 'mutationAnnotations(false, true)',
  trackly_revoke_sensitive_storage_consent: 'mutationAnnotations(true, false)',
  trackly_start_or_resume_apply: 'mutationAnnotations(false, true)',
  trackly_get_apply_work: 'mutationAnnotations()',
  trackly_report_apply_progress: 'mutationAnnotations()',
  trackly_certify_review_ready: 'mutationAnnotations(false, true)',
  trackly_reconcile_manual_submission: 'mutationAnnotations(false, true)',
  trackly_stop_apply: 'mutationAnnotations(true, true)',
};
for (const toolName of executablePluginTools) {
  const annotations = registrationDescriptorPropertyAst(
    hostedPluginSource,
    pluginToolRegistration(toolName),
    'annotations',
    hostedPluginSourcePath,
  );
  const scopes = pluginLock.publicScopeContract[toolName];
  const isMutation = scopes.some((scope) => scope.endsWith(':write'));
  if (isMutation) {
    assert.ok(mutationAnnotationContract[toolName], `${toolName} mutation annotations must be explicitly locked`);
    assert.deepEqual(
      canonicalSchemaAst(annotations),
      canonicalSchemaAst(parseExpectedExpression(
        mutationAnnotationContract[toolName],
        `${toolName}.annotations contract`,
      )),
      `${toolName} has a write scope and must publish its complete locked mutationAnnotations(...) expression`,
    );
  } else {
    assert.deepEqual(
      canonicalSchemaAst(annotations),
      canonicalSchemaAst(parseExpectedExpression('readOnlyAnnotations', `${toolName}.annotations`)),
      `${toolName} has read-only scopes and must publish readOnlyAnnotations`,
    );
  }
}
assert.deepEqual(
  Object.keys(mutationAnnotationContract).sort(),
  Object.entries(pluginLock.publicScopeContract)
    .filter(([, scopes]) => scopes.some((scope) => scope.endsWith(':write')))
    .map(([toolName]) => toolName)
    .sort(),
  'Mutation annotation contract must cover every write-scoped public tool exactly once',
);
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
assert.equal(
  sha256ExactBytes(hostedJobBriefServiceSource),
  pluginLock.publicExecutableContract.jobBriefServiceSha256,
  'Hosted public job-brief date validation drifted from the packaged whole-source digest lock',
);
assert.equal(
  sha256ExactBytes(fs.readFileSync(path.join(backendRoot, 'src', 'utils', 'trackly-web-origin.ts'))),
  pluginLock.publicExecutableContract.backendUiRedirectSha256,
  'Hosted backend UI redirect middleware semantics drifted from the packaged whole-source digest lock',
);
assert.equal(
  sha256ExactBytes(fs.readFileSync(path.join(backendRoot, 'src', 'middleware', 'maintenance-mode.ts'))),
  pluginLock.publicExecutableContract.maintenanceModeSha256,
  'Hosted maintenance middleware semantics drifted from the packaged whole-source digest lock',
);
assert.equal(
  sha256ExactBytes(fs.readFileSync(path.join(backendRoot, 'src', 'config', 'database.ts'))),
  pluginLock.publicExecutableContract.databaseBindingSha256,
  'Hosted production database binding drifted from the packaged whole-source digest lock',
);
assert.equal(
  sha256ExactBytes(hostedReviewIdentitySource),
  pluginLock.publicExecutableContract.reviewIdentitySha256,
  'Hosted configured review-identity predicate drifted from the packaged whole-source digest lock',
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
  APPLY_EXECUTION_MEMBER_OPERATIONS: [hostedApplyExecutionContractSource, hostedApplyExecutionContractPath],
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
const exactSharedParseSchemaNames = sharedParseSchemaNames.filter(
  (schemaName) => schemaName !== 'startApplyRunSchema',
);
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
for (const schemaName of exactSharedParseSchemaNames) {
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
const classifiedSchemaDependencies = {};
for (const [side, sourceText, sourcePath, schemaAsts] of [
  ['local', localApplySource, localApplySourcePath, localApplySchemaAsts],
  ['hosted', hostedApplySource, hostedApplySourcePath, hostedApplySchemaAsts],
]) {
  const dependencies = [...new Set(
    exactSharedParseSchemaNames.flatMap((schemaName) => referencedFreeIdentifiers(schemaAsts[schemaName])),
  )].sort();
  classifiedSchemaDependencies[side] = {
    sourceText,
    sourcePath,
    dependencies: classifyFreeIdentifiers(dependencies, {
      runtimeGlobal: ['undefined', 'z'],
      sharedDefinition: exactSharedParseSchemaNames,
      contractConstant: expectedSchemaConstants,
    }, `${side} Apply schema`),
  };
}
assert.deepEqual(
  classifiedSchemaDependencies.local.dependencies,
  classifiedSchemaDependencies.hosted.dependencies,
  'Local and hosted Apply schemas must reference the same explicitly classified dependencies',
);
const sharedDefinitionDependencies = Object.entries(classifiedSchemaDependencies.local.dependencies)
  .filter(([, classification]) => classification === 'sharedDefinition')
  .map(([name]) => name);
assert.deepEqual(
  Object.entries(classifiedSchemaDependencies.local.dependencies)
    .filter(([, classification]) => classification === 'contractConstant')
    .map(([name]) => name),
  expectedSchemaConstants,
  'Apply schema transitive contract-constant audit changed; explicitly lock every new dependency',
);
for (const dependencyName of sharedDefinitionDependencies) {
  assert.deepEqual(
    canonicalSchemaAst(activeNamedDefinitionAst(
      classifiedSchemaDependencies.local.sourceText,
      dependencyName,
      classifiedSchemaDependencies.local.sourcePath,
    )),
    canonicalSchemaAst(activeNamedDefinitionAst(
      classifiedSchemaDependencies.hosted.sourceText,
      dependencyName,
      classifiedSchemaDependencies.hosted.sourcePath,
    )),
    `${dependencyName} executable definition drifted between local and hosted Apply schemas`,
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
    localParse: 'truthCertificationSchema',
    hostedPublishedAndParse: 'truthCertificationInputSchema',
  },
  trackly_start_apply_run: {
    localPublished: 'startApplyRunInputSchema',
    localParse: 'startApplyRunSchema',
    hostedPublishedAndParse: 'startApplyRunSchema',
  },
};
const executableLocalApplyRegistrations = [
  ...directToolRegistrationsInNamedParameterFunction(
    localApplySource,
    'registerApplyTools',
    'server',
    'tool',
    localApplySourcePath,
  ),
  ...directToolRegistrationsInNamedParameterFunction(
    localApplySource,
    'registerApplyTools',
    'server',
    'registerTool',
    localApplySourcePath,
  ),
];
const executableLocalBaseRegistrations = directToolRegistrationsInNamedParameterFunction(
  localServerSource,
  'createServer',
  'server',
  'tool',
  localServerSourcePath,
  'direct-construction',
);
const executableHostedRegistrations = directHostedToolRegistrationsInNamedFactory(
  hostedApplySource,
  'createTracklyMcpServer',
  'registerHostedMcpTool',
  hostedApplySourcePath,
  pluginLock.hostedMcpToolAllowlist,
);
assertHostedStartApplyRunBatchBindingGuard(
  executableHostedRegistrations.find(({ name }) => name === 'trackly_start_apply_run'),
  hostedApplySourcePath,
);
const executableLocalApplyToolNames = executableLocalApplyRegistrations.map(({ name }) => name);
const executableLocalToolNames = [
  ...executableLocalBaseRegistrations.map(({ name }) => name),
  ...executableLocalApplyToolNames,
];
assert.equal(
  new Set(executableLocalToolNames).size,
  executableLocalToolNames.length,
  'Executable local MCP source must not register a tool name more than once',
);
assert.deepEqual(
  [...executableLocalToolNames].sort(),
  [
    ...pluginLock.hostedMcpToolAllowlist.filter((name) => !HOSTED_ONLY_TOOLS.includes(name)),
    ...LOCAL_ONLY_TOOLS,
  ].sort(),
  'Executable local MCP registrations must exactly match the locked hosted catalog minus hosted-only chat plus local-only tools',
);
const hostedRegistrationNames = new Set(executableHostedRegistrations.map(({ name }) => name));
const sharedApplyToolNames = executableLocalApplyToolNames.filter((name) => hostedRegistrationNames.has(name));
assert.equal(
  new Set(sharedApplyToolNames).size,
  sharedApplyToolNames.length,
  'Shared local/hosted Apply schema catalog must not contain duplicate names',
);
for (const toolName of sharedApplyToolNames) {
  const localRegistrations = executableLocalApplyRegistrations.filter(
    (registration) => registration.name === toolName,
  );
  const hostedRegistrations = executableHostedRegistrations.filter(
    (registration) => registration.name === toolName,
  );
  assert.equal(localRegistrations.length, 1, `${toolName} local must have exactly one active registration`);
  assert.equal(hostedRegistrations.length, 1, `${toolName} hosted must have exactly one active registration`);
  const mapping = publishedSchemaCompatibility[toolName];
  if (mapping) {
    for (const [side, registrations, sourcePath, schemaName] of [
      ['local', localRegistrations, localApplySourcePath, mapping.localPublished],
      ['hosted', hostedRegistrations, hostedApplySourcePath, mapping.hostedPublishedAndParse],
    ]) {
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
      if (side === 'local') {
        assertWrappedHandlerParsesWithSchema(registrations[0], mapping.localParse, sourcePath);
      }
    }
    continue;
  }
  const localSchema = registrationInputSchemaAst(
    localApplySource,
    localRegistrations[0],
    localApplySourcePath,
  );
  const hostedSchema = registrationInputSchemaAst(
    hostedApplySource,
    hostedRegistrations[0],
    hostedApplySourcePath,
  );
  if (toolName === 'trackly_verify_prepared_resume') {
    assert.deepEqual(
      canonicalSchemaAst(localSchema),
      canonicalSchemaAst(babelParser.parseExpression(`({
        runId: z.number().int().min(1),
        resumeId: z.number().int().min(1),
        confirmationId: z.string().min(1).max(200),
        exactLocalPath: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
        sizeBytes: z.number().int().min(1),
        expiresAt: z.string().datetime(),
      })`, { plugins: ['typescript'] })),
      `${toolName} local schema must preserve the complete local proof contract`,
    );
    assert.deepEqual(
      canonicalSchemaAst(hostedSchema),
      canonicalSchemaAst(babelParser.parseExpression(`({
        runId: z.number().int().min(1),
        confirmationId: z.string().min(1).max(200),
      })`, { plugins: ['typescript'] })),
      `${toolName} hosted schema must remain an explicitly bounded manual-handoff contract`,
    );
    continue;
  }
  assert.deepEqual(
    canonicalSchemaAst(hostedSchema),
    canonicalSchemaAst(localSchema),
    `${toolName} hosted/local input schemas drifted from their complete shared Apply contract`,
  );
}

const grantSensitiveStorageRegistration = pluginToolRegistration(
  'trackly_grant_sensitive_storage_consent',
);
assertWrappedHandlerAst(
  grantSensitiveStorageRegistration,
  `({ expectedRevision }) => requestApi(
    'PATCH', '/api/jobscout/application-profile', authToken,
    { expectedRevision, source: 'mcp', sensitiveStorageConsent: true },
  )`,
  hostedPluginSourcePath,
);
const revokeSensitiveStorageRegistration = pluginToolRegistration(
  'trackly_revoke_sensitive_storage_consent',
);
assertWrappedHandlerAst(
  revokeSensitiveStorageRegistration,
  `(params) => requestApi(
    'PATCH', '/api/jobscout/application-profile', authToken,
    { ...params, source: 'mcp', sensitiveStorageConsent: false },
  )`,
  hostedPluginSourcePath,
);
assertTruthWrapperCompatibility(
  localApplySchemaAsts.truthCertificationInputSchema,
  hostedApplySchemaAsts.truthCertificationSchema,
);
assertStartRunWrapperCompatibility(
  localApplySchemaAsts.startApplyRunInputSchema,
  hostedApplySchemaAsts.startApplyRunSchema,
);

const jobBriefRegistration = pluginToolRegistration('trackly_get_job_brief');
const jobBriefDescriptor = jobBriefRegistration.call.arguments[1];
const jobBriefDescriptorProperties = staticBabelObjectProperties(
  jobBriefDescriptor,
  'trackly_get_job_brief descriptor',
);
assert.deepEqual(
  Object.keys(jobBriefDescriptorProperties),
  ['title', 'description', 'inputSchema', 'annotations'],
  'trackly_get_job_brief must not publish an unverified output schema',
);
const jobBriefOutputProperties = wrappedHandlerReturnProperties(
  jobBriefRegistration,
  hostedPluginSourcePath,
);
assert.deepEqual(
  Object.keys(jobBriefOutputProperties),
  ['jobId', 'companyName', 'companySignal'],
  'trackly_get_job_brief output must exclude contacts, employees, referrals, actions, and raw backend fields',
);
for (const [field, expression] of Object.entries({
  jobId: 'brief.jobId',
  companyName: 'brief.companyName',
})) {
  assertBabelPropertyExpression(
    jobBriefOutputProperties,
    field,
    expression,
    'trackly_get_job_brief output projection',
  );
}
const jobBriefCompanySignalProperties = staticBabelObjectProperties(
  jobBriefOutputProperties.companySignal,
  'trackly_get_job_brief companySignal projection',
);
for (const [field, expression] of Object.entries({
  openRoleCount: 'brief.companySignal?.openRoleCount ?? 0',
  pmRoleCount: 'brief.companySignal?.pmRoleCount ?? 0',
  postedLast7d: 'brief.companySignal?.postedLast7d ?? 0',
  latestPostedAt: 'brief.companySignal?.latestPostedAt ?? null',
})) {
  assertBabelPropertyExpression(
    jobBriefCompanySignalProperties,
    field,
    expression,
    'trackly_get_job_brief companySignal projection',
  );
}
assert.deepEqual(
  Object.keys(jobBriefCompanySignalProperties),
  ['openRoleCount', 'pmRoleCount', 'postedLast7d', 'latestPostedAt'],
  'trackly_get_job_brief companySignal must remain a bounded aggregate-only projection',
);

const readinessRegistration = pluginToolRegistration('trackly_get_apply_readiness');
assertDescriptorUsesTopLevelBinding(
  hostedPluginSource,
  readinessRegistration,
  'outputSchema',
  'readinessOutputSchema',
  hostedPluginSourcePath,
);
assertWrappedHandlerDirectStatementAst(
  readinessRegistration,
  `return projectApplyReadiness({
    schema: value(schemaResult),
    profileResponse: value(profileResult),
    queue: value(queueResult),
    protocolResponse: value(protocolResult),
    executionResponse: value(executionResult),
    availability: {
      schema: schemaResult.status === 'fulfilled',
      profile: profileResult.status === 'fulfilled',
      queue: queueResult.status === 'fulfilled',
      protocol: protocolResult.status === 'fulfilled',
      execution: executionResult.status === 'fulfilled',
    },
  });`,
  hostedPluginSourcePath,
);
const readinessRootProperties = schemaObjectPropertyAsts(
  hostedPluginSource,
  'readinessOutputSchema',
  hostedPluginSourcePath,
);
assert.ok(readinessRootProperties.profile, 'readinessOutputSchema is missing profile');
const readinessProperties = namedProperties(
  objectSchemaProperties(readinessRootProperties.profile, 'readinessOutputSchema.profile'),
  'readinessOutputSchema.profile',
);
const profileFieldReferenceProperties = schemaObjectPropertyAsts(
  hostedPluginSource,
  'profileFieldReferenceSchema',
  hostedPluginSourcePath,
);
const readinessProfileContract = {
  revision: 'nullableCountSchema',
  confirmed: 'z.boolean()',
  sensitiveStorageConsent: 'z.boolean()',
  defaultResumeAvailable: 'z.boolean()',
  completeness: 'z.object({ completed: nullableCountSchema, total: nullableCountSchema, percent: nullableCountSchema }).strict()',
  missingRequired: 'z.array(profileFieldReferenceSchema).max(100)',
  availableFields: 'z.array(profileFieldReferenceSchema).max(100)',
};
assertExactSchemaProperties(
  readinessProperties,
  readinessProfileContract,
  'readinessOutputSchema.profile',
);
const profileFieldReferenceContract = {
  key: 'z.string().min(1).max(200)',
  label: 'z.string().min(1).max(1000)',
};
assertExactSchemaProperties(
  profileFieldReferenceProperties,
  profileFieldReferenceContract,
  'profileFieldReferenceSchema',
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'readinessRecord',
  `function readinessRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }`,
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'readinessSchemaAvailable',
  `function readinessSchemaAvailable(value: unknown): value is Record<string, unknown> {
    if (!readinessRecord(value)
      || readinessVersion(value.schemaVersion) === null
      || !Array.isArray(value.fields)
      || value.fields.length > 1_000
      || !Array.isArray(value.screens)
      || value.screens.length > 100) return false;
    const validLabelField = (field: unknown) => {
      if (!readinessRecord(field)) return false;
      return typeof field.key === 'string'
        && field.key.length >= 1
        && field.key.length <= 200
        && typeof field.label === 'string'
        && field.label.length >= 1
        && field.label.length <= 1_000;
    };
    if (!value.fields.every(validLabelField)) return false;
    if (value.educationFields === undefined) return true;
    return Array.isArray(value.educationFields)
      && value.educationFields.length <= 100
      && value.educationFields.every(validLabelField);
  }`,
  hostedPluginSourcePath,
);
assertActiveFunctionDefinitionAst(
  hostedPluginSource,
  'readinessProfileAvailable',
  `function readinessProfileAvailable(value: unknown): value is Record<string, unknown> {
    if (!readinessRecord(value)
      || readinessCount(value.revision) === null
      || !(value.confirmedAt === null
        || (typeof value.confirmedAt === 'string'
          && value.confirmedAt.length >= 1
          && value.confirmedAt.length <= 100))
      || !readinessRecord(value.sensitiveStorage)
      || typeof value.sensitiveStorage.consented !== 'boolean'
      || !(value.defaultResume === null || readinessRecord(value.defaultResume))
      || !readinessRecord(value.completeness)
      || !readinessRecord(value.fields)) return false;
    const completed = readinessCount(value.completeness.completed);
    const total = readinessCount(value.completeness.total);
    const percent = readinessCount(value.completeness.percent);
    const expectedPercent = total === 0 ? 100 : Math.round((Number(completed) / Number(total)) * 100);
    if (completed === null
      || total === null
      || percent === null
      || percent > 100
      || completed > total
      || percent !== expectedPercent
      || !Array.isArray(value.completeness.missingKeys)
      || value.completeness.missingKeys.length > 100
      || !value.completeness.missingKeys.every((key) => (
        typeof key === 'string' && key.length <= 200 && CANONICAL_PROFILE_KEY.test(key)
      ))) return false;
    const fields = Object.entries(value.fields);
    return fields.length <= 1_000 && fields.every(([key, field]) => (
      key.length <= 200
      && CANONICAL_PROFILE_KEY.test(key)
      && readinessRecord(field)
      && typeof field.state === 'string'
      && (field.state === 'unknown' || RESOLVED_PROFILE_STATES.has(field.state))
    ));
  }`,
  hostedPluginSourcePath,
);
for (const statement of [
  `const schemaProjectionAvailable = availability.schema && readinessSchemaAvailable(schema);`,
  `const safeSchema: any = schemaProjectionAvailable ? schema : undefined;`,
  `const rawProfile = profileResponse?.profile;`,
  `const profileBodyAvailable = availability.profile && readinessProfileAvailable(rawProfile);`,
  `const profile: any = profileBodyAvailable ? rawProfile : undefined;`,
  `const fieldLabels = new Map(
    (Array.isArray(safeSchema?.fields) ? safeSchema.fields : []).flatMap((field: unknown) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return [];
      const value = field as Record<string, unknown>;
      return typeof value.key === 'string' && typeof value.label === 'string'
        ? [[value.key, value.label] as const]
        : [];
    }),
  );`,
  `for (const field of Array.isArray(safeSchema?.educationFields) ? safeSchema.educationFields : []) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
    const value = field as Record<string, unknown>;
    if (typeof value.key === 'string' && typeof value.label === 'string') {
      fieldLabels.set(\`education.\${value.key}\`, value.label);
    }
  }`,
  `const missingRequiredKeys = Array.isArray(profile?.completeness?.missingKeys)
    ? (profile.completeness.missingKeys as unknown[]).flatMap((key): string[] => (
      typeof key === 'string' && key.length <= 200 && CANONICAL_PROFILE_KEY.test(key)
        ? [key]
        : []
    )).slice(0, 100)
    : [];`,
  `const missingRequired = missingRequiredKeys.flatMap((key) => (
    fieldLabels.has(key) ? [{ key, label: fieldLabels.get(key)! }] : []
  ));`,
  `const profileProjectionAvailable = schemaProjectionAvailable
    && profileBodyAvailable
    && missingRequired.length === missingRequiredKeys.length;`,
  `const availableFields = profile?.fields
    && typeof profile.fields === 'object'
    && !Array.isArray(profile.fields)
    ? Object.keys(profile.fields)
      .filter((key) => (
        key.length <= 200
        && CANONICAL_PROFILE_KEY.test(key)
        && fieldLabels.has(key)
        && profile.fields[key]
        && typeof profile.fields[key] === 'object'
        && !Array.isArray(profile.fields[key])
        && RESOLVED_PROFILE_STATES.has(profile.fields[key].state)
      ))
      .sort()
      .slice(0, 100)
      .map((key) => ({ key, label: fieldLabels.get(key)! }))
    : [];`,
]) {
  assertActiveFunctionDirectStatementAst(
    hostedPluginSource,
    'projectApplyReadiness',
    statement,
    hostedPluginSourcePath,
  );
}

const readinessProjectionProperties = functionSoleReturnObjectProperties(
  hostedPluginSource,
  'projectApplyReadiness',
  hostedPluginSourcePath,
);
const readinessProfileProjectionProperties = staticBabelObjectProperties(
  readinessProjectionProperties.profile,
  'projectApplyReadiness profile projection',
);
assertBabelPropertyExpression(
  readinessProfileProjectionProperties,
  'missingRequired',
  'missingRequired',
  'projectApplyReadiness profile projection',
);
const readinessAvailability = readinessProjectionProperties.availability;
assert.equal(
  readinessAvailability?.type,
  'ObjectExpression',
  'projectApplyReadiness availability must be a bounded object projection',
);
assert.equal(
  readinessAvailability.properties.length,
  3,
  'projectApplyReadiness availability must preserve base status plus locked schema/profile availability',
);
assert.equal(readinessAvailability.properties[0]?.type, 'SpreadElement');
assert.equal(readinessAvailability.properties[0]?.argument?.type, 'Identifier');
assert.equal(readinessAvailability.properties[0]?.argument?.name, 'availability');
const readinessAvailabilityProperties = staticBabelObjectProperties(
  { ...readinessAvailability, properties: readinessAvailability.properties.slice(1) },
  'projectApplyReadiness availability projection',
);
assertBabelPropertyExpression(
  readinessAvailabilityProperties,
  'schema',
  'schemaProjectionAvailable',
  'projectApplyReadiness availability projection',
);
assertBabelPropertyExpression(
  readinessAvailabilityProperties,
  'profile',
  'profileProjectionAvailable',
  'projectApplyReadiness availability projection',
);

const applyOutputProperties = schemaObjectPropertyAsts(
  hostedPluginSource,
  'applyOutputSchema',
  hostedPluginSourcePath,
);
const applyOutputContract = {
  view: "z.literal('apply')",
  success: 'z.boolean()',
  active: 'z.boolean()',
  resumed: 'z.boolean()',
  started: 'z.boolean()',
  targetMismatch: 'z.boolean()',
  target: 'nullableCountSchema',
  requestedTarget: 'nullableCountSchema',
  activeTarget: 'nullableCountSchema',
  executionId: 'nullableCountSchema',
  revision: 'nullableCountSchema',
  status: 'z.enum(APPLY_EXECUTION_STATUS_VALUES).nullable()',
  batchId: 'nullableCountSchema',
  memberIds: 'z.array(z.number().int().min(1)).max(APPLY_EXECUTION_MAX_TARGET)',
  nextAction: "z.enum(['work_ready', 'use_active_target', 'advance_or_refresh', 'restart_after_reauthorization', 'complete', 'manual_review'])",
  noSubmit: 'z.literal(true)',
};
assert.deepEqual(
  Object.keys(applyOutputProperties),
  Object.keys(applyOutputContract),
  'applyOutputSchema must publish only its required locked fields',
);
for (const [field, expression] of Object.entries(applyOutputContract)) {
  assertSchemaPropertyExpression(applyOutputProperties, field, expression, 'applyOutputSchema');
}
const startOrResumeRegistration = pluginToolRegistration('trackly_start_or_resume_apply');
const startOrResume = pluginToolDefinition('trackly_start_or_resume_apply');
const startOrResumeDescriptorProperties = staticBabelObjectProperties(
  startOrResumeRegistration.call.arguments[1],
  'trackly_start_or_resume_apply descriptor',
);
assertBabelPropertyExpression(
  startOrResumeDescriptorProperties,
  'inputSchema',
  `z.object({
    target: z.number().int().min(1).max(APPLY_EXECUTION_MAX_TARGET),
    idempotencyKey: z.string().min(16).max(180).regex(SAFE_IDEMPOTENCY_KEY),
    browserSurface: z.enum(APPLY_BROWSER_SURFACES),
  }).strict()`,
  'trackly_start_or_resume_apply descriptor',
);
assertDescriptorUsesTopLevelBinding(
  hostedPluginSource,
  startOrResumeRegistration,
  'outputSchema',
  'applyOutputSchema',
  hostedPluginSourcePath,
);
assertWrappedHandlerDirectStatementAst(
  startOrResumeRegistration,
  `const orchestrationRequest = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => requestApi(
    method,
    path,
    authToken,
    body,
    headers,
    APPLY_ORCHESTRATION_REQUEST_TIMEOUT_MS,
  );`,
  hostedPluginSourcePath,
);
assertWrappedHandlerAssignedRequestEndpoint(
  startOrResumeRegistration,
  'prepared',
  'POST',
  '`/api/jobscout/apply/batches/${batchId}/plugin-prepare`',
  hostedPluginSourcePath,
  { afterBindingName: 'page', calleeName: 'orchestrationRequest' },
);
assertWrappedHandlerStatementSequenceAst(
  startOrResumeRegistration,
  `const started = await orchestrationRequest(
    'POST', '/api/jobscout/apply/executions',
    { mode: 'complete_next_n_accessible', target },
    { 'Idempotency-Key': idempotencyKey },
  );
  startResult = projectApplyStartResult(started, target, {
    resumed: false, started: true, targetMismatch: false,
  });`,
  hostedPluginSourcePath,
);
assertWrappedHandlerStatementSequenceAst(
  startOrResumeRegistration,
  `let execution = await orchestrationRequest(
    'GET', \`/api/jobscout/apply/executions/\${startResult.executionId}\`,
  );
  let batchId = readinessCount(execution?.execution?.unresolvedWaves?.[0]?.batchId);`,
  hostedPluginSourcePath,
);
assertWrappedHandlerStatementSequenceAst(
  startOrResumeRegistration,
  `const page = await orchestrationRequest(
    'GET', \`/api/jobscout/apply/batches/\${batchId}?limit=\${APPLY_EXECUTION_MAX_TARGET}\`,
  );
  const prepared = await orchestrationRequest(
    'POST', \`/api/jobscout/apply/batches/\${batchId}/plugin-prepare\`,
    { expectedRevision: page?.batch?.revision },
    { 'Idempotency-Key': \`\${idempotencyKey}:prepare\` },
  );`,
  hostedPluginSourcePath,
);
assert.doesNotMatch(startOrResume, /\bleaseToken\b|\/claim|\/api\/jobscout\/apply\/runs/);

for (const [name, digest] of Object.entries({
  projectApplyWorkSnapshot: '1f1f0f80381c14e44157b4d491f100cf9f4ad182abbf87cab89032dcf327eca1',
  projectApplyWorkResponse: '9c0b03f3eeec7d5d7aef2d3fde45fe452471ae299806b338cad9a9592a9f5308',
  projectApplyWorkExecution: 'b4bf7d4fe1720870cb579a4c3dc7fbc88df0b1e0b2abcaece9a3b4ef86cb77ea',
  projectApplyWorkProgress: '5ec96731c10aa70a10ebde09d1ba118c55e32e366a30b394cce1b9e0a57bd568',
  readinessCount: '3d130acc0da6a240ee0a07b4da2cec356ee7113e44cd5ffbed42a5c31f50f299',
  safeExecutionStatus: 'b4bacbbea669cd7f3409d0995b7eb8dbaf52aff18d4c97282fc14d78800c2d8b',
})) {
  assertActiveFunctionAstSha256(hostedPluginSource, name, digest, hostedPluginSourcePath);
}
assertActiveVariableInitializerAst(hostedPluginSource, 'SHA256', '/^[a-f0-9]{64}$/', hostedPluginSourcePath);
assertActiveVariableInitializerAst(
  hostedPluginSource,
  'APPLY_EXECUTION_STATUS_VALUES',
  `[
    'running', 'target_reached', 'exhausted_partial', 'stopped', 'closed', 'expired',
  ] as const`,
  hostedPluginSourcePath,
);
assertActiveVariableInitializerAst(
  hostedPluginSource,
  'READINESS_PROGRESS_COUNTS',
  `[
    'target', 'durablyReviewReady', 'submitted', 'reservedReviewSlots', 'currentlyFilling',
    'awaitingAnswer', 'authParked', 'excluded', 'conflicted', 'attempted',
    'remainingCandidates',
  ] as const`,
  hostedPluginSourcePath,
);

const lintRegistration = pluginToolRegistration('trackly_lint_application_text');
const lintDescriptorProperties = staticBabelObjectProperties(
  lintRegistration.call.arguments[1],
  'trackly_lint_application_text descriptor',
);
assertBabelPropertyExpression(
  lintDescriptorProperties,
  'inputSchema',
  `z.object({
    items: z.array(z.object({
      key: z.string().min(1).max(200),
      text: z.string().max(20_000),
      required: z.boolean().optional(),
      minLength: z.number().int().min(0).max(20_000).optional(),
      maxLength: z.number().int().min(1).max(20_000).optional(),
    }).strict()).min(1).max(1),
  }).strict()`,
  'trackly_lint_application_text descriptor',
);
assertWrappedHandlerAst(
  lintRegistration,
  `({ items }) => Promise.resolve(lintApplicationText(items))`,
  hostedPluginSourcePath,
);
assertActiveFunctionAstSha256(
  hostedPluginSource,
  'lintApplicationText',
  'c0720fa2255558660ff43405b7b0ba1ebed8e708bc0d444a7f29aa53f11db3ea',
  hostedPluginSourcePath,
);

const getWorkRegistration = pluginToolRegistration('trackly_get_apply_work');
const getWorkDescriptorProperties = staticBabelObjectProperties(
  getWorkRegistration.call.arguments[1],
  'trackly_get_apply_work descriptor',
);
assertBabelPropertyExpression(
  getWorkDescriptorProperties,
  'inputSchema',
  `z.object({
    executionId: z.number().int().min(1).optional(),
    snapshot: z.object({
      memberIds: z.array(z.number().int().min(1)).min(1).max(APPLY_EXECUTION_MAX_TARGET),
      profileKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
    }).strict().optional(),
  }).strict().superRefine((value, context) => {
    if (value.snapshot && !value.executionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'executionId is required for a snapshot' });
    }
  })`,
  'trackly_get_apply_work descriptor',
);
assertWrappedHandlerAssignedRequestEndpoint(
  getWorkRegistration,
  'work',
  'POST',
  '`/api/jobscout/apply/executions/${resolvedExecutionId}/plugin-work`',
  hostedPluginSourcePath,
  { guardExpression: '!snapshot' },
);
assertWrappedHandlerGuardedReturnAst(
  getWorkRegistration,
  '!snapshot',
  `return work?.lineageMismatch === true
    ? projectApplyWorkResponse(work, 'authorization_changed')
    : projectApplyWorkResponse(work, 'progress');`,
  hostedPluginSourcePath,
);
assertWrappedHandlerGuardedBlockAst(
  getWorkRegistration,
  '!snapshot',
  `{
    const work = await requestApi(
      'POST', \`/api/jobscout/apply/executions/\${resolvedExecutionId}/plugin-work\`, authToken, {},
    );
    return work?.lineageMismatch === true
      ? projectApplyWorkResponse(work, 'authorization_changed')
      : projectApplyWorkResponse(work, 'progress');
  }`,
  hostedPluginSourcePath,
);
assertWrappedHandlerAssignedRequestEndpoint(
  getWorkRegistration,
  'workSnapshot',
  'POST',
  '`/api/jobscout/apply/executions/${resolvedExecutionId}/snapshot`',
  hostedPluginSourcePath,
);
assertWrappedHandlerDirectStatementAst(
  getWorkRegistration,
  `return {
    ...projectApplyWorkSnapshot(workSnapshot, snapshot.profileKeys ?? []),
    kind: 'snapshot' as const,
  };`,
  hostedPluginSourcePath,
);

const progressRegistration = pluginToolRegistration('trackly_report_apply_progress');
const progress = pluginToolDefinition('trackly_report_apply_progress');
const progressDescriptorProperties = staticBabelObjectProperties(
  progressRegistration.call.arguments[1],
  'trackly_report_apply_progress descriptor',
);
assertBabelPropertyExpression(
  progressDescriptorProperties,
  'inputSchema',
  `z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('bind_surface'),
      batchId: z.number().int().min(1),
      memberId: z.number().int().min(1),
      runId: z.number().int().min(1),
      expectedMemberVersion: z.number().int().min(1),
      expectedInspectionEpoch: z.number().int().min(0),
      browserBindingHash: z.string().regex(SHA256),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
      adapterCode: z.string().regex(SAFE_CODE),
      bindingReason: z.enum(['initial_binding', 'recovery_binding']),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    }).strict(),
    z.object({
      operation: z.literal('record_dispositions'),
      executionId: z.number().int().min(1),
      expectedRevision: z.number().int().min(1),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
      dispositions: z.array(dispositionSchema).min(1).max(APPLY_EXECUTION_MAX_TARGET),
    }).strict(),
    z.object({
      operation: z.literal('resume_parked'),
      executionId: z.number().int().min(1),
      memberId: z.number().int().min(1),
      expectedRevision: z.number().int().min(1),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
      explicitUserResume: z.literal(true),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    }).strict(),
    z.object({
      operation: z.literal('record_observations'),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
      observations: z.array(observationSchema).min(1).max(20),
    }).strict(),
    z.object({
      operation: z.literal('advance'),
      executionId: z.number().int().min(1),
      expectedRevision: z.number().int().min(1),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    }).strict(),
  ])`,
  'trackly_report_apply_progress descriptor',
);
assertActiveVariableInitializerAst(
  hostedPluginSource,
  'dispositionSchema',
  `z.object({
    jobId: z.number().int().min(1),
    classification: z.enum(APPLY_EXECUTION_ACCESS_CLASSIFICATIONS),
    source: z.literal('live_probe'),
    batchId: z.number().int().min(1),
    memberId: z.number().int().min(1),
    runId: z.number().int().min(1),
    expectedMemberVersion: z.number().int().min(1),
    expectedInspectionEpoch: z.number().int().min(0),
    probeOnlyNoDraft: z.boolean().optional(),
    browserSurface: z.enum(APPLY_BROWSER_SURFACES),
  }).strict()`,
  hostedPluginSourcePath,
);
assertActiveVariableInitializerAst(
  hostedPluginSource,
  'observationSchema',
  `z.object({
    runId: z.number().int().min(1),
    batchId: z.number().int().min(1),
    memberId: z.number().int().min(1),
    inspectionEpoch: z.number().int().min(0),
    provider: z.string().regex(SAFE_CODE),
    fieldLabel: z.string().min(1).max(1000),
    observationType: z.string().regex(SAFE_CODE),
    resolutionCode: z.string().regex(SAFE_CODE).optional(),
    metadata: z.object({
      controlType: z.string().regex(SAFE_CODE).optional(),
      required: z.boolean().optional(),
      errorCode: z.string().regex(SAFE_CODE).optional(),
      committed: z.boolean(),
      scenarioCode: z.enum(APPLY_SCENARIO_CODES),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
      browserBindingHash: z.string().regex(SHA256).optional(),
      resumedAfterHandoff: z.boolean().optional(),
    }).strict(),
  }).strict()`,
  hostedPluginSourcePath,
);
assertDescriptorUsesTopLevelBinding(
  hostedPluginSource,
  progressRegistration,
  'outputSchema',
  'progressOutputSchema',
  hostedPluginSourcePath,
);
assertWrappedHandlerAssignedRequestEndpoint(
  progressRegistration,
  'response',
  'POST',
  "'/api/jobscout/apply/plugin-observations/bulk'",
  hostedPluginSourcePath,
  { guardExpression: "params.operation === 'record_observations'" },
);
assertWrappedHandlerAssignedRequestEndpoint(
  progressRegistration,
  'renewedWork',
  'POST',
  '`/api/jobscout/apply/executions/${executionId}/plugin-work`',
  hostedPluginSourcePath,
  { afterBindingName: 'response' },
);
assert.doesNotMatch(progress, /\bleaseToken\b/);
const progressOutputProperties = schemaObjectPropertyAsts(
  hostedPluginSource,
  'progressOutputSchema',
  hostedPluginSourcePath,
);
const progressOutputContract = {
  success: 'z.boolean()',
  operation: "z.enum(['bind_surface', 'resume_parked', 'record_dispositions', 'record_observations', 'advance'])",
  recordedCount: 'z.number().int().nonnegative()',
  batchId: 'nullableCountSchema.optional()',
  memberIds: 'z.array(z.number().int().min(1)).max(APPLY_EXECUTION_MAX_TARGET).optional()',
  binding: `z.object({
    memberId: z.number().int().min(1),
    runId: z.number().int().min(1),
    memberVersion: z.number().int().min(1),
    inspectionEpoch: z.number().int().nonnegative(),
    replay: z.boolean(),
  }).strict().optional()`,
  resumed: `z.object({
    executionId: z.number().int().min(1),
    memberId: z.number().int().min(1),
    revision: z.number().int().min(1),
    memberVersion: z.number().int().min(1),
    inspectionEpoch: z.number().int().nonnegative(),
    requiresFreshProbe: z.boolean(),
    mutable: z.boolean(),
    allowedOperations: z.array(z.enum(APPLY_EXECUTION_MEMBER_OPERATIONS)),
    replay: z.boolean(),
  }).strict().optional()`,
  nextAction: "z.enum(['work_ready', 'advance_or_refresh']).optional()",
  noSubmit: 'z.literal(true)',
};
assert.deepEqual(
  Object.keys(progressOutputProperties),
  Object.keys(progressOutputContract),
  'progressOutputSchema must publish only its required locked fields',
);
for (const [field, expression] of Object.entries(progressOutputContract)) {
  assertSchemaPropertyExpression(progressOutputProperties, field, expression, 'progressOutputSchema');
}
const resumeRegistration = pluginToolRegistration('trackly_prepare_resume_artifact');
const resumeDescriptorProperties = staticBabelObjectProperties(
  resumeRegistration.call.arguments[1],
  'trackly_prepare_resume_artifact descriptor',
);
assertBabelPropertyExpression(
  resumeDescriptorProperties,
  'inputSchema',
  'z.object({}).strict()',
  'trackly_prepare_resume_artifact descriptor',
);
assertDescriptorUsesTopLevelBinding(
  hostedPluginSource,
  resumeRegistration,
  'outputSchema',
  'resumeOutputSchema',
  hostedPluginSourcePath,
);
const resumeOutputProperties = schemaObjectPropertyAsts(
  hostedPluginSource,
  'resumeOutputSchema',
  hostedPluginSourcePath,
);
const resumeOutputContract = {
  view: "z.literal('resume')",
  success: 'z.boolean()',
  requiresLocalAgentOrManualUpload: 'z.literal(true)',
  automaticEmployerAttachment: 'z.literal(false)',
  noSubmit: 'z.literal(true)',
  nextAction: "z.literal('Choose or upload the resume manually, attach it to the visible Resume or CV field, then verify the visible filename before continuing.')",
  privacy: "z.literal('No resume bytes, file identifiers, filenames, download URLs, tokens, or local paths were returned or stored.')",
};
assertExactSchemaProperties(resumeOutputProperties, resumeOutputContract, 'resumeOutputSchema');
const resumeProjectionProperties = wrappedHandlerReturnedObjectProperties(
  resumeRegistration,
  hostedPluginSourcePath,
);
const resumeProjectionContract = {
  view: "'resume' as const",
  success: 'true',
  requiresLocalAgentOrManualUpload: 'true',
  automaticEmployerAttachment: 'false as const',
  noSubmit: 'true as const',
  nextAction: "'Choose or upload the resume manually, attach it to the visible Resume or CV field, then verify the visible filename before continuing.' as const",
  privacy: "'No resume bytes, file identifiers, filenames, download URLs, tokens, or local paths were returned or stored.' as const",
};
assert.deepEqual(
  Object.keys(resumeProjectionProperties),
  Object.keys(resumeProjectionContract),
  'trackly_prepare_resume_artifact handler must return only its locked manual-handoff fields',
);
for (const [field, expression] of Object.entries(resumeProjectionContract)) {
  assertBabelPropertyExpression(
    resumeProjectionProperties,
    field,
    expression,
    'trackly_prepare_resume_artifact output projection',
  );
}

const certifyRegistration = pluginToolRegistration('trackly_certify_review_ready');
const certifyInputProperties = namedProperties(objectSchemaProperties(
  registrationDescriptorPropertyAst(
    hostedPluginSource,
    certifyRegistration,
    'inputSchema',
    hostedPluginSourcePath,
  ),
  'trackly_certify_review_ready.inputSchema',
), 'trackly_certify_review_ready.inputSchema');
const certifyInputContract = {
  runId: 'z.number().int().min(1)',
  batchId: 'z.number().int().min(1)',
  memberId: 'z.number().int().min(1)',
  expectedMemberVersion: 'z.number().int().min(1)',
  inspectionEpoch: 'z.number().int().min(0)',
  answerSnapshotHash: 'z.string().regex(SHA256)',
  wordingFingerprint: 'z.string().regex(SHA256)',
  resumeDependency: "z.literal('not_applicable')",
  explicitUserTruthConfirmed: 'z.literal(true)',
  knownFieldsCommitted: 'z.literal(true)',
  idempotencyKey: 'z.string().min(16).max(170).regex(SAFE_IDEMPOTENCY_KEY)',
};
assert.deepEqual(
  Object.keys(certifyInputProperties),
  Object.keys(certifyInputContract),
  'trackly_certify_review_ready must publish only the locked truth-certification fields',
);
for (const [field, expression] of Object.entries(certifyInputContract)) {
  assertSchemaPropertyExpression(
    certifyInputProperties,
    field,
    expression,
    'trackly_certify_review_ready.inputSchema',
  );
}
assertWrappedHandlerAst(
  certifyRegistration,
  `async ({ runId, idempotencyKey, ...binding }) => {
    const response = await requestApi(
      'POST', \`/api/jobscout/apply/runs/\${runId}/plugin-review-ready\`, authToken,
      binding,
      { 'Idempotency-Key': idempotencyKey },
    );
    const outcomeRunId = readinessCount(response?.outcome?.runId);
    const status = safeReviewStatus(response?.outcome?.status);
    if (
      response?.success !== true
      || outcomeRunId !== runId
      || response?.outcome?.applied !== false
      || status !== 'awaiting_manual_submit'
    ) {
      throw new Error('Trackly did not persist the expected review-ready checkpoint');
    }
    return {
      view: 'review' as const,
      success: true,
      reviewReady: true,
      status,
      noSubmit: true as const,
    };
  }`,
  hostedPluginSourcePath,
);
assertPluginReviewReadyPersistenceSemantics(
  hostedTracklyApplySource,
  hostedApplicationProfileServiceSource,
  hostedTracklyApplyPath,
  hostedApplicationProfileServicePath,
  undefined,
  { serviceSourceSha256: pluginLock.publicExecutableContract.applicationProfileServiceSha256 },
);

const reconcileRegistration = pluginToolRegistration('trackly_reconcile_manual_submission');
const reconcileInputSchema = registrationDescriptorPropertyAst(
  hostedPluginSource,
  reconcileRegistration,
  'inputSchema',
  hostedPluginSourcePath,
);
const reconcileUnion = assertCall(
  reconcileInputSchema,
  'z.discriminatedUnion',
  'trackly_reconcile_manual_submission.inputSchema',
);
assert.equal(reconcileUnion.arguments[0]?.type, 'Literal');
assert.equal(reconcileUnion.arguments[0].value, 'confirmation');
assert.equal(reconcileUnion.arguments[1]?.type, 'ArrayExpression');
assert.equal(reconcileUnion.arguments[1].elements.length, 2);
const reconcileBranchContract = {
  user_confirmation: {
    runId: 'z.number().int().min(1)',
    confirmation: "z.literal('user_confirmation')",
    explicitUserConfirmed: 'z.literal(true)',
    batchId: 'z.number().int().min(1)',
    memberId: 'z.number().int().min(1)',
    expectedMemberVersion: 'z.number().int().min(1)',
    inspectionEpoch: 'z.number().int().min(1)',
    browserBindingHash: 'z.string().regex(SHA256)',
    evidenceFingerprint: 'z.string().regex(SHA256)',
    idempotencyKey: 'z.string().min(16).max(170).regex(SAFE_IDEMPOTENCY_KEY)',
  },
  success_page: {
    runId: 'z.number().int().min(1)',
    confirmation: "z.literal('success_page')",
    batchId: 'z.number().int().min(1)',
    memberId: 'z.number().int().min(1)',
    expectedMemberVersion: 'z.number().int().min(1)',
    inspectionEpoch: 'z.number().int().min(1)',
    browserBindingHash: 'z.string().regex(SHA256)',
    evidenceFingerprint: 'z.string().regex(SHA256)',
    idempotencyKey: 'z.string().min(16).max(170).regex(SAFE_IDEMPOTENCY_KEY)',
  },
};
const reconcileBranches = new Map(reconcileUnion.arguments[1].elements.map((branch, index) => {
  const properties = namedProperties(
    objectSchemaProperties(branch, `trackly_reconcile_manual_submission branch ${index + 1}`),
    `trackly_reconcile_manual_submission branch ${index + 1}`,
  );
  const confirmation = assertCall(
    properties.confirmation,
    'z.literal',
    `trackly_reconcile_manual_submission branch ${index + 1}.confirmation`,
  ).arguments[0]?.value;
  return [confirmation, properties];
}));
assert.deepEqual([...reconcileBranches.keys()], Object.keys(reconcileBranchContract));
for (const [confirmation, contract] of Object.entries(reconcileBranchContract)) {
  const properties = reconcileBranches.get(confirmation);
  assert.deepEqual(
    Object.keys(properties),
    Object.keys(contract),
    `trackly_reconcile_manual_submission ${confirmation} must publish only its locked evidence fields`,
  );
  for (const [field, expression] of Object.entries(contract)) {
    assertSchemaPropertyExpression(
      properties,
      field,
      expression,
      `trackly_reconcile_manual_submission.${confirmation}`,
    );
  }
}
assertWrappedHandlerAst(
  reconcileRegistration,
  `({ runId, idempotencyKey, ...body }) => requestApi(
    'POST',
    \`/api/jobscout/apply/runs/\${runId}/plugin-manual-submission\`,
    authToken,
    body,
    { 'Idempotency-Key': idempotencyKey },
  )`,
  hostedPluginSourcePath,
);
assertPluginManualSubmissionRouteSemantics(
  hostedTracklyApplySource,
  hostedTracklyApplyPath,
  `router.post('/jobscout/apply/runs/:id/plugin-manual-submission', requireAuth, requireApplyFeature, requireAccessibleExecutionFeature, async (req, res) => {
    try {
      assertPlainBodyKeys(req.body, [
        'batchId', 'memberId', 'expectedMemberVersion', 'inspectionEpoch',
        'browserBindingHash', 'evidenceFingerprint',
        'confirmation', 'explicitUserConfirmed',
      ], 'Plugin manual reconciliation accepts only current typed evidence and an explicit confirmation');
      const confirmation = String(req.body?.confirmation || '');
      if (!['success_page', 'user_confirmation'].includes(confirmation)) {
        throw new ProfileValidationError('confirmation must be success_page or user_confirmation');
      }
      if (confirmation === 'user_confirmation' && req.body?.explicitUserConfirmed !== true) {
        throw new ProfileValidationError('Explicit user confirmation is required');
      }
      if (confirmation === 'success_page' && req.body?.explicitUserConfirmed !== undefined) {
        throw new ProfileValidationError(
          'explicitUserConfirmed is accepted only for user_confirmation evidence',
        );
      }
      const result = await reconcilePluginManualSubmission(userId(req)!, {
        runId: positiveInteger(req.params.id, 'Apply run id'),
        batchId: positiveInteger(req.body?.batchId, 'batchId'),
        memberId: positiveInteger(req.body?.memberId, 'memberId'),
        expectedMemberVersion: positiveInteger(
          req.body?.expectedMemberVersion,
          'expectedMemberVersion',
        ),
        inspectionEpoch: positiveInteger(req.body?.inspectionEpoch, 'inspectionEpoch'),
        browserBindingHash: boundedMachineInput(
          req.body?.browserBindingHash,
          'browserBindingHash',
          64,
        ),
        evidenceFingerprint: boundedMachineInput(
          req.body?.evidenceFingerprint,
          'evidenceFingerprint',
          64,
        ),
        confirmation: confirmation as 'success_page' | 'user_confirmation',
        ...(confirmation === 'user_confirmation' ? { explicitUserConfirmed: true as const } : {}),
        idempotencyKey: applyIdempotencyKey(req),
      }, applyRunCallerContext(req));
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });`,
);

const stopRegistration = pluginToolRegistration('trackly_stop_apply');
const stopDescriptorProperties = staticBabelObjectProperties(
  stopRegistration.call.arguments[1],
  'trackly_stop_apply descriptor',
);
assertBabelPropertyExpression(
  stopDescriptorProperties,
  'inputSchema',
  `z.object({
    executionId: z.number().int().min(1),
    expectedRevision: z.number().int().min(1),
    reasonCode: z.enum(APPLY_EXECUTION_STOP_REASON_CODES).optional(),
    idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
  }).strict()`,
  'trackly_stop_apply descriptor',
);
assertWrappedHandlerAst(
  stopRegistration,
  `({ executionId, idempotencyKey, ...body }) => requestApi(
    'POST', \`/api/jobscout/apply/executions/\${executionId}/stop\`, authToken,
    body, { 'Idempotency-Key': idempotencyKey },
  )`,
  hostedPluginSourcePath,
);

console.log(
  `Trackly Apply MCP contracts match at ${local.contractVersion}; the ${hostedPluginTools.length}-tool public plugin facade matches at ${hostedPluginContract.contractVersion}.`,
);
}

module.exports = {
  CHECKED_IN_HOSTED_FIXTURE_SHA256,
  HOSTED_DEPLOYABLE_PATHS,
  HOSTED_GIT_MAX_BUFFER,
  activeNamedDefinitionAst,
  activeToolRegistrations,
  assertApplicationFieldByKeyReferenceSemantics,
  assertExactHostedSourceSha256,
  assertInternalSecretCompatibility,
  assertInstallProcessGuardsSemantics,
  assertPluginManualSubmissionRouteSemantics,
  assertPluginReviewReadyPersistenceSemantics,
  assertPluginRoutePrecedence,
  assertPluginUiContractSemantics,
  assertServerListenSemantics,
  assertCommonJsDestructuredRequire,
  assertActiveFunctionDirectStatementAst,
  assertActiveTopLevelStatementAst,
  assertActiveFunctionDefinitionAst,
  assertActiveFunctionAstSha256,
  assertLivePluginRouterMount,
  assertImmutablePluginScopeFreeMethods,
  assertImmutablePluginToolScopesSemantics,
  assertMcpScopeHelperSemantics,
  assertMergeCommitPreservesPaths,
  assertHostedCommitTimestamps,
  assertHostedStartApplyRunBatchBindingGuard,
  assertBabelPropertyExpression,
  assertExactSchemaProperties,
  assertExportedFactoryUsedByPluginRouter,
  assertSchemaPropertyExpression,
  assertWrappedHandlerParsesWithSchema,
  assertWrappedHandlerAssignedRequestEndpoint,
  assertWrappedHandlerGuardedBlockAst,
  assertWrappedHandlerAst,
  assertWrappedHandlerDirectStatementAst,
  assertWrappedHandlerGuardedReturnAst,
  assertWrappedHandlerStatementSequenceAst,
  assertWrappedHandlerRequestEndpoint,
  canonicalSchemaAst,
  classifyFreeIdentifiers,
  directToolRegistrationsInExportedFunction,
  directHostedToolRegistrationsInNamedFactory,
  directToolRegistrationsInNamedFactory,
  directToolRegistrationsInNamedParameterFunction,
  exactSchemaDefinition,
  gitOutput,
  parseSchemaExpression,
  referencedConstantIdentifiers,
  referencedFreeIdentifiers,
  registeredInputSchemaName,
  registrationDescriptorPropertyAst,
  registrationArgumentSources,
  registrationInputSchemaAst,
  schemaObjectPropertyAsts,
  schemaDefinition,
  sha256ExactBytes,
  staticStringArrayMap,
  staticApplicationFieldSensitivityMap,
  typescriptConstArrayValues,
  verifyHostedContract,
  verifyCheckedInHostedContractFixture,
  verifyCoordinatedBackendCore,
  verifyHostedSnapshotGitProvenance,
  wrappedHandlerReturnProperties,
  wrappedHandlerReturnedObjectProperties,
};

if (require.main === module) {
  verifyHostedContract();
}
