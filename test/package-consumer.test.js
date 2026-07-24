'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test('packed CLI starts from the extracted npm artifact with the audited dependency tree', { timeout: 120_000 }, (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-packed-consumer-'));
  const packageDir = path.join(tempDir, 'package');
  const consumerDir = path.join(tempDir, 'consumer');
  const installedCli = path.join(consumerDir, 'node_modules', 'trackly-cli');
  fs.mkdirSync(packageDir);
  fs.mkdirSync(installedCli, { recursive: true });
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const pack = run(NPM, ['pack', '--json', '--pack-destination', packageDir], {
    cwd: REPO_ROOT,
  });
  const packResult = JSON.parse(pack.stdout);
  assert.equal(packResult.length, 1);
  const tarballPath = path.join(packageDir, packResult[0].filename);

  run('tar', ['-xzf', tarballPath, '--strip-components=1', '-C', installedCli]);
  for (const dependencyName of ['@modelcontextprotocol', '@hono', 'hono', 'zod']) {
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules', dependencyName),
      path.join(consumerDir, 'node_modules', dependencyName),
      'junction',
    );
  }

  const version = run(process.execPath, [
    path.join(installedCli, 'bin', 'trackly'),
    '--version',
  ], { cwd: consumerDir });
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);

  const packedManifest = JSON.parse(
    fs.readFileSync(path.join(installedCli, 'package.json'), 'utf8'),
  );
  assert.equal(
    packedManifest.dependencies['@modelcontextprotocol/sdk'],
    require('../package.json').dependencies['@modelcontextprotocol/sdk'],
  );
  assert.equal(
    packedManifest.dependencies.hono,
    require('../package.json').dependencies.hono,
  );
  assert.ok(
    fs.existsSync(path.join(installedCli, 'scripts', 'verify-audit-exceptions.js')),
    'the installed security:audit command must include its implementation',
  );
  assert.ok(
    fs.existsSync(path.join(installedCli, 'security', 'audit-exceptions.json')),
    'the installed security:audit command must include its exact policy',
  );
  assert.ok(
    require.resolve('@hono/node-server', { paths: [installedCli] }),
    'the known transitive adapter must remain visible to dependency auditing',
  );
});
