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

function directToolRegistrationsInNamedFactory(source, expectedFunction, expectedCallee, sourcePath) {
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
  assert.ok(
    factoryStatements.slice(lastRegistrationIndex + 1, -1).every((statement) => {
      const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
      const callee = call?.type === 'CallExpression' ? call.callee : null;
      return callee?.type === 'MemberExpression'
        && !callee.computed
        && callee.object?.type === 'Identifier'
        && callee.object.name === expectedServerBinding
        && callee.property?.type === 'Identifier'
        && allowedTailRegistrationMethods.has(callee.property.name);
    }),
    `${expectedFunction} in ${sourcePath} must reach its final server return through direct registration calls on the exact server, without a branch, return, throw, or other executable statement after ${expectedCallee} registration`,
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
) {
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
    2,
    `${expectedFunction} in ${sourcePath} must contain only the verified server and registration-helper declarations before registering tools`,
  );
  assert.ok(
    preRegistrationStatements.every((statement) => (
      statement.type === 'VariableDeclaration' && statement.declarations.length === 1
    )),
    `${expectedFunction} in ${sourcePath} must contain only single-binding declarations before registering tools`,
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
    if (node.type === 'MemberExpression'
      && node.object?.type === 'Identifier'
      && node.object.name === 'server') {
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
  return registrations;
}

function assertExportedFactoryUsedByPluginRouter(source, expectedFactory, sourcePath) {
  const ast = parseFullSource(source, sourcePath);
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
      'requirePluginEnabled',
      'validateOrigin',
      'ipLimiter',
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
    'ipLimiter',
    `rateLimit({
      windowMs: 60_000,
      max: PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many trackly plugin requests. Try again later.' },
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

function registrationArgumentSources(source, registration, sourcePath) {
  assert.ok(
    registration?.call?.arguments?.length >= 3,
    `${registration?.name || 'Tool'} registration in ${sourcePath} must contain name, descriptor, and handler`,
  );
  return registration.call.arguments.map((argument) => source.slice(argument.start, argument.end));
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

function assertActiveFunctionDirectStatementAst(source, name, expectedStatement, sourcePath) {
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
}

function assertActiveVariableInitializerAst(source, name, expectedExpression, sourcePath) {
  assert.deepEqual(
    canonicalSchemaAst(activeVariableDeclarator(source, name, sourcePath).declarator.init),
    canonicalSchemaAst(babelParser.parseExpression(expectedExpression, { plugins: ['typescript'] })),
    `${name} in ${sourcePath} must preserve its locked executable definition`,
  );
}

function assertImportBinding(source, importedName, localName, moduleName, sourcePath) {
  const matches = parseFullSource(source, sourcePath).program.body.filter((statement) => (
    statement.type === 'ImportDeclaration'
    && statement.source.value === moduleName
    && statement.specifiers.some((specifier) => {
      if (importedName === 'default') {
        return specifier.type === 'ImportDefaultSpecifier' && specifier.local?.name === localName;
      }
      return specifier.type === 'ImportSpecifier'
        && specifier.imported?.name === importedName
        && specifier.local?.name === localName;
    })
  ));
  assert.equal(
    matches.length,
    1,
    `${sourcePath} must import ${importedName} as ${localName} exactly once from ${moduleName}`,
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
const hostedPluginRouterPath = path.join(backendRoot, 'src', 'mcp', 'plugin-router.ts');
const hostedPluginScopesPath = path.join(backendRoot, 'src', 'mcp', 'plugin-scopes.ts');
const hostedJobBriefServicePath = path.join(backendRoot, 'src', 'services', 'job-brief.ts');
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
const hostedPluginRouterSource = fs.readFileSync(hostedPluginRouterPath, 'utf8');
const hostedPluginScopesSource = fs.readFileSync(hostedPluginScopesPath, 'utf8');
const hostedJobBriefServiceSource = fs.readFileSync(hostedJobBriefServicePath, 'utf8');
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
assertExportedFactoryUsedByPluginRouter(
  hostedPluginRouterSource,
  'createTracklyPluginMcpServer',
  hostedPluginRouterPath,
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
const executablePluginRegistrations = directToolRegistrationsInExportedFunction(
  hostedPluginSource,
  'createTracklyPluginMcpServer',
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
assert.equal(
  sha256ExactBytes(hostedPluginScopesSource),
  pluginLock.publicExecutableContract.pluginScopesSha256,
  'Hosted plugin conditional scope enforcement drifted from the packaged whole-source digest lock',
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
const classifiedSchemaDependencies = {};
for (const [side, sourceText, sourcePath, schemaAsts] of [
  ['local', localApplySource, localApplySourcePath, localApplySchemaAsts],
  ['hosted', hostedApplySource, hostedApplySourcePath, hostedApplySchemaAsts],
]) {
  const dependencies = [...new Set(
    sharedParseSchemaNames.flatMap((schemaName) => referencedFreeIdentifiers(schemaAsts[schemaName])),
  )].sort();
  classifiedSchemaDependencies[side] = {
    sourceText,
    sourcePath,
    dependencies: classifyFreeIdentifiers(dependencies, {
      runtimeGlobal: ['undefined', 'z'],
      sharedDefinition: sharedParseSchemaNames,
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
    hostedPublishedAndParse: 'truthCertificationSchema',
  },
  trackly_start_apply_run: {
    localPublished: 'startApplyRunInputSchema',
    localParse: 'startApplyRunSchema',
    hostedPublishedAndParse: 'startApplyRunSchema',
  },
};
for (const [toolName, mapping] of Object.entries(publishedSchemaCompatibility)) {
  for (const [side, sourceText, sourcePath, schemaName] of [
    ['local', localApplySource, localApplySourcePath, mapping.localPublished],
    ['hosted', hostedApplySource, hostedApplySourcePath, mapping.hostedPublishedAndParse],
  ]) {
    const registrations = (side === 'local'
      ? activeToolRegistrations(sourceText, 'server.registerTool', sourcePath)
      : directToolRegistrationsInNamedFactory(
        sourceText,
        'createTracklyMcpServer',
        'server.registerTool',
        sourcePath,
      ))
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
    if (side === 'local') {
      assertWrappedHandlerParsesWithSchema(registrations[0], mapping.localParse, sourcePath);
    }
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
for (const statement of [
  `const fieldLabels = new Map(
    (Array.isArray(schema?.fields) ? schema.fields : []).flatMap((field: unknown) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return [];
      const value = field as Record<string, unknown>;
      return typeof value.key === 'string' && typeof value.label === 'string'
        ? [[value.key, value.label] as const]
        : [];
    }),
  );`,
  `for (const field of Array.isArray(schema?.educationFields) ? schema.educationFields : []) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
    const value = field as Record<string, unknown>;
    if (typeof value.key === 'string' && typeof value.label === 'string') {
      fieldLabels.set(\`education.\${value.key}\`, value.label);
    }
  }`,
  `fieldLabels.set('documents.default_resume', 'Default resume');`,
  `const missingRequired = Array.isArray(profile?.completeness?.missingKeys)
    ? profile.completeness.missingKeys.flatMap((key: unknown) => (
      typeof key === 'string' && key.length <= 200 && CANONICAL_PROFILE_KEY.test(key)
        ? [{ key, label: fieldLabels.get(key) ?? 'Required profile field' }]
        : []
    )).slice(0, 100)
    : [];`,
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
    return {
      view: 'review' as const,
      success: response?.success !== false,
      reviewReady: response?.success !== false,
      status: safeReviewStatus(
        response?.outcome?.status ?? response?.status ?? response?.run?.status,
      ),
      noSubmit: true as const,
    };
  }`,
  hostedPluginSourcePath,
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
  activeNamedDefinitionAst,
  activeToolRegistrations,
  assertActiveFunctionDirectStatementAst,
  assertActiveFunctionDefinitionAst,
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
  directToolRegistrationsInNamedFactory,
  exactSchemaDefinition,
  parseSchemaExpression,
  referencedConstantIdentifiers,
  referencedFreeIdentifiers,
  registeredInputSchemaName,
  registrationDescriptorPropertyAst,
  registrationArgumentSources,
  schemaObjectPropertyAsts,
  schemaDefinition,
  sha256ExactBytes,
  staticStringArrayMap,
  typescriptConstArrayValues,
  verifyHostedContract,
  wrappedHandlerReturnProperties,
  wrappedHandlerReturnedObjectProperties,
};

if (require.main === module) {
  verifyHostedContract();
}
