const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const currentSurfaces = ['package.json', 'server.json', 'README.md', 'CLAUDE.md', 'AGENTS.md'];
const source = JSON.parse(fs.readFileSync(path.join(root, 'metrics', 'public-marketing-metrics-v1.json'), 'utf8'));
const generated = JSON.parse(fs.readFileSync(path.join(root, 'metrics', 'public-metrics.generated.json'), 'utf8'));
const { isFreshForBuild, publicDisplay, render, replaceMetricsCopy } = require('../scripts/sync-public-metrics');

test('current CLI and MCP metadata use the conservative public metrics snapshot', () => {
  assert.deepEqual(generated, render(source));
  assert.equal(generated.sourceEndpoint, '/api/admin/public-marketing-metrics');
  assert.equal(generated.sourceDatabase, 'azure-blue');
  assert.equal(isFreshForBuild(generated, new Date('2026-08-04T00:00:00-07:00')), true);
  for (const relativePath of currentSurfaces) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /128(?:K|,000)\+ jobs/i, relativePath);
    assert.doesNotMatch(source, /1,900\+ companies/i, relativePath);
    assert.match(source, /170(?:K|,000)\+ jobs/i, relativePath);
    assert.match(source, /3,800\+ companies/i, relativePath);
  }
});

test('stale or missing metrics use nonnumeric public copy', () => {
  assert.deepEqual(publicDisplay(null), {
    jobs: 'Thousands of jobs',
    companies: 'Thousands of companies',
  });
  assert.deepEqual(publicDisplay(generated, new Date('2026-10-01T00:00:00-07:00')), {
    jobs: 'Thousands of jobs',
    companies: 'Thousands of companies',
  });
  assert.equal(
    replaceMetricsCopy(
      'Search 170K+ jobs across 3,800+ companies.',
      generated,
      new Date('2026-10-01T00:00:00-07:00'),
    ),
    'Search Thousands of jobs across Thousands of companies.',
  );
});

test('preparation replaces a previous numeric rounding bucket', () => {
  assert.equal(
    replaceMetricsCopy(
      'Search 160K+ jobs across 3,700+ companies.',
      generated,
      new Date('2026-08-04T01:00:00-07:00'),
    ),
    'Search 170K+ jobs across 3,800+ companies.',
  );
});
