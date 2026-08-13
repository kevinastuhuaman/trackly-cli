'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const REPO_ROOT = path.join(__dirname, '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'trackly');

function waitForInitialize(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for MCP initialize response. stderr: ${stderr}`));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(
        `Trackly MCP exited before initialize with code ${code}, signal ${signal}. stderr: ${stderr}`,
      ));
    });
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}

test('stdio cleanup does not wait for an exit event that already fired', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  });
  await once(child, 'exit');
  await terminateChild(child);
});

test('stdio MCP initialize never loads HTTP transport or static-file modules', { timeout: 20_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-stdio-isolation-'));
  const hookPath = path.join(tempDir, 'trace-forbidden-loads.cjs');
  const tracePath = path.join(tempDir, 'forbidden-loads.jsonl');
  const configDir = path.join(tempDir, 'config');

  fs.writeFileSync(hookPath, `
    'use strict';
    const fs = require('node:fs');
    const Module = require('node:module');
    const originalLoad = Module._load;
    const forbidden = /(?:@hono\\/node-server|streamableHttp|serve[-_]?static)/i;
    Module._load = function(request, parent, isMain) {
      if (forbidden.test(String(request))) {
        fs.appendFileSync(process.env.TRACKLY_MODULE_TRACE, JSON.stringify({
          request: String(request),
          parent: parent && parent.filename ? parent.filename : null
        }) + '\\n');
      }
      return originalLoad.apply(this, arguments);
    };
  `);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [BIN_PATH, 'mcp'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TRACKLY_MCP_ANALYTICS_DISABLED: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${hookPath}`.trim(),
      TRACKLY_CONFIG_DIR: configDir,
      TRACKLY_MODULE_TRACE: tracePath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => terminateChild(child));

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'trackly-stdio-isolation-test', version: '1.0.0' },
    },
  })}\n`);

  const response = await waitForInitialize(child);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'trackly');

  const forbiddenLoads = fs.existsSync(tracePath)
    ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  assert.deepEqual(
    forbiddenLoads,
    [],
    `stdio startup loaded HTTP/static modules: ${JSON.stringify(forbiddenLoads)}`,
  );
});
