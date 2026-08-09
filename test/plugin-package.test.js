'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'trackly');

const { exactSchemaDefinition, sha256ExactBytes } = require('../scripts/verify-hosted-contract.js');

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

test('named local and hosted Apply schemas have collision-free exact-byte locks', () => {
  const lock = json('plugins/trackly/skill-lock.json');
  const namedLocks = lock.publicExecutableContract.namedApplySchemaSha256;
  const schemaNames = [
    'applyExecutionDispositionSchema',
    'startApplyRunSchema',
    'truthCertificationCommon',
    'truthCertificationSchema',
  ];

  assert.deepEqual(Object.keys(namedLocks).sort(), ['hostedMcpServer', 'localMcpApplyTools']);
  assert.deepEqual(Object.keys(namedLocks.localMcpApplyTools).sort(), schemaNames);
  assert.deepEqual(Object.keys(namedLocks.hostedMcpServer).sort(), schemaNames);
  assert.ok(
    Object.values(namedLocks).flatMap(Object.values).every((digest) => /^[a-f0-9]{64}$/.test(digest)),
  );

  const localApplySource = read('mcp/apply-tools.js');
  for (const schemaName of schemaNames) {
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
  assert.deepEqual(actual, [...lock.publicToolAllowlist].sort());
  assert.ok(!actual.some((name) => name.includes('referral')));
  assert.deepEqual(lock.publicLifecycleContract, {
    readinessMissingProfileFields: 'canonical_key_and_public_label_only',
    readinessAvailableProfileFields: 'saved_canonical_key_and_public_label_only',
    startOrResume: 'returns_claimed_batch_bound_runs',
    leaseHandling: 'facade_owned_never_model_visible',
    leaseRenewal: 'facade_owned_on_every_work_and_mutation_path',
    resumeHandling: 'manual_unbound_not_attested',
    certifyReviewReady: 'atomic_checkpoint_truth_outcome_manual_resume_unbound',
    reconcileManualSubmission: 'atomic_current_epoch_evidence_outcome',
    submissionBoundary: 'manual_only_no_submit_tool',
  });
  assert.deepEqual(Object.keys(lock.publicScopeContract).sort(), [...lock.publicToolAllowlist].sort());
  assert.deepEqual(
    lock.publicScopeContract.trackly_get_apply_work,
    ['profile:read', 'sensitive:read', 'apply:read', 'apply:write'],
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
  assert.ok(Object.values(lock.publicExecutableContract.schemaSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.ok(Object.values(lock.publicExecutableContract.transitiveSchemaSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.ok(Object.values(lock.publicExecutableContract.namedApplySchemaSha256).flatMap(Object.values).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  assert.ok(Object.hasOwn(lock.publicExecutableContract.transitiveSchemaSha256, 'APPLY_BROWSER_SURFACES'));
});

test('adapted trackly Apply skill is traceable to its source and safety invariants', () => {
  const lock = json('plugins/trackly/skill-lock.json');
  assert.equal(lock.source.treeSha256, treeSha256(path.join(ROOT, lock.source.path)));
  assert.equal(lock.adapted.treeSha256, treeSha256(path.join(ROOT, lock.adapted.path)));

  const skill = read('plugins/trackly/skills/trackly-apply/SKILL.md');
  assert.match(skill, /^---\nname: trackly-apply\n/);
  assert.match(skill, /Never activate the final Submit control/);
  assert.match(skill, /jobs the user approved/);
  assert.match(skill, /Never invent identity, legal, immigration/);
  assert.match(skill, /authoritative employer, exact title, job URL, provider, and authorized origin/);
  assert.match(skill, /CAPTCHA, OTP, login credentials, account creation/);
  assert.match(skill, /visible success state or the user's explicit confirmation/);
  assert.match(skill, /requiresLocalAgentOrManualUpload/);
  assert.match(skill, /profile\.missingRequired/);
  assert.match(skill, /profile\.availableFields/);
  assert.match(skill, /never send a snapshot/);
  assert.match(skill, /`nextAction: use_active_target`/);
  assert.match(skill, /`nextAction: advance_or_refresh`/);
  assert.match(skill, /only that minimal intersection as `profileKeys`/);
  assert.match(skill, /For every distinct `jobId` in the bound snapshot, call `trackly_get_job`/);
  assert.match(skill, /atomically records the review checkpoint, truth certification, and review-ready outcome/);
  assert.match(skill, /atomically records typed confirmation evidence and the submitted outcome/);
  assert.match(skill, /keep that browser-local upload explicitly unbound and outside the truth certification/);
  assert.match(skill, /at least once every 60 seconds during active browser work/);
  assert.match(skill, /first pass for every mutable member in the current bound wave/);
  assert.match(skill, /Wait until the advertised retry time or estimated return time before one work refetch/);
  const browserSafety = read('plugins/trackly/skills/trackly-apply/references/browser-safety.md');
  assert.match(browserSafety, /verify only the filename visibly committed/);
  assert.match(browserSafety, /never claim an artifact identity, preview, or hash exists/);
  const lifecycle = read('plugins/trackly/skills/trackly-apply/references/lifecycle-contract.md');
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
  const handoff = read('plugins/trackly/skills/trackly-apply/references/review-handoff.md');
  assert.match(handoff, /filename check does not bind or attest the browser-local bytes/);
  assert.match(handoff, /verified preservation receipt and user-visible reachability proof/);
  assert.match(handoff, /Inventory membership alone is not visibility proof/);
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
  assert.deepEqual(monitored.turns.map((turn) => turn.role), ['user', 'assistant', 'user']);
  assert.deepEqual(monitored.turns[1].expected, ['trackly_search_jobs']);
  assert.match(monitored.turns[2].content, /4101 and 4103/);
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
      'trackly_prepare_resume_artifact',
      'trackly_report_apply_progress',
      'trackly_certify_review_ready',
      'trackly_get_apply_work',
    ],
  );
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
