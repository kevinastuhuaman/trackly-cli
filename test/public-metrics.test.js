const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const currentSurfaces = ['package.json', 'server.json', 'README.md', 'CLAUDE.md', 'AGENTS.md'];

test('current CLI and MCP metadata use the conservative public metrics snapshot', () => {
  for (const relativePath of currentSurfaces) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /128(?:K|,000)\+ jobs/i, relativePath);
    assert.doesNotMatch(source, /1,900\+ companies/i, relativePath);
    assert.match(source, /170(?:K|,000)\+ jobs/i, relativePath);
    assert.match(source, /3,800\+ companies/i, relativePath);
  }
});
