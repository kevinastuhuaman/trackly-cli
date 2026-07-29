'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateAuditReport,
} = require('../scripts/verify-audit-exceptions');

const POLICY_PATH = path.join(__dirname, '..', 'security', 'audit-exceptions.json');
const PACKAGE_LOCK_PATH = path.join(__dirname, '..', 'package-lock.json');
const SHRINKWRAP_PATH = path.join(__dirname, '..', 'npm-shrinkwrap.json');

function policy() {
  return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
}

function cleanReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };
}

test('published shrinkwrap exactly matches the repository dependency lock', () => {
  assert.deepEqual(
    JSON.parse(fs.readFileSync(SHRINKWRAP_PATH, 'utf8')),
    JSON.parse(fs.readFileSync(PACKAGE_LOCK_PATH, 'utf8')),
  );
});

test('audit policy permits no temporary exceptions', () => {
  assert.deepEqual(policy(), {
    schemaVersion: 1,
    exceptions: [],
  });
});

test('audit gate accepts only a clean report', () => {
  assert.deepEqual(validateAuditReport(cleanReport(), policy()), {
    allowedAdvisories: [],
    propagatedVulnerabilities: [],
  });

  const report = cleanReport();
  report.vulnerabilities.example = {
    name: 'example',
    severity: 'low',
    isDirect: true,
    via: [],
    effects: [],
    range: '<1.0.1',
    nodes: ['node_modules/example'],
  };
  report.metadata.vulnerabilities.low = 1;
  report.metadata.vulnerabilities.total = 1;
  assert.throws(
    () => validateAuditReport(report, policy()),
    /permits no audit exceptions/i,
  );
});

test('audit gate reports registry failures without misclassifying the schema version', () => {
  assert.throws(
    () => validateAuditReport({
      message: 'request to the npm audit endpoint failed',
      error: { summary: '', detail: '' },
    }, policy()),
    /npm audit did not return an advisory report: request to the npm audit endpoint failed/i,
  );
});
