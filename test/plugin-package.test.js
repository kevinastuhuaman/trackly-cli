'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'trackly');

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
  assert.equal(manifest.interface.composerIcon, './assets/trackly-appicon.svg');
  assert.equal(manifest.interface.logo, './assets/trackly-appicon.svg');
  assert.equal(manifest.interface.logoDark, './assets/trackly-appicon.svg');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(!Object.hasOwn(manifest, 'apps'), 'apps must wait for a real registered MCP technical ID');
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
  const provenance = json('plugins/trackly/assets/brand-source.json');
  assert.equal(provenance.brand, 'trackly');
  assert.equal(
    provenance.sourceSha256,
    '8aa1b351cbc1ab62c8a178838403b706954c3b73109871c054c5b286bbf73ff2',
  );
  assert.equal(provenance.packagedAsset, 'assets/trackly-appicon.svg');
  assert.equal(provenance.byteIdenticalToSource, false);
  assert.equal(provenance.pixelIdenticalToSource, false);
  assert.equal(provenance.visualApprovalRequired, true);
  assert.match(provenance.treatment, /vector approximation/);
  assert.match(provenance.approvalRequirement, /Kevin must compare/);
  const svg = read('plugins/trackly/assets/trackly-appicon.svg');
  assert.match(svg, /<rect[^>]+fill="#000"/);
  assert.match(svg, /<path[^>]+fill="#fff"/);
  assert.doesNotMatch(svg, /purple|#[a-f0-9]{0,2}(?:7c3aed|8b5cf6|a855f7)/i);
  assert.match(provenance.forbiddenReplacement, /Purple Orb/);
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
  assert.deepEqual(lock.publicScopeContract, {
    trackly_get_apply_work: ['profile:read', 'sensitive:read', 'apply:read', 'apply:write'],
  });
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
  for (const item of fixtures.positive) {
    assert.ok(item.fixture);
    assert.ok(item.expectedResultShape.length > 0);
    assert.ok(item.expected.every((tool) => allowedTools.has(tool)), `${item.id} references an unlisted tool`);
  }
  assert.ok(fixtures.negative.every((item) => item.fixture));
  assert.ok(fixtures.positive.some((item) => item.id === 'apply-to-review'));
  assert.ok(fixtures.positive.find((item) => item.id === 'apply-to-review').expected.includes('trackly_prepare_resume_artifact'));
  assert.ok(fixtures.positive.find((item) => item.id === 'apply-to-review').expected.includes('trackly_get_job'));
  assert.deepEqual(
    fixtures.positive.find((item) => item.id === 'apply-to-review').expectedResultShape,
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
  assert.equal(
    fixtures.positive.find((item) => item.id === 'resume-apply').expected[0],
    'trackly_get_apply_readiness',
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
  assert.ok(!fs.existsSync(path.join(PLUGIN, '.app.json')));
  const gates = read('plugins/trackly/RELEASE-GATES.md');
  assert.match(gates, /Do not invent or pre-allocate an ID/);
  assert.match(gates, /HTTP 200 response from `https:\/\/usetrackly\.app\/plugins\/trackly`/);
  assert.match(gates, /derived approximation, not a byte- or pixel-identical copy/);
  assert.match(gates, /Kevin must explicitly approve the exact packaged SVG/);
  assert.match(gates, /Kevin must approve/);
  assert.match(gates, /ask Kevin again before selecting Publish/);
});
