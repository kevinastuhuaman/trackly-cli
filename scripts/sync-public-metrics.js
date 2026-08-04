#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'metrics', 'public-marketing-metrics-v1.json');
const outputPath = path.join(root, 'metrics', 'public-metrics.generated.json');
const expected = {
  report: 'public-marketing-metrics-v1',
  environment: 'production',
  database: 'azure-blue',
  sourceEndpoint: '/api/admin/public-marketing-metrics',
};
const maximumAgeInDays = 45;
const minimumBuildFreshnessDays = 7;
const currentSurfaces = ['package.json', 'server.json', 'README.md', 'CLAUDE.md', 'AGENTS.md'];

function validateSource(source) {
  for (const [field, value] of Object.entries(expected)) {
    if (source[field] !== value) throw new Error(`${field} must be ${value}`);
  }
  if (
    typeof source.generatedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(source.generatedAt)
    || !Number.isFinite(Date.parse(source.generatedAt))
  ) {
    throw new Error('generatedAt must be an ISO timestamp with an explicit offset');
  }
  for (const field of ['totalJobs', 'totalCompanies']) {
    const value = source.metrics?.[field];
    if (!Number.isInteger(value) || value <= 0) throw new Error(`metrics.${field} must be a positive integer`);
  }
}

function render(source) {
  validateSource(source);
  const conservativeJobs = Math.max(0, Math.floor(source.metrics.totalJobs / 10_000) * 10_000 - 10_000);
  const conservativeCompanies = Math.floor(source.metrics.totalCompanies / 100) * 100;
  return {
    schemaVersion: 1,
    sourceReport: source.report,
    sourceEnvironment: source.environment,
    sourceDatabase: source.database,
    sourceEndpoint: source.sourceEndpoint,
    sourceTimestamp: source.generatedAt,
    maximumAgeInDays,
    minimumBuildFreshnessDays,
    exact: { jobs: source.metrics.totalJobs, companies: source.metrics.totalCompanies },
    display: {
      jobs: `${conservativeJobs / 1_000}K+ jobs`,
      companies: `${conservativeCompanies.toLocaleString('en-US')}+ companies`,
    },
  };
}

function isFreshForBuild(snapshot, now = new Date()) {
  const generatedAt = new Date(snapshot.sourceTimestamp);
  const cutoff = new Date(generatedAt);
  cutoff.setDate(cutoff.getDate() + snapshot.maximumAgeInDays - snapshot.minimumBuildFreshnessDays);
  return Number.isFinite(generatedAt.getTime()) && now <= cutoff;
}

function publicDisplay(snapshot, now = new Date()) {
  if (!snapshot || !isFreshForBuild(snapshot, now)) {
    return { jobs: 'Thousands of jobs', companies: 'Thousands of companies' };
  }
  return snapshot.display;
}

function serialized(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function main() {
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const generated = render(source);
  if (!process.argv.includes('--check')) {
    fs.writeFileSync(outputPath, serialized(generated));
    return;
  }
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== serialized(generated)) {
    throw new Error('public-metrics.generated.json is not synchronized');
  }
  if (!isFreshForBuild(generated)) throw new Error('public metrics snapshot is too close to expiry; refresh it from the protected production report');
  for (const relativePath of currentSurfaces) {
    const contents = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const value of Object.values(generated.display)) {
      if (!contents.includes(value)) throw new Error(`${relativePath} is missing canonical metric: ${value}`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { isFreshForBuild, publicDisplay, render, serialized, validateSource };
