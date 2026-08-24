'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agent = require('../lib/agent');
const packageManifest = require('../package.json');

function withTempAgentHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-agent-test-'));
  const previous = {
    TRACKLY_CONFIG_DIR: process.env.TRACKLY_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    PATH: process.env.PATH,
  };
  process.env.TRACKLY_CONFIG_DIR = path.join(root, '.trackly');
  process.env.CODEX_HOME = path.join(root, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  process.env.PATH = path.join(root, 'empty-bin');
  fs.mkdirSync(process.env.PATH, { recursive: true });
  try {
    return run(root);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withTempAgentHomeAsync(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-agent-test-'));
  const previous = {
    TRACKLY_CONFIG_DIR: process.env.TRACKLY_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    PATH: process.env.PATH,
  };
  process.env.TRACKLY_CONFIG_DIR = path.join(root, '.trackly');
  process.env.CODEX_HOME = path.join(root, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  process.env.PATH = path.join(root, 'empty-bin');
  fs.mkdirSync(process.env.PATH, { recursive: true });
  try {
    return await run(root);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('agent setup installs one canonical skill and links both clients', () => {
  withTempAgentHome(() => {
    const result = agent.setupAgent('both');
    assert.equal(result.skillVersion, '4.7.1');
    assert.ok(fs.existsSync(path.join(result.canonical, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(result.canonical, 'references', 'inbox-receipt-preflight.md')));
    for (const reference of ['operational-checkpoints.md', 'access-probe.md', 'performance-telemetry.md']) {
      assert.ok(fs.existsSync(path.join(result.canonical, 'references', reference)), reference);
    }
    const validator = path.join(result.canonical, 'scripts', 'validate-phase-checkpoint.js');
    assert.ok(fs.existsSync(validator));
    const validation = spawnSync(process.execPath, [validator, 'selection'], {
      input: JSON.stringify({
        receipt: {
          workMode: 'accessible_execution',
          executionId: 301,
          batchId: 501,
          latestExplicitTarget: 1,
          approvedJobIds: [101],
          approvalRecorded: true,
          noFormMutationBeforeApproval: true,
          queueExhausted: false,
        },
        expectedContext: {
          workMode: 'accessible_execution',
          executionId: 301,
          batchId: 501,
          latestExplicitTarget: 1,
          selectableJobIds: [101],
          queueExhausted: false,
        },
      }),
      encoding: 'utf8',
    });
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /selection checkpoint valid/);
    assert.equal(result.clients.length, 2);
    for (const client of result.clients) {
      assert.ok(fs.existsSync(path.join(client.target, 'SKILL.md')));
      assert.equal(client.mcp.status, 'missing_client');
    }
  });
});

test('agent setup records a deterministic full-pack content digest', () => {
  withTempAgentHome(() => {
    const first = agent.setupAgent('codex');
    const metadataPath = path.join(first.canonical, '.trackly-managed.json');
    const firstMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    assert.equal(firstMetadata.skillManifestVersion, 1);
    assert.match(firstMetadata.skillContentDigest, /^[a-f0-9]{64}$/);
    assert.ok(firstMetadata.skillFileCount > 1);
    assert.equal(agent.inspectClient('codex').skillIntegrity, 'verified');

    const second = agent.setupAgent('codex');
    const secondMetadata = JSON.parse(fs.readFileSync(
      path.join(second.canonical, '.trackly-managed.json'),
      'utf8',
    ));
    assert.equal(secondMetadata.skillContentDigest, firstMetadata.skillContentDigest);
    assert.equal(secondMetadata.skillFileCount, firstMetadata.skillFileCount);
  });
});

test('agent doctor inspection fails closed on modified, missing, or extra managed skill content', () => {
  for (const mutation of ['modified', 'missing', 'extra']) {
    withTempAgentHome(() => {
      const setup = agent.setupAgent('codex');
      const target = setup.clients[0].target;
      if (mutation === 'modified') {
        fs.appendFileSync(
          path.join(target, 'references', 'form-integrity.md'),
          '\nfixture mutation\n',
        );
      } else if (mutation === 'missing') {
        fs.unlinkSync(path.join(target, 'references', 'form-integrity.md'));
      } else {
        fs.writeFileSync(path.join(target, 'unexpected-managed-file.txt'), 'unexpected');
      }

      const inspection = agent.inspectClient('codex');
      assert.equal(inspection.installedSkillVersion, '4.7.1', mutation);
      assert.equal(inspection.installed, false, mutation);
      assert.equal(inspection.skillIntegrity, 'content_mismatch', mutation);
    });
  }
});

test('agent doctor reports managed skill integrity failures even when metadata version is current', async () => {
  await withTempAgentHomeAsync(async () => {
    const setup = agent.setupAgent('codex');
    fs.appendFileSync(path.join(setup.clients[0].target, 'SKILL.md'), '\nfixture mutation\n');

    const report = await agent.doctorAgent();
    assert.equal(report.skillPackIntegrity.ok, false);
    assert.match(report.skillPackIntegrity.expectedDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      report.skillPackIntegrity.failures,
      [{ client: 'codex', integrity: 'content_mismatch' }],
    );
    assert.equal(report.ok, false);
  });
});

test('clean temporary homes install Codex, Claude, and both client targets', () => {
  for (const requested of ['codex', 'claude', 'both']) {
    withTempAgentHome(() => {
      const result = agent.setupAgent(requested);
      const expected = requested === 'both' ? ['codex', 'claude'] : [requested];
      assert.deepEqual(result.clients.map((client) => client.client), expected);
      for (const client of result.clients) {
        assert.ok(fs.existsSync(path.join(client.target, 'SKILL.md')));
      }
    });
  }
});

test('Apply execution mode makes managed skill 4.0.0 stale and setup installs 4.7.1', () => {
  withTempAgentHome(() => {
    const target = agent.clientSkillDir('codex');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'old managed skill');
    fs.writeFileSync(path.join(target, '.trackly-managed.json'), JSON.stringify({
      managedBy: 'trackly-cli',
      skill: 'trackly-apply',
      skillVersion: '4.0.0',
    }));

    const before = agent.inspectClient('codex');
    assert.equal(before.installed, false);
    assert.equal(before.installedSkillVersion, '4.0.0');

    const setup = agent.setupAgent('codex');
    assert.equal(setup.skillVersion, '4.7.1');
    const after = agent.inspectClient('codex');
    assert.equal(after.installed, true);
    assert.equal(after.installedSkillVersion, '4.7.1');
    const installedSkill = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
    assert.match(installedSkill, /Resume after maintenance/);
    assert.match(installedSkill, /sanctioned idempotent lookup/);
    assert.match(installedSkill, /Never create a replacement run/);
    assert.match(installedSkill, /browser readiness gate/);
  });
});

test('agent doctor inspection rejects stale Codex and Claude MCP commands', () => {
  withTempAgentHome(() => {
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CODEX_HOME, 'config.toml'),
      '[mcp_servers.trackly]\ncommand = "node"\nargs = ["old-server.js"]\n',
    );
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
      JSON.stringify({ mcpServers: { trackly: { command: 'node', args: ['old-server.js'] } } }),
    );

    assert.equal(agent.inspectClient('codex').mcpRegistration, 'stale');
    assert.equal(agent.inspectClient('codex').mcpRegistered, false);
    assert.equal(agent.inspectClient('claude').mcpRegistration, 'stale');
    assert.equal(agent.inspectClient('claude').mcpRegistered, false);
  });
});

test('agent doctor inspection accepts only the exact Trackly MCP command', () => {
  withTempAgentHome(() => {
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CODEX_HOME, 'config.toml'),
      '[mcp_servers.trackly]\ncommand = "trackly"\nargs = ["mcp"]\n',
    );
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
      JSON.stringify({ mcpServers: { trackly: { command: 'trackly', args: ['mcp'] } } }),
    );

    assert.equal(agent.inspectClient('codex').mcpRegistration, 'current');
    assert.equal(agent.inspectClient('claude').mcpRegistration, 'current');
  });
});

test('agent setup rejects a current MCP registration when the client executable is missing', () => {
  withTempAgentHome(() => {
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CODEX_HOME, 'config.toml'),
      '[mcp_servers.trackly]\ncommand = "trackly"\nargs = ["mcp"]\n',
    );

    const result = agent.setupAgent('codex');

    assert.equal(result.clients[0].mcp.status, 'missing_client');
    assert.match(result.clients[0].mcp.error, /codex is not installed/);
  });
});

test('agent setup resolves a relative Trackly config directory before symlinking', () => {
  withTempAgentHome((root) => {
    const previousCwd = process.cwd();
    process.chdir(root);
    process.env.TRACKLY_CONFIG_DIR = '.trackly';
    try {
      const result = agent.setupAgent('codex');
      assert.equal(path.isAbsolute(result.canonical), true);
      assert.equal(path.isAbsolute(agent.cacheDir()), true);
      assert.equal(agent.cacheDir(), path.resolve('.trackly', 'cache', 'resumes'));
      assert.ok(fs.existsSync(path.join(result.clients[0].target, 'SKILL.md')));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('agent setup refuses to overwrite an unmanaged client skill', () => {
  withTempAgentHome(() => {
    const target = agent.clientSkillDir('codex');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'user-owned');
    assert.throws(() => agent.setupAgent('codex'), /Refusing to overwrite unmanaged skill/);
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'user-owned');
  });
});

test('agent setup refuses to overwrite an unmanaged client skill symlink', () => {
  withTempAgentHome((root) => {
    const unmanaged = path.join(root, 'user-owned-trackly-apply');
    fs.mkdirSync(unmanaged, { recursive: true });
    fs.writeFileSync(path.join(unmanaged, 'SKILL.md'), 'user-owned');
    const target = agent.clientSkillDir('codex');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(unmanaged, target, 'dir');
    assert.throws(() => agent.setupAgent('codex'), /Refusing to overwrite unmanaged skill/);
    assert.equal(fs.readlinkSync(target), unmanaged);
    assert.equal(fs.readFileSync(path.join(unmanaged, 'SKILL.md'), 'utf8'), 'user-owned');
  });
});

test('agent setup falls back to a private managed copy when symlinks are unavailable', () => {
  withTempAgentHome(() => {
    const originalSymlink = fs.symlinkSync;
    fs.symlinkSync = () => {
      const error = new Error('symlinks unavailable');
      error.code = 'EPERM';
      throw error;
    };
    try {
      const result = agent.setupAgent('codex');
      assert.equal(result.clients[0].method, 'copy');
      assert.ok(fs.existsSync(path.join(result.clients[0].target, '.trackly-managed.json')));
      assert.equal(fs.statSync(result.canonical).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(result.canonical, '.trackly-managed.json')).mode & 0o777, 0o600);
    } finally {
      fs.symlinkSync = originalSymlink;
    }
  });
});

test('agent setup never exposes a partial skill when fallback copying fails', () => {
  withTempAgentHome(() => {
    const originalSymlink = fs.symlinkSync;
    const originalCopyFile = fs.copyFileSync;
    let copies = 0;
    fs.symlinkSync = () => {
      const error = new Error('symlinks unavailable');
      error.code = 'ENOTSUP';
      throw error;
    };
    fs.copyFileSync = (...args) => {
      copies += 1;
      if (copies === 2) throw new Error('simulated interrupted copy');
      return originalCopyFile(...args);
    };
    try {
      const target = agent.clientSkillDir('codex');
      assert.throws(() => agent.setupAgent('codex'), /simulated interrupted copy/);
      assert.equal(fs.existsSync(target), false);
      const parent = path.dirname(target);
      const leftovers = fs.existsSync(parent)
        ? fs.readdirSync(parent).filter((entry) => entry.startsWith('trackly-apply.staging.'))
        : [];
      assert.deepEqual(leftovers, []);
    } finally {
      fs.symlinkSync = originalSymlink;
      fs.copyFileSync = originalCopyFile;
    }
  });
});

test('agent setup removes canonical staging when the bundled skill copy fails', () => {
  withTempAgentHome(() => {
    const originalCopyFile = fs.copyFileSync;
    fs.copyFileSync = (source, destination, ...rest) => {
      if (destination.includes(`${path.sep}.trackly${path.sep}skills${path.sep}trackly-apply.staging.`)) {
        throw new Error('simulated canonical copy failure');
      }
      return originalCopyFile(source, destination, ...rest);
    };
    try {
      assert.throws(() => agent.setupAgent('codex'), /simulated canonical copy failure/);
      const parent = path.join(process.env.TRACKLY_CONFIG_DIR, 'skills');
      const leftovers = fs.existsSync(parent)
        ? fs.readdirSync(parent).filter((entry) => entry.startsWith('trackly-apply.staging.'))
        : [];
      assert.deepEqual(leftovers, []);
    } finally {
      fs.copyFileSync = originalCopyFile;
    }
  });
});

test('agent setup restores the previous managed copy when replacement copying fails', () => {
  withTempAgentHome(() => {
    const originalSymlink = fs.symlinkSync;
    const originalCopyFile = fs.copyFileSync;
    fs.symlinkSync = () => {
      const error = new Error('symlinks unavailable');
      error.code = 'ENOTSUP';
      throw error;
    };
    try {
      const first = agent.setupAgent('codex');
      const target = first.clients[0].target;
      fs.writeFileSync(path.join(target, 'sentinel.txt'), 'previous-good-copy');
      fs.copyFileSync = (source, destination, ...rest) => {
        if (destination.includes(`${path.sep}.codex${path.sep}skills${path.sep}trackly-apply.staging.`)) {
          throw new Error('simulated replacement failure');
        }
        return originalCopyFile(source, destination, ...rest);
      };
      assert.throws(() => agent.setupAgent('codex'), /simulated replacement failure/);
      assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'previous-good-copy');
    } finally {
      fs.symlinkSync = originalSymlink;
      fs.copyFileSync = originalCopyFile;
    }
  });
});

test('resume validation checks PDF type and server hash', () => {
  const buffer = Buffer.from('%PDF-1.7\nexample');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  assert.deepEqual(agent.validateResumeFile({ buffer, contentType: 'application/pdf', sha256 }), {
    digest: sha256,
    contentType: 'application/pdf',
  });
  assert.throws(
    () => agent.validateResumeFile({ buffer, contentType: 'application/pdf', sha256: '0'.repeat(64) }),
    /SHA-256/,
  );
});

test('resume validation normalizes generic MIME types from file signatures', () => {
  const pdf = Buffer.from('%PDF-1.7\nexample');
  assert.equal(agent.validateResumeFile({ buffer: pdf, contentType: 'application/octet-stream' }).contentType, 'application/pdf');
  const docx = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('[Content_Types].xml\0word/document.xml'),
  ]);
  assert.equal(
    agent.validateResumeFile({ buffer: docx, contentType: '' }).contentType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.throws(
    () => agent.validateResumeFile({ buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]), contentType: 'application/zip' }),
    /Unsupported or invalid resume type/,
  );
});

test('agent doctor distinguishes missing resumes from failed validation', () => {
  assert.equal(agent.resumeValidationStatus({ profile: { hasDefaultResume: false } }), 'not applicable (no default resume set)');
  assert.equal(agent.resumeValidationStatus({ profile: { hasDefaultResume: true }, resume: { available: false } }), 'failed');
  assert.equal(
    agent.resumeValidationStatus({ profile: { hasDefaultResume: true }, resume: { available: true } }),
    'available (exact bytes are verified during an active Apply run)',
  );
});

test('agent doctor compatibility requires protocol 3.6.0 or newer', () => {
  assert.equal(agent.protocolAtLeast('2.0.9'), false);
  assert.equal(agent.protocolAtLeast('2.1.0'), false);
  assert.equal(agent.protocolAtLeast('2.99.9'), false);
  assert.equal(agent.protocolAtLeast('3.0.0'), false);
  assert.equal(agent.protocolAtLeast('3.0.9'), false);
  assert.equal(agent.protocolAtLeast('3.1.0'), false);
  assert.equal(agent.protocolAtLeast('3.2.9'), false);
  assert.equal(agent.protocolAtLeast('3.3.0'), false);
  assert.equal(agent.protocolAtLeast('3.3.1'), false);
  assert.equal(agent.protocolAtLeast('3.4.0'), false);
  assert.equal(agent.protocolAtLeast('3.6.0'), true);
  assert.equal(agent.protocolAtLeast('1.99.0'), false);
  assert.equal(agent.protocolAtLeast('invalid'), false);
});

test('agent doctor compatibility enforces the protocol minimum installed skill version', () => {
  const installed = [{
    client: 'codex',
    installed: true,
    installedSkillVersion: '4.7.1',
  }];
  const current = agent.evaluateApplyCompatibility({
    version: '3.6.0',
    mcpContractVersion: '3.7.5',
    compatibleCliMinimumVersion: '0.8.2',
    compatibleSkillMajor: 4,
    compatibleSkillMinimumVersion: '4.4.0',
  }, installed);
  assert.equal(current.compatible, true);
  assert.equal(current.mcpContractCompatible, true);
  assert.equal(current.cliMinimumSatisfied, true);
  assert.equal(current.skillMinimumSatisfied, true);
  assert.deepEqual(current.compatibleClientSkills, ['codex']);

  const future = agent.evaluateApplyCompatibility({
    version: '3.6.0',
    mcpContractVersion: '3.7.5',
    compatibleCliMinimumVersion: '0.8.2',
    compatibleSkillMajor: 4,
    compatibleSkillMinimumVersion: '4.8.0',
  }, installed);
  assert.equal(future.compatible, false);
  assert.equal(future.skillMinimumSatisfied, false);
  assert.deepEqual(future.compatibleClientSkills, []);

  const missingMinimum = agent.evaluateApplyCompatibility({
    version: '3.4.1',
    mcpContractVersion: '3.7.5',
    compatibleCliMinimumVersion: '0.8.2',
    compatibleSkillMajor: 4,
  }, installed);
  assert.equal(missingMinimum.compatible, false);
  assert.equal(missingMinimum.skillMinimumSatisfied, false);
});

test('agent doctor compatibility rejects stale CLI and MCP contract versions', () => {
  const clients = [{
    client: 'codex',
    installed: true,
    installedSkillVersion: '4.7.1',
  }];
  const base = {
    version: '3.6.0',
    mcpContractVersion: '3.7.5',
    compatibleCliMinimumVersion: '0.8.2',
    compatibleSkillMajor: 4,
    compatibleSkillMinimumVersion: '4.4.0',
  };

  const staleCli = agent.evaluateApplyCompatibility({
    ...base,
    compatibleCliMinimumVersion: packageManifest.version.replace(
      /^(\d+)\.(\d+)\.(\d+)$/,
      (_match, major, minor, patch) => `${major}.${minor}.${Number(patch) + 1}`,
    ),
  }, clients);
  assert.equal(staleCli.cliMinimumSatisfied, false);
  assert.equal(staleCli.compatible, false);

  const staleContract = agent.evaluateApplyCompatibility({
    ...base,
    mcpContractVersion: '3.2.0',
  }, clients);
  assert.equal(staleContract.mcpContractCompatible, false);
  assert.equal(staleContract.compatible, false);

  const missingVersions = agent.evaluateApplyCompatibility({
    version: '3.6.0',
    compatibleSkillMajor: 4,
    compatibleSkillMinimumVersion: '4.4.0',
  }, clients);
  assert.equal(missingVersions.cliMinimumSatisfied, false);
  assert.equal(missingVersions.mcpContractCompatible, false);
  assert.equal(missingVersions.compatible, false);
});

test('agent doctor accepts the local MCP contract during an explicit overlap window', () => {
  const clients = [{
    client: 'codex',
    installed: true,
    installedSkillVersion: '4.7.1',
  }];
  const result = agent.evaluateApplyCompatibility({
    version: '3.6.1',
    mcpContractVersion: '3.6.0',
    preferredMcpContractVersion: '3.7.5',
    compatibleMcpContractVersions: ['3.7.5', '3.7.4', '3.7.3', '3.7.2'],
    compatibleCliMinimumVersion: '0.13.1',
    compatibleSkillMajor: 4,
    compatibleSkillMinimumVersion: '4.4.1',
    batchOrchestration: { accessibleExecution: { enabled: true } },
  }, clients);

  assert.equal(result.mcpContractCompatible, true);
  assert.equal(result.preferredMcpContractVersion, '3.7.5');
  assert.deepEqual(result.compatibleMcpContractVersions, ['3.7.5', '3.7.4', '3.7.3', '3.7.2']);
});

test('agent doctor treats an explicit MCP compatibility window as authoritative', () => {
  const result = agent.evaluateApplyCompatibility({
    version: '3.6.1',
    mcpContractVersion: '3.7.3',
    preferredMcpContractVersion: '3.6.3',
    compatibleMcpContractVersions: ['3.6.3'],
    compatibleCliMinimumVersion: '0.13.1',
    compatibleSkillMajor: 4,
    compatibleSkillMinimumVersion: '4.4.1',
    batchOrchestration: { accessibleExecution: { enabled: true } },
  }, [{
    client: 'codex',
    installed: true,
    installedSkillVersion: '4.7.1',
  }]);

  assert.equal(result.mcpContractCompatible, false);
  assert.equal(result.compatible, false);
});

test('agent doctor accepts the legacy MCP contract only while accessible execution is disabled', () => {
  const clients = [{
    client: 'codex',
    installed: true,
    installedSkillVersion: '4.7.1',
  }];
  const base = {
    version: '3.4.0',
    mcpContractVersion: '3.4.0',
    compatibleCliMinimumVersion: '0.10.2',
    compatibleSkillMajor: 4,
    compatibleSkillMinimumVersion: '4.2.6',
  };

  const disabled = agent.evaluateApplyCompatibility({
    ...base,
    batchOrchestration: { accessibleExecution: { enabled: false } },
  }, clients);
  assert.equal(disabled.mcpContractCompatible, true);
  assert.equal(disabled.compatible, true);

  const enabled = agent.evaluateApplyCompatibility({
    ...base,
    batchOrchestration: { accessibleExecution: { enabled: true } },
  }, clients);
  assert.equal(enabled.mcpContractCompatible, false);
  assert.equal(enabled.compatible, false);

  const missingCapability = agent.evaluateApplyCompatibility(base, clients);
  assert.equal(missingCapability.mcpContractCompatible, false);
  assert.equal(missingCapability.compatible, false);
});

test('agent doctor fails browser readiness closed unless a full semantic surface exists', () => {
  assert.equal(agent.liveBrowserReady({ codex: false, codexComputerUse: false, claude: null }), false);
  assert.equal(agent.liveBrowserReady({ codex: true, codexComputerUse: false, claude: null }), false);
  assert.equal(agent.liveBrowserReady({ codex: false, codexComputerUse: true, claude: null }), false);
  assert.equal(agent.liveBrowserReady({ codex: true, codexComputerUse: true, claude: null }), true);
  assert.equal(agent.liveBrowserReady({ codex: false, codexComputerUse: false, claude: true }), true);
});

test('agent doctor does not infer controller and user tab union inventory from plugin presence', async () => {
  await withTempAgentHomeAsync(async () => {
    const report = await agent.doctorAgent();
    assert.equal(report.cliVersion, packageManifest.version);
    assert.equal(report.mcpContractVersion, '3.7.5');
    assert.match(report.skillPackIntegrity.expectedDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.browserControl.tabInventory, {
      controllerOwnedTabs: 'runtime_verification_required',
      userOwnedTabs: 'runtime_verification_required',
      unionReconciliation: 'runtime_verification_required',
      detectedSurfaces: [],
      unionInventoryDetected: false,
      requiredForClosedClaim: true,
      note: 'Installed plugins do not prove controller-owned and user-owned tab union inventory. The active browser client must verify both inventories before claiming a tab is closed.',
    });
  });
});

test('resume preparation keeps CLI and MCP attribution distinct', () => {
  assert.match(agent.CLI_USER_AGENT, /^trackly-cli\//);
  assert.match(agent.MCP_USER_AGENT, /^trackly-mcp\//);
  assert.notEqual(agent.CLI_USER_AGENT, agent.MCP_USER_AGENT);
});

test('resume cache keeps the user-facing filename exact while isolating internal uniqueness', () => {
  const fileName = 'Candidate Résumé (2026) – Product.pdf';
  const first = agent.resumeCacheName(fileName, 'application/pdf', 1234, 'aaaaaaaa');
  const second = agent.resumeCacheName(fileName, 'application/pdf', 1234, 'bbbbbbbb');
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), '1234-aaaaaaaa');
  assert.equal(path.basename(first), fileName);
  assert.equal(path.basename(second), fileName);
});

test('resume cache rejects unsafe or silently lossy filenames', () => {
  for (const fileName of [
    '../Resume.pdf',
    'folder\\Resume.pdf',
    'Resume\u0000.pdf',
    `${'a'.repeat(241)}.pdf`,
    'Resume.pdf ',
    'Resume.docx',
  ]) {
    assert.throws(
      () => agent.resumeCacheName(fileName, 'application/pdf', 1234, 'aaaaaaaa'),
      /resume filename/i,
      fileName,
    );
  }
});

test('resume confirmation identifies the exact local bytes the user can inspect', () => {
  const sha256 = 'a'.repeat(64);
  const localPath = path.join('/private', 'trackly-cache', 'Resume - Candidate Name.pdf');
  const expiresAt = '2026-07-14T12:00:00.000Z';
  assert.deepEqual(agent.resumeConfirmation('Resume - Candidate Name.pdf', sha256, 132123, localPath, 91, expiresAt, 'proof-123'), {
    required: true,
    source: 'trackly_default_resume',
    runId: 91,
    confirmationId: 'proof-123',
    fileName: 'Resume - Candidate Name.pdf',
    sha256,
    sizeBytes: 132123,
    expiresAt,
    verification: {
      preferred: 'local_preview',
      exactLocalPath: localPath,
      displayExactPathRequired: true,
    },
  });
});

test('resume materialization binds exact bytes, path, filename, permissions, and proof to one run', () => {
  withTempAgentHome(() => {
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    const fileName = 'Candidate Résumé (2026) – Product.pdf';
    const buffer = Buffer.from('%PDF-1.7\nexact resume bytes');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    const prepared = agent.materializeResume({
      buffer,
      contentType: 'application/pdf',
      fileName,
      sha256,
      resumeId: 70,
    }, {
      runId: 91,
      now,
      nonce: 'aaaaaaaa',
      confirmationId: 'proof-123',
    });

    assert.equal(path.basename(prepared.path), fileName);
    assert.equal(path.basename(path.dirname(prepared.path)), `${now}-aaaaaaaa`);
    assert.equal(prepared.fileName, fileName);
    assert.equal(prepared.resumeId, 70);
    assert.equal(prepared.confirmation.resumeId, 70);
    assert.deepEqual(fs.readFileSync(prepared.path), buffer);
    assert.equal(fs.statSync(prepared.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(prepared.path)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(path.dirname(prepared.path), '.trackly-resume-proof.json')).mode & 0o777, 0o400);
    assert.equal(fs.statSync(path.join(process.env.TRACKLY_CONFIG_DIR, 'resume-proof.key')).mode & 0o777, 0o600);
    assert.equal(prepared.sha256, sha256);
    assert.equal(prepared.sizeBytes, buffer.length);
    assert.equal(prepared.confirmation.runId, 91);
    assert.equal(prepared.confirmation.confirmationId, 'proof-123');
    assert.equal(prepared.confirmation.sha256, sha256);
    assert.equal(prepared.confirmation.verification.exactLocalPath, prepared.path);
    assert.equal(prepared.confirmation.expiresAt, prepared.expiresAt);
  });
});

test('pre-attach verification rehashes the confirmed file and locks it read-only', () => {
  withTempAgentHome(() => {
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    const buffer = Buffer.from('%PDF-1.7\nconfirmed resume bytes');
    const prepared = agent.materializeResume({
      buffer,
      contentType: 'application/pdf',
      fileName: 'Resume - Candidate Name.pdf',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      resumeId: 70,
    }, { runId: 91, now, nonce: 'aaaaaaaa', confirmationId: 'proof-123' });

    const result = agent.verifyPreparedResume({
      runId: prepared.confirmation.runId,
      resumeId: prepared.resumeId,
      confirmationId: prepared.confirmation.confirmationId,
      exactLocalPath: prepared.path,
      sha256: prepared.sha256,
      sizeBytes: prepared.sizeBytes,
      expiresAt: prepared.expiresAt,
    }, now + 1000);

    assert.equal(result.verified, true);
    assert.equal(result.resumeId, 70);
    assert.equal(result.sha256, prepared.sha256);
    assert.equal(result.exactLocalPath, prepared.path);
    assert.equal(result.permissions, '400');
    assert.equal(fs.statSync(prepared.path).mode & 0o777, 0o400);
  });
});

test('pre-attach verification rejects changed or expired resume proof', () => {
  withTempAgentHome(() => {
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    const buffer = Buffer.from('%PDF-1.7\nconfirmed resume bytes');
    const prepared = agent.materializeResume({
      buffer,
      contentType: 'application/pdf',
      fileName: 'Resume - Candidate Name.pdf',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      resumeId: 70,
    }, { runId: 91, now, nonce: 'aaaaaaaa', confirmationId: 'proof-123' });
    const proof = {
      runId: 91,
      resumeId: 70,
      confirmationId: 'proof-123',
      exactLocalPath: prepared.path,
      sha256: prepared.sha256,
      sizeBytes: prepared.sizeBytes,
      expiresAt: prepared.expiresAt,
    };

    assert.throws(() => agent.verifyPreparedResume({ ...proof, runId: 92 }, now + 1000), /does not match the confirmed run/i);
    assert.throws(() => agent.verifyPreparedResume({ ...proof, resumeId: 71 }, now + 1000), /does not match the confirmed run/i);
    assert.throws(() => agent.verifyPreparedResume({ ...proof, confirmationId: 'different-proof' }, now + 1000), /does not match the confirmed run/i);

    fs.writeFileSync(prepared.path, Buffer.from('%PDF-1.7\nchanged resume content'));
    assert.throws(() => agent.verifyPreparedResume(proof, now + 1000), /changed after confirmation/i);

    fs.writeFileSync(prepared.path, buffer);
    assert.throws(() => agent.verifyPreparedResume(proof, Date.parse(prepared.expiresAt)), /expired/i);
  });
});

test('pre-attach verification rejects a modified signed proof manifest', () => {
  withTempAgentHome(() => {
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    const buffer = Buffer.from('%PDF-1.7\nconfirmed resume bytes');
    const prepared = agent.materializeResume({
      buffer,
      contentType: 'application/pdf',
      fileName: 'Resume - Candidate Name.pdf',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    }, { runId: 91, now, nonce: 'aaaaaaaa', confirmationId: 'proof-123' });
    const manifestPath = path.join(path.dirname(prepared.path), '.trackly-resume-proof.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.runId = 92;
    fs.chmodSync(manifestPath, 0o600);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.chmodSync(manifestPath, 0o400);

    assert.throws(() => agent.verifyPreparedResume({
      runId: 91,
      confirmationId: 'proof-123',
      exactLocalPath: prepared.path,
      sha256: prepared.sha256,
      sizeBytes: prepared.sizeBytes,
      expiresAt: prepared.expiresAt,
    }, now + 1000), /proof is invalid/i);
  });
});

test('resume preparation rejects a symlinked proof-signing key', () => {
  withTempAgentHome((root) => {
    const externalKey = path.join(root, 'external-proof.key');
    const keyPath = path.join(process.env.TRACKLY_CONFIG_DIR, 'resume-proof.key');
    fs.mkdirSync(process.env.TRACKLY_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(externalKey, crypto.randomBytes(32), { mode: 0o600 });
    fs.symlinkSync(externalKey, keyPath);
    const buffer = Buffer.from('%PDF-1.7\nconfirmed resume bytes');

    assert.throws(() => agent.materializeResume({
      buffer,
      contentType: 'application/pdf',
      fileName: 'Resume - Candidate Name.pdf',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    }, { runId: 91 }), /not a private regular file/i);
    assert.deepEqual(fs.readdirSync(agent.cacheDir()), []);
  });
});

test('pre-attach verification rejects a cache path redirected through a symlink', () => {
  withTempAgentHome((root) => {
    const dir = agent.cacheDir();
    const externalDir = path.join(root, 'external');
    const cacheAlias = path.join(dir, '1700000000000-aaaaaaaa');
    const fileName = 'Resume - Candidate Name.pdf';
    const buffer = Buffer.from('%PDF-1.7\nexternal bytes');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, fileName), buffer, { mode: 0o600 });
    fs.symlinkSync(externalDir, cacheAlias);

    assert.throws(() => agent.verifyPreparedResume({
      runId: 91,
      confirmationId: 'proof-123',
      exactLocalPath: path.join(cacheAlias, fileName),
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.length,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), /resolves outside/i);
  });
});

test('resume cache removes only expired files', () => {
  withTempAgentHome(() => {
    const dir = agent.cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, 'old.pdf');
    const freshFile = path.join(dir, 'fresh.pdf');
    fs.writeFileSync(oldFile, '%PDF-old');
    fs.writeFileSync(freshFile, '%PDF-fresh');
    const now = Date.now();
    fs.utimesSync(oldFile, new Date(now - agent.CACHE_TTL_MS - 1000), new Date(now - agent.CACHE_TTL_MS - 1000));
    const result = agent.cleanResumeCache(now);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(freshFile), true);
  });
});

test('resume cache cleanup handles private per-download directories', () => {
  withTempAgentHome(() => {
    const dir = agent.cacheDir();
    const oldDir = path.join(dir, '1700000000000-aaaaaaaa');
    const freshDir = path.join(dir, '1700000000000-bbbbbbbb');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(freshDir, { recursive: true });
    const oldFile = path.join(oldDir, 'Resume - Candidate Name.pdf');
    const freshFile = path.join(freshDir, 'Resume - Candidate Name.pdf');
    fs.writeFileSync(oldFile, '%PDF-old');
    fs.writeFileSync(freshFile, '%PDF-fresh');
    const now = Date.now();
    fs.utimesSync(oldFile, new Date(now - agent.CACHE_TTL_MS - 1000), new Date(now - agent.CACHE_TTL_MS - 1000));
    fs.utimesSync(oldDir, new Date(now - agent.CACHE_TTL_MS - 1000), new Date(now - agent.CACHE_TTL_MS - 1000));

    const result = agent.cleanResumeCache(now);

    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(freshFile), true);
  });
});

test('resume cache cleanup leaves fresh empty download directories in place', () => {
  withTempAgentHome(() => {
    const dir = agent.cacheDir();
    const freshEmpty = path.join(dir, `${Date.now()}-aaaaaaaa`);
    fs.mkdirSync(freshEmpty, { recursive: true });

    assert.doesNotThrow(() => agent.cleanResumeCache(Date.now()));
    assert.equal(fs.existsSync(freshEmpty), true);
  });
});

test('resume cache cleanup tolerates entries removed by another process', () => {
  withTempAgentHome(() => {
    const dir = agent.cacheDir();
    const oldDir = path.join(dir, '1700000000000-aaaaaaaa');
    const oldFile = path.join(oldDir, 'Resume - Candidate Name.pdf');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(oldFile, '%PDF-old');
    const now = Date.now();
    fs.utimesSync(oldFile, new Date(now - agent.CACHE_TTL_MS - 1000), new Date(now - agent.CACHE_TTL_MS - 1000));
    fs.utimesSync(oldDir, new Date(now - agent.CACHE_TTL_MS - 1000), new Date(now - agent.CACHE_TTL_MS - 1000));

    const originalLstat = fs.lstatSync;
    let removedConcurrently = false;
    fs.lstatSync = (target, ...args) => {
      if (target === oldFile && !removedConcurrently) {
        removedConcurrently = true;
        fs.rmSync(oldFile, { force: true });
      }
      return originalLstat(target, ...args);
    };
    try {
      assert.doesNotThrow(() => agent.cleanResumeCache(now));
      assert.equal(removedConcurrently, true);
    } finally {
      fs.lstatSync = originalLstat;
    }
  });
});

test('resume cache cleanup tolerates a directory becoming non-empty before removal', () => {
  withTempAgentHome(() => {
    const dir = agent.cacheDir();
    const oldDir = path.join(dir, '1700000000000-aaaaaaaa');
    fs.mkdirSync(oldDir, { recursive: true });
    const now = Date.now();
    fs.utimesSync(oldDir, new Date(now - agent.CACHE_TTL_MS - 1000), new Date(now - agent.CACHE_TTL_MS - 1000));

    const originalRmdir = fs.rmdirSync;
    fs.rmdirSync = (target, ...args) => {
      if (target === oldDir) {
        const error = new Error('directory is no longer empty');
        error.code = 'ENOTEMPTY';
        throw error;
      }
      return originalRmdir(target, ...args);
    };
    try {
      assert.doesNotThrow(() => agent.cleanResumeCache(now));
    } finally {
      fs.rmdirSync = originalRmdir;
    }
  });
});

test('resume cache cleanup never follows symlinked children', () => {
  withTempAgentHome((root) => {
    const dir = agent.cacheDir();
    const external = path.join(root, 'outside.pdf');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(external, '%PDF-outside');
    fs.utimesSync(external, new Date(0), new Date(0));
    fs.symlinkSync(external, path.join(dir, 'legacy-link.pdf'));

    assert.doesNotThrow(() => agent.cleanResumeCache(Date.now()));
    assert.equal(fs.existsSync(external), true);
  });
});

test('public skill contains no personal profile data or absolute user paths', () => {
  const root = agent.bundledSkillDir();
  const files = [];
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(item);
      else if (entry.isFile()) files.push(item);
    }
  }
  collect(root);
  const text = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(text, /Kevin|Astuhuaman|berkeley\.edu|2710 Bancroft|\/Users\//i);
  assert.match(text, /Stop before Submit/);
  assert.match(text, /preserve.*user.*filename/i);
  assert.match(text, /internal.*cache.*identifier/i);
  assert.match(text, /visual.*preview/i);
  assert.match(text, /explicit.*confirmation/i);
  assert.match(text, /exact.*SHA-256/i);
  assert.match(text, /exact.*prepared.*file/i);
  assert.match(text, /exact local path/i);
  assert.match(text, /Always provide.*exactLocalPath/i);
  assert.match(text, /Quick Look|Preview\.app/i);
  assert.match(text, /generic.*profile.*not.*proof/i);
});
