'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const OMITTED_AST_KEYS = new Set([
  'loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra',
]);

const canonicalAst = (value) => {
  if (Array.isArray(value)) return value.map(canonicalAst);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (OMITTED_AST_KEYS.has(key)) continue;
    result[key] = canonicalAst(value[key]);
  }
  return result;
};

const astSha256 = (node) => crypto
  .createHash('sha256')
  .update(JSON.stringify(canonicalAst(node)))
  .digest('hex');

const boundNames = (pattern, names = []) => {
  if (!pattern || typeof pattern !== 'object') return names;
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'RestElement') boundNames(pattern.argument, names);
  else if (pattern.type === 'AssignmentPattern') boundNames(pattern.left, names);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((element) => boundNames(element, names));
  else if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((property) => boundNames(
      property.type === 'RestElement' ? property.argument : property.value,
      names,
    ));
  }
  return names;
};

const walkBindings = (node, visitor) => {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (OMITTED_AST_KEYS.has(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walkBindings(child, visitor));
    else if (value && typeof value === 'object') walkBindings(value, visitor);
  }
};

const assertExactUnshadowedNamedImports = (root, sourcePath, expectedNames) => {
  const imports = root.program.body.filter((node) => node.type === 'ImportDeclaration'
    && node.source?.value === sourcePath);
  assert.equal(imports.length, 1, `The active ${sourcePath} import must be unique`);
  const reviewedSpecifiers = new Set(imports[0].specifiers);
  const names = imports[0].specifiers.map((specifier) => {
    assert.equal(specifier.type, 'ImportSpecifier', `${sourcePath} must use named imports only`);
    assert.equal(specifier.local?.name, specifier.imported?.name, `${sourcePath} imports must not be aliased`);
    return specifier.imported.name;
  }).sort();
  assert.deepEqual(names, [...expectedNames].sort(), `${sourcePath} must preserve its reviewed helper bindings`);

  const protectedNames = new Set(expectedNames);
  const rejectProtected = (patterns, context) => {
    for (const pattern of patterns) {
      for (const name of boundNames(pattern)) {
        assert.ok(!protectedNames.has(name), `${sourcePath} helper ${name} must resolve only to its reviewed import; rejected ${context}`);
      }
    }
  };
  walkBindings(root.program, (node) => {
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      if (!reviewedSpecifiers.has(node)) rejectProtected([node.local], 'competing import binding');
    } else if (node.type === 'VariableDeclarator') rejectProtected([node.id], 'variable shadow');
    else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
      rejectProtected([node.id, ...node.params], 'function binding or parameter shadow');
    } else if (node.type === 'ArrowFunctionExpression') rejectProtected(node.params, 'function parameter shadow');
    else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') rejectProtected([node.id], 'class shadow');
    else if (node.type === 'CatchClause') rejectProtected([node.param], 'catch binding shadow');
    else if (node.type === 'AssignmentExpression') rejectProtected([node.left], 'assignment to imported binding');
    else if (node.type === 'UpdateExpression') rejectProtected([node.argument], 'update of imported binding');
    else if (node.type === 'TSImportEqualsDeclaration') rejectProtected([node.id], 'competing TypeScript import binding');
  });
};

module.exports = { assertExactUnshadowedNamedImports, astSha256, canonicalAst };
