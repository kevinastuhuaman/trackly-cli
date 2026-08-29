#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const babelParser = require('@babel/parser');
const fs = require('node:fs');
const path = require('node:path');

const backendDir = process.env.TRACKLY_BACKEND_DIR;
if (!backendDir) {
  if (process.argv.includes('--allow-missing-backend')) {
    console.log('Dedicated MCP reviewer-auth source check explicitly skipped without TRACKLY_BACKEND_DIR; standalone fixture validation continues.');
    process.exit(0);
  }
  throw new Error('TRACKLY_BACKEND_DIR is required for the dedicated reviewer-auth contract check');
}

const backendRoot = path.resolve(backendDir);
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
const activeReviewerFixture = reviewerFixture
  .replace(/--[^\r\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

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

const routeCall = (root, routePath) => {
  const matches = callsBelow(root, 'router.post').filter((call) => call.arguments[0]?.value === routePath);
  assert.equal(matches.length, 1, `${routePath} must have exactly one active router.post registration`);
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
assert.equal(callsBelow(bindingFunctions[0], 'isConfiguredReviewUserId').length, 1, 'MCP and App Store review identities must remain distinct');
assert.equal(callsBelow(credentialFunctions[0], 'crypto.timingSafeEqual').length, 1, 'MCP reviewer passwords must use constant-time comparison');
for (const identifier of ['is_test_account', 'email', 'resource', 'pluginResource', 'auth_epoch']) {
  let present = false;
  walk(identityGuardFunctions[0], (node) => { if (node.type === 'Identifier' && node.name === identifier) present = true; });
  assert.ok(present, `The active MCP identity guard must bind ${identifier}`);
}

assert.match(auth.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ''), /name="provider" value="mcp_review"/, 'The consent page must expose direct plugin-review sign-in');
const consentRoute = routeCall(authAst, '/mcp-consent');
assert.equal(consentRoute.arguments[1]?.name, 'reviewEmailAlertLimiter', 'The consent route must apply the email alert limiter first');
assert.equal(consentRoute.arguments[2]?.name, 'reviewCredentialLimiter', 'The consent route must apply the credential limiter second');
const consentHandler = consentRoute.arguments[3];
for (const call of ['authenticateMcpReviewCredentials', 'isMcpReviewIdentityAllowed', 'generateMcpAuthCode']) {
  assert.equal(callsBelow(consentHandler, call).length, 1, `The active consent handler must call ${call} exactly once`);
}

assert.ok(
  callsBelow(providerAst, 'isMcpReviewIdentityAllowed').length >= 3,
  'Authorization-code exchange, refresh, and access-token verification must all revalidate the MCP reviewer binding',
);
assert.ok(callsBelow(providerAst, 'isConfiguredMcpReviewUserId').length >= 3, 'Token validation must recognize the dedicated MCP reviewer identity');

assert.match(reviewerFixture, /openai-review@usetrackly\.app/, 'The reviewer login must have a dedicated synthetic identity');
assert.match(reviewerFixture, /is_test_account IS DISTINCT FROM TRUE/, 'The fixture must reject non-synthetic identity reuse');
assert.match(reviewerFixture, /account_deletion_requests/, 'The fixture must reject deleted identity reuse');
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

console.log('Dedicated MCP reviewer-auth contract passes: the fixture and direct password sign-in are synthetic, rate-limited, and plugin-resource-bound.');
