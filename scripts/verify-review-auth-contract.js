#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendDir = process.env.TRACKLY_BACKEND_DIR;
if (!backendDir) {
  console.log('Dedicated MCP reviewer-auth source check skipped without TRACKLY_BACKEND_DIR; standalone fixture validation continues.');
  process.exit(0);
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

for (const envName of [
  'MCP_REVIEW_LOGIN_EMAIL',
  'MCP_REVIEW_LOGIN_PASSWORD',
  'MCP_REVIEW_LOGIN_USER_ID',
  'MCP_REVIEW_LOGIN_AUTH_EPOCH',
]) {
  assert.match(identity, new RegExp(`\\b${envName}\\b`), `${envName} must be read by the dedicated binding helper`);
}
assert.match(identity, /isConfiguredReviewUserId\(userId\)/, 'MCP and App Store review identities must remain distinct');
assert.match(identity, /identity\.is_test_account === true/, 'MCP review access must require a synthetic test account');
assert.match(identity, /resource !== pluginResource/, 'MCP review access must be confined to the plugin resource');
assert.match(identity, /crypto\.timingSafeEqual/, 'MCP reviewer passwords must use constant-time comparison');

assert.match(auth, /name="provider" value="mcp_review"/, 'The consent page must expose direct plugin-review sign-in');
assert.match(
  auth,
  /router\.post\('\/mcp-consent', reviewEmailAlertLimiter, reviewCredentialLimiter,/,
  'Direct plugin-review sign-in must use the review credential limiters',
);
assert.match(auth, /authenticateMcpReviewCredentials\(email, password\)/, 'The consent route must authenticate the submitted reviewer credential');
assert.match(auth, /pending\.rows\[0\]\.resource !== MCP_PLUGIN_RESOURCE/, 'The consent route must reject review credentials on every non-plugin resource');
assert.match(auth, /isMcpReviewIdentityAllowed\(candidate, pending\.rows\[0\]\.resource, MCP_PLUGIN_RESOURCE\)/, 'The consent route must validate the immutable synthetic binding');
assert.match(auth, /return generateMcpAuthCode\(mcpReviewUser\.id, pending_id, redirect_uri, state, res\)/, 'Direct reviewer sign-in must complete the authorization-code flow without a third-party provider');

assert.match(provider, /isConfiguredMcpReviewUserId/, 'Token validation must recognize the dedicated MCP reviewer identity');
assert.ok(
  (provider.match(/isMcpReviewIdentityAllowed\(/g) || []).length >= 3,
  'Authorization-code exchange, refresh, and access-token verification must all revalidate the MCP reviewer binding',
);
assert.match(provider, /decoded\.resource !== MCP_PLUGIN_RESOURCE/, 'MCP reviewer refresh/access tokens must remain plugin-resource-bound');

assert.match(reviewerFixture, /openai-review@usetrackly\.app/, 'The reviewer login must have a dedicated synthetic identity');
assert.match(reviewerFixture, /is_test_account IS DISTINCT FROM TRUE/, 'The fixture must reject non-synthetic identity reuse');
assert.match(reviewerFixture, /account_deletion_requests/, 'The fixture must reject deleted identity reuse');
assert.doesNotMatch(reviewerFixture, /MCP_REVIEW_LOGIN_PASSWORD/, 'The reviewer password must never be stored in the fixture');
assert.match(migrationRoute, /'\/admin\/run-migration-503'/, 'The reviewer fixture must have a protected deployment route');
assert.match(
  migrationRoute,
  /'\/admin\/run-migration-503',[\s\S]*?requireAdminApiOrSession,[\s\S]*?requirePrimaryAdminApiKeyHeader/,
  'The reviewer fixture route must require both admin authorization boundaries',
);

for (const proof of [
  'plugin review path authenticates directly and returns an authorization code',
  'plugin review path rejects invalid credentials before consent or code creation',
]) assert.match(authTests, new RegExp(proof));
for (const proof of [
  'mints plugin-resource tokens for the dedicated synthetic MCP reviewer',
  'rotates a dedicated MCP reviewer token only for the plugin resource',
]) assert.match(providerTests, new RegExp(proof));

console.log('Dedicated MCP reviewer-auth contract passes: the fixture and direct password sign-in are synthetic, rate-limited, and plugin-resource-bound.');
