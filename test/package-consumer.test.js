'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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

function writeMcpRequest(child, id, method, params = undefined) {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  })}\n`);
}

function waitForMcpResponse(child, id) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    const onStderr = (chunk) => { stderr += String(chunk); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(
        `Packed MCP exited before response ${id}: code ${code}, signal ${signal}. stderr: ${stderr}`,
      ));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response ${id}. stderr: ${stderr}`));
    }, 10_000);
    const onData = (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== id) continue;
        cleanup();
        resolve(message);
        return;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exit;
}

test('clean npm install runs the packed CLI, MCP, agent setup, and audit command', { timeout: 180_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-packed-consumer-'));
  const packageDir = path.join(tempDir, 'package');
  const consumerDir = path.join(tempDir, 'consumer');
  const installedCli = path.join(consumerDir, 'node_modules', 'trackly-cli');
  fs.mkdirSync(packageDir);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const pack = run(NPM, ['pack', '--json', '--pack-destination', packageDir], {
    cwd: REPO_ROOT,
  });
  const packResult = JSON.parse(pack.stdout);
  assert.equal(packResult.length, 1);
  const tarballPath = path.join(packageDir, packResult[0].filename);

  run(NPM, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    consumerDir,
    tarballPath,
  ]);

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
    fs.existsSync(path.join(installedCli, 'npm-shrinkwrap.json')),
    'the installed security:audit command must include an auditable dependency lock',
  );
  assert.ok(
    require.resolve('@hono/node-server', { paths: [installedCli] }),
    'the known transitive adapter must remain visible to dependency auditing',
  );

  const mcp = spawn(process.execPath, [path.join(installedCli, 'bin', 'trackly'), 'mcp'], {
    cwd: consumerDir,
    env: {
      ...process.env,
      TRACKLY_CONFIG_DIR: path.join(tempDir, 'mcp-config'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => terminateChild(mcp));
  const initialized = waitForMcpResponse(mcp, 1);
  writeMcpRequest(mcp, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'trackly-packed-consumer-test', version: '1.0.0' },
  });
  assert.equal((await initialized).result.serverInfo.version, packedManifest.version);

  const listed = waitForMcpResponse(mcp, 2);
  writeMcpRequest(mcp, 2, 'tools/list', {});
  const toolNames = (await listed).result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('trackly_get_apply_protocol'));
  assert.ok(toolNames.includes('trackly_start_apply_execution'));
  assert.ok(toolNames.includes('trackly_get_active_apply_execution'));
  assert.ok(toolNames.includes('trackly_get_apply_execution'));
  assert.ok(toolNames.includes('trackly_advance_apply_execution'));
  assert.ok(toolNames.includes('trackly_record_apply_execution_dispositions'));
  assert.ok(toolNames.includes('trackly_stop_apply_execution'));
  assert.ok(toolNames.includes('trackly_create_apply_batch'));
  assert.ok(toolNames.includes('trackly_cancel_apply_batch'));
  await terminateChild(mcp);

  for (const requested of ['codex', 'claude', 'both']) {
    const home = path.join(tempDir, `agent-${requested}`);
    const setup = run(process.execPath, [
      '-e',
      `
        const agent = require(${JSON.stringify(path.join(installedCli, 'lib', 'agent.js'))});
        const result = agent.setupAgent(${JSON.stringify(requested)});
        process.stdout.write(JSON.stringify(result));
      `,
    ], {
      cwd: consumerDir,
      env: {
        ...process.env,
        TRACKLY_CONFIG_DIR: path.join(home, '.trackly'),
        CODEX_HOME: path.join(home, '.codex'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        PATH: path.join(home, 'empty-bin'),
      },
    });
    const result = JSON.parse(setup.stdout);
    const expected = requested === 'both' ? ['codex', 'claude'] : [requested];
    assert.deepEqual(result.clients.map((client) => client.client), expected);
    for (const client of result.clients) {
      assert.ok(fs.existsSync(path.join(client.target, 'SKILL.md')));
    }
  }

  run(NPM, ['--prefix', installedCli, 'run', 'security:audit'], {
    cwd: consumerDir,
  });
});
