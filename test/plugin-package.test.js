'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'trackly');

const {
  HOSTED_DEPLOYABLE_PATHS,
  activeNamedDefinitionAst,
  activeToolRegistrations,
  assertCommonJsDestructuredRequire,
  assertActiveFunctionDirectStatementAst,
  assertActiveFunctionDefinitionAst,
  assertActiveFunctionAstSha256,
  assertActiveTopLevelStatementAst,
  assertBabelPropertyExpression,
  assertExactSchemaProperties,
  assertExportedFactoryUsedByPluginRouter,
  assertImmutablePluginScopeFreeMethods,
  assertLivePluginRouterMount,
  assertMcpScopeHelperSemantics,
  assertMergeCommitPreservesPaths,
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
  directToolRegistrationsInNamedParameterFunction,
  exactSchemaDefinition,
  parseSchemaExpression,
  referencedConstantIdentifiers,
  referencedFreeIdentifiers,
  registeredInputSchemaName,
  registrationDescriptorPropertyAst,
  registrationInputSchemaAst,
  registrationArgumentSources,
  schemaObjectPropertyAsts,
  sha256ExactBytes,
  staticApplicationFieldSensitivityMap,
  staticStringArrayMap,
  verifyHostedSnapshotGitProvenance,
  wrappedHandlerReturnProperties,
  wrappedHandlerReturnedObjectProperties,
} = require('../scripts/verify-hosted-contract.js');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

function filesBelow(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `skill trees must not contain symbolic links: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      if (entry.isFile()) files.push(absolute);
    }
  };
  visit(directory);
  return files.sort();
}

function treeSha256(directory) {
  const hash = crypto.createHash('sha256');
  for (const absolute of filesBelow(directory)) {
    hash.update(path.relative(directory, absolute).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function referencedTools(directory) {
  const names = new Set();
  for (const absolute of filesBelow(directory).filter((file) => file.endsWith('.md'))) {
    const source = fs.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/\btrackly_[a-z0-9_]+\b/g)) names.add(match[0]);
  }
  return [...names].sort();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('skill tree hashing and tool discovery fail closed on symbolic links', (t) => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'trackly-symlink-tree-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'target.md');
  const link = path.join(directory, 'linked.md');
  fs.writeFileSync(target, 'safe');
  fs.symlinkSync(target, link);
  assert.throws(() => treeSha256(directory), /skill trees must not contain symbolic links/);
  assert.throws(() => referencedTools(directory), /skill trees must not contain symbolic links/);
});

test('executable digest hashing is exact-byte and fail-closed on formatting changes', () => {
  const compact = 'const value={label:"two words",template:`keep this space`,pattern:/a b/};';
  const formatted = `
    // formatting-only comment
    const value = {
      label: "two words",
      template: \`keep this space\`,
      pattern: /a b/,
    };
  `;

  assert.notEqual(sha256ExactBytes(formatted), sha256ExactBytes(compact));
  assert.notEqual(
    sha256ExactBytes(compact),
    sha256ExactBytes(compact.replace('two words', 'twowords')),
    'spaces inside quoted literals must affect executable digests',
  );
  assert.notEqual(
    sha256ExactBytes(compact),
    sha256ExactBytes(compact.replace('keep this space', 'keepthisspace')),
    'spaces inside template literals must affect executable digests',
  );
  assert.notEqual(
    sha256ExactBytes(compact),
    sha256ExactBytes(compact.replace('/a b/', '/ab/')),
    'spaces inside regular-expression literals must affect executable digests',
  );
  assert.notEqual(
    sha256ExactBytes('if (ok) {} else /a b/.test(value)'),
    sha256ExactBytes('if (ok) {} else /a  b/.test(value)'),
    'regular-expression bytes after an else branch must remain digest-significant',
  );
  assert.notEqual(
    sha256ExactBytes('do /a b/.test(value); while(ok)'),
    sha256ExactBytes('do /a  b/.test(value); while(ok)'),
    'regular-expression bytes after do must remain digest-significant',
  );
});

test('token secret initialization requires the active fail-closed production guard', () => {
  const guard = `if (!BASE_SECRET) {
    throw new Error('missing secret');
  }`;
  assert.doesNotThrow(() => assertActiveTopLevelStatementAst(guard, guard, 'token guard fixture'));
  assert.throws(
    () => assertActiveTopLevelStatementAst(
      `function neverCalled() { ${guard} }`,
      guard,
      'nested token guard fixture',
    ),
    /must execute its locked fail-closed top-level statement exactly once/,
  );
});

test('schema extraction ignores commented and nested decoys and resolves top-level bindings', () => {
  const localLikeSource = `
    // const targetSchema = z.never();
    /* const targetSchema = z.any(); */
    const targetSchema = z.string();
  `;
  assert.equal(
    exactSchemaDefinition(localLikeSource, 'targetSchema', 'local-like fixture'),
    'const targetSchema = z.string();',
  );

  const hostedLikeSource = `
    const targetSchema: z.ZodString = z.string();
    export function register(): void {
      // const targetSchema = z.never();
      const targetSchema = z.any();
    }
  `;
  assert.equal(
    exactSchemaDefinition(hostedLikeSource, 'targetSchema', 'hosted-like fixture'),
    'const targetSchema: z.ZodString = z.string();',
  );
  assert.equal(
    parseSchemaExpression(hostedLikeSource, 'targetSchema', 'hosted-like fixture').type,
    'CallExpression',
  );
  const hostedFactorySource = `
    export function createTracklyMcpServer(): void {
      const targetSchema = z.string();
      if (false) { const targetSchema = z.never(); }
    }
  `;
  assert.equal(
    exactSchemaDefinition(hostedFactorySource, 'targetSchema', 'hosted factory fixture'),
    'const targetSchema = z.string();',
  );
  assert.throws(
    () => exactSchemaDefinition(
      'function nested() { const decoy = z.number(); }',
      'decoy',
      'nested-only fixture',
    ),
    /must have exactly one active top-level variable declaration/,
  );
  assert.throws(
    () => exactSchemaDefinition('let targetSchema = z.string();', 'targetSchema', 'mutable schema fixture'),
    /must use an immutable const declaration/,
  );
  assert.throws(
    () => exactSchemaDefinition(
      'const targetSchema = z.string(); targetSchema = z.any();',
      'targetSchema',
      'reassigned schema fixture',
    ),
    /must never be assigned or updated after declaration/,
  );
  assert.throws(
    () => activeNamedDefinitionAst(
      'function lockedHelper() { return true; } lockedHelper = decoyHelper;',
      'lockedHelper',
      'reassigned function fixture',
    ),
    /must never be assigned or updated after its locked definition/,
  );
  assert.throws(
    () => activeNamedDefinitionAst(
      'function lockedHelper() { return true; } lockedHelper++;',
      'lockedHelper',
      'updated function fixture',
    ),
    /must never be assigned or updated after its locked definition/,
  );
});

test('coordinated hosted provenance rejects a dirty reviewed-runtime checkout', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'trackly-provenance-'));
  const cliRoot = path.join(root, 'cli');
  const backendRoot = path.join(root, 'backend');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cliRoot, 'plugins', 'trackly'), { recursive: true });
  fs.mkdirSync(backendRoot, { recursive: true });
  const git = (...args) => childProcess.execFileSync('git', ['-C', backendRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init');
  fs.writeFileSync(path.join(backendRoot, 'tracked.txt'), 'reviewed\n');
  git('add', 'tracked.txt');
  childProcess.execFileSync('git', [
    '-C', backendRoot,
    '-c', 'user.name=Trackly Test',
    '-c', 'user.email=test@usetrackly.app',
    'commit', '-m', 'fixture',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sourceCommit = git('rev-parse', 'HEAD');
  fs.writeFileSync(
    path.join(cliRoot, 'plugins', 'trackly', 'hosted-contract-fixture.json'),
    JSON.stringify({
      sourceRuntime: { commit: sourceCommit, parent: '0'.repeat(40) },
      mergedRuntime: { commit: '1'.repeat(40), parents: [sourceCommit] },
      sourceSha256: {},
    }),
  );
  fs.writeFileSync(path.join(backendRoot, 'unreviewed.txt'), 'dirty\n');
  assert.throws(
    () => verifyHostedSnapshotGitProvenance(cliRoot, backendRoot),
    /must be completely clean so every inspected backend byte comes from the reviewed commit/,
  );
});

test('coordinated hosted provenance rejects merge commits that alter reviewed deployable blobs', (t) => {
  assert.ok(
    HOSTED_DEPLOYABLE_PATHS.includes('src/mcp/plugin-ui.ts'),
    'the hosted MCP App UI must be covered by exact reviewed-to-merged byte provenance',
  );
  const repository = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'trackly-merge-provenance-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => childProcess.execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init');
  git('config', 'user.name', 'Trackly Test');
  git('config', 'user.email', 'test@usetrackly.app');
  fs.writeFileSync(path.join(repository, 'deployable.ts'), 'export const reviewed = true;\n');
  git('add', 'deployable.ts');
  git('commit', '-m', 'reviewed source');
  const sourceCommit = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'preserving merge fixture');
  const preservingCommit = git('rev-parse', 'HEAD');
  assert.doesNotThrow(() => assertMergeCommitPreservesPaths(
    repository,
    sourceCommit,
    preservingCommit,
    ['deployable.ts'],
  ));
  fs.writeFileSync(path.join(repository, 'deployable.ts'), 'export const reviewed = false;\n');
  git('add', 'deployable.ts');
  git('commit', '-m', 'merge-time drift');
  const driftedCommit = git('rev-parse', 'HEAD');
  assert.throws(
    () => assertMergeCommitPreservesPaths(repository, sourceCommit, driftedCommit, ['deployable.ts']),
    /must exactly preserve reviewed source/,
  );
});

test('scope extraction ignores stale commented mappings and rejects dynamic object members', () => {
  const source = `
    const TRACKLY_PLUGIN_TOOL_SCOPES = {
      // trackly_stale: ['admin:write'],
      trackly_active: ['jobs:read', 'tracking:read'],
      /* trackly_old: ['sensitive:write'], */
    } as const satisfies Record<string, readonly string[]>;
  `;
  assert.deepEqual(
    staticStringArrayMap(source, 'TRACKLY_PLUGIN_TOOL_SCOPES', 'scope fixture'),
    { trackly_active: ['jobs:read', 'tracking:read'] },
  );
  assert.throws(
    () => staticStringArrayMap(
      'const TRACKLY_PLUGIN_TOOL_SCOPES = { ...dynamicScopes };',
      'TRACKLY_PLUGIN_TOOL_SCOPES',
      'spread scope fixture',
    ),
    /only static properties \(no spreads or methods\)/,
  );
});

test('OAuth scope normalization and subset checks stay fail-closed against the canonical scope catalog', () => {
  const source = `
    export const MCP_SCOPE_DEFINITIONS = {
      'jobs:read': 'Search and view jobs, companies, contacts, and discovery preferences',
      'tracking:read': 'View your saved jobs and application status',
      'tracking:write': 'Update your job tracking status and discovery preferences',
      'profile:read': 'View your application profile and Apply readiness',
      'profile:write': 'Save user-approved application answers',
      'sensitive:read': 'Read consented sensitive application answers needed for form filling',
      'sensitive:write': 'Grant or revoke encrypted storage consent for sensitive application answers',
      'apply:read': 'View your Apply queue, work, and value-free progress',
      'apply:write': 'Read and update your application profile and prepare user-approved applications',
    } as const;
    type McpScope = keyof typeof MCP_SCOPE_DEFINITIONS;
    export const MCP_SUPPORTED_SCOPES = Object.freeze(
      Object.keys(MCP_SCOPE_DEFINITIONS) as McpScope[],
    );
    const MCP_SUPPORTED_SCOPE_SET = new Set<string>(MCP_SUPPORTED_SCOPES);
    export function normalizeMcpScopes(
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
    }
    export function isScopeSubset(
      candidate: readonly string[],
      allowed: readonly string[],
    ): boolean {
      const allowedSet = new Set(allowed);
      return candidate.every((scope) => allowedSet.has(scope));
    }
  `;
  assert.doesNotThrow(() => assertMcpScopeHelperSemantics(source, 'scope helper fixture'));
  assert.throws(
    () => assertMcpScopeHelperSemantics(
      source.replace(
        'return candidate.every((scope) => allowedSet.has(scope));',
        'return candidate.some((scope) => allowedSet.has(scope));',
      ),
      'permissive subset fixture',
    ),
    /must preserve its locked executable branch semantics/,
  );
  assert.throws(
    () => assertMcpScopeHelperSemantics(
      source.replace(
        'const MCP_SUPPORTED_SCOPE_SET = new Set<string>(MCP_SUPPORTED_SCOPES);',
        "const MCP_SUPPORTED_SCOPE_SET = new Set<string>(MCP_SUPPORTED_SCOPES);\n    MCP_SUPPORTED_SCOPE_SET.add('admin:all');",
      ),
      'mutated scope set fixture',
    ),
    /must be referenced only by its immutable declaration and locked membership check/,
  );
  assert.throws(
    () => assertMcpScopeHelperSemantics(
      source.replace(
        "candidate.some((scope) => !MCP_SUPPORTED_SCOPE_SET.has(scope))",
        'false',
      ),
      'permissive normalization fixture',
    ),
    /must preserve its locked executable branch semantics/,
  );
});

test('scope-free plugin methods are immutable and used only by the locked membership decision', () => {
  const source = `
    const TRACKLY_PLUGIN_SCOPE_FREE_METHODS = new Set([
      'initialize',
      'ping',
      'notifications/initialized',
      'notifications/cancelled',
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'resources/read',
    ]);
    function enforce(message) {
      if (TRACKLY_PLUGIN_SCOPE_FREE_METHODS.has(message.method)) return;
      deny();
    }
  `;
  assert.doesNotThrow(() => assertImmutablePluginScopeFreeMethods(source, 'scope-free fixture'));
  for (const [label, drift] of [
    ['mutated', "TRACKLY_PLUGIN_SCOPE_FREE_METHODS.add('tools/call');"],
    ['aliased', 'const bypasses = TRACKLY_PLUGIN_SCOPE_FREE_METHODS;'],
    ['reassigned', 'TRACKLY_PLUGIN_SCOPE_FREE_METHODS = new Set();'],
  ]) {
    assert.throws(
      () => assertImmutablePluginScopeFreeMethods(
        source.replace('function enforce', `${drift}\n    function enforce`),
        `${label} scope-free fixture`,
      ),
      /must (?:not be aliased, escaped, mutated, or used outside its locked membership check|never be assigned or updated)/,
    );
  }
  assert.throws(
    () => assertImmutablePluginScopeFreeMethods(
      source.replace("'resources/read',", "'resources/read', 'tools/call',"),
      'widened scope-free fixture',
    ),
    /must preserve its locked executable definition/,
  );
});

test('the exported plugin router must be mounted on the exact production application path', () => {
  const source = `
    import express from 'express';
    import tracklyPluginMcpRoutes from './mcp/plugin-router';
    const PORT = 3000;
    export function createApp() {
      const app = express();
      app.use('/api/plugin/trackly/mcp', tracklyPluginMcpRoutes);
      return app;
    }
    function startServer() {
      installProcessGuards();
      const app = createApp();
      app.listen(PORT);
    }
    if (require.main === module) {
      startServer();
    }
  `;
  assert.doesNotThrow(() => assertLivePluginRouterMount(
    source,
    'tracklyPluginMcpRoutes',
    './mcp/plugin-router',
    '/api/plugin/trackly/mcp',
    'application mount fixture',
  ));
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace(
        "app.use('/api/plugin/trackly/mcp', tracklyPluginMcpRoutes);",
        "app.use('/api/plugin/trackly/mcp', decoyRouter);",
      ),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'decoy application mount fixture',
    ),
    /must directly mount imported tracklyPluginMcpRoutes exactly once/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace(
        "app.use('/api/plugin/trackly/mcp', tracklyPluginMcpRoutes);",
        "app.use('/api/plugin/trackly/mcp-v2', tracklyPluginMcpRoutes);",
      ),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'wrong application path fixture',
    ),
    /must directly mount imported tracklyPluginMcpRoutes exactly once/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace(
        "app.use('/api/plugin/trackly/mcp', tracklyPluginMcpRoutes);",
        "const escapedRouter = tracklyPluginMcpRoutes;\n      app.use('/api/plugin/trackly/mcp', tracklyPluginMcpRoutes);",
      ),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'escaped application router fixture',
    ),
    /must not alias, escape, or register tracklyPluginMcpRoutes outside its locked live application mount/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace(
        'const PORT = 3000;',
        'const PORT = 3000;\n    const escapedRouter = tracklyPluginMcpRoutes;',
      ),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'top-level escaped application router fixture',
    ),
    /must not alias, escape, or register tracklyPluginMcpRoutes outside its locked live application mount/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      `${source}\ncreateApp = decoyCreateApp;`,
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'reassigned application factory fixture',
    ),
    /createApp.*must never be assigned or updated after its locked definition/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      `${source}\ncreateApp++;`,
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'updated application factory fixture',
    ),
    /createApp.*must never be assigned or updated after its locked definition/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace(
        'installProcessGuards();',
        'process.exit(0);',
      ),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'unreachable application mount fixture',
    ),
    /must execute only installProcessGuards before creating the live application/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace('function startServer() {', 'function* startServer() {'),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'deferred application mount fixture',
    ),
    /must not defer execution as a generator/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace('export function createApp() {', 'export function* createApp() {'),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'generator application factory fixture',
    ),
    /must not return a generator/,
  );
  assert.throws(
    () => assertLivePluginRouterMount(
      source.replace(
        'installProcessGuards();\n      const app = createApp();',
        'installProcessGuards();\n      const app = createApp(), dead = process.exit(0);',
      ),
      'tracklyPluginMcpRoutes',
      './mcp/plugin-router',
      '/api/plugin/trackly/mcp',
      'multi-declarator application mount fixture',
    ),
    /must isolate createApp in one side-effect-free declaration/,
  );
});

test('registration extraction ignores commented tools and binds the active published schema', () => {
  const pluginSource = `
    // registerPluginTool('trackly_active', { stale: true }, staleHandler);
    registerPluginTool('trackly_active', { active: true }, activeHandler);
  `;
  const [pluginRegistration] = activeToolRegistrations(
    pluginSource,
    'registerPluginTool',
    'plugin registration fixture',
  );
  assert.equal(pluginRegistration.name, 'trackly_active');
  assert.deepEqual(
    registrationArgumentSources(pluginSource, pluginRegistration, 'plugin registration fixture'),
    ["'trackly_active'", '{ active: true }', 'activeHandler'],
  );

  const applySource = `
    /* server.registerTool('trackly_apply', { inputSchema: staleSchema }, handler); */
    server.registerTool(
      'trackly_apply',
      { inputSchema: activeSchema } as const,
      handler,
    );
  `;
  const [registration] = activeToolRegistrations(
    applySource,
    'server.registerTool',
    'Apply registration fixture',
  );
  assert.equal(registration.name, 'trackly_apply');
  assert.equal(registeredInputSchemaName(registration, 'Apply registration fixture'), 'activeSchema');
});

test('local Apply registrations are bound to the helper reached by createServer', () => {
  const applySource = `
    function registerApplyTools(server, dependencies) {
      server.tool('trackly_zero', 'zero', {}, zeroHandler);
      server.registerTool('trackly_one', { inputSchema: oneSchema }, oneHandler);
      server.registerTool('trackly_two', { inputSchema: twoSchema }, twoHandler);
    }
  `;
  assert.deepEqual(
    directToolRegistrationsInNamedParameterFunction(
      applySource,
      'registerApplyTools',
      'server',
      'tool',
      'local registration fixture',
    ).map(({ name }) => name),
    ['trackly_zero'],
  );
  assert.deepEqual(
    directToolRegistrationsInNamedParameterFunction(
      applySource,
      'registerApplyTools',
      'server',
      'registerTool',
      'local registration fixture',
    ).map(({ name }) => name),
    ['trackly_one', 'trackly_two'],
  );
  assert.throws(
    () => directToolRegistrationsInNamedParameterFunction(
      applySource.replace(
        "server.registerTool('trackly_two', { inputSchema: twoSchema }, twoHandler);",
        "function disabled() { server.registerTool('trackly_two', { inputSchema: twoSchema }, twoHandler); }",
      ),
      'registerApplyTools',
      'server',
      'registerTool',
      'nested local registration fixture',
    ),
    /must not alias, escape, or otherwise reference server outside direct catalog registrations/,
  );
  for (const [label, prefix] of [
    ['return', 'if (disabled) return;'],
    ['throw', "throw new Error('disabled');"],
    ['branch', "if (disabled) { server.tool('trackly_branch', 'branch', {}, branchHandler); }"],
  ]) {
    assert.throws(
      () => directToolRegistrationsInNamedParameterFunction(
        applySource.replace("server.tool('trackly_zero'", `${prefix}\n      server.tool('trackly_zero'`),
        'registerApplyTools',
        'server',
        'tool',
        `${label} before local registration fixture`,
      ),
      /must reach every local registration without an earlier branch, return, or throw/,
    );
  }
  assert.throws(
    () => directToolRegistrationsInNamedParameterFunction(
      applySource.replace("server.registerTool('trackly_two', { inputSchema: twoSchema }, twoHandler);", "server.registerTool('trackly_two', { inputSchema: twoSchema }, twoHandler);\n      return server;"),
      'registerApplyTools',
      'server',
      'registerTool',
      'returned local server fixture',
    ),
    /must not alias, escape, or otherwise reference server outside direct catalog registrations/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedParameterFunction(
      applySource.replace(
        "server.tool('trackly_zero', 'zero', {}, zeroHandler);",
        "const add = server.tool.bind(server);\n      add('trackly_hidden', 'hidden', {}, hiddenHandler);\n      server.tool('trackly_zero', 'zero', {}, zeroHandler);",
      ),
      'registerApplyTools',
      'server',
      'tool',
      'aliased local registration fixture',
    ),
    /must not alias, escape, or otherwise reference server outside direct catalog registrations/,
  );
  const baseSource = `
    function createServer() {
      const server = new McpServer({ name: 'trackly', version: PACKAGE_VERSION });
      server.tool('trackly_base_one', 'one', {}, oneHandler);
      server.tool('trackly_base_two', 'two', {}, twoHandler);
      return server;
    }
  `;
  assert.deepEqual(
    directToolRegistrationsInNamedParameterFunction(
      baseSource,
      'createServer',
      'server',
      'tool',
      'local base registration fixture',
      'direct-construction',
    ).map(({ name }) => name),
    ['trackly_base_one', 'trackly_base_two'],
  );
  const serverSource = `
    const { registerApplyTools } = require('./apply-tools');
    function createServer() {
      const server = makeServer();
      registerApplyTools(server, {
        wrapTool,
        mcpUserAgent: MCP_USER_AGENT,
        throwMcpResourceError,
      });
      return server;
    }
  `;
  assert.doesNotThrow(() => assertCommonJsDestructuredRequire(
    serverSource,
    'registerApplyTools',
    './apply-tools',
    'local server fixture',
  ));
  assert.doesNotThrow(() => assertActiveFunctionDirectStatementAst(
    serverSource,
    'createServer',
    `registerApplyTools(server, {
      wrapTool,
      mcpUserAgent: MCP_USER_AGENT,
      throwMcpResourceError,
    });`,
    'local server fixture',
    { mustPrecedeSoleFinalReturn: true },
  ));
  const escapedServerSource = baseSource.replace(
    "server.tool('trackly_base_one', 'one', {}, oneHandler);",
    "publishServer(server);\n      server.tool('trackly_base_one', 'one', {}, oneHandler);",
  );
  assert.throws(
    () => directToolRegistrationsInNamedParameterFunction(
      escapedServerSource,
      'createServer',
      'server',
      'tool',
      'escaped local server fixture',
      'direct-construction',
    ),
    /must not alias, escape, or otherwise reference server outside direct catalog registrations/,
  );
  const registrationStatement = `registerApplyTools(server, {
      wrapTool,
      mcpUserAgent: MCP_USER_AGENT,
      throwMcpResourceError,
    });`;
  const deadRegistrationSource = `
    function createServer() {
      const server = makeServer();
      return server;
      ${registrationStatement}
    }
  `;
  assert.throws(
    () => assertActiveFunctionDirectStatementAst(
      deadRegistrationSource,
      'createServer',
      registrationStatement,
      'dead local registration fixture',
      { mustPrecedeSoleFinalReturn: true },
    ),
    /must end with its sole return after its locked direct statement/,
  );
  assert.throws(
    () => assertCommonJsDestructuredRequire(
      serverSource.replace("require('./apply-tools')", "require('./decoy-tools')"),
      'registerApplyTools',
      './apply-tools',
      'decoy local server fixture',
    ),
    /must import registerApplyTools exactly once from \.\/apply-tools/,
  );
});

test('plugin registration proof accepts only unconditional calls in the exported server factory', () => {
  const uiResourceLoop = `
      for (const view of Object.keys(TRACKLY_PLUGIN_UI) as Array<keyof typeof TRACKLY_PLUGIN_UI>) {
        const uri = TRACKLY_PLUGIN_UI[view];
        server.registerResource(\`trackly-\${view}-card\`, uri, {
          title: \`trackly \${view} card\`,
          description: 'Private trackly Apply status UI. The user always submits manually.',
          mimeType: TRACKLY_PLUGIN_UI_MIME_TYPE,
        }, async () => ({
          contents: [{
            uri,
            mimeType: TRACKLY_PLUGIN_UI_MIME_TYPE,
            text: tracklyPluginUiHtml(view),
            _meta: TRACKLY_PLUGIN_UI_RESOURCE_META,
          }],
        }));
      }
  `;
  const factoryFixture = (body, returnedServer = 'server') => `
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    export function createTracklyPluginMcpServer(
      authToken: string,
      requestApi: PluginApiRequest = apiRequest,
    ) {
      const server = new McpServer({ name: 'trackly', version: PLUGIN_VERSION });
      const registerPluginTool = (name, config, handler) => {
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
      };
      ${body}
      return ${returnedServer};
    }
  `;
  const source = `
    registerPluginTool('trackly_decoy', { inputSchema: z.object({}) }, decoyHandler);
    ${factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      registerPluginTool('trackly_two', { inputSchema: z.object({}) }, twoHandler);
    `)}
  `;
  assert.deepEqual(
    directToolRegistrationsInExportedFunction(
      source,
      'createTracklyPluginMcpServer',
      'registerPluginTool',
      'server factory fixture',
    ).map(({ name }) => name),
    ['trackly_one', 'trackly_two'],
  );
  assert.doesNotThrow(() => directToolRegistrationsInExportedFunction(
    factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      ${uiResourceLoop}
    `),
    'createTracklyPluginMcpServer',
    'registerPluginTool',
    'required UI resource fixture',
    { requireUiResourceLoop: true },
  ));
  assert.throws(
    () => directToolRegistrationsInExportedFunction(
      factoryFixture(`
        registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      `),
      'createTracklyPluginMcpServer',
      'registerPluginTool',
      'missing UI resource fixture',
      { requireUiResourceLoop: true },
    ),
    /must contain exactly one locked plugin UI resource loop/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
    `).replace(
      "from '@modelcontextprotocol/sdk/server/mcp.js'",
      "from './decoy-mcp.js'",
    ), 'createTracklyPluginMcpServer', 'registerPluginTool', 'decoy McpServer import fixture'),
    /must import McpServer as McpServer exactly once from @modelcontextprotocol\/sdk\/server\/mcp\.js/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
        registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
        if (false) registerPluginTool('trackly_decoy', { inputSchema: z.object({}) }, handler);
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'conditional registration fixture'),
    /must register every registerPluginTool tool unconditionally as a direct function-body statement/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
        registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
    `).replace(
      'const server = new McpServer',
      'const abort = abortStartup();\n      const server = new McpServer',
    ), 'createTracklyPluginMcpServer', 'registerPluginTool', 'executable initializer fixture'),
    /only the verified server and registration-helper declarations/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
        registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
    `).replace('server.registerTool(name, {', 'server.registerTool(alias, {'),
    'createTracklyPluginMcpServer', 'registerPluginTool', 'forwarded name fixture'),
    /must forward the exact name, config, and handler bindings/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
        if (disabled) return server;
        registerPluginTool('trackly_unreachable', { inputSchema: z.object({}) }, handler);
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'early return fixture'),
    /must contain only the verified server and registration-helper declarations before registering tools/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
    `, 'new McpServer({ name: \'decoy\', version: \'1.0.0\' })'),
    'createTracklyPluginMcpServer', 'registerPluginTool', 'wrong return fixture'),
    /must return the exact server that received the verified registrations/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
    `).replace('return server.registerTool', 'return decoyServer.registerTool'),
    'createTracklyPluginMcpServer', 'registerPluginTool', 'wrong registration server fixture'),
    /must forward the exact name, config, and handler bindings/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
    `).replace('requestApi: PluginApiRequest = apiRequest', 'requestApi: PluginApiRequest = decoyRequest'),
    'createTracklyPluginMcpServer', 'registerPluginTool', 'request helper provenance fixture'),
    /must receive authToken and the canonical apiRequest-backed requestApi helper exactly/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      server.registerTool('trackly_submit', { inputSchema: z.object({}) }, submitHandler);
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'direct submit fixture'),
    /must register tools only through the verified registerPluginTool helper/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      server.tool('trackly_submit', submitHandler);
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'alternate registrar fixture'),
    /must register tools only through the verified registerPluginTool helper/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      server['registerTool']('trackly_submit', { inputSchema: z.object({}) }, submitHandler);
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'computed registrar fixture'),
    /must register tools only through the verified registerPluginTool helper/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      (server as any).registerTool('trackly_submit', { inputSchema: z.object({}) }, submitHandler);
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'typed receiver fixture'),
    /must register tools only through the verified registerPluginTool helper/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
      server[registrationMethod]('trackly_submit', { inputSchema: z.object({}) }, submitHandler);
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'dynamic registrar fixture'),
    /must not use dynamic server member access that could bypass the verified registerPluginTool helper/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool(
        'trackly_one',
        { inputSchema: z.object({}) },
        () => publishServer(server),
      );
    `), 'createTracklyPluginMcpServer', 'registerPluginTool', 'escaped facade server fixture'),
    /must not alias, escape, or use its public facade server outside the verified registration helper, locked UI resource registration, and final return/,
  );
  assert.throws(
    () => directToolRegistrationsInExportedFunction(factoryFixture(`
      registerPluginTool('trackly_one', { inputSchema: z.object({}) }, oneHandler);
    `).replace(
      'const registerPluginTool =',
      'const escapedServer = server;\n      const registerPluginTool =',
    ), 'createTracklyPluginMcpServer', 'registerPluginTool', 'aliased facade server fixture'),
    /must contain only the verified server and registration-helper declarations before registering tools|must not alias, escape, or use its public facade server/,
  );
});

test('hosted schema registration proof uses only direct reachable factory initialization', () => {
  const source = `
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    function neverCalled() {
      server.registerTool('trackly_decoy', { inputSchema: decoySchema }, decoyHandler);
    }
    export function createTracklyMcpServer() {
      const server = new McpServer({ name: 'trackly', version: MCP_VERSION });
      server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);
      return server;
    }
  `;
  assert.deepEqual(
    directToolRegistrationsInNamedFactory(
      source,
      'createTracklyMcpServer',
      'server.registerTool',
      'hosted factory registration fixture',
    ).map(({ name }) => name),
    ['trackly_active'],
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "from '@modelcontextprotocol/sdk/server/mcp.js'",
        "from './decoy-mcp.js'",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'decoy McpServer provenance fixture',
    ),
    /must import McpServer as McpServer exactly once from @modelcontextprotocol\/sdk\/server\/mcp\.js/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
        "neverCalled();",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'decoy-only hosted factory fixture',
    ),
    /must directly register its server\.registerTool tools during factory initialization/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
        "if (disabled) return server;\n      server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'disabled hosted factory fixture',
    ),
    /must reach every server\.registerTool registration without an earlier branch, return, throw, or disabled path/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        'return server;',
        "throw new Error('abort startup');\n      return server;",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'post-registration throw hosted factory fixture',
    ),
    /must reach its final server return through direct registration calls on the exact server/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        'return server;',
        "server.tool('trackly_uncontracted', 'Uncontracted', {}, handler);\n      return server;",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'tail tool hosted factory fixture',
      ['trackly_active'],
    ),
    /executable tool catalog drifted from the locked hosted MCP allowlist/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        'return server;',
        'abortStartup();\n      return server;',
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'post-registration abort call hosted factory fixture',
    ),
    /must reach its final server return through direct registration calls on the exact server/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
        "decoyServer.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'decoy receiver hosted factory fixture',
    ),
    /registerTool.*must be called on the exact server factory binding/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace('return server;', 'return decoyServer;'),
      'createTracklyMcpServer',
      'server.registerTool',
      'wrong return hosted factory fixture',
    ),
    /must return the exact server that received the verified registrations/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source
        .replace('const server = new McpServer', 'let server = new McpServer')
        .replace(
          "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
          "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);\n      server = decoyServer;",
        ),
      'createTracklyMcpServer',
      'server.registerTool',
      'mutable reassigned hosted factory fixture',
    ),
    /must declare the server McpServer binding as immutable const/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);\n      server = decoyServer;",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'const reassigned hosted factory fixture',
    ),
    /must reach its final server return through direct registration calls on the exact server/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
        "const add = server.registerTool.bind(server);\n      add('trackly_hidden', { inputSchema: activeSchema }, activeHandler);\n      server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'aliased registration fixture',
    ),
    /may contain only verified pure schema declarations and direct cataloged server registrations/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
        "const z = decoyZ;\n      server.registerTool('trackly_active', { inputSchema: z.object({}) }, activeHandler);",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'shadowed schema namespace fixture',
    ),
    /may contain only verified pure schema declarations and direct cataloged server registrations/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        "server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
        "const startup = abortStartup();\n      server.registerTool('trackly_active', { inputSchema: activeSchema }, activeHandler);",
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'impure hosted declaration fixture',
    ),
    /may contain only verified pure schema declarations and direct cataloged server registrations/,
  );
  assert.throws(
    () => directToolRegistrationsInNamedFactory(
      source.replace(
        'export function createTracklyMcpServer()',
        'export function createTracklyMcpServer(McpServer = DecoyServer)',
      ),
      'createTracklyMcpServer',
      'server.registerTool',
      'shadowed constructor fixture',
    ),
    /must not shadow the canonical imported McpServer binding/,
  );
});

test('application field sensitivity catalog extraction is static and fail closed', () => {
  const source = `
    const APPLICATION_PROFILE_FIELD_DEFINITIONS = [
      { key: 'email', sensitivity: 'sensitive' },
      { key: 'portfolioUrl', sensitivity: 'standard' },
    ] as const;
  `;
  assert.deepEqual(
    staticApplicationFieldSensitivityMap(source, 'application catalog fixture'),
    { email: 'sensitive', portfolioUrl: 'standard' },
  );
  assert.throws(
    () => staticApplicationFieldSensitivityMap(
      source.replace("sensitivity: 'sensitive'", 'sensitivity: classifyField()'),
      'dynamic application catalog fixture',
    ),
    /needs a static sensitivity/,
  );
  assert.throws(
    () => staticApplicationFieldSensitivityMap(
      source.replace("sensitivity: 'sensitive'", "sensitivity: 'public'"),
      'unsupported application catalog fixture',
    ),
    /has an unsupported sensitivity/,
  );
});

test('plugin registration proof binds the exported factory to the live POST route', () => {
  const routerFixture = (
    handlerBody,
    authInfoExpression = '(req as Request & { auth: HostedOAuthAuthInfo }).auth',
    authTokenExpression = 'generateHostedOAuthInternalToken(authInfo)',
    routeWrapperStart = '',
    routeWrapperEnd = '',
  ) => `
    import { Router } from 'express';
    import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
    import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
    import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
    import { tracklyOAuthProvider } from './oauth-provider.js';
    import { MCP_PLUGIN_RESOURCE } from './mcp-tokens.js';
    import { enforceTracklyPluginScope } from './plugin-scopes.js';
    import { requireTracklyAccess } from '../services/trackly-access.js';
    import { createTracklyPluginMcpServer } from './plugin-server.js';
    import { generateHostedOAuthInternalToken } from './server.js';
    const router = Router();
    const RESOURCE_METADATA_URL = \`\${process.env.MCP_ISSUER_URL || 'https://mcp.usetrackly.app'}/.well-known/oauth-protected-resource/api/plugin/trackly/mcp\`;
    const allowedOrigins = new Set([
      'https://closeai.mba',
      'https://www.closeai.mba',
      'https://usetrackly.app',
      'https://www.usetrackly.app',
      'https://mcp.usetrackly.app',
      'https://chatgpt.com',
    ]);
    function validateOrigin(req: Request, res: Response, next: NextFunction): void {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        res.status(403).json({ error: 'Forbidden origin' });
        return;
      }
      next();
    }
    const bearerAuth = requireBearerAuth({
      verifier: tracklyOAuthProvider,
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
    export function enforcePluginResource(
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
    }
    export function requirePluginEnabled(
      _req: Request,
      res: Response,
      next: NextFunction,
    ): void {
      if (process.env.MCP_SERVER_ENABLED === 'true') {
        next();
        return;
      }
      res.status(503).json({ error: 'trackly plugin is not enabled' });
    }
    export const PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX = 6_000;
    const ipLimiter = rateLimit({
      windowMs: 60_000,
      max: PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many trackly plugin requests. Try again later.' },
    });
    const identityLimiter = rateLimit({
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
    });
    ${routeWrapperStart}
    router.post(
      '/',
      requirePluginEnabled,
      validateOrigin,
      ipLimiter,
      bearerAuth,
      enforcePluginResource,
      requireTracklyAccess,
      enforceTracklyPluginScope,
      identityLimiter,
      async (req: Request, res: Response) => {
        const authInfo = ${authInfoExpression};
        const authToken = ${authTokenExpression};
        ${handlerBody}
      },
    );
    ${routeWrapperEnd}
    export default router;
  `;
  const routerSource = routerFixture(`
    const server = createTracklyPluginMcpServer(authToken);
    const transport = new StreamableHTTPServerTransport({});
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  `);
  assert.doesNotThrow(() => assertExportedFactoryUsedByPluginRouter(
    routerSource,
    'createTracklyPluginMcpServer',
    'router fixture',
  ));
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace('PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX = 6_000', 'PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX = 60_000'),
      'createTracklyPluginMcpServer',
      'widened shared egress limiter fixture',
    ),
    /PLUGIN_SHARED_EGRESS_RATE_LIMIT_MAX.*must preserve its locked executable definition/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace("import { Router } from 'express';", "import { Router } from './decoy-express.js';"),
      'createTracklyPluginMcpServer',
      'decoy Router import fixture',
    ),
    /must import Router as Router exactly once from express/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace('const router = Router();', 'const router = decoyRouter;'),
      'createTracklyPluginMcpServer',
      'decoy Router initializer fixture',
    ),
    /router in decoy Router initializer fixture must preserve its locked executable definition/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace('export default router;', 'export default decoyRouter;'),
      'createTracklyPluginMcpServer',
      'decoy default export fixture',
    ),
    /must default-export the exact canonical Express router receiving POST/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace(
        "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
        "import { StreamableHTTPServerTransport } from './decoy-transport.js';",
      ),
      'createTracklyPluginMcpServer',
      'decoy transport fixture',
    ),
    /must import StreamableHTTPServerTransport as StreamableHTTPServerTransport exactly once from @modelcontextprotocol\/sdk\/server\/streamableHttp\.js/,
  );
  for (const competingRoute of [
    "router.all('/', (_req, res) => res.end());",
    "router.use('/', (_req, res) => res.end());",
    "router.route('/').post((_req, res) => res.end());",
    "router.all('/{*splat}', (_req, res) => res.end());",
    "router.use(/.*/, (_req, res) => res.end());",
    "router.post(['/', '/shadow'], (_req, res) => res.end());",
    "router.use(dynamicMount, (_req, res) => res.end());",
    "router['post']('/', (_req, res) => res.end());",
    "router[dynamicMethod]('/', (_req, res) => res.end());",
    "router.route('/')['post']((_req, res) => res.end());",
    "router.route('/').get(readHandler).post(writeHandler);",
  ]) {
    assert.throws(
      () => assertExportedFactoryUsedByPluginRouter(
        routerSource.replace('router.post(', `${competingRoute}\n    router.post(`),
        'createTracklyPluginMcpServer',
        'competing route fixture',
      ),
      /must not register an earlier router mount that could cover POST \/ ahead of the authenticated route/,
    );
  }
  assert.doesNotThrow(() => assertExportedFactoryUsedByPluginRouter(
    routerSource.replace('router.post(', "router.use('/health', healthRouter);\n    router.post("),
    'createTracklyPluginMcpServer',
    'statically disjoint route fixture',
  ));
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace(
        'const server = createTracklyPluginMcpServer(authToken);',
        'if (disabled) return;\n        const server = createTracklyPluginMcpServer(authToken);',
      ),
      'createTracklyPluginMcpServer',
      'early route exit fixture',
    ),
    /must reach factory creation and its live transport without an earlier exit, throw, branch, or side effect/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerFixture(`
        const server = createTracklyPluginMcpServer(authToken);
        const transport = new StreamableHTTPServerTransport({});
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } finally {
          await server.close();
        }
      `, undefined, undefined, 'function registerLater() {', '}'),
      'createTracklyPluginMcpServer',
      'dead route fixture',
    ),
    /must execute exactly one POST \/ plugin route registration at module initialization/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerFixture(`
      if (false) {
        const server = createTracklyPluginMcpServer(authToken);
      }
    `), 'createTracklyPluginMcpServer', 'nested factory fixture'),
    /must directly instantiate createTracklyPluginMcpServer exactly once/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerFixture(`
      const server = createTracklyPluginMcpServer(authToken);
      const transport = new StreamableHTTPServerTransport({});
      try {
        await decoyServer.connect(transport);
      } finally {
        await server.close();
      }
    `), 'createTracklyPluginMcpServer', 'wrong server fixture'),
    /must directly connect its exact factory-result server to its live transport/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerFixture(`
      const server = createTracklyPluginMcpServer(authToken);
      const transport = new StreamableHTTPServerTransport({});
      try {
        await server.connect(transport);
        await decoyTransport.handleRequest(req, res, req.body);
      } finally {
        await server.close();
      }
    `), 'createTracklyPluginMcpServer', 'wrong dispatch fixture'),
    /must directly dispatch req, res, and req\.body through its connected transport/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerSource.replace(
      'await server.close();',
      'await decoyServer.close();',
    ), 'createTracklyPluginMcpServer', 'wrong close fixture'),
    /must await closing the exact routed server after dispatch or error/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerSource.replace(
      'await server.close();',
      'if (shouldClose) await server.close();',
    ), 'createTracklyPluginMcpServer', 'conditional close fixture'),
    /must await closing the exact routed server after dispatch or error/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerSource.replace(
      '} finally {\n      await server.close();\n    }',
      '} catch (error) { throw error; }',
    ), 'createTracklyPluginMcpServer', 'missing finally fixture'),
    /must unconditionally close its routed server in finally/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerFixture(`
      const server = createTracklyPluginMcpServer(authToken);
      const transport = new StreamableHTTPServerTransport({});
    `, '(req as Request & { auth: HostedOAuthAuthInfo }).auth', 'req.body.authToken'),
    'createTracklyPluginMcpServer', 'shadow token fixture'),
    /must mint authToken only from authenticated authInfo/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(routerFixture(`
      const server = createTracklyPluginMcpServer(authToken);
      const transport = new StreamableHTTPServerTransport({});
    `, 'req.body.auth'), 'createTracklyPluginMcpServer', 'raw auth context fixture'),
    /must derive authInfo from the authenticated request context/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace("from './plugin-scopes.js'", "from './no-op.js'"),
      'createTracklyPluginMcpServer',
      'wrong middleware provenance fixture',
    ),
    /must import enforceTracklyPluginScope as enforceTracklyPluginScope exactly once from \.\/plugin-scopes\.js/,
  );
  assert.throws(
    () => assertExportedFactoryUsedByPluginRouter(
      routerSource.replace(
        "if (origin && !allowedOrigins.has(origin))",
        "if (false)",
      ),
      'createTracklyPluginMcpServer',
      'no-op origin middleware fixture',
    ),
    /validateOrigin.*must preserve its locked executable branch semantics/,
  );
});

test('descriptor extraction binds active annotation and input-schema expressions instead of comments', () => {
  const source = `
    registerPluginTool('trackly_mutation', {
      // annotations: readOnlyAnnotations,
      annotations: mutationAnnotations(false, true),
      /* inputSchema: z.object({ stale: z.literal(true) }), */
      inputSchema: z.object({ confirmed: z.literal(true) }).strict(),
    }, handler);
  `;
  const [registration] = activeToolRegistrations(source, 'registerPluginTool', 'descriptor fixture');
  assert.deepEqual(
    canonicalSchemaAst(registrationDescriptorPropertyAst(
      source, registration, 'annotations', 'descriptor fixture',
    )),
    canonicalSchemaAst(parseSchemaExpression(
      'const annotation = mutationAnnotations(false, true);',
      'annotation',
      'expected annotation fixture',
    )),
  );
  const inputSchema = registrationDescriptorPropertyAst(
    source, registration, 'inputSchema', 'descriptor fixture',
  );
  assert.equal(inputSchema.type, 'CallExpression');
  assert.equal(inputSchema.callee.property.name, 'strict');
  assert.notDeepEqual(
    canonicalSchemaAst(registrationDescriptorPropertyAst(
      source, registration, 'annotations', 'descriptor fixture',
    )),
    canonicalSchemaAst(parseSchemaExpression(
      'const annotation = mutationAnnotations(false, false);',
      'annotation',
      'different annotation fixture',
    )),
    'mutation annotation argument tuples must remain semantically distinct',
  );
});

test('shared Apply schema extraction covers tool and registerTool registrations', () => {
  const source = `
    server.tool('trackly_tool_schema', 'fixture', { id: z.number().int() }, handler);
    server.registerTool('trackly_registered_schema', {
      inputSchema: z.object({ id: z.number().int() }).strict(),
    }, handler);
  `;
  const registrations = activeToolRegistrations(source, 'server.tool', 'tool schema fixture').concat(
    activeToolRegistrations(source, 'server.registerTool', 'registered schema fixture'),
  );
  const toolSchema = registrationInputSchemaAst(source, registrations[0], 'tool schema fixture');
  assert.equal(toolSchema.type, 'ObjectExpression');
  assert.equal(toolSchema.properties[0].key.name, 'id');
  const registeredSchema = registrationInputSchemaAst(
    source,
    registrations[1],
    'registered schema fixture',
  );
  assert.equal(registeredSchema.type, 'CallExpression');
  assert.equal(registeredSchema.callee.property.name, 'strict');
});

test('job-brief projection validation binds every active value expression', () => {
  const source = `
    registerPluginTool('trackly_get_job_brief', { inputSchema }, wrapTool(async () => {
      const brief = response.brief;
      return {
        jobId: brief.jobId,
        companyName: brief.companyName,
        companySignal: { openRoleCount: brief.companySignal?.openRoleCount ?? 0 },
      };
    }, 'Fixture failure'));
  `;
  const [registration] = activeToolRegistrations(source, 'registerPluginTool', 'job brief fixture');
  const properties = wrappedHandlerReturnProperties(registration, 'job brief fixture');
  assertBabelPropertyExpression(properties, 'jobId', 'brief.jobId', 'job brief fixture');
  assertBabelPropertyExpression(properties, 'companyName', 'brief.companyName', 'job brief fixture');
  assert.throws(
    () => assertBabelPropertyExpression(properties, 'companyName', 'brief.contacts', 'job brief fixture'),
    /companyName must equal brief\.contacts/,
  );
  const [alternateReturn] = activeToolRegistrations(source.replace(
    'const brief = response.brief;',
    'const brief = response.brief;\n      if (brief.contacts) return { contacts: brief.contacts };',
  ), 'registerPluginTool', 'alternate job brief fixture');
  assert.throws(
    () => wrappedHandlerReturnProperties(alternateReturn, 'alternate job brief fixture'),
    /must have exactly one reachable projection return/,
  );
});

test('handler inspection accepts only the canonical executable wrapTool call shape', () => {
  const canonicalWrapper = `function wrapTool(handler, fallback, includeStructuredContent = false) {
    return async (params) => {
      try {
        return resultContent(await handler(params), includeStructuredContent);
      } catch (error) {
        return errorContent(error, fallback);
      }
    };
  }`;
  assert.doesNotThrow(() => assertActiveFunctionDefinitionAst(
    canonicalWrapper,
    'wrapTool',
    canonicalWrapper,
    'canonical wrapper definition fixture',
  ));
  assert.throws(
    () => assertActiveFunctionDefinitionAst(
      canonicalWrapper.replace('await handler(params)', 'await decoyHandler(params)'),
      'wrapTool',
      canonicalWrapper,
      'decoy wrapper definition fixture',
    ),
    /must preserve its locked executable branch semantics/,
  );
  const registrationFrom = (handlerSource, sourcePath) => activeToolRegistrations(
    `registerPluginTool('trackly_wrapped', { inputSchema }, ${handlerSource});`,
    'registerPluginTool',
    sourcePath,
  )[0];
  assert.doesNotThrow(() => wrappedHandlerReturnProperties(
    registrationFrom("wrapTool(async () => { return { success: true }; }, 'Fixture failure')", 'canonical wrapper fixture'),
    'canonical wrapper fixture',
  ));
  assert.throws(
    () => wrappedHandlerReturnProperties(
      registrationFrom("decoyWrap(async () => ({ success: true }), 'Fixture failure')", 'decoy wrapper fixture'),
      'decoy wrapper fixture',
    ),
    /must use the canonical wrapTool binding/,
  );
  assert.throws(
    () => wrappedHandlerReturnProperties(
      registrationFrom('wrapTool(async () => ({ success: true }))', 'short wrapper fixture'),
      'short wrapper fixture',
    ),
    /must provide exactly a handler, fallback message, and optional structured-content flag/,
  );
  assert.throws(
    () => wrappedHandlerReturnProperties(
      registrationFrom(
        "wrapTool(async () => ({ success: true }), 'Fixture failure', true, async () => ({ decoy: true }))",
        'extra handler fixture',
      ),
      'extra handler fixture',
    ),
    /must provide exactly a handler, fallback message, and optional structured-content flag/,
  );
});

test('sensitive-consent revocation handler binds revision, confirmation, endpoint, and response', () => {
  const handler = `(params) => requestApi(
    'PATCH', '/api/jobscout/application-profile', authToken,
    { ...params, source: 'mcp', sensitiveStorageConsent: false },
  )`;
  const registrationFrom = (handlerSource, sourcePath) => activeToolRegistrations(
    `registerPluginTool('trackly_revoke_sensitive_storage_consent', { inputSchema }, wrapTool(${handlerSource}, 'Failed to revoke sensitive storage consent'));`,
    'registerPluginTool',
    sourcePath,
  )[0];
  assert.doesNotThrow(() => assertWrappedHandlerAst(
    registrationFrom(handler, 'revocation handler fixture'),
    handler,
    'revocation handler fixture',
  ));
  for (const [label, drifted] of [
    ['endpoint', handler.replace('/api/jobscout/application-profile', '/api/jobscout/application-profile/decoy')],
    ['payload', handler.replace('{ ...params, source:', '{ expectedRevision: params.expectedRevision, source:')],
    ['consent', handler.replace('sensitiveStorageConsent: false', 'sensitiveStorageConsent: true')],
    ['response', handler.replace("=> requestApi(", "=> { requestApi(").replace("\n  )", "\n  ); return { success: true }; }")],
  ]) {
    assert.throws(
      () => assertWrappedHandlerAst(
        registrationFrom(drifted, `${label} revocation drift fixture`),
        handler,
        `${label} revocation drift fixture`,
      ),
      /must preserve its complete locked executable semantics/,
    );
  }
});

test('local wrapper handlers must actively parse params with their strict schema', () => {
  const validSource = `
    server.registerTool('trackly_strict', { inputSchema: publicSchema }, wrapTool(async (params) =>
      requestApi('POST', '/strict', strictSchema.parse(params))
    , 'Fixture failure'));
  `;
  const [valid] = activeToolRegistrations(validSource, 'server.registerTool', 'strict handler fixture');
  assert.doesNotThrow(() => assertWrappedHandlerParsesWithSchema(valid, 'strictSchema', 'strict handler fixture'));

  const decoySource = `
    server.registerTool('trackly_strict', { inputSchema: publicSchema }, wrapTool(async (params) => {
      // strictSchema.parse(params)
      const unused = () => strictSchema.parse(params);
      return requestApi('POST', '/permissive', params);
    }, 'Fixture failure'));
  `;
  const [decoy] = activeToolRegistrations(decoySource, 'server.registerTool', 'decoy parse fixture');
  assert.throws(
    () => assertWrappedHandlerParsesWithSchema(decoy, 'strictSchema', 'decoy parse fixture'),
    /must execute exactly one strictSchema\.parse\(params\) call/,
  );
  const conditionalSource = `
    server.registerTool('trackly_strict', { inputSchema: publicSchema }, wrapTool(async (params) => {
      if (enabled) {
        const parsed = strictSchema.parse(params);
      }
      return requestApi('POST', '/permissive', params);
    }, 'Fixture failure'));
  `;
  const [conditional] = activeToolRegistrations(
    conditionalSource,
    'server.registerTool',
    'conditional parse fixture',
  );
  assert.throws(
    () => assertWrappedHandlerParsesWithSchema(conditional, 'strictSchema', 'conditional parse fixture'),
    /must parse params in its first unconditional statement/,
  );
  const deadSource = `
    server.registerTool('trackly_strict', { inputSchema: publicSchema }, wrapTool(async (params) => {
      return requestApi('POST', '/permissive', params);
      const parsed = strictSchema.parse(params);
    }, 'Fixture failure'));
  `;
  const [dead] = activeToolRegistrations(deadSource, 'server.registerTool', 'dead parse fixture');
  assert.throws(
    () => assertWrappedHandlerParsesWithSchema(dead, 'strictSchema', 'dead parse fixture'),
    /must parse params in its first unconditional statement/,
  );
});

test('truth-certification handler locks auth, body, idempotency, and bounded projection', () => {
  const source = `
    registerPluginTool('trackly_certify_review_ready', { inputSchema }, wrapTool(async ({ runId, idempotencyKey, ...binding }) => {
      const response = await requestApi(
        'POST', \`/api/jobscout/apply/runs/\${runId}/plugin-review-ready\`, wrongToken,
        binding,
        { 'Idempotency-Key': idempotencyKey },
      );
      return {
        view: 'review' as const,
        success: response?.success !== false,
        reviewReady: response?.success !== false,
        status: safeReviewStatus(response?.outcome?.status ?? response?.status ?? response?.run?.status),
        noSubmit: true as const,
      };
    }, 'Fixture failure'));
  `;
  const [registration] = activeToolRegistrations(source, 'registerPluginTool', 'certification handler fixture');
  assert.throws(
    () => assertWrappedHandlerAst(registration, `async ({ runId, idempotencyKey, ...binding }) => {
      const response = await requestApi(
        'POST', \`/api/jobscout/apply/runs/\${runId}/plugin-review-ready\`, authToken,
        binding,
        { 'Idempotency-Key': idempotencyKey },
      );
      return {
        view: 'review' as const,
        success: response?.success !== false,
        reviewReady: response?.success !== false,
        status: safeReviewStatus(response?.outcome?.status ?? response?.status ?? response?.run?.status),
        noSubmit: true as const,
      };
    }`, 'certification handler fixture'),
    /must preserve its complete locked executable semantics/,
  );
});

test('wrapped request endpoint validation requires the reachable returned request for every input', () => {
  const source = `registerPluginTool(
    'trackly_reconcile', { inputSchema },
    wrapTool(({ runId }) => requestApi(
      'POST', \`/api/jobscout/apply/runs/\${runId}/wrong-endpoint\`, body,
    ), 'Fixture failure'),
  );`;
  const [registration] = activeToolRegistrations(source, 'registerPluginTool', 'endpoint fixture');
  assert.throws(
    () => assertWrappedHandlerRequestEndpoint(
      registration,
      'POST',
      '`/api/jobscout/apply/runs/${runId}/plugin-review-ready`',
      'endpoint fixture',
    ),
    /must target `\/api\/jobscout\/apply\/runs\/\$\{runId\}\/plugin-review-ready`/,
  );
  const conditionalSource = `
    registerPluginTool('trackly_reconcile', { inputSchema }, wrapTool(async ({ runId }) => {
      if (disabled) {
        return requestApi(
          'POST', \`/api/jobscout/apply/runs/\${runId}/plugin-review-ready\`, body,
        );
      }
      return { success: true };
    }, 'Fixture failure'));
  `;
  const [conditional] = activeToolRegistrations(
    conditionalSource,
    'registerPluginTool',
    'conditional endpoint fixture',
  );
  assert.throws(
    () => assertWrappedHandlerRequestEndpoint(
      conditional,
      'POST',
      '`/api/jobscout/apply/runs/${runId}/plugin-review-ready`',
      'conditional endpoint fixture',
    ),
    /must directly return its sole requestApi call/,
  );
  const certificationSource = `
    registerPluginTool('trackly_certify', { inputSchema }, wrapTool(async ({ runId }) => {
      if (disabled) {
        const response = await requestApi(
          'POST', \`/api/jobscout/apply/runs/\${runId}/plugin-review-ready\`, body,
        );
        return response;
      }
      return { success: true };
    }, 'Fixture failure'));
  `;
  const [certification] = activeToolRegistrations(
    certificationSource,
    'registerPluginTool',
    'conditional certification fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAssignedRequestEndpoint(
      certification,
      'response',
      'POST',
      '`/api/jobscout/apply/runs/${runId}/plugin-review-ready`',
      'conditional certification fixture',
    ),
    /must bind its live response request exactly once/,
  );
  const earlyReturnCertificationSource = `
    registerPluginTool('trackly_certify', { inputSchema }, wrapTool(async ({ runId }) => {
      if (skipCertification) return { success: true };
      const response = await requestApi(
        'POST', \`/api/jobscout/apply/runs/\${runId}/plugin-review-ready\`, body,
      );
      return response;
    }, 'Fixture failure'));
  `;
  const [earlyReturnCertification] = activeToolRegistrations(
    earlyReturnCertificationSource,
    'registerPluginTool',
    'early return certification fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAssignedRequestEndpoint(
      earlyReturnCertification,
      'response',
      'POST',
      '`/api/jobscout/apply/runs/${runId}/plugin-review-ready`',
      'early return certification fixture',
      { requireReachableForAllInputs: true },
    ),
    /must be reachable for every accepted input without an earlier branch, return, or throw/,
  );
});

test('live work endpoint validation binds the consumed request result', () => {
  const validSource = `
    registerPluginTool('trackly_get_apply_work', { inputSchema }, wrapTool(async () => {
      if (!snapshot) {
        const work = await requestApi(
          'POST', \`/api/jobscout/apply/executions/\${resolvedExecutionId}/plugin-work\`, authToken, {},
        );
        return work?.lineageMismatch === true
          ? projectApplyWorkResponse(work, 'authorization_changed')
          : projectApplyWorkResponse(work, 'progress');
      }
      const workSnapshot = await requestApi(
        'POST', \`/api/jobscout/apply/executions/\${resolvedExecutionId}/snapshot\`, authToken, snapshot,
      );
      return {
        ...projectApplyWorkSnapshot(workSnapshot, snapshot.profileKeys ?? []),
        kind: 'snapshot' as const,
      };
    }, 'Fixture failure'));
  `;
  const [valid] = activeToolRegistrations(validSource, 'registerPluginTool', 'live work fixture');
  assert.doesNotThrow(() => assertWrappedHandlerAssignedRequestEndpoint(
    valid,
    'work',
    'POST',
    '`/api/jobscout/apply/executions/${resolvedExecutionId}/plugin-work`',
    'live work fixture',
    { guardExpression: '!snapshot' },
  ));
  assert.doesNotThrow(() => assertWrappedHandlerGuardedReturnAst(
    valid,
    '!snapshot',
    `return work?.lineageMismatch === true
      ? projectApplyWorkResponse(work, 'authorization_changed')
      : projectApplyWorkResponse(work, 'progress');`,
    'live work fixture',
  ));
  assert.doesNotThrow(() => assertWrappedHandlerGuardedBlockAst(
    valid,
    '!snapshot',
    `{
      const work = await requestApi(
        'POST', \`/api/jobscout/apply/executions/\${resolvedExecutionId}/plugin-work\`, authToken, {},
      );
      return work?.lineageMismatch === true
        ? projectApplyWorkResponse(work, 'authorization_changed')
        : projectApplyWorkResponse(work, 'progress');
    }`,
    'live work fixture',
  ));
  assert.doesNotThrow(() => assertWrappedHandlerAssignedRequestEndpoint(
    valid,
    'workSnapshot',
    'POST',
    '`/api/jobscout/apply/executions/${resolvedExecutionId}/snapshot`',
    'live work fixture',
  ));
  assert.doesNotThrow(() => assertWrappedHandlerDirectStatementAst(
    valid,
    `return {
      ...projectApplyWorkSnapshot(workSnapshot, snapshot.profileKeys ?? []),
      kind: 'snapshot' as const,
    };`,
    'live work fixture',
  ));

  const decoySource = `
    registerPluginTool('trackly_get_apply_work', { inputSchema }, wrapTool(async () => {
      // /plugin-work
      const stale = '/plugin-work';
      if (!snapshot) {
        const work = await requestApi(
          'POST', \`/api/jobscout/apply/executions/\${resolvedExecutionId}/wrong-work\`, authToken, {},
        );
        return work;
      }
    }, 'Fixture failure'));
  `;
  const [decoy] = activeToolRegistrations(decoySource, 'registerPluginTool', 'decoy work fixture');
  assert.throws(
    () => assertWrappedHandlerAssignedRequestEndpoint(
      decoy,
      'work',
      'POST',
      '`/api/jobscout/apply/executions/${resolvedExecutionId}/plugin-work`',
      'decoy work fixture',
      { guardExpression: '!snapshot' },
    ),
    /live work request.*must target/s,
  );
  const rawWorkSource = validSource.replace(
    `return work?.lineageMismatch === true
          ? projectApplyWorkResponse(work, 'authorization_changed')
          : projectApplyWorkResponse(work, 'progress');`,
    'return work;',
  );
  const [rawWork] = activeToolRegistrations(rawWorkSource, 'registerPluginTool', 'raw work fixture');
  assert.throws(
    () => assertWrappedHandlerGuardedReturnAst(
      rawWork,
      '!snapshot',
      `return work?.lineageMismatch === true
        ? projectApplyWorkResponse(work, 'authorization_changed')
        : projectApplyWorkResponse(work, 'progress');`,
      'raw work fixture',
    ),
    /must return its locked bounded projection/,
  );
  const alternateReturnSource = validSource.replace(
    'if (!snapshot) {',
    "if (!snapshot) {\n        if (cached) return projectApplyWorkResponse(cached, 'progress');",
  );
  const [alternateReturn] = activeToolRegistrations(
    alternateReturnSource,
    'registerPluginTool',
    'alternate work return fixture',
  );
  assert.throws(
    () => assertWrappedHandlerGuardedBlockAst(
      alternateReturn,
      '!snapshot',
      `{
        const work = await requestApi(
          'POST', \`/api/jobscout/apply/executions/\${resolvedExecutionId}/plugin-work\`, authToken, {},
        );
        return work?.lineageMismatch === true
          ? projectApplyWorkResponse(work, 'authorization_changed')
          : projectApplyWorkResponse(work, 'progress');
      }`,
      'alternate work return fixture',
    ),
    /must preserve the complete locked !snapshot branch/,
  );
  const snapshotDecoySource = `
    registerPluginTool('trackly_get_apply_work', { inputSchema }, wrapTool(async () => {
      // /snapshot and projectApplyWorkSnapshot(workSnapshot, snapshot.profileKeys ?? [])
      const workSnapshot = await requestApi(
        'POST', \`/api/jobscout/apply/executions/\${resolvedExecutionId}/unbounded-work\`, authToken, snapshot,
      );
      return { ...workSnapshot, kind: 'snapshot' as const };
    }, 'Fixture failure'));
  `;
  const [snapshotDecoy] = activeToolRegistrations(
    snapshotDecoySource,
    'registerPluginTool',
    'snapshot decoy fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAssignedRequestEndpoint(
      snapshotDecoy,
      'workSnapshot',
      'POST',
      '`/api/jobscout/apply/executions/${resolvedExecutionId}/snapshot`',
      'snapshot decoy fixture',
    ),
    /live workSnapshot request.*must target/s,
  );
  assert.throws(
    () => assertWrappedHandlerDirectStatementAst(
      snapshotDecoy,
      `return {
        ...projectApplyWorkSnapshot(workSnapshot, snapshot.profileKeys ?? []),
        kind: 'snapshot' as const,
      };`,
      'snapshot decoy fixture',
    ),
    /must execute its locked direct statement exactly once/,
  );
});

test('Apply work projection AST locks reject raw payloads and permissive decision dependencies', () => {
  const source = `
    function readinessCount(value) {
      return Number.isSafeInteger(value) && value >= 0 ? Number(value) : null;
    }
    function projectApplyWorkResponse(value, kind) {
      return {
        kind,
        lineageMismatch: value?.lineageMismatch === true,
        execution: kind === 'progress' ? { id: readinessCount(value?.execution?.id) } : undefined,
      };
    }
  `;
  const digest = (text, name) => sha256ExactBytes(JSON.stringify(
    canonicalSchemaAst(activeNamedDefinitionAst(text, name, 'Apply work projection fixture')),
  ));
  const responseDigest = digest(source, 'projectApplyWorkResponse');
  const countDigest = digest(source, 'readinessCount');
  assert.doesNotThrow(() => assertActiveFunctionAstSha256(
    source,
    'projectApplyWorkResponse',
    responseDigest,
    'Apply work projection fixture',
  ));
  assert.throws(
    () => assertActiveFunctionAstSha256(
      source.replace(
        "return {\n        kind,\n        lineageMismatch: value?.lineageMismatch === true,\n        execution: kind === 'progress' ? { id: readinessCount(value?.execution?.id) } : undefined,\n      };",
        'return value;',
      ),
      'projectApplyWorkResponse',
      responseDigest,
      'raw Apply work projection fixture',
    ),
    /must preserve its locked active semantic AST/,
  );
  assert.throws(
    () => assertActiveFunctionAstSha256(
      source.replace(
        'Number.isSafeInteger(value) && value >= 0 ? Number(value) : null',
        'Number(value)',
      ),
      'readinessCount',
      countDigest,
      'permissive Apply work dependency fixture',
    ),
    /must preserve its locked active semantic AST/,
  );
});

test('remote lint handler stays on its in-memory value-free endpoint without logging, storage, or echo', () => {
  const lintSource = `
    function lintApplicationText(items) {
      const results = items.map((item) => ({
        key: item.key,
        valid: item.text.trim().length > 0,
        characterCount: item.text.length,
      }));
      return {
        valid: results.every((item) => item.valid),
        items: results,
        privacy: 'Text was linted in memory and is not echoed or stored by this tool.',
      };
    }
    registerPluginTool('trackly_lint_application_text', { inputSchema }, wrapTool(
      ({ items }) => Promise.resolve(lintApplicationText(items)),
      'Failed to lint application text',
    ));
  `;
  const lintDigest = sha256ExactBytes(JSON.stringify(canonicalSchemaAst(
    activeNamedDefinitionAst(lintSource, 'lintApplicationText', 'lint privacy fixture'),
  )));
  const [registration] = activeToolRegistrations(
    lintSource,
    'registerPluginTool',
    'lint privacy fixture',
  );
  assert.doesNotThrow(() => assertWrappedHandlerAst(
    registration,
    '({ items }) => Promise.resolve(lintApplicationText(items))',
    'lint privacy fixture',
  ));
  assert.doesNotThrow(() => assertActiveFunctionAstSha256(
    lintSource,
    'lintApplicationText',
    lintDigest,
    'lint privacy fixture',
  ));
  const echoed = lintSource.replace(
    'characterCount: item.text.length,',
    'characterCount: item.text.length, text: item.text,',
  );
  assert.throws(
    () => assertActiveFunctionAstSha256(
      echoed,
      'lintApplicationText',
      lintDigest,
      'echoing lint fixture',
    ),
    /must preserve its locked active semantic AST/,
  );
  const logged = lintSource.replace(
    'const results = items.map',
    'console.log(items); const results = items.map',
  );
  assert.throws(
    () => assertActiveFunctionAstSha256(
      logged,
      'lintApplicationText',
      lintDigest,
      'logging lint fixture',
    ),
    /must preserve its locked active semantic AST/,
  );
  const alternateEndpoint = lintSource.replace(
    'Promise.resolve(lintApplicationText(items))',
    'persistAndLintApplicationText(items)',
  );
  const [alternateRegistration] = activeToolRegistrations(
    alternateEndpoint,
    'registerPluginTool',
    'persisting lint endpoint fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAst(
      alternateRegistration,
      '({ items }) => Promise.resolve(lintApplicationText(items))',
      'persisting lint endpoint fixture',
    ),
    /must preserve its complete locked executable semantics/,
  );
});

test('snapshot input verification binds the complete active bounded schema', () => {
  const expectedInputSchema = `z.object({
    executionId: z.number().int().min(1).optional(),
    snapshot: z.object({
      memberIds: z.array(z.number().int().min(1)).min(1).max(APPLY_EXECUTION_MAX_TARGET),
      profileKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
    }).strict().optional(),
  }).strict()`;
  const source = `
    registerPluginTool('trackly_get_apply_work', {
      /* inputSchema: ${expectedInputSchema}, */
      inputSchema: z.object({
        executionId: z.number().int().min(1).optional(),
        snapshot: z.object({
          memberIds: z.array(z.number().int().min(1)).max(999),
          profileKeys: z.array(z.string()).max(1_000).optional(),
          browserSurface: z.enum(APPLY_BROWSER_SURFACES),
        }).strict().optional(),
      }).strict(),
    }, handler);
  `;
  const [registration] = activeToolRegistrations(source, 'registerPluginTool', 'snapshot schema fixture');
  const descriptor = registration.call.arguments[1];
  assert.throws(
    () => assertBabelPropertyExpression(
      Object.fromEntries(descriptor.properties.map((property) => [property.key.name, property.value])),
      'inputSchema',
      expectedInputSchema,
      'snapshot schema fixture',
    ),
    /inputSchema must equal/,
  );
});

test('active facade descriptors bind complete input and named output contracts', () => {
  const expectedStartInput = `z.object({
    target: z.number().int().min(1).max(APPLY_EXECUTION_MAX_TARGET),
    idempotencyKey: z.string().min(16).max(180).regex(SAFE_IDEMPOTENCY_KEY),
    browserSurface: z.enum(APPLY_BROWSER_SURFACES),
  }).strict()`;
  const source = `
    registerPluginTool('trackly_start_or_resume_apply', {
      /* inputSchema: ${expectedStartInput}, outputSchema: applyOutputSchema, */
      inputSchema: z.object({ target: z.number(), browserSurface: z.string().optional() }),
      outputSchema: z.any(),
    }, handler);
  `;
  const [registration] = activeToolRegistrations(source, 'registerPluginTool', 'active descriptor fixture');
  const properties = Object.fromEntries(
    registration.call.arguments[1].properties.map((property) => [property.key.name, property.value]),
  );
  assert.throws(
    () => assertBabelPropertyExpression(
      properties,
      'inputSchema',
      expectedStartInput,
      'active descriptor fixture',
    ),
    /inputSchema must equal/,
  );
  assert.throws(
    () => assertBabelPropertyExpression(
      properties,
      'outputSchema',
      'applyOutputSchema',
      'active descriptor fixture',
    ),
    /outputSchema must equal applyOutputSchema/,
  );
});

test('readiness profile references must originate from canonical keys and public schema labels', () => {
  const missingKeyProjection = `const missingRequiredKeys = Array.isArray(profile?.completeness?.missingKeys)
    ? (profile.completeness.missingKeys as unknown[]).flatMap((key): string[] => (
      typeof key === 'string' && key.length <= 200 && CANONICAL_PROFILE_KEY.test(key)
        ? [key]
        : []
    )).slice(0, 100)
    : [];`;
  const trustedMissingProjection = `const missingRequired = missingRequiredKeys.flatMap((key) => (
    fieldLabels.has(key) ? [{ key, label: fieldLabels.get(key)! }] : []
  ));`;
  const trustedAvailabilityProjection = `const profileProjectionAvailable = schemaProjectionAvailable
    && profileBodyAvailable
    && missingRequired.length === missingRequiredKeys.length;`;
  const trustedMissingSource = `
    function projectApplyReadiness() {
      ${missingKeyProjection}
      ${trustedMissingProjection}
      ${trustedAvailabilityProjection}
      return missingRequired;
    }
  `;
  for (const statement of [missingKeyProjection, trustedMissingProjection, trustedAvailabilityProjection]) {
    assert.doesNotThrow(() => assertActiveFunctionDirectStatementAst(
      trustedMissingSource,
      'projectApplyReadiness',
      statement,
      'trusted missing readiness fixture',
    ));
  }
  assert.throws(
    () => assertActiveFunctionDirectStatementAst(
      trustedMissingSource.replace(
        'fieldLabels.has(key) ? [{ key, label: fieldLabels.get(key)! }] : []',
        "[{ key, label: fieldLabels.get(key) ?? 'Required profile field' }]",
      ),
      'projectApplyReadiness',
      trustedMissingProjection,
      'fallback missing readiness fixture',
    ),
    /must execute its locked direct statement exactly once/,
  );
  assert.throws(
    () => assertActiveFunctionDirectStatementAst(
      trustedMissingSource.replace(
        'missingRequired.length === missingRequiredKeys.length',
        'true',
      ),
      'projectApplyReadiness',
      trustedAvailabilityProjection,
      'untrusted missing-key availability fixture',
    ),
    /must execute its locked direct statement exactly once/,
  );
  const source = `
    function projectApplyReadiness() {
      // const availableFields = profile.fields.map((key) => ({ key, label: fieldLabels.get(key)! }));
      const availableFields = privateAnswers.map((answer) => ({
        key: answer.value,
        label: answer.contact,
      }));
      return availableFields;
    }
  `;
  assert.throws(
    () => assertActiveFunctionDirectStatementAst(
      source,
      'projectApplyReadiness',
      `const availableFields = profile?.fields
        && typeof profile.fields === 'object'
        && !Array.isArray(profile.fields)
        ? Object.keys(profile.fields)
          .filter((key) => fieldLabels.has(key))
          .map((key) => ({ key, label: fieldLabels.get(key)! }))
        : [];`,
      'readiness projection fixture',
    ),
    /must execute its locked direct statement exactly once/,
  );
  const handlerSource = `
    registerPluginTool('trackly_get_apply_readiness', { outputSchema: readinessOutputSchema }, wrapTool(async () => {
      return privateProjection;
    }, 'Fixture failure'));
  `;
  const [registration] = activeToolRegistrations(
    handlerSource,
    'registerPluginTool',
    'readiness handler fixture',
  );
  assert.throws(
    () => assertWrappedHandlerDirectStatementAst(
      registration,
      `return projectApplyReadiness({
        schema: value(schemaResult),
        profileResponse: value(profileResult),
      });`,
      'readiness handler fixture',
    ),
    /must execute its locked direct statement exactly once/,
  );
});

test('progress and stop contracts reject widened branches and success-only lifecycle decoys', () => {
  const expectedProgressInput = `z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('resume_parked'),
      explicitUserResume: z.literal(true),
    }).strict(),
    z.object({
      operation: z.literal('record_observations'),
      observations: z.array(observationSchema).min(1).max(20),
    }).strict(),
  ])`;
  const progressSource = `
    registerPluginTool('trackly_report_apply_progress', {
      /* inputSchema: ${expectedProgressInput}, */
      inputSchema: z.discriminatedUnion('operation', [
        z.object({ operation: z.literal('resume_parked'), explicitUserResume: z.boolean() }),
        z.object({ operation: z.literal('record_observations'), answers: z.array(z.unknown()) }),
      ]),
    }, handler);
  `;
  const [progress] = activeToolRegistrations(
    progressSource,
    'registerPluginTool',
    'progress schema fixture',
  );
  const progressProperties = Object.fromEntries(
    progress.call.arguments[1].properties.map((property) => [property.key.name, property.value]),
  );
  assert.throws(
    () => assertBabelPropertyExpression(
      progressProperties,
      'inputSchema',
      expectedProgressInput,
      'progress schema fixture',
    ),
    /inputSchema must equal/,
  );

  const stopSource = `
    registerPluginTool('trackly_stop_apply', { inputSchema }, wrapTool(
      ({ executionId }) => Promise.resolve({ success: true, executionId }),
      'Fixture failure',
    ));
  `;
  const [stop] = activeToolRegistrations(stopSource, 'registerPluginTool', 'stop handler fixture');
  assert.throws(
    () => assertWrappedHandlerAst(
      stop,
      `({ executionId, idempotencyKey, ...body }) => requestApi(
        'POST', \`/api/jobscout/apply/executions/\${executionId}/stop\`, authToken,
        body, { 'Idempotency-Key': idempotencyKey },
      )`,
      'stop handler fixture',
    ),
    /must preserve its complete locked executable semantics/,
  );
});

test('start, progress, and reconciliation checks bind active endpoint control flow', () => {
  const startSource = `
    registerPluginTool('trackly_start_or_resume_apply', { inputSchema }, wrapTool(async () => {
      const page = await orchestrationRequest('GET', pagePath);
      const prepared = await orchestrationRequest(
        'POST', \`/api/jobscout/apply/batches/\${batchId}/plugin-prepare\`, body,
      );
      return prepared;
    }, 'Fixture failure'));
  `;
  const [start] = activeToolRegistrations(startSource, 'registerPluginTool', 'start endpoint fixture');
  assert.doesNotThrow(() => assertWrappedHandlerAssignedRequestEndpoint(
    start,
    'prepared',
    'POST',
    '`/api/jobscout/apply/batches/${batchId}/plugin-prepare`',
    'start endpoint fixture',
    { afterBindingName: 'page', calleeName: 'orchestrationRequest' },
  ));
  const [wrongStart] = activeToolRegistrations(
    startSource.replace('/plugin-prepare', '/wrong-prepare'),
    'registerPluginTool',
    'wrong start endpoint fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAssignedRequestEndpoint(
      wrongStart,
      'prepared',
      'POST',
      '`/api/jobscout/apply/batches/${batchId}/plugin-prepare`',
      'wrong start endpoint fixture',
      { afterBindingName: 'page', calleeName: 'orchestrationRequest' },
    ),
    /live prepared request.*must target/s,
  );
  const startFlowSource = `
    registerPluginTool('trackly_start_or_resume_apply', { inputSchema }, wrapTool(async ({ target, idempotencyKey }) => {
      const started = await orchestrationRequest(
        'POST', '/api/jobscout/apply/executions',
        { mode: 'complete_next_n_accessible', target },
        { 'Idempotency-Key': idempotencyKey },
      );
      startResult = projectApplyStartResult(started, target, {
        resumed: false, started: true, targetMismatch: false,
      });
      let execution = await orchestrationRequest(
        'GET', \`/api/jobscout/apply/executions/\${startResult.executionId}\`,
      );
      let batchId = readinessCount(execution?.execution?.unresolvedWaves?.[0]?.batchId);
      const page = await orchestrationRequest(
        'GET', \`/api/jobscout/apply/batches/\${batchId}?limit=\${APPLY_EXECUTION_MAX_TARGET}\`,
      );
      const prepared = await orchestrationRequest(
        'POST', \`/api/jobscout/apply/batches/\${batchId}/plugin-prepare\`,
        { expectedRevision: page?.batch?.revision },
        { 'Idempotency-Key': \`\${idempotencyKey}:prepare\` },
      );
      return prepared;
    }, 'Fixture failure'));
  `;
  const [startFlow] = activeToolRegistrations(
    startFlowSource,
    'registerPluginTool',
    'start data-flow fixture',
  );
  const prepareSequence = `const page = await orchestrationRequest(
    'GET', \`/api/jobscout/apply/batches/\${batchId}?limit=\${APPLY_EXECUTION_MAX_TARGET}\`,
  );
  const prepared = await orchestrationRequest(
    'POST', \`/api/jobscout/apply/batches/\${batchId}/plugin-prepare\`,
    { expectedRevision: page?.batch?.revision },
    { 'Idempotency-Key': \`\${idempotencyKey}:prepare\` },
  );`;
  assert.doesNotThrow(() => assertWrappedHandlerStatementSequenceAst(
    startFlow,
    prepareSequence,
    'start data-flow fixture',
  ));
  const [wrongStartFlow] = activeToolRegistrations(
    startFlowSource.replace('page?.batch?.revision', 'staleRevision'),
    'registerPluginTool',
    'wrong start data-flow fixture',
  );
  assert.throws(
    () => assertWrappedHandlerStatementSequenceAst(
      wrongStartFlow,
      prepareSequence,
      'wrong start data-flow fixture',
    ),
    /must execute its locked data-flow statement sequence exactly once/,
  );

  const progressSource = `
    registerPluginTool('trackly_report_apply_progress', { inputSchema }, wrapTool(async (params) => {
      if (params.operation === 'record_observations') {
        const response = await requestApi(
          'POST', '/api/jobscout/apply/plugin-observations/bulk', authToken, body,
        );
        return response;
      }
      const response = await requestApi('POST', mutationPath, authToken, body);
      const renewedWork = await requestApi(
        'POST', \`/api/jobscout/apply/executions/\${executionId}/plugin-work\`, authToken, {},
      );
      return renewedWork;
    }, 'Fixture failure'));
  `;
  const [progressRegistration] = activeToolRegistrations(
    progressSource,
    'registerPluginTool',
    'progress endpoint fixture',
  );
  assert.doesNotThrow(() => assertWrappedHandlerAssignedRequestEndpoint(
    progressRegistration,
    'response',
    'POST',
    "'/api/jobscout/apply/plugin-observations/bulk'",
    'progress endpoint fixture',
    { guardExpression: "params.operation === 'record_observations'" },
  ));
  assert.doesNotThrow(() => assertWrappedHandlerAssignedRequestEndpoint(
    progressRegistration,
    'renewedWork',
    'POST',
    '`/api/jobscout/apply/executions/${executionId}/plugin-work`',
    'progress endpoint fixture',
    { afterBindingName: 'response' },
  ));
  const [wrongObservation] = activeToolRegistrations(
    progressSource.replace('/plugin-observations/bulk', '/wrong-observations'),
    'registerPluginTool',
    'wrong observation endpoint fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAssignedRequestEndpoint(
      wrongObservation,
      'response',
      'POST',
      "'/api/jobscout/apply/plugin-observations/bulk'",
      'wrong observation endpoint fixture',
      { guardExpression: "params.operation === 'record_observations'" },
    ),
    /live response request.*must target/s,
  );
  const [wrongRenewal] = activeToolRegistrations(
    progressSource.replace('/plugin-work', '/wrong-work'),
    'registerPluginTool',
    'wrong renewal endpoint fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAssignedRequestEndpoint(
      wrongRenewal,
      'renewedWork',
      'POST',
      '`/api/jobscout/apply/executions/${executionId}/plugin-work`',
      'wrong renewal endpoint fixture',
      { afterBindingName: 'response' },
    ),
    /live renewedWork request.*must target/s,
  );

  const reconcileSource = `
    registerPluginTool('trackly_reconcile_manual_submission', { inputSchema }, wrapTool(({ runId, idempotencyKey, ...body }) =>
      requestApi(
        'POST',
        \`/api/jobscout/apply/runs/\${runId}/plugin-manual-submission\`,
        authToken,
        body,
        { 'Idempotency-Key': wrongKey },
      )
    , 'Fixture failure'));
  `;
  const [reconcile] = activeToolRegistrations(
    reconcileSource,
    'registerPluginTool',
    'reconcile endpoint fixture',
  );
  assert.throws(
    () => assertWrappedHandlerAst(
      reconcile,
      `({ runId, idempotencyKey, ...body }) => requestApi(
        'POST',
        \`/api/jobscout/apply/runs/\${runId}/plugin-manual-submission\`,
        authToken,
        body,
        { 'Idempotency-Key': idempotencyKey },
      )`,
      'reconcile endpoint fixture',
    ),
    /must preserve its complete locked executable semantics/,
  );
});

test('conditional scope verification compares active function branch semantics', () => {
  const expected = `
    function requiredScopesForPluginToolCall(toolName, input) {
      const required = requiredScopesForPluginTool(toolName);
      if (toolName === 'trackly_update_status' && input.action === 'applied') {
        required.push('apply:write');
      }
      return required;
    }
  `;
  const valid = expected.replace('function requiredScopesForPluginToolCall', 'export function requiredScopesForPluginToolCall');
  assert.doesNotThrow(() => assertActiveFunctionDefinitionAst(
    valid,
    'requiredScopesForPluginToolCall',
    expected,
    'scope fixture',
  ));
  const decoy = `
    export function requiredScopesForPluginToolCall(toolName, input) {
      // required.push('apply:write');
      const required = requiredScopesForPluginTool(toolName);
      if (toolName === 'trackly_update_status' && input.action === 'applied') {
        required.push('tracking:write');
      }
      return required;
    }
  `;
  assert.throws(
    () => assertActiveFunctionDefinitionAst(
      decoy,
      'requiredScopesForPluginToolCall',
      expected,
      'decoy scope fixture',
    ),
    /must preserve its locked executable branch semantics/,
  );
});

test('resume handoff projection supports expression handlers and excludes artifact identity', () => {
  const source = `
    registerPluginTool('trackly_prepare_resume_artifact', {
      inputSchema: z.object({}).strict(),
      outputSchema: resumeOutputSchema,
    }, wrapTool(async () => ({
      view: 'resume' as const,
      success: true,
      requiresLocalAgentOrManualUpload: true,
      automaticEmployerAttachment: false as const,
      noSubmit: true as const,
    }), 'Fixture failure'));
  `;
  const [registration] = activeToolRegistrations(source, 'registerPluginTool', 'resume fixture');
  assert.deepEqual(
    canonicalSchemaAst(registrationDescriptorPropertyAst(
      source,
      registration,
      'inputSchema',
      'resume fixture',
    )),
    canonicalSchemaAst(parseSchemaExpression(
      'const expected = z.object({}).strict();',
      'expected',
      'expected resume input fixture',
    )),
  );
  const properties = wrappedHandlerReturnedObjectProperties(registration, 'resume fixture');
  assert.deepEqual(Object.keys(properties), [
    'view',
    'success',
    'requiresLocalAgentOrManualUpload',
    'automaticEmployerAttachment',
    'noSubmit',
  ]);
  assertBabelPropertyExpression(
    properties,
    'requiresLocalAgentOrManualUpload',
    'true',
    'resume fixture',
  );
  assert.throws(
    () => assertExactSchemaProperties(properties, {
      view: "'resume' as const",
      success: 'true',
      requiresLocalAgentOrManualUpload: 'true',
      automaticEmployerAttachment: 'false as const',
      noSubmit: 'true as const',
      resumeUrl: 'resume.url',
    }, 'resume fixture'),
    /must publish only its locked fields/,
  );
});

test('schema property extraction ignores stale property text in comments', () => {
  const properties = schemaObjectPropertyAsts(`
    const readinessOutputSchema = z.object({
      profile: z.object({
        // missingRequired: z.array(profileFieldReferenceSchema),
        missingRequired: z.array(profileFieldReferenceSchema).max(100),
        /* availableFields: z.any(), */
        availableFields: z.array(profileFieldReferenceSchema).max(100),
      }).strict(),
    }).strict();
  `, 'readinessOutputSchema', 'readiness fixture');

  assert.deepEqual(Object.keys(properties), ['profile']);
  assert.equal(properties.profile.type, 'CallExpression');

  const referenceProperties = schemaObjectPropertyAsts(`
    const profileFieldReferenceSchema = z.object({
      key: z.string().min(1).max(200),
      label: z.string().min(1).max(1000),
      value: z.string(),
    }).strict();
  `, 'profileFieldReferenceSchema', 'extra profile field fixture');
  assert.throws(
    () => assertExactSchemaProperties(referenceProperties, {
      key: 'z.string().min(1).max(200)',
      label: 'z.string().min(1).max(1000)',
    }, 'profileFieldReferenceSchema'),
    /must publish only its locked fields/,
  );
});

test('importing executable digest helpers never runs hosted verification as a side effect', () => {
  const { spawnSync } = require('node:child_process');
  const verifierPath = path.join(ROOT, 'scripts', 'verify-hosted-contract.js');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(verifierPath)})`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TRACKLY_BACKEND_DIR: '/definitely/not/a/backend',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('schema AST canonicalization ignores parser positions but preserves literal semantics', () => {
  const formatted = parseSchemaExpression(
    'const example = z.string().regex(/a b/i);',
    'example',
    'formatted fixture',
  );
  const repositioned = parseSchemaExpression(
    'const example =\n  z.string().regex(/a b/i);',
    'example',
    'repositioned fixture',
  );
  const changedPattern = parseSchemaExpression(
    'const example = z.string().regex(/ab/i);',
    'example',
    'changed-pattern fixture',
  );
  const changedFlags = parseSchemaExpression(
    'const example = z.string().regex(/a b/g);',
    'example',
    'changed-flags fixture',
  );
  const approvedLiteral = parseSchemaExpression(
    "const example = z.literal('approved');",
    'example',
    'approved-literal fixture',
  );
  const notApplicableLiteral = parseSchemaExpression(
    "const example = z.literal('not_applicable');",
    'example',
    'not-applicable-literal fixture',
  );

  assert.deepEqual(canonicalSchemaAst(formatted), canonicalSchemaAst(repositioned));
  assert.notDeepEqual(canonicalSchemaAst(formatted), canonicalSchemaAst(changedPattern));
  assert.notDeepEqual(canonicalSchemaAst(formatted), canonicalSchemaAst(changedFlags));
  assert.notDeepEqual(canonicalSchemaAst(approvedLiteral), canonicalSchemaAst(notApplicableLiteral));
  assert.deepEqual(
    referencedConstantIdentifiers(parseSchemaExpression(
      'const example = z.enum(EXISTING_CONSTANT).refine((value) => value === OTHER_CONSTANT);',
      'example',
      'constant-reference fixture',
    )),
    ['EXISTING_CONSTANT', 'OTHER_CONSTANT'],
  );
  assert.throws(
    () => parseSchemaExpression(
      'const example = z.string() unexpected;',
      'example',
      'trailing-bytes fixture',
    ),
    /Could not parse trailing-bytes fixture as executable JavaScript\/TypeScript/,
  );
});

test('free dependency audit is naming-agnostic and ignores callback bindings', () => {
  const schema = parseSchemaExpression(`
    const example = z.object({
      country: iso3166Alpha2Schema,
      idempotencyKey: z.string().regex(SAFE_IDEMPOTENCY_KEY),
    }).superRefine((value, context) => {
      if (value.country === 'US') context.addIssue({ code: z.ZodIssueCode.custom });
    });
  `, 'example', 'lower-camel dependency fixture');
  assert.deepEqual(
    referencedFreeIdentifiers(schema),
    ['SAFE_IDEMPOTENCY_KEY', 'iso3166Alpha2Schema', 'z'],
  );

  const local = 'const iso3166Alpha2Schema = z.string().length(2);';
  const hosted = 'const iso3166Alpha2Schema = z.string().length(3);';
  assert.notDeepEqual(
    canonicalSchemaAst(activeNamedDefinitionAst(local, 'iso3166Alpha2Schema', 'local helper fixture')),
    canonicalSchemaAst(activeNamedDefinitionAst(hosted, 'iso3166Alpha2Schema', 'hosted helper fixture')),
    'divergent lower-camel helper definitions must remain visible to parity checks',
  );

  const identifiers = ['$dollar', 'ALL_CAPS', 'PascalCase', '_private', 'camelCase'];
  assert.deepEqual(
    classifyFreeIdentifiers(identifiers, {
      runtimeGlobal: ['$dollar'],
      sharedDefinition: ['PascalCase', '_private', 'camelCase'],
      contractConstant: ['ALL_CAPS'],
    }, 'mixed-name fixture'),
    {
      $dollar: 'runtimeGlobal',
      ALL_CAPS: 'contractConstant',
      PascalCase: 'sharedDefinition',
      _private: 'sharedDefinition',
      camelCase: 'sharedDefinition',
    },
  );
  assert.throws(
    () => classifyFreeIdentifiers(['unclassifiedName'], { runtimeGlobal: ['z'] }, 'failure fixture'),
    /dependency unclassifiedName is unclassified/,
  );
});

test('named local and hosted Apply schemas have collision-free exact-byte locks', () => {
  const lock = json('plugins/trackly/skill-lock.json');
  const namedLocks = lock.publicExecutableContract.namedApplySchemaSha256;
  const localSchemaNames = [
    'applyExecutionDispositionSchema',
    'startApplyRunInputSchema',
    'startApplyRunSchema',
    'truthCertificationCommon',
    'truthCertificationInputSchema',
    'truthCertificationSchema',
  ];
  const hostedSchemaNames = [
    'applyExecutionDispositionSchema',
    'startApplyRunSchema',
    'truthCertificationCommon',
    'truthCertificationSchema',
  ];

  assert.deepEqual(Object.keys(namedLocks).sort(), ['hostedMcpServer', 'localMcpApplyTools']);
  assert.deepEqual(Object.keys(namedLocks.localMcpApplyTools).sort(), localSchemaNames);
  assert.deepEqual(Object.keys(namedLocks.hostedMcpServer).sort(), hostedSchemaNames);
  assert.ok(
    Object.values(namedLocks).flatMap(Object.values).every((digest) => /^[a-f0-9]{64}$/.test(digest)),
  );

  const localApplySource = read('mcp/apply-tools.js');
  for (const schemaName of localSchemaNames) {
    const definition = exactSchemaDefinition(localApplySource, schemaName, 'mcp/apply-tools.js');
    assert.equal(sha256ExactBytes(definition), namedLocks.localMcpApplyTools[schemaName]);
    const changedSource = localApplySource.replace(definition, definition.replace(/;$/, '\n;'));
    assert.notEqual(
      sha256ExactBytes(exactSchemaDefinition(changedSource, schemaName, 'changed mcp/apply-tools.js')),
      namedLocks.localMcpApplyTools[schemaName],
      `${schemaName} lock must change when verifier-visible definition bytes change`,
    );
  }
});

test('every transitive Apply schema constant is audited, locked, and semantically resolved', () => {
  const lock = json('plugins/trackly/skill-lock.json');
  const dependencyLocks = lock.publicExecutableContract.namedApplyDependencySha256;
  assert.deepEqual(Object.keys(dependencyLocks).sort(), [
    'hostedApplyExecutionContract',
    'hostedMcpServer',
    'localMcpApplyTools',
  ]);
  assert.deepEqual(Object.keys(dependencyLocks.localMcpApplyTools).sort(), [
    'APPLY_BROWSER_SURFACES',
    'APPLY_EXECUTION_ACCESS_CLASSIFICATIONS',
    'APPLY_EXECUTION_DISPOSITION_SOURCES',
    'SAFE_IDEMPOTENCY_KEY',
  ]);
  assert.deepEqual(Object.keys(dependencyLocks.hostedMcpServer), ['SAFE_IDEMPOTENCY_KEY']);
  assert.deepEqual(Object.keys(dependencyLocks.hostedApplyExecutionContract).sort(), [
    'APPLY_BROWSER_SURFACES',
    'APPLY_EXECUTION_ACCESS_CLASSIFICATIONS',
    'APPLY_EXECUTION_DISPOSITION_SOURCES',
  ]);
  assert.ok(
    Object.values(dependencyLocks).flatMap(Object.values)
      .every((digest) => /^[a-f0-9]{64}$/.test(digest)),
  );
});

function validateAppBinding(manifest, appConfig) {
  const hasManifestBinding = Object.hasOwn(manifest, 'apps');
  assert.equal(hasManifestBinding, appConfig !== null, 'manifest and .app.json binding must appear together');
  if (appConfig === null) return;
  assert.equal(manifest.apps, './.app.json');
  assert.deepEqual(Object.keys(appConfig), ['apps']);
  assert.deepEqual(Object.keys(appConfig.apps), ['trackly']);
  assert.deepEqual(Object.keys(appConfig.apps.trackly), ['id']);
  assert.match(appConfig.apps.trackly.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/);
  assert.doesNotMatch(appConfig.apps.trackly.id, /\.\.\.|replace|placeholder|todo/i);
}

function validateBrandAsset(manifest, provenance, packagedBytes) {
  const manifestPath = `./${provenance.packagedAsset}`;
  assert.equal(manifest.interface.composerIcon, manifestPath);
  assert.equal(manifest.interface.logo, manifestPath);
  assert.equal(manifest.interface.logoDark, manifestPath);
  assert.match(provenance.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.forbiddenReplacement, /Purple Orb/);

  if (provenance.packagedAsset.endsWith('.png')) {
    assert.deepEqual(packagedBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(sha256(packagedBytes), provenance.sourceSha256);
    assert.equal(provenance.byteIdenticalToSource, true);
    assert.equal(provenance.pixelIdenticalToSource, true);
    assert.equal(provenance.visualApprovalRequired, false);
    assert.match(provenance.treatment, /exact approved PNG/i);
    return;
  }

  assert.match(provenance.packagedAsset, /\.svg$/);
  assert.match(provenance.packagedSha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256(packagedBytes), provenance.packagedSha256);
  assert.equal(provenance.byteIdenticalToSource, false);
  assert.equal(provenance.pixelIdenticalToSource, false);
  assert.equal(provenance.visualApprovalRequired, true);
  assert.match(provenance.treatment, /vector approximation/);
  assert.match(provenance.approvalRequirement, /Kevin must compare/);
  const svg = packagedBytes.toString('utf8');
  assert.match(svg, /<rect[^>]+fill="#000"/);
  assert.match(svg, /<path[^>]+fill="#fff"/);
  assert.doesNotMatch(svg, /purple|#[a-f0-9]{0,2}(?:7c3aed|8b5cf6|a855f7)/i);
}

test('plugin manifest is complete, lowercase, and uses the official trackly brand', () => {
  const manifest = json('plugins/trackly/.codex-plugin/plugin.json');
  const metadata = json('plugins/trackly/listing/metadata.json');
  assert.equal(manifest.name, metadata.pluginName);
  assert.equal(manifest.description, metadata.shortDescription);
  assert.equal(manifest.interface.displayName, metadata.pluginName);
  assert.equal(manifest.interface.developerName, metadata.pluginName);
  assert.equal(manifest.interface.shortDescription, 'Real-time job search and application filling');
  assert.equal(manifest.interface.privacyPolicyURL, metadata.privacyPolicyURL);
  assert.equal(manifest.interface.termsOfServiceURL, metadata.termsOfServiceURL);
  assert.equal(manifest.interface.brandColor, '#000000');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  const appPath = path.join(PLUGIN, '.app.json');
  validateAppBinding(manifest, fs.existsSync(appPath) ? JSON.parse(fs.readFileSync(appPath, 'utf8')) : null);
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  assert.ok(manifest.interface.defaultPrompt.every((prompt) => prompt.length <= 128));
  for (const key of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    assert.match(manifest.interface[key], /^https:\/\//);
  }
});

test('remote MCP uses the dedicated public facade and exact OAuth resource', () => {
  const config = json('plugins/trackly/.mcp.json');
  const metadata = json('plugins/trackly/listing/metadata.json');
  assert.deepEqual(Object.keys(config.mcpServers), ['trackly']);
  const server = config.mcpServers.trackly;
  const expected = metadata.productionMcpURL;
  assert.equal(server.type, 'http');
  assert.equal(server.url, expected);
  assert.equal(server.oauth_resource, expected);
  assert.notEqual(server.url, 'https://mcp.usetrackly.app/api/mcp');
  for (const yamlPath of [
    'plugins/trackly/skills/trackly/agents/openai.yaml',
    'plugins/trackly/skills/trackly-apply/agents/openai.yaml',
  ]) {
    assert.match(read(yamlPath), new RegExp(`url: "${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
});

test('repo marketplace exposes the canonical plugin with explicit install policy', () => {
  const marketplace = json('.agents/plugins/marketplace.json');
  assert.equal(marketplace.name, 'trackly-cli');
  assert.equal(marketplace.interface.displayName, 'trackly');
  assert.deepEqual(marketplace.plugins, [{
    name: 'trackly',
    source: { source: 'local', path: './plugins/trackly' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  }]);
  assert.ok(fs.existsSync(PLUGIN));
});

test('derived brand asset is traceable without claiming source identity', () => {
  const manifest = json('plugins/trackly/.codex-plugin/plugin.json');
  const provenance = json('plugins/trackly/assets/brand-source.json');
  assert.equal(provenance.brand, 'trackly');
  assert.equal(
    provenance.sourceSha256,
    '8aa1b351cbc1ab62c8a178838403b706954c3b73109871c054c5b286bbf73ff2',
  );
  const packagedPath = path.join(PLUGIN, provenance.packagedAsset);
  assert.ok(fs.existsSync(packagedPath));
  validateBrandAsset(manifest, provenance, fs.readFileSync(packagedPath));
});

test('brand validation accepts the exact approved PNG replacement state', () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('approved-trackly-fixture')]);
  const packagedAsset = 'assets/trackly-appicon.png';
  validateBrandAsset({
    interface: {
      composerIcon: `./${packagedAsset}`,
      logo: `./${packagedAsset}`,
      logoDark: `./${packagedAsset}`,
    },
  }, {
    packagedAsset,
    sourceSha256: sha256(png),
    treatment: 'Exact approved PNG source bytes.',
    byteIdenticalToSource: true,
    pixelIdenticalToSource: true,
    visualApprovalRequired: false,
    forbiddenReplacement: 'Purple Orb composer icon',
  }, png);
});

test('app binding validation accepts a real future registered state', () => {
  validateAppBinding({ apps: './.app.json' }, {
    apps: { trackly: { id: 'app_trackly_prod_7H3K9' } },
  });
});

test('public skills reference only the locked 18-tool facade', () => {
  const lock = json('plugins/trackly/skill-lock.json');
  const actual = referencedTools(path.join(PLUGIN, 'skills'));
  assert.equal(lock.publicToolAllowlist.length, 18);
  assert.equal(lock.hostedMcpToolAllowlist.length, 47);
  assert.equal(new Set(lock.hostedMcpToolAllowlist).size, 47);
  assert.deepEqual(actual, [...lock.publicToolAllowlist].sort());
  assert.ok(!actual.some((name) => name.includes('referral')));
  assert.deepEqual(lock.publicLifecycleContract, {
    readinessMissingProfileFields: 'canonical_key_and_public_label_only',
    readinessAvailableProfileFields: 'saved_canonical_key_and_public_label_only',
    startOrResume: 'returns_claimed_batch_bound_runs',
    readinessSections: 'independently_available_with_explicit_availability',
    readinessCardAvailability: 'unavailable_sections_never_render_as_saved_state',
    readinessQueueCount: 'page_count_with_has_more_lower_bound',
    leaseHandling: 'facade_owned_never_model_visible',
    leaseRenewal: 'facade_owned_on_every_work_and_mutation_path',
    waveLeaseRecovery: 'claim_unleased_or_renew_same_facade_lease',
    surfaceBinding: 'value_free_via_report_progress_with_facade_owned_lease_and_concurrency_receipt',
    parkedMemberResume: 'explicit_user_assertion_via_report_progress_with_idempotent_value_free_receipt',
    observationBulk: 'atomic_grant_bound_idempotent_replay',
    profileEducation: 'bounded_explicitly_confirmed_user_approved_replace_all',
    advanceReceipt: 'returns_prepared_batch_and_member_ids',
    applyWorkOutput: 'discriminated_allowlisted_structured_content',
    applyWorkProfileProjection: 'requested_fields_and_resume_availability_boolean_only',
    applyWorkNavigation: 'bounded_frozen_requisition_identity_with_server_verified_origin_and_tenant_policy',
    conditionalSensitiveScopes: 'required_only_for_requested_sensitive_fields',
    appliedStatusScope: 'tracking_write_plus_apply_write_for_run_reconciliation',
    jobBriefRecentPosts: 'validated_posted_at_only',
    resumeHandling: 'manual_unbound_not_attested',
    certifyReviewReady: 'atomic_checkpoint_truth_outcome_manual_resume_unbound',
    reconcileManualSubmission: 'atomic_current_epoch_evidence_outcome',
    submissionBoundary: 'manual_only_no_submit_tool',
  });
  assert.deepEqual(Object.keys(lock.publicScopeContract).sort(), [...lock.publicToolAllowlist].sort());
  assert.deepEqual(
    lock.publicScopeContract.trackly_get_apply_work,
    ['profile:read', 'apply:read', 'apply:write'],
  );
  assert.deepEqual(
    Object.keys(lock.publicExecutableContract.descriptorSha256).sort(),
    [...lock.publicToolAllowlist].sort(),
  );
  assert.ok(Object.values(lock.publicExecutableContract.descriptorSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.deepEqual(
    Object.keys(lock.publicExecutableContract.handlerSha256).sort(),
    [...lock.publicToolAllowlist].sort(),
  );
  assert.ok(Object.values(lock.publicExecutableContract.handlerSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.match(lock.publicExecutableContract.pluginServerSha256, /^[a-f0-9]{64}$/);
  assert.match(lock.publicExecutableContract.pluginScopesSha256, /^[a-f0-9]{64}$/);
  assert.match(lock.publicExecutableContract.jobBriefServiceSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(lock.publicExecutableContract.schemaSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.ok(Object.values(lock.publicExecutableContract.transitiveSchemaSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.ok(Object.values(lock.publicExecutableContract.namedApplySchemaSha256).flatMap(Object.values).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.ok(Object.hasOwn(lock.publicExecutableContract.transitiveSchemaSha256, 'APPLY_BROWSER_SURFACES'));
  assert.ok(Object.hasOwn(lock.publicExecutableContract.transitiveSchemaSha256, 'APPLY_EXECUTION_MEMBER_OPERATIONS'));
});

test('adapted trackly Apply skill is traceable to its source and safety invariants', () => {
  const lock = json('plugins/trackly/skill-lock.json');
  const skill = read('plugins/trackly/skills/trackly-apply/SKILL.md');
  const lifecycle = read('plugins/trackly/skills/trackly-apply/references/lifecycle-contract.md');
  const handoff = read('plugins/trackly/skills/trackly-apply/references/review-handoff.md');
  assert.equal(lock.source.treeSha256, treeSha256(path.join(ROOT, lock.source.path)));
  assert.equal(lock.adapted.treeSha256, treeSha256(path.join(ROOT, lock.adapted.path)));
  assert.match(
    skill,
    /`reasonCode: execution_restarted`/,
  );

  assert.match(skill, /^---\nname: trackly-apply\n/);
  assert.match(skill, /Never activate the final Submit control/);
  assert.match(skill, /jobs the user approved/);
  assert.match(skill, /Never invent identity, legal, immigration/);
  assert.match(skill, /exact frozen company, title, requisition URL, verified ATS provider and tenant/);
  assert.match(skill, /CAPTCHA, OTP, login credentials, account creation/);
  assert.match(skill, /visible success state or the user's explicit confirmation/);
  assert.match(skill, /requiresLocalAgentOrManualUpload/);
  assert.match(skill, /profile\.missingRequired/);
  assert.match(skill, /profile\.availableFields/);
  assert.match(skill, /matching `availability` flag is true/);
  assert.match(skill, /`queue\.pageCount` is only the returned page count/);
  assert.match(skill, /strict projection: only requested profile fields may appear/);
  assert.match(skill, /resume data is reduced to availability booleans/);
  assert.match(skill, /additionally requires sensitive read permission/);
  assert.match(skill, /additionally requires sensitive write permission/);
  assert.match(skill, /`operation: bind_surface`/);
  assert.match(skill, /receipt matches that member, run, version, and inspection epoch/);
  assert.match(skill, /prepared next-wave receipt/);
  assert.match(skill, /frozen `navigation\.requisitionUrl`/);
  assert.match(skill, /verified ATS provider and tenant/);
  assert.match(skill, /Revalidate both origin and tenant after every redirect/);
  assert.match(skill, /`operation: resume_parked`/);
  assert.match(skill, /`explicitUserResume: true`/);
  assert.match(skill, /Never infer or auto-resume parked work/);
  assert.match(skill, /never send a snapshot/);
  assert.match(skill, /Before any form mutation, require a verified end-to-end preservation path/);
  assert.match(skill, /complete current controller-owned and user-owned tab inventories/);
  assert.match(skill, /Before ending every browser turn/);
  assert.match(skill, /explicit keep list with `status: handoff`/);
  assert.match(skill, /durably hand off every live tab and verify every receipt/);
  assert.match(skill, /Never silently send a complete draft or multiple fields/);
  assert.match(skill, /one non-sensitive field at a time/);
  assert.match(skill, /exact field label and exact proposed text/);
  assert.match(skill, /process that text transiently without logging, storing, or echoing it/);
  assert.match(skill, /Call the tool with exactly one `items` entry only after that approval/);
  assert.match(skill, /Approval for one field never covers another field or later revision/);
  assert.match(skill, /use local length\/required checks plus manual user review as the fallback/);

  const writing = read('plugins/trackly/skills/trackly-apply/references/application-writing.md');
  assert.match(writing, /Keep the complete draft local/);
  assert.match(writing, /Remote lint is optional/);
  assert.match(writing, /without logging, storing, or echoing the text/);
  assert.match(writing, /exactly one `items` entry/);
  assert.match(writing, /contact data, legal or immigration answers, credentials, demographic data, compensation data/);
  assert.match(writing, /If the user declines, does not answer, or gives ambiguous approval, do not call remote lint/);
  assert.match(writing, /local required\/minimum\/maximum-length checks/);

  assert.match(lifecycle, /matching `availability` flag is true/);
  assert.match(lifecycle, /strictly projects the result to those requested keys/);
  assert.match(lifecycle, /`operation: bind_surface`/);
  assert.match(lifecycle, /authoritative next-wave receipt/);
  assert.match(lifecycle, /server-verified origin and ATS-tenant policy/);
  assert.match(lifecycle, /Resume a parked member only after an explicit user request/);

  const discoverySkill = read('plugins/trackly/skills/trackly/SKILL.md');
  assert.match(discoverySkill, /validated posting-date signals only/);
  assert.match(discoverySkill, /never substitute first-seen time for a posting date/);
  assert.match(discoverySkill, /Marking a job `applied` additionally requires Apply write permission/);
  assert.match(discoverySkill, /never use it to infer or claim submission/);

  const browserSafety = read('plugins/trackly/skills/trackly-apply/references/browser-safety.md');
  assert.match(browserSafety, /tab and unsaved-draft preservation path exists before any mutation/);
  assert.match(browserSafety, /Before ending every browser turn/);
  assert.match(browserSafety, /reconcile the complete current inventory/);
  assert.match(browserSafety, /verify each exact persistence receipt/);
  assert.match(browserSafety, /server-verified authorized origins, host suffixes, verified provider\/tenant, and tenant rule/);
  assert.match(browserSafety, /both origin and ATS tenant were revalidated/);
  assert.match(skill, /`nextAction: use_active_target`/);
  assert.match(skill, /`nextAction: advance_or_refresh`/);
  assert.match(skill, /only that minimal intersection as `profileKeys`/);
  assert.match(skill, /For every distinct `jobId` in the bound snapshot, call `trackly_get_job`/);
  assert.match(skill, /atomically records the review checkpoint, truth certification, and review-ready outcome/);
  assert.match(skill, /atomically records typed confirmation evidence and the submitted outcome/);
  assert.match(skill, /keep that browser-local upload explicitly unbound and outside the truth certification/);
  assert.match(skill, /There is no generic heartbeat operation/);
  assert.match(skill, /only when one of its supported lifecycle operations actually occurs/);
  assert.doesNotMatch(skill, /at least once every 60 seconds during active browser work/);
  assert.match(skill, /`nextAction: complete`/);
  assert.match(skill, /`nextAction: manual_review`/);
  assert.match(skill, /first pass for every mutable member in the current bound wave/);
  assert.match(skill, /Wait until the advertised retry time or estimated return time before one work refetch/);
  assert.match(browserSafety, /verify only the filename visibly committed/);
  assert.match(browserSafety, /never claim an artifact identity, preview, or hash exists/);
  assert.match(lifecycle, /at most 100 `\{ key, label \}` records each/);
  assert.match(lifecycle, /`profile\.availableFields`/);
  assert.match(lifecycle, /snapshot `profileKeys`/);
  assert.match(lifecycle, /Never call a snapshot with empty `memberIds`/);
  assert.match(lifecycle, /call `trackly_get_job` for every distinct `jobId`/);
  assert.match(lifecycle, /`executionId`, `revision`, `batchId`, `memberIds`, and `nextAction`/);
  assert.match(lifecycle, /No public tool accepts or returns a lease token/);
  assert.match(lifecycle, /`knownFieldsCommitted: true`/);
  assert.match(lifecycle, /`explicitUserTruthConfirmed: true`/);
  assert.match(lifecycle, /`answerSnapshotHash`/);
  assert.match(lifecycle, /`wordingFingerprint`/);
  assert.match(lifecycle, /literal `resumeDependency: not_applicable`/);
  assert.match(lifecycle, /manually uploaded resume is browser-local, unbound, and not attested/);
  assert.doesNotMatch(lifecycle, /explicitUserResumeApproved/);
  assert.match(lifecycle, /`browserBindingHash`/);
  assert.match(lifecycle, /`evidenceFingerprint`/);
  assert.match(lifecycle, /Do not send server-owned internals, resume IDs, filenames, paths, contents, download URLs, or answer values/);
  assert.match(handoff, /filename check does not bind or attest the browser-local bytes/);
  assert.match(handoff, /verified preservation receipt and user-visible reachability proof/);
  assert.match(handoff, /Inventory membership alone is not visibility proof/);
  assert.match(handoff, /Before manual submission/);
  assert.match(handoff, /leave only those certified tabs at review/);
  assert.match(handoff, /exclude that reconciled member from any later review handoff/);
  assert.match(handoff, /Never tell the user to submit an already reconciled member/);
});

test('submission fixtures cover six positive and three negative cases', () => {
  const fixtures = json('plugins/trackly/listing/submission-tests.json');
  const lock = json('plugins/trackly/skill-lock.json');
  const allowedTools = new Set(lock.publicToolAllowlist);
  assert.equal(fixtures.positive.length, 6);
  assert.equal(fixtures.negative.length, 3);
  assert.equal(new Set([...fixtures.positive, ...fixtures.negative].map((item) => item.id)).size, 9);
  assert.match(fixtures.reviewEnvironment.account, /synthetic reviewer account/i);
  assert.match(fixtures.reviewEnvironment.submissionPolicy, /No fixture may submit/);
  assert.doesNotMatch(JSON.stringify(fixtures), /\b(?:Kevin|Astuhuaman)\b/i, 'submission fixtures must not leak a real reviewer identity');
  for (const item of fixtures.positive) {
    assert.ok(item.fixture);
    assert.ok(item.expectedResultShape.length > 0);
    assert.ok(item.expected.every((tool) => allowedTools.has(tool)), `${item.id} references an unlisted tool`);
  }
  const monitored = fixtures.positive.find((item) => item.id === 'search-monitored-remote');
  assert.deepEqual(monitored.turns.map((turn) => turn.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(
    monitored.turns.map((turn) => turn.expected || []),
    [[], ['trackly_search_jobs'], [], ['trackly_update_status', 'trackly_update_status']],
  );
  assert.match(monitored.turns[2].content, /4101 and 4103/);
  assert.match(monitored.turns[3].content, /job 4101 once and fixture job 4103 once/);
  assert.deepEqual(
    monitored.expected,
    ['trackly_search_jobs', 'trackly_update_status', 'trackly_update_status'],
  );
  assert.ok(monitored.expectedResultShape.includes('userChoice.jobIds'));
  assert.ok(fixtures.negative.every((item) => item.fixture));
  assert.ok(fixtures.positive.some((item) => item.id === 'apply-to-review'));
  const applyToReview = fixtures.positive.find((item) => item.id === 'apply-to-review');
  assert.deepEqual(applyToReview.turns.map((turn) => turn.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(
    applyToReview.turns.map((turn) => turn.expected || []),
    [
      [],
      [
        'trackly_get_apply_readiness',
        'trackly_start_or_resume_apply',
        'trackly_get_apply_work',
        'trackly_get_job',
        'trackly_get_apply_work',
        'trackly_report_apply_progress',
        'trackly_prepare_resume_artifact',
        'trackly_report_apply_progress',
      ],
      [],
      [],
      [],
      ['trackly_certify_review_ready', 'trackly_get_apply_work'],
    ],
  );
  assert.deepEqual(
    applyToReview.expected,
    [
      'trackly_get_apply_readiness',
      'trackly_start_or_resume_apply',
      'trackly_get_apply_work',
      'trackly_get_job',
      'trackly_get_apply_work',
      'trackly_report_apply_progress',
      'trackly_prepare_resume_artifact',
      'trackly_report_apply_progress',
      'trackly_certify_review_ready',
      'trackly_get_apply_work',
    ],
  );
  assert.match(applyToReview.turns[1].content, /Before filling, bind each verified browser surface with operation bind_surface/);
  assert.match(applyToReview.turns[1].content, /after the first pass report value-free progress with a separate fresh idempotency key/);
  assert.match(applyToReview.turns[2].content, /attached the intended resume.*filename/s);
  assert.match(applyToReview.turns[2].content, /Synthetic-Reviewer-0001-Resume\.pdf/);
  assert.match(applyToReview.turns[4].content, /exact complete application.*truthful/s);
  assert.ok(applyToReview.turns.slice(0, 5).every((turn) => !(turn.expected || []).includes('trackly_certify_review_ready')));
  assert.match(applyToReview.turns[5].content, /immediately refetch.*only after the refetch verifies the durable review-ready handoff/s);
  assert.deepEqual(
    applyToReview.expectedResultShape,
    [
      'profile.missingRequired[].key',
      'profile.missingRequired[].label',
      'profile.availableFields[].key',
      'profile.availableFields[].label',
      'executionId',
      'batchId',
      'memberIds',
      'nextAction',
      'requiresLocalAgentOrManualUpload',
      'visibleFilenameConfirmation',
      'durableReviewReady',
      'manualSubmitRequired',
    ],
  );
  assert.deepEqual(
    fixtures.positive.find((item) => item.id === 'job-brief').expectedResultShape,
    ['jobId', 'companyName', 'companySignal.openRoleCount', 'companySignal.postedLast7d'],
  );
  assert.deepEqual(
    fixtures.positive.find((item) => item.id === 'search-recent-product').expectedResultShape,
    ['jobs[].id', 'jobs[].title', 'jobs[].companyName', 'jobs[].location', 'jobs[].jobUrl'],
  );
  assert.deepEqual(
    fixtures.positive.find((item) => item.id === 'resume-apply').expected,
    [
      'trackly_get_apply_readiness',
      'trackly_start_or_resume_apply',
      'trackly_get_apply_work',
      'trackly_get_job',
      'trackly_get_apply_work',
    ],
  );
  assert.ok(fixtures.negative.some((item) => item.id === 'no-autosubmit'));
  assert.ok(fixtures.negative.some((item) => item.id === 'no-referral-intelligence'));
  assert.ok(fixtures.negative.some((item) => item.id === 'no-fabricated-answer'));
  assert.deepEqual(
    fixtures.positive.find((item) => item.id === 'reconcile-manual-submission').expected,
    ['trackly_get_apply_work', 'trackly_reconcile_manual_submission', 'trackly_get_apply_work'],
  );
});

test('registered app binding and public submission remain explicit release gates', () => {
  const gates = read('plugins/trackly/RELEASE-GATES.md');
  assert.match(gates, /Do not invent or pre-allocate an ID/);
  assert.match(gates, /HTTP 200 response from `https:\/\/usetrackly\.app\/plugins\/trackly`/);
  assert.match(gates, /approved PNG/);
  assert.match(gates, /Kevin must approve/);
  assert.match(gates, /ask Kevin again before selecting Publish/);
});
