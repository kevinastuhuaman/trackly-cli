#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_POLICY_PATH = path.join(
  __dirname,
  '..',
  'security',
  'audit-exceptions.json',
);
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function selectAdvisoryFields(advisory) {
  return {
    source: advisory.source,
    name: advisory.name,
    dependency: advisory.dependency,
    title: advisory.title,
    url: advisory.url,
    severity: advisory.severity,
    cwe: advisory.cwe,
    cvss: advisory.cvss,
    range: advisory.range,
  };
}

function selectVulnerabilityFields(vulnerability) {
  return {
    name: vulnerability.name,
    severity: vulnerability.severity,
    isDirect: vulnerability.isDirect,
    via: vulnerability.via.map((entry) => (
      typeof entry === 'string' ? entry : selectAdvisoryFields(entry)
    )),
    effects: vulnerability.effects,
    range: vulnerability.range,
    nodes: vulnerability.nodes,
  };
}

function normalizedAuditShape(report) {
  const vulnerabilities = {};
  for (const packageName of Object.keys(report.vulnerabilities || {}).sort()) {
    vulnerabilities[packageName] = selectVulnerabilityFields(
      report.vulnerabilities[packageName],
    );
  }

  return {
    vulnerabilityCounts: report.metadata?.vulnerabilities,
    vulnerabilities,
  };
}

function cleanAuditResult(report) {
  const counts = report.metadata?.vulnerabilities;
  const vulnerabilities = report.vulnerabilities || {};
  const zeroCounts = counts
    && ['info', 'low', 'moderate', 'high', 'critical', 'total']
      .every((key) => counts[key] === 0);
  return zeroCounts && Object.keys(vulnerabilities).length === 0;
}

function validatePolicy(policy) {
  assert.equal(policy?.schemaVersion, 1);
  assert.ok(Array.isArray(policy.exceptions));
  assert.equal(
    policy.exceptions.length,
    0,
    'No npm audit exceptions are permitted',
  );
}

function validateAuditReport(report, policy) {
  if (
    report
    && typeof report === 'object'
    && (
      (report.error && typeof report.error === 'object')
      || typeof report.message === 'string'
    )
  ) {
    const detail = [
      report.message,
      report.error?.summary,
      report.error?.detail,
    ].find((value) => typeof value === 'string' && value.trim());
    throw new Error(
      `npm audit did not return an advisory report${detail ? `: ${detail.trim()}` : ''}`,
    );
  }
  assert.equal(report?.auditReportVersion, 2, 'Unsupported npm audit report version');
  validatePolicy(policy);

  if (cleanAuditResult(report)) {
    return {
      allowedAdvisories: [],
      propagatedVulnerabilities: [],
    };
  }
  throw new Error(
    'npm audit reported a vulnerability; Trackly CLI permits no audit exceptions.',
  );
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
}

function runAudit() {
  const result = spawnSync(NPM, ['audit', '--json', '--audit-level=moderate'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (!result.stdout.trim()) {
    throw new Error(`npm audit returned no JSON. stderr: ${result.stderr.trim()}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `npm audit returned invalid JSON. stderr: ${result.stderr.trim()}`,
      { cause: error },
    );
  }

  return validateAuditReport(report, loadPolicy());
}

if (require.main === module) {
  try {
    const result = runAudit();
    if (result.allowedAdvisories.length === 0) {
      console.log('npm audit is clean; no temporary exceptions were used.');
    } else {
      console.log(
        `npm audit matches the single temporary exception: ${result.allowedAdvisories.join(', ')}`,
      );
    }
  } catch (error) {
    console.error(error.message);
    if (error.cause?.message) {
      console.error(error.cause.message);
    }
    process.exitCode = 1;
  }
}

module.exports = {
  loadPolicy,
  normalizedAuditShape,
  runAudit,
  validateAuditReport,
};
