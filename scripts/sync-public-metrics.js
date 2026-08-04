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
  // Jobs keep one additional 10K safety bucket because the public job total is
  // volatile; company count only needs normal round-down to the nearest 100.
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
  // The hard CI gate prevents stale numeric copy from shipping. This helper
  // defines the nonnumeric fallback contract for renderers that consume the
  // snapshot directly rather than publishing static package metadata.
  if (!snapshot || !isFreshForBuild(snapshot, now)) {
    return { jobs: 'Thousands of jobs', companies: 'Thousands of companies' };
  }
  return snapshot.display;
}

function serialized(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function replaceMetricsCopy(contents, snapshot, now = new Date()) {
  const desired = publicDisplay(snapshot, now);
  const fallback = publicDisplay(null, now);
  let next = contents;
  for (const field of ['jobs', 'companies']) {
    for (const candidate of new Set([snapshot.display[field], fallback[field]])) {
      next = next.split(candidate).join(desired[field]);
    }
  }
  // A newly refreshed snapshot can cross a rounding bucket (for example,
  // 170K+ to 180K+). Replace the narrowly scoped metric phrases even when the
  // previous generated snapshot is no longer available to name the old value.
  next = next.replace(/\b\d+K\+ jobs\b/g, desired.jobs);
  next = next.replace(/\b\d{1,3}(?:,\d{3})*\+ companies\b/g, desired.companies);
  return next;
}

function prepareCurrentSurfaces(snapshot, now = new Date()) {
  for (const relativePath of currentSurfaces) {
    const filePath = path.join(root, relativePath);
    const contents = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, replaceMetricsCopy(contents, snapshot, now));
  }
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
  if (process.argv.includes('--prepare')) prepareCurrentSurfaces(generated);
  const expectedDisplay = publicDisplay(generated);
  for (const relativePath of currentSurfaces) {
    const contents = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const value of Object.values(expectedDisplay)) {
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

module.exports = { isFreshForBuild, prepareCurrentSurfaces, publicDisplay, render, replaceMetricsCopy, serialized, validateSource };
