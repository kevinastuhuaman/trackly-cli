#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const babelParser = require('@babel/parser');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS,
  assertExactGitCheckout,
  assertExactUnshadowedNamedImports,
  astSha256,
  sha256ExactBytes,
} = require('./review-auth-contract-ast.js');

const backendDir = process.env.TRACKLY_BACKEND_DIR;
if (!backendDir) {
  if (process.argv.includes('--allow-missing-backend')) {
    console.log('Dedicated MCP reviewer-auth source check explicitly skipped without TRACKLY_BACKEND_DIR; standalone fixture validation continues.');
    process.exit(0);
  }
  throw new Error('TRACKLY_BACKEND_DIR is required for the dedicated reviewer-auth contract check');
}

const backendRoot = path.resolve(backendDir);
const EXPECTED_DEPLOYED_BACKEND_COMMIT = '2306d3907409b842f963ac2786c5378c15c7b650';
assertExactGitCheckout(backendRoot, EXPECTED_DEPLOYED_BACKEND_COMMIT);
const read = (relativePath) => {
  const sourcePath = path.join(backendRoot, relativePath);
  assert.ok(fs.existsSync(sourcePath), `Missing backend reviewer-auth source: ${sourcePath}`);
  return fs.readFileSync(sourcePath, 'utf8');
};

const auth = read('src/routes/auth.ts');
const provider = read('src/mcp/oauth-provider.ts');
const identity = read('src/services/mcp-review-identity.ts');
const authTests = read('src/routes/__tests__/mcp-consent.test.ts');
const providerTests = read('src/mcp/__tests__/mcp-oauth-provider.test.ts');
const migrationRoute = read('src/routes/run-migration-api.ts');
const reviewerFixture = read('migrations/503_seed_openai_plugin_review_fixture.sql');

const stripPostgresComments = (source) => {
  let output = '';
  let index = 0;
  let state = 'normal';
  let blockDepth = 0;
  let dollarDelimiter = null;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') {
        output += current;
        state = 'normal';
      }
      index += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockDepth += 1;
        index += 2;
      } else if (current === '*' && next === '/') {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) state = 'normal';
      } else {
        if (current === '\n' || current === '\r') output += current;
        index += 1;
      }
      continue;
    }
    if (state === 'dollar-quote') {
      if (source.startsWith(dollarDelimiter, index)) {
        output += dollarDelimiter;
        index += dollarDelimiter.length;
        state = 'normal';
      } else {
        output += current;
        index += 1;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      const quote = state === 'single-quote' ? "'" : '"';
      output += current;
      if (current === '\\' && next !== undefined) {
        output += next;
        index += 2;
      } else if (current === quote && next === quote) {
        output += next;
        index += 2;
      } else {
        index += 1;
        if (current === quote) state = 'normal';
      }
      continue;
    }
    if (current === '-' && next === '-') {
      state = 'line-comment';
      index += 2;
    } else if (current === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      index += 2;
    } else if (current === "'") {
      output += current;
      state = 'single-quote';
      index += 1;
    } else if (current === '"') {
      output += current;
      state = 'double-quote';
      index += 1;
    } else if (current === '$') {
      const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarDelimiter = match[0];
        output += dollarDelimiter;
        index += dollarDelimiter.length;
        state = 'dollar-quote';
      } else {
        output += current;
        index += 1;
      }
    } else {
      output += current;
      index += 1;
    }
  }
  assert.notEqual(state, 'block-comment', 'Reviewer fixture contains an unterminated SQL block comment');
  assert.notEqual(state, 'single-quote', 'Reviewer fixture contains an unterminated SQL string');
  assert.notEqual(state, 'double-quote', 'Reviewer fixture contains an unterminated SQL identifier');
  assert.notEqual(state, 'dollar-quote', 'Reviewer fixture contains an unterminated dollar-quoted SQL string');
  return output;
};

const activeReviewerFixture = stripPostgresComments(reviewerFixture);
assert.equal(
  sha256ExactBytes(reviewerFixture),
  '73d71283e6e5e59b8a93d4d8ccd245a96578b79f586c81a35b6f654be4ea611f',
  'Migration 503 must preserve the complete reviewed synthetic-account seeding transaction',
);
assert.match(stripPostgresComments("SELECT '--', '/*'; -- removed\nSELECT $$-- kept /* kept */$$; /* outer /* nested */ done */ SELECT 1;"), /'--', '\/\*'; \nSELECT \$\$-- kept \/\* kept \*\/\$\$;\s+SELECT 1;/);

const parseTypescript = (source, sourcePath) => {
  try {
    return babelParser.parse(source, { sourceType: 'module', plugins: ['typescript'] });
  } catch (error) {
    throw new Error(`Unable to parse ${sourcePath}: ${error.message}`);
  }
};

const walk = (node, visitor, ancestors = []) => {
  if (!node || typeof node !== 'object') return;
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visitor, nextAncestors));
    else if (value && typeof value === 'object') walk(value, visitor, nextAncestors);
  }
};

const calleeName = (callee) => {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type !== 'MemberExpression' || callee.computed) return null;
  const object = calleeName(callee.object);
  return object && callee.property?.type === 'Identifier' ? `${object}.${callee.property.name}` : null;
};

const callsBelow = (root, name) => {
  const calls = [];
  walk(root, (node) => {
    if (node.type === 'CallExpression' && calleeName(node.callee) === name) calls.push(node);
  });
  return calls;
};

const namedFunctions = (root, name) => {
  const functions = [];
  walk(root, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) functions.push(node);
  });
  return functions;
};

const namedMethods = (root, name) => {
  const methods = [];
  walk(root, (node) => {
    if (node.type === 'ClassMethod' && !node.computed && node.key?.name === name) methods.push(node);
  });
  return methods;
};

const compactSource = (source, node) => source.slice(node.start, node.end).replace(/\s+/g, ' ').trim();

const exactCallArguments = (source, root, name, expectedArguments) => {
  const calls = callsBelow(root, name);
  assert.equal(calls.length, 1, `The active ${name} call must be unique in its security boundary`);
  assert.deepEqual(
    calls[0].arguments.map((argument) => compactSource(source, argument)),
    expectedArguments,
    `The active ${name} call must preserve its reviewed argument binding`,
  );
};

const routeCall = (root, routePath, method = 'post') => {
  const registration = `router.${method}`;
  const matches = callsBelow(root, registration).filter((call) => call.arguments[0]?.value === routePath);
  assert.equal(matches.length, 1, `${routePath} must have exactly one active ${registration} registration`);
  return matches[0];
};

const activeTestTitles = (root) => {
  const titles = new Set();
  walk(root, (node, ancestors) => {
    if (node.type !== 'CallExpression' || !['it', 'test'].includes(calleeName(node.callee))) return;
    if (ancestors.some((ancestor) => ancestor.type === 'CallExpression' && calleeName(ancestor.callee)?.endsWith('.skip'))) return;
    const title = node.arguments[0];
    if (title?.type === 'StringLiteral') titles.add(title.value);
  });
  return titles;
};

const authAst = parseTypescript(auth, 'src/routes/auth.ts');
const providerAst = parseTypescript(provider, 'src/mcp/oauth-provider.ts');
const identityAst = parseTypescript(identity, 'src/services/mcp-review-identity.ts');
const migrationRouteAst = parseTypescript(migrationRoute, 'src/routes/run-migration-api.ts');
const consentTests = activeTestTitles(parseTypescript(authTests, 'src/routes/__tests__/mcp-consent.test.ts'));
const oauthTests = activeTestTitles(parseTypescript(providerTests, 'src/mcp/__tests__/mcp-oauth-provider.test.ts'));

const bindingFunctions = namedFunctions(identityAst, 'configuredMcpReviewBinding');
const credentialFunctions = namedFunctions(identityAst, 'authenticateMcpReviewCredentials');
const identityGuardFunctions = namedFunctions(identityAst, 'isMcpReviewIdentityAllowed');
assert.equal(bindingFunctions.length, 1, 'The active MCP binding helper must be unique');
assert.equal(credentialFunctions.length, 1, 'The active MCP credential helper must be unique');
assert.equal(identityGuardFunctions.length, 1, 'The active MCP identity guard must be unique');
assert.equal(
  astSha256(identityAst.program),
  '0f109314959fca6fc229f99ce18cbb71582c468c60e907747fb058f61755a4e3',
  'The complete MCP reviewer-identity module AST must preserve environment-only credentials and fail-closed identity binding',
);
assertExactUnshadowedNamedImports(authAst, '../services/mcp-review-identity.js', [
  'authenticateMcpReviewCredentials',
  'configuredMcpReviewBinding',
  'isMcpReviewIdentityAllowed',
]);
assertExactUnshadowedNamedImports(providerAst, '../services/mcp-review-identity.js', [
  'isConfiguredMcpReviewUserId',
  'isMcpReviewIdentityAllowed',
]);
const activeBindingTokens = new Set();
walk(bindingFunctions[0], (node) => {
  if (node.type === 'Identifier') activeBindingTokens.add(node.name);
  if (node.type === 'StringLiteral') activeBindingTokens.add(node.value);
});
for (const envName of [
  'MCP_REVIEW_LOGIN_EMAIL',
  'MCP_REVIEW_LOGIN_PASSWORD',
  'MCP_REVIEW_LOGIN_USER_ID',
  'MCP_REVIEW_LOGIN_AUTH_EPOCH',
]) assert.ok(activeBindingTokens.has(envName), `${envName} must be read by the active dedicated binding helper`);
const activeBindingMembers = new Set();
walk(bindingFunctions[0], (node) => {
  if (node.type === 'MemberExpression') activeBindingMembers.add(calleeName(node));
});
assert.ok(activeBindingMembers.has('process.env.MCP_REVIEW_LOGIN_EMAIL'), 'The active binding helper must read MCP_REVIEW_LOGIN_EMAIL');
assert.ok(activeBindingMembers.has('process.env.MCP_REVIEW_LOGIN_PASSWORD'), 'The active binding helper must read MCP_REVIEW_LOGIN_PASSWORD');
exactCallArguments(identity, bindingFunctions[0], 'configuredPositiveInteger', ["'MCP_REVIEW_LOGIN_USER_ID'"]);
exactCallArguments(identity, bindingFunctions[0], 'parseAuthEpochSetting', ['process.env.MCP_REVIEW_LOGIN_AUTH_EPOCH']);
assert.equal(callsBelow(bindingFunctions[0], 'isConfiguredReviewUserId').length, 1, 'MCP and App Store review identities must remain distinct');
assert.equal(callsBelow(credentialFunctions[0], 'crypto.timingSafeEqual').length, 1, 'MCP reviewer passwords must use constant-time comparison');
assert.equal(
  astSha256(identityGuardFunctions[0]),
  '2fe7a716547241f8fd2b68eb69150786da0c70e2675565957001e32580eb9d76',
  'The complete MCP identity guard AST must preserve the reviewed fail-closed control flow and five-way identity binding',
);

const consentRoute = routeCall(authAst, '/mcp-consent');
assert.equal(consentRoute.arguments[1]?.name, 'reviewEmailAlertLimiter', 'The consent route must apply the email alert limiter first');
assert.equal(consentRoute.arguments[2]?.name, 'reviewCredentialLimiter', 'The consent route must apply the credential limiter second');
const consentHandler = consentRoute.arguments[3];
assert.equal(
  astSha256(consentHandler),
  '3c166ae60c37113bc6096b4cdea0b6178991b97947fccd011cf07fb41a2ad44a',
  'The complete MCP consent handler AST must bind reviewer authentication directly to the reviewed credential result',
);
const consentPageRoute = routeCall(authAst, '/mcp-consent', 'get');
const consentPageHandler = consentPageRoute.arguments[1];
assert.equal(
  astSha256(consentPageHandler),
  '71c5945b0c31189bdf95373a03dec3888b0e1c55a3d2110fb9f081c9ed6f338b',
  'The complete MCP consent page handler must render the reviewed direct reviewer sign-in form',
);
const consentText = [];
walk(consentPageHandler, (node) => {
  if (node.type === 'StringLiteral') consentText.push(node.value);
  if (node.type === 'TemplateElement') consentText.push(node.value.raw);
});
assert.ok(consentText.some((value) => value.includes('name="provider" value="mcp_review"')), 'The consent page must expose direct plugin-review sign-in');
exactCallArguments(auth, consentHandler, 'authenticateMcpReviewCredentials', ['email', 'password']);
exactCallArguments(auth, consentHandler, 'isMcpReviewIdentityAllowed', ['candidate', 'pending.rows[0].resource', 'MCP_PLUGIN_RESOURCE']);
exactCallArguments(auth, consentHandler, 'generateMcpAuthCode', ['mcpReviewUser.id', 'pending_id', 'redirect_uri', 'state', 'res']);

const exchangeMethods = namedMethods(providerAst, 'exchangeAuthorizationCode');
const refreshMethods = namedMethods(providerAst, 'exchangeRefreshToken');
const accessMethods = namedMethods(providerAst, 'verifyAccessToken');
assert.equal(exchangeMethods.length, 1, 'The active authorization-code exchange method must be unique');
assert.equal(refreshMethods.length, 1, 'The active refresh-token exchange method must be unique');
assert.equal(accessMethods.length, 1, 'The active access-token verification method must be unique');
assert.equal(astSha256(exchangeMethods[0]), '4dff4d36ecc3b4483c5ff14d23d41e9c939191e9b5c9e309d5c5055c3e9e2eb0', 'Authorization-code exchange must preserve the reviewed reviewer guard and token-operation control flow');
assert.equal(astSha256(refreshMethods[0]), 'b3039b31c0ebadd0ee8962e34ae8ad40b8cae7e84bfad07c4a40d72a98f16849', 'Refresh-token exchange must preserve the reviewed reviewer guard and token-operation control flow');
assert.equal(astSha256(accessMethods[0]), '8a6ec79367aea8906d1b3f5ce0e57da6775dbe5cd5b1aa448a608887d2863513', 'Access-token verification must preserve the reviewed reviewer guard and fail-closed control flow');
assert.equal(callsBelow(exchangeMethods[0], 'isMcpReviewIdentityAllowed').length, 1, 'Authorization-code exchange must revalidate the MCP reviewer binding');
assert.equal(callsBelow(refreshMethods[0], 'isMcpReviewIdentityAllowed').length, 1, 'Refresh-token exchange must revalidate the MCP reviewer binding');
assert.equal(callsBelow(accessMethods[0], 'isMcpReviewIdentityAllowed').length, 1, 'Access-token verification must revalidate the MCP reviewer binding');
assert.ok(callsBelow(refreshMethods[0], 'isConfiguredMcpReviewUserId').length >= 1, 'Refresh-token exchange must recognize the dedicated MCP reviewer identity');
assert.ok(callsBelow(accessMethods[0], 'isConfiguredMcpReviewUserId').length >= 1, 'Access-token verification must recognize the dedicated MCP reviewer identity');

assert.match(activeReviewerFixture, /openai-review@usetrackly\.app/, 'The reviewer login must have a dedicated synthetic identity');
assert.match(activeReviewerFixture, /is_test_account IS DISTINCT FROM TRUE/, 'The fixture must reject non-synthetic identity reuse');
assert.match(activeReviewerFixture, /account_deletion_requests/, 'The fixture must reject deleted identity reuse');
assert.doesNotMatch(
  activeReviewerFixture,
  /\b(?:MCP_REVIEW_LOGIN_PASSWORD|OPENAI_REVIEW_PASSWORD|REVIEW_LOGIN_PASSWORD|REVIEW_PASSWORD|password(?:_hash|_digest)?|passwd|passphrase|pwd|credential_secret|client_secret)\b/i,
  'The reviewer fixture must not contain password-bearing columns, variables, or alternate secret identifiers',
);
const protectedMigrationRoute = routeCall(migrationRouteAst, '/admin/run-migration-503');
assert.equal(protectedMigrationRoute.arguments[1]?.name, 'requireAdminApiOrSession', 'Migration 503 must require admin authorization');
assert.equal(protectedMigrationRoute.arguments[2]?.name, 'requirePrimaryAdminApiKeyHeader', 'Migration 503 must require the primary admin API key');

for (const proof of [
  'plugin review path authenticates directly and returns an authorization code',
  'plugin review path rejects invalid credentials before consent or code creation',
]) assert.ok(consentTests.has(proof), `Missing active consent test: ${proof}`);
for (const proof of [
  'mints plugin-resource tokens for the dedicated synthetic MCP reviewer',
  'rotates a dedicated MCP reviewer token only for the plugin resource',
]) assert.ok(oauthTests.has(proof), `Missing active OAuth test: ${proof}`);

const isolatedBackendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-review-auth-backend-'));
try {
  const archivePath = path.join(isolatedBackendRoot, 'backend.tar');
  const archive = childProcess.spawnSync(
    'git',
    ['-C', backendRoot, 'archive', '--format=tar', '--output', archivePath, EXPECTED_DEPLOYED_BACKEND_COMMIT],
    { encoding: 'utf8', timeout: REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS },
  );
  assert.ifError(archive.error);
  assert.equal(archive.status, 0, `Unable to export the pinned backend commit (exit ${archive.status ?? 'unknown'})`);
  const extract = childProcess.spawnSync('tar', ['-xf', archivePath, '-C', isolatedBackendRoot], {
    encoding: 'utf8',
    timeout: REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS,
  });
  assert.ifError(extract.error);
  assert.equal(extract.status, 0, `Unable to extract the pinned backend commit (exit ${extract.status ?? 'unknown'})`);
  fs.unlinkSync(archivePath);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installEnv = { ...process.env, NODE_ENV: 'development', npm_config_omit: '' };
  const install = childProcess.spawnSync(
    npmCommand,
    ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'],
    { cwd: isolatedBackendRoot, encoding: 'utf8', env: installEnv, timeout: 600_000 },
  );
  assert.ifError(install.error);
  const installFailure = `${install.stderr || ''}\n${install.stdout || ''}`
    .replace(/(_authToken=)[^\s]+/gi, '$1[redacted]')
    .trim()
    .slice(-4000);
  assert.equal(
    install.status,
    0,
    `The isolated pinned backend dependency install must succeed (exit ${install.status ?? 'unknown'}): ${installFailure}`,
  );
  let vitestPackage;
  try {
    vitestPackage = require.resolve('vitest/package.json', { paths: [isolatedBackendRoot] });
  } catch {
    throw new Error('The isolated pinned backend dependency install must provide Vitest');
  }
  const vitestBin = path.join(path.dirname(vitestPackage), 'vitest.mjs');
  const backendTests = childProcess.spawnSync(
    process.execPath,
    [vitestBin, 'run', 'src/routes/__tests__/mcp-consent.test.ts', 'src/mcp/__tests__/mcp-oauth-provider.test.ts', '--no-file-parallelism'],
    {
      cwd: isolatedBackendRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: REVIEW_AUTH_SUBPROCESS_TIMEOUT_MS,
    },
  );
  assert.ifError(backendTests.error);
  assert.equal(
    backendTests.status,
    0,
    `The isolated focused backend consent and OAuth tests must execute successfully (exit ${backendTests.status ?? 'unknown'})`,
  );
} finally {
  fs.rmSync(isolatedBackendRoot, { recursive: true, force: true });
}

console.log('Dedicated MCP reviewer-auth contract passes: the fixture and direct password sign-in are synthetic, rate-limited, and plugin-resource-bound.');
