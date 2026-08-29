'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS = 120_000;

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

const sha256ExactBytes = (value) => crypto.createHash('sha256').update(value).digest('hex');

const redactSubprocessOutput = (value) => String(value || '')
  .replace(/\b(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
  .replace(/(_authToken\s*=\s*)[^\s]+/gi, '$1[redacted]')
  .replace(/\b(((?:node|npm)(?:_[a-z]+)*_token|(?:auth|access)_?token)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]')
  .replace(/((?:^|[/:])_(?:auth|password)\s*=\s*)[^\s]+/gim, '$1[redacted]')
  .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[redacted]')
  .replace(/([?&](?:auth|access)?_?token=)[^&#\s]+/gi, '$1[redacted]');

const assertExactGitCheckout = (root, expectedCommit) => {
  const runGit = (args, label) => {
    const result = childProcess.spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Unable to ${label} for reviewed backend checkout: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  assert.equal(
    runGit(['rev-parse', 'HEAD'], 'resolve HEAD'),
    expectedCommit,
    'The reviewed backend checkout must be the exact deployed merge commit',
  );
  assert.equal(runGit(['rev-parse', '--show-object-format'], 'resolve object format'), 'sha1', 'The reviewed backend checkout must use the audited Git object format');
  const tracked = childProcess.spawnSync('git', ['-C', root, 'ls-files', '-s', '-z'], {
    encoding: 'buffer',
    timeout: REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS,
  });
  assert.ifError(tracked.error);
  assert.equal(tracked.status, 0, `Unable to enumerate reviewed backend files: ${tracked.stderr.toString('utf8').trim()}`);
  for (const record of tracked.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const metadata = record.slice(0, separator).split(' ');
    const relativePath = record.slice(separator + 1);
    assert.equal(metadata[2], '0', `The reviewed backend checkout must not contain staged conflict entries: ${relativePath}`);
    assert.ok(['100644', '100755', '120000'].includes(metadata[0]), `Unsupported reviewed backend file mode ${metadata[0]}: ${relativePath}`);
    const absolutePath = path.join(root, relativePath);
    const bytes = metadata[0] === '120000'
      ? fs.readlinkSync(absolutePath, { encoding: 'buffer' })
      : fs.readFileSync(absolutePath);
    const actualBlob = crypto.createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    assert.equal(actualBlob, metadata[1], `The reviewed backend tracked bytes must match the pinned commit: ${relativePath}`);
  }
  assert.equal(
    runGit(['status', '--porcelain=v1', '--untracked-files=all'], 'inspect worktree state'),
    '',
    'The reviewed backend checkout must have no tracked modifications or untracked source',
  );
  const ignoredOutsideDependencies = runGit(
    ['status', '--porcelain=v1', '--ignored=matching', '--untracked-files=all'],
    'inspect ignored worktree state',
  ).split('\n').filter(Boolean).filter((line) => !/^!! (?:node_modules\/?|\.husky\/_\/?)$/.test(line));
  assert.deepEqual(
    ignoredOutsideDependencies,
    [],
    'The reviewed backend checkout must have no ignored files outside dependency and hook install artifacts',
  );
};

const boundNames = (pattern, names = []) => {
  if (!pattern || typeof pattern !== 'object') return names;
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'TSParameterProperty') boundNames(pattern.parameter, names);
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
  assert.equal(imports[0].importKind, 'value', `${sourcePath} must provide runtime helper bindings`);
  const reviewedSpecifiers = new Set(imports[0].specifiers);
  const names = imports[0].specifiers.map((specifier) => {
    assert.equal(specifier.type, 'ImportSpecifier', `${sourcePath} must use named imports only`);
    assert.equal(specifier.importKind, 'value', `${sourcePath} helpers must be runtime value imports`);
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
    else if (['ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'TSDeclareMethod'].includes(node.type)) {
      rejectProtected(node.params, 'method parameter shadow');
    }
    else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') rejectProtected([node.id], 'class shadow');
    else if (node.type === 'CatchClause') rejectProtected([node.param], 'catch binding shadow');
    else if (node.type === 'AssignmentExpression') rejectProtected([node.left], 'assignment to imported binding');
    else if (node.type === 'UpdateExpression') rejectProtected([node.argument], 'update of imported binding');
    else if (node.type === 'TSImportEqualsDeclaration') rejectProtected([node.id], 'competing TypeScript import binding');
  });
};

module.exports = {
  REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS,
  assertExactGitCheckout,
  assertExactUnshadowedNamedImports,
  astSha256,
  canonicalAst,
  redactSubprocessOutput,
  sha256ExactBytes,
};
