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
  assert.ok(
    factory.body.body.slice(0, firstRegistrationIndex)
      .every((statement) => statement.type === 'VariableDeclaration'),
    `${expectedFunction} in ${sourcePath} must not branch, return, or throw before registering tools`,
  );
  assert.deepEqual(
    registrationStatementIndexes,
    Array.from({ length: registrations.length }, (_, index) => firstRegistrationIndex + index),
    `${expectedFunction} in ${sourcePath} must register tools in one unconditional contiguous block`,
  );

  const nestedRegistrations = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === 'CallExpression' && babelCalleeName(node.callee) === expectedCallee) {
      nestedRegistrations.push(node);
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
  const postRoutes = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      node.type === 'CallExpression'
      && babelCalleeName(node.callee) === 'router.post'
      && node.arguments[0]?.type === 'StringLiteral'
      && node.arguments[0].value === '/'
    ) {
      postRoutes.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(ast);
  assert.equal(postRoutes.length, 1, `${sourcePath} must define exactly one POST / plugin route`);
  const handler = postRoutes[0].arguments.at(-1);
  assert.ok(
    handler?.type === 'ArrowFunctionExpression' || handler?.type === 'FunctionExpression',
    `POST / in ${sourcePath} must end with a function handler`,
  );
  assert.equal(handler.body?.type, 'BlockStatement', `POST / handler in ${sourcePath} must use a block body`);
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

function wrappedHandlerReturnProperties(registration, sourcePath) {
  const wrapper = registration.call.arguments[2];
  assert.equal(wrapper?.type, 'CallExpression', `${registration.name} handler in ${sourcePath} must use a wrapper call`);
  const handler = wrapper.arguments[0];
  assert.ok(
    handler?.type === 'ArrowFunctionExpression' || handler?.type === 'FunctionExpression',
    `${registration.name} wrapper in ${sourcePath} must receive a function handler`,
  );
  assert.equal(handler.body?.type, 'BlockStatement', `${registration.name} handler in ${sourcePath} must use a block body`);
  const returns = handler.body.body.filter((statement) => statement.type === 'ReturnStatement');
  assert.equal(returns.length, 1, `${registration.name} handler in ${sourcePath} must directly return one projection`);
  return staticBabelObjectProperties(returns[0].argument, `${registration.name} output projection`);
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

function exactSchemaDefinition(source, name, sourcePath) {
  const bounds = schemaDefinitionBounds(source, name, sourcePath);
  return source.slice(bounds.declarationStart, bounds.declarationEnd);
}

const AST_METADATA_FIELDS = new Set(['start', 'end', 'loc', 'range', 'raw', 'extra']);

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
  const matches = [];
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === name) {
      assert.ok(node.init, `${name} in ${sourcePath} must have an initializer`);
      matches.push(node.init);
    } else if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
      matches.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue;
      visit(child);
    }
  }
  visit(parseFullSource(source, sourcePath));
  assert.equal(
    matches.length,
    1,
    `${name} must have exactly one active variable or function definition in ${sourcePath}`,
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
    assert.equal(
      calleeName(annotations.callee),
      'mutationAnnotations',
      `${toolName} has a write scope and must publish mutationAnnotations(...)`,
    );
  } else {
    assert.deepEqual(
      canonicalSchemaAst(annotations),
      canonicalSchemaAst(parseExpectedExpression('readOnlyAnnotations', `${toolName}.annotations`)),
      `${toolName} has read-only scopes and must publish readOnlyAnnotations`,
    );
  }
}
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
const jobBriefCompanySignalProperties = staticBabelObjectProperties(
  jobBriefOutputProperties.companySignal,
  'trackly_get_job_brief companySignal projection',
);
assert.deepEqual(
  Object.keys(jobBriefCompanySignalProperties),
  ['openRoleCount', 'pmRoleCount', 'postedLast7d', 'latestPostedAt'],
  'trackly_get_job_brief companySignal must remain a bounded aggregate-only projection',
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
assertSchemaPropertyExpression(
  readinessProperties,
  'missingRequired',
  'z.array(profileFieldReferenceSchema).max(100)',
  'readinessOutputSchema',
);
assertSchemaPropertyExpression(
  readinessProperties,
  'availableFields',
  'z.array(profileFieldReferenceSchema).max(100)',
  'readinessOutputSchema',
);
assertSchemaPropertyExpression(
  profileFieldReferenceProperties,
  'key',
  'z.string().min(1).max(200)',
  'profileFieldReferenceSchema',
);
assertSchemaPropertyExpression(
  profileFieldReferenceProperties,
  'label',
  'z.string().min(1).max(1000)',
  'profileFieldReferenceSchema',
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
  nextAction: "z.enum(['work_ready', 'use_active_target', 'advance_or_refresh', 'restart_after_reauthorization'])",
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
const startOrResume = pluginToolDefinition('trackly_start_or_resume_apply');
for (const marker of ['browserSurface', 'plugin-prepare']) {
  assert.match(startOrResume, new RegExp(marker.replaceAll('/', '\\/')));
}
assert.match(startOrResume, /browserSurface: z\.enum\(APPLY_BROWSER_SURFACES\)/);
assert.doesNotMatch(startOrResume, /\bleaseToken\b|\/claim|\/api\/jobscout\/apply\/runs/);

const getWork = pluginToolDefinition('trackly_get_apply_work');
assert.match(getWork, /plugin-work/);
assert.match(getWork, /memberIds: z\.array\(z\.number\(\)\.int\(\)\.min\(1\)\)\.min\(1\)/);
assert.match(getWork, /profileKeys: z\.array\(z\.string\(\)\.min\(1\)\.max\(200\)\)\.max\(100\)\.optional\(\)/);

const progress = pluginToolDefinition('trackly_report_apply_progress');
assert.match(progress, /plugin-observations\/bulk/);
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
assert.match(progress, /plugin-work/);

const certify = pluginToolDefinition('trackly_certify_review_ready');
const certifyInputProperties = namedProperties(objectSchemaProperties(
  registrationDescriptorPropertyAst(
    hostedPluginSource,
    pluginToolRegistration('trackly_certify_review_ready'),
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
assert.match(certify, /plugin-review-ready/);

const reconcile = pluginToolDefinition('trackly_reconcile_manual_submission');
const reconcileInputSchema = registrationDescriptorPropertyAst(
  hostedPluginSource,
  pluginToolRegistration('trackly_reconcile_manual_submission'),
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
assert.match(reconcile, /plugin-manual-submission/);

console.log(
  `Trackly Apply MCP contracts match at ${local.contractVersion}; the ${hostedPluginTools.length}-tool public plugin facade matches at ${hostedPluginContract.contractVersion}.`,
);
}

module.exports = {
  activeNamedDefinitionAst,
  activeToolRegistrations,
  assertExportedFactoryUsedByPluginRouter,
  assertSchemaPropertyExpression,
  canonicalSchemaAst,
  classifyFreeIdentifiers,
  directToolRegistrationsInExportedFunction,
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
};

if (require.main === module) {
  verifyHostedContract();
}
